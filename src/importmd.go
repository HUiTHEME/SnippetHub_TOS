package main

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// 批量导入：把一堆 .md 按文件夹打包成 zip，导入时保留文件夹结构。
// 流程拆成两步，避免一次上传无法确认：
//  1. POST /api/import/inspect  上传 zip → 落在 data/import-cache/<token>.zip，返回摘要
//  2. POST /api/import/apply?token=…&mode=merge|replace  真正写入
const (
	importCacheTTL = 2 * time.Hour
	maxMDSize      = 8 << 20   // 单篇 .md 上限 8MB
	maxZipTotal    = 768 << 20 // 一个导入包解压后的总量上限，挡「几 KB 解出几十 GB」的压缩炸弹
)

// zipTotalSize 估算解压后的总字节数；超过上限就返回 false。
func zipTotalSize(zr *zip.ReadCloser) (int64, bool) {
	var total int64
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		if f.UncompressedSize64 > maxZipTotal {
			return 0, false
		}
		total += int64(f.UncompressedSize64)
		if total > maxZipTotal {
			return total, false
		}
	}
	return total, true
}

type importPreview struct {
	Token   string   `json:"token"`
	Kind    string   `json:"kind"` // md | backup
	Folders int      `json:"folders"`
	Docs    int      `json:"docs"`
	Skipped int      `json:"skipped"`
	BadName int      `json:"badName"`
	Fixed   int      `json:"fixed"` // 文件名原本是 GBK 等非 UTF-8 编码，已自动转成正常中文
	Bytes   int64    `json:"bytes"`
	Names   []string `json:"names"`
}

type mdEntry struct {
	folder string
	title  string
	f      *zip.File
}

func (a *api) importCacheDir() string { return filepath.Join(a.store.dirPath(), "import-cache") }

// ---------- zip 文件名的编码修复 ----------
// Windows 上的旧压缩工具（资源管理器「压缩到 ZIP」、好压、2345 等）会把 GBK 字节直接写进 zip，
// 而且不打「UTF-8」标志位。Go 的 archive/zip 不做转码，f.Name 就是那串原始字节，
// 这里按三步处理：
//  1. 优先用压缩工具写在 extra field 里的 UTF-8 别名（Info-ZIP Unicode Path, 0x7075）
//  2. 本来就是合法 UTF-8 就直接用
//  3. 否则按 GBK(CP936) 解一遍
//
// 注意：必须解完码再处理 \ 和 /，因为 GBK 的尾字节可能是 0x5C（反斜杠）。
func zipEntryName(f *zip.File) (name string, fixed bool) {
	raw := f.Name
	if alt, ok := unicodePathExtra(f); ok {
		return alt, !utf8.ValidString(raw)
	}
	if utf8.ValidString(raw) {
		return raw, false
	}
	if s, ok := gbkToUTF8([]byte(raw)); ok {
		return s, true
	}
	return raw, false
}

// unicodePathExtra 读 Info-ZIP Unicode Path Extra Field (0x7075)：
// version(1) + 原始名字的 CRC32(4) + UTF-8 路径，CRC 对得上才认。
func unicodePathExtra(f *zip.File) (string, bool) {
	b := f.Extra
	sum := crc32.ChecksumIEEE([]byte(f.Name))
	for len(b) >= 4 {
		id := binary.LittleEndian.Uint16(b[0:2])
		size := int(binary.LittleEndian.Uint16(b[2:4]))
		if 4+size > len(b) {
			return "", false
		}
		data := b[4 : 4+size]
		if id == 0x7075 && len(data) > 5 && data[0] == 1 &&
			binary.LittleEndian.Uint32(data[1:5]) == sum {
			s := string(bytes.TrimRight(data[5:], "\x00"))
			if s != "" && utf8.ValidString(s) {
				return s, true
			}
		}
		b = b[4+size:]
	}
	return "", false
}

// gbkToUTF8 把 GBK 字节解成 UTF-8；有解不了的字节就返回 false。
func gbkToUTF8(b []byte) (string, bool) {
	var sb strings.Builder
	sb.Grow(len(b) + len(b)/2)
	for i := 0; i < len(b); {
		c := b[i]
		switch {
		case c < 0x80:
			sb.WriteByte(c)
			i++
		case c == 0x80: // CP936 把 0x80 映射成欧元符号
			sb.WriteRune('€')
			i++
		default:
			if i+1 >= len(b) {
				return "", false
			}
			r, ok := gbkLookup(c, b[i+1])
			if !ok {
				return "", false
			}
			sb.WriteRune(r)
			i += 2
		}
	}
	return sb.String(), true
}

