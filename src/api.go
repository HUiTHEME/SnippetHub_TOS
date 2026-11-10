package main

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type api struct {
	store *Store
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
}

func fail(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]any{"error": msg})
}

func (a *api) currentToken(r *http.Request) string {
	c, err := r.Cookie(sessionCookie)
	if err != nil {
		return ""
	}
	return c.Value
}

func (a *api) authed(r *http.Request) bool {
	return sessionValid(a.currentToken(r))
}

// guard 包装需要登录的接口。
func (a *api) guard(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !a.authed(r) {
			fail(w, http.StatusUnauthorized, "未登录或登录已过期")
			return
		}
		h(w, r)
	}
}

type appInfo struct {
	NameZH  string `json:"nameZh"`
	NameEN  string `json:"nameEn"`
	Version string `json:"version"`
	Author  string `json:"author"`
	Site    string `json:"site"`
	Slogan  string `json:"slogan"`
	DataDir string `json:"dataDir"`
}

func (a *api) info() appInfo {
	return appInfo{
		NameZH:  appNameZH,
		NameEN:  appNameEN,
		Version: appVersion,
		Author:  authorName,
		Site:    authorSite,
		Slogan:  authorSlogan,
		DataDir: a.store.dirPath(),
	}
}

// GET /api/state
func (a *api) state(w http.ResponseWriter, r *http.Request) {
	a.store.mu.RLock()
	init := a.store.db.Settings.Initialized
	hasRecovery := a.store.db.Settings.RecoveryHash != ""
	a.store.mu.RUnlock()
	info := a.info()
	authed := a.authed(r)
	if !authed {
		info.DataDir = "" // 没登录就别把服务器路径漏出去
	}
	writeJSON(w, 200, map[string]any{
		"initialized": init,
		"authed":      authed,
		"hasRecovery": hasRecovery,
		"platform":    appPlatform,
		"app":         info,
	})
}

func (a *api) setCookie(w http.ResponseWriter, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(sessionTTL.Seconds()),
	})
}

// POST /api/setup
func (a *api) setup(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		fail(w, 400, "参数错误")
		return
	}
	if len(strings.TrimSpace(in.Password)) < 4 {
		fail(w, 400, "密码至少需要 4 位")
		return
	}

	a.store.mu.Lock()
	if a.store.db.Settings.Initialized {
		a.store.mu.Unlock()
		fail(w, 409, "密码已经设置过了")
		return
	}
	salt := randHex(16)
	a.store.db.Settings = Settings{
		Initialized:  true,
		Salt:         salt,
		PasswordHash: hashPassword(in.Password, salt),
	}
	recoveryCode := a.issueRecoveryLocked()
	err := a.store.saveLocked()
	a.store.mu.Unlock()
	if err != nil {
		fail(w, 500, "保存密码失败")
		return
	}

	token := newSession()
	a.setCookie(w, token)
	writeJSON(w, 200, map[string]any{"ok": true, "recoveryCode": recoveryCode})
}

// POST /api/login
func (a *api) login(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		fail(w, 400, "参数错误")
		return
	}

	a.store.mu.RLock()
	st := a.store.db.Settings
	a.store.mu.RUnlock()

	if !st.Initialized {
		fail(w, 409, "尚未设置密码")
		return
	}
	if wait := loginLocked(); wait > 0 {
		fail(w, 429, "密码错误次数过多，请 "+itoa(int(wait))+" 秒后再试")
		return
	}
	if !verifyPassword(in.Password, st.Salt, st.PasswordHash) {
		loginFailed()
		fail(w, 401, "密码不正确")
		return
	}
	loginSucceeded()

	token := newSession()
	a.setCookie(w, token)
	writeJSON(w, 200, map[string]any{"ok": true})
}

// POST /api/logout
func (a *api) logout(w http.ResponseWriter, r *http.Request) {
	dropSession(a.currentToken(r))
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/", HttpOnly: true, MaxAge: -1,
	})
	writeJSON(w, 200, map[string]any{"ok": true})
}

