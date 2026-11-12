package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	appVersion   = "1.0.6"
	appNameZH    = "片段HUB"
	appNameEN    = "SnippetHub"
	appPkg       = "snippethub"
	authorName   = "疯狂的大叔"
	authorSite   = "https://github.com/HUiTHEME/SnippetHub_TOS"
	authorSlogan = "一个装代码、装教程、装想法的私人仓库"
)

// appPlatform 是运行环境的标识，运行时确定：
//
//	tos —— 铁威马 TOS（socket 固定为 /var/api/<appid>.sock，
//	       窗口顶部有约 40px 的标题栏，前端要留出这块安全区）
//	""  —— 本地开发：直接监听 TCP 端口，没有窗口标题栏，不需要安全区
var appPlatform = ""

// Attachment 是挂在片段上的附件。
type Attachment struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Size      int64  `json:"size"`
	CreatedAt int64  `json:"createdAt"`
}

// Doc 是一条片段记录。
type Doc struct {
	ID       string `json:"id"`
	FolderID string `json:"folderId"`
	Title    string `json:"title"`
	// File 是正文在 notes/ 下的相对路径，例如「代码仓库/WordPress 缩略图.md」。
	File string `json:"file,omitempty"`
	// Content 只在内存里临时使用（迁移、导入、读取），不进 db.json。
	Content     string       `json:"content,omitempty"`
	Preview     string       `json:"preview,omitempty"`
	Pinned      bool         `json:"pinned"`
	DeletedAt   int64        `json:"deletedAt,omitempty"`
	CreatedAt   int64        `json:"createdAt"`
	UpdatedAt   int64        `json:"updatedAt"`
	Attachments []Attachment `json:"attachments"`
	Tags        []string     `json:"tags"`
}

// Folder 是左侧的文件夹。
type Folder struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt int64  `json:"createdAt"`
	Order     int    `json:"order"`
}

// Settings 保存密码与基础信息。
type Settings struct {
	Initialized  bool   `json:"initialized"`
	PasswordHash string `json:"passwordHash"`
	Salt         string `json:"salt"`
	RecoveryHash string `json:"recoveryHash,omitempty"`
	RecoverySalt string `json:"recoverySalt,omitempty"`
}

type database struct {
	Folders   []Folder          `json:"folders"`
	Docs      []Doc             `json:"docs"`
	Settings  Settings          `json:"settings"`
	TagColors map[string]string `json:"tagColors"`
	TagOrder  []string          `json:"tagOrder,omitempty"`
}

// Store 负责内存数据与磁盘 JSON 的同步。
type Store struct {
	mu   sync.RWMutex
	dirv atomic.Value // string：当前数据目录，迁移时会换，读侧不用拿锁
	file string
	db   database

	// 正文内存缓存：全文搜索要遍历所有 .md，逐次读盘在 NAS 上太慢。
	// cmu 单独一把锁，避免与 mu 的调用顺序纠缠（readContent 有时在持有 mu 时调用）。
	cmu     sync.Mutex
	cache   map[string]string
	cacheSz int // 缓存里正文的字节数，超过预算就整体丢掉重新预热
}

// cacheBudget 限制正文缓存占用的内存，避免几千篇大文档把 NAS 内存吃光。
const cacheBudget = 64 << 20

// dirPath 取当前数据目录（迁移目录时会换，统一走这里，读写都不会打架）。
func (s *Store) dirPath() string {
	if v, ok := s.dirv.Load().(string); ok {
		return v
	}
	return ""
}

func (s *Store) setDirPath(dir string) { s.dirv.Store(dir) }

func newID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return hex.EncodeToString([]byte(time.Now().Format(time.RFC3339Nano)))
	}
	return hex.EncodeToString(b)
}

// isHexID 校验 16 位小写十六进制 id（newID 的产物）。
// 任何会拿 id 拼文件路径的地方都先过一遍，防止手改 db.json 或构造请求造成目录穿越。
func isHexID(s string) bool {
	if len(s) != 16 {
		return false
	}
	for i := 0; i < len(s); i++ {
		c := s[i]
		if !((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) {
			return false
		}
	}
	return true
}

func now() int64 { return time.Now().Unix() }

// normalizeDoc 补齐空切片、清理标签。
func normalizeDoc(d *Doc) {
	if d.Attachments == nil {
		d.Attachments = []Attachment{}
	}
	d.Tags = cleanTags(d.Tags)
}

// cleanTags 去空、去重、限长，最多保留 12 个标签。
func cleanTags(in []string) []string {
	out := make([]string, 0, len(in))
	seen := map[string]bool{}
	for _, t := range in {
		t = strings.TrimSpace(t)
		t = strings.TrimPrefix(t, "#")
		if t == "" {
			continue
		}
		if rs := []rune(t); len(rs) > 20 {
			t = string(rs[:20])
		}
		key := strings.ToLower(t)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, t)
		if len(out) >= 12 {
			break
		}
	}
	return out
}

