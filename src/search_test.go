package main

import (
	"strings"
	"testing"
)

func TestIndexFold(t *testing.T) {
	body := "## 标题\n\nconst FooBar = 1\n第二行 HELLO world\n"
	cases := []struct {
		q    string
		want int
	}{
		{"foobar", strings.Index(strings.ToLower(body), "foobar")},
		{"FOOBAR", strings.Index(strings.ToLower(body), "foobar")},
		{"hello", strings.Index(strings.ToLower(body), "hello")},
		{"第二行", strings.Index(body, "第二行")},
		{"不存在的词", -1},
	}
	for _, c := range cases {
		if got := indexFold(body, c.q); got != c.want {
			t.Fatalf("indexFold(%q) = %d, want %d", c.q, got, c.want)
		}
	}

	// 空查询：约定返回 0（调用方已先判空，这里只是别 panic）
	if got := indexFold(body, ""); got != 0 {
		t.Fatalf("empty query = %d, want 0", got)
	}
	// 比正文还长的查询
	if got := indexFold("ab", "abc"); got != -1 {
		t.Fatalf("long query = %d, want -1", got)
	}
}

// 大小写折叠只对 ASCII 生效，中文必须原样命中，命中位置要能直接当字节偏移用。
func TestIndexFoldMatchesToLower(t *testing.T) {
	body := "第一段 Alpha\n第二段 beta\n第三段 GAMMA\n"
	for _, q := range []string{"alpha", "BETA", "gamma", "第二段", "段"} {
		want := strings.Index(strings.ToLower(body), strings.ToLower(q))
		if got := indexFold(body, q); got != want {
			t.Fatalf("indexFold(%q) = %d, want %d", q, got, want)
		}
	}
}

func TestLineSnippetKeepsHit(t *testing.T) {
	body := "line one\n  const targetValue = 1;\nline three"
	idx := indexFold(body, "targetvalue")
	if idx < 0 {
		t.Fatal("hit not found")
	}
	snip := lineSnippet(body, idx)
	if !strings.Contains(snip, "targetValue") {
		t.Fatalf("snippet %q lost the hit", snip)
	}
}
