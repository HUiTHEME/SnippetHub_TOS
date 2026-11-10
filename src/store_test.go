package main

import (
	"fmt"
	"strings"
	"testing"
)

func TestIsHexID(t *testing.T) {
	good := newID()
	if !isHexID(good) {
		t.Fatalf("newID() %q 不是合法 id", good)
	}
	for _, bad := range []string{"", "../etc", "ABCDEF0123456789", "abcdef012345678", "abcdef0123456789a", "abcdef01-2345678"} {
		if isHexID(bad) {
			t.Fatalf("%q 不该通过校验", bad)
		}
	}
}

func TestSafePathName(t *testing.T) {
	cases := []struct{ in, want string }{
		{"正常标题", "正常标题"},
		{"a/b\\c:d*e?f\"g<h>i|j", "a_b_c_d_e_f_g_h_i_j"},
		{"  前后空格  ", "前后空格"},
		{"...点点...", "点点"},
		{"", "未命名"},
	}
	for _, c := range cases {
		if got := safePathName(c.in, "未命名"); got != c.want {
			t.Fatalf("safePathName(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	// 超长标题截断后仍是 80 个字符
	long := strings.Repeat("字", 120)
	if n := len([]rune(safePathName(long, "x"))); n != 80 {
		t.Fatalf("超长标题截断后为 %d 字符，want 80", n)
	}
}

func TestCleanTags(t *testing.T) {
	got := cleanTags([]string{" #Go ", "go", "", "  ", "Vue", "GO"})
	if len(got) != 2 || got[0] != "Go" || got[1] != "Vue" {
		t.Fatalf("cleanTags = %v", got)
	}
	many := make([]string, 0, 20)
	for i := 0; i < 20; i++ {
		many = append(many, fmt.Sprintf("t%d", i))
	}
	if n := len(cleanTags(many)); n != 12 {
		t.Fatalf("标签上限 = %d, want 12", n)
	}
}

func TestNotePathRejectsEscape(t *testing.T) {
	s := &Store{cache: map[string]string{}}
	s.setDirPath("/tmp/sh-test-notes")

	for _, rel := range []string{"../../etc/passwd", "a/../../../x.md", "..", "/etc/passwd"} {
		if p := s.notePath(rel); p != "" && !strings.HasPrefix(p, "/tmp/sh-test-notes/notes/") {
			t.Fatalf("notePath(%q) 逃出了 notes：%q", rel, p)
		}
	}
	if p := s.notePath("文件夹/标题.md"); p != "/tmp/sh-test-notes/notes/文件夹/标题.md" {
		t.Fatalf("正常路径解析错误：%q", p)
	}
}
