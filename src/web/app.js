/* ================= 片段HUB SnippetHub ================= */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

let BASE = '';
let logoSeq = 0;

const state = {
  initialized: false,
  authed: false,
  app: null,
  folders: [],
  docs: [],
  trash: [],
  tags: [],
  view: { type: 'all', id: null },
  currentId: null,
  doc: null,
  editing: false,
  dirty: false,
  query: '',
  hits: new Map(),      // 全文搜索命中：id -> 正文片段（标题命中时为 ''）
  hitsQuery: '',        // hits 对应的关键词，避免旧结果套到新词上
  saving: false,
  hasRecovery: false,
  connectFailed: false,  // 启动时连不上后端：密码页换成「重试」，别让人以为是要输密码
  theme: { mode: 'dark', accent: '#e2644c', font: 'system', scale: 1, code: 'midnight' },
};

/* ---------- 工具 ---------- */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 转义 + 把关键词包成 <mark>，用于列表里的标题/摘要高亮
function highlightText(text, q) {
  const t = String(text || '');
  const key = String(q || '').trim();
  if (!key) return esc(t);
  const lower = t.toLowerCase();
  const kl = key.toLowerCase();
  let out = '';
  let i = 0;
  while (i < t.length) {
    const j = lower.indexOf(kl, i);
    if (j < 0) { out += esc(t.slice(i)); break; }
    out += esc(t.slice(i, j)) + '<mark>' + esc(t.slice(j, j + key.length)) + '</mark>';
    i = j + key.length;
  }
  return out;
}

// 应用图标：底色跟随主题高亮色，中间是 <>（代码的意思）
function logo(id) {
  return `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="${id}-gloss" x1="0.1" y1="0" x2="0.6" y2="1">
        <stop offset="0" stop-color="#ffffff" stop-opacity="0.26"/>
        <stop offset="0.52" stop-color="#ffffff" stop-opacity="0.04"/>
        <stop offset="1" stop-color="#000000" stop-opacity="0.16"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="48" height="48" rx="11.6" style="fill:var(--accent)"/>
    <rect x="0" y="0" width="48" height="48" rx="11.6" fill="url(#${id}-gloss)"/>
    <rect x="0.9" y="0.9" width="46.2" height="46.2" rx="10.8" fill="none" stroke="#ffffff" stroke-opacity="0.26" stroke-width="1.4"/>
    <g fill="none" stroke="#ffffff" stroke-width="3.1" stroke-linecap="round" stroke-linejoin="round">
      <path d="M18.7 15.9 11.3 24l7.4 8.1"/>
      <path d="M29.3 15.9 36.7 24l-7.4 8.1"/>
    </g>
  </svg>`;
}

function logoHTML() { return logo('sh-g-' + (++logoSeq)); }

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const y = d.getFullYear();
  return `${y}/${d.getMonth() + 1}/${d.getDate()}`;
}
function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${fmtDate(ts)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}
function extOf(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return 'FILE';
  return name.slice(i + 1, i + 6);
}

// 列表里的摘要：去掉 Markdown 记号，避免列表里出现 ## ** ` 这类符号。
function previewText(s) {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d+[.)]\s+/gm, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 按钮提示：写进 data-tip，由 CSS 在图标下方居中即时显示（比原生 title 快很多）
function setTip(sel, text) {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (!el) return;
  el.dataset.tip = text;
  el.setAttribute('aria-label', text);
}

let toastTimer = null;function toast(msg, isErr) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast' + (isErr ? ' err' : ''); }, 2200);
}

/* ---------- 主题 ---------- */
const THEME_KEY = 'sh.theme';
const DEFAULT_ACCENT = '#e2644c';
const ACCENT_PRESETS = ['#e2644c', '#e8a13c', '#4f9d69', '#3d8fd1', '#7a6cf0', '#d4557f'];
// 代码配色：id 与 style.css 里的 [data-code=...] 对应
const CODE_THEMES = [
  { id: 'midnight', name: '极夜' },
  { id: 'dracula', name: '吸血鬼' },
  { id: 'monokai', name: '复古' },
  { id: 'github', name: '简白' },
];
const CODE_DEFAULT = 'midnight';

function normalizeCodeTheme(v) {
  return CODE_THEMES.some((t) => t.id === v) ? v : CODE_DEFAULT;
}

function loadTheme() {
  try {
    const t = JSON.parse(localStorage.getItem(THEME_KEY) || 'null');
    if (t && (t.mode === 'light' || t.mode === 'dark')) {
      return {
        mode: t.mode,
        accent: t.accent || DEFAULT_ACCENT,
        font: t.font === 'song' ? 'song' : 'system',
        scale: clampScale(t.scale),
        code: normalizeCodeTheme(t.code),
      };
    }
  } catch (e) { /* ignore */ }
  return { mode: 'dark', accent: DEFAULT_ACCENT, font: 'system', scale: 1, code: CODE_DEFAULT };
}

function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return {
    r: parseInt(v.slice(0, 2), 16) || 0,
    g: parseInt(v.slice(2, 4), 16) || 0,
    b: parseInt(v.slice(4, 6), 16) || 0,
  };
}
function mixWhite(hex, p) {
  const { r, g, b } = hexToRgb(hex);
  const f = (c) => Math.round(c + (255 - c) * p).toString(16).padStart(2, '0');
  return '#' + f(r) + f(g) + f(b);
}
function mixBlack(hex, p) {
  const { r, g, b } = hexToRgb(hex);
  const f = (c) => Math.round(c * (1 - p)).toString(16).padStart(2, '0');
  return '#' + f(r) + f(g) + f(b);
}

const SCALE_MIN = 0.8;
const SCALE_MAX = 1.8;
const SCALE_STEP = 0.1;

function clampScale(v) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return 1;
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(n * 100) / 100));
}

function applyTheme(save) {
  const { mode, accent } = state.theme;
  const font = state.theme.font || 'system';
  const { r, g, b } = hexToRgb(accent);
  const root = document.documentElement;
  root.setAttribute('data-theme', mode);
  root.setAttribute('data-font', font);
  root.setAttribute('data-code', normalizeCodeTheme(state.theme.code));
  root.style.setProperty('--doc-scale', String(clampScale(state.theme.scale)));
  root.style.setProperty('--accent-rgb', `${r} ${g} ${b}`);
  root.style.setProperty('--accent', `rgb(${r} ${g} ${b})`);
  root.style.setProperty('--accent-2', mixWhite(accent, 0.24));
  root.style.setProperty('--accent-deep', mixBlack(accent, 0.16));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', mode === 'light' ? '#ffffff' : '#101013');
  if (save) {
    try { localStorage.setItem(THEME_KEY, JSON.stringify(state.theme)); } catch (e) { /* ignore */ }
  }
}

state.theme = loadTheme();
applyTheme(false);

/* ---------- 窄屏：抽屉式导航（分类 + 列表并排出现） ---------- */
const MOBILE_MQ = window.matchMedia('(max-width: 820px)');
let mNav = 'none'; // none | both（两侧一起出）| list | side

const isMobile = () => MOBILE_MQ.matches;

function applyLayout() {
  if (!isMobile()) mNav = 'none';
  const app = $('#app');
  app.classList.toggle('m-list', mNav !== 'none');
  app.classList.toggle('m-side', mNav === 'side');
  app.classList.toggle('m-both', mNav === 'both');
}

function setMobileNav(v) {
  const next = isMobile() ? v : 'none';
  if (next === mNav) return;
  const fromNone = mNav === 'none';
  mNav = next;
  applyLayout();
  // 打开抽屉时压一条历史记录，安卓返回键先关抽屉而不是退出页面
  try {
    if (fromNone && next !== 'none') history.pushState({ mnav: true }, '');
    else if (!fromNone && next === 'none' && history.state && history.state.mnav) history.back();
  } catch (e) { /* 忽略 */ }
}

window.addEventListener('popstate', () => {
  if (mNav !== 'none') { mNav = 'none'; applyLayout(); }
});

// ≡ 一次把「分类 + 列表」两栏一起拉出来（窄屏两栏都收窄并排）
$('#btnDrawer').addEventListener('click', () => setMobileNav(mNav === 'none' ? 'both' : 'none'));
$('#btnSideDrawer').addEventListener('click', () => setMobileNav(mNav === 'both' ? 'none' : 'side'));
$('#btnSideClose').addEventListener('click', () => setMobileNav('none'));
$('#mMask').addEventListener('click', () => setMobileNav('none'));
// 窄屏下点标题（如「全部片段」）也能回到分类
$('#listTitle').addEventListener('click', () => { if (isMobile() && mNav === 'list') setMobileNav('side'); });
MOBILE_MQ.addEventListener('change', () => { mNav = 'none'; applyLayout(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && mNav !== 'none') { e.preventDefault(); setMobileNav('none'); }
});

// 手机端彻底禁止缩放：iOS 的双指手势 + 输入框聚焦放大
['gesturestart', 'gesturechange', 'gestureend'].forEach((t) => {
  document.addEventListener(t, (e) => e.preventDefault(), { passive: false });
});
document.addEventListener('touchmove', (e) => {
  if (e.touches.length > 1) e.preventDefault(); // 双指缩放
}, { passive: false });
applyLayout();

/* ---------- API ---------- */

/* 铁威马 TOS 7：iframe 页面由平台 nginx 直接发静态文件，
 * 接口必须走平台代理 /v2/proxy/<appid>/（规范 8.9），并且要带上
 * X-Csrf-Token（规范 8.10）。TMSESSNAME 是 HttpOnly，JS 读不到，
 * 只能靠 credentials:'include' 让浏览器自动带。 */
function readCookie(name) {
  const prefix = name + '=';
  return document.cookie.split(';').map((s) => s.trim())
    .find((s) => s.startsWith(prefix))?.slice(prefix.length) || '';
}

/* 平台标记：TOS 的窗口顶部有标题栏，需要在 CSS 里给 .app/.gate 等
 * 全屏容器让出 --safe-top；本地开发（直接开 TCP 端口）没有这一层，
 * 变量保持 0。 */
function applyPlatform(p) {
  const el = document.documentElement;
  if (p === 'tos') el.dataset.platform = 'tos';
  else delete el.dataset.platform;
}

function appIdFromPath() {
  // 页面地址形如 /snippethub/，取第一段做 appid
  return (location.pathname.split('/').filter(Boolean)[0] || '');
}

/* 统一的请求初始化：平台鉴权要求同时有 Cookie（浏览器自动带）与
 * X-Csrf-Token 头（规范 8.10）；没有这个 cookie 时读到空串就不加。 */
function authInit(method = 'GET', isForm = false) {
  const headers = {};
  const csrf = readCookie('X-Csrf-Token');
  if (csrf) headers['X-Csrf-Token'] = csrf;
  return { credentials: 'include', method, headers };
}

function apiCandidates() {
  const p = location.pathname;
  const dir = p.replace(/[^/]*$/, '');
  const seg = appIdFromPath();
  const list = [
    // 当前页面所在目录优先，能一次命中就不多发探测请求
    p.endsWith('/') ? p : p + '/',
    '/v2/proxy/' + seg + '/',      // TOS 7 平台代理（规范 8.9）
    '/proxy/' + seg + '/',         // 部分固件的 API 网关直通形态
    dir,
    '/',
  ];
  return Array.from(new Set(list.filter(Boolean)));
}

/* 平台会话失效时，网关对 /v2/proxy/<id>/* 回 200 的
 * {"is_login":false,"msg":"please login"}（而不是 401）。这时不能当成
 * 「应用连不上」，也不该让用户对着应用自己的密码框反复输 —— 直接重新加载
 * 当前页面，让平台按它自己的流程走登录。只触发一次，避免刷新循环。 */
let platformLoginRedirected = false;
function leaveToPlatformLogin() {
  if (platformLoginRedirected) return;
  platformLoginRedirected = true;
  location.reload();
}

function isPlatformLoginMissing(j) {
  return !!j && j.is_login === false;
}

async function detectBase() {
  for (const c of apiCandidates()) {
    try {
      // 探测请求也要带 X-Csrf-Token：TOS 的 API 网关对「有会话但缺 token」
      // 的请求直接 403，漏了它就会四个候选全失败，表现为「无法连接到应用服务」。
      const res = await fetch(c + 'api/state', authInit());
      if (!res.ok) continue;
      const j = await res.json();
      if (isPlatformLoginMissing(j)) { platformLoginRedirected = false; leaveToPlatformLogin(); throw new Error('平台登录已过期，请重新登录'); }
      if (j && typeof j.initialized === 'boolean') {
        BASE = c;
        applyPlatform(j.platform);
        return j;
      }
    } catch (e) {
      // 平台登录问题要立刻往上抛，不能被当成「这个前缀不通」吞掉
      if (platformLoginRedirected) throw e;
    }
  }
  throw new Error('无法连接到应用服务');
}

/* 触发浏览器保存一个 blob */
function saveBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1200);
}

/* 二进制下载统一走这里。
 * <a download> 是浏览器原生发起的请求，带不上 X-Csrf-Token，在 TOS 上会被
 * 平台网关 403；所以改成 fetch（带齐 Cookie + token）拿到 blob 再保存。 */
async function downloadViaApi(path, name) {
  const res = await fetch(BASE + path, authInit());
  if (!res.ok) throw new Error('下载失败（' + res.status + '）');
  let filename = name;
  if (!filename) {
    const cd = res.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    if (m) {
      try { filename = decodeURIComponent(m[1]); } catch (e) { filename = m[1]; }
    }
  }
  saveBlob(await res.blob(), filename || 'download');
}

async function api(path, opts = {}) {
  const init = authInit(opts.method || 'GET', opts.body instanceof FormData);
  if (opts.body instanceof FormData) {
    init.body = opts.body;
  } else if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch(BASE + 'api/' + path, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  if (isPlatformLoginMissing(data)) {
    leaveToPlatformLogin();
    throw new Error('平台登录已过期，正在重新登录…');
  }
  if (res.status === 401) {
    // 返回的不是本应用的 JSON，说明是 TOS 平台会话失效（而不是应用密码错），
    // 这种情况刷新页面让平台重新走登录，别让用户对着密码框反复输。
    if (!data || typeof data.error !== 'string') {
      location.reload();
      throw new Error('平台登录已过期，请重新登录');
    }
    showGate();
    throw new Error((data && data.error) || '登录已过期');
  }
  if (res.status === 403) {
    // 403 有两种来源，不能一概而论：
    //  ① 平台网关：当前 TOS 账号没被授权使用这个应用（没有 body 或不是我们的 JSON）
    //  ② 应用自己：比如某个文件读写没权限，后端会把具体原因和解决办法写在 error 里
    // 以前这里直接抛通用文案，把 ② 的详细提示吃掉了，用户只看到「联系管理员」。
    if (data && typeof data.error === 'string' && data.error) throw new Error(data.error);
    throw new Error('当前 TOS 账号没有本应用的访问权限，请联系管理员授权');
  }
  if (!res.ok) throw new Error((data && data.error) || '请求失败（' + res.status + '）');
  return data;
}

/* ---------- 锁屏 ---------- */
function showGate(initialized = true, autoFocus = true) {
  state.connectFailed = false;
  $('#app').hidden = true;
  $('#gate').hidden = false;
  const input = $('#gatePassword');
  input.value = '';
  input.disabled = false;
  $('#gatePassword2').disabled = false;
  $('#gateErr').textContent = '';
  $('#gateSubmit').textContent = initialized ? '解锁' : '创建并进入';
  input.placeholder = initialized ? '请输入访问密码' : '设置访问密码（至少 4 位）';
  $('#gateField2').hidden = initialized;
  $('#gateForgot').hidden = !initialized;
  $('#gatePassword2').value = '';
  $('#gateHint').innerHTML = '';
  resetGateEyes();
  if (autoFocus) setTimeout(() => input.focus(), 60);
}

/* 启动时连不上后端（平台网关拒绝、服务没起、socket 不通……）。
 * 这时候显示「解锁」会让人以为密码输错了，所以把输入框收起来、按钮改成「重试」。 */
function showConnectError(msg) {
  showGate(true, false);
  state.connectFailed = true;
  const input = $('#gatePassword');
  input.placeholder = '暂时连不上应用服务';
  input.disabled = true;
  $('#gatePassword2').disabled = true;
  $('#gateForgot').hidden = true;
  $('#gateSubmit').textContent = '重试';
  $('#gateErr').textContent = msg || '无法连接到应用服务';
  $('#gateHint').innerHTML =
    '<div style="line-height:1.9;text-align:left;margin-top:6px">' +
    '可以依次检查：<br>' +
    '1. 应用是否在运行（应用中心里应是「运行中」）<br>' +
    '2. 点下面的「重试」刷新一次<br>' +
    '3. 还是不行就重启应用后再打开' +
    '</div>';
}

/* 密码可见切换 */
function resetGateEyes() {
  $$('.gate-eye').forEach((b) => {
    b.classList.remove('on');
    b.title = '显示密码';
    b.setAttribute('aria-label', '显示密码');
    const input = document.getElementById(b.dataset.eye);
    if (input) input.type = 'password';
  });
}

$$('.gate-eye').forEach((b) => {
  b.addEventListener('click', () => {
    const input = document.getElementById(b.dataset.eye);
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    b.classList.toggle('on', show);
    b.title = show ? '隐藏密码' : '显示密码';
    b.setAttribute('aria-label', b.title);
    input.focus();
    try { input.setSelectionRange(input.value.length, input.value.length); } catch (e) { /* ignore */ }
  });
});

$('#gatePassword').addEventListener('keydown', (e) => {
  if (!state.initialized && e.key === 'Enter' && !$('#gatePassword2').value) {
    e.preventDefault();
    $('#gatePassword2').focus();
  }
});

$('#gateForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.connectFailed) { location.reload(); return; }
  const pwd = $('#gatePassword').value;
  if (!pwd) { $('#gateErr').textContent = '请输入密码'; return; }
  const btn = $('#gateSubmit');
  btn.disabled = true;
  $('#gateErr').textContent = '';
  let newCode = '';
  try {
    if (state.initialized) {
      await api('login', { method: 'POST', body: { password: pwd } });
    } else {
      if (pwd.length < 4) throw new Error('密码至少需要 4 位');
      if ($('#gatePassword2').value !== pwd) throw new Error('两次输入的密码不一致');
      const res = await api('setup', { method: 'POST', body: { password: pwd } });
      state.initialized = true;
      if (res && res.recoveryCode) {
        state.hasRecovery = true;
        newCode = res.recoveryCode;
      }
    }
    await enterApp();
    if (newCode) await showRecoveryCode(newCode);
  } catch (err) {
    $('#gateErr').textContent = err.message;
    $('#gateForm').classList.remove('shake');
    void $('#gateForm').offsetWidth;
    $('#gateForm').classList.add('shake');
    $('#gatePassword').select();
  } finally {
    btn.disabled = false;
  }
});

