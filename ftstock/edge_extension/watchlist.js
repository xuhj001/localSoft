// 本地自选：股票列表只保存在本浏览器的扩展存储（chrome.storage.local）里，不需要登录。
// 条目拼成与 get-watch-list 返回值相同的格式，交给站点自己的 WatchListModal 渲染（拼装在 page.js 里）。
//
// 保存流程：校验 → 旧版本存为 watchlist_prev → 写入 watchlist → 回读比对，不一致就用旧版本还原。
// 所有修改（添加、删除、拖动排序、启动校对、导入）都排队依次执行，每次都在存储里的最新数据上改动。
'use strict';

const FW = (() => {
  const KEY = 'watchlist';
  const PREV_KEY = 'watchlist_prev';
  const MARKET_LABELS = { us: 'US', hk: 'HK', sh: 'SH', sz: 'SZ' };
  const FUTURES_TYPE = 9;
  const US_TYPES = { stock: [3, 3002], etf: [4, 4002], futures: [FUTURES_TYPE, 9002] };
  const FUTURES_MONTH_RE = /\s*\(\d{4}\)$/;
  const ENTRY_FIELDS = {
    stockId: 'string', stockCode: 'string', marketType: 'int', marketLabel: 'string', name: 'string',
    instrumentType: 'int', subInstrumentType: 'int',
  };

  const us = (stockId, stockCode, name, kind = 'stock') => ({
    stockId, stockCode, marketType: 2, marketLabel: 'US', name,
    instrumentType: US_TYPES[kind][0], subInstrumentType: US_TYPES[kind][1],
  });

  // 扩展里没带 defaults.json 时的默认本地自选
  const DEFAULT_ENTRIES = [
    us('70000944', 'NQmain', '纳斯达克100指数期货主连', 'futures'),
    us('203290', 'QQQ', '纳指100ETF-Invesco QQQ Trust', 'etf'),
    us('206647', 'GOOGL', '谷歌-A'),
    us('205189', 'AAPL', '苹果'),
    us('201345', 'MSFT', '微软'),
    us('207605', 'SOXX', '半导体ETF-iShares', 'etf'),
  ];

  class SaveError extends Error {}
  class StockNotFound extends Error {}

  function validate(entries) {
    if (!Array.isArray(entries)) throw new Error('顶层不是列表');
    const seen = new Set();
    entries.forEach((e, i) => {
      if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error(`第 ${i + 1} 项不是对象`);
      for (const [key, type] of Object.entries(ENTRY_FIELDS)) {
        const v = e[key];
        const ok = type === 'int' ? Number.isInteger(v) : typeof v === type;
        if (!ok) throw new Error(`第 ${i + 1} 项字段 ${key} 缺失或类型不对`);
      }
      if (seen.has(e.stockId)) throw new Error(`stockId ${e.stockId} 重复`);
      seen.add(e.stockId);
    });
    return entries;
  }

  // 导出 / defaults.json 的文本：字段按固定顺序、2 空格缩进、结尾换行，提交到 git 时只有真正改动的行出现在 diff 里
  function toJson(entries) {
    const rows = entries.map((e) => Object.fromEntries(Object.keys(ENTRY_FIELDS).map((k) => [k, e[k]])));
    return JSON.stringify(rows, null, 2) + '\n';
  }

  // TSLA -> [TSLA, null]，NVDA.US / NVDA-US -> [NVDA, US]，700 -> [00700, HK]，600519 -> [600519, null]
  function parseCode(text) {
    const s = String(text || '').trim().toUpperCase().replace(/\./g, '-');
    const m = s.match(/^(.+?)-(US|HK|SH|SZ)$/);
    let [symbol, market] = m ? [m[1], m[2]] : [s, null];
    if (/^\d{1,5}$/.test(symbol)) return [symbol.padStart(5, '0'), market || 'HK'];
    return [symbol, market];
  }

  // 牛牛圈的批量个股静态信息，含 instrument_type_v2 / sub_instrument_type_v2（扩展页面有 host 权限，不受跨域限制）
  async function stockInfos(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      const url = 'https://q.futunn.com/api/stock/list?' + new URLSearchParams({ stock_ids: ids.slice(i, i + 50).join(',') });
      const res = await fetch(url, { headers: { Accept: 'application/json', 'x-futu-nnq-new-website': 'nnq' }, credentials: 'omit' });
      if (!/json/.test(res.headers.get('content-type') || '')) throw new Error('被富途网关拦截（访问频繁）');
      const data = (await res.json()).data;
      if (!Array.isArray(data)) throw new Error('个股资料接口返回格式不对');
      out.push(...data);
    }
    return out;
  }

  // 用站点搜索接口（search 由调用方提供，在左侧页面里请求）把代码解析成本地自选条目
  async function resolve(search, text) {
    const [symbol, market] = parseCode(text);
    if (!symbol) throw new StockNotFound('请输入股票代码');
    const found = (await search(symbol)) || [];
    const candidates = found.filter((q) => String(q.stockSymbol || '').toUpperCase() === symbol
      && (market === null || MARKET_LABELS[q.market || ''] === market));
    if (!candidates.length) throw new StockNotFound(`没有找到 ${String(text).trim()}，请确认代码，如 TSLA、00700、600519-SH`);
    const q = candidates[0];
    const entry = {
      stockId: String(q.stockId),
      stockCode: String(q.stockSymbol),
      marketType: Number(q.marketType),
      marketLabel: MARKET_LABELS[q.market || ''] || String(q.market || '').toUpperCase(),
      name: q.stockName || String(q.stockSymbol),
      instrumentType: 3,
      subInstrumentType: 0,
    };
    try {
      const info = (await stockInfos([entry.stockId]))[0] || {};
      entry.instrumentType = info.instrument_type_v2 || 3;
      entry.subInstrumentType = info.sub_instrument_type_v2 || 0;
    } catch (e) {
      // 证券类型只影响跳转路径（stock / etfs），取不到就按正股处理
    }
    return entry;
  }

  // 批量个股资料里会随时间变的字段：代码、名称、证券类型。取不到或格式不对的字段不返回，校对时保持原值。
  function liveFields(info) {
    const out = {};
    const symbol = info.symbol;
    if (typeof symbol === 'string' && symbol.includes('.')) {
      const code = symbol.slice(0, symbol.lastIndexOf('.')).trim();
      if (code) out.stockCode = code;
    }
    let name = info.sc_name;
    if (typeof name === 'string' && name.trim()) {
      name = name.trim();
      // 期货主连名称带当前合约月份「(2612)」，每季度都变，不跟
      if (info.instrument_type_v2 === FUTURES_TYPE) name = name.replace(FUTURES_MONTH_RE, '');
      out.name = name;
    }
    for (const [key, src] of [['instrumentType', 'instrument_type_v2'], ['subInstrumentType', 'sub_instrument_type_v2']]) {
      const v = info[src];
      if (Number.isInteger(v) && v > 0) out[key] = v;
    }
    return out;
  }

  function describeChange(e, diff) {
    const parts = [];
    if ('stockCode' in diff) parts.push(`代码 ${e.stockCode} → ${diff.stockCode}`);
    if ('name' in diff) parts.push(`名称 ${e.name} → ${diff.name}`);
    if ('instrumentType' in diff || 'subInstrumentType' in diff) {
      const now = `${diff.instrumentType ?? e.instrumentType}/${diff.subInstrumentType ?? e.subInstrumentType}`;
      parts.push(`证券类型 ${e.instrumentType}/${e.subInstrumentType} → ${now}`);
    }
    return `${diff.stockCode ?? e.stockCode}：` + parts.join('，');
  }

  // chrome.storage 回读的对象键按字母序排列，比较时不能依赖键的顺序
  const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
  const same = (a, b) => canon(a) === canon(b);
  const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

  class LocalWatchlist {
    constructor() {
      this.entries = [];
      this.warning = '';
      this.onExternal = null; // (说明文字) => void：存储被别处改动（另一个窗口、导入）后回调
      this.queue = Promise.resolve();
      this.lastWritten = null;
    }

    // 读存储；没有就用 watchlist_prev 备份，再没有就用扩展自带的 defaults.json。
    // 损坏的数据另存为 watchlist_corrupt_<时间>，绝不拿空列表覆盖它。
    async load() {
      const got = await chrome.storage.local.get([KEY, PREV_KEY]);
      if (got[KEY] !== undefined) {
        try {
          this.entries = validate(got[KEY]);
          this.lastWritten = canon(this.entries);
        } catch (e) {
          await chrome.storage.local.set({ [`watchlist_corrupt_${stamp()}`]: got[KEY] });
          await this._fromBackup(got[PREV_KEY], `本地自选数据损坏（${e.message}），已另存一份`);
        }
      } else if (got[PREV_KEY] !== undefined) {
        await this._fromBackup(got[PREV_KEY], '本地自选数据不见了');
      } else {
        this.entries = await this._defaults();
        await this._trySave();
      }
      chrome.storage.onChanged.addListener((changes, area) => this._onChanged(changes, area));
      return this.entries;
    }

    async _defaults() {
      try {
        const res = await fetch(chrome.runtime.getURL('defaults.json'));
        return validate(await res.json());
      } catch (e) {
        return DEFAULT_ENTRIES.map((x) => ({ ...x }));
      }
    }

    async _fromBackup(prev, reason) {
      try {
        this.entries = validate(prev);
      } catch (e) {
        this.entries = [];
        this.warning = `${reason}；备份也不可用，本地自选从空列表开始`;
        return;
      }
      this.warning = `${reason}；已从备份恢复 ${this.entries.length} 只`;
      await this._trySave();
    }

    async _trySave() {
      try {
        await this._write(this.entries);
      } catch (e) {
        this.warning = this.warning ? `${this.warning}；${e.message}` : e.message;
      }
    }

    async _write(entries) {
      try {
        validate(entries);
        const old = (await chrome.storage.local.get(KEY))[KEY];
        const data = JSON.parse(JSON.stringify(entries));
        const update = { [KEY]: data };
        if (old !== undefined) {
          try {
            update[PREV_KEY] = validate(old);
          } catch (e) {
            update[`watchlist_corrupt_${stamp()}`] = old; // 当前数据有误：另存一份再覆盖，不拿它覆盖好的备份
          }
        }
        this.lastWritten = canon(data);
        await chrome.storage.local.set(update);
        const back = (await chrome.storage.local.get(KEY))[KEY];
        if (!same(back, data)) {
          if (update[PREV_KEY]) await chrome.storage.local.set({ [KEY]: update[PREV_KEY] });
          throw new Error('写入后回读校验不一致，已用备份还原');
        }
      } catch (e) {
        throw new SaveError(`保存本地自选失败：${e.message}`);
      }
    }

    // 排队执行：先读存储里的最新数据，fn 返回新列表（或 null 表示不用改），保存失败时内存保持原样
    _mutate(fn) {
      const run = this.queue.then(async () => {
        const cur = (await chrome.storage.local.get(KEY))[KEY];
        try {
          if (cur !== undefined) this.entries = validate(cur);
        } catch (e) {
          // 存储里的数据有误：在内存里那份上改，保存时会先另存坏数据
        }
        const result = fn(this.entries.slice());
        if (!result || !result.entries) return result && result.value;
        await this._write(result.entries);
        this.entries = result.entries;
        return result.value;
      });
      this.queue = run.catch(() => {});
      return run;
    }

    _onChanged(changes, area) {
      if (area !== 'local' || !changes[KEY]) return;
      const v = changes[KEY].newValue;
      if (canon(v) === this.lastWritten) return;
      try {
        this.entries = validate(v);
        this.lastWritten = canon(v);
        if (this.onExternal) this.onExternal(`本地自选在别处被修改，已重新载入（${this.entries.length} 只）`);
      } catch (e) {
        // 格式有误的外部修改不载入，下次保存时会另存一份再覆盖
      }
    }

    find(id) {
      return this.entries.find((e) => e.stockId === id) || null;
    }

    add(entry) {
      return this._mutate((list) => (list.some((e) => e.stockId === entry.stockId)
        ? { value: false } : { entries: [...list, entry], value: true }));
    }

    remove(id) {
      return this._mutate((list) => (list.some((e) => e.stockId === id)
        ? { entries: list.filter((e) => e.stockId !== id), value: true } : { value: false }));
    }

    // 按拖动后的顺序重排，只排现有的股票：页面上有、存储里已经没有的忽略；存储里有、页面上没有的
    // （拖动期间刚添加的、或别处改动加进来的）按原先后接在最后。一只不丢，也不会凭空多出来。
    reorder(ids) {
      if (!Array.isArray(ids) || !ids.every((i) => typeof i === 'string')) {
        return Promise.reject(new SaveError('拖动后的顺序数据格式不对'));
      }
      return this._mutate((list) => {
        const byId = new Map(list.map((e) => [e.stockId, e]));
        const order = [...new Set(ids.filter((i) => byId.has(i)))];
        const placed = new Set(order);
        list.forEach((e) => { if (!placed.has(e.stockId)) order.push(e.stockId); });
        if (same(order, list.map((e) => e.stockId))) return { value: false };
        return { entries: order.map((i) => byId.get(i)), value: true };
      });
    }

    // 用实时个股资料校对 checkedIds 这些股票的代码、名称、证券类型，有变化就保存。
    // 返回 {changes, missing}。没查到的股票原样保留、绝不删除；stockId 和顺序不动。
    sync(infos, checkedIds) {
      return this._mutate((list) => {
        const byId = new Map(infos.filter((i) => i && typeof i === 'object').map((i) => [String(i.stock_id), i]));
        const checked = new Set(checkedIds);
        const changes = [], missing = [];
        const entries = list.map((e) => {
          if (!checked.has(e.stockId)) return e;
          const info = byId.get(e.stockId);
          if (!info) {
            missing.push(e.stockCode);
            return e;
          }
          const diff = {};
          for (const [k, v] of Object.entries(liveFields(info))) if (e[k] !== v) diff[k] = v;
          if (!Object.keys(diff).length) return e;
          changes.push(describeChange(e, diff));
          return { ...e, ...diff };
        });
        return changes.length ? { entries, value: { changes, missing } } : { value: { changes, missing } };
      });
    }

    // 导入：整份替换，先校验；旧列表照常进 watchlist_prev
    replaceAll(entries) {
      validate(entries);
      return this._mutate(() => ({ entries: entries.map((e) => ({ ...e })), value: entries.length }));
    }
  }

  return { LocalWatchlist, SaveError, StockNotFound, validate, toJson, parseCode, resolve, stockInfos, MARKET_LABELS };
})();
