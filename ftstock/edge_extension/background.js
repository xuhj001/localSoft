// 点工具栏图标：打开扩展窗口（无地址栏的独立小窗口），已经开着就切到前面，只保留一个。
importScripts('cookies.js');

const APP_URL = chrome.runtime.getURL('app.html');

// 登录窗口、普通标签页里新写入的 futunn cookie 也随时改成扩展窗口的 iframe 能用的样子
chrome.cookies.onChanged.addListener(({ removed, cookie }) => {
  if (!removed) FC.relax(cookie);
});

// 扩展窗口里 futunn iframe 收到的 Set-Cookie 浏览器不会存（算跨站、没写 SameSite），这里只读响应头、照原样存下。
// 只管扩展窗口的标签页（DNR 规则 id 就是标签页 id）和扩展自己发的请求，普通标签页浏览富途不受影响。
const EXT_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');

async function isAppRequest(details) {
  if (details.tabId === -1) return details.initiator === EXT_ORIGIN;
  const rules = await chrome.declarativeNetRequest.getSessionRules();
  return rules.some((r) => r.id === details.tabId);
}

chrome.webRequest.onHeadersReceived.addListener((details) => {
  const lines = (details.responseHeaders || []).filter((h) => h.name.toLowerCase() === 'set-cookie' && h.value);
  if (!lines.length) return;
  isAppRequest(details).then((ok) => {
    if (ok) lines.forEach((h) => h.value.split('\n').forEach((line) => FC.store(line, details.url)));
  });
}, { urls: ['https://*.futunn.com/*'] }, ['responseHeaders', 'extraHeaders']);

async function findAppWindow() {
  const { appWindowId } = await chrome.storage.session.get('appWindowId');
  if (appWindowId === undefined) return null;
  try {
    return await chrome.windows.get(appWindowId);
  } catch (e) {
    return null;
  }
}

chrome.action.onClicked.addListener(async () => {
  const existing = await findAppWindow();
  if (existing) {
    await chrome.windows.update(existing.id, { focused: true, ...(existing.state === 'minimized' ? { state: 'normal' } : {}) });
    return;
  }
  const { bounds } = await chrome.storage.local.get('bounds');
  const win = await chrome.windows.create({
    url: APP_URL,
    type: 'popup',
    ...(bounds && bounds.width > 200 && bounds.height > 200 ? bounds : { width: 1440, height: 900 }),
  });
  await chrome.storage.session.set({ appWindowId: win.id });
});

// 窗口大小、位置：下次打开时还原
chrome.windows.onBoundsChanged.addListener(async (win) => {
  const { appWindowId } = await chrome.storage.session.get('appWindowId');
  if (win.id !== appWindowId || win.state !== 'normal') return;
  await chrome.storage.local.set({ bounds: { left: win.left, top: win.top, width: win.width, height: win.height } });
});

chrome.windows.onRemoved.addListener(async (id) => {
  const { appWindowId } = await chrome.storage.session.get('appWindowId');
  if (id === appWindowId) await chrome.storage.session.remove('appWindowId');
});

// 扩展窗口里放开 futunn 的 iframe 嵌入限制的规则按标签页登记（规则 id 就是标签页 id），标签页关了就删掉
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [tabId] }).catch(() => {});
});