/* ---------- 恢复码 / 找回密码 ---------- */
function showRecoveryCode(code, intro) {
  return new Promise((resolve) => {
    openModal(`
      <h3>保存你的恢复码</h3>
      <div class="m-sub">${intro ? esc(intro) : '当您忘记了访问密码时，可以使用该恢复码来重置密码。'}<b>它只显示这一次。</b></div>
      <div class="recovery-box">${esc(code)}</div>
      <div class="m-sub">建议截图或抄到安全的地方。该恢复码只能使用一次；之后可在设置里重新申请。</div>
      <div class="m-actions">
        <button class="ghost-btn" id="rcCopy">复制</button>
        <button class="primary-btn" id="rcDone">我已保存</button>
      </div>`, (card) => {
      card.querySelector('#rcCopy').addEventListener('click', async () => {
        try { await copyText(code); toast('恢复码已复制'); }
        catch (e) { toast('复制失败，请手动选中复制', true); }
      });
      card.querySelector('#rcDone').addEventListener('click', () => { closeModal(); resolve(); });
    });
  });
}

function forgotModal() {
  if (!state.hasRecovery) {
    openModal(`
      <h3>找回访问密码</h3>
      <div class="m-sub">这台设备还没有生成恢复码，无法自助重置。请在 NAS 上执行下面两行命令：</div>
      <pre class="cmd-block">sudo systemctl stop snippethub
sudo -u snippethub /usr/local/snippethub/bin/snippethub -reset-password -data /usr/local/snippethub/data
sudo systemctl start snippethub</pre>
      <div class="m-sub">执行后重新打开应用即可设置新密码，<b>片段与附件不会丢失</b>。</div>
      <div class="m-actions"><button class="primary-btn" data-close>知道了</button></div>`);
    return;
  }

  openModal(`
    <h3>用恢复码重置密码</h3>
    <div class="m-sub">输入之前保存的恢复码，再设置一个新密码。恢复码用完即失效。</div>
    <div class="m-body pw-form">
      <input class="input" id="rcInput" placeholder="恢复码，如 ABCD-EFGH-JKLM-NPQR" autocomplete="off" spellcheck="false">
      <input class="input" id="rcNew" type="password" placeholder="新密码（至少 4 位）" autocomplete="new-password">
      <input class="input" id="rcNew2" type="password" placeholder="再输入一次新密码" autocomplete="new-password">
    </div>
    <div class="gate-err" id="rcErr" style="min-height:16px"></div>
    <div class="m-actions">
      <button class="ghost-btn" data-close>取消</button>
      <button class="primary-btn" id="rcSubmit">重置密码</button>
    </div>`, (card) => {
    const err = (msg) => { card.querySelector('#rcErr').textContent = msg || ''; };
    card.querySelector('#rcInput').focus();
    const submit = async () => {
      const code = card.querySelector('#rcInput').value;
      const p1 = card.querySelector('#rcNew').value;
      const p2 = card.querySelector('#rcNew2').value;
      if (!code.trim()) { err('请输入恢复码'); return; }
      if (p1.length < 4) { err('新密码至少 4 位'); return; }
      if (p1 !== p2) { err('两次输入的新密码不一致'); return; }
      const btn = card.querySelector('#rcSubmit');
      btn.disabled = true;
      err('');
      try {
        const res = await api('recover', { method: 'POST', body: { code, password: p1 } });
        const newCode = (res && res.recoveryCode) || '';
        state.hasRecovery = !!newCode;
        showGate(true, false);
        $('#gateHint').innerHTML = '密码已重置，请用新密码登录。';
        toast('密码已重置');
        // 重置成功立即把新签发的恢复码摆出来，不靠文案提醒用户自己去生成
        if (newCode) {
          await showRecoveryCode(newCode, '密码已重置，旧恢复码已经作废。这是刚刚为你生成的新恢复码，请保存好。');
        } else {
          closeModal();
        }
      } catch (e) {
        err(e.message);
        btn.disabled = false;
      }
    };
    card.querySelector('#rcSubmit').addEventListener('click', submit);
    card.querySelector('#rcInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    card.querySelector('#rcNew2').addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  });
}

$('#gateForgot').addEventListener('click', forgotModal);

/* ---------- 抹除所有 ---------- */
function resetAllModal() {
  openModal(`
    <h3>抹除所有数据</h3>
    <div class="m-sub">将彻底清空所有<b>文件夹、片段、标签、附件</b>，并清除密码，应用恢复至初始状态。<b>此操作无法撤销。</b></div>
    <div class="m-body">
      <div class="field-label">请输入「抹除」以确认</div><br>
      <input class="input" id="rsConfirm" placeholder="抹除" autocomplete="off" spellcheck="false">
    </div>
    <div class="m-actions">
      <button class="ghost-btn" data-close>取消</button>
      <button class="danger-btn" id="rsOk" disabled>抹除全部</button>
    </div>`, (card) => {
    const inp = card.querySelector('#rsConfirm');
    const ok = card.querySelector('#rsOk');
    inp.addEventListener('input', () => { ok.disabled = inp.value.trim() !== '抹除'; });
    inp.focus();
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      ok.textContent = '正在抹除…';
      try {
        await api('reset', { method: 'POST' });
        state.docs = [];
        state.folders = [];
        state.tags = [];
        state.trash = [];
        state.doc = null;
        state.currentId = null;
        state.authed = false;
        state.initialized = false;
        state.hasRecovery = false;
        state.view = { type: 'all', id: null };
        closeModal();
        showGate(false);
        toast('已抹除全部数据');
      } catch (err) {
        toast(err.message, true);
        ok.disabled = false;
        ok.textContent = '抹除全部';
      }
    });
  });
}

/* ---------- 进入应用 ---------- */
// animate=true 时等数据加载完再让主界面淡入（打开应用那次用，避免看到空壳/闪一下）
async function enterApp(animate = false) {
  const app = $('#app');
  $('#gate').hidden = true;
  app.hidden = false;
  app.classList.remove('ready');
  $('#gateLogo').innerHTML = logoHTML();
  $('#brandLogo').innerHTML = logoHTML();
  await loadData();
  if (animate) {
    app.classList.remove('no-anim');
    void app.offsetWidth;
    app.classList.add('ready');
  } else {
    app.classList.add('no-anim', 'ready');
  }
}

async function loadData() {
  const d = await api('data');
  state.app = d.app;
  state.folders = d.folders || [];
  state.docs = d.docs || [];
  state.trash = d.trash || [];
  state.tags = d.tags || [];
  renderSidebar();
  renderTags();
  renderList();

  const stillThere = state.currentId &&
    (state.docs.some((x) => x.id === state.currentId) || state.trash.some((x) => x.id === state.currentId));
  if (stillThere) {
    renderDocHead();
  } else if (state.currentId) {
    state.currentId = null;
    state.doc = null;
    renderDocArea();
  }
  if (!state.currentId) {
    // 窄屏在抽屉里切换分类时，先停在标题列表，别直接跳进第一条正文
    const autoOpen = isMobile() && mNav !== 'none' ? null : visibleDocs()[0];
    if (autoOpen) openDoc(autoOpen.id);
    else renderDocArea();
  }
}

/* ---------- 视图切换 ---------- */
async function setView(type, id) {
  if (state.dirty && state.doc) {
    const ok = await saveDoc(true);
    if (!ok) return;
  }
  state.view = { type, id: id || null };
  state.currentId = null;
  state.doc = null;
  state.editing = false;
  state.dirty = false;
  $('#saveBar').hidden = true;
  $('#docEditor').hidden = true;
  await loadData();
  if (!state.currentId) renderDocArea();
  // 窄屏：在「分类」里挑完，退回「列表」让用户直接看到结果
  if (mNav === 'side') setMobileNav('list');
}

/* ---------- 侧边栏 ---------- */
function renderSidebar() {
  $('#cntAll').textContent = state.docs.length;
  $('#cntPinned').textContent = state.docs.filter((d) => d.pinned).length;
  $('#cntTrash').textContent = state.trash.length;

  $$('.side-item[data-view]').forEach((b) => {
    const v = b.dataset.view;
    b.classList.toggle('active', state.view.type === v);
  });

  const list = $('#folderList');
  list.innerHTML = '';
  state.folders.forEach((f) => {
    const btn = document.createElement('button');
    btn.className = 'side-item' + (state.view.type === 'folder' && state.view.id === f.id ? ' active' : '');
    btn.dataset.folder = f.id;
    btn.innerHTML = `<svg viewBox="0 0 24 24" class="ic"><path d="M4 6.4A1.6 1.6 0 0 1 5.6 4.8h3.7l2 2h7.1A1.6 1.6 0 0 1 20 8.4v9.2a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 17.6z"/></svg>
      <span>${esc(f.name)}</span><em class="cnt">${f.count}</em>`;
    btn.addEventListener('click', () => setView('folder', f.id));
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openCtx(e.clientX, e.clientY, { type: 'folder', item: f });
    });
    list.appendChild(btn);
  });
  $('#folderEmpty').style.display = state.folders.length ? 'none' : 'flex';
}

$$('.side-item[data-view]').forEach((b) => {
  b.addEventListener('click', () => setView(b.dataset.view, null));
});

/* ---------- 侧栏长按拖拽排序 ---------- */
function enableSortable(box, kind, itemSel, keyOf) {
  let timer = null;
  let drag = null;
  let suppressUntil = 0;

  const itemsOf = () => Array.from(box.children).filter((el) => el.matches(itemSel));

  function start(item, x, y) {
    const rect = item.getBoundingClientRect();
    const ph = document.createElement('div');
    ph.className = 'sort-ph';
    ph.style.height = rect.height + 'px';
    item.after(ph);
    item.classList.add('dragging');
    item.style.width = rect.width + 'px';
    item.style.left = rect.left + 'px';
    item.style.top = rect.top + 'px';
    document.body.appendChild(item);
    drag = { item, ph, dx: x - rect.left, dy: y - rect.top };
    box.classList.add('sorting');
  }

  function move(x, y) {
    if (!drag) return;
    drag.item.style.left = x - drag.dx + 'px';
    drag.item.style.top = y - drag.dy + 'px';

    let target = null;
    for (const el of itemsOf()) {
      const r = el.getBoundingClientRect();
      if (y < r.top + r.height / 2) { target = el; break; }
    }
    if (target) box.insertBefore(drag.ph, target);
    else box.appendChild(drag.ph);

    const scroller = box.closest('.side-scroll');
    if (scroller) {
      const sr = scroller.getBoundingClientRect();
      if (y < sr.top + 34) scroller.scrollTop -= 10;
      else if (y > sr.bottom - 34) scroller.scrollTop += 10;
    }
  }

  async function finish() {
    const { item, ph } = drag;
    drag = null;
    box.classList.remove('sorting');
    item.classList.remove('dragging');
    item.style.cssText = '';
    ph.replaceWith(item);
    suppressUntil = Date.now() + 350;

    const order = itemsOf().map(keyOf);
    try {
      await api('sort', { method: 'POST', body: { kind, order } });
      await loadData();
    } catch (err) { toast(err.message, true); }
  }

  box.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // 触摸屏上长按留给「右键菜单」，不在这里抢
    if (e.pointerType === 'touch') return;
    const item = e.target.closest(itemSel);
    if (!item || item.parentNode !== box) return;

    const sx = e.clientX;
    const sy = e.clientY;
    let started = false;

    const onMove = (ev) => {
      if (started) {
        ev.preventDefault();
        move(ev.clientX, ev.clientY);
        return;
      }
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8) stop();
    };
    const onUp = () => {
      if (started && drag) finish();
      stop();
    };
    const stop = () => {
      clearTimeout(timer);
      timer = null;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };

    // 长按 250ms 进入排序模式
    timer = setTimeout(() => {
      started = true;
      start(item, sx, sy);
    }, 250);

    document.addEventListener('pointermove', onMove, { passive: false });
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  });

  // 拖拽结束后屏蔽一次点击，避免误切视图
  box.addEventListener('click', (e) => {
    if (Date.now() < suppressUntil) {
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
}

enableSortable($('#folderList'), 'folder', '[data-folder]', (el) => el.dataset.folder);
enableSortable($('#tagList'), 'tag', '[data-tag-name]', (el) => el.dataset.tagName);

/* ---------- 触摸屏：长按 = 右键菜单（手机上管理文件夹/标签/片段） ---------- */
function bindLongPress(box, selector, resolve) {
  let timer = null;
  let sx = 0;
  let sy = 0;
  let fired = false;
  let blockUntil = 0;

  box.addEventListener('touchstart', (e) => {
    const el = e.target.closest(selector);
    if (!el) return;
    const p = e.touches[0];
    sx = p.clientX;
    sy = p.clientY;
    fired = false;
    clearTimeout(timer);
    timer = setTimeout(() => {
      fired = true;
      blockUntil = Date.now() + 700;
      const target = resolve(el);
      if (target) openCtx(sx, sy, target);
    }, 480);
  }, { passive: true });

  box.addEventListener('touchmove', (e) => {
    const p = e.touches[0];
    if (Math.abs(p.clientX - sx) > 8 || Math.abs(p.clientY - sy) > 8) clearTimeout(timer);
  }, { passive: true });

  box.addEventListener('touchend', (e) => {
    clearTimeout(timer);
    if (fired) { fired = false; e.preventDefault(); }
  }, { passive: false });
  box.addEventListener('touchcancel', () => clearTimeout(timer));

  // 长按已经处理过，别让随后的 click 再打开片段
  box.addEventListener('click', (e) => {
    if (Date.now() < blockUntil) { e.stopPropagation(); e.preventDefault(); }
  }, true);
}

bindLongPress($('#folderList'), '[data-folder]', (el) => {
  const f = state.folders.find((x) => x.id === el.dataset.folder);
  return f ? { type: 'folder', item: f } : null;
});
bindLongPress($('#tagList'), '[data-tag-name]', (el) => {
  const name = String(el.dataset.tagName || '').toLowerCase();
  const t = state.tags.find((x) => x.name.toLowerCase() === name);
  return t ? { type: 'tag', item: t } : null;
});
bindLongPress($('#docList'), '.doc-item', (el) => {
  const id = el.dataset.id;
  const d = state.docs.find((x) => x.id === id) || state.trash.find((x) => x.id === id);
  if (!d) return null;
  return { type: state.view.type === 'trash' ? 'trash' : 'doc', item: d };
});

/* ---------- 列表 ---------- */
// 当前关键词下，是否命中正文（全文搜索由后端扫 content/*.md）
function hitSnippet(d) {
  if (!state.query || state.hitsQuery !== state.query) return null;
  return state.hits.has(d.id) ? (state.hits.get(d.id) || '') : null;
}

function visibleDocs() {
  if (state.view.type === 'trash') {
    let trash = state.trash.slice();
    if (state.query) {
      const q = state.query.toLowerCase();
      trash = trash.filter((d) => (d.title || '').toLowerCase().includes(q)
        || (d.preview || '').toLowerCase().includes(q) || hitSnippet(d) !== null);
    }
    return trash;
  }
  // 搜索是全局的：只要有搜索词，就跨所有文件夹 / 标签 / 置顶一起找
  if (state.query) {
    const q = state.query.toLowerCase();
    return state.docs.filter((d) =>
      (d.title || '').toLowerCase().includes(q) || (d.preview || '').toLowerCase().includes(q)
      || hitSnippet(d) !== null);
  }
  let docs = state.docs.slice();
  if (state.view.type === 'folder') docs = docs.filter((d) => d.folderId === state.view.id);
  if (state.view.type === 'tag') {
    const want = String(state.view.id).toLowerCase();
    docs = docs.filter((d) => (d.tags || []).some((t) => t.toLowerCase() === want));
  }
  if (state.view.type === 'pinned') docs = docs.filter((d) => d.pinned);
  return docs;
}

function viewTitle() {
  if (state.view.type === 'folder') {
    const f = state.folders.find((x) => x.id === state.view.id);
    return f ? f.name : '文件夹';
  }
  if (state.view.type === 'tag') return '#' + state.view.id;
  return { all: '全部片段', pinned: '置顶片段', trash: '废纸篓' }[state.view.type] || '全部片段';
}

/* ---------- 标签侧栏 ---------- */
function tagColorOf(name) {
  const hit = state.tags.find((t) => t.name.toLowerCase() === String(name).toLowerCase());
  return (hit && hit.color) || '';
}

// kind: 'tag-chip'（文档头）/ 'chip'（列表里的标签，仅展示、不可点）
function tagChipHTML(name, kind) {
  const color = tagColorOf(name);
  const style = color ? ` style="--tag:${color};color:${color};border-color:${color}44;background:${color}1f"` : '';
  if (kind === 'chip') return `<span class="chip"${style}>#${esc(name)}</span>`;
  return `<button class="tag-chip clickable" data-tag="${esc(name)}"${style}>#${esc(name)}</button>`;
}

function renderTags() {
  const box = $('#tagList');
  box.innerHTML = '';
  state.tags.forEach((t) => {
    const b = document.createElement('button');
    const active = state.view.type === 'tag' && String(state.view.id).toLowerCase() === t.name.toLowerCase();
    b.className = 'side-item' + (active ? ' active' : '');
    b.dataset.tagName = t.name;
    b.innerHTML = `<i class="tag-dot"${t.color ? ` style="background:${esc(t.color)}"` : ''}></i><span>${esc(t.name)}</span><em class="cnt">${t.count}</em>`;
    b.addEventListener('click', () => setView('tag', t.name));
    b.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openCtx(e.clientX, e.clientY, { type: 'tag', item: t });
    });
    box.appendChild(b);
  });
  $('#tagEmpty').style.display = state.tags.length ? 'none' : 'block';
}

