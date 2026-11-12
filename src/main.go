package main

import (
	"context"
	"embed"
	"flag"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

//go:embed all:web
var webFS embed.FS

func main() {
	var (
		port    = flag.String("port", "8080", "监听端口（只在没有 -socket 时使用，本地开发用）")
		dataIn  = flag.String("data", "", "数据目录")
		resetPw = flag.Bool("reset-password", false, "清除访问密码（片段与附件保留）")
		// TOS 的平台网关通过 /var/api/<appid>.sock 把请求转发进来，
		// 传了就用 unix socket；不传则退回 TCP 端口，方便本地调试。
		socket = flag.String("socket", "", "unix socket 路径，如 /var/api/snippethub.sock（留空则监听 TCP 端口）")
		logDir = flag.String("log", "", "日志文件路径（留空则输出到 stderr，由 systemd/journal 收集）")
	)
	flag.Parse()

	// 铁威马侧 systemd 用 journal 收日志，这里只在显式传了 -log 时才落盘，
	// 避免和系统日志重复。
	if *logDir != "" {
		if f, err := os.OpenFile(*logDir, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644); err == nil {
			log.SetOutput(f)
			defer f.Close()
		} else {
			log.Printf("open log file %s failed: %v (fallback to stderr)", *logDir, err)
		}
	}

	// 数据默认放共享文件夹 /VolumeN/snippethub（卸载/重装都不影响），
	// 共享夹还没建好时退回安装目录下的 data。老版本的数据会自动搬一次。
	dataDir, legacyDir := pickDataDir(*dataIn)
	if err := migrateData(legacyDir, dataDir); err != nil {
		log.Printf("migrate data failed: %v —— 继续使用原目录 %s", err, legacyDir)
		dataDir = legacyDir
	}
	// 首次启动时数据目录可能还没建（安装脚本会建，但目录被清掉时也要能自己恢复）。
	if err := os.MkdirAll(dataDir, 0o750); err != nil {
		log.Printf("create data dir %s failed: %v", dataDir, err)
	}

	store, err := openStore(dataDir)
	if err != nil {
		log.Fatalf("open data dir failed: %v", err)
	}
	if *resetPw {
		store.mu.Lock()
		store.db.Settings = Settings{}
		err := store.saveLocked()
		store.mu.Unlock()
		if err != nil {
			log.Fatalf("重置密码失败: %v", err)
		}
		log.Println("访问密码已清除，重新打开应用即可重新设置密码；片段与附件未受影响。")
		return
	}

	log.Printf("data dir: %s", dataDir)
	// 应用是平台建的非 root 用户跑的，把实际身份打出来，
	// 出权限问题时一条日志就能确认。
	log.Printf("running as uid=%d gid=%d", os.Getuid(), os.Getgid())

	// 后台定期清理过期登录态
	startSessionSweeper()

	// 导入会话是一次性的临时文件，重启后全部作废，直接清掉
	_ = os.RemoveAll(filepath.Join(dataDir, "import-cache"))

	// 后台预热正文缓存，第一次全文搜索不用逐篇读盘
	go store.warmCache()

	a := &api{store: store}

	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/state", a.state)
	mux.HandleFunc("POST /api/setup", a.setup)
	mux.HandleFunc("POST /api/login", a.login)
	mux.HandleFunc("POST /api/logout", a.logout)
	mux.HandleFunc("POST /api/password", a.guard(a.changePassword))
	mux.HandleFunc("POST /api/recover", a.recoverAccount)
	mux.HandleFunc("POST /api/recovery/rotate", a.guard(a.rotateRecovery))
	mux.HandleFunc("POST /api/reset", a.guard(a.resetAll))
	mux.HandleFunc("GET /api/data", a.guard(a.data))
	mux.HandleFunc("GET /api/search", a.guard(a.search))
	mux.HandleFunc("GET /api/export", a.guard(a.exportData))
	mux.HandleFunc("POST /api/import", a.guard(a.importData))
	mux.HandleFunc("POST /api/import/inspect", a.guard(a.inspectImport))
	mux.HandleFunc("POST /api/import/apply", a.guard(a.applyImport))
	mux.HandleFunc("POST /api/folders", a.guard(a.createFolder))
	mux.HandleFunc("PUT /api/folders/{id}", a.guard(a.renameFolder))
	mux.HandleFunc("DELETE /api/folders/{id}", a.guard(a.deleteFolder))
	mux.HandleFunc("POST /api/docs", a.guard(a.createDoc))
	mux.HandleFunc("GET /api/docs/{id}", a.guard(a.getDoc))
	mux.HandleFunc("PUT /api/docs/{id}", a.guard(a.updateDoc))
	mux.HandleFunc("DELETE /api/docs/{id}", a.guard(a.deleteDoc))
	mux.HandleFunc("POST /api/docs/{id}/restore", a.guard(a.restoreDoc))
	mux.HandleFunc("DELETE /api/docs/{id}/purge", a.guard(a.purgeDoc))
	mux.HandleFunc("POST /api/trash/empty", a.guard(a.emptyTrash))
	mux.HandleFunc("POST /api/docs/{id}/files", a.guard(a.uploadFiles))
	mux.HandleFunc("GET /api/docs/{id}/file", a.guard(a.downloadDocFile))
	mux.HandleFunc("GET /api/docs/{id}/files/{fid}", a.guard(a.downloadFile))
	mux.HandleFunc("DELETE /api/docs/{id}/files/{fid}", a.guard(a.deleteFile))
	mux.HandleFunc("POST /api/tags/update", a.guard(a.updateTag))
	mux.HandleFunc("POST /api/tags/delete", a.guard(a.deleteTag))
	mux.HandleFunc("POST /api/sort", a.guard(a.sortItems))
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true, "version": appVersion})
	})
	// 未匹配的 /api/* 直接回 JSON 404，不要回落成首页 HTML
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		fail(w, http.StatusNotFound, "接口不存在")
	})

	static, err := fs.Sub(webFS, "web")
	if err != nil {
		log.Fatalf("embed web assets: %v", err)
	}
	mux.Handle("/", staticHandler(static))

	srv := &http.Server{
		Handler:           noCacheHTML(stripAppPrefix(limitBodies(mux))),
		ReadHeaderTimeout: 15 * time.Second,
		IdleTimeout:       90 * time.Second,
	}

	// SIGTERM/SIGINT 优雅退出：systemd stop 和 App Center「停用」都发 SIGTERM，
	// 收到后停止接新请求、把手上的请求跑完再退，避免正在保存的片段被打断。
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	shutdown := func() {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	}

	// 只监听 unix socket，由平台 nginx + API 网关转发过来。
	// 不绑定任何 TCP 端口，所以和别的应用共存不会端口冲突。
	if *socket != "" {
		sockPath := *socket
		// socket 落在 /var/api/ 下，前端据此给窗口标题栏让出顶部安全区。
		if strings.Contains(sockPath, "/var/api/") {
			appPlatform = "tos"
		}
		// /var/api 是 /tmp/api 的软链；重启后目录还在但旧 socket 可能残留，
		// 绑定前必须先清掉，否则 bind 会报 address already in use。
		_ = os.MkdirAll(filepath.Dir(sockPath), 0o755)
		_ = os.Remove(sockPath)
		ln, err := net.Listen("unix", sockPath)
		if err != nil {
			log.Fatalf("unix socket listen failed: %v", err)
		}
		// 按规范 8.3.1 给 0660：属主是应用用户，属组是 allusers（进程的主组），
		// 平台 nginx 以 root / allusers 组运行照样能连，其它用户连不上。
		_ = os.Chmod(sockPath, 0o660)
		log.Printf("%s %s listening on %s (unix socket only, no TCP port)", appNameZH, appNameEN, sockPath)

		go func() { <-stop; log.Println("shutting down (signal received)"); shutdown() }()

		if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
			log.Fatalf("server stopped: %v", err)
		}
		_ = os.Remove(sockPath)
		log.Println("bye")
		return
	}

	// 本地开发 / 调试：没有 socket 时才退回到 TCP 端口
	srv.Addr = ":" + *port
	log.Printf("%s %s listening on :%s", appNameZH, appNameEN, *port)
	go func() { <-stop; log.Println("shutting down (signal received)"); shutdown() }()
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server stopped: %v", err)
	}
	log.Println("bye")
}