// POST /api/password
func (a *api) changePassword(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Old string `json:"old"`
		New string `json:"new"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		fail(w, 400, "参数错误")
		return
	}
	if len(strings.TrimSpace(in.New)) < 4 {
		fail(w, 400, "新密码至少需要 4 位")
		return
	}

	a.store.mu.Lock()
	st := a.store.db.Settings
	if !verifyPassword(in.Old, st.Salt, st.PasswordHash) {
		a.store.mu.Unlock()
		fail(w, 403, "当前密码不正确")
		return
	}
	salt := randHex(16)
	a.store.db.Settings.Salt = salt
	a.store.db.Settings.PasswordHash = hashPassword(in.New, salt)
	err := a.store.saveLocked()
	a.store.mu.Unlock()
	if err != nil {
		fail(w, 500, "保存失败")
		return
	}
	// 改完密码，其它设备上的登录态一并作废（当前这台继续用）
	dropOtherSessions(a.currentToken(r))
	loginSucceeded()
	writeJSON(w, 200, map[string]any{"ok": true})
}

type folderOut struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	CreatedAt int64  `json:"createdAt"`
	Count     int    `json:"count"`
}

type docOut struct {
	ID          string       `json:"id"`
	FolderID    string       `json:"folderId"`
	Title       string       `json:"title"`
	Pinned      bool         `json:"pinned"`
	CreatedAt   int64        `json:"createdAt"`
	UpdatedAt   int64        `json:"updatedAt"`
	Attachments []Attachment `json:"attachments"`
	Tags        []string     `json:"tags"`
	Preview     string       `json:"preview"`
	File        string       `json:"file,omitempty"`
	DeletedAt   int64        `json:"deletedAt,omitempty"`
}

type tagOut struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
	Color string `json:"color,omitempty"`
}

// GET /api/data
func (a *api) data(w http.ResponseWriter, r *http.Request) {
	a.store.mu.RLock()
	folders := a.store.foldersSorted()
	counts := docCountByFolder(a.store.db.Docs)
	docs := make([]docOut, 0, len(a.store.db.Docs))
	trash := make([]docOut, 0)
	for _, d := range a.store.db.Docs {
		if d.DeletedAt > 0 {
			trash = append(trash, docOut{
				ID: d.ID, FolderID: d.FolderID, Title: d.Title, Pinned: d.Pinned,
				CreatedAt: d.CreatedAt, UpdatedAt: d.UpdatedAt,
				Attachments: d.Attachments, Tags: cleanTags(d.Tags),
				Preview: d.Preview, File: d.File, DeletedAt: d.DeletedAt,
			})
			continue
		}
		preview := d.Preview
		atts := d.Attachments
		if atts == nil {
			atts = []Attachment{}
		}
		docs = append(docs, docOut{
			ID: d.ID, FolderID: d.FolderID, Title: d.Title, Pinned: d.Pinned,
			CreatedAt: d.CreatedAt, UpdatedAt: d.UpdatedAt,
			Attachments: atts, Tags: cleanTags(d.Tags), Preview: preview, File: d.File,
		})
	}
	a.store.mu.RUnlock()

	sort.SliceStable(docs, func(i, j int) bool {
		if docs[i].Pinned != docs[j].Pinned {
			return docs[i].Pinned
		}
		return docs[i].UpdatedAt > docs[j].UpdatedAt
	})
	sort.SliceStable(trash, func(i, j int) bool { return trash[i].DeletedAt > trash[j].DeletedAt })

	a.store.mu.RLock()
	tagColors := make(map[string]string, len(a.store.db.TagColors))
	for k, v := range a.store.db.TagColors {
		tagColors[k] = v
	}
	tagOrder := append([]string{}, a.store.db.TagOrder...)
	a.store.mu.RUnlock()

	fo := make([]folderOut, 0, len(folders))
	for _, f := range folders {
		fo = append(fo, folderOut{ID: f.ID, Name: f.Name, CreatedAt: f.CreatedAt, Count: counts[f.ID]})
	}

	writeJSON(w, 200, map[string]any{
		"folders": fo,
		"docs":    docs,
		"trash":   trash,
		"tags":    collectTags(docs, tagColors, tagOrder),
		"app":     a.info(),
	})
}

// POST /api/folders
func (a *api) createFolder(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		fail(w, 400, "参数错误")
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		name = "新建文件夹"
	}

	f := Folder{ID: newID(), Name: name, CreatedAt: now()}
	a.store.mu.Lock()
	for _, x := range a.store.db.Folders {
		if x.Order >= f.Order {
			f.Order = x.Order + 1
		}
	}
	a.store.db.Folders = append(a.store.db.Folders, f)
	err := a.store.saveLocked()
	a.store.mu.Unlock()
	if err != nil {
		fail(w, 500, "保存失败")
		return
	}
	writeJSON(w, 200, folderOut{ID: f.ID, Name: f.Name, CreatedAt: f.CreatedAt, Count: 0})
}

// PUT /api/folders/{id}
func (a *api) renameFolder(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		fail(w, 400, "参数错误")
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" {
		fail(w, 400, "名称不能为空")
		return
	}

	id := r.PathValue("id")
	a.store.mu.Lock()
	idx := a.store.findFolderLocked(id)
	if idx < 0 {
		a.store.mu.Unlock()
		fail(w, 404, "文件夹不存在")
		return
	}
	a.store.db.Folders[idx].Name = name
	a.store.resyncFolderLocked(id)
	err := a.store.saveLocked()
	a.store.mu.Unlock()
	if err != nil {
		fail(w, 500, "保存失败")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// DELETE /api/folders/{id}
func (a *api) deleteFolder(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	a.store.mu.Lock()
	idx := a.store.findFolderLocked(id)
	if idx < 0 {
		a.store.mu.Unlock()
		fail(w, 404, "文件夹不存在")
		return
	}
	removed := 0
	for i := range a.store.db.Docs {
		if a.store.db.Docs[i].FolderID == id && a.store.db.Docs[i].DeletedAt == 0 {
			a.store.db.Docs[i].DeletedAt = now()
			removed++
		}
	}
	a.store.db.Folders = append(a.store.db.Folders[:idx], a.store.db.Folders[idx+1:]...)
	err := a.store.saveLocked()
	a.store.mu.Unlock()
	if err != nil {
		fail(w, 500, "保存失败")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "removed": removed})
}

// POST /api/docs
func (a *api) createDoc(w http.ResponseWriter, r *http.Request) {
	var in struct {
		FolderID string   `json:"folderId"`
		Title    string   `json:"title"`
		Tags     []string `json:"tags"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		fail(w, 400, "参数错误")
		return
	}
	t := now()
	d := Doc{
		ID: newID(), FolderID: in.FolderID, Title: trimTitle(in.Title),
		CreatedAt: t, UpdatedAt: t, Attachments: []Attachment{},
		Tags:    cleanTags(in.Tags),
		Content: "",
	}

	a.store.mu.Lock()
	if a.store.findFolderLocked(d.FolderID) < 0 {
		a.store.mu.Unlock()
		fail(w, 400, "请先选择或创建一个文件夹")
		return
	}
	d.File = a.store.allocNoteRelLocked(d.FolderID, d.Title, "")
	a.store.db.Docs = append(a.store.db.Docs, d)
	if err := a.store.writeNote(d.File, ""); err != nil {
		// 正文没写成功就把刚加进内存的记录撤掉，别留下一条「索引里有、文件没有」的碎片
		a.store.db.Docs = a.store.db.Docs[:len(a.store.db.Docs)-1]
		a.store.mu.Unlock()
		fail(w, 500, "创建正文文件失败")
		return
	}
	err := a.store.saveLocked()
	a.store.mu.Unlock()
	if err != nil {
		fail(w, 500, "保存失败")
		return
	}
	writeJSON(w, 200, d)
}

