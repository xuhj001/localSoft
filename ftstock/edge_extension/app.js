// 扩展窗口：左侧 iframe 是本地自选（站点自选弹窗铺满），右侧 iframe 是个股详情 / 市场行情。
// 两个 iframe 里的 page.js 通过 postMessage 收命令、发事件；行情、搜索在左侧页面里请求（同站、带 cookie）。
'use strict';

const BASE_URL = 'https://www.futunn.com';
const FUTU_ORIGIN = BASE_URL;
const WATCH_URL = BASE_URL + '/quote/us';
const PASSPORT_HOST = 'passport.futunn.com';
const DEFAULT_CODE = 'TSLA-US';
const AUTO_REFRESH_MS = 3000; // 站点自己每 60 秒轮询一次，这里额外按 3 秒触发它的刷新回调
const SLOW_REFRESH_MS = 60000; // 关掉快速刷新后，本地自选按站点的节奏刷新
const RATE_LIMIT_PAUSE_MS = 60000;
const LIST_WIDTH = 880; // 站点自选弹窗 .content 的原始宽度
const STOCK_PATH_RE = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(stock|etfs|futures|index|options|currency|crypto|sectors)\/([^/?#]+)/i;
const MARKET_PATH_RE = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?quote(?:\/|$)/i;

const $ = (id) => document.getElementById(id);
const ui = {
  back: $('back'), listMode: $('listMode'), localInput: $('localInput'),
  reload: $('reload'), auto: $('auto'), login: $('login'), verify: $('verify'),
  exportBtn: $('export'), importBtn: $('import'), importFile: $('importFile'),
  left: $('left'), splitter: $('splitter'), right: $('right'), message: $('message'), status: $('status'),
  config: $('config'), configPanel: $('configPanel'), configPath: $('configPath'),
  configCopy: $('configCopy'), configClose: $('configClose'),
};

const list = new FW.LocalWatchlist();
const frames = { watch: null, detail: null };
const states = { watch: {}, detail: {} };
const loadInfo = { watch: { at: 0, pending: false }, detail: { at: 0, pending: false } };
const loadFailures = { watch: 0, detail: 0 };
const wafRetries = { watch: 0, detail: 0 };
const seenBlocked = {};
let code = DEFAULT_CODE;
let detailPath = '/stock/' + DEFAULT_CODE;
let detailVisible = false;
let listMode = 'local'; // 左侧列表：local 本地自选 / hot 站点原样的热门自选（登录后为账号自选）
let peekWidth = 0; // 0 表示按页面里名称列的实际宽度
let watchStarted = false;
let localBusy = false;
let localRefreshedAt = 0;
let localBackoffUntil = 0;
let quoteCursor = 0;
let localInfoChecked = false;
let refreshPausedUntil = 0;
let blockStrikes = [];
let awaitingLogin = false;
let wasLogin = null;
let loginWindowId = null;

// ---------- 状态栏 ----------

let messageTimer = 0;
function showMessage(text, ms = 0) {
  ui.message.textContent = text;
  ui.message.title = text;
  clearTimeout(messageTimer);
  if (ms) messageTimer = setTimeout(() => { ui.message.textContent = ''; }, ms);
}

function isLogin() {
  return !!(Object.keys(states.detail).length ? states.detail : states.watch).isLogin;
}

function updateStatus() {
  const login = isLogin();
  ui.login.textContent = login ? '退出登录' : '登录';
  const uid = (Object.keys(states.detail).length ? states.detail : states.watch).uid || '';
  const shown = listMode === 'local' ? `本地自选 ${list.entries.length} 只` : login ? '账号自选' : '热门自选';
  const who = shown + (login ? ` · 已登录 uid ${uid}` : ' · 未登录');
  let where = '';
  if (detailVisible) {
    const path = states.detail.path || detailPath;
    where = MARKET_PATH_RE.test(path) ? '市场行情 ' + path : code;
  }
  ui.status.textContent = where ? `${who}  ·  ${where}` : who;
  document.title = (detailVisible && states.detail.title) || '富途牛牛';
}

// ---------- 和 iframe 通信 ----------

let seq = 0;
const pending = new Map();

function call(role, cmd, args, timeout = 5000) {
  const frame = frames[role];
  if (!frame || !frame.contentWindow) return Promise.reject(new Error('页面还没加载'));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('页面没有响应'));
    }, timeout);
    pending.set(id, { resolve, reject, timer, role });
    frame.contentWindow.postMessage({ fa: 1, id, cmd, args }, FUTU_ORIGIN);
  });
}

