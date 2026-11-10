package main

import (
	"net/http"
	"os"
	"path/filepath"
)

// POST /api/reset —— 抹除全部内容与访问密码，回到「首次使用」状态。
// 不可恢复，前端会做二次文字确认。
func (a *api) resetAll(w http.ResponseWriter, r *http.Request) {
	a.store.mu.Lock()
	a.store.db.Folders = []Folder{}
	a.store.db.Docs = []Doc{}
	a.store.db.TagColors = map[string]string{}
	a.store.db.TagOrder = nil
	a.store.db.Settings = Settings{}
	err := a.store.saveLocked()
	a.store.mu.Unlock()
	if err != nil {
		fail(w, 500, "清空失败："+err.Error())
		return
	}

	// 附件与正文文件一并清掉（content 是旧版本的目录，只删不建）
	for _, sub := range []string{"files", "notes"} {
		dir := filepath.Join(a.store.dirPath(), sub)
		_ = os.RemoveAll(dir)
		_ = os.MkdirAll(dir, 0o755)
	}
	_ = os.RemoveAll(filepath.Join(a.store.dirPath(), "content"))
	a.store.cacheReset()

	dropAllSessions()
	http.SetCookie(w, &http.Cookie{
		Name: sessionCookie, Value: "", Path: "/", HttpOnly: true, MaxAge: -1,
	})

	writeJSON(w, 200, map[string]any{"ok": true})
}
