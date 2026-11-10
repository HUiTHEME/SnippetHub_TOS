package main

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

func previewOf(content string) string {
	preview := strings.TrimSpace(content)
	if rs := []rune(preview); len(rs) > 90 {
		preview = string(rs[:90])
	}
	return preview
}

// POST /api/docs/{id}/restore —— 从废纸篓恢复
func (a *api) restoreDoc(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	a.store.mu.Lock()
	idx := a.store.findDocLocked(id)
	if idx < 0 {
		a.store.mu.Unlock()
		fail(w, 404, "片段不存在")
		return
	}
	d := &a.store.db.Docs[idx]
	if d.DeletedAt == 0 {
		a.store.mu.Unlock()
		fail(w, 400, "这条内容不在废纸篓里")
		return
	}

	// 原文件夹可能已被删除，恢复到可用位置
	if a.store.findFolderLocked(d.FolderID) < 0 {
		if len(a.store.db.Folders) > 0 {
			d.FolderID = a.store.db.Folders[0].ID
		} else {
			f := Folder{ID: newID(), Name: "收件箱", CreatedAt: now()}
			a.store.db.Folders = append(a.store.db.Folders, f)
			d.FolderID = f.ID
		}
	}
	d.DeletedAt = 0
	d.UpdatedAt = now()
	a.store.syncDocFileLocked(idx)
	err := a.store.saveLocked()
	a.store.mu.Unlock()
	if err != nil {
		fail(w, 500, "保存失败")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true})
}

// DELETE /api/docs/{id}/purge —— 彻底删除（含附件）
func (a *api) purgeDoc(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if !isHexID(id) {
		fail(w, 400, "参数错误")
		return
	}
	a.store.mu.Lock()
	idx := a.store.findDocLocked(id)
	if idx < 0 {
		a.store.mu.Unlock()
		fail(w, 404, "片段不存在")
		return
	}
	if a.store.db.Docs[idx].DeletedAt == 0 {
		a.store.mu.Unlock()
		fail(w, 400, "请先把它移到废纸篓")
		return
	}
	rel := a.store.db.Docs[idx].File
	a.store.db.Docs = append(a.store.db.Docs[:idx], a.store.db.Docs[idx+1:]...)
	err := a.store.saveLocked()
	dir := a.store.dirPath()
	a.store.mu.Unlock()
	if err != nil {
		fail(w, 500, "保存失败")
		return
	}
	// 索引已经落盘成功，再删文件和正文，避免「删了文件但索引没保存」这种对不上的情况
	_ = os.RemoveAll(filepath.Join(dir, "files", id))
	a.store.removeNote(rel)
	a.store.cacheDrop(id)
	writeJSON(w, 200, map[string]any{"ok": true})
}

// POST /api/trash/empty —— 清空废纸篓
func (a *api) emptyTrash(w http.ResponseWriter, r *http.Request) {
	a.store.mu.Lock()
	type gone struct{ id, rel string }
	var removed []gone
	kept := make([]Doc, 0, len(a.store.db.Docs))
	for _, d := range a.store.db.Docs {
		if d.DeletedAt > 0 {
			removed = append(removed, gone{d.ID, d.File})
			continue
		}
		kept = append(kept, d)
	}
	a.store.db.Docs = kept
	err := a.store.saveLocked()
	dir := a.store.dirPath()
	a.store.mu.Unlock()

	if err != nil {
		fail(w, 500, "保存失败")
		return
	}
	for _, g := range removed {
		if isHexID(g.id) {
			_ = os.RemoveAll(filepath.Join(dir, "files", g.id))
		}
		a.store.removeNote(g.rel)
		a.store.cacheDrop(g.id)
	}
	writeJSON(w, 200, map[string]any{"ok": true, "removed": len(removed)})
}