function folderName(id) {
  const f = state.folders.find((x) => x.id === id);
  return f ? f.name : '';
}

function renderList() {
  const docs = visibleDocs();
  const isTrash = state.view.type === 'trash';
  $('#listTitle').textContent = (state.query && !isTrash) ? '搜索结果' : viewTitle();
  $('#listCount').textContent = docs.length ? docs.length + ' 条' : '';
  $('#btnEmptyTrash').hidden = !isTrash || !state.trash.length;

  const box = $('#docList');
  box.innerHTML = '';

  docs.forEach((d) => {
    const item = document.createElement('div');
    item.className = 'doc-item' + (d.id === state.currentId ? ' active' : '');
    item.dataset.id = d.id;
    const fname = folderName(d.folderId);
    const snip = hitSnippet(d);
    const prev = snip ? snip : previewText(d.preview);
    const pinIcon = '<svg viewBox="0 0 24 24" class="ic pin-ic"><path d="M12 20.5V9.5"/><path d="m6.8 14.6 5.2-5.2 5.2 5.2"/><path d="M5 4.5h14"/></svg>';
    item.innerHTML = `
      <div class="dt">
        <b>${highlightText(d.title || '未命名片段', state.query)}</b>
        ${d.pinned && !isTrash ? pinIcon : ''}
      </div>
      <div class="dp${snip ? ' dp-hit' : ''}">${prev ? highlightText(prev, state.query) : '空片段，点开写点什么…'}</div>
      <div class="df">
        <div class="df-left">
          ${fname ? `<span class="chip">${esc(fname)}</span>` : ''}
          ${(d.tags || []).slice(0, 2).map((t) => tagChipHTML(t, 'chip')).join('')}
        </div>
        <span class="date">${isTrash ? '删除于 ' + fmtDate(d.deletedAt) : fmtDate(d.updatedAt)}</span>
      </div>`;
    item.addEventListener('click', () => openDoc(d.id));
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openCtx(e.clientX, e.clientY, { type: isTrash ? 'trash' : 'doc', item: d });
    });
    box.appendChild(item);
  });

  $('#listEmpty').style.display = docs.length ? 'none' : 'flex';
  let emptyText = isTrash
    ? '废纸篓是空的'
    : (state.query ? '没有找到匹配的片段' : '这个分类下还没有片段');
  if (!isTrash && !state.query && !state.folders.length) emptyText = '暂无内容';
  $('#listEmpty').textContent = emptyText;
}

const SEARCH_DEBOUNCE = 150;
let searchTimer = null;
let searchSeq = 0;

async function runSearch(q) {
  const seq = ++searchSeq;
  try {
    const res = await api('search?q=' + encodeURIComponent(q));
    if (seq !== searchSeq || state.query !== q) return;
    const m = new Map();
    ((res && res.hits) || []).forEach((h) => m.set(h.id, h.snippet || ''));
    state.hits = m;
    state.hitsQuery = q;
    renderList();
  } catch (e) {
    /* 搜索失败就当没有正文命中，标题匹配仍然有效 */
  }
}

function syncSearchClear() {
  $('#searchClear').hidden = $('#search').value.length === 0;
}

function clearSearch() {
  const input = $('#search');
  input.value = '';
  state.query = '';
  clearTimeout(searchTimer);
  searchSeq++;
  state.hits = new Map();
  state.hitsQuery = '';
  syncSearchClear();
  renderList();
  input.focus();
}

$('#search').addEventListener('input', (e) => {
  state.query = e.target.value.trim();
  syncSearchClear();
  clearTimeout(searchTimer);
  if (!state.query) {
    searchSeq++;
    state.hits = new Map();
    state.hitsQuery = '';
    renderList();
    return;
  }
  renderList(); // 先用标题/摘要本地匹配兜底，正文结果到了再重绘
  const q = state.query;
  searchTimer = setTimeout(() => runSearch(q), SEARCH_DEBOUNCE);
});

$('#searchClear').addEventListener('click', clearSearch);
$('#search').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#search').value) { e.preventDefault(); clearSearch(); }
});
syncSearchClear();

/* ---------- 文档 ---------- */
async function openDoc(id, opts = {}) {
  if (state.dirty && state.doc && state.doc.id !== id) {
    const ok = await saveDoc(true);
    if (!ok) return;
  }
  try {
    const d = await api('docs/' + id);
    state.doc = d;
    state.currentId = id;
    state.editing = false;
    state.dirty = false;
    $('#saveBar').hidden = true;
    closeTagPop();
    renderDocArea();
    renderList();
    if (opts.edit) startEdit();
    if (mNav !== 'none') setMobileNav('none'); // 窄屏：选完片段直接看正文
  } catch (err) {
    toast(err.message, true);
    if (/不存在/.test(err.message)) { state.currentId = null; await loadData(); }
  }
}

function renderDocArea() {
  const has = !!state.doc;
  closeInfoPop();
  $('#placeholder').classList.toggle('show', !has);
  $('#docTitle').hidden = !has;
  $('#docMeta').hidden = !has;
  $('.doc-actions').style.display = has ? 'flex' : 'none';
  $('.attach-bar').style.display = has ? 'block' : 'none';
  $('#docView').style.display = has && !state.editing ? 'block' : 'none';
  $('#docEditor').hidden = !(has && state.editing);
  if (!has || !state.editing) resetEditMode(); // 不在编辑态就别留着预览分栏
  $('#docBody').scrollTop = 0;
  if (has) {
    renderDocHead();
    $('#docView').innerHTML = markdown(state.doc.content || '');
    $('#docEditor').value = state.doc.content || '';
    renderAttachments();
    renderToc();
  } else {
    renderToc();
  }
}

function renderDocHead() {
  const d = state.doc;
  if (!d) return;
  closeDocMenu();
  const inTrash = !!d.deletedAt;
  const title = $('#docTitle');
  title.value = d.title || '';
  title.scrollLeft = 0;
  if (titleAnim) stopTitleScroll();
  title.readOnly = !state.editing || inTrash;
  title.classList.toggle('editing', state.editing && !inTrash);

  // 元信息一行：分类 → 标签 → 时间 → 附件（不换行）
  const fname = folderName(d.folderId);
  const meta = [];
  if (fname) meta.push(`<span class="chip">${esc(fname)}</span>`);
  const tagHTML = (d.tags || []).map((t) => tagChipHTML(t, 'tag-chip')).join('');
  if (tagHTML) meta.push(`<span class="meta-tags">${tagHTML}</span>`);
  meta.push(`<span class="meta-time">${fmtTime(d.updatedAt)}</span>`);
  if (d.attachments && d.attachments.length) {
    meta.push('<span class="dot"></span>');
    meta.push(`<span>${d.attachments.length} 个附件</span>`);
  }
  if (inTrash) {
    meta.push('<span class="dot"></span>');
    meta.push(`<span class="trash-hint">已删除 ${fmtTime(d.deletedAt)}</span>`);
  }
  $('#docMeta').innerHTML = meta.join('');

  // 按钮：废纸篓里只保留「恢复 / 彻底删除」
  $('#btnPin').hidden = inTrash;
  $('#btnTags').hidden = inTrash;
  $('#btnCopy').hidden = inTrash;
  $('#btnEdit').hidden = inTrash;
  $('#btnDeleteDoc').hidden = inTrash;
  $('#btnRestore').hidden = !inTrash;
  $('#btnPurge').hidden = !inTrash;

  $('#btnPin').classList.toggle('on', !!d.pinned);
  $('#btnEdit').classList.toggle('on', state.editing);
  // 提示文字走 data-tip（悬停立即在图标下方居中显示），不用原生 title
  setTip('#btnPin', d.pinned ? '取消置顶' : '置顶这段内容');
  setTip('#btnEdit', state.editing ? '保存并退出编辑' : '编辑正文');
  setTip('#btnDeleteDoc', '移至废纸篓');
  setTip('#btnRestore', '恢复到原位置');
  setTip('#btnPurge', '彻底删除（不可恢复）');
  setTip('#btnToc', $('#btnToc').classList.contains('on') ? '隐藏目录' : '显示目录');

  // 手机端「更多」按钮上的状态点：置顶或编辑中时提示一下
  const more = $('#btnMore');
  if (more) more.classList.toggle('has-state', !inTrash && (!!d.pinned || !!state.editing));
}

/* ---------- 书写 / 预览 模式 ---------- */
let previewTimer = 0;

function renderPreview() {
  const box = $('#docPreview');
  if (!box) return;
  box.innerHTML = markdown($('#docEditor').value || '');
}

function setEditMode(mode) {
  const preview = mode === 'preview';
  $('#app').classList.toggle('preview-mode', preview);
  $$('#modeSwitch button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
  if (preview) {
    renderPreview();
  } else {
    if (!$('#docEditor').hidden) $('#docEditor').focus();
    // 面板滑出之后再清空渲染结果：隐藏着的大段 DOM 不用一直参与布局
    setTimeout(() => {
      if (!$('#app').classList.contains('preview-mode')) $('#docPreview').innerHTML = '';
    }, 320);
  }
}

// 退出编辑 / 换文档都回到书写模式（不做全局记忆）
function resetEditMode() {
  clearTimeout(previewTimer);
  $('#app').classList.remove('preview-mode');
  const box = $('#docPreview');
  box.innerHTML = '';
  $('#modeSwitch').hidden = true;
  $$('#modeSwitch button').forEach((b) => b.classList.toggle('on', b.dataset.mode === 'write'));
}

$('#modeSwitch').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (b) setEditMode(b.dataset.mode);
});

function startEdit() {
  if (!state.doc) return;
  if (state.doc.deletedAt) { toast('这条内容在废纸篓里，请先恢复再编辑', true); return; }
  state.editing = true;
  state.dirty = false;
  resetEditMode(); // 每次进编辑都从书写模式开始
  $('#modeSwitch').hidden = false;
  $('#docView').style.display = 'none';
  const ed = $('#docEditor');
  ed.hidden = false;
  ed.value = state.doc.content || '';
  $('#docTitle').readOnly = false;
  $('#saveBar').hidden = true;
  renderAttachments();
  renderDocHead();
  renderToc();
  ed.focus();
  ed.setSelectionRange(ed.value.length, ed.value.length);
}

function stopEdit() {
  state.editing = false;
  state.dirty = false;
  resetEditMode();
  $('#saveBar').hidden = true;
  $('#docTitle').readOnly = true;
  renderDocArea();
  renderDocHead();
}

// keepEditing=true 时保存后继续留在编辑态（Ctrl+S 用），光标和滚动位置都不动
async function saveDoc(silent, keepEditing) {
  if (!state.doc) return true;
  if (state.saving) return false;
  const title = $('#docTitle').value;
  const ed = $('#docEditor');
  const content = ed.value;
  const caret = ed.selectionStart;
  if (!state.dirty && !state.editing) return true;
  state.saving = true;
  try {
    const saved = await api('docs/' + state.doc.id, { method: 'PUT', body: { title, content } });
    state.doc = Object.assign({}, state.doc, saved);
    state.dirty = false;
    $('#saveBar').hidden = true;
    await loadData();
    if (state.editing && keepEditing) {
      // 留在编辑态：把光标放回原处
      if (document.activeElement === ed || state.editing) {
        ed.focus();
        ed.setSelectionRange(caret, caret);
      }
    } else if (state.editing) {
      stopEdit();
    }
    if (!silent) toast('已保存');
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  } finally {
    state.saving = false;
  }
}

function markDirty() {
  state.dirty = true;
  $('#saveBar').hidden = false;
}