// GET /api/docs/{id}
func (a *api) getDoc(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	a.store.mu.RLock()
	idx := a.store.findDocLocked(id)
	var d Doc
	if idx >= 0 {
		d = a.store.db.Docs[idx]
	}
	a.store.mu.RUnlock()
	if idx < 0 {
		fail(w, 404, "片段不存在")
		return
	}
	if d.Attachments == nil {
		d.Attachments = []Attachment{}
	}
	body, err := a.store.readContent(id)
	if err != nil {
		fail(w, 500, "读取正文失败")
		return
	}
	d.Content = body
	writeJSON(w, 200, d)
}

// PUT /api/docs/{id}
func (a *api) updateDoc(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Title    *string   `json:"title"`
		Content  *string   `json:"content"`
		Pinned   *bool     `json:"pinned"`
		FolderID *string   `json:"folderId"`
		Tags     *[]string `json:"tags"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		fail(w, 400, "参数错误")
		return
	}

	id := r.PathValue("id")
	a.store.mu.Lock()
	idx := a.store.findDocLocked(id)
	if idx < 0 {
		a.store.mu.Unlock()
		fail(w, 404, "片段不存在")
		return
	}
	d := &a.store.db.Docs[idx]
	if d.DeletedAt > 0 && (in.Content != nil || in.Title != nil || in.Tags != nil) {
		a.store.mu.Unlock()
		fail(w, 400, "这条内容在废纸篓里，请先恢复再编辑")
		return
	}

	if in.Title != nil {
		d.Title = trimTitle(*in.Title)
	}
	if in.Pinned != nil {
		d.Pinned = *in.Pinned
	}
	if in.Tags != nil {
		d.Tags = cleanTags(*in.Tags)
	}
	if in.FolderID != nil && *in.FolderID != "" {
		if a.store.findFolderLocked(*in.FolderID) >= 0 {
			d.FolderID = *in.FolderID
		}
	}

	// 标题或文件夹变了 → 正文文件跟着改名 / 搬家（notes/<文件夹>/<标题>.md）
	a.store.syncDocFileLocked(idx)

	body := ""
	if in.Content != nil {
		body = *in.Content
		if err := a.store.writeNote(d.File, body); err != nil {
			a.store.mu.Unlock()
			fail(w, 500, "保存正文失败")
			return
		}
		d.Preview = previewOf(body)
		a.store.cacheSet(d.ID, body)
	} else {
		body, _ = a.store.readNote(d.File)
	}
	d.UpdatedAt = now()
	saved := *d
	saved.Content = body
	err := a.store.saveLocked()
	a.store.mu.Unlock()
	if err != nil {
		fail(w, 500, "保存失败")
		return
	}
	writeJSON(w, 200, saved)
}

// DELETE /api/docs/{id}
func (a *api) deleteDoc(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	a.store.mu.Lock()
	idx := a.store.findDocLocked(id)
	if idx < 0 {
		a.store.mu.Unlock()
		fail(w, 404, "片段不存在")
		return
	}
	a.store.db.Docs[idx].DeletedAt = now()
	err := a.store.saveLocked()
	a.store.mu.Unlock()
	if err != nil {
		fail(w, 500, "保存失败")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "trashed": true})
}

func attachPath(dir, docID string, att Attachment) string {
	return filepath.Join(dir, "files", docID, att.ID+strings.ToLower(filepath.Ext(att.Name)))
}

// POST /api/docs/{id}/files
func (a *api) uploadFiles(w http.ResponseWriter, r *http.Request) {
	docID := r.PathValue("id")
	if !isHexID(docID) {
		fail(w, 400, "参数错误")
		return
	}
	a.store.mu.RLock()
	idx := a.store.findDocLocked(docID)
	a.store.mu.RUnlock()
	if idx < 0 {
		fail(w, 404, "片段不存在")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 2<<30)
	mr, err := r.MultipartReader()
	if err != nil {
		fail(w, 400, "上传格式错误")
		return
	}

	targetDir := filepath.Join(a.store.dirPath(), "files", docID)
	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		fail(w, 500, "无法创建附件目录")
		return
	}

	var added []Attachment
	for {
		part, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			fail(w, 400, "上传中断")
			return
		}
		name := part.FileName()
		if name == "" {
			_ = part.Close()
			continue
		}
		att := Attachment{ID: newID(), Name: filepath.Base(name), CreatedAt: now()}
		f, err := os.Create(attachPath(a.store.dirPath(), docID, att))
		if err != nil {
			_ = part.Close()
			fail(w, 500, "写入附件失败")
			return
		}
		n, copyErr := io.Copy(f, part)
		_ = f.Close()
		_ = part.Close()
		if copyErr != nil {
			_ = os.Remove(attachPath(a.store.dirPath(), docID, att))
			fail(w, 500, "写入附件失败")
			return
		}
		att.Size = n
		added = append(added, att)
	}

	if len(added) > 0 {
		a.store.mu.Lock()
		if i := a.store.findDocLocked(docID); i >= 0 {
			a.store.db.Docs[i].Attachments = append(a.store.db.Docs[i].Attachments, added...)
			a.store.db.Docs[i].UpdatedAt = now()
			_ = a.store.saveLocked()
		}
		a.store.mu.Unlock()
	}
	writeJSON(w, 200, map[string]any{"ok": true, "added": added})
}

// GET /api/docs/{id}/files/{fid}
func (a *api) downloadFile(w http.ResponseWriter, r *http.Request) {
	docID, fid := r.PathValue("id"), r.PathValue("fid")
	if !isHexID(docID) || !isHexID(fid) {
		fail(w, 400, "参数错误")
		return
	}
	a.store.mu.RLock()
	idx := a.store.findDocLocked(docID)
	var target *Attachment
	if idx >= 0 {
		for i := range a.store.db.Docs[idx].Attachments {
			if a.store.db.Docs[idx].Attachments[i].ID == fid {
				cp := a.store.db.Docs[idx].Attachments[i]
				target = &cp
				break
			}
		}
	}
	a.store.mu.RUnlock()
	if target == nil || !isHexID(target.ID) {
		fail(w, 404, "附件不存在")
		return
	}

	path := attachPath(a.store.dirPath(), docID, *target)
	f, err := os.Open(path)
	if err != nil {
		fail(w, 404, "附件文件已丢失")
		return
	}
	defer f.Close()

	ctype := mime.TypeByExtension(filepath.Ext(target.Name))
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	disposition := "attachment"
	// 只有「预览也无害」的类型才允许 inline；html / svg / xml 这类能带脚本的一律强制下载，
	// 并且 inline 时再加一层 CSP sandbox，万一被当页面打开也跑不了脚本。
	if r.URL.Query().Get("inline") == "1" && !riskyInline(ctype) {
		disposition = "inline"
		w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'")
	}
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Content-Disposition", disposition+"; filename=\""+sanitizeASCII(target.Name)+"\"; filename*=UTF-8''"+url.PathEscape(target.Name))
	http.ServeContent(w, r, target.Name, timeFromUnix(target.CreatedAt), f)
}

// riskyInline 判断这类文件在浏览器里内联打开时能不能执行脚本。
func riskyInline(ctype string) bool {
	switch strings.ToLower(strings.TrimSpace(strings.Split(ctype, ";")[0])) {
	case "text/html", "application/xhtml+xml", "image/svg+xml",
		"text/xml", "application/xml", "application/javascript", "text/javascript":
		return true
	}
	return false
}

// GET /api/docs/{id}/file —— 下载片段正文的 .md 原文件（真实存在磁盘上的那一份）
func (a *api) downloadDocFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	a.store.mu.RLock()
	idx := a.store.findDocLocked(id)
	var rel, title string
	var updated int64
	if idx >= 0 {
		rel = a.store.db.Docs[idx].File
		title = a.store.db.Docs[idx].Title
		updated = a.store.db.Docs[idx].UpdatedAt
	}
	a.store.mu.RUnlock()
	if idx < 0 {
		fail(w, 404, "片段不存在")
		return
	}

	filePath := a.store.notePath(rel)
	f, err := os.Open(filePath)
	if err != nil {
		fail(w, 404, "正文文件已丢失")
		return
	}
	defer f.Close()

	name := filepath.Base(filepath.FromSlash(rel))
	if rel == "" || name == "." || name == "/" {
		name = strings.TrimSpace(title) + ".md"
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+sanitizeASCII(name)+"\"; filename*=UTF-8''"+url.PathEscape(name))
	http.ServeContent(w, r, name, timeFromUnix(updated), f)
}

func (a *api) deleteFile(w http.ResponseWriter, r *http.Request) {
	docID, fid := r.PathValue("id"), r.PathValue("fid")
	if !isHexID(docID) || !isHexID(fid) {
		fail(w, 400, "参数错误")
		return
	}
	a.store.mu.Lock()
	idx := a.store.findDocLocked(docID)
	if idx < 0 {
		a.store.mu.Unlock()
		fail(w, 404, "片段不存在")
		return
	}
	d := &a.store.db.Docs[idx]
	var removed *Attachment
	kept := d.Attachments[:0]
	for _, at := range d.Attachments {
		if at.ID == fid {
			cp := at
			removed = &cp
			continue
		}
		kept = append(kept, at)
	}
	d.Attachments = kept
	d.UpdatedAt = now()
	err := a.store.saveLocked()
	a.store.mu.Unlock()

	if removed != nil && isHexID(removed.ID) {
		_ = os.Remove(attachPath(a.store.dirPath(), docID, *removed))
	}
	if err != nil {
		fail(w, 500, "保存失败")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

func sanitizeASCII(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		if r < 32 || r > 126 || r == '"' || r == '\\' {
			out = append(out, '_')
			continue
		}
		out = append(out, r)
	}
	if len(out) == 0 {
		return "download"
	}
	return string(out)
}