window.addEventListener('message', (e) => {
  const m = e.data;
  if (e.origin !== FUTU_ORIGIN || !m || m.fa !== 1) return;
  const role = Object.keys(frames).find((r) => frames[r] && frames[r].contentWindow === e.source);
  if (!role) return;
  if (m.re) {
    const p = pending.get(m.re);
    if (!p || p.role !== role) return;
    pending.delete(m.re);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.value);
    else p.reject(new Error(m.error));
    return;
  }
  onFrameEvent(role, m.ev, m.data);
});

function onFrameEvent(role, ev, data) {
  if (role === 'watch' && ev === 'open' && data && typeof data.path === 'string') {
    openPath(data.path, data.item && typeof data.item === 'object' ? data.item : null);
  } else if (role === 'watch' && ev === 'localDel') {
    setTimeout(() => removeLocal(String(data)), 0);
  } else if (role === 'watch' && ev === 'localMove') {
    reorderLocal(data);
  } else if (role === 'watch' && ev === 'hotChanged') {
    localBackoffUntil = 0;
    setTimeout(refreshListSoon, 500);
  } else if (ev === 'nav' && typeof data === 'string') {
    routeUrl(data);
  }
}

// ---------- iframe 加载 ----------

// 新建 iframe 时带着 src 插入，首次加载不进历史记录；之后的重载 / 恢复用 location.replace，
// 「←」只回退右侧主动打开过的页面
function createFrame(role, url) {
  const frame = document.createElement('iframe');
  frame.name = role === 'watch' ? 'fa-watch' : 'fa-detail';
  frame.id = role;
  frame.allow = 'clipboard-write';
  frame.src = url;
  frame.addEventListener('load', () => {
    loadInfo[role] = { at: Date.now(), pending: true };
  });
  frames[role] = frame;
  if (role === 'watch') {
    frame.style.width = watchFrameWidth();
    ui.left.appendChild(frame);
  } else {
    ui.right.appendChild(frame);
  }
}

function replaceFrame(role, url) {
  const frame = frames[role];
  if (!frame) return;
  states[role] = {};
  loadInfo[role] = { at: 0, pending: false };
  try {
    frame.contentWindow.location.replace(url);
  } catch (e) {
    frame.src = url;
  }
}

function loadDetail(url) {
  states.detail = {};
  frames.detail.src = url;
}

function startWatch() {
  if (watchStarted) return;
  watchStarted = true;
  createFrame('watch', WATCH_URL);
}

function detailUrl() {
  return BASE_URL + detailPath;
}

function recoverUrl(role) {
  if (role === 'watch') return WATCH_URL;
  const href = states.detail.href;
  try {
    const u = new URL(href);
    if (u.host === 'www.futunn.com' && (STOCK_PATH_RE.test(u.pathname) || MARKET_PATH_RE.test(u.pathname))) return href;
  } catch (e) { /* 没有可用的当前地址 */ }
  return detailUrl();
}

function reloadAll() {
  for (const role of Object.keys(frames)) {
    if (!frames[role]) continue;
    if (states[role].path === '/403' || !states[role].href) replaceFrame(role, recoverUrl(role));
    else call(role, 'reload').catch(() => replaceFrame(role, recoverUrl(role)));
  }
}

