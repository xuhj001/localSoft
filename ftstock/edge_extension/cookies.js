// 扩展窗口（chrome-extension:// 页面）里嵌的 futunn iframe 在浏览器看来是跨站的：没写 SameSite 的 cookie
// （wafToken、csrfToken、登录态都是）按 Lax 处理，iframe 里既收不到也存不进去，接口会被网关拦截。
// 这里把 futunn.com 的 cookie 改成 SameSite=None; Secure（值、有效期、HttpOnly 都不变），iframe 里就能用了。
'use strict';

const FC = (() => {
  const BASE_URL = 'https://www.futunn.com';

  function relax(c) {
    if (c.sameSite === 'no_restriction' || c.partitionKey || !/(^|\.)futunn\.com$/.test(c.domain)) return Promise.resolve();
    const details = {
      url: `https://${c.domain.replace(/^\./, '')}${c.path}`,
      name: c.name,
      value: c.value,
      path: c.path,
      secure: true,
      httpOnly: c.httpOnly,
      sameSite: 'no_restriction',
      storeId: c.storeId,
    };
    if (!c.hostOnly) details.domain = c.domain;
    if (!c.session && c.expirationDate) details.expirationDate = c.expirationDate;
    return chrome.cookies.set(details).catch(() => {});
  }

  // 扩展窗口 iframe 里收到的 Set-Cookie 会被浏览器丢掉（没写 SameSite），照原样写进 cookie 库，改成 SameSite=None
  function store(line, responseUrl) {
    const parts = line.split(';').map((s) => s.trim());
    const eq = parts[0].indexOf('=');
    if (eq <= 0) return Promise.resolve();
    const host = new URL(responseUrl).hostname;
    const details = {
      name: parts[0].slice(0, eq).trim(),
      value: parts[0].slice(eq + 1).trim(),
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'no_restriction',
    };
    let maxAge = null, expires = null;
    for (const attr of parts.slice(1)) {
      const i = attr.indexOf('=');
      const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
      const val = i < 0 ? '' : attr.slice(i + 1).trim();
      if (key === 'path' && val.startsWith('/')) details.path = val;
      else if (key === 'domain' && val) details.domain = val.replace(/^\./, '');
      else if (key === 'httponly') details.httpOnly = true;
      else if (key === 'max-age' && /^-?\d+$/.test(val)) maxAge = Number(val);
      else if (key === 'expires' && !Number.isNaN(Date.parse(val))) expires = Date.parse(val) / 1000;
      else if (key === 'samesite' && val.toLowerCase() === 'none') return Promise.resolve(); // 浏览器已经照常存下了
    }
    if (details.domain && !(`.${host}`.endsWith(`.${details.domain}`) && /(^|\.)futunn\.com$/.test(details.domain))) {
      return Promise.resolve();
    }
    if (maxAge !== null) details.expirationDate = Date.now() / 1000 + maxAge;
    else if (expires !== null) details.expirationDate = expires;
    details.url = `https://${details.domain || host}${details.path}`;
    return chrome.cookies.set(details).catch(() => {});
  }

  async function relaxAll() {
    const cookies = await chrome.cookies.getAll({ domain: 'futunn.com' });
    await Promise.all(cookies.map(relax));
  }

  // 还没有 csrfToken 时，先用扩展自己的请求访问一次站点，响应里的 cookie 由 background.js 照原样存下，
  // 页面一打开接口就能用
  async function prime() {
    await relaxAll();
    const names = new Set((await chrome.cookies.getAll({ domain: 'futunn.com' })).map((c) => c.name));
    if (names.has('csrfToken')) return;
    try {
      await (await fetch(BASE_URL + '/quote/us', { credentials: 'include' })).text();
    } catch (e) {
      return; // 断网：照常打开窗口，页面加载失败后会自动重试
    }
    for (let i = 0; i < 10; i++) {
      if ((await chrome.cookies.getAll({ domain: 'futunn.com', name: 'csrfToken' })).length) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return { relax, store, relaxAll, prime };
})();
