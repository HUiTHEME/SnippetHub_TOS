package main

import (
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"strconv"
)

// 数据放在共享文件夹里，而不是应用安装目录：
//
//	/Volume1/snippethub
//
// 这么做有三个好处：
//   - 卸载/重装应用不会碰用户数据（安装目录删干净了，数据还在共享夹里）；
//   - 安装目录卸载后不留任何残留，满足应用中心的卸载检查；
//   - 共享夹在「文件管理」里能看到，SMB 挂上去也能直接翻 notes/*.md。
//
// 平台在应用中心安装时会按 config.ini 的 share_folders 建好这个文件夹并授权给
// 应用用户；用 dpkg 侧载时由 postinst 兜底创建，两边都能用。
const shareFolder = "snippethub"

// exeDir 返回二进制所在目录（/usr/local/snippethub/bin → /usr/local/snippethub）。
func exeDir() string {
	p, err := os.Executable()
	if err != nil {
		return "."
	}
	if r, err := filepath.EvalSymlinks(p); err == nil {
		p = r
	}
	return filepath.Dir(filepath.Dir(p))
}

// writableDir 真建一个临时文件来判断，和运行期实际能力一致
// （只看权限位会被 ACL 骗）。
func writableDir(dir string) bool {
	f, err := os.CreateTemp(dir, ".sh-wtest-*")
	if err != nil {
		return false
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return true
}

// pickDataDir 决定这次用哪个目录存数据，并返回「老版本用的那个目录」供迁移。
//
// 优先级：显式 -data 参数 > /VolumeN/snippethub（第一个存在且可写的） > 安装目录下的 data。
// 最后那个只作为兜底：比如共享夹还没建好、或者本地调试。
func pickDataDir(explicit string) (dir string, legacy string) {
	legacy = filepath.Join(exeDir(), "data")
	if explicit != "" {
		if abs, err := filepath.Abs(explicit); err == nil {
			return abs, legacy
		}
		return explicit, legacy
	}
	for i := 1; i <= 9; i++ {
		base := filepath.Join("/Volume"+strconv.Itoa(i), shareFolder)
		st, err := os.Stat(base)
		if err != nil || !st.IsDir() || !writableDir(base) {
			continue
		}
		return base, legacy
	}
	return legacy, legacy
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

func treeStats(dir string, subs []string) (files int, bytes int64) {
	for _, sub := range subs {
		_ = filepath.WalkDir(filepath.Join(dir, sub), func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			if info, ierr := d.Info(); ierr == nil {
				files++
				bytes += info.Size()
			}
			return nil
		})
	}
	return
}

func copyOne(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	if err := os.MkdirAll(filepath.Dir(dst), 0o750); err != nil {
		return err
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// copyTree 把 db.json / notes / files 复制到新目录（其它缓存类的东西不搬）。
func copyTree(from, to string) error {
	if err := os.MkdirAll(to, 0o750); err != nil {
		return err
	}
	if fileExists(filepath.Join(from, "db.json")) {
		if err := copyOne(filepath.Join(from, "db.json"), filepath.Join(to, "db.json")); err != nil {
			return err
		}
	}
	for _, sub := range []string{"notes", "files"} {
		src := filepath.Join(from, sub)
		if _, err := os.Stat(src); err != nil {
			continue
		}
		err := filepath.WalkDir(src, func(p string, d os.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			rel, rerr := filepath.Rel(src, p)
			if rerr != nil {
				return rerr
			}
			dst := filepath.Join(to, sub, rel)
			if d.IsDir() {
				return os.MkdirAll(dst, 0o750)
			}
			return copyOne(p, dst)
		})
		if err != nil {
			return err
		}
	}
	return nil
}

// migrateData 把老版本放在安装目录里的数据搬到共享文件夹。
//
// 只在「老目录有 db.json、新目录还没有」时动手；复制完逐项核对文件数与字节数，
// 对不上就不切换（调用方会退回老目录），并且**不删除任何东西** —— 老目录留着，
// 用户确认没问题后自己清掉即可。
func migrateData(from, to string) error {
	if from == "" || to == "" || filepath.Clean(from) == filepath.Clean(to) {
		return nil
	}
	if !fileExists(filepath.Join(from, "db.json")) || fileExists(filepath.Join(to, "db.json")) {
		return nil
	}
	subs := []string{"notes", "files"}
	wantFiles, wantBytes := treeStats(from, subs)
	if fileExists(filepath.Join(from, "db.json")) {
		if info, err := os.Stat(filepath.Join(from, "db.json")); err == nil {
			wantFiles++
			wantBytes += info.Size()
		}
	}
	log.Printf("migrating data %s -> %s (%d files, %d bytes)", from, to, wantFiles, wantBytes)
	if err := copyTree(from, to); err != nil {
		return err
	}
	gotFiles, gotBytes := treeStats(to, subs)
	if fileExists(filepath.Join(to, "db.json")) {
		if info, err := os.Stat(filepath.Join(to, "db.json")); err == nil {
			gotFiles++
			gotBytes += info.Size()
		}
	}
	if gotFiles < wantFiles || gotBytes < wantBytes {
		return fmt.Errorf("迁移不完整：应 %d 个文件 / %d 字节，实际 %d 个 / %d 字节",
			wantFiles, wantBytes, gotFiles, gotBytes)
	}
	log.Printf("data migrated OK (%d files, %d bytes)；旧目录 %s 保留，可自行删除", gotFiles, gotBytes, from)
	return nil
}
