package main

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

const (
	backupFormat  = "snippethub-backup"
	backupVersion = 1
)

type backupPayload struct {
	Format     string            `json:"format"`
	Version    int               `json:"version"`
	AppVersion string            `json:"appVersion"`
	ExportedAt int64             `json:"exportedAt"`
	Folders    []Folder          `json:"folders"`
	Docs       []Doc             `json:"docs"`
	TagColors  map[string]string `json:"tagColors,omitempty"`
	TagOrder   []string          `json:"tagOrder,omitempty"`
}

// collectTags 汇总标签及使用次数。
func collectTags(docs []docOut, colors map[string]string, order []string) []tagOut {
	count := map[string]int{}
	display := map[string]string{}
	for _, d := range docs {
		for _, t := range d.Tags {
			k := strings.ToLower(t)
			count[k]++
			display[k] = t
		}
	}
	out := make([]tagOut, 0, len(count))
	for k, n := range count {
		out = append(out, tagOut{Name: display[k], Count: n, Color: colors[k]})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Count == out[j].Count {
			return out[i].Name < out[j].Name
		}
		return out[i].Count > out[j].Count
	})

	// 用户手动排过序的标签优先按自定义顺序，其余保持次数顺序排在其后
	if len(order) > 0 {
		rank := make(map[string]int, len(order))
		for i, k := range order {
			rank[strings.ToLower(k)] = i
		}
		sort.SliceStable(out, func(i, j int) bool {
			ri, iok := rank[strings.ToLower(out[i].Name)]
			rj, jok := rank[strings.ToLower(out[j].Name)]
			if iok && jok {
				return ri < rj
			}
			return iok
		})
	}
	return out
}

// GET /api/export —— 导出 zip（snippets.json + 附件）
func (a *api) exportData(w http.ResponseWriter, r *http.Request) {
	a.store.mu.RLock()
	payload := backupPayload{
		Format:     backupFormat,
		Version:    backupVersion,
		AppVersion: appVersion,
		ExportedAt: now(),
		Folders:    append([]Folder{}, a.store.db.Folders...),
		Docs:       make([]Doc, len(a.store.db.Docs)),
		TagColors:  map[string]string{},
		TagOrder:   append([]string{}, a.store.db.TagOrder...),
	}
	for k, v := range a.store.db.TagColors {
		payload.TagColors[k] = v
	}
	copy(payload.Docs, a.store.db.Docs)
	a.store.mu.RUnlock()

	filename := "snippethub-backup-" + time.Now().Format("20060102-1504") + ".zip"
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.Header().Set("Cache-Control", "no-store")

	zw := zip.NewWriter(w)
	defer zw.Close()

	meta, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return
	}
	if fw, err := zw.Create("snippets.json"); err == nil {
		_, _ = fw.Write(meta)
	}
	if fw, err := zw.Create("README.txt"); err == nil {
		_, _ = fw.Write([]byte(readmeForBackup()))
	}

	for _, d := range payload.Docs {
		rel := d.File
		if rel == "" {
			rel = d.ID + ".md"
		}
		if body, err := a.store.readContent(d.ID); err == nil {
			if fw, err := zw.Create(path.Join("notes", filepath.ToSlash(rel))); err == nil {
				_, _ = fw.Write([]byte(body))
			}
		}
		for _, at := range d.Attachments {
			src := attachPath(a.store.dirPath(), d.ID, at)
			f, err := os.Open(src)
			if err != nil {
				continue
			}
			entry := path.Join("attachments", d.ID, at.ID+strings.ToLower(filepath.Ext(at.Name)))
			fw, err := zw.Create(entry)
			if err == nil {
				_, _ = io.Copy(fw, f)
			}
			_ = f.Close()
		}
	}
}

func readmeForBackup() string {
	return `片段HUB SnippetHub —— 数据备份包
=====================================

目录结构：
  notes/<文件夹名>/<标题>.md         每篇内容的正文，一个 .md 文件，按文件夹分好
  snippets.json                    文件夹、片段元信息（含每篇的 file 路径）、标签
  attachments/<片段ID>/<附件ID>.<扩展名>   附件原文件

说明：
  1. notes/ 里的 .md 就是正文原文，用任何 Markdown 编辑器都能直接打开；
     snippets.json 只存索引，正文不在里面。
  2. 备份包不含访问密码，导入后仍使用当前应用的密码。
  3. 在本应用的「应用设置 → 数据备份」中可直接导入该 zip。
  4. 导入支持两种方式：
     - 合并：保留现有内容，把备份里的文件夹与片段追加进来（同名文件夹会合并）
     - 覆盖：清空现有片段与文件夹后再导入（密码保留）
`
}

