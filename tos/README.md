# 片段HUB · 铁威马 TOS 7 打包工程

这里是 SnippetHub 在**铁威马（TerraMaster）TOS 7** 上的打包工程：平台元数据、
systemd 单元、Debian 生命周期脚本，以及打包脚本。业务代码在仓库根目录的 `src/`，
两边是同一份。

产物：`dist/tos/snippethub_<platform>.deb`（单包 deb，安装到 `/usr/local/snippethub/`）

---

## 一、目录结构

```
tos/
├── build.sh                    构建脚本（编译 + 打包 deb）
├── config.ini                  平台元数据（JSON，扩展名沿平台惯例叫 .ini）
├── snippethub.lang             26 语言文案（TOS 7.0 要求至少前 14 种）
├── snippethub.env              systemd EnvironmentFile
├── images/icons/snippethub.svg 应用图标（SVG，≤50 KB）
├── init.d/snippethub.service   systemd 单元（装到应用目录，由 postinst 链接到 /etc/systemd/system）
├── DEBIAN/                     control + postinst/prerm/postrm
└── preview.sh                  侧载调试用：临时挂 nginx 预览路由
```

打出来的 deb 内部结构：

```
snippethub_x86_64.deb
├── DEBIAN/{control,postinst,prerm,postrm}
└── usr/local/snippethub/
    ├── config.ini
    ├── snippethub.lang
    ├── snippethub.env
    ├── images/icons/snippethub.svg
    ├── init.d/snippethub.service
    ├── bin/snippethub
    └── webui.bz2                解压后是 webui/ 目录，页面由此提供
```

运行时还会多出（不由 deb 管理，卸载也不会删）：

```
/usr/local/snippethub/data/      业务数据：db.json、notes/、files/
/usr/local/snippethub/logs/
/usr/local/snippethub/webui/     postinst 从 webui.bz2 解出来的页面
/var/api/snippethub.sock         平台代理用的 unix socket
```

---

## 二、构建

```bash
# 需要 Go 1.21+ 和 python3
./tos/build.sh x86_64      # 出 x86_64 包
./tos/build.sh aarch64     # 出 aarch64 包
./tos/build.sh all         # 两个都出
```

脚本会先比对 `tos/config.ini` 的 `version` 和 `src/store.go` 里的 `appVersion`，
不一致直接报错（避免出现「商店显示 1.0.0、程序自称 0.9.9」）。

> macOS 上没有 `dpkg-deb`，所以 `tools/mkdeb.py` 直接按 ar + tar.gz 的格式拼出
> 标准 deb（`debian-binary` / `control.tar.gz` / `data.tar.gz`），不需要装任何额外工具。

---

## 三、安装

```bash
# 在 NAS 上（root）
dpkg -i snippethub_x86_64.deb
systemctl status snippethub
curl --unix-socket /var/api/snippethub.sock http://localhost/api/health
# {"ok":true,"version":"1.0.0"}
```

卸载（用户数据保留）：

```bash
dpkg -r snippethub        # 移除程序，data/ 留着
dpkg --purge snippethub   # 连程序目录一起清掉（data/ 同样保留）
```

### 侧载之后页面为什么 404

TOS 的 `/<appid>/` 路由、`/v2/proxy/<appid>/` 代理和平台鉴权（`auth_request`
到 `127.0.0.1:5057`）都是**应用中心安装时由平台生成**的，生成的配置落在
`/etc/nginx/AppAccessControl/` 下。用 `dpkg -i` 手工侧载时平台不认这个应用，
所以页面会 404 —— 这不是包做错了。

调试时可以临时挂一条预览路由（**没有平台鉴权**，只有应用自己的密码）：

```bash
./tos/preview.sh on      # 之后打开 http://<NAS>:8181/snippethub/
./tos/preview.sh status
./tos/preview.sh off     # 调试完记得关
```

正式给用户装，请走应用中心（见下一节）。

---

## 四、提交到应用中心