// 加载失败（断网、页面进程崩溃）后自动重新加载：3、6、12、24、30、30… 秒，网络恢复后自己回来
function scheduleRecover(role, reason) {
  const n = ++loadFailures[role];
  const delay = Math.min(3 * 2 ** (n - 1), 30);
  const name = role === 'watch' ? '左侧列表' : '右侧页面';
  showMessage(`${name}${reason}，${delay} 秒后自动重试`, delay * 1000);
  setTimeout(() => {
    if (loadFailures[role] !== n) return; // 期间已经加载成功，或者又失败过一次由那次负责
    replaceFrame(role, recoverUrl(role));
  }, delay * 1000);
}

// ---------- 布局：只看列表时左侧铺满窗口（列表内容仍按原宽度排版，滚动条在窗口最右侧）；
// 展开详情时左侧只露出名称列 ----------

function peek() {
  if (peekWidth) return peekWidth;
  const nameRight = states.watch.nameRight || 0;
  return nameRight > 80 ? Math.min(nameRight + 4, LIST_WIDTH) : 190;
}

function watchFrameWidth() {
  return detailVisible ? Math.max(LIST_WIDTH, ui.left.clientWidth) + 'px' : '100%';
}

function layout() {
  document.body.classList.toggle('list-only', !detailVisible);
  if (detailVisible) {
    const max = Math.max(document.body.clientWidth - 5 - 200, 60);
    ui.left.style.width = Math.min(peek(), max) + 'px';
  } else {
    ui.left.style.width = '';
  }
  ui.right.classList.toggle('detail', detailVisible);
  const local = listMode === 'local';
  ui.listMode.textContent = local ? '本地' : '热门';
  ui.listMode.classList.toggle('checked', !detailVisible);
  ui.listMode.title = detailVisible
    ? `收起右侧详情，回到${local ? '本地自选' : '热门自选'}`
    : local ? '当前：本地自选。点击切换到热门自选（登录后为账号里的自选）' : '当前：热门自选（登录后为账号里的自选）。点击切换到本地自选';
  if (frames.watch) frames.watch.style.width = watchFrameWidth();
}

// 切换列表就重新加载左侧页面：本地自选加载后推入本地条目，热门自选保持站点原样
function setListMode(mode) {
  if (mode !== listMode) {
    listMode = mode;
    localRefreshedAt = 0;
    chrome.storage.local.set({ listMode: mode });
    if (frames.watch) replaceFrame('watch', WATCH_URL);
  }
  showList();
}

function showList() {
  detailVisible = false;
  layout();
  updateStatus();
}

function showDetail() {
  if (!detailVisible) {
    detailVisible = true;
    layout();
    updateStatus();
  }
}

ui.splitter.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  ui.splitter.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
  const startX = e.clientX, startW = ui.left.clientWidth;
  const move = (ev) => {
    const w = startW + ev.clientX - startX;
    peekWidth = Math.max(w, 60);
    layout();
  };
  const up = () => {
    document.body.classList.remove('resizing');
    ui.splitter.removeEventListener('pointermove', move);
    ui.splitter.removeEventListener('pointerup', up);
    ui.splitter.removeEventListener('lostpointercapture', up);
  };
  ui.splitter.addEventListener('pointermove', move);
  ui.splitter.addEventListener('pointerup', up);
  ui.splitter.addEventListener('lostpointercapture', up);
});
window.addEventListener('resize', layout);

// ---------- 页面切换 ----------

function setDetail(m) {
  code = decodeURIComponent(m[2]).toUpperCase();
  detailPath = m[0];
}

// 在右侧打开个股。带着自选条目数据且右侧已是个股页时，走站点自己的 stockClick，不整页刷新。
async function openPath(path, item = null) {
  path = new URL(path, BASE_URL).pathname;
  const m = path.match(STOCK_PATH_RE);
  if (!m) return;
  setDetail(m);
  showDetail();
  updateStatus();
  const url = BASE_URL + path;
  if (!(item && states.detail.ready)) {
    loadDetail(url);
    return;
  }
  const ok = await call('detail', 'go', item).catch(() => false);
  if (!ok) loadDetail(url);
}