// stripAppPrefix 剥掉平台网关转发时可能保留的应用前缀。
//
// 不同入口的转发方式不一样，这里一次覆盖所有见过的形态：
//
//	/v2/proxy/snippethub/api/...  （规范 8.9 的前端请求路径）
//	/proxy/snippethub/api/...     （API 网关转发时可能只留 /proxy）
//	/snippethub/api/...           （nginx 门户路由 /<appid>/ 直通）
//
// 剥掉之后统一交给后面的 mux，路由表不用为每个入口写一套。
func stripAppPrefix(next http.Handler) http.Handler {
	prefixes := []string{
		"/v2/proxy/" + appPkg,
		"/proxy/" + appPkg,
		"/" + appPkg,
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, prefix := range prefixes {
			if r.URL.Path != prefix && !strings.HasPrefix(r.URL.Path, prefix+"/") {
				continue
			}
			p := strings.TrimPrefix(r.URL.Path, prefix)
			if p == "" {
				p = "/"
			}
			r2 := r.Clone(r.Context())
			r2.URL.Path = p
			if r.URL.RawPath != "" {
				r2.URL.RawPath = ""
			}
			next.ServeHTTP(w, r2)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// staticHandler 提供静态资源，未知路径回落到 index.html（前端单页）。
func staticHandler(static fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(static))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 未匹配到的接口（如已下线的 POST /api/xxx）不要回落成 index.html
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		p := strings.TrimPrefix(r.URL.Path, "/")
		if p == "" {
			serveIndex(w, r, static)
			return
		}
		if _, err := fs.Stat(static, p); err != nil {
			serveIndex(w, r, static)
			return
		}
		if strings.HasSuffix(p, ".js") || strings.HasSuffix(p, ".css") {
			// 用协商缓存：升级后浏览器会先问一次，避免继续用旧脚本
			w.Header().Set("Cache-Control", "no-cache")
		}
		fileServer.ServeHTTP(w, r)
	})
}