1. 把 `dist/tos/snippethub_x86_64.deb`（和 arm64 包）传到 GitHub/Gitee Release；
2. 在 [开发者平台](https://developer.terra-master.com) 创建应用
   （`app_id` = `snippethub`，`kind` = `deb`，`platform` = `x86_64` / `aarch64` 各建一个），
   `repo` 填 Release 所在的仓库地址；
3. 走「创建版本 → 轮询任务 → 看解析结果 → 确认」的两阶段流程，
   详见平台文档 `Developer/agent-api/README.md` 第 6.4 节；
4. 解析阶段会校验：`config.ini` 的十个必填字段、`id` 与 App ID 一致、
   `platform` 一致、`application_type` 为 `deb`、26 语言文件非空、图标 ≤50 KB 且无脚本。

`config.ini` 里几处需要注意的：

- `help` 是**必填**，填 `https://github.com/HUiTHEME/SnippetHub_TOS`（也可以换成产品主页）；
- `recommend` 必须写 `false`，这是平台审核后自己置位的字段；
- `id` 不能以 `tos` 开头（平台保留了 nginx 路由命名空间）；
- `low_version` 写 `TOS7.0`。

---

## 五、数据放在哪

默认 `/usr/local/snippethub/data`（物理位置 `/Volume<N>/@apps/snippethub/data`）。
它不在 deb 文件清单里，所以**升级、卸载重装都不会丢**。

**应用内不提供「数据目录」设置**。原因：TOS 的目录权限是自研的
`tmacl`，应用用户进不去共享文件夹和个人目录，界面上让人填路径只会一路报「没有权限」，
反而把「数据到底存哪儿」这件事搞复杂。现在数据固定放在上面的默认目录，
位置由 systemd 的 `-data` 参数决定，要改就改 `/usr/local/snippethub/snippethub.env`。

`notes/<文件夹>/<标题>.md` 就是磁盘上的原始 Markdown，SMB 挂上去能直接看、直接改。

---

## 六、踩过的坑（改代码前先看这几条）

1. **`Group=` 必须写 `allusers`，不能写 `snippethub`**。TOS 建应用用户时主组是
   `allusers`，同名的组根本不存在，写 `Group=snippethub` 会让 systemd 在
   `ExecStart` 之前就以 `216/GROUP` 失败；换成别的组又会丢掉 `allusers` 成员身份，
   共享文件夹就读不到了。规范要求显式声明 `Group`，所以写 `Group=allusers`。
2. **不要配置 `Restart=` / `RestartSec=`**。规范把重启策略交给平台管理，
   只保留 `StartLimitBurst` / `StartLimitIntervalSec` 防崩溃循环。
3. **不要开 `PrivateTmp=true`**。`/var/api` 在 TOS 上是 `/tmp/api` 的软链，私有
   `/tmp` 命名空间会让它挂不上，服务以 `226/NAMESPACE` 起不来。
4. **`ReadWritePaths` 只放开自己的 data/logs 和 `/var/api`**。`ProtectSystem=strict`
   下 `/usr/local` 是只读的，这两个目录必须显式列出来，否则启动即 EROFS。
5. **systemd 单元要落到 `/etc/systemd/system/`**。规范要求单元文件放在应用目录
   `init.d/` 下，但 systemd 不会去扫那里，`postinst` 里 `ln -sf` 一条链接过去，
   `postrm` 里删掉。
6. **socket 权限给 0666**。规范写的是 0660，但 `/var/api` 是 1777 共享目录、平台
   nginx 以另一个用户组访问，0666 两边都能过，省掉一堆权限问题。
7. **`Set-Cookie` 的 `Path` 必须是 `/`**。登录 cookie（`sh_sid`）要能跟着
   `/v2/proxy/snippethub/*` 的请求一起发出去，否则一刷新就掉登录。
8. **打包别带 `._*` / `.DS_Store`**。macOS 会在目录里留 AppleDouble 文件，
   打进去以后会被平台当成页面资源，`build.sh` 已经过滤掉。
9. **行尾必须 LF**。`postinst` 混进 CRLF 会让 TOS 报 `bad interpreter`，
   `build.sh` 打包前统一转一遍。
10. **前端每一个请求都要带 `X-Csrf-Token`，包括启动探测和文件下载**。
   平台网关对「有会话但缺 token」的请求回 **403**（而不是文档里写的 401），
   对「会话无效」才回 `200 {"please login"}` —— 很容易误判成「服务没起来」。
   两个具体教训：
   - `detectBase()` 里那几次探测请求一开始是裸 `fetch`，漏了 token，
     结果 `/v2/proxy/<id>/api/state` 被 403，所有候选全失败，
     页面就停在「无法连接到应用服务」；
   - `<a download>` 是浏览器原生发起的请求，**带不上**自定义头，
     所以附件下载、备份导出这类二进制下载必须改成 `fetch` → `blob` → 触发保存
     （见 `downloadViaApi()`），否则点下载就是 403。
11. **窗口顶部要留 40px**。TOS 的窗口标题栏是**浮在 iframe 之上**的（窗口按钮压在页面
    最上面那一行），应用不留白的话，侧栏 logo、搜索框、正文标题整行都会被挡住。
    实现方式：后端按 socket 路径判断平台（`/var/api/` 开头即 TOS），在 `state` 里返回
    `platform`；前端挂到 `<html data-platform="tos">`，CSS 里
    `html[data-platform="tos"]{--safe-top:40px}`，`.app` / `.gate` / `.boot` / `.modal`
    这些 `position:fixed` 的全屏容器统一 `inset:var(--safe-top) 0 0 0`。
    ⚠️ `index.html` 里那段内联预判只能写 `seg === 'snippethub'`，**别写成「第一段不是
    app 就当 TOS」**——本地开发和 `file://` 预览会被误判，凭空多出一块空白。
12. **TOS 的目录权限是自研的 `tmacl`，`setfacl` 不生效**。文件系统挂载参数里带 `tmacl`，
    `setfacl -m u:snippethub:rwx <dir>` 之后 `getfacl` 能看到条目，但内核判权限时不采用
    （`access()` 依然拒绝）。默认数据目录 `/usr/local/snippethub/data` 属主就是应用用户，
    不受影响 —— 这也是 TOS 把应用数据放 `@apps` 下的原因。
13. **`share_folders` 只在应用中心安装时生效**。`config.ini` 里声明了
    `"share_folders": ["data"]`，从 App Center 安装时平台会建好共享文件夹并配好权限；
    但 `dpkg -i` 侧载不会触发（实测 `/Volume1` 下什么都没多出来）。
14. **`low_version` 写 `7.0`，不要写 `TOS7.0`**。规范要求纯数字的 MAJOR.MINOR
   （或 MAJOR.MINOR.PATCH），带前缀在人工审核那关会被挑出来。
15. **卸载脚本绝对不能删 `data`**（这是一次真实事故，务必保留这条）。
    TOS 应用中心里的「重装 / 修复安装」走的是 `dpkg --purge`，`/var/log/dpkg.log`
    里会记成 `configure <appid> <ver> <none>`（`<none>` 表示视为全新安装）。
    早期版本的 `postrm` 在 purge 分支里 `rm -rf data`，用户只要重装一次，
    所有片段和附件就全没了。现在 `postrm` 只清 `webui/`（可从 `webui.bz2` 重建）
    和残留 socket，`data`/`logs`/应用用户都不碰 —— 删了账号，下次安装 UID 会变，
    `data` 的属主对不上，等于换个方式把数据锁死。
    自测 `purge` 是否安全时，**用 ASCII 文件名做标记**：拿中文文件名配 `test -f`
    判断会被 bash 编码问题影响，误报成"数据被删"。
16. **开机自启的两个坑（实测踩过）**。
   1. `/etc/systemd/system/<appid>.service` 必须是**复制**过去的实体文件，不能是
      指向 `/usr/local/<appid>/init.d/` 的软链：应用目录在 `/Volume1/@apps` 上，
      开机早期卷还没挂，软链是断的，systemd 直接把单元判成 not-found 跳过
      （日志：`Failed to open /etc/systemd/system/<appid>.service: No such file or directory`）。
   2. 光有 `RequiresMountsFor=` 还不够。unit 在开机很早时就被加载，那时卷没挂，
      systemd 解析路径会当成「在根文件系统上」，于是不生成挂载依赖，服务照旧在
      卷挂载前启动，然后死在建立命名空间这一步：
      `Failed to set up mount namespacing: .../Volume1/@apps/<appid>/data: No such file or directory`
      （`226/NAMESPACE`）。必须显式写 `Wants=tnas-mntdata.service` 和
      `After=... tnas-mntdata.service` —— `/Volume1` 是 TOS 自己的挂载服务挂的。
   验证：`systemctl reboot` 后看 `journalctl -b | grep -E "Volume1 success|Started SnippetHub"`，
   后者的时间必须晚于前者。

17. **连接失败不要复用「解锁」界面**。`detectBase()` 抛错时如果直接
   `showGate(true)`，用户看到的是「请输入访问密码」+「无法连接到应用服务」，
   会以为密码错了。现在走 `showConnectError()`：输入框禁用、按钮变「重试」、
   下面列出「检查应用是否运行 → 重试 → 重启应用」的步骤。