func timeFromUnix(ts int64) time.Time { return time.Unix(ts, 0) }

// writeFileSync 写临时文件并 fsync 后再由调用方 rename。
// NAS 上直接 rename 一个还在页缓存里的文件，遇到断电会留下 0 字节的正文/索引，
// 这里多一次 fsync（每篇只有几 KB，开销可忽略），换来「要么旧的、要么新的」。
func writeFileSync(path string, data []byte, perm os.FileMode) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		return err
	}
	return f.Close()
}

func openStore(dir string) (*Store, error) {
	for _, sub := range []string{"", "files", "notes"} {
		if err := os.MkdirAll(filepath.Join(dir, sub), 0o755); err != nil {
			return nil, err
		}
	}
	s := &Store{file: filepath.Join(dir, "db.json"), cache: map[string]string{}}
	s.setDirPath(dir)
	s.db = database{Folders: []Folder{}, Docs: []Doc{}}

	// 注意：db.json 解析失败时绝不能当成「空库」继续跑——那样下一次保存就会把
	// 用户唯一的一份索引覆盖掉。这里先把坏文件改名留档，再以空库启动，并打日志。
	raw, err := os.ReadFile(s.file)
	if err == nil && len(raw) == 0 {
		// 0 字节通常意味着上一次写入中途被打断（断电/强杀）。
		// 正文 .md 还在磁盘上，但索引没了，这里留一条明确日志，别让用户以为是「数据被清空」。
		log.Printf("db.json 是空文件，本次以空索引启动；正文仍在 notes/ 下，可从备份或 .broken 文件恢复索引")
	}
	if err == nil && len(raw) > 0 {
		var db database
		if err := json.Unmarshal(raw, &db); err == nil {
			s.db = db
		} else {
			broken := s.file + ".broken-" + time.Now().Format("20060102-150405")
			if rerr := os.Rename(s.file, broken); rerr == nil {
				log.Printf("db.json 解析失败（%v），已备份为 %s，本次以空索引启动", err, broken)
			} else {
				log.Printf("db.json 解析失败（%v），备份也失败（%v），请立即手动备份数据目录", err, rerr)
			}
		}
	}
	if s.db.Folders == nil {
		s.db.Folders = []Folder{}
	}
	if s.db.Docs == nil {
		s.db.Docs = []Doc{}
	}
	if s.db.TagColors == nil {
		s.db.TagColors = map[string]string{}
	}
	for i := range s.db.Docs {
		normalizeDoc(&s.db.Docs[i])
	}

	// 迁移：老版本正文内嵌在 db.json、或存在 content/<id>.md；
	// 现在统一搬到 notes/<文件夹>/<标题>.md，索引里只记 file。
	if s.migrateNotesLocked() {
		_ = s.saveLocked()
	}

	return s, nil
}

// ---------- 正文存放：notes/<文件夹>/<标题>.md ----------

func (s *Store) notesDir() string { return filepath.Join(s.dirPath(), "notes") }

// notePath 相对路径统一用 / 保存，落盘时再换成本地分隔符。
// rel 来自索引（可能被手工改过 db.json），这里校验它必须落在 notes/ 内，否则返回空串，
// 调用方把空串当「文件不存在」处理，避免目录穿越读到 notes 之外的文件。
func (s *Store) notePath(rel string) string {
	full := filepath.Join(s.dirPath(), "notes", filepath.FromSlash(rel))
	root := filepath.Join(s.dirPath(), "notes")
	if full != root && !strings.HasPrefix(full, root+string(os.PathSeparator)) {
		return ""
	}
	return full
}

// safePathName 把标题 / 文件夹名变成安全的文件名：替换路径分隔符与非法字符，去掉首尾空格与点，限 80 字符。
func safePathName(in, fallback string) string {
	var b strings.Builder
	for _, r := range strings.TrimSpace(in) {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|':
			b.WriteRune('_')
		default:
			if r < 0x20 || r == 0x7f {
				continue
			}
			b.WriteRune(r)
		}
	}
	out := strings.Trim(b.String(), " .")
	if rs := []rune(out); len(rs) > 80 {
		out = strings.TrimRight(string(rs[:80]), " .")
	}
	if out == "" {
		out = fallback
	}
	return out
}

// folderDirLocked 文件夹对应的目录名；文件夹已被删掉就归到「未归类」。
func (s *Store) folderDirLocked(folderID string) string {
	for _, f := range s.db.Folders {
		if f.ID == folderID {
			return safePathName(f.Name, "未命名文件夹")
		}
	}
	return "未归类"
}

