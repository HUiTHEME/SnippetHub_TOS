package main

import (
	"os"
	"path/filepath"
)

// storeStats 是「文件数 + 总字节数」。导入备份时用它判断当前目录里
// 到底有没有旧数据（有没有东西要归档到 _replaced-<时间>/ 里）。
type storeStats struct {
	files int
	bytes int64
}

func (s storeStats) add(n int64) storeStats {
	s.files++
	s.bytes += n
	return s
}

// statStore 统计 notes + files 里的文件数与字节数。
func statStore(dir string) storeStats {
	var st storeStats
	for _, sub := range []string{"notes", "files"} {
		_ = filepath.WalkDir(filepath.Join(dir, sub), func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			if info, ierr := d.Info(); ierr == nil {
				st = st.add(info.Size())
			}
			return nil
		})
	}
	return st
}