function routeUrl(href) {
  let url;
  try { url = new URL(href); } catch (e) { return; }
  if (url.host === PASSPORT_HOST) {
    showLogin();
  } else if (url.host === 'www.futunn.com' && STOCK_PATH_RE.test(url.pathname)) {
    openPath(url.pathname);
  } else if (url.host === 'www.futunn.com' && MARKET_PATH_RE.test(url.pathname)) {
    showDetail();
    loadDetail(url.href);
  } else if (/^https?:$/.test(url.protocol)) {
    chrome.tabs.create({ url: url.href });
  }
}

// ---------- 页面状态：每秒问一次两边的页面 ----------

async function pollState(role) {
  if (!frames[role] || !loadInfo[role].at) return; // 还没加载完，里面还不是 futunn 页面
  let state;
  try {
    state = await call(role, 'state', null, 1500);
  } catch (e) {
    const info = loadInfo[role];
    if (info.pending && Date.now() - info.at > 8000) {
      info.pending = false;
      states[role] = {};
      scheduleRecover(role, '加载失败');
    }
    return;
  }
  if (!state || typeof state !== 'object') return;
  if (loadInfo[role].pending) {
    loadInfo[role].pending = false;
    afterFutuLoad(role, state);
  } else {
    applyState(role, state);
  }
}

function afterFutuLoad(role, state) {
  loadFailures[role] = 0;
  if (state.waf) {
    // 首次访问没有 wafToken 时服务端直接返回 {"code":-12011}，重载即可放行
    if (wafRetries[role] < 6) {
      wafRetries[role] += 1;
      setTimeout(() => replaceFrame(role, recoverUrl(role)), 1000 * wafRetries[role]);
    }
    return;
  }
  wafRetries[role] = 0;
  applyState(role, state);
  checkLocalInfo();
  if (role === 'detail') {
    startWatch();
  } else {
    pushLocal();
    refreshListSoon();
  }
  // 从未登录变成已登录（登录窗口跳回、或其它方式登录）：还没刷新登录态的页面重新加载
  if (state.isLogin && (awaitingLogin || wasLogin === false)) {
    awaitingLogin = false;
    for (const other of Object.keys(frames)) {
      if (other !== role && frames[other] && !states[other].isLogin) replaceFrame(other, recoverUrl(other));
    }
    verify(false);
  }
  wasLogin = !!state.isLogin;
}

function applyState(role, state) {
  states[role] = state;
  if (state.loginRequested && !state.isLogin) setTimeout(showLogin, 0);
  if (role === 'detail') {
    const m = (state.path || '').match(STOCK_PATH_RE);
    if (m) setDetail(m);
  } else if (detailVisible && !peekWidth) {
    layout(); // 名称列宽度拿到之后再按它露出
  }
  if (state.path === '/403') {
    pauseRefresh();
    showMessage('被富途网关限流（访问频繁，跳到了 403 页），过几分钟后点「←」或「刷新」重试', 5000);
  } else if (state.blocked) {
    if (state.blockedAt !== seenBlocked[role]) {
      seenBlocked[role] = state.blockedAt;
      pauseRefresh();
    }
    if (Date.now() < refreshPausedUntil) {
      showMessage(`行情接口被富途网关限流（访问频繁），定时刷新暂停 ${RATE_LIMIT_PAUSE_MS / 1000} 秒；图表可能空白，稍后点「刷新」重试`, 5000);
    }
  }
  updateStatus();
}

setInterval(() => {
  pollState('watch');
  pollState('detail');
}, 1000);

// ---------- 定时刷新 ----------

// 30 秒内第二次被拦才暂停：冷启动时偶发一次拦截（还没拿到 wafToken）不算限流
function pauseRefresh() {
  const now = Date.now();
  if (now < refreshPausedUntil) return;
  blockStrikes = blockStrikes.filter((t) => now - t < 30000).concat(now);
  if (blockStrikes.length >= 2) {
    blockStrikes = [];
    refreshPausedUntil = now + RATE_LIMIT_PAUSE_MS;
  }
}

