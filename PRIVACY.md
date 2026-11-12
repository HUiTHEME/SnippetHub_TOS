# 隐私政策 · Privacy Policy

片段HUB（SnippetHub）· 最后更新：2026-11-12

---

## 中文

### 一句话

这是一个**完全在你的 NAS 本地运行**的应用，没有账号、没有云服务、没有遥测。我们不会收集、上传或看到你的任何内容。

### 我们收集什么

**什么都不收集。** 应用没有服务器端账号体系，不接入任何第三方统计、广告、推送或崩溃上报服务，运行时不向外发起任何网络请求（页面所需的脚本与样式全部打包在应用内）。

### 你的数据存在哪里

- 你创建的片段、文件夹、标签、附件，只写在你自己的 NAS 上（默认 `/<卷名>/snippethub`，可在应用信息里查看实际路径）
- 访问密码与恢复码只保存 **PBKDF2-HMAC-SHA256（21 万轮）** 的哈希，无法反推原文
- 登录会话保存在浏览器 Cookie 中，只用于本机登录状态

### 会不会外传

不会。导出备份、下载附件都由你的浏览器直接从 NAS 取，不经过任何第三方。

### 你的控制权

- 随时可以导出全部数据（设置 →「数据备份」→ 下载），得到标准 zip 与其中的 Markdown 原文
- 随时可以抹除全部数据（设置 →「数据备份」→ 抹除数据）
- 卸载应用不会删除共享文件夹里的数据；要一并删除，请在「文件管理」里删除该文件夹

### 联系方式

有任何隐私相关问题，可以在这里提：<https://github.com/HUiTHEME/SnippetHub_TOS/issues>

---

## English

### Summary

SnippetHub runs **entirely on your own NAS**. There is no account, no cloud service and no telemetry. We do not collect, upload or have access to any of your content.

### What we collect

**Nothing.** The application has no server-side account system, integrates no analytics, advertising, push or crash-reporting service, and makes no outbound network requests at runtime (all scripts and stylesheets are shipped inside the package).

### Where your data lives

- Snippets, folders, tags and attachments are written only to your own NAS (by default `/<volume>/snippethub`; the exact path is shown in the app).
- The access password and recovery code are stored only as **PBKDF2-HMAC-SHA256 (210,000 iterations)** hashes and cannot be reversed.
- The login session lives in a browser cookie and is used solely for the local sign-in state.

### Sharing

Never. Backups and attachment downloads are transferred directly from your NAS to your browser; no third party is involved.

### Your control

- Export everything at any time (Settings → Data backup → Download) — you get a standard zip with plain Markdown files.
- Erase everything at any time (Settings → Data backup → Erase data).
- Uninstalling the application does not delete the data in the shared folder; delete that folder in File Manager if you want it gone.

### Contact

For any privacy question: <https://github.com/HUiTHEME/SnippetHub_TOS/issues>
