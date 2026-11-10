package main

import (
	"net/http"
	"strings"
	"unicode/utf8"
)

type searchHit struct {
	ID      string `json:"id"`
	Snippet string `json:"snippet,omitempty"`
}

// GET /api/search?q=xxx
// 标题 + 正文全文搜索。正文走内存缓存（见 Store.contentOf），几百篇的量级下
// 每次按键扫一遍也只有毫秒级开销，前端再加 150ms 防抖即可。
func (a *api) search(w http.ResponseWriter, r *http.Request) {
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeJSON(w, 200, map[string]any{"q": "", "hits": []searchHit{}})
		return
	}

	a.store.mu.RLock()
	docs := make([]Doc, len(a.store.db.Docs))
	copy(docs, a.store.db.Docs)
	a.store.mu.RUnlock()

	ql := strings.ToLower(q)
	hits := make([]searchHit, 0, 8)
	for _, d := range docs {
		if d.DeletedAt > 0 { // 废纸篓里的不参与搜索
			continue
		}
		if strings.Contains(strings.ToLower(d.Title), ql) {
			hits = append(hits, searchHit{ID: d.ID})
			continue
		}
		body := a.store.contentOf(d.ID)
		if body == "" {
			continue
		}
		if idx := indexFold(body, q); idx >= 0 {
			hits = append(hits, searchHit{ID: d.ID, Snippet: lineSnippet(body, idx)})
		}
	}
	writeJSON(w, 200, map[string]any{"q": q, "hits": hits})
}

// indexFold 在 body 里找 q 并返回字节下标，ASCII 字母不区分大小写，且**不分配内存**。
//
// 之前是 strings.Index(strings.ToLower(body), ql)：每敲一个字，就把整库正文各复制一份成小写。
// 180 篇 / 12MB 的库，一次按键要多分配 12MB 临时对象，输入法联想一路打下来 GC 会明显发烫。
// 这里逐字节比较：中文按 UTF-8 原样比（不受大小写影响），英文大小写折叠只对 A-Z 生效，
// 而 A-Z 折叠前后字节数不变，所以命中位置可以直接当字节偏移用。
func indexFold(body, q string) int {
	m := len(q)
	if m == 0 {
		return 0
	}
	n := len(body)
	if m > n {
		return -1
	}
	first := lowerASCII(q[0])
	for i := 0; i+m <= n; i++ {
		if lowerASCII(body[i]) != first {
			continue
		}
		if hasPrefixFold(body[i:i+m], q) {
			return i
		}
	}
	return -1
}

func lowerASCII(c byte) byte {
	if c >= 'A' && c <= 'Z' {
		return c + 'a' - 'A'
	}
	return c
}

func hasPrefixFold(s, q string) bool {
	if len(s) < len(q) {
		return false
	}
	for i := 0; i < len(q); i++ {
		if lowerASCII(s[i]) != lowerASCII(q[i]) {
			return false
		}
	}
	return true
}

// lineSnippet 取命中处所在的那一行；行太长时围绕命中点裁剪，保证命中词可见。
func lineSnippet(body string, idx int) string {
	if idx < 0 || idx > len(body) {
		return ""
	}
	start := strings.LastIndexByte(body[:idx], '\n') + 1
	end := strings.IndexByte(body[idx:], '\n')
	if end < 0 {
		end = len(body)
	} else {
		end += idx
	}
	raw := strings.TrimRight(body[start:end], "\r")
	rel := idx - start

	// 去掉行首缩进（代码行常见），同步修正命中点在行内的位置
	line := strings.TrimLeft(raw, " \t")
	rel -= len(raw) - len(line)
	if rel < 0 {
		rel = 0
	}

	// 列表里的摘要只有一行宽，命中词必须落在开头附近，否则会被截断看不见
	const maxRunes, keepBefore = 56, 4
	rs := []rune(line)
	mr := utf8.RuneCountInString(line[:min(rel, len(line))])
	from := mr - keepBefore
	if from < 0 {
		from = 0
	}
	to := from + maxRunes
	if to > len(rs) {
		to = len(rs)
	}
	out := string(rs[from:to])
	if from > 0 {
		out = "…" + out
	}
	if to < len(rs) {
		out += "…"
	}
	return out
}