function autoRefresh() {
  const now = Date.now();
  if (document.hidden || now < refreshPausedUntil) return;
  if (!ui.auto.classList.contains('checked')) {
    if (now - localRefreshedAt >= SLOW_REFRESH_MS) refreshList();
    return;
  }
  if (detailVisible && states.detail.ready) call('detail', 'refresh').catch(() => {});
  refreshList();
}
setInterval(autoRefresh, AUTO_REFRESH_MS);

// ---------- 本地自选 ----------

const label = (e) => `${e.name}（${e.stockCode}.${e.marketLabel}）`;

function pushLocal() {
  if (frames.watch && listMode === 'local') call('watch', 'setLocal', list.entries).catch(() => {});
}

async function refreshLocalQuotes() {
  // 页面过了网关校验（拿到 wafToken cookie）之前直接调接口会被拦截
  const passed = states.watch.ready || states.detail.ready;
  if (listMode !== 'local' || localBusy || !passed || !frames.watch || !list.entries.length || Date.now() < localBackoffUntil) return;
  localBusy = true;
  localRefreshedAt = Date.now();
  try {
    const entries = list.entries.slice();
    const res = await FQ.fetchQuotes(entries, quoteCursor % entries.length);
    quoteCursor = res.next;
    const got = Object.keys(res.quotes).length;
    if (got) await call('watch', 'setQuotes', res.quotes).catch(() => {});
    if (res.blocked) {
      // 一轮里拿到一部分就只是请求太密，歇几秒接着轮；一只都没拿到才算被限流
      localBackoffUntil = Date.now() + 5000;
      if (!got) {
        showMessage(`本地自选：${res.error}`, 5000);
        pauseRefresh();
      }
    } else if (res.error) {
      showMessage(`本地自选：${res.error}`, 5000);
    }
  } finally {
    localBusy = false;
  }
}

// 热门自选（登录后为账号自选）：由扩展窗口请求整份列表推给左侧页面，页面里自己请求会被网关限流
async function refreshHot() {
  const passed = states.watch.ready || states.detail.ready;
  if (listMode !== 'hot' || localBusy || !passed || !frames.watch || Date.now() < localBackoffUntil) return;
  localBusy = true;
  localRefreshedAt = Date.now();
  try {
    const data = await FQ.fetchWatchList(isLogin());
    if (listMode !== 'hot') return;
    try {
      await call('watch', 'setHot', data);
    } catch (err) {
      // 扩展更新后没点「重新加载」：左侧页面里还是旧版 page.js，不认识 setHot
      if (/未知命令/.test(err.message)) showMessage('左侧页面脚本是旧版本：请在 edge://extensions 点本扩展的「重新加载」，再重新打开窗口');
      return;
    }
    if (!data.list.length) showMessage(isLogin() ? '账号自选是空的：富途账号里还没有自选股' : '热门自选没有返回数据，稍后自动重试', 6000);
  } catch (err) {
    localBackoffUntil = Date.now() + 5000;
    showMessage(`${isLogin() ? '账号自选' : '热门自选'}：${err.message}`, 5000);
    if (err instanceof FQ.Blocked) pauseRefresh();
  } finally {
    localBusy = false;
  }
}

function refreshList() {
  if (listMode === 'local') refreshLocalQuotes();
  else refreshHot();
}

// 左侧页面刚加载完 / 切换列表后马上要一次数据：上一轮还没跑完或在退避中时每秒重试，直到真正发出请求
function refreshListSoon(tries = 20) {
  const before = localRefreshedAt;
  refreshList();
  if (localRefreshedAt === before && tries > 0) setTimeout(() => refreshListSoon(tries - 1), 1000);
}

