package main

import (
	"encoding/json"
	"net/http"
	"strings"
)

// POST /api/sort  { kind: "folder" | "tag", order: ["id 或标签名", ...] }
// 侧栏长按拖拽排序后自动调用，把顺序落盘。
func (a *api) sortItems(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Kind  string   `json:"kind"`
		Order []string `json:"order"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		fail(w, 400, "参数错误")
		return
	}

	switch in.Kind {
	case "folder":
		pos := make(map[string]int, len(in.Order))
		for i, id := range in.Order {
			pos[id] = i
		}
		a.store.mu.Lock()
		tail := len(in.Order)
		for i := range a.store.db.Folders {
			if p, ok := pos[a.store.db.Folders[i].ID]; ok {
				a.store.db.Folders[i].Order = p
				continue
			}
			// 未出现在提交列表里的文件夹排到最后，保持原有相对顺序
			a.store.db.Folders[i].Order = tail
			tail++
		}
		err := a.store.saveLocked()
		a.store.mu.Unlock()
		if err != nil {
			fail(w, 500, "保存失败")
			return
		}

	case "tag":
		keys := make([]string, 0, len(in.Order))
		seen := make(map[string]bool, len(in.Order))
		for _, name := range in.Order {
			k := strings.ToLower(strings.TrimSpace(name))
			if k == "" || seen[k] {
				continue
			}
			seen[k] = true
			keys = append(keys, k)
		}
		a.store.mu.Lock()
		a.store.db.TagOrder = keys
		err := a.store.saveLocked()
		a.store.mu.Unlock()
		if err != nil {
			fail(w, 500, "保存失败")
			return
		}

	default:
		fail(w, 400, "未知的排序类型")
		return
	}

	writeJSON(w, 200, map[string]any{"ok": true, "count": len(in.Order)})
}