// allocNoteRelLocked 给一篇内容分配不冲突的相对路径：同一文件夹里标题重名就加 (2)。
func (s *Store) allocNoteRelLocked(folderID, title, selfID string) string {
	dir := s.folderDirLocked(folderID)
	base := safePathName(title, "未命名片段")
	used := make(map[string]bool, len(s.db.Docs))
	for i := range s.db.Docs {
		if selfID != "" && s.db.Docs[i].ID == selfID {
			continue
		}
		if rel := s.db.Docs[i].File; rel != "" {
			used[strings.ToLower(rel)] = true
		}
	}
	rel := dir + "/" + base + ".md"
	for n := 2; used[strings.ToLower(rel)]; n++ {
		rel = fmt.Sprintf("%s/%s (%d).md", dir, base, n)
	}
	return rel
}

// moveNote 把正文文件搬到新位置（文件名/文件夹变了才会调用）。
func (s *Store) moveNote(from, to string) error {
	if from == to {
		return nil
	}
	dst := s.notePath(to)
	if dst == "" {
		return fmt.Errorf("目标路径不合法")
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	if from == "" {
		return nil
	}
	src := s.notePath(from)
	if src == "" {
		return fmt.Errorf("源路径不合法")
	}
	if _, err := os.Stat(src); err != nil {
		return nil // 旧文件不在，交给调用方决定是否新建
	}
	if err := os.Rename(src, dst); err != nil {
		return err
	}
	s.pruneEmptyDirs(filepath.Dir(src))
	return nil
}

// pruneEmptyDirs 清掉 notes 下因此变空的文件夹目录（notes 本身保留）。
func (s *Store) pruneEmptyDirs(dir string) {
	root := filepath.Clean(s.notesDir())
	for {
		d := filepath.Clean(dir)
		if d == root || !strings.HasPrefix(d, root+string(os.PathSeparator)) {
			return
		}
		entries, err := os.ReadDir(d)
		if err != nil || len(entries) > 0 {
			return
		}
		if err := os.Remove(d); err != nil {
			return
		}
		dir = filepath.Dir(d)
	}
}

func (s *Store) readNote(rel string) (string, error) {
	if rel == "" {
		return "", nil
	}
	b, err := os.ReadFile(s.notePath(rel))
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return string(b), nil
}

func (s *Store) writeNote(rel, text string) error {
	if rel == "" {
		return fmt.Errorf("缺少文件路径")
	}
	p := s.notePath(rel)
	if p == "" {
		return fmt.Errorf("文件路径不合法")
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := writeFileSync(tmp, []byte(text), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p)
}

func (s *Store) removeNote(rel string) {
	if rel == "" {
		return
	}
	p := s.notePath(rel)
	_ = os.Remove(p)
	s.pruneEmptyDirs(filepath.Dir(p))
}

// readContent 按 id 读正文：先查索引里的 file，再读盘。
func (s *Store) readContent(id string) (string, error) {
	s.mu.RLock()
	rel := ""
	if idx := s.findDocLocked(id); idx >= 0 {
		rel = s.db.Docs[idx].File
	}
	s.mu.RUnlock()
	body, err := s.readNote(rel)
	if err == nil {
		s.cacheSet(id, body)
	}
	return body, err
}

func (s *Store) cacheSet(id, text string) {
	if id == "" {
		return
	}
	s.cmu.Lock()
	if s.cache == nil {
		s.cache = map[string]string{}
	}
	if old, ok := s.cache[id]; ok {
		s.cacheSz -= len(old)
	}
	s.cache[id] = text
	s.cacheSz += len(text)
	if s.cacheSz > cacheBudget { // 超预算就整体丢掉，下次用到再按需读盘
		s.cache = map[string]string{}
		s.cacheSz = 0
	}
	s.cmu.Unlock()
}

func (s *Store) cacheDrop(id string) {
	s.cmu.Lock()
	if old, ok := s.cache[id]; ok {
		s.cacheSz -= len(old)
		delete(s.cache, id)
	}
	s.cmu.Unlock()
}

func (s *Store) cacheReset() {
	s.cmu.Lock()
	s.cache = map[string]string{}
	s.cacheSz = 0
	s.cmu.Unlock()
}

// contentOf 取正文，命中缓存就不读盘（缓存由 readContent 维护）。
func (s *Store) contentOf(id string) string {
	s.cmu.Lock()
	if v, ok := s.cache[id]; ok {
		s.cmu.Unlock()
		return v
	}
	s.cmu.Unlock()
	body, err := s.readContent(id)
	if err != nil {
		return ""
	}
	return body
}

// warmCache 启动后在后台把所有正文读进内存，第一次搜索不用等逐篇读盘。
// 用 4 个并发读：机械盘上顺序读 180 篇约 1–2 秒，串行要更久；
// 并发度也别太高，NAS 的盘本来就慢，开太多线程只会互相抢磁道。
func (s *Store) warmCache() {
	s.mu.RLock()
	ids := make([]string, 0, len(s.db.Docs))
	for _, d := range s.db.Docs {
		ids = append(ids, d.ID)
	}
	s.mu.RUnlock()

	sem := make(chan struct{}, 4)
	var wg sync.WaitGroup
	for _, id := range ids {
		wg.Add(1)
		sem <- struct{}{}
		go func(id string) {
			defer wg.Done()
			defer func() { <-sem }()
			_ = s.contentOf(id)
		}(id)
	}
	wg.Wait()
}

// syncDocFileLocked 让某篇正文文件跟当前的文件夹 / 标题保持一致（改名、搬家）。
func (s *Store) syncDocFileLocked(idx int) {
	if idx < 0 || idx >= len(s.db.Docs) {
		return
	}
	d := &s.db.Docs[idx]
	want := s.allocNoteRelLocked(d.FolderID, d.Title, d.ID)
	if want == d.File {
		return
	}
	if err := s.moveNote(d.File, want); err != nil {
		return
	}
	d.File = want
}

// resyncFolderLocked 文件夹改名后，把里面所有正文搬到新目录。
func (s *Store) resyncFolderLocked(folderID string) {
	for i := range s.db.Docs {
		if s.db.Docs[i].FolderID == folderID {
			s.syncDocFileLocked(i)
		}
	}
}

// migrateNotesLocked 把老数据整理成 notes/<文件夹>/<标题>.md，可重复执行。
func (s *Store) migrateNotesLocked() bool {
	changed := false
	legacyDir := filepath.Join(s.dirPath(), "content")

	// 1) 正文还嵌在 db.json 里的老版本：先落到 content/<id>.md
	for i := range s.db.Docs {
		d := &s.db.Docs[i]
		if d.Content != "" {
			if err := os.MkdirAll(legacyDir, 0o755); err == nil {
				if err := os.WriteFile(filepath.Join(legacyDir, d.ID+".md"), []byte(d.Content), 0o600); err == nil {
					d.Preview = previewOf(d.Content)
					d.Content = ""
					changed = true
				}
			}
		}
	}

	// 2) 逐篇确定目标路径，必要时把 content/<id>.md 搬过去
	for i := range s.db.Docs {
		d := &s.db.Docs[i]
		want := s.allocNoteRelLocked(d.FolderID, d.Title, d.ID)
		legacy := filepath.Join(legacyDir, d.ID+".md")
		target := s.notePath(want)

		if _, err := os.Stat(target); os.IsNotExist(err) {
			moved := false
			if d.File != "" {
				if _, e := os.Stat(s.notePath(d.File)); e == nil {
					_ = s.moveNote(d.File, want)
					moved = true
				}
			}
			if !moved {
				if _, e := os.Stat(legacy); e == nil {
					if err := os.MkdirAll(filepath.Dir(target), 0o755); err == nil {
						if err := os.Rename(legacy, target); err == nil {
							moved = true
						}
					}
				}
			}
			if !moved {
				_ = s.writeNote(want, "")
			}
		}
		if d.File != want {
			d.File = want
			changed = true
		}

		if d.Preview == "" {
			if body, err := s.readNote(d.File); err == nil && body != "" {
				d.Preview = previewOf(body)
				changed = true
			}
		}
	}

	_ = os.Remove(legacyDir) // 空了就顺手删掉
	return changed
}

func (s *Store) saveLocked() error {
	// 索引不落正文：正文在 content/<id>.md
	snap := s.db
	snap.Docs = make([]Doc, len(s.db.Docs))
	copy(snap.Docs, s.db.Docs)
	for i := range snap.Docs {
		snap.Docs[i].Content = ""
	}
	buf, err := json.MarshalIndent(snap, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.file + ".tmp"
	if err := writeFileSync(tmp, buf, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}

func (s *Store) findFolderLocked(id string) int {
	for i := range s.db.Folders {
		if s.db.Folders[i].ID == id {
			return i
		}
	}
	return -1
}

func (s *Store) findDocLocked(id string) int {
	for i := range s.db.Docs {
		if s.db.Docs[i].ID == id {
			return i
		}
	}
	return -1
}

func (s *Store) foldersSorted() []Folder {
	out := append([]Folder{}, s.db.Folders...)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Order != out[j].Order {
			return out[i].Order < out[j].Order
		}
		if out[i].CreatedAt == out[j].CreatedAt {
			return out[i].Name < out[j].Name
		}
		return out[i].CreatedAt < out[j].CreatedAt
	})
	return out
}

func docCountByFolder(docs []Doc) map[string]int {
	m := map[string]int{}
	for _, d := range docs {
		if d.DeletedAt > 0 { // 废纸篓里的不算在文件夹数量里
			continue
		}
		m[d.FolderID]++
	}
	return m
}

func trimTitle(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "未命名片段"
	}
	return s
}