ui.localInput.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const text = ui.localInput.value.trim();
  if (!text) return;
  if (!states.watch.ready && !states.detail.ready) {
    showMessage('页面还在加载，稍后再添加', 4000);
    return;
  }
  ui.localInput.disabled = true;
  showMessage(`正在查找 ${text} ...`);
  let entry;
  try {
    entry = await FW.resolve((kw) => call(frames.watch ? 'watch' : 'detail', 'search', kw, 15000), text);
  } catch (err) {
    showMessage(err instanceof FW.StockNotFound ? err.message : `查找 ${text} 失败：${err.message}`, 6000);
    return;
  } finally {
    ui.localInput.disabled = false;
    ui.localInput.focus();
  }
  ui.localInput.value = '';
  try {
    const added = await list.add(entry);
    showMessage(added ? `已添加到本地自选：${label(entry)}` : `${label(entry)} 已在本地自选里`, 5000);
  } catch (err) {
    alert(`${label(entry)} 没有添加：${err.message}\n\n本地自选保持原样。`);
    return;
  }
  pushLocal();
  updateStatus();
  refreshLocalQuotes();
});

async function removeLocal(id) {
  const entry = list.find(id);
  if (!entry || !confirm(`从本地自选删除 ${label(entry)}？`)) return;
  try {
    await list.remove(id);
  } catch (err) {
    alert(`${label(entry)} 没有删除：${err.message}\n\n本地自选保持原样。`);
    return;
  }
  pushLocal();
  updateStatus();
}

// 无论成败都推一次，让页面和存储保持一致
async function reorderLocal(ids) {
  try {
    if (await list.reorder(ids)) showMessage('已调整本地自选顺序', 3000);
  } catch (err) {
    setTimeout(() => alert(`顺序没有保存：${err.message}\n\n本地自选保持原样，列表已恢复原来的顺序。`), 0);
  }
  pushLocal();
}

// 每次打开校对一次本地自选的代码、名称、证券类型（一个批量请求），防止股票改名、换代码后还显示旧的
async function checkLocalInfo() {
  if (localInfoChecked || !list.entries.length) return;
  localInfoChecked = true;
  const ids = list.entries.map((e) => e.stockId);
  let infos;
  try {
    infos = await FW.stockInfos(ids);
  } catch (e) {
    localInfoChecked = false; // 这次没查成，什么都不改，下次页面加载完再查
    return;
  }
  if (!infos.length) {
    localInfoChecked = false;
    return;
  }
  let result;
  try {
    result = await list.sync(infos, ids);
  } catch (err) {
    alert(`股票资料有更新，但没有保存：${err.message}\n\n本地自选保持原样。`);
    return;
  }
  if (result.changes.length) {
    pushLocal();
    alert('以下股票的资料在富途有变化，已更新到本地自选：\n\n' + result.changes.join('\n'));
  }
  if (result.missing.length) {
    showMessage(`没有查到 ${result.missing.join('、')} 的最新资料（可能已停牌或退市），已原样保留`, 10000);
  }
}

// ---------- 配置：数据位置 ----------

// 扩展拿不到自己所在的个人资料目录名，按默认个人资料 Default 显示
const DATA_DIR = `%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\Default\\Local Extension Settings\\${chrome.runtime.id}`;
ui.configPath.textContent = DATA_DIR;

function hideConfig() {
  ui.configPanel.hidden = true;
  ui.config.classList.remove('checked');
}

ui.config.addEventListener('click', () => {
  if (!ui.configPanel.hidden) return hideConfig();
  const r = ui.config.getBoundingClientRect();
  ui.configPanel.hidden = false;
  ui.configPanel.style.left = Math.max(8, Math.min(r.left, innerWidth - ui.configPanel.offsetWidth - 8)) + 'px';
  ui.config.classList.add('checked');
});
ui.configClose.addEventListener('click', hideConfig);
ui.configCopy.addEventListener('click', () => {
  navigator.clipboard.writeText(DATA_DIR).then(
    () => showMessage('已复制数据位置，可粘贴到资源管理器地址栏打开', 4000),
    () => showMessage('复制失败，请点一下路径全选后按 Ctrl+C 复制', 4000),
  );
});
// 点到面板外面（包括两侧富途页面，点进去时本页失去焦点）或按 Esc 就收起
document.addEventListener('pointerdown', (e) => {
  if (!ui.configPanel.hidden && !ui.configPanel.contains(e.target) && e.target !== ui.config) hideConfig();
});
window.addEventListener('blur', () => { if (!ui.configPanel.hidden) hideConfig(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !ui.configPanel.hidden) hideConfig(); });