func serveIndex(w http.ResponseWriter, r *http.Request, static fs.FS) {
	buf, err := fs.ReadFile(static, "index.html")
	if err != nil {
		http.Error(w, "index.html missing", 500)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(buf)
}

func noCacheHTML(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "same-origin")
		w.Header().Set("Content-Security-Policy", contentSecurityPolicy)
		next.ServeHTTP(w, r)
	})
}

// contentSecurityPolicy 是给「正文里可能贴了别人的笔记」这种场景兜底的：
// 前端已经把用户数据全部转义、URL 也只放行 http(s) 与相对路径，这里再加一层，
// 万一哪天渲染器漏了一处，内联脚本也跑不起来。
// 说明：
//   - style-src 放开 unsafe-inline：正文/表格/图标大量使用 style="" 属性
//   - img-src 允许 http(s)：笔记里引用外链图片是正常用法
//   - frame-src 允许 about:：打印正文用的是内存里的 about:blank iframe
const contentSecurityPolicy = "default-src 'self'; " +
	"script-src 'self'; " +
	"style-src 'self' 'unsafe-inline'; " +
	"img-src 'self' data: blob: https: http:; " +
	"font-src 'self' data:; " +
	"media-src 'self' data: blob:; " +
	"connect-src 'self'; " +
	"object-src 'none'; " +
	"frame-src 'self' about:; " +
	"form-action 'self'"

// limitBodies 给请求体兜个上限，避免一个巨大的 JSON 就把内存打满。
// 上传附件和导入 zip 自己会设更大的上限，这里直接放行。
func limitBodies(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body != nil {
			var max int64
			switch {
			case strings.HasSuffix(r.URL.Path, "/files"): // 附件上传
			case strings.HasPrefix(r.URL.Path, "/api/import"): // 导入 zip
			case strings.HasPrefix(r.URL.Path, "/api/docs/"): // 正文保存
				max = 32 << 20
			case strings.HasPrefix(r.URL.Path, "/api/"):
				max = 4 << 20
			}
			if max > 0 {
				r.Body = http.MaxBytesReader(w, r.Body, max)
			}
		}
		next.ServeHTTP(w, r)
	})
}