// POST /api/import/inspect
func (a *api) inspectImport(w http.ResponseWriter, r *http.Request) {
	dir := a.importCacheDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fail(w, 500, "无法创建导入缓存目录")
		return
	}
	pruneImportCache(dir)

	r.Body = http.MaxBytesReader(w, r.Body, 512<<20)
	mr, err := r.MultipartReader()
	if err != nil {
		fail(w, 400, "上传格式错误")
		return
	}

	token := randHex(16)
	dst := filepath.Join(dir, token+".zip")
	out, err := os.Create(dst)
	if err != nil {
		fail(w, 500, "无法创建临时文件")
		return
	}

	var size int64
	got := false
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			_ = out.Close()
			_ = os.Remove(dst)
			fail(w, 400, "上传中断")
			return
		}
		if part.FormName() != "file" {
			_ = part.Close()
			continue
		}
		size, err = io.Copy(out, part)
		_ = part.Close()
		if err != nil {
			_ = out.Close()
			_ = os.Remove(dst)
			fail(w, 500, "写入临时文件失败")
			return
		}
		got = true
	}
	_ = out.Close()
	if !got || size == 0 {
		_ = os.Remove(dst)
		fail(w, 400, "没有收到文件")
		return
	}

	zr, err := zip.OpenReader(dst)
	if err != nil {
		_ = os.Remove(dst)
		fail(w, 400, "不是有效的 zip 文件")
		return
	}
	defer zr.Close()

	if _, ok := zipTotalSize(zr); !ok {
		_ = zr.Close()
		_ = os.Remove(dst)
		fail(w, 400, "压缩包解压后超过 768MB，已拒绝导入")
		return
	}

	p := importPreview{Token: token, Bytes: size}
	if hasBackupMeta(zr) {
		p.Kind = "backup"
		if bp, err := readBackupMeta(zr); err == nil && bp != nil {
			p.Folders = len(bp.Folders)
			p.Docs = len(bp.Docs)
		}
	} else {
		entries, skipped, bad, fixed := parseMDEntries(zr)
		if len(entries) == 0 {
			_ = os.Remove(dst)
			if bad > 0 {
				fail(w, 400, "压缩包里没有可导入的 .md：有 "+fmt.Sprint(bad)+" 个文件名无法识别编码（既不是 UTF-8 也不是 GBK），请换用 7-Zip 重新打包")
				return
			}
			fail(w, 400, "压缩包里没有找到 .md 文件")
			return
		}
		p.Kind = "md"
		p.Docs = len(entries)
		p.Skipped = skipped
		p.BadName = bad
		p.Fixed = fixed
		names := map[string]bool{}
		for _, e := range entries {
			if !names[e.folder] {
				names[e.folder] = true
			}
		}
		p.Folders = len(names)
		for n := range names {
			p.Names = append(p.Names, n)
		}
		sort.Strings(p.Names)
		if len(p.Names) > 12 {
			p.Names = p.Names[:12]
		}
	}
	writeJSON(w, 200, p)
}

// POST /api/import/apply?token=…&mode=merge|replace
func (a *api) applyImport(w http.ResponseWriter, r *http.Request) {
	token := r.URL.Query().Get("token")
	if !isHex32(token) {
		fail(w, 400, "导入会话无效，请重新选择文件")
		return
	}
	mode := r.URL.Query().Get("mode")
	if mode != "replace" {
		mode = "merge"
	}
	src := filepath.Join(a.importCacheDir(), token+".zip")
	st, err := os.Stat(src)
	if err != nil || st.IsDir() {
		fail(w, 400, "导入会话已过期，请重新选择文件")
		return
	}
	defer os.Remove(src)

	zr, err := zip.OpenReader(src)
	if err != nil {
		fail(w, 400, "压缩包已损坏")
		return
	}
	defer zr.Close()

	if _, ok := zipTotalSize(zr); !ok {
		fail(w, 400, "压缩包解压后超过 768MB，已拒绝导入")
		return
	}

	if hasBackupMeta(zr) {
		bp, err := readBackupMeta(zr)
		if err != nil || bp == nil {
			fail(w, 400, "备份包内的 snippets.json 解析失败")
			return
		}
		if bp.Format != backupFormat {
			fail(w, 400, "这不是片段HUB的备份包")
			return
		}
		nf, nd, na, err := a.applyBackup(bp, mode, zr)
		if err != nil {
			fail(w, 500, "导入失败："+err.Error())
			return
		}
		writeJSON(w, 200, map[string]any{
			"ok": true, "kind": "backup", "mode": mode,
			"folders": nf, "docs": nd, "attachments": na,
		})
		return
	}

	nf, nd, skipped, err := a.applyMdZip(zr)
	if err != nil {
		fail(w, 500, "导入失败："+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{
		"ok": true, "kind": "md", "mode": "merge",
		"folders": nf, "docs": nd, "skipped": skipped,
	})
}

// parseMDEntries 从 zip 里挑出 .md，解析出「文件夹 / 标题」。
// 只支持一级文件夹：多级目录取最靠近文件的那一层，不同上级下的同名文件夹会合并。
func parseMDEntries(zr *zip.ReadCloser) (out []mdEntry, skipped, badName, fixed int) {
	for _, f := range zr.File {
		// 目录先按原始名字判掉，避免把目录也算成「修好了的文件名」
		if f.FileInfo().IsDir() || strings.HasSuffix(f.Name, "/") || strings.HasSuffix(f.Name, "\\") {
			continue
		}
		name, repaired := zipEntryName(f)
		name = strings.ReplaceAll(name, "\\", "/")
		if strings.Contains(name, "__MACOSX") {
			skipped++
			continue
		}
		clean := path.Clean(strings.TrimPrefix(name, "./"))
		if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
			skipped++
			continue
		}
		segs := strings.Split(clean, "/")
		hidden := false
		for _, s := range segs {
			if strings.HasPrefix(s, ".") && s != "." { // .DS_Store、.git/…
				hidden = true
				break
			}
		}
		if hidden {
			skipped++
			continue
		}
		base := segs[len(segs)-1]
		ext := path.Ext(base)
		switch strings.ToLower(ext) {
		case ".md", ".markdown", ".mdown":
		default:
			skipped++
			continue
		}
		if !utf8.ValidString(clean) {
			badName++
			continue
		}
		title := trimTitle(strings.TrimSuffix(base, ext))
		if strings.TrimSpace(title) == "" {
			title = "未命名片段"
		}
		folder := "未归类"
		if len(segs) > 1 {
			folder = segs[len(segs)-2]
			if folder == "" || folder == "." {
				folder = "未归类"
			}
		}
		if repaired {
			fixed++
		}
		out = append(out, mdEntry{folder: folder, title: title, f: f})
	}
	return
}