// POST /api/import?mode=merge|replace
func (a *api) importData(w http.ResponseWriter, r *http.Request) {
	mode := r.URL.Query().Get("mode")
	if mode != "replace" {
		mode = "merge"
	}

	r.Body = http.MaxBytesReader(w, r.Body, 4<<30)
	mr, err := r.MultipartReader()
	if err != nil {
		fail(w, 400, "上传格式错误")
		return
	}

	// 临时文件放在数据目录里，不要用系统 /tmp：
	// NAS 的 /tmp 常常是小容量内存盘，导入一个几 GB 的备份会把内存吃光。
	tmpDir := filepath.Join(a.store.dirPath(), "import-cache")
	_ = os.MkdirAll(tmpDir, 0o755)

	var tmp *os.File
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			fail(w, 400, "上传中断")
			return
		}
		if part.FormName() != "file" {
			_ = part.Close()
			continue
		}
		tmp, err = os.CreateTemp(tmpDir, "backup-*.zip")
		if err != nil {
			_ = part.Close()
			fail(w, 500, "无法创建临时文件")
			return
		}
		if _, err := io.Copy(tmp, part); err != nil {
			_ = part.Close()
			_ = tmp.Close()
			_ = os.Remove(tmp.Name())
			fail(w, 500, "写入临时文件失败")
			return
		}
		_ = part.Close()
	}
	if tmp == nil {
		fail(w, 400, "没有收到备份文件")
		return
	}
	_ = tmp.Close()
	defer os.Remove(tmp.Name())

	zr, err := zip.OpenReader(tmp.Name())
	if err != nil {
		fail(w, 400, "不是有效的 zip 备份包")
		return
	}
	defer zr.Close()

	var payload backupPayload
	found := false
	for _, f := range zr.File {
		if f.Name == "snippets.json" {
			rc, err := f.Open()
			if err != nil {
				continue
			}
			err = json.NewDecoder(rc).Decode(&payload)
			_ = rc.Close()
			if err != nil {
				fail(w, 400, "备份包内的 snippets.json 解析失败")
				return
			}
			found = true
			break
		}
	}
	if !found {
		fail(w, 400, "备份包里找不到 snippets.json")
		return
	}
	if payload.Format != backupFormat {
		fail(w, 400, "这不是片段HUB的备份包")
		return
	}

	nf, nd, na, err := a.applyBackup(&payload, mode, zr)
	if err != nil {
		fail(w, 500, "导入失败："+err.Error())
		return
	}
	writeJSON(w, 200, map[string]any{
		"ok": true, "mode": mode,
		"folders": nf, "docs": nd, "attachments": na,
	})
}