// ---------- 导入 / 导出 ----------

// 默认文件名 defaults.json：存到项目的 edge_extension 文件夹覆盖它，就是提交到 git 的那份备份；
// 存储丢失时扩展会自动用它恢复。保存对话框会记住上次的文件夹。
ui.exportBtn.addEventListener('click', async () => {
  const text = FW.toJson(list.entries);
  const n = list.entries.length;
  if (window.showSaveFilePicker) {
    let handle;
    try {
      handle = await showSaveFilePicker({
        id: 'watchlist-backup',
        suggestedName: 'defaults.json',
        types: [{ description: '本地自选 JSON', accept: { 'application/json': ['.json'] } }],
      });
    } catch (err) {
      if (err.name !== 'AbortError') showMessage(`导出失败：${err.message}`, 6000);
      return;
    }
    try {
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      showMessage(`已导出 ${n} 只到 ${handle.name}`, 5000);
    } catch (err) {
      alert(`写入 ${handle.name} 失败：${err.message}`);
    }
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = 'defaults.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  showMessage(`已导出 ${n} 只`, 4000);
});

ui.importBtn.addEventListener('click', () => ui.importFile.click());

ui.importFile.addEventListener('change', async () => {
  const file = ui.importFile.files[0];
  ui.importFile.value = '';
  if (!file) return;
  let entries;
  try {
    entries = FW.validate(JSON.parse(await file.text()));
  } catch (err) {
    alert(`${file.name} 不是有效的本地自选文件：${err.message}\n\n本地自选保持原样。`);
    return;
  }
  if (!confirm(`用 ${file.name} 里的 ${entries.length} 只替换当前的 ${list.entries.length} 只本地自选？\n（当前列表会保留一份备份）`)) return;
  try {
    await list.replaceAll(entries);
  } catch (err) {
    alert(`没有导入：${err.message}\n\n本地自选保持原样。`);
    return;
  }
  showMessage(`已导入 ${entries.length} 只`, 5000);
  pushLocal();
  updateStatus();
  localInfoChecked = false;
  checkLocalInfo();
  refreshLocalQuotes();
});

// ---------- 登录 / 退出 ----------

function loginUrl(target) {
  return `https://${PASSPORT_HOST}/?` + new URLSearchParams({ type: 'login', target, lang: 'zh-cn' });
}

// 登录页在单独的小窗口里打开（第三方登录要 window.opener），登录完跳回 www.futunn.com 时关掉它、重新加载两侧
async function showLogin() {
  if (loginWindowId !== null) {
    chrome.windows.update(loginWindowId, { focused: true }).catch(() => { loginWindowId = null; });
    return;
  }
  const win = await chrome.windows.create({ url: loginUrl(detailUrl()), type: 'popup', width: 560, height: 720 });
  loginWindowId = win.id;
  awaitingLogin = true;
}

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (loginWindowId === null || tab.windowId !== loginWindowId || !change.url) return;
  let url;
  try { url = new URL(change.url); } catch (e) { return; }
  if (url.host === 'www.futunn.com') chrome.windows.remove(loginWindowId).catch(() => {});
});

chrome.windows.onRemoved.addListener((id) => {
  if (id !== loginWindowId) return;
  loginWindowId = null;
  for (const role of Object.keys(frames)) if (frames[role]) replaceFrame(role, recoverUrl(role));
});

ui.login.addEventListener('click', async () => {
  if (!isLogin()) {
    showLogin();
    return;
  }
  if (!confirm('确定退出当前账号？')) return;
  const cookies = await chrome.cookies.getAll({ domain: 'futunn.com' });
  await Promise.all(cookies.map((c) => chrome.cookies.remove({
    url: `https://${c.domain.replace(/^\./, '')}${c.path}`,
    name: c.name,
    ...(c.storeId ? { storeId: c.storeId } : {}),
    ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}),
  }).catch(() => {})));
  states.watch = {};
  states.detail = {};
  wasLogin = false;
  updateStatus();
  for (const role of Object.keys(frames)) if (frames[role]) replaceFrame(role, recoverUrl(role));
});