// applyMdZip 增量写入：文件夹不存在则创建，已存在则复用；同名标题自动加序号。
func (a *api) applyMdZip(zr *zip.ReadCloser) (int, int, int, error) {
	entries, skipped, _, _ := parseMDEntries(zr)

	a.store.mu.Lock()
	defer a.store.mu.Unlock()

	folderByName := map[string]string{}
	for _, f := range a.store.db.Folders {
		folderByName[f.Name] = f.ID
	}
	baseOrder := 0
	for _, f := range a.store.db.Folders {
		if f.Order >= baseOrder {
			baseOrder = f.Order + 1
		}
	}

	nFolders := 0
	folderOf := func(name string) string {
		if name == "" {
			name = "未归类"
		}
		if id, ok := folderByName[name]; ok {
			return id
		}
		id := newID()
		a.store.db.Folders = append(a.store.db.Folders, Folder{
			ID: id, Name: name, CreatedAt: now(), Order: baseOrder + nFolders,
		})
		folderByName[name] = id
		nFolders++
		return id
	}

	titles := map[string]map[string]bool{}
	for _, d := range a.store.db.Docs {
		set := titles[d.FolderID]
		if set == nil {
			set = map[string]bool{}
			titles[d.FolderID] = set
		}
		set[strings.ToLower(d.Title)] = true
	}
	uniqTitle := func(fid, t string) string {
		set := titles[fid]
		if set == nil {
			set = map[string]bool{}
			titles[fid] = set
		}
		if !set[strings.ToLower(t)] {
			set[strings.ToLower(t)] = true
			return t
		}
		for i := 2; ; i++ {
			cand := fmt.Sprintf("%s (%d)", t, i)
			if !set[strings.ToLower(cand)] {
				set[strings.ToLower(cand)] = true
				return cand
			}
		}
	}

	nDocs := 0
	for _, e := range entries {
		rc, err := e.f.Open()
		if err != nil {
			skipped++
			continue
		}
		body, err := io.ReadAll(io.LimitReader(rc, maxMDSize+1))
		_ = rc.Close()
		if err != nil || len(body) > maxMDSize {
			skipped++
			continue
		}
		text := strings.TrimPrefix(string(body), "\ufeff")

		fid := folderOf(e.folder)
		title := uniqTitle(fid, e.title)
		rel := a.store.allocNoteRelLocked(fid, title, "")
		if err := a.store.writeNote(rel, text); err != nil {
			skipped++
			continue
		}
		created := e.f.Modified.Unix()
		if created <= 0 {
			created = now()
		}
		id := newID()
		a.store.db.Docs = append(a.store.db.Docs, Doc{
			ID: id, FolderID: fid, Title: title, File: rel,
			Preview: previewOf(text), CreatedAt: created, UpdatedAt: created,
		})
		a.store.cacheSet(id, text)
		nDocs++
	}

	if err := a.store.saveLocked(); err != nil {
		return 0, 0, 0, fmt.Errorf("保存数据失败")
	}
	return nFolders, nDocs, skipped, nil
}

func hasBackupMeta(zr *zip.ReadCloser) bool {
	for _, f := range zr.File {
		if f.Name == "snippets.json" {
			return true
		}
	}
	return false
}

func readBackupMeta(zr *zip.ReadCloser) (*backupPayload, error) {
	for _, f := range zr.File {
		if f.Name != "snippets.json" {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, err
		}
		defer rc.Close()
		var p backupPayload
		if err := json.NewDecoder(rc).Decode(&p); err != nil {
			return nil, err
		}
		return &p, nil
	}
	return nil, fmt.Errorf("找不到 snippets.json")
}

func pruneImportCache(dir string) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	nowT := time.Now()
	for _, e := range ents {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if nowT.Sub(info.ModTime()) > importCacheTTL {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

func isHex32(s string) bool {
	if len(s) != 32 {
		return false
	}
	for _, c := range s {
		ok := (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
		if !ok {
			return false
		}
	}
	return true
}