func (a *api) applyBackup(p *backupPayload, mode string, zr *zip.ReadCloser) (int, int, int, error) {
	a.store.mu.Lock()
	defer a.store.mu.Unlock()

	if mode == "replace" {
		a.store.db.Folders = []Folder{}
		a.store.db.Docs = []Doc{}
		// 覆盖导入不直接删旧数据：把 files / notes 整体改名到 _replaced-<时间>/ 里，
		// 万一这个 zip 有问题（缺正文、内容不对），用户还能把目录改回来手动捞。
		dir := a.store.dirPath()
		archive := filepath.Join(dir, "_replaced-"+time.Now().Format("20060102-150405"))
		hadFiles := statStore(dir).files > 0
		for _, sub := range []string{"files", "notes"} {
			from := filepath.Join(dir, sub)
			if _, err := os.Stat(from); err != nil {
				_ = os.MkdirAll(from, 0o755)
				continue
			}
			// 空目录就直接留着，没必要为它建一个归档文件夹
			if !hadFiles {
				continue
			}
			if err := os.MkdirAll(archive, 0o755); err != nil || os.Rename(from, filepath.Join(archive, sub)) != nil {
				// 挪不动（跨设备等原因）就退回「直接清掉」，保证导入还能跑
				_ = os.RemoveAll(from)
			}
			_ = os.MkdirAll(from, 0o755)
		}
		_ = os.RemoveAll(filepath.Join(dir, "content"))
		a.store.cacheReset()
	}

	folderByName := map[string]string{}
	usedFolderID := map[string]bool{}
	for _, f := range a.store.db.Folders {
		folderByName[f.Name] = f.ID
		usedFolderID[f.ID] = true
	}

	remap := map[string]string{}
	nFolders := 0
	baseOrder := 0
	for _, f := range a.store.db.Folders {
		if f.Order >= baseOrder {
			baseOrder = f.Order + 1
		}
	}
	fallbackFolder := ""
	for _, f := range p.Folders {
		name := strings.TrimSpace(f.Name)
		if name == "" {
			continue
		}
		if mode == "merge" {
			if id, ok := folderByName[name]; ok {
				remap[f.ID] = id
				if fallbackFolder == "" {
					fallbackFolder = id
				}
				continue
			}
		}
		id := f.ID
		if id == "" || usedFolderID[id] {
			id = newID()
		}
		created := f.CreatedAt
		if created == 0 {
			created = now()
		}
		order := f.Order
		if mode == "merge" {
			order = baseOrder + nFolders
		}
		a.store.db.Folders = append(a.store.db.Folders, Folder{ID: id, Name: name, CreatedAt: created, Order: order})
		folderByName[name] = id
		usedFolderID[id] = true
		remap[f.ID] = id
		if fallbackFolder == "" {
			fallbackFolder = id
		}
		nFolders++
	}

	if fallbackFolder == "" {
		if len(a.store.db.Folders) > 0 {
			fallbackFolder = a.store.foldersSorted()[0].ID
		} else {
			id := newID()
			a.store.db.Folders = append(a.store.db.Folders, Folder{ID: id, Name: "导入的片段", CreatedAt: now(), Order: baseOrder})
			fallbackFolder = id
		}
	}

	docFiles := map[string][]*zip.File{}
	noteFiles := map[string]*zip.File{}  // key: notes/ 下的相对路径，如「代码仓库/标题.md」
	noteLegacy := map[string]*zip.File{} // key: 老备份里的片段 ID
	for _, f := range zr.File {
		parts := strings.Split(f.Name, "/")
		if len(parts) == 3 && parts[0] == "attachments" {
			docFiles[parts[1]] = append(docFiles[parts[1]], f)
		}
		if len(parts) >= 2 && parts[0] == "notes" && strings.HasSuffix(f.Name, ".md") {
			rel := strings.TrimPrefix(f.Name, "notes/")
			noteFiles[rel] = f
			if len(parts) == 2 {
				noteLegacy[strings.TrimSuffix(parts[1], ".md")] = f
			}
		}
	}

	nDocs, nAtts := 0, 0
	for _, d := range p.Docs {
		title := trimTitle(d.Title)
		if strings.TrimSpace(title) == "" {
			continue
		}
		newDocID := d.ID
		if newDocID == "" || a.store.findDocLocked(newDocID) >= 0 {
			newDocID = newID()
		}
		fid := remap[d.FolderID]
		if fid == "" {
			fid = fallbackFolder
		}
		created := d.CreatedAt
		if created == 0 {
			created = now()
		}
		updated := d.UpdatedAt
		if updated == 0 {
			updated = created
		}

		atts := make([]Attachment, 0, len(d.Attachments))
		for _, at := range d.Attachments {
			newAtt := at
			if mode == "merge" || newAtt.ID == "" {
				newAtt.ID = newID()
			}
			entry := path.Join("attachments", d.ID, at.ID+strings.ToLower(filepath.Ext(at.Name)))
			var zf *zip.File
			for _, cand := range docFiles[d.ID] {
				if cand.Name == entry {
					zf = cand
					break
				}
			}
			if zf == nil {
				continue
			}
			dir := filepath.Join(a.store.dirPath(), "files", newDocID)
			if err := os.MkdirAll(dir, 0o755); err != nil {
				continue
			}
			dst := filepath.Join(dir, newAtt.ID+strings.ToLower(filepath.Ext(newAtt.Name)))
			rc, err := zf.Open()
			if err != nil {
				continue
			}
			out, err := os.Create(dst)
			if err != nil {
				_ = rc.Close()
				continue
			}
			n, copyErr := io.Copy(out, rc)
			_ = out.Close()
			_ = rc.Close()
			if copyErr != nil {
				_ = os.Remove(dst)
				continue
			}
			newAtt.Size = n
			if newAtt.CreatedAt == 0 {
				newAtt.CreatedAt = now()
			}
			atts = append(atts, newAtt)
			nAtts++
		}

		// 正文：新备份按 notes/<文件夹>/<标题>.md 存；老备份是 notes/<id>.md 或直接内嵌在 JSON 里
		body := d.Content
		if body == "" {
			zf := noteFiles[filepath.ToSlash(d.File)]
			if zf == nil {
				zf = noteLegacy[d.ID]
			}
			if zf != nil {
				if rc, err := zf.Open(); err == nil {
					if b, err := io.ReadAll(rc); err == nil {
						body = string(b)
					}
					_ = rc.Close()
				}
			}
		}

		rel := a.store.allocNoteRelLocked(fid, title, "")
		if err := a.store.writeNote(rel, body); err != nil {
			return 0, 0, 0, fmt.Errorf("写入正文失败")
		}

		a.store.db.Docs = append(a.store.db.Docs, Doc{
			ID: newDocID, FolderID: fid, Title: title, File: rel, Preview: previewOf(body),
			Pinned: d.Pinned, CreatedAt: created, UpdatedAt: updated,
			Attachments: atts, Tags: cleanTags(d.Tags),
		})
		a.store.cacheSet(newDocID, body)
		nDocs++
	}

	if len(p.TagColors) > 0 {
		if a.store.db.TagColors == nil {
			a.store.db.TagColors = map[string]string{}
		}
		for k, v := range p.TagColors {
			if strings.HasPrefix(v, "#") && len(v) == 7 {
				a.store.db.TagColors[strings.ToLower(k)] = v
			}
		}
	}

	if len(p.TagOrder) > 0 {
		if mode == "replace" {
			a.store.db.TagOrder = dedupeKeys(p.TagOrder)
		} else {
			merged := append([]string{}, a.store.db.TagOrder...)
			merged = append(merged, p.TagOrder...)
			a.store.db.TagOrder = dedupeKeys(merged)
		}
	}

	if err := a.store.saveLocked(); err != nil {
		return 0, 0, 0, fmt.Errorf("保存数据失败")
	}
	return nFolders, nDocs, nAtts, nil
}