// 有未保存的改动时，关窗口 / 刷新先拦一下
window.addEventListener('beforeunload', (e) => {
  if (!state.dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

$('#docEditor').addEventListener('input', () => {
  markDirty();
  // 预览模式下边打字边刷新右侧预览
  if ($('#app').classList.contains('preview-mode')) {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(renderPreview, 90);
  }
});
$('#docTitle').addEventListener('input', () => { if (state.editing) markDirty(); });

/* ---------- 窄屏：点标题慢慢横向滚动，看全标题 ---------- */
let titleAnim = 0;

function stopTitleScroll() {
  if (titleAnim) cancelAnimationFrame(titleAnim);
  titleAnim = 0;
  $('#docTitle').scrollLeft = 0;
}

function playTitleScroll() {
  const el = $('#docTitle');
  if (!isMobile() || !el.readOnly) return;
  stopTitleScroll();
  const max = el.scrollWidth - el.clientWidth;
  if (max <= 2) return;
  const speed = 26;   // px/s，慢慢来
  const hold = 900;   // 到头停一下再回
  let pos = 0;
  let dir = 1;
  let holdStart = 0;
  let last = performance.now();
  const tick = (now) => {
    const dt = Math.min(now - last, 80) / 1000;
    last = now;
    if (holdStart) {
      if (now - holdStart >= hold) { holdStart = 0; dir = -1; }
      titleAnim = requestAnimationFrame(tick);
      return;
    }
    pos += dir * speed * dt;
    if (pos >= max) { pos = max; holdStart = now; }
    if (pos <= 0 && dir < 0) { el.scrollLeft = 0; titleAnim = 0; return; }
    el.scrollLeft = pos;
    titleAnim = requestAnimationFrame(tick);
  };
  el.scrollLeft = 0;
  titleAnim = requestAnimationFrame(tick);
}

// 只读态下不让聚焦抢走滚动（聚焦会把光标位置的文字滚进来）
$('#docTitle').addEventListener('pointerdown', (e) => {
  const el = $('#docTitle');
  if (!isMobile() || !el.readOnly) return;
  if (el.scrollWidth - el.clientWidth <= 2) return; // 标题没超出就按普通输入框处理
  e.preventDefault();
});
$('#docTitle').addEventListener('click', () => {
  const el = $('#docTitle');
  if (!isMobile() || !el.readOnly) return;
  playTitleScroll();
});

$('#btnSave').addEventListener('click', () => saveDoc());
$('#btnDiscard').addEventListener('click', async () => {
  if (!state.doc) return;
  const d = await api('docs/' + state.doc.id);
  state.doc = d;
  state.editing = false;
  state.dirty = false;
  $('#saveBar').hidden = true;
  renderDocArea();
  toast('已还原');
});

$('#btnEdit').addEventListener('click', async () => {
  if (!state.doc) return;
  if (state.doc.deletedAt) { toast('这条内容在废纸篓里，请先恢复再编辑', true); return; }
  if (state.editing) {
    if (state.dirty) { if (!(await saveDoc())) return; }
    stopEdit();
    return;
  }
  startEdit();
});

async function setPinned(d, next) {
  try {
    const saved = await api('docs/' + d.id, { method: 'PUT', body: { pinned: next } });
    if (state.doc && state.doc.id === d.id) {
      state.doc = Object.assign({}, state.doc, saved);
      renderDocHead();
    }
    await loadData();
    toast(next ? '已置顶' : '已取消置顶');
  } catch (err) { toast(err.message, true); }
}

/* ---------- 编辑器右键菜单 ---------- */
let lastEditSel = { start: 0, end: 0 };

function openEditMenu(x, y) {
  const m = $('#editMenu');
  // 光标所在行已经是几级标题，就把那个按钮点亮
  const ed = $('#docEditor');
  const lineStart = ed.value.lastIndexOf('\n', ed.selectionStart - 1) + 1;
  const line = ed.value.slice(lineStart, ed.selectionStart + 40).split('\n')[0] || '';
  const hm = line.match(/^(#{1,6})[ \t]/);
  const lv = hm ? hm[1].length : 0;
  $$('#editMenu [data-h]').forEach((b) => b.classList.toggle('on', Number(b.dataset.h) === lv));

  m.hidden = false;
  const rect = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  m.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
}
function closeEditMenu() { $('#editMenu').hidden = true; }

// 插入文本：优先走 execCommand('insertText')，这样 Ctrl+Z 的撤销栈不会被打断，
// 而且浏览器自己会把光标滚到可见位置；失败再退回直接改 value。
function editorReplace(start, end, text, selStart, selEnd) {
  const ed = $('#docEditor');
  const keepTop = ed.scrollTop;
  ed.focus();
  ed.setSelectionRange(start, end);
  let ok = false;
  try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
  if (!ok) {
    const v = ed.value;
    ed.value = v.slice(0, start) + text + v.slice(end);
  }
  const s = selStart === undefined ? start + text.length : selStart;
  const e = selEnd === undefined ? s : selEnd;
  ed.setSelectionRange(s, e);
  restoreScroll(ed, keepTop, s);
  lastEditSel = { start: s, end: e };
  markDirty();
}

// 操作后不要乱滚：光标还在原来的视野里就保持不动，跑到视野外才滚过去
function restoreScroll(ed, top, pos) {
  const cs = getComputedStyle(ed);
  let lh = parseFloat(cs.lineHeight);
  if (!isFinite(lh) || lh <= 0) lh = (parseFloat(cs.fontSize) || 13) * 1.75;
  const padT = parseFloat(cs.paddingTop) || 0;
  const padB = parseFloat(cs.paddingBottom) || 0;
  const line = (ed.value.slice(0, pos).match(/\n/g) || []).length;
  const viewLines = Math.max(1, (ed.clientHeight - padT - padB) / lh);
  const topLine = (top - padT) / lh;
  if (line >= topLine - 1 && line <= topLine + viewLines) {
    ed.scrollTop = top;
  } else {
    ed.scrollTop = Math.max(0, padT + line * lh - viewLines * lh * 0.4);
  }
}

function insertAtEditSel(text) {
  const ed = $('#docEditor');
  let start = lastEditSel.start;
  let end = lastEditSel.end;
  if (document.activeElement === ed) {
    start = ed.selectionStart;
    end = ed.selectionEnd;
  }
  editorReplace(start, end, text, start + text.length, start + text.length);
}

function wrapEditSel(before, after, placeholder) {
  const ed = $('#docEditor');
  let start = lastEditSel.start;
  let end = lastEditSel.end;
  if (document.activeElement === ed) {
    start = ed.selectionStart;
    end = ed.selectionEnd;
  }
  const raw = ed.value.slice(start, end);
  const sel = raw || placeholder || '';
  editorReplace(start, end, before + sel + after, start + before.length, start + before.length + sel.length);
}

async function insertImage(file) {
  if (!state.doc) return;
  try {
    toast('正在上传图片…');
    const fd = new FormData();
    fd.append('files', file, file.name || 'image.png');
    const res = await api(`docs/${state.doc.id}/files`, { method: 'POST', body: fd });
    const att = (res.added || [])[0];
    if (!att) throw new Error('图片上传失败');
    state.doc.attachments = (state.doc.attachments || []).concat(res.added || []);
    renderAttachments();
    const url = BASE + 'api/docs/' + state.doc.id + '/files/' + att.id;
    insertAtEditSel(`\n![${att.name}](${url})\n`);
    toast('图片已插入正文');
  } catch (err) { toast(err.message, true); }
}

/* ---------- 编辑器键盘增强 ---------- */
const ED_INDENT = '    '; // Tab = 4 空格

function inFence(ed, pos) {
  const before = ed.value.slice(0, pos);
  return ((before.match(/^```/gm) || []).length % 2) === 1;
}

// Tab / Shift+Tab：单行就是 4 空格缩进，多行选区整块缩进或反缩进
function indentSelection(back) {
  const ed = $('#docEditor');
  const v = ed.value;
  const s = ed.selectionStart;
  const e = ed.selectionEnd;
  const lineStart = v.lastIndexOf('\n', s - 1) + 1;
  let lineEnd = v.indexOf('\n', e);
  if (lineEnd === -1) lineEnd = v.length;
  if (e > s && v[e - 1] === '\n') lineEnd = e - 1; // 选区结束在行首时不算那一行

  const block = v.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const deltas = [];
  let total = 0;
  const out = lines.map((ln) => {
    let d = 0;
    let next = ln;
    if (!back) {
      d = ED_INDENT.length;
      next = ED_INDENT + ln;
    } else {
      const m = ln.match(/^(?:\t| {1,4})/);
      d = -(m ? m[0].length : 0);
      next = ln.slice(-d);
    }
    deltas.push(d);
    total += d;
    return next;
  }).join('\n');
  if (out === block) return;

  const firstDelta = deltas[0];
  const ns = Math.max(lineStart, s + firstDelta);
  const ne = Math.max(ns, e + total);
  editorReplace(lineStart, lineEnd, out, ns, ne);
}

// 回车续行：列表 / 有序列表 / 任务列表 / 引用自动接上，代码块内保持缩进
function smartEnter() {
  const ed = $('#docEditor');
  const s = ed.selectionStart;
  if (s !== ed.selectionEnd) return false;
  const v = ed.value;
  const lineStart = v.lastIndexOf('\n', s - 1) + 1;
  const line = v.slice(lineStart, s);

  if (inFence(ed, s)) {
    const m = line.match(/^[ \t]+/);
    if (m) { editorReplace(s, s, '\n' + m[0]); return true; }
    return false;
  }

  const q = line.match(/^([ \t]*)>[ \t]?/);
  if (q) {
    const rest = line.slice(q[0].length);
    if (!rest.trim()) { editorReplace(lineStart, s, ''); return true; }
    editorReplace(s, s, '\n' + q[1] + '> ');
    return true;
  }

  const m = line.match(/^([ \t]*)([-*+]|\d+[.)])[ \t]+(\[[ xX]\][ \t]+)?/);
  if (!m) return false;
  const rest = line.slice(m[0].length);
  if (!rest.trim()) {
    editorReplace(lineStart, s, ''); // 空项回车 → 退出列表
    return true;
  }
  let marker = m[2];
  if (/^\d/.test(marker)) {
    const num = String(parseInt(marker, 10));
    marker = String(Number(num) + 1) + marker.slice(num.length);
  }
  const task = m[3] ? '[ ] ' : '';
  editorReplace(s, s, '\n' + m[1] + marker + ' ' + task);
  return true;
}

function insertLinkAtSel(s0, e0) {
  const ed = $('#docEditor');
  const start = s0 === undefined ? ed.selectionStart : s0;
  const end = e0 === undefined ? ed.selectionEnd : e0;
  const label = ed.value.slice(start, end) || '链接文字';
  const text = `[${label}](https://)`;
  const from = start + label.length + 3;
  editorReplace(start, end, text, from, from + 8); // 选中 https:// 方便直接覆盖
}

// Ctrl/Cmd+D 复制当前行
function duplicateLine() {
  const ed = $('#docEditor');
  const v = ed.value;
  const s = ed.selectionStart;
  const ls = v.lastIndexOf('\n', s - 1) + 1;
  let le = v.indexOf('\n', s);
  if (le === -1) le = v.length;
  const line = v.slice(ls, le);
  const caret = s + line.length + 1;
  editorReplace(le, le, '\n' + line, caret, caret);
}

// Alt+↑ / Alt+↓ 上下移动当前行（有选区就整块移动）
function moveLines(dir) {
  const ed = $('#docEditor');
  const v = ed.value;
  const s = ed.selectionStart;
  const e2 = ed.selectionEnd;
  const ls = v.lastIndexOf('\n', s - 1) + 1;
  let le = v.indexOf('\n', e2);
  if (le === -1) le = v.length;
  const block = v.slice(ls, le);

  if (dir < 0) {
    if (ls === 0) return;
    const prevStart = v.lastIndexOf('\n', ls - 2) + 1;
    const prev = v.slice(prevStart, ls - 1);
    const delta = prev.length + 1;
    editorReplace(prevStart, le, block + '\n' + prev, s - delta, e2 - delta);
  } else {
    if (le >= v.length) return;
    const nextEndRaw = v.indexOf('\n', le + 1);
    const nextEnd = nextEndRaw === -1 ? v.length : nextEndRaw;
    const next = v.slice(le + 1, nextEnd);
    const delta = next.length + 1;
    editorReplace(ls, nextEnd, next + '\n' + block, s + delta, e2 + delta);
  }
}

// 标题级别：给选区覆盖的每一行套上 / 换成 / 去掉 # 前缀（同一级再点一次就取消）
function setHeading(level) {
  const ed = $('#docEditor');
  const v = ed.value;
  const s = ed.selectionStart;
  const e2 = ed.selectionEnd;
  const ls = v.lastIndexOf('\n', s - 1) + 1;
  let le = v.indexOf('\n', e2);
  if (le === -1) le = v.length;
  if (e2 > s && v[e2 - 1] === '\n') le = e2 - 1;

  const block = v.slice(ls, le);
  const lines = block.split('\n');
  const prefix = '#'.repeat(level) + ' ';
  const re = /^(#{1,6})[ \t]+/;
  const filled = lines.filter((ln) => ln.trim());
  const allSame = filled.length > 0 && filled.every((ln) => {
    const m = ln.match(re);
    return m && m[1].length === level;
  });

  const deltas = [];
  let total = 0;
  const out = lines.map((ln) => {
    if (!ln.trim()) { deltas.push(0); return ln; } // 空行不套标题
    const m = ln.match(re);
    const body = m ? ln.slice(m[0].length) : ln;
    const next = allSame ? body : prefix + body;
    const d = next.length - ln.length;
    deltas.push(d);
    total += d;
    return next;
  }).join('\n');
  if (out === block) return;

  const ns = Math.max(ls, s + deltas[0]);
  const ne = Math.max(ns, e2 + total);
  editorReplace(ls, le, out, ns, ne);
}

$('#docEditor').addEventListener('keydown', (e) => {
  if (e.isComposing || e.keyCode === 229) return; // 中文输入法组词中不拦
  const ed = e.currentTarget;
  const cmd = e.metaKey || e.ctrlKey;

  if (cmd && !e.shiftKey && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 's') { e.preventDefault(); saveDoc(false, true); return; }
    if (k === 'b') { e.preventDefault(); wrapEditSel('**', '**', '粗体文字'); return; }
    if (k === 'i') { e.preventDefault(); wrapEditSel('*', '*', '斜体文字'); return; }
    if (k === 'e') { e.preventDefault(); wrapEditSel('`', '`', 'code'); return; }
    if (k === 'k') { e.preventDefault(); insertLinkAtSel(); return; }
    if (k === 'd') { e.preventDefault(); duplicateLine(); return; }
    if (k === 'enter') { e.preventDefault(); saveDoc(); return; }
  }

  if (e.key === 'Tab') { e.preventDefault(); indentSelection(e.shiftKey); return; }

  if (e.altKey && !cmd && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    moveLines(e.key === 'ArrowUp' ? -1 : 1);
    return;
  }

  if (e.key === 'Enter' && !e.shiftKey && !cmd) {
    if (smartEnter()) e.preventDefault();
    return;
  }

  if (e.key === 'Escape') closeEditMenu();
});

$('#docEditor').addEventListener('contextmenu', (e) => {
  if (!state.editing) return;
  e.preventDefault();
  const ed = $('#docEditor');
  lastEditSel = { start: ed.selectionStart, end: ed.selectionEnd };
  openEditMenu(e.clientX, e.clientY);
});

$('#docEditor').addEventListener('scroll', closeEditMenu);

document.addEventListener('mousedown', (e) => {
  if ($('#editMenu').hidden) return;
  if (e.target.closest('#editMenu')) return;
  closeEditMenu();
});

$('#editMenu').addEventListener('click', (e) => {
  const hb = e.target.closest('[data-h]');
  if (hb) {
    closeEditMenu();
    setHeading(Number(hb.dataset.h));
    return;
  }
  const btn = e.target.closest('button[data-eact]');
  if (!btn) return;
  const act = btn.dataset.eact;
  closeEditMenu();
  const ed = $('#docEditor');

  if (act === 'image') { $('#imagePicker').click(); return; }
  if (act === 'bold') { wrapEditSel('**', '**', '粗体文字'); return; }
  if (act === 'italic') { wrapEditSel('*', '*', '斜体文字'); return; }
  if (act === 'inlinecode') { wrapEditSel('`', '`', 'code'); return; }
  if (act === 'link') {
    insertLinkAtSel(lastEditSel.start, lastEditSel.end);
    return;
  }
  if (act === 'codeblock') {
    const start = lastEditSel.start;
    const end = lastEditSel.end;
    const code = ed.value.slice(start, end);
    const text = `\n\`\`\`bash\n${code}\n\`\`\`\n`;
    editorReplace(start, end, text, start + 9, start + 9 + code.length);
    return;
  }
  if (act === 'table') {
    const text = '\n| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |\n';
    insertAtEditSel(text);
  }
});

$('#imagePicker').addEventListener('change', (e) => {
  const file = (e.target.files || [])[0];
  e.target.value = '';
  if (file) insertImage(file);
});

// 直接粘贴截图也能插入；选中文字后粘贴一个网址，自动变成 [文字](网址)
$('#docEditor').addEventListener('paste', (e) => {
  const items = Array.from((e.clipboardData && e.clipboardData.items) || []);
  const img = items.find((it) => it.type && it.type.startsWith('image/'));
  if (img) {
    const file = img.getAsFile();
    if (!file) return;
    e.preventDefault();
    insertImage(file);
    return;
  }
  // 选中文字 + 粘贴链接
  const ed = e.currentTarget;
  const s = ed.selectionStart;
  const en = ed.selectionEnd;
  if (s === en) return;
  const text = (e.clipboardData && e.clipboardData.getData('text/plain') || '').trim();
  if (!/^https?:\/\/\S+$/i.test(text)) return;
  e.preventDefault();
  const label = ed.value.slice(s, en);
  const ins = `[${label}](${text})`;
  editorReplace(s, en, ins, s + ins.length, s + ins.length);
});

$('#btnPin').addEventListener('click', () => {
  if (!state.doc) return;
  setPinned(state.doc, !state.doc.pinned);
});

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
}

$('#btnCopy').addEventListener('click', async () => {
  if (!state.doc) return;
  try {
    await copyText(state.doc.content || '');
    toast('内容已复制到剪贴板');
  } catch (e) { toast('复制失败，请手动选择内容', true); }
});

// 代码块快速复制（事件委托，重新渲染后依然有效；预览面板里的代码块也能用）
$('#docBody').addEventListener('click', async (e) => {
  const btn = e.target.closest('.cb-copy');
  if (!btn) return;
  const cb = btn.closest('.cb');
  const code = cb && cb.querySelector('code');
  if (!code) return;
  try {
    await copyText(code.textContent);
    const label = btn.querySelector('span');
    btn.classList.add('done');
    if (label) label.textContent = '已复制';
    setTimeout(() => {
      btn.classList.remove('done');
      if (label) label.textContent = '复制';
    }, 1400);
  } catch (err) { toast('复制失败', true); }
});

$('#btnDeleteDoc').addEventListener('click', () => {
  if (!state.doc) return;
  trashDoc(state.doc);
});

// 移到废纸篓
function trashDoc(d) {
  confirmModal({
    title: '移到废纸篓',
    sub: `「${esc(d.title || '未命名片段')}」会被移到废纸篓，随时可以恢复。`,
    okText: '移到废纸篓',
    danger: true,
    onOk: async () => {
      await api('docs/' + d.id, { method: 'DELETE' });
      if (state.currentId === d.id) {
        state.doc = null;
        state.currentId = null;
      }
      await loadData();
      toast('已移到废纸篓');
    },
  });
}

// 从废纸篓恢复
async function restoreDoc(d) {
  await api('docs/' + d.id + '/restore', { method: 'POST' });
  await loadData();
  if (state.currentId === d.id) {
    try {
      state.doc = await api('docs/' + d.id);
      renderDocArea();
    } catch (e) { /* 已不在当前视图 */ }
  }
  toast('已恢复');
}

// 彻底删除
function purgeDoc(d) {
  confirmModal({
    title: '彻底删除',
    sub: `「${esc(d.title || '未命名片段')}」及其附件会被永久删除，无法恢复。`,
    okText: '彻底删除',
    danger: true,
    onOk: async () => {
      await api('docs/' + d.id + '/purge', { method: 'DELETE' });
      if (state.currentId === d.id) {
        state.doc = null;
        state.currentId = null;
      }
      await loadData();
      toast('已彻底删除');
    },
  });
}

$('#btnRestore').addEventListener('click', async () => {
  if (!state.doc) return;
  try { await restoreDoc(state.doc); } catch (err) { toast(err.message, true); }
});

$('#btnPurge').addEventListener('click', () => {
  if (!state.doc) return;
  purgeDoc(state.doc);
});

/* ---------- 右上角动作按钮：长按拖动排序 ---------- */
const ACT_ORDER_KEY = 'sh.actOrder';
const ACT_DEFAULT = ['edit', 'toc', 'tags', 'copy', 'info', 'pin', 'delete'];
// v1.1.5 及更早的默认顺序：老用户如果没自己拖过，就跟着换成新默认
const ACT_OLD_DEFAULT = ['tags', 'pin', 'copy', 'edit', 'info', 'toc', 'delete'];

function loadActOrder() {
  let arr = null;
  try { arr = JSON.parse(localStorage.getItem(ACT_ORDER_KEY) || 'null'); } catch (e) { arr = null; }
  if (!Array.isArray(arr)) return ACT_DEFAULT.slice();
  // 存的还是旧默认 → 认为没自定义过，直接用新默认
  if (arr.length === ACT_OLD_DEFAULT.length && arr.every((v, i) => v === ACT_OLD_DEFAULT[i])) {
    return ACT_DEFAULT.slice();
  }
  const out = arr.filter((id) => ACT_DEFAULT.includes(id));
  ACT_DEFAULT.forEach((id) => { if (!out.includes(id)) out.push(id); }); // 兼容以后新增的按钮
  return out;
}

function actBox() { return document.querySelector('.doc-actions'); }

function applyActOrder() {
  const box = actBox();
  if (!box) return;
  loadActOrder().forEach((id) => {
    const el = box.querySelector(`.act[data-act="${id}"]`);
    if (el) box.appendChild(el);
  });
  const more = $('#btnMore');
  if (more) box.appendChild(more); // 「更多」永远排最后
}

function currentActOrder() {
  const box = actBox();
  if (!box) return ACT_DEFAULT.slice();
  return Array.from(box.querySelectorAll('.act[data-act]')).map((el) => el.dataset.act);
}

let actDrag = null;

function beginActDrag(el, x, y) {
  const box = actBox();
  if (!box) return;
  const r = el.getBoundingClientRect();
  const ph = document.createElement('div');
  ph.className = 'act-ph';
  ph.style.width = r.width + 'px';
  ph.style.height = r.height + 'px';
  box.insertBefore(ph, el);
  el.style.width = r.width + 'px';
  el.style.height = r.height + 'px';
  el.style.left = r.left + 'px';
  el.style.top = r.top + 'px';
  el.classList.add('dragging');
  document.body.classList.add('acts-dragging');
  actDrag = { el, ph, box, dx: x - r.left, dy: y - r.top };
}

function moveActDrag(e) {
  const d = actDrag;
  if (!d) return;
  d.el.style.left = (e.clientX - d.dx) + 'px';
  d.el.style.top = (e.clientY - d.dy) + 'px';

  // 指针越过哪个按钮的中心，就把占位挪到它前面
  const others = Array.from(d.box.querySelectorAll('.act[data-act]')).filter((x) => x !== d.el);
  let before = null;
  for (const o of others) {
    const r = o.getBoundingClientRect();
    if (e.clientX < r.left + r.width / 2) { before = o; break; }
  }
  const more = d.box.querySelector('#btnMore');
  if (before) d.box.insertBefore(d.ph, before);
  else if (more && more.parentNode === d.box) d.box.insertBefore(d.ph, more);
  else d.box.appendChild(d.ph);
}

function endActDrag(save) {
  const d = actDrag;
  if (!d) return;
  actDrag = null;
  document.body.classList.remove('acts-dragging');
  const { el, ph } = d;
  el.classList.remove('dragging');
  el.style.cssText = '';
  if (save) {
    ph.parentNode.insertBefore(el, ph);
    const order = currentActOrder();
    const changed = order.join(',') !== loadActOrder().join(',');
    try { localStorage.setItem(ACT_ORDER_KEY, JSON.stringify(order)); } catch (e) { /* ignore */ }
    if (changed) toast('按钮顺序已保存');
  }
  ph.remove();
}

let suppressActClick = false;

document.addEventListener('click', (e) => {
  if (suppressActClick && e.target.closest('.doc-actions')) {
    e.stopPropagation();
    e.preventDefault();
  }
}, true);

document.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (matchMedia('(max-width: 820px)').matches) return; // 手机端只显示「更多」，不参与排序
  const el = e.target.closest('.doc-actions .act[data-act]');
  if (!el) return;

  const sx = e.clientX;
  const sy = e.clientY;
  let armed = false;   // 长按到了，等一个位移就开拖
  let active = false;  // 真正在拖
  let done = false;

  const timer = setTimeout(() => {
    if (done) return;
    armed = true;
  }, 260);

  const finish = (save) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onUp, true);
    if (active) {
      endActDrag(save);
      suppressActClick = true;
      setTimeout(() => { suppressActClick = false; }, 0);
    }
  };

  const onMove = (ev) => {
    if (!active) {
      const dist = Math.hypot(ev.clientX - sx, ev.clientY - sy);
      if (armed && dist > 5) {
        active = true;
        beginActDrag(el, sx, sy);
        if (el.setPointerCapture) { try { el.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
      } else if (!armed && dist > 8) {
        finish(false); // 还没长按就划走了，交给原行为
        return;
      }
      if (!active) return;
    }
    ev.preventDefault();
    moveActDrag(ev);
  };
  const onUp = () => finish(true);

  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onUp, true);
}, true);

applyActOrder();

// 非 macOS 把右键菜单里的 ⌘ 提示换成 Ctrl
if (!/Mac|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
  $$('.kbd').forEach((k) => { k.textContent = k.textContent.replace('⌘', 'Ctrl+'); });
}

/* ---------- 手机端：正文操作菜单 ---------- */
const DOC_MENU_ICONS = {
  tags: '<path d="M11.6 4H20v8.4a2 2 0 0 1-.6 1.4l-6 6a2 2 0 0 1-2.8 0l-5.4-5.4a2 2 0 0 1 0-2.8l5-5A2 2 0 0 1 11.6 4z"/><circle cx="15.8" cy="8.2" r="1.15"/>',
  pin: '<path d="M12 20.5V9.5"/><path d="m6.8 14.6 5.2-5.2 5.2 5.2"/><path d="M5 4.5h14"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M15 6.2A2.2 2.2 0 0 0 12.8 4H6.2A2.2 2.2 0 0 0 4 6.2v6.6A2.2 2.2 0 0 0 6.2 15"/>',
  edit: '<path d="M11.5 5H6.4A2.4 2.4 0 0 0 4 7.4v10.2A2.4 2.4 0 0 0 6.4 20h10.2a2.4 2.4 0 0 0 2.4-2.4v-5.1"/><path d="M17.3 3.7a2.3 2.3 0 0 1 3.2 3.2L13 14.4l-3.6.9.9-3.6z"/>',
  trash: '<path d="M4.6 6.9h14.8"/><path d="M9 6.9V5a1.2 1.2 0 0 1 1.2-1.2h3.6A1.2 1.2 0 0 1 15 5v1.9"/><path d="M6.5 6.9l.8 12.2A2 2 0 0 0 9.3 21h5.4a2 2 0 0 0 2-1.9l.8-12.2"/><path d="M10.2 10.6v6.6M13.8 10.6v6.6"/>',
  restore: '<path d="M4 9.5h5.5"/><path d="M4 9.5V4"/><path d="M4.6 9.2A8 8 0 1 1 4 14.6"/>',
  purge: '<path d="M5 7h14M9.5 7V5.4h5V7M7.2 7l.8 11.2a1.6 1.6 0 0 0 1.6 1.5h4.8a1.6 1.6 0 0 0 1.6-1.5L16.8 7"/><path d="M10.5 10.5l3 3M13.5 10.5l-3 3"/>',
  info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 7.6v5.2"/><circle cx="12" cy="16.5" r=".95" fill="currentColor" stroke="none"/>',
  toc: '<path d="M8.4 6.4h11.4M8.4 12h11.4M8.4 17.6h11.4"/><circle cx="4.6" cy="6.4" r="1.15" fill="currentColor" stroke="none"/><circle cx="4.6" cy="12" r="1.15" fill="currentColor" stroke="none"/><circle cx="4.6" cy="17.6" r="1.15" fill="currentColor" stroke="none"/>',
};

function closeDocMenu() {
  const menu = $('#docMenu');
  if (menu && !menu.hidden) menu.hidden = true;
  const btn = $('#btnMore');
  if (btn) btn.classList.remove('open');
}

function openDocMenu() {
  const d = state.doc;
  if (!d) return;
  const menu = $('#docMenu');
  const btn = $('#btnMore');
  const inTrash = !!d.deletedAt;
  const row = (act, icon, label, cls = '') =>
    `<button data-dact="${act}"${cls ? ` class="${cls}"` : ''}><svg viewBox="0 0 24 24" class="ic">${icon}</svg>${label}</button>`;

  // 顺序与 PC 端右上角图标一致：编辑 / 目录 / 标签 / 复制 / 信息 / 置顶 / 删除
  menu.innerHTML = inTrash
    ? row('restore', DOC_MENU_ICONS.restore, '恢复到原位置')
      + row('purge', DOC_MENU_ICONS.purge, '彻底删除', 'danger')
      + '<div class="sep"></div>'
      + row('toc', DOC_MENU_ICONS.toc, tocOn ? '隐藏目录' : '显示目录', tocOn ? 'on' : '')
      + row('info', DOC_MENU_ICONS.info, '文档信息')
    : row('edit', DOC_MENU_ICONS.edit, state.editing ? '保存并退出' : '编辑正文', state.editing ? 'on' : '')
      + row('toc', DOC_MENU_ICONS.toc, tocOn ? '隐藏目录' : '显示目录', tocOn ? 'on' : '')
      + row('tags', DOC_MENU_ICONS.tags, '设置标签')
      + row('copy', DOC_MENU_ICONS.copy, '复制内容')
      + row('info', DOC_MENU_ICONS.info, '文档信息')
      + row('pin', DOC_MENU_ICONS.pin, d.pinned ? '取消置顶' : '置顶这段内容', d.pinned ? 'on' : '')
      + '<div class="sep"></div>'
      + row('delete', DOC_MENU_ICONS.trash, '移至废纸篓', 'danger');

  menu.hidden = false;
  btn.classList.add('open');

  // 右对齐「更多」按钮，超出视口时夹回来
  const r = btn.getBoundingClientRect();
  const pad = 10;
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  const left = Math.max(pad, Math.min(window.innerWidth - w - pad, r.right - w));
  const top = Math.max(pad, Math.min(window.innerHeight - h - pad, r.bottom + 8));
  menu.style.left = Math.round(left) + 'px';
  menu.style.top = Math.round(top) + 'px';
}

$('#btnMore').addEventListener('click', (e) => {
  e.stopPropagation();
  if ($('#docMenu').hidden) openDocMenu();
  else closeDocMenu();
});

$('#docMenu').addEventListener('click', (e) => {
  const b = e.target.closest('[data-dact]');
  if (!b) return;
  const act = b.dataset.dact;
  if (act === 'info') { closeDocMenu(); openInfoPop(); return; }
  if (act === 'toc') { closeDocMenu(); setTocPref(!tocOn); return; }
  const target = {
    tags: '#btnTags', pin: '#btnPin', copy: '#btnCopy',
    edit: '#btnEdit', delete: '#btnDeleteDoc', restore: '#btnRestore', purge: '#btnPurge',
  }[b.dataset.dact];
  closeDocMenu();
  const el = target && $(target);
  if (el) el.click();
});

document.addEventListener('click', (e) => {
  const menu = $('#docMenu');
  if (!menu || menu.hidden) return;
  if (menu.contains(e.target) || e.target.closest('#btnMore')) return;
  closeDocMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDocMenu();
});
$('#docBody').addEventListener('scroll', () => {
  const menu = $('#docMenu');
  if (menu && !menu.hidden) closeDocMenu();
}, { passive: true });
window.addEventListener('resize', closeDocMenu);

/* ---------- 文档信息浮层（字数 / 实际路径 / 下载）---------- */
function closeInfoPop() {
  const pop = $('#infoPop');
  if (pop && !pop.hidden) pop.hidden = true;
  const btn = $('#btnInfo');
  if (btn) btn.classList.remove('on');
}

function docTextStats(content) {
  return { chars: String(content || '').replace(/\s/g, '').length };
}

function openInfoPop(anchor) {
  const d = state.doc;
  if (!d) return;
  const pop = $('#infoPop');
  const btn = anchor || $('#btnInfo');
  const { chars } = docTextStats(d.content);
  const dir = (state.app && state.app.dataDir) || '';
  const rel = d.file || d.id + '.md'; // 服务端存的是 notes/<文件夹>/<标题>.md
  const path = dir + '/notes/' + rel;
  pop.innerHTML = `
    <div class="ip-head">
      <div class="ip-title">${esc(d.title || '未命名片段')}</div>
      <button class="ip-print" id="btnPrintDoc" type="button" aria-label="打印这段内容" title="打印">
        <svg viewBox="0 0 24 24" class="ic"><path d="M7.2 8.6V4.7h9.6v3.9"/><rect x="4.2" y="8.6" width="15.6" height="7" rx="2"/><path d="M7.2 15.6h9.6v3.7H7.2z"/><path d="M17 11.6h.01"/></svg>
      </button>
    </div>
    <div class="ip-row"><span>本文字数</span><b>${chars.toLocaleString('zh-CN')} 字</b></div>
    <div class="ip-path">${esc(path)}</div>
    <button class="ip-dl" id="btnDownloadDoc">
      <svg viewBox="0 0 24 24" class="ic"><path d="M12 4v10.5"/><path d="m7.8 10.6 4.2 4.2 4.2-4.2"/><path d="M5 19.2h14"/></svg>
      下载这份 .md 文档
    </button>
    <button class="ip-dl ip-dl-alt" id="btnExportHtml">
      <svg viewBox="0 0 24 24" class="ic"><path d="M13.5 4.5H7.2A1.7 1.7 0 0 0 5.5 6.2v11.6a1.7 1.7 0 0 0 1.7 1.7h9.6a1.7 1.7 0 0 0 1.7-1.7v-8.3Z"/><path d="M13.2 4.6v4.2h4.4"/><path d="M9 13.4h6"/><path d="M9 16.4h4"/></svg>
      导出为 HTML 文档
    </button>`;
  pop.hidden = false;
  if (btn) btn.classList.add('on');

  const pad = 10;
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const r = btn && btn.offsetParent ? btn.getBoundingClientRect() : null;
  if (r) {
    const left = Math.max(pad, Math.min(window.innerWidth - w - pad, r.right - w));
    const top = Math.max(pad, Math.min(window.innerHeight - h - pad, r.bottom + 8));
    pop.style.left = Math.round(left) + 'px';
    pop.style.top = Math.round(top) + 'px';
  } else {
    pop.style.left = Math.round((window.innerWidth - w) / 2) + 'px';
    pop.style.top = Math.round((window.innerHeight - h) / 2) + 'px';
  }

  $('#btnDownloadDoc').addEventListener('click', downloadDocFile);
  $('#btnExportHtml').addEventListener('click', exportDocHtml);
  $('#btnPrintDoc').addEventListener('click', printDocContent);
}

async function downloadDocFile() {
  const d = state.doc;
  if (!d) return;
  const name = docFileBase(d) + '.md';
  try {
    await downloadViaApi('api/docs/' + encodeURIComponent(d.id) + '/file', name);
    toast('已下载 ' + name);
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------- 导出 HTML / 打印：只把正文按现有样式解析成一页 ---------- */
function docFileBase(d) {
  return ((d && d.title) || '未命名片段').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || '未命名片段';
}

// 页面里的代码块带复制按钮和行号列，导出时简化成「语言 + 代码」，避免行号错位
function docContentHTML(d) {
  const holder = document.createElement('div');
  holder.innerHTML = markdown((d && d.content) || '');
  holder.querySelectorAll('button').forEach((b) => b.remove());
  holder.querySelectorAll('.cb').forEach((cb) => {
    const langEl = cb.querySelector('.cb-lang');
    const codeEl = cb.querySelector('pre code');
    const box = document.createElement('div');
    box.className = 'code';
    const head = document.createElement('div');
    head.className = 'code-lang';
    head.textContent = (langEl && langEl.textContent.trim()) || 'text';
    const pre = document.createElement('pre');
    if (codeEl) pre.appendChild(codeEl);
    box.appendChild(head);
    box.appendChild(pre);
    cb.replaceWith(box);
  });
  return holder.innerHTML;
}

function docExportCSS() {
  const accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#e2644c').trim() || '#e2644c';
  return `
:root{color-scheme:light;}
*{box-sizing:border-box;}
body{margin:0;background:#fff;color:#20242b;font:15px/1.78 -apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;text-wrap:pretty;}
.wrap{max-width:820px;margin:0 auto;padding:44px 26px 72px;}
h1,h2,h3,h4{margin:1.55em 0 .55em;font-weight:650;line-height:1.35;color:#12161b;break-after:avoid;}
h1{font-size:26px;margin-top:0;padding-bottom:.34em;border-bottom:1px solid #e6e9ee;}
h2{font-size:21px;}
h3{font-size:17px;}
h4{font-size:15px;}
p{margin:.72em 0;}
a{color:${accent};text-decoration:none;}
a:hover{text-decoration:underline;}
strong{font-weight:650;}
ul,ol{margin:.7em 0;padding-left:1.55em;}
li{margin:.26em 0;}
li::marker{color:#8b929c;}
blockquote{margin:1em 0;padding:.55em 1.05em;border-left:3px solid ${accent};background:#f7f8fa;color:#4a5058;border-radius:0 7px 7px 0;}
blockquote p{margin:.35em 0;}
hr{border:0;height:1px;background:#e6e9ee;margin:1.9em 0;}
img{max-width:100%;height:auto;border-radius:7px;}
code{font-family:ui-monospace,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;font-size:.87em;background:#f1f3f6;padding:.14em .36em;border-radius:4px;color:#b4392c;}
.code{margin:1.05em 0;border:1px solid #e6e9ee;border-radius:10px;overflow:hidden;background:#fbfcfd;break-inside:avoid;}
.code-lang{padding:5px 13px;font:600 11px/1.65 ui-monospace,Menlo,Consolas,monospace;letter-spacing:.3px;color:#7c848e;background:#f2f4f7;border-bottom:1px solid #e6e9ee;}
.code pre{margin:0;padding:13px 15px;overflow-x:auto;}
.code pre code{display:block;background:none;padding:0;border-radius:0;color:#24292f;font-size:12.5px;line-height:1.72;white-space:pre;}
.tbl{overflow-x:auto;margin:1.05em 0;}
table{border-collapse:collapse;width:100%;font-size:13.5px;}
th,td{border:1px solid #e2e5ea;padding:7px 11px;text-align:left;vertical-align:top;}
th{background:#f6f7f9;font-weight:600;}
tbody tr:nth-child(even){background:#fbfbfc;}
.hljs-comment,.hljs-quote{color:#8b929c;font-style:italic;}
.hljs-keyword,.hljs-selector-tag,.hljs-literal,.hljs-doctag,.hljs-name{color:#a626a4;}
.hljs-string,.hljs-regexp,.hljs-addition,.hljs-attribute,.hljs-meta .hljs-string{color:#3f8f45;}
.hljs-number,.hljs-symbol,.hljs-bullet,.hljs-link,.hljs-selector-attr{color:#986801;}
.hljs-title,.hljs-title.function_,.hljs-section,.hljs-selector-id,.hljs-selector-class{color:#3d6fe0;}
.hljs-variable,.hljs-template-variable,.hljs-attr,.hljs-property,.hljs-selector-pseudo{color:#c14a37;}
.hljs-type,.hljs-title.class_,.hljs-built_in,.hljs-class .hljs-title{color:#a06000;}
.hljs-tag{color:#c14a37;}
.hljs-operator,.hljs-punctuation{color:#5c6370;}
.hljs-meta,.hljs-subst{color:#8b929c;}
@page{margin:14mm;}
@media print{
  .wrap{max-width:none;padding:0;}
  body{font-size:12.5pt;}
  a{color:#20242b;text-decoration:underline;}
  .code pre{overflow:visible;}
  .code pre code{white-space:pre-wrap;overflow-wrap:anywhere;}
  .tbl{overflow:visible;}
  .code,.tbl,blockquote,pre,table,img{break-inside:avoid;}
  tr,td,th{break-inside:avoid;}
}`;
}

function docExportHTML(d, forPrint) {
  const title = esc(d.title || '未命名片段');
  const base = forPrint ? `<base href="${esc(location.href)}">\n` : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${base}<title>${title}</title>
<style>${docExportCSS()}</style>
</head>
<body>
<div class="wrap">
${docContentHTML(d)}
</div>
</body>
</html>
`;
}

function exportDocHtml() {
  const d = state.doc;
  if (!d) return;
  try {
    const html = docExportHTML(d, false);
    const name = docFileBase(d) + '.html';
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1200);
    toast('已导出 ' + name);
  } catch (err) {
    toast('导出失败：' + err.message, true);
  }
}

// 打印：把同一份 HTML 写进离屏 iframe，唤起系统打印，直接打正文这一页
function printDocContent() {
  const d = state.doc;
  if (!d) return;
  const old = document.getElementById('printFrame');
  if (old) old.remove();
  const frame = document.createElement('iframe');
  frame.id = 'printFrame';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none;';
  document.body.appendChild(frame);
  const win = frame.contentWindow;
  const fdoc = win.document;
  fdoc.open();
  fdoc.write(docExportHTML(d, true));
  fdoc.close();

  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    try {
      win.focus();
      win.print();
      toast('已打开打印窗口');
    } catch (err) {
      toast('当前浏览器不允许直接打印，可改用「导出为 HTML 文档」', true);
    }
    setTimeout(() => { const f = document.getElementById('printFrame'); if (f) f.remove(); }, 15000);
  };
  // 等图片 / 字体就绪，避免打印预览里缺图
  if (fdoc.readyState === 'complete') setTimeout(fire, 160);
  else frame.addEventListener('load', () => setTimeout(fire, 160), { once: true });
  setTimeout(fire, 1600); // 兜底，别让点击没反应
}

$('#btnInfo').addEventListener('click', (e) => {
  e.stopPropagation();
  if ($('#infoPop').hidden) openInfoPop() ; else closeInfoPop();
});

document.addEventListener('click', (e) => {
  const pop = $('#infoPop');
  if (!pop || pop.hidden) return;
  if (pop.contains(e.target) || e.target.closest('#btnInfo') || e.target.closest('#docMenu')) return;
  closeInfoPop();
});

/* ---------- 正文目录（TOC）---------- */
const TOC_KEY = 'sh.toc';
let tocOn = false;
try { tocOn = localStorage.getItem(TOC_KEY) === '1'; } catch (e) { /* ignore */ }
let tocHeads = [];
let tocActiveIdx = -1;

function setTocPref(on) {
  tocOn = !!on;
  try { localStorage.setItem(TOC_KEY, tocOn ? '1' : '0'); } catch (e) { /* ignore */ }
  renderToc();
}

function renderToc() {
  const pane = $('#tocPane');
  const list = $('#tocList');
  const btn = $('#btnToc');
  const d = state.doc;
  const show = tocOn && !!d && !state.editing;
  pane.hidden = !show;
  if (btn) {
    btn.classList.toggle('on', tocOn);
    setTip('#btnToc', tocOn ? '隐藏目录' : '显示目录');
  }
  if (!show) { tocHeads = []; tocActiveIdx = -1; return; }

  tocHeads = Array.from($('#docView').querySelectorAll('h1,h2,h3,h4,h5,h6'));
  if (!tocHeads.length) {
    list.innerHTML = '<div class="toc-empty">该篇内容没有出现标题</div>';
    return;
  }
  const minLv = Math.min(...tocHeads.map((h) => Number(h.tagName[1])));
  list.innerHTML = tocHeads.map((h, i) => {
    const lv = Number(h.tagName[1]) - minLv + 1;
    const pad = 8 + (lv - 1) * 12;
    const label = (h.textContent || '').trim() || '未命名标题';
    return `<button class="toc-item${lv === 1 ? ' lv1' : ''}" data-toc="${i}" style="padding-left:${pad}px" title="${esc(label)}">${esc(label)}</button>`;
  }).join('');
  tocActiveIdx = -1;
  spyToc();
}

function setTocActive(idx) {
  if (idx === tocActiveIdx) return;
  tocActiveIdx = idx;
  const list = $('#tocList');
  const items = list.querySelectorAll('.toc-item');
  items.forEach((b, i) => b.classList.toggle('active', i === idx));
  const cur = items[idx];
  if (cur) {
    const r = cur.getBoundingClientRect();
    const lr = list.getBoundingClientRect();
    if (r.top < lr.top || r.bottom > lr.bottom) cur.scrollIntoView({ block: 'nearest' });
  }
}

function spyToc() {
  if (!tocHeads.length) return;
  const body = $('#docBody');
  if (!body) return;
  const line = body.getBoundingClientRect().top + 56;
  let idx = 0;
  for (let i = 0; i < tocHeads.length; i++) {
    if (tocHeads[i].getBoundingClientRect().top <= line) idx = i;
    else break;
  }
  // 只有正文确实能滚动时，滚到底部才把高亮落到最后一个标题
  const canScroll = body.scrollHeight > body.clientHeight + 4;
  if (canScroll && body.scrollTop + body.clientHeight >= body.scrollHeight - 6) idx = tocHeads.length - 1;
  setTocActive(idx);
}

$('#btnToc').addEventListener('click', () => setTocPref(!tocOn));
$('#tocClose').addEventListener('click', () => setTocPref(false));

$('#tocList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-toc]');
  if (!b) return;
  const i = Number(b.dataset.toc);
  const h = tocHeads[i];
  if (!h) return;
  const body = $('#docBody');
  const delta = h.getBoundingClientRect().top - body.getBoundingClientRect().top;
  body.scrollTo({ top: Math.max(0, body.scrollTop + delta - 6), behavior: 'smooth' });
  setTocActive(i);
});

$('#docBody').addEventListener('scroll', () => {
  if (!tocHeads.length) return;
  spyToc();
}, { passive: true });

$('#btnEmptyTrash').addEventListener('click', () => {
  if (!state.trash.length) return;
  confirmModal({
    title: '清空废纸篓',
    sub: `废纸篓里的 ${state.trash.length} 条内容及其附件将被永久删除，无法恢复。`,
    okText: '清空',
    danger: true,
    onOk: async () => {
      const res = await api('trash/empty', { method: 'POST' });
      state.doc = null;
      state.currentId = null;
      await loadData();
      toast(`已清空 ${res.removed} 条内容`);
    },
  });
});

/* ---------- 标签编辑 ---------- */
$('#docMeta').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-tag]');
  if (chip) setView('tag', chip.dataset.tag);
});

function renderTagPop() {
  const d = state.doc;
  if (!d) return;
  const cur = d.tags || [];
  $('#tpChips').innerHTML = cur
    .map((t) => {
      const color = tagColorOf(t);
      const style = color ? ` style="color:${color};border-color:${color}44;background:${color}1f"` : '';
      return `<span class="tag-chip"${style}><span class="tx">${esc(t)}</span><span class="x" data-rm="${esc(t)}" title="移除标签"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></span></span>`;
    })
    .join('');
  const lower = new Set(cur.map((t) => t.toLowerCase()));
  const sug = state.tags.filter((t) => !lower.has(t.name.toLowerCase())).slice(0, 8);
  $('#tpSuggest').innerHTML = sug
    .map((t) => `<button class="tag-chip" data-add="${esc(t.name)}"${t.color ? ` style="color:${t.color};border-color:${t.color}44;background:${t.color}1f"` : ''}>${esc(t.name)}</button>`)
    .join('');
}

function openTagPop() {
  if (!state.doc) return;
  const pop = $('#tagPop');
  if (!pop.hidden) { pop.hidden = true; return; }
  renderTagPop();
  pop.hidden = false;
  const input = $('#tpInput');
  input.value = '';
  input.focus();
}
function closeTagPop() { $('#tagPop').hidden = true; }

async function updateTags(next) {
  if (!state.doc) return;
  try {
    const saved = await api('docs/' + state.doc.id, { method: 'PUT', body: { tags: next } });
    state.doc = Object.assign({}, state.doc, saved);
    renderDocHead();
    renderTagPop();
    await loadData();
  } catch (err) { toast(err.message, true); }
}

async function addTag(name) {
  const v = String(name || '').trim().replace(/^#/, '');
  if (!v || !state.doc) return;
  const cur = state.doc.tags || [];
  if (cur.some((t) => t.toLowerCase() === v.toLowerCase())) { toast('已经有这个标签了', true); return; }
  if (cur.length >= 12) { toast('单篇内容最多 12 个标签', true); return; }
  await updateTags(cur.concat([v]));
}

$('#btnTags').addEventListener('click', openTagPop);

$('#tpChips').addEventListener('click', (e) => {
  const x = e.target.closest('[data-rm]');
  if (!x || !state.doc) return;
  const name = x.dataset.rm;
  updateTags((state.doc.tags || []).filter((t) => t !== name));
});

$('#tpSuggest').addEventListener('click', (e) => {
  const b = e.target.closest('[data-add]');
  if (b) addTag(b.dataset.add);
});

$('#tpInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const v = e.target.value;
    e.target.value = '';
    addTag(v);
  }
  if (e.key === 'Escape') { closeTagPop(); }
});

document.addEventListener('mousedown', (e) => {
  if ($('#tagPop').hidden) return;
  if (e.target.closest('#tagPop') || e.target.closest('#btnTags')) return;
  closeTagPop();
});

/* ---------- 附件 ---------- */
/* 附件文件名：鼠标移上去时慢慢横向滚动，把被截断的部分露出来 */
let nameScrollEl = null;

function stopNameScroll() {
  const el = nameScrollEl;
  if (!el) return;
  if (el._raf) cancelAnimationFrame(el._raf);
  el._raf = null;
  el.classList.remove('scrolling');
  el.scrollLeft = 0;
  nameScrollEl = null;
}

function startNameScroll(tile) {
  const el = tile && tile.querySelector('.an');
  if (!el) return;
  stopNameScroll();
  const max = el.scrollWidth - el.clientWidth;
  if (max <= 3) return; // 名字没被截断就不动

  el.classList.add('scrolling');
  el.scrollLeft = 0;
  nameScrollEl = el;

  // 速度按超长程度自适应：短一点就慢，长一点稍快，整趟控制在 3 秒上下
  const speed = Math.min(96, Math.max(40, max / 3.2));
  let dir = 1;
  let pos = 0;
  let wait = 0;
  let last = performance.now();

  const step = (now) => {
    const dt = Math.min(64, now - last);
    last = now;
    if (wait > 0) {
      wait -= dt;
      el._raf = requestAnimationFrame(step);
      return;
    }
    pos += (dir * speed * dt) / 1000;
    if (dir > 0 && pos >= max) {
      pos = max;
      dir = -1;
      wait = 900; // 滚到末尾停一下
    } else if (dir < 0 && pos <= 0) {
      el.scrollLeft = 0;
      el.classList.remove('scrolling');
      el._raf = null;
      if (nameScrollEl === el) nameScrollEl = null;
      return;
    }
    el.scrollLeft = pos;
    el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

$('#attachStrip').addEventListener('mouseover', (e) => {
  const tile = e.target.closest('.att');
  if (!tile) return;
  if (tile.contains(e.relatedTarget)) return;
  startNameScroll(tile);
});
$('#attachStrip').addEventListener('mouseout', (e) => {
  const tile = e.target.closest('.att');
  if (!tile) return;
  if (tile.contains(e.relatedTarget)) return;
  stopNameScroll();
});

function renderAttachments() {
  const d = state.doc;
  const strip = $('#attachStrip');
  stopNameScroll();
  strip.innerHTML = '';
  if (!d) return;
  const atts = d.attachments || [];
  // 没有附件时的预览状态整条隐藏；编辑状态才露出上传入口
  const canEdit = state.editing && !d.deletedAt;
  const showBar = atts.length > 0 || canEdit;
  $('.attach-bar').style.display = showBar ? 'block' : 'none';
  $('#attachCount').textContent = atts.length ? atts.length + ' 个' : '';

  atts.forEach((a) => {
    const tile = document.createElement('div');
    tile.className = 'att';
    // 名字超长时悬停会横向滚动露出全名，所以不再挂原生 title（会被浮层挡住）
    if ((a.name || '').length <= 14) tile.title = `${a.name} · ${fmtSize(a.size)}`;
    const readonlyDoc = !!d.deletedAt;
    tile.innerHTML = `
      <span class="ext">${esc(extOf(a.name))}</span>
      <span class="an">${esc(a.name)}</span>
      <div class="ov">
        <button class="dl" title="下载">
          <svg viewBox="0 0 24 24" class="ic" style="width:13px;height:13px"><path d="M12 5v10M8 11.5l4 4 4-4M5 19h14"/></svg>
        </button>
        ${readonlyDoc || !state.editing ? '' : `<button class="del" title="删除附件"><svg viewBox="0 0 24 24" class="ic" style="width:13px;height:13px"><path d="M6 6l12 12M18 6L6 18"/></svg></button>`}
      </div>`;
    tile.querySelector('.dl').addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        await downloadViaApi('api/docs/' + d.id + '/files/' + a.id, a.name);
      } catch (err) {
        toast(err.message, true);
      }
    });
    const delBtn = tile.querySelector('.del');
    if (delBtn) delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      confirmModal({
        title: '删除附件',
        sub: `确定删除附件「${esc(a.name)}」？`,
        okText: '删除',
        danger: true,
        onOk: async () => {
          await api(`docs/${d.id}/files/${a.id}`, { method: 'DELETE' });
          state.doc.attachments = state.doc.attachments.filter((x) => x.id !== a.id);
          renderAttachments();
          await loadData();
          toast('附件已删除');
        },
      });
    });
    strip.appendChild(tile);
  });

  if (canEdit) {
    const add = document.createElement('button');
    add.className = 'att add';
    add.innerHTML = `<svg viewBox="0 0 24 24" class="ic"><path d="M12 5v14M5 12h14"/></svg><span>添加附件</span>`;
    add.addEventListener('click', () => $('#filePicker').click());
    strip.appendChild(add);
  }
}

$('#filePicker').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  e.target.value = '';
  if (!files.length || !state.doc) return;
  await uploadFiles(files);
});

async function uploadFiles(files) {
  if (!state.doc) return;
  const fd = new FormData();
  files.forEach((f) => fd.append('files', f, f.name));
  toast('正在上传 ' + files.length + ' 个文件…');
  try {
    const res = await api(`docs/${state.doc.id}/files`, { method: 'POST', body: fd });
    state.doc.attachments = (state.doc.attachments || []).concat(res.added || []);
    renderAttachments();
    await loadData();
    toast('上传完成');
  } catch (err) { toast(err.message, true); }
}

;['dragenter', 'dragover'].forEach((ev) => {
  $('#attachStrip').addEventListener(ev, (e) => { e.preventDefault(); $('#attachStrip').classList.add('drag-over'); });
});
;['dragleave', 'drop'].forEach((ev) => {
  $('#attachStrip').addEventListener(ev, (e) => { e.preventDefault(); $('#attachStrip').classList.remove('drag-over'); });
});
$('#attachStrip').addEventListener('drop', (e) => {
  if (!state.doc) return;
  const files = Array.from(e.dataTransfer.files || []);
  if (files.length) uploadFiles(files);
});

/* ---------- 文件夹操作 ---------- */
function promptNewFolder(opts = {}) {
  promptModal({
    title: '新建文件夹',
    sub: opts.sub || '给这个文件夹起个名字，比如「代码仓库」「运维备忘」。',
    placeholder: '文件夹名称',
    okText: opts.okText || '创建',
    onOk: async (name) => {
      const f = await api('folders', { method: 'POST', body: { name } });
      if (opts.after) { await opts.after(f); return; }
      await setView('folder', f.id);
      toast('文件夹已创建');
    },
  });
}

function newFolder() { promptNewFolder(); }

const TAG_PALETTE = ['#e2644c', '#e8a13c', '#4f9d69', '#3d8fd1', '#7a6cf0', '#d4557f', '#5aa8a0', '#8b8f99'];

let ctxTarget = null;
function openCtx(x, y, target) {
  ctxTarget = target || null;
  const m = $('#ctxMenu');
  const type = target ? target.type : 'blank';
  const show = (act, on) => { m.querySelector(`[data-act="${act}"]`).hidden = !on; };
  const label = (act, text) => { m.querySelector(`[data-act="${act}"]`).lastChild.textContent = text; };

  show('new', type === 'blank' || type === 'folder');
  show('rename', type === 'folder' || type === 'tag');
  show('delete', type === 'folder' || type === 'tag' || type === 'doc');
  show('tagcolor', type === 'tag');
  show('pin', type === 'doc');
  show('move', type === 'doc');
  show('restore', type === 'trash');
  show('purge', type === 'trash');

  label('rename', type === 'tag' ? '重命名标签' : '重命名');
  label('delete', type === 'tag' ? '删除标签' : (type === 'doc' ? '移到废纸篓' : '删除'));
  if (type === 'doc') label('pin', target.item.pinned ? '取消置顶' : '置顶');

  m.hidden = false;
  const rect = m.getBoundingClientRect();
  m.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
  m.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
}
function closeCtx() { $('#ctxMenu').hidden = true; ctxTarget = null; }

$('#folderList').addEventListener('contextmenu', (e) => {
  if (e.target.closest('[data-folder]')) return;
  e.preventDefault();
  openCtx(e.clientX, e.clientY, null);
});

// 侧边栏空白处右键也能新建文件夹
$('.side-scroll').addEventListener('contextmenu', (e) => {
  if (e.target.closest('[data-folder]') || e.target.closest('.side-item')) return;
  e.preventDefault();
  openCtx(e.clientX, e.clientY, null);
});

/* ---------- 标签管理 ---------- */
function tagColorModal(tag) {
  const swatches = TAG_PALETTE.map((c) =>
    `<button class="swatch${tag.color === c ? ' active' : ''}" data-color="${c}" style="background:${c};color:${c}"></button>`).join('');
  openModal(`
    <h3>标签颜色</h3>
    <div class="m-sub">给「${esc(tag.name)}」选一个颜色，标签在侧栏和正文里都会用它着色。</div>
    <div class="m-body">
      <div class="swatches" style="margin-top:0">${swatches}
        <span class="swatch-wrap"><input type="color" id="tagColorPicker" value="${esc(tag.color || '#e2644c')}"></span>
      </div>
    </div>
    <div class="m-actions">
      <button class="ghost-btn" id="tagColorClear">清除颜色</button>
      <button class="ghost-btn" data-close>取消</button>
      <button class="primary-btn" id="tagColorOk">保存</button>
    </div>`, (card) => {
    let picked = tag.color || '';
    const picker = card.querySelector('#tagColorPicker');
    card.querySelectorAll('[data-color]').forEach((b) => {
      b.addEventListener('click', () => {
        picked = b.dataset.color;
        picker.value = picked;
        card.querySelectorAll('[data-color]').forEach((x) => x.classList.toggle('active', x === b));
      });
    });
    picker.addEventListener('input', () => { picked = picker.value; });
    card.querySelector('#tagColorClear').addEventListener('click', async () => {
      try {
        await api('tags/update', { method: 'POST', body: { name: tag.name, color: '' } });
        closeModal();
        await loadData();
        toast('已清除颜色');
      } catch (err) { toast(err.message, true); }
    });
    card.querySelector('#tagColorOk').addEventListener('click', async () => {
      try {
        await api('tags/update', { method: 'POST', body: { name: tag.name, color: picked } });
        closeModal();
        await loadData();
        toast('颜色已更新');
      } catch (err) { toast(err.message, true); }
    });
  });
}

function renameTagModal(tag) {
  promptModal({
    title: '重命名标签',
    sub: '用到这个标签的片段会一起更新。',
    value: tag.name,
    placeholder: '标签名称',
    okText: '保存',
    onOk: async (name) => {
      await api('tags/update', { method: 'POST', body: { name: tag.name, newName: name } });
      if (state.view.type === 'tag' && state.view.id === tag.name) state.view = { type: 'tag', id: name };
      await loadData();
      toast('标签已重命名');
    },
  });
}

function deleteTagModal(tag) {
  confirmModal({
    title: '删除标签',
    sub: `确定删除标签「${esc(tag.name)}」？它会从 ${tag.count} 篇内容上移除，正文和附件不受影响。`,
    okText: '删除',
    danger: true,
    onOk: async () => {
      await api('tags/delete', { method: 'POST', body: { name: tag.name } });
      if (state.view.type === 'tag' && state.view.id === tag.name) state.view = { type: 'all', id: null };
      await loadData();
      toast('标签已删除');
    },
  });
}

$('#ctxMenu').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const act = btn.dataset.act;
  const target = ctxTarget;
  closeCtx();
  if (!target) { if (act === 'new') newFolder(); return; }

  if (target.type === 'tag') {
    if (act === 'rename') renameTagModal(target.item);
    else if (act === 'delete') deleteTagModal(target.item);
    else if (act === 'tagcolor') tagColorModal(target.item);
    return;
  }

  if (target.type === 'doc') {
    if (act === 'delete') trashDoc(target.item);
    else if (act === 'pin') setPinned(target.item, !target.item.pinned);
    else if (act === 'move') moveDocModal(target.item);
    return;
  }

  if (target.type === 'trash') {
    if (act === 'restore') {
      try { await restoreDoc(target.item); } catch (err) { toast(err.message, true); }
    } else if (act === 'purge') purgeDoc(target.item);
    return;
  }

  const folder = target.item;
  if (act === 'new') { newFolder(); return; }
  if (act === 'rename') {
    promptModal({
      title: '重命名文件夹',
      sub: '修改后文件夹内的片段不会受影响。',
      value: folder.name,
      placeholder: '文件夹名称',
      okText: '保存',
      onOk: async (name) => {
        await api('folders/' + folder.id, { method: 'PUT', body: { name } });
        await loadData();
        toast('已重命名');
      },
    });
  } else if (act === 'delete') {
    confirmModal({
      title: '删除文件夹',
      sub: `确定删除「${esc(folder.name)}」？其中的 ${folder.count} 条片段会移到废纸篓，需要时可以恢复。`,
      okText: '删除',
      danger: true,
      onOk: async () => {
        await api('folders/' + folder.id, { method: 'DELETE' });
        if (state.view.type === 'folder' && state.view.id === folder.id) state.view = { type: 'all', id: null };
        state.currentId = null;
        state.doc = null;
        await loadData();
        toast('文件夹已删除');
      },
    });
  }
});

document.addEventListener('click', (e) => {
  if (!$('#ctxMenu').hidden && !e.target.closest('#ctxMenu')) closeCtx();
});
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('[data-folder]') || e.target.closest('.doc-item') || e.target.closest('[data-tag-name]')) return;
  closeCtx();
});
window.addEventListener('resize', closeCtx);

/* ---------- 新建片段 ---------- */
/* ---------- 新建片段 ---------- */
async function createDocIn(folderId) {
  try {
    const d = await api('docs', { method: 'POST', body: { folderId, title: '未命名片段' } });
    await loadData();
    await openDoc(d.id);
    startEdit();
    $('#docTitle').select();
  } catch (err) { toast(err.message, true); }
}

function newDoc() {
  const folderId = state.view.type === 'folder' ? state.view.id : (state.folders[0] && state.folders[0].id);
  if (!folderId) {
    // 还没有任何文件夹：直接弹「新建文件夹」，建完接着写这第一条片段
    promptNewFolder({
      sub: '给这个文件夹起个名字，比如「代码仓库」「运维备忘」。',
      okText: '创建并开始写',
      after: async (f) => {
        await loadData();
        await createDocIn(f.id);
      },
    });
    return;
  }
  createDocIn(folderId);
}

$('#btnNewDoc').addEventListener('click', newDoc);
$('#folderEmpty').addEventListener('click', () => promptNewFolder());

/* ---------- 修改片段所属文件夹 ---------- */
function moveDocModal(d) {
  const cur = d.folderId;
  const icon = '<svg viewBox="0 0 24 24" class="ic"><path d="M4 7.2A1.6 1.6 0 0 1 5.6 5.6h3.5l1.8 1.8h7.5A1.6 1.6 0 0 1 20 9v8.2a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 17.2z"/></svg>';
  const rows = state.folders.map((f) => `
    <button class="pick-row${f.id === cur ? ' active' : ''}" data-fid="${f.id}">
      ${icon}<span>${esc(f.name)}</span>${f.id === cur ? '<em>当前</em>' : ''}
    </button>`).join('');
  openModal(`
    <h3>修改文件夹</h3>
    <div class="m-sub">把「${esc(d.title || '未命名片段')}」移到另一个文件夹。</div>
    <div class="pick-list">${rows || '<div class="pick-empty">还没有文件夹</div>'}</div>
    <div class="m-actions"><button class="ghost-btn" data-close>取消</button></div>`, (card) => {
    card.querySelectorAll('[data-fid]').forEach((b) => {
      b.addEventListener('click', async () => {
        const fid = b.dataset.fid;
        if (fid === cur) { closeModal(); return; }
        b.disabled = true;
        try {
          await api('docs/' + d.id, { method: 'PUT', body: { folderId: fid } });
          if (state.doc && state.doc.id === d.id) state.doc.folderId = fid;
          await loadData();
          closeModal();
          toast('已移到「' + folderName(fid) + '」');
        } catch (err) {
          toast(err.message, true);
          b.disabled = false;
        }
      });
    });
  });
}

/* ---------- 弹窗 ---------- */
const modal = $('#modal');
function openModal(html, mount) {
  $('#modalCard').innerHTML = html;
  modal.hidden = false;
  const close = $('#modalCard [data-close]');
  if (close) close.addEventListener('click', closeModal);
  if (mount) mount($('#modalCard'));
}
function closeModal() { modal.hidden = true; $('#modalCard').innerHTML = ''; hideHelp(0); }
modal.querySelector('.modal-mask').addEventListener('click', closeModal);

function promptModal({ title, sub, value = '', placeholder = '', okText = '确定', onOk }) {
  openModal(`
    <h3>${esc(title)}</h3>
    <div class="m-sub">${sub || ''}</div>
    <div class="m-body"><input class="input" id="mInput" value="${esc(value)}" placeholder="${esc(placeholder)}" spellcheck="false"></div>
    <div class="m-actions">
      <button class="ghost-btn" data-close>取消</button>
      <button class="primary-btn" id="mOk">${esc(okText)}</button>
    </div>`, (card) => {
    const input = card.querySelector('#mInput');
    const ok = card.querySelector('#mOk');
    input.focus();
    input.select();
    const submit = async () => {
      const v = input.value.trim();
      if (!v) { input.focus(); return; }
      ok.disabled = true;
      try { await onOk(v); closeModal(); } catch (err) { toast(err.message, true); ok.disabled = false; }
    };
    ok.addEventListener('click', submit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  });
}

function confirmModal({ title, sub, okText = '确定', danger = false, onOk }) {
  openModal(`
    <h3>${esc(title)}</h3>
    <div class="m-sub">${sub || ''}</div>
    <div class="m-actions">
      <button class="ghost-btn" data-close>取消</button>
      <button class="${danger ? 'danger-btn' : 'primary-btn'}" id="mOk">${esc(okText)}</button>
    </div>`, (card) => {
    const ok = card.querySelector('#mOk');
    ok.addEventListener('click', async () => {
      ok.disabled = true;
      try { await onOk(); closeModal(); } catch (err) { toast(err.message, true); ok.disabled = false; }
    });
  });
}

/* ---------- 应用设置 ---------- */
function settingsHTML() {
  const a = state.app || {};
  const swatches = ACCENT_PRESETS.map((c) =>
    `<button class="swatch" data-accent="${c}" style="background:${c};color:${c}" title="${c}"></button>`).join('');
  const codeThemes = CODE_THEMES.map((t) =>
    `<button class="code-swatch" data-code="${t.id}" title="${esc(t.name)}">
      <i style="background:var(--hl-key)"></i><i style="background:var(--hl-str)"></i><i style="background:var(--hl-fn)"></i>
    </button>`).join('');
  return `
    <div class="modal-head">
      <h3>应用设置</h3>
      <div class="head-actions">
        <button class="help-btn" id="btnHelp" type="button" aria-label="使用说明" title="使用说明">FAQ</button>
        <button class="primary-btn head-done" data-close>保存</button>
      </div>
    </div>

    <div class="set-card">
      <div class="card-title">外观主题</div>
      <div class="theme-row">
        <button class="theme-card" data-mode="dark"><div class="theme-preview dark"></div>暗色</button>
        <button class="theme-card" data-mode="light"><div class="theme-preview light"></div>亮色</button>
      </div>
      <div class="opt-divider"></div>
      <div class="opt-row">
        <span class="opt-label">主题着色</span>
        <div class="swatches">
          ${swatches}
          <span class="swatch-wrap" title="自定义颜色"><input type="color" id="accentPicker" value="${esc(state.theme.accent)}"></span>
        </div>
      </div>
      <div class="opt-divider"></div>
      <div class="opt-row">
        <span class="opt-label">代码配色</span>
        <div class="code-themes">${codeThemes}</div>
      </div>
      <div class="opt-divider"></div>
      <div class="opt-row">
        <span class="opt-label">字体风格</span>
        <div class="seg-row">
          <button class="seg-btn" data-font="system">常规</button>
          <button class="seg-btn" data-font="song">宋体</button>
        </div>
      </div>
      <div class="opt-divider"></div>
      <div class="opt-row">
        <span class="opt-label">正文字号</span>
        <div class="stepper">
          <button class="step-btn" id="scaleMinus" title="缩小正文">−</button>
          <span class="step-val" id="scaleVal">100%</span>
          <button class="step-btn" id="scalePlus" title="放大正文">＋</button>
        </div>
      </div>
    </div>

    <div class="set-card">
      <button class="card-title card-toggle" id="backupToggle" type="button" aria-expanded="false" aria-controls="dangerRow">
        <span>数据备份</span>
        <svg viewBox="0 0 24 24" class="ic"><path d="m7.5 10 4.5 4.5L16.5 10"/></svg>
      </button>
      <div class="setting-row">
        <span class="k">备份数据</span>
        <span class="v"><button class="ghost-btn mini" id="btnExport">下载</button></span>
      </div>
      <div class="setting-row" id="restoreRow">
        <span class="k">导入数据</span>
        <span class="v"><button class="ghost-btn mini" id="btnImport">导入</button></span>
      </div>
      <div class="setting-row" id="dangerRow" hidden>
        <span class="k">抹除数据</span>
        <span class="v"><button class="danger-btn mini" id="btnReset">抹除</button></span>
      </div>
    </div>

    <div class="set-card">
      <button class="card-title card-toggle" id="pwToggle" type="button" aria-expanded="false" aria-controls="pwBody">
        <span>密码修改</span>
        <svg viewBox="0 0 24 24" class="ic"><path d="m7.5 10 4.5 4.5L16.5 10"/></svg>
      </button>
      <div class="pw-body" id="pwBody" hidden>
        <div class="pw-form">
          <input class="input" id="pwOld" type="password" placeholder="当前密码" autocomplete="off">
          <input class="input" id="pwNew" type="password" placeholder="新密码（至少 4 位）" autocomplete="off">
          <button class="ghost-btn full-btn" id="pwSave">修改密码</button>
        </div>
        <div class="setting-row" style="border-bottom:0; padding-bottom:0">
          <span class="k">恢复码 <em class="rc-state">${state.hasRecovery ? '已设置' : '未设置'}</em></span>
          <span class="v"><button class="ghost-btn mini" id="btnRecovery">生成恢复码</button></span>
        </div>
      </div>
    </div>
`;
}

function refreshThemeUI(card) {
  card.querySelectorAll('[data-mode]').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === state.theme.mode);
  });
  const scaleVal = card.querySelector('#scaleVal');
  if (scaleVal) {
    const cur = clampScale(state.theme.scale);
    scaleVal.textContent = Math.round(cur * 100) + '%';
    card.querySelector('#scaleMinus').disabled = cur <= SCALE_MIN + 0.001;
    card.querySelector('#scalePlus').disabled = cur >= SCALE_MAX - 0.001;
  }
  card.querySelectorAll('[data-font]').forEach((b) => {
    const cur = state.theme.font || 'system';
    b.classList.toggle('active', b.dataset.font === cur);
  });
  card.querySelectorAll('[data-accent]').forEach((b) => {
    b.classList.toggle('active', b.dataset.accent.toLowerCase() === state.theme.accent.toLowerCase());
  });
  card.querySelectorAll('[data-code]').forEach((b) => {
    b.classList.toggle('active', b.dataset.code === normalizeCodeTheme(state.theme.code));
  });
  const picker = card.querySelector('#accentPicker');
  if (picker) picker.value = state.theme.accent;
}

/* ---------- 应用设置：使用说明浮层 ---------- */
let helpEl = null;
let helpTimer = null;

function helpHTML() {
  const a = state.app || {};
  const siteURL = a.site || 'https://github.com/HUiTHEME/SnippetHub_TOS';
  const tip = (title, text) => `
    <div class="hp-tip"><b>${title}</b><p>${text}</p></div>`;
  return `
    <div class="hp-head">
      <div class="hp-logo">${logoHTML()}</div>
      <div class="hp-id">
        <b>${esc(a.nameZh || '片段HUB')}</b>
        <a class="hp-dev" href="${esc(siteURL)}" target="_blank" rel="noopener">
          应用开发：${esc(a.author || '疯狂的大叔')}
          <svg viewBox="0 0 24 24" class="ic hp-link-ic"><path d="M9 15l6-6"/><path d="M10.6 6.4h6a1 1 0 0 1 1 1v6"/></svg>
        </a>
      </div>
    </div>
    <div class="hp-sec hp-tips">
      ${tip('请做好数据备份', '该应用部署在NAS里，理应具备了数据安全性，但还是建议隔段时间备份一下数据(应用设置有此功能)，把备份压缩包存到另一块硬盘或网盘里。')}
      ${tip('收好您的恢复码', '当您忘记密码时，重置密码的唯一渠道就是使用恢复码来重置，恢复码只在生成时显示一次，请抄下来离线保存。')}
      ${tip('陌生设备记得退出登录', '在陌生的电脑或手机上验证密码进入后，用完记得点左下角的退出登录，别把访问状态留在那台设备上。')}
      ${tip('移至篓误可还原', '删除的内容会先移到废纸篓里，在废纸篓里再被删除才会真正消失。')}
      ${tip('数据格式通用', '每一篇内容的本质就是markdown文档，备份的压缩包里也有每个片段的.md格式的文件存在，用任何编辑器都能打开，格式通用。')}
    </div>
    <div class="hp-foot">注重数据安全 · 愿片段HUB能一直陪着你</div>`;
}

function showHelp(anchor) {
  clearTimeout(helpTimer);
  if (!helpEl) {
    helpEl = document.createElement('div');
    helpEl.className = 'help-pop';
    helpEl.innerHTML = helpHTML();
    document.body.appendChild(helpEl);
    helpEl.addEventListener('mouseenter', () => clearTimeout(helpTimer));
    helpEl.addEventListener('mouseleave', () => hideHelp(200));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && helpEl && !helpEl.hidden) { e.stopPropagation(); hideHelp(0); }
    }, true);
    document.addEventListener('click', (e) => {
      if (!helpEl || helpEl.hidden) return;
      if (helpEl.contains(e.target) || e.target.closest('#btnHelp')) return;
      hideHelp(0);
    });
    window.addEventListener('resize', () => hideHelp(0));
  }
  helpEl.hidden = false;
  anchor.classList.add('on');

  // 在页面正中间显示
  const pad = 14;
  const w = helpEl.offsetWidth;
  const h = helpEl.offsetHeight;
  const left = Math.max(pad, (window.innerWidth - w) / 2);
  const top = Math.max(pad, (window.innerHeight - h) / 2);
  helpEl.style.left = Math.round(left) + 'px';
  helpEl.style.top = Math.round(top) + 'px';
}

function hideHelp(delay = 0) {
  if (!helpEl) return;
  clearTimeout(helpTimer);
  const btn = $('#btnHelp');
  const run = () => {
    if (!helpEl) return;
    helpEl.hidden = true;
    if (btn) btn.classList.remove('on');
  };
  if (delay > 0) helpTimer = setTimeout(run, delay);
  else run();
}

$('#btnSettings').addEventListener('click', () => {
  openModal(settingsHTML(), (card) => {
    refreshThemeUI(card);

    // 使用说明：悬停展开，点击也可展开（手机端没有 hover）
    const helpBtn = card.querySelector('#btnHelp');
    if (helpBtn) {
      helpBtn.addEventListener('mouseenter', () => showHelp(helpBtn));
      helpBtn.addEventListener('mouseleave', () => hideHelp(220));
      helpBtn.addEventListener('focus', () => showHelp(helpBtn));
      helpBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        showHelp(helpBtn);
      });
    }

    card.querySelectorAll('[data-mode]').forEach((b) => {
      b.addEventListener('click', () => {
        state.theme.mode = b.dataset.mode;
        applyTheme(true);
        refreshThemeUI(card);
      });
    });
    card.querySelectorAll('[data-accent]').forEach((b) => {
      b.addEventListener('click', () => {
        state.theme.accent = b.dataset.accent;
        applyTheme(true);
        refreshThemeUI(card);
      });
    });
    card.querySelectorAll('.code-swatch').forEach((b) => {
      b.addEventListener('click', () => {
        state.theme.code = normalizeCodeTheme(b.dataset.code);
        applyTheme(true); // 只改变量，已渲染的代码块会立刻换色，不用重绘
        refreshThemeUI(card);
      });
    });
    const stepScale = (delta) => {
      state.theme.scale = clampScale((state.theme.scale || 1) + delta);
      applyTheme(true);
      refreshThemeUI(card);
    };
    card.querySelector('#scaleMinus').addEventListener('click', () => stepScale(-SCALE_STEP));
    card.querySelector('#scalePlus').addEventListener('click', () => stepScale(SCALE_STEP));

    card.querySelectorAll('[data-font]').forEach((b) => {
      b.addEventListener('click', () => {
        state.theme.font = b.dataset.font;
        applyTheme(true);
        refreshThemeUI(card);
      });
    });
    const picker = card.querySelector('#accentPicker');
    if (picker) {
      picker.addEventListener('input', () => {
        state.theme.accent = picker.value;
        applyTheme(true);
        refreshThemeUI(card);
      });
    }

    card.querySelector('#btnReset').addEventListener('click', () => {
      closeModal();
      resetAllModal();
    });

    const pwToggle = card.querySelector('#pwToggle');
    const pwBody = card.querySelector('#pwBody');
    if (pwToggle && pwBody) {
      pwToggle.addEventListener('click', () => {
        const willOpen = pwToggle.getAttribute('aria-expanded') !== 'true';
        pwToggle.setAttribute('aria-expanded', String(willOpen));
        pwBody.hidden = !willOpen;
        if (willOpen) {
          pwBody.classList.remove('in');
          void pwBody.offsetWidth;
          pwBody.classList.add('in');
        }
      });
    }

    const backupToggle = card.querySelector('#backupToggle');
    const dangerRow = card.querySelector('#dangerRow');
    if (backupToggle && dangerRow) {
      const restoreRow = card.querySelector('#restoreRow');
      const applyDanger = (open) => {
        backupToggle.setAttribute('aria-expanded', String(open));
        dangerRow.hidden = !open;
        // 收起时「恢复数据」是卡片最后一行，去掉它的下边线
        if (restoreRow) restoreRow.classList.toggle('nb', !open);
      };
      applyDanger(false); // 危险项默认收起
      backupToggle.addEventListener('click', () => {
        const willOpen = backupToggle.getAttribute('aria-expanded') !== 'true';
        applyDanger(willOpen);
        if (willOpen) {
          dangerRow.classList.remove('in');
          void dangerRow.offsetWidth;
          dangerRow.classList.add('in');
        }
      });
    }

    const btnRecovery = card.querySelector('#btnRecovery');
    if (btnRecovery) {
      btnRecovery.addEventListener('click', async () => {
        btnRecovery.disabled = true;
        try {
          const res = await api('recovery/rotate', { method: 'POST' });
          state.hasRecovery = true;
          closeModal();
          await showRecoveryCode(res.code);
          toast('新恢复码已生成，请妥善保存');
        } catch (err) {
          toast(err.message, true);
          btnRecovery.disabled = false;
        }
      });
    }

    card.querySelector('#btnExport').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      toast('正在打包备份，稍等片刻…');
      try {
        await downloadViaApi('api/export');
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
      }
    });

    card.querySelector('#btnImport').addEventListener('click', () => {
      importGuideModal();
    });

    card.querySelector('#pwSave').addEventListener('click', async (e) => {
      const oldPw = card.querySelector('#pwOld').value;
      const newPw = card.querySelector('#pwNew').value;
      if (!oldPw || !newPw) { toast('请填写当前密码和新密码', true); return; }
      e.target.disabled = true;
      try {
        await api('password', { method: 'POST', body: { old: oldPw, new: newPw } });
        card.querySelector('#pwOld').value = '';
        card.querySelector('#pwNew').value = '';
        toast('密码已更新');
      } catch (err) { toast(err.message, true); }
      e.target.disabled = false;
    });

  });
});

/* ---------- 退出登录 ---------- */
$('#btnLogout').addEventListener('click', () => {
  confirmModal({
    title: '退出登录',
    sub: '退出后需要重新输入访问密码才能进入，数据不受影响。',
    okText: '退出登录',
    danger: true,
    onOk: async () => {
      try { await api('logout', { method: 'POST' }); } catch (e) { /* ignore */ }
      state.authed = false;
      state.currentId = null;
      state.doc = null;
      state.view = { type: 'all', id: null };
      $('#tagPop').hidden = true;
      showGate(true);
      toast('已退出登录');
    },
  });
});

/* ---------- 导入备份 ---------- */
/* ---------- 导入数据：引导（备份包 / 已有文档 两种方式）→ 选择 zip → 确认 → 写入 ---------- */
let importMode = 'backup'; // backup = 通过系统备份包恢复（默认）｜ md = 通过已有文档导入

const IMP_MODE_DETAIL = {
  backup: () => '',
  md: () => `
    <pre class="imp-tree">压缩包.zip
├─ AAA文件夹
│   ├─ abc.md
│   └─ def.md
└─ BBB文件夹
    ├─ ghi.md
    └─ jkl.md</pre>
    <ul class="imp-tips">
      <li>只支持导入<b>.md</b>格式的文档，图片及附件无法导入进来</li>
      <li>如果文件夹已存在会自动合并</li>
      <li>不会覆盖已有文档内容，标题重名会自动追加<b>(2)</b>序号</li>
    </ul>`,
};

const IMP_MODE_PICK = { backup: '选择备份包', md: '选择文档压缩包' };

function importGuideModal() {
  importMode = 'backup';
  openModal(`
    <h3 class="imp-title">导入数据</h3>
    <div class="imp-modes">
      <button class="imp-mode on" data-mode="backup">
        <span class="imp-mode-t">通过备份包恢复</span>
        <span class="imp-mode-d">通过「应用设置 - 备份数据」下载的备份包来恢复数据。</span>
      </button>
      <button class="imp-mode" data-mode="md">
        <span class="imp-mode-t">通过已有文档导入</span>
        <span class="imp-mode-d">按照格式要求，整理好文件夹和文档，打包zip导入数据。</span>
      </button>
    </div>
    <div class="imp-detail" id="impDetail">${IMP_MODE_DETAIL.backup()}</div>
    <div class="m-actions">
      <button class="ghost-btn" data-close>取消</button>
      <button class="primary-btn" id="impPick">${IMP_MODE_PICK.backup}</button>
    </div>`, (card) => {
    const detail = card.querySelector('#impDetail');
    const pickBtn = card.querySelector('#impPick');
    card.querySelectorAll('.imp-mode').forEach((btn) => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        if (mode === importMode) return;
        importMode = mode;
        card.querySelectorAll('.imp-mode').forEach((x) => x.classList.toggle('on', x === btn));
        detail.innerHTML = IMP_MODE_DETAIL[mode]();
        detail.classList.remove('imp-in');
        void detail.offsetWidth; // 强制回流，让淡入动画重新播放
        detail.classList.add('imp-in');
        pickBtn.textContent = IMP_MODE_PICK[mode];
      });
    });
    pickBtn.addEventListener('click', () => {
      closeModal();
      $('#importPicker').click();
    });
  });
}

function mdImportModal(file, info) {
  const names = (info.names || []).map(esc);
  const more = (info.folders || 0) > names.length ? ' 等' : '';
  const total = info.docs + (info.skipped || 0);
  openModal(`
    <h3>确认导入</h3>
    <div class="m-sub">已选择 <b>${esc(file.name)}</b>（${fmtSize(info.bytes)}）</div>
    <div class="imp-sum">
      <div><b>${info.docs}</b>篇 Markdown</div>
      <div><b>${info.folders}</b>个文件夹</div>
    </div>
    ${names.length ? `<div class="m-sub" style="margin-top:11px">${names.join('、')}${more}</div>` : ''}
    ${importMode === 'backup' ? `<div class="m-sub" style="margin-top:11px">这个压缩包里没有找到备份信息，将按「通过已有文档导入」的方式处理。</div>` : ''}
    ${info.skipped ? `<div class="m-sub">压缩包里共 ${total} 个文件，其中 ${info.skipped} 个不是 .md，会跳过。</div>` : ''}
    ${info.fixed ? `<div class="m-sub">有 ${info.fixed} 个文件名是 GBK 编码（Windows 旧压缩工具常见），已自动转成正常中文。</div>` : ''}
    ${info.badName ? `<div class="m-sub">另有 ${info.badName} 个文件名的编码实在认不出来，已跳过。</div>` : ''}
    <div class="m-actions">
      <button class="ghost-btn" data-close>取消</button>
      <button class="primary-btn" id="impGo">开始导入</button>
    </div>`, (card) => {
    const btn = card.querySelector('#impGo');
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '正在导入…';
      try {
        const res = await api('import/apply?token=' + encodeURIComponent(info.token) + '&mode=merge', { method: 'POST' });
        closeModal();
        state.view = { type: 'all', id: null };
        state.currentId = null;
        state.doc = null;
        await loadData();
        const extra = res.skipped ? `，跳过 ${res.skipped} 个` : '';
        toast(`导入完成：${res.docs} 篇文档、新建 ${res.folders} 个文件夹${extra}`);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = '开始导入';
        toast(err.message, true);
      }
    });
  });
}

function backupImportModal(file, info) {
  openModal(`
    <h3>导入备份</h3>
    <div class="m-sub">已选择 <b>${esc(file.name)}</b>（${fmtSize(info.bytes)}），含 ${info.folders} 个文件夹、${info.docs} 篇片段。<br><br>
      ${importMode === 'md' ? '检测到这是本应用导出的备份包，将按备份方式导入。<br><br>' : ''}
      <b>合并</b>：保留现有内容，把备份里的文件夹与片段追加进来，同名文件夹自动合并。<br>
      <b>覆盖</b>：先清空现有片段与文件夹，再导入备份内容。访问密码不受影响。
    </div>
    <div class="m-actions">
      <button class="ghost-btn" data-close>取消</button>
      <button class="ghost-btn" id="impMerge">合并导入</button>
      <button class="danger-btn" id="impReplace">覆盖导入</button>
    </div>`, (card) => {
    const run = async (mode) => {
      closeModal();
      toast('正在导入，请不要关闭页面…');
      try {
        const res = await api('import/apply?token=' + encodeURIComponent(info.token) + '&mode=' + mode, { method: 'POST' });
        state.view = { type: 'all', id: null };
        state.currentId = null;
        state.doc = null;
        await loadData();
        toast(`导入完成：${res.folders} 个文件夹、${res.docs} 篇片段、${res.attachments} 个附件`);
      } catch (err) { toast(err.message, true); }
    };
    card.querySelector('#impMerge').addEventListener('click', () => run('merge'));
    card.querySelector('#impReplace').addEventListener('click', () => run('replace'));
  });
}

$('#importPicker').addEventListener('change', async (e) => {
  const file = (e.target.files || [])[0];
  e.target.value = '';
  if (!file) return;
  if (!/\.zip$/i.test(file.name)) { toast('请选择 .zip 压缩包', true); return; }
  toast('正在读取压缩包…');
  let info;
  try {
    const fd = new FormData();
    fd.append('file', file, file.name);
    info = await api('import/inspect', { method: 'POST', body: fd });
  } catch (err) {
    toast(err.message, true);
    return;
  }
  if (info.kind === 'backup') backupImportModal(file, info);
  else mdImportModal(file, info);
});

/* ---------- 快捷键 ---------- */
document.addEventListener('keydown', (e) => {
  const meta = e.metaKey || e.ctrlKey;
  if (meta && e.key.toLowerCase() === 's') {
    if (state.editing) { e.preventDefault(); saveDoc(); }
  }
  if (e.key === 'Escape') {
    if (!modal.hidden) { closeModal(); return; }
    if (!$('#tagPop').hidden) { closeTagPop(); return; }
    if (!$('#ctxMenu').hidden) { closeCtx(); return; }
    if (state.editing) {
      if (state.dirty) { saveDoc().then((ok) => ok && stopEdit()); }
      else stopEdit();
    }
  }
});

/* ---------- 极简 Markdown ---------- */
// 只放行安全协议：挡掉 javascript:、data:text/html 这类能执行脚本的伪协议。
// （正文里可能贴别人的笔记，不能默认它可信）
function safeUrl(raw, forImage) {
  const u = String(raw || '').trim();
  if (!u) return '';
  if (/^(https?:|mailto:|tel:)/i.test(u)) return u;
  if (forImage && /^data:image\/(png|jpe?g|gif|webp|avif|bmp);/i.test(u)) return u;
  if (/^(#|\/|\.\/|\.\.\/)/.test(u)) return u; // 站内绝对路径、相对路径、锚点
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return u; // 无协议（如 //host/a.png）
  return '';
}

function inlineMd(s) {
  const codes = [];
  s = s.replace(/`([^`]+)`/g, (m, c) => {
    codes.push(c);
    return '\u0000' + (codes.length - 1) + '\u0000';
  });
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => {
    const u = safeUrl(url, true);
    return u ? `<img src="${u}" alt="${alt}" loading="lazy">` : alt;
  });
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => {
    const u = safeUrl(url, false);
    return u ? `<a href="${u}" target="_blank" rel="noreferrer noopener">${text}</a>` : text;
  });
  s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => '<code>' + esc(codes[+i]) + '</code>');
  return s;
}

// 语法着色：语言已知就按语言高亮，未知则自动识别；没加载到库时退回纯转义
function highlightCode(code, lang) {
  const hl = window.hljs;
  if (!hl) return esc(code);
  try {
    const l = String(lang || '').trim().toLowerCase();
    if (l && hl.getLanguage(l)) {
      return hl.highlight(code, { language: l, ignoreIllegals: true }).value;
    }
    if (code.length <= 20000) {
      return hl.highlightAuto(code).value;
    }
  } catch (e) { /* 高亮失败就用原文 */ }
  return esc(code);
}

function codeBlock(code, lang) {
  const lines = code.split('\n');
  const nums = lines.map((_, i) => `<span>${i + 1}</span>`).join('');
  return `<div class="cb">
    <div class="cb-bar">
      <span class="cb-lang">${esc(lang || 'text')}</span>
      <button class="cb-copy" type="button" title="复制这段代码">
        <svg viewBox="0 0 24 24" class="ic" style="width:12px;height:12px"><rect x="9" y="9" width="11" height="11" rx="2.2"/><path d="M15 6.2A2.2 2.2 0 0 0 12.8 4H6.2A2.2 2.2 0 0 0 4 6.2v6.6A2.2 2.2 0 0 0 6.2 15"/></svg>
        <span>复制</span>
      </button>
    </div>
    <div class="cb-body">
      <div class="cb-nums">${nums}</div>
      <pre><code class="hljs">${highlightCode(code, lang)}</code></pre>
    </div>
  </div>`;
}

/* ---------- GFM 表格 ---------- */
function splitTableRow(line) {
  let s = String(line).trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = false; // 行内代码里的 | 不算分列
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '`') { inCode = !inCode; cur += ch; continue; }
    if (ch === '|' && !inCode) { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function isTableSep(line) {
  if (!line || !line.includes('-')) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

// 当前行 + 下一行是不是表格的开头（表头 + 分隔行）
function isTableStart(lines, i) {
  const line = lines[i];
  if (!line || !line.includes('|')) return false;
  const next = lines[i + 1];
  return !!next && isTableSep(next);
}

function tableHTML(head, seps, rows) {
  const alignOf = (c) => {
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    if (l && r) return 'center';
    if (r) return 'right';
    if (l) return 'left';
    return '';
  };
  const aligns = seps.map(alignOf);
  const cell = (tag, text, i) => {
    const a = aligns[i] ? ` style="text-align:${aligns[i]}"` : '';
    return `<${tag}${a}>${inlineMd(text || '')}</${tag}>`;
  };
  const th = head.map((c, i) => cell('th', c, i)).join('');
  const body = rows
    .map((r) => '<tr>' + head.map((_, i) => cell('td', r[i], i)).join('') + '</tr>')
    .join('');
  return `<div class="tbl"><table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table></div>`;
}

function markdown(src) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*```/.test(line)) {
      const lang = line.replace(/^\s*```/, '').trim();
      i++;
      const code = [];
      while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i++; }
      i++;
      out.push(codeBlock(code.join('\n'), lang));
      continue;
    }

    if (/^\s*$/.test(line)) { i++; continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lv = Math.min(h[1].length, 4);
      out.push(`<h${lv}>${inlineMd(h[2])}</h${lv}>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }

    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push('<blockquote>' + buf.map(inlineMd).join('<br>') + '</blockquote>');
      continue;
    }

    if (/^\s*([-*+])\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*([-*+])\s+/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*([-*+])\s+/, ''));
        i++;
      }
      out.push('<ul>' + buf.map((t) => `<li>${inlineMd(t)}</li>`).join('') + '</ul>');
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
        i++;
      }
      out.push('<ol>' + buf.map((t) => `<li>${inlineMd(t)}</li>`).join('') + '</ol>');
      continue;
    }

    if (isTableStart(lines, i)) {
      const head = splitTableRow(line);
      const seps = splitTableRow(lines[i + 1]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      out.push(tableHTML(head, seps, rows));
      continue;
    }

    const buf = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^\s*(#{1,6})\s+/.test(lines[i])
      && !/^\s*```/.test(lines[i]) && !/^\s*([-*+])\s+/.test(lines[i]) && !/^\s*\d+[.)]\s+/.test(lines[i])
      && !isTableStart(lines, i)) {
      buf.push(lines[i]);
      i++;
    }
    out.push('<p>' + buf.map(inlineMd).join('<br>') + '</p>');
  }

  return out.join('\n') || '<p style="color:var(--faint)">（这里还没有内容，点击右上角编辑开始记录）</p>';
}

/* ---------- 启动 ---------- */
// 启动画面淡出（下面已经摆好主界面或密码页）
function hideBoot() {
  const b = $('#boot');
  if (!b || b.hidden) return;
  b.classList.add('out');
  setTimeout(() => { b.hidden = true; }, 360);
}

(async function boot() {
  // 每个位置都要独立的渐变 / filter id：共用同一个 id 时，一旦第一份被隐藏（display:none），
  // url(#id) 引用就解析到那棵不渲染的树上，logo 会丢掉蓝色底和阴影，看起来像"显示不全"。
  const bootLogo = $('#bootLogo');
  if (bootLogo) bootLogo.innerHTML = logoHTML();
  $('#gateLogo').innerHTML = logoHTML();
  $('#brandLogo').innerHTML = logoHTML();

  const t0 = performance.now();
  let st = null;
  let err = null;
  try {
    st = await detectBase();
  } catch (e) {
    err = e;
  }
  // 启动画面至少停留 340ms：本机接口几十毫秒就返回，否则会"闪一下就跳过去"
  const left = 340 - (performance.now() - t0);
  if (left > 0) await new Promise((r) => setTimeout(r, left));

  if (st) {
    state.initialized = !!st.initialized;
    state.hasRecovery = !!st.hasRecovery;
    state.app = st.app;
    if (st.authed) {
      await enterApp(true); // 先加载数据，再缓缓浮出主界面
      hideBoot();
      return;
    }
    showGate(st.initialized); // 未解锁：先把密码页摆好，再让启动画面淡出
    hideBoot();
    return;
  }
  showConnectError(err ? err.message : '无法连接到应用服务');
  hideBoot();
})();
