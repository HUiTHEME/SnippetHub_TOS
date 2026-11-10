package main

import (
	"encoding/json"
	"net/http"
	"strings"
)

// normalizeColor 只接受 #rgb / #rrggbb，统一成小写六位。
func normalizeColor(c string) (string, bool) {
	c = strings.TrimSpace(c)
	if c == "" {
		return "", true
	}
	if !strings.HasPrefix(c, "#") {
		return "", false
	}
	hex := strings.ToLower(c[1:])
	if len(hex) == 3 {
		hex = string([]byte{hex[0], hex[0], hex[1], hex[1], hex[2], hex[2]})
	}
	if len(hex) != 6 {
		return "", false
	}
	for _, r := range hex {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f')) {
			return "", false
		}
	}
	return "#" + hex, true
}

func (a *api) tagExistsLocked(key string) bool {
	for _, d := range a.store.db.Docs {
		for _, t := range d.Tags {
			if strings.ToLower(t) == key {
				return true
			}
		}
	}
	_, ok := a.store.db.TagColors[key]
	return ok
}

// POST /api/tags/update  { name, newName, color }
// 同时支持重命名与上色；newName 为空表示不改名，color 为空表示清除颜色。
func (a *api) updateTag(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name    string `json:"name"`
		NewName string `json:"newName"`
		Color   string `json:"color"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		fail(w, 400, "参数错误")
		return
	}
	key := strings.ToLower(strings.TrimSpace(in.Name))
	if key == "" {
		fail(w, 400, "标签名称不能为空")
		return
	}

	target := ""
	if strings.TrimSpace(in.NewName) != "" && strings.TrimSpace(in.NewName) != in.Name {
		cleaned := cleanTags([]string{in.NewName})
		if len(cleaned) == 0 {
			fail(w, 400, "标签名称不合法")
			return
		}
		target = cleaned[0]
	}

	color, ok := normalizeColor(in.Color)
	if !ok {
		fail(w, 400, "颜色格式不正确")
		return
	}

	a.store.mu.Lock()
	if !a.tagExistsLocked(key) {
		a.store.mu.Unlock()
		fail(w, 404, "标签不存在")
		return
	}

	if target != "" {
		newKey := strings.ToLower(target)
		for i := range a.store.db.Docs {
			tags := make([]string, 0, len(a.store.db.Docs[i].Tags))
			for _, t := range a.store.db.Docs[i].Tags {
				if strings.ToLower(t) == key {
					tags = append(tags, target)
				} else if strings.ToLower(t) != newKey {
					tags = append(tags, t)
				}
			}
			a.store.db.Docs[i].Tags = cleanTags(tags)
		}
		if c, exists := a.store.db.TagColors[key]; exists {
			delete(a.store.db.TagColors, key)
			a.store.db.TagColors[newKey] = c
		}
		if len(a.store.db.TagOrder) > 0 {
			next := make([]string, 0, len(a.store.db.TagOrder))
			for _, k := range a.store.db.TagOrder {
				if k == key {
					k = newKey
				}
				next = append(next, k)
			}
			a.store.db.TagOrder = dedupeKeys(next)
		}
		key = newKey
	}

	if color == "" {
		delete(a.store.db.TagColors, key)
	} else {
		a.store.db.TagColors[key] = color
	}

	err := a.store.saveLocked()
	a.store.mu.Unlock()
	if err != nil {
		fail(w, 500, "保存失败")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "name": target, "color": color})
}

// POST /api/tags/delete  { name }
func (a *api) deleteTag(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		fail(w, 400, "参数错误")
		return
	}
	key := strings.ToLower(strings.TrimSpace(in.Name))
	if key == "" {
		fail(w, 400, "标签名称不能为空")
		return
	}

	a.store.mu.Lock()
	if !a.tagExistsLocked(key) {
		a.store.mu.Unlock()
		fail(w, 404, "标签不存在")
		return
	}
	affected := 0
	for i := range a.store.db.Docs {
		tags := make([]string, 0, len(a.store.db.Docs[i].Tags))
		hit := false
		for _, t := range a.store.db.Docs[i].Tags {
			if strings.ToLower(t) == key {
				hit = true
				continue
			}
			tags = append(tags, t)
		}
		if hit {
			a.store.db.Docs[i].Tags = tags
			a.store.db.Docs[i].UpdatedAt = now()
			affected++
		}
	}
	delete(a.store.db.TagColors, key)
	if len(a.store.db.TagOrder) > 0 {
		next := make([]string, 0, len(a.store.db.TagOrder))
		for _, k := range a.store.db.TagOrder {
			if k != key {
				next = append(next, k)
			}
		}
		a.store.db.TagOrder = next
	}
	err := a.store.saveLocked()
	a.store.mu.Unlock()
	if err != nil {
		fail(w, 500, "保存失败")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "affected": affected})
}

func dedupeKeys(in []string) []string {
	out := make([]string, 0, len(in))
	seen := make(map[string]bool, len(in))
	for _, k := range in {
		if k == "" || seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, k)
	}
	return out
}
