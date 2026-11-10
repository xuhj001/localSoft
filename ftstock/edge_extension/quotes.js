// 本地自选的行情：由扩展窗口自己逐只请求 get-stock-quote。
// 浏览器页面里发的请求，网关只放行很少的次数，逐只请求会被跳到 /403「访问频繁」；
// 所以这些请求由 DNR 规则改成普通程序的请求头（自定义 User-Agent，去掉浏览器特有的头），见 allowQuoteApi()。
'use strict';

const FQ = (() => {
  const BASE_URL = 'https://www.futunn.com';
  const QUOTE_API = BASE_URL + '/quote-api/quote-v2';
  const MARKET_CODE = { 1: 1, 2: 11 };
  const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FutuWatchlist/1.0 (Extension)';
  const RULE_ID = 1;
  const enc = new TextEncoder();

  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

  // quote-token 请求头：SHA256(HmacSHA512(payload, "quote_web").hex[:10]).hex[:10]
  async function quoteToken(payload) {
    const key = await crypto.subtle.importKey('raw', enc.encode('quote_web'), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
    const first = hex(await crypto.subtle.sign('HMAC', key, enc.encode(payload || 'quote'))).slice(0, 10);
    return hex(await crypto.subtle.digest('SHA-256', enc.encode(first))).slice(0, 10);
  }

  class Blocked extends Error {}

  // 只改本扩展发往 /quote-api/ 的请求，站点页面自己的请求、普通标签页都不受影响
  async function allowQuoteApi() {
    const remove = (header) => ({ header, operation: 'remove' });
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [RULE_ID],
      addRules: [{
        id: RULE_ID,
        priority: 2,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'user-agent', operation: 'set', value: UA },
            { header: 'referer', operation: 'set', value: BASE_URL + '/' },
            remove('origin'),
            remove('sec-ch-ua'),
            remove('sec-ch-ua-mobile'),
            remove('sec-ch-ua-platform'),
            remove('sec-fetch-site'),
            remove('sec-fetch-mode'),
            remove('sec-fetch-dest'),
          ],
        },
        condition: {
          initiatorDomains: [chrome.runtime.id],
          requestDomains: ['www.futunn.com'],
          urlFilter: '|https://www.futunn.com/quote-api/',
          resourceTypes: ['xmlhttprequest'],
        },
      }],
    });
  }

  // GET 参数的值全部转成字符串后 JSON.stringify 作为签名内容，没有参数时是 "{}"
  async function get(path, params) {
    const strParams = {};
    for (const [k, v] of Object.entries(params || {})) if (v != null) strParams[k] = String(v);
    const query = new URLSearchParams(strParams).toString();
    const csrf = await chrome.cookies.get({ url: BASE_URL, name: 'csrfToken' });
    const res = await fetch(QUOTE_API + path + (query ? '?' + query : ''), {
      credentials: 'include',
      headers: {
        Accept: 'application/json, text/plain, */*',
        'quote-token': await quoteToken(JSON.stringify(strParams)),
        'futu-x-csrf-token': csrf ? decodeURIComponent(csrf.value) : '',
      },
    });
    if (!/json/.test(res.headers.get('content-type') || '')) throw new Blocked('被富途网关拦截（访问频繁），稍后自动重试');
    return res.json();
  }

  // 从第 start 只开始轮一圈，返回 {quotes: {stockId: 行情}, error, next}。被拦或断网时后面的就不再试了，
  // next 是停下的位置，下一轮从那里接着请求，持续限流时排在后面的股票也能轮到
  async function fetchQuotes(entries, start = 0) {
    const quotes = {};
    let error = '';
    const n = entries.length;
    for (let k = 0; k < n; k++) {
      const e = entries[(start + k) % n];
      try {
        const res = await get('/get-stock-quote', {
          stockId: e.stockId,
          marketType: e.marketType,
          marketCode: MARKET_CODE[e.marketType] || 11,
          instrumentType: e.instrumentType,
        });
        const q = res && res.data;
        if (q && typeof q === 'object' && Object.keys(q).length) quotes[e.stockId] = q;
      } catch (err) {
        const stop = err instanceof Blocked ? err.message : err instanceof TypeError ? '网络连接失败，稍后自动重试' : '';
        if (stop) return { quotes, error: stop, blocked: err instanceof Blocked, next: (start + k) % n };
        error = `${e.stockCode} 行情获取失败：${err.message || err}`;
      }
    }
    return { quotes, error, blocked: false, next: 0 };
  }

  // 热门自选 / 账号自选：get-watch-list 按页取全（每页 20 只），登录时一并取账号自选的 stockId（爱心实心）
  async function fetchWatchList(login) {
    const list = [];
    for (let page = 0; page < 10; page++) {
      const res = await get('/get-watch-list', { page, page_size: 20, t: Date.now() });
      if (!res || res.code !== 0 || !res.data) throw new Error(`get-watch-list 返回 code=${res && res.code}`);
      const items = Array.isArray(res.data.list) ? res.data.list : [];
      list.push(...items);
      if (!items.length || list.length >= (res.data.allCount || 0)) break;
    }
    let ids = [];
    if (login) {
      const res = await get('/get-watch-ids', {});
      ids = ((res && res.data && res.data.ids) || '').split(',').filter(Boolean);
    }
    return { list, ids };
  }

  return { Blocked, allowQuoteApi, fetchQuotes, fetchWatchList, get };
})();