// ---------- 接口验证 ----------

async function verify(showDialog) {
  showMessage('正在用 cookie + quote-token 请求 get-watch-list ...');
  let result;
  try {
    const idsRes = await FQ.get('/get-watch-ids', {});
    const ids = ((idsRes && idsRes.data && idsRes.data.ids) || '').split(',').filter(Boolean);
    result = { ids, list: await FQ.get('/get-watch-list', { page: 0, page_size: 20, t: Date.now() }) };
  } catch (err) {
    const msg = `接口请求失败：${err.message}`;
    showMessage(msg, 8000);
    if (showDialog) alert(msg);
    return;
  }
  const res = result.list || {};
  const data = res.data || {};
  const items = data.list || [];
  const kind = result.ids.length ? '我的自选' : '热门自选（未登录或自选为空）';
  const summary = `get-watch-list code=${res.code}，${kind}，共 ${data.allCount ?? items.length} 只`;
  showMessage(summary, 8000);
  if (showDialog) {
    const lines = items.slice(0, 20).map((i) => `${String(i.stockCode).padEnd(10)}${i.name}  ${i.price ?? ''}  ${i.changeRatio ?? ''}`);
    alert(summary + '\n\n' + lines.join('\n'));
  }
}

// ---------- 工具栏 ----------

ui.back.addEventListener('click', () => history.back());
// 打开详情时先回到列表；已经在看列表时切换本地 / 热门
ui.listMode.addEventListener('click', () => {
  if (detailVisible) showList();
  else setListMode(listMode === 'local' ? 'hot' : 'local');
});
ui.reload.addEventListener('click', reloadAll);
ui.verify.addEventListener('click', () => verify(true));
ui.auto.addEventListener('click', () => {
  ui.auto.classList.toggle('checked');
  chrome.storage.local.set({ fastRefresh: ui.auto.classList.contains('checked') });
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'F5' || (e.ctrlKey && e.key.toLowerCase() === 'r')) {
    e.preventDefault();
    reloadAll();
  }
});

// ---------- 启动 ----------

// 只在本窗口（按标签页 id）去掉 futunn 页面的 X-Frame-Options / CSP，让它能放进 iframe；
// 平时在浏览器里打开富途不受影响。窗口关闭后 background.js 删掉这条规则。
async function allowFraming() {
  const tab = await chrome.tabs.getCurrent();
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tab.id],
    addRules: [{
      id: tab.id,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'x-frame-options', operation: 'remove' },
          { header: 'content-security-policy', operation: 'remove' },
        ],
      },
      condition: { requestDomains: ['futunn.com'], resourceTypes: ['sub_frame'], tabIds: [tab.id] },
    }],
  });
}

(async function main() {
  list.onExternal = (text) => {
    showMessage(text, 8000);
    pushLocal();
    updateStatus();
  };
  const [, saved] = await Promise.all([
    list.load(), chrome.storage.local.get(['fastRefresh', 'listMode']), allowFraming(), FC.prime(),
    FQ.allowQuoteApi().catch((e) => showMessage(`行情请求规则设置失败：${e.message}`)),
  ]);
  if (saved.fastRefresh === false) ui.auto.classList.remove('checked');
  if (saved.listMode === 'hot') listMode = 'hot';
  layout();
  updateStatus();
  if (list.warning) setTimeout(() => alert('本地自选：' + list.warning), 0);
  // 冷启动时两个页面同时请求，都会拿不到 wafToken 而被网关拦下（-12011）；
  // 先加载右侧，它通过后再加载左侧，超时也照样加载
  createFrame('detail', detailUrl());
  setTimeout(startWatch, 10000);
})();
