// 注入 www.futunn.com 页面（MAIN world，document_start）。
// 只在扩展窗口的两个 iframe 里生效：name="fa-watch" 是左侧自选栏，name="fa-detail" 是右侧个股详情；
// 平时在浏览器标签页里打开富途不受任何影响。
//
// 自选栏：ToolBar 的自选按钮点击后 toolbarStore.label = "工具栏-自选"，App 才会挂载
// section.watchlist-modal；SSR 输出的按钮在 Vue 水合前点击无效，所以要轮询直到弹窗出现。
// 条目点击走 WatchListModal.stockClick：更新个股 store、router.push(个股路径)，最后 closeModal()，
// 即 toolbarStore.label = "" 再 commonStore.switchWatch(false)。左侧让 router.push 只记录路径、
// 在 switchWatch(false) 里同步把 label 改回去（Vue 异步渲染看不到变化，弹窗不会卸载），
// 再把条目数据和路径交给扩展窗口，由右侧用同一个 stockClick 打开。
(function () {
  'use strict';
  var role = window.name === 'fa-watch' ? 'watch' : window.name === 'fa-detail' ? 'detail' : '';
  var parentOrigin = (location.ancestorOrigins && location.ancestorOrigins[0]) || '';
  if (!role || window === window.top || parentOrigin.indexOf('chrome-extension://') !== 0 || window.__fa) return;
  window.__fa = true;

  // 放在扩展窗口里算跨站，站点脚本写的 cookie 不带 SameSite 会被浏览器丢掉，这里补上
  var cookieDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  if (cookieDesc && cookieDesc.set) {
    Object.defineProperty(Document.prototype, 'cookie', {
      configurable: true,
      enumerable: cookieDesc.enumerable,
      get: cookieDesc.get,
      set: function (v) {
        if (typeof v === 'string' && !/;\s*samesite\s*=/i.test(v)) v += '; SameSite=None; Secure';
        cookieDesc.set.call(this, v);
      },
    });
  }

  var PAGE_CSS = [
    '#header, #footer, .top-banner { display: none !important; }',
    'body { position: static !important; }',
  ].join('\n');

  var DETAIL_CSS = 'section.tool-bar { display: none !important; }';

  var WATCH_CSS = [
    'section.watchlist-modal { z-index: 2147483000 !important; width: 100vw !important; height: 100vh !important; }',
    'section.watchlist-modal .mask,',
    'section.watchlist-modal .close-icon { display: none !important; }',
    'section.watchlist-modal .content {',
    '  top: 0 !important; left: 0 !important; transform: none !important;',
    '  width: 100vw !important; max-width: none !important;',
    '  height: 100vh !important; max-height: none !important;',
    '  border-radius: 0 !important; box-shadow: none !important;',
    '  padding: 12px 0 12px 16px !important;',
    '  display: flex !important; flex-direction: column !important; overflow: hidden !important;',
    '}',
    // 内容按弹窗原始宽度（880 减左右内边距）排版；列表滚动区域伸到页面最右侧，滚动条贴着右边框
    'section.watchlist-modal .content > :not(.list),',
    'section.watchlist-modal .content::after { max-width: 848px !important; }',
    'section.watchlist-modal .list { flex: 1 1 auto !important; height: auto !important; max-height: none !important; }',
    'section.watchlist-modal .list-head,',
    'section.watchlist-modal .list-item { width: 848px !important; min-width: 0 !important; max-width: none !important; }',
    '@media (max-width: 620px) {',
    '  section.watchlist-modal .content { padding-right: 16px !important; }',
    '  section.watchlist-modal .list-head,',
    '  section.watchlist-modal .list-item { width: auto !important; min-width: 100% !important; }',
    '  section.watchlist-modal .col.change-value,',
    '  section.watchlist-modal .col.volume { display: none !important; }',
    '  section.watchlist-modal .col.name { min-width: 0 !important; }',
    '  section.watchlist-modal .col.price { width: 96px !important; }',
    // 右侧紧挨着自选心形，盘前/盘后/夜盘标签没处顺延，就在列内留出标签宽度，所有行的涨跌幅仍对齐
    '  section.watchlist-modal .col.change { width: 128px !important; padding-right: 44px !important; }',
    '  section.watchlist-modal .col.watchlist { width: 44px !important; }',
    '}',
    // 盘前/盘后/夜盘：涨跌幅和其他行对齐，标签顺延到列外（涨跌额列左侧的空白里）
    'section.watchlist-modal .col.change:has(.disc-change),',
    'section.watchlist-modal .col.change .disc-change { overflow: visible !important; }',
    'section.watchlist-modal .col.change .disc-change { position: relative; }',
    'section.watchlist-modal .col.change-value { width: 132px !important; }',
    'section.watchlist-modal .col.change .disc-status {',
    '  position: absolute; left: 100%; top: 50%; transform: translateY(-50%);',
    '  margin-left: 4px !important; white-space: nowrap;',
    '}',
    'section.watchlist-modal .header h3[data-fa-title] { font-size: 0 !important; }',
    'section.watchlist-modal .header h3[data-fa-title]::after {',
    '  content: attr(data-fa-title); font-size: var(--fa-h3-size); font-weight: var(--fa-h3-weight); font-family: var(--fa-h3-family);',
    '}',
    'html.fa-drag, html.fa-drag * { cursor: grabbing !important; user-select: none !important; }',
    'section.watchlist-modal .list-item.fa-moving { transition: transform .15s ease; }',
    'section.watchlist-modal .list-item.fa-dragged {',
    '  position: relative; z-index: 2; transition: none;',
    '  background: #fff; box-shadow: 0 4px 16px rgba(0, 0, 0, .18);',
    '}',
    'html.fa-local-empty section.watchlist-modal .content::after {',
    '  content: "本地自选还是空的：在顶部「添加本地自选」输入框里输入代码（如 TSLA、00700、600519）回车即可添加";',
    '  display: block; padding: 48px 24px; text-align: center; color: #888; font-size: 14px; line-height: 1.8;',
    '}',
  ].join('\n');

  new MutationObserver(function (_, observer) {
    if (!document.head) return;
    var style = document.createElement('style');
    style.id = 'fa-style';
    style.textContent = PAGE_CSS + '\n' + (role === 'watch' ? WATCH_CSS : DETAIL_CSS);
    document.head.appendChild(style);
    observer.disconnect();
  }).observe(document, { childList: true, subtree: true });

  // ---------- 和扩展窗口通信：命令 {fa, id, cmd, args} → 回复 {fa, re, ok, value|error}；事件 {fa, ev, data} ----------

  function emit(ev, data) {
    window.parent.postMessage({ fa: 1, ev: ev, data: data }, parentOrigin);
  }

  var handlers = {};
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (e.source !== window.parent || e.origin !== parentOrigin || !m || m.fa !== 1 || !m.cmd) return;
    Promise.resolve().then(function () {
      var h = handlers[m.cmd];
      if (!h) throw new Error('未知命令 ' + m.cmd);
      return h(m.args);
    }).then(function (value) {
      if (m.id) window.parent.postMessage({ fa: 1, re: m.id, ok: true, value: value }, parentOrigin);
    }, function (err) {
      if (m.id) window.parent.postMessage({ fa: 1, re: m.id, ok: false, error: String((err && err.message) || err) }, parentOrigin);
    });
  });

  function plain(obj) {
    return obj == null ? obj : JSON.parse(JSON.stringify(obj));
  }

  function rootVm() {
    var app = document.getElementById('app');
    return app && app.__vue__;
  }

  // App 组件（setup 里暴露了 WatchListModal 组件定义）
  function appVm() {
    var queue = rootVm() ? [rootVm()] : [];
    for (var i = 0; i < queue.length && i < 20; i++) {
      var vm = queue[i];
      if (vm._setupState && vm._setupState.WatchListModal) return vm;
      queue.push.apply(queue, vm.$children);
    }
    return null;
  }

  function patchWatch(modal) {
    var vm = rootVm(), modalVm = modal.__vue__;
    if (!vm || !vm.$router || !vm.$pinia || !modalVm || !modalVm._setupState) return;
    var router = vm.$router;
    if (!router.__fa) {
      router.__fa = true;
      router.push = router.replace = function (loc) {
        lastPath = typeof loc === 'string' ? loc : (loc && (loc.fullPath || loc.path)) || '';
        return Promise.resolve();
      };
    }
    var common = vm.$pinia._s.get('common_data'), toolbar = vm.$pinia._s.get('tool-bar');
    if (common && toolbar && toolbar.$state.label && !common.__fa) {
      common.__fa = true;
      var label = toolbar.$state.label, switchWatch = common.switchWatch;
      common.switchWatch = function (show) {
        if (!show) {
          toolbar.$state.label = label;
          return;
        }
        return switchWatch.apply(this, arguments);
      };
    }
    var setup = modalVm._setupState;
    if (!setup.__fa) {
      setup.__fa = true;
      var stockClick = setup.stockClick;
      setup.stockClick = function (item) {
        lastPath = '';
        stockClick(item);
        if (lastPath) emit('open', { path: lastPath, item: plain(item) });
      };
      // 本地自选里的爱心表示「从本地自选删除」，不走站点的加/删自选；热门自选保持站点原样
      var watchClick = setup.watchClick;
      setup.watchClick = function (item) {
        if (local.mode !== 'local') return watchClick(item);
        emit('localDel', String(item.stockId));
      };
    }
  }
  var lastPath = '';

  // ---------- 列表数据：复用同一个 WatchListModal，watch_list store 的数据换成扩展窗口推来的条目 ----------
  // fetchList / getIdsMap 不请求服务端（页面里请求会被网关限流），updateList 直接用推来的条目，避免在途请求把列表覆盖回去。
  // setLocal：本地自选（条目 + 扩展窗口推来的行情）；setHot：热门自选 / 账号自选（扩展窗口请求 get-watch-list 的结果）。
  var MARKET_CODE = { 1: 1, 2: 11 }, FUTURES_TYPE = 9;
  var local = { mode: '', entries: [], items: [], ids: {}, loaded: false, dirty: false }, quotes = {}, origStore = null;

  function buildItem(e, q) {
    var item = Object.assign({}, e, {
      displaySymbol: e.stockCode + '.' + e.marketLabel,
      marketCode: MARKET_CODE[e.marketType] || 11,
      isOption: false,
      isPlate: false,
      isFutures: e.instrumentType === FUTURES_TYPE,
      underlyingStock: {},
      delayTime: 0,
      price: '--',
      change: '--',
      changeRatio: '--',
      volume: '--',
    });
    return Object.assign(item, q || {});
  }

  function rebuildItems() {
    local.items = local.entries.map(function (e) { return buildItem(e, quotes[e.stockId]); });
    local.dirty = true;
  }

  function watchStore() {
    var vm = rootVm();
    return vm && vm.$pinia && vm.$pinia._s.get('watch_list');
  }

  function applyLocal() {
    var store = watchStore();
    if (!store || !local.loaded) return false;
    if (!origStore) {
      origStore = { updateList: store.updateList };
      store.fetchList = function () { return Promise.resolve(); };
      store.getIdsMap = function () { return Promise.resolve(); };
      store.updateList = function () { if (!dragging()) this.list = local.items.slice(); };
      // 账号自选里点爱心加/删后站点会 resetData 清空列表重拉：改成保留当前列表，请扩展窗口马上重新请求
      store.resetData = function () {
        local.dirty = true;
        if (local.mode === 'hot') emit('hotChanged');
        return Promise.resolve();
      };
    }
    var ids = local.ids;
    if (local.mode === 'local') {
      ids = {};
      local.items.forEach(function (it) { ids[it.stockId] = true; });
    }
    store.$patch(function (s) {
      s.list = local.items.slice();
      s.idsMap = ids;
      s.isMore = false;
      s.loading = false;
    });
    return true;
  }

  handlers.setLocal = function (entries) {
    if (role !== 'watch' || local.mode === 'hot' || !Array.isArray(entries)) return false;
    local.mode = 'local';
    local.entries = entries;
    local.loaded = true;
    rebuildItems();
    return true;
  };

  // data = {list: get-watch-list 的条目, ids: 账号自选的 stockId 列表（爱心实心）}
  handlers.setHot = function (data) {
    if (role !== 'watch' || local.mode === 'local' || !data || !Array.isArray(data.list)) return false;
    local.mode = 'hot';
    local.items = data.list.filter(function (it) { return it && it.stockCode; });
    local.ids = {};
    (data.ids || []).forEach(function (id) { local.ids[id] = true; });
    local.loaded = true;
    local.dirty = true;
    return true;
  };

  // 行情由扩展窗口请求后推过来（页面里逐只请求会被网关限流）
  handlers.setQuotes = function (map) {
    if (role !== 'watch' || local.mode !== 'local' || !map || typeof map !== 'object') return false;
    Object.keys(map).forEach(function (id) { quotes[id] = map[id]; });
    rebuildItems();
    return true;
  };

  function blockedError() {
    var err = new Error('被富途网关拦截（访问频繁），稍后自动重试');
    err.blocked = true;
    return err;
  }

  handlers.search = async function (keyword) {
    var query = new URLSearchParams({ keyword: String(keyword || ''), lang: 'zh-cn', site: 'cn' }).toString();
    var res = await fetch('/search-stock/predict?' + query, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!/json/.test(res.headers.get('content-type') || '')) throw blockedError();
    var data = await res.json();
    return plain((data && data.data && data.data.quote) || []);
  };

  // ---------- 本地自选拖动排序：按住条目上下拖，其它条目让出位置，松开鼠标就落在当前位置 ----------
  // 新顺序交给扩展窗口安全保存。拖动期间不应用新推来的行情（列表重绘会打断拖动），松开后再应用。
  var drag = null, suppressClick = false;

  function dragging() {
    return !!(drag && drag.active);
  }

  document.addEventListener('pointerdown', function (e) {
    // 上次按下后在窗口外松开、没收到 pointerup 的残留状态，先清掉
    if (drag) endDrag(null, drag.active);
    if (role !== 'watch' || local.mode !== 'local' || e.button !== 0) return;
    var row = e.target.closest && e.target.closest('section.watchlist-modal .list > .list-item');
    if (!row || e.target.closest('.col.watchlist')) return;
    var list = row.parentElement;
    var rows = Array.prototype.filter.call(list.children, function (el) { return el.classList.contains('list-item'); });
    drag = { id: e.pointerId, row: row, list: list, rows: rows, from: rows.indexOf(row), to: rows.indexOf(row),
             startY: e.clientY, y: e.clientY, scroll: list.scrollTop, active: false, timer: 0 };
    e.preventDefault();  // 不触发文字选中；click 照常触发，单击条目仍然打开详情
  }, true);

  document.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag.y = e.clientY;
    if (!drag.active) {
      if (Math.abs(drag.y - drag.startY) < 6) return;
      startDrag();
    }
    layoutDrag();
  }, true);

  document.addEventListener('pointerup', function (e) { endDrag(e, true); }, true);
  document.addEventListener('pointercancel', function (e) { endDrag(e, false); }, true);
  document.addEventListener('lostpointercapture', function (e) { endDrag(e, true); }, true);
  window.addEventListener('blur', function () { endDrag(null, true); });

  // 拖动结束时鼠标还在条目上，吞掉随后的 click，免得松手就打开详情
  window.addEventListener('click', function (e) {
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  function startDrag() {
    var listTop = drag.list.getBoundingClientRect().top;
    drag.active = true;
    drag.height = drag.row.getBoundingClientRect().height;
    drag.centers = drag.rows.map(function (r) {
      var b = r.getBoundingClientRect();
      return b.top - listTop + drag.scroll + b.height / 2;
    });
    drag.rows.forEach(function (r) { r.classList.add('fa-moving'); });
    drag.row.classList.add('fa-dragged');
    document.documentElement.classList.add('fa-drag');
    try { drag.row.setPointerCapture(drag.id); } catch (err) {}
    drag.timer = setInterval(autoScroll, 16);
  }

  // 位置都按列表内容坐标算：鼠标位移 + 列表滚动位移
  function layoutDrag() {
    var offset = drag.y - drag.startY + drag.list.scrollTop - drag.scroll;
    var center = drag.centers[drag.from] + offset, from = drag.from, to = 0;
    drag.centers.forEach(function (c, i) { if (i !== from && c < center) to++; });
    drag.to = to;
    drag.rows.forEach(function (r, i) {
      var shift = 0;
      if (i === from) shift = offset;
      else if (from < to && i > from && i <= to) shift = -drag.height;
      else if (to < from && i >= to && i < from) shift = drag.height;
      r.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
    });
  }

  // 拖到列表上下边缘时自动滚动，离边缘越远滚得越快
  function autoScroll() {
    if (!drag || !drag.active) return;
    var r = drag.list.getBoundingClientRect(), edge = 48, step = 0;
    if (drag.y < r.top + edge) step = -Math.min(30, Math.ceil((r.top + edge - drag.y) / 4));
    else if (drag.y > r.bottom - edge) step = Math.min(30, Math.ceil((drag.y - r.bottom + edge) / 4));
    if (step) drag.list.scrollTop += step;
    layoutDrag();
  }

  function endDrag(e, commit) {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    var d = drag;
    drag = null;
    clearInterval(d.timer);
    document.documentElement.classList.remove('fa-drag');
    d.rows.forEach(function (r) {
      r.classList.remove('fa-moving', 'fa-dragged');
      r.style.transform = '';
    });
    if (!d.active) return;
    suppressClick = true;
    setTimeout(function () { suppressClick = false; }, 0);
    var store = watchStore();
    if (commit && d.to !== d.from && store && store.list.length === d.rows.length) {
      var ids = store.list.map(function (it) { return String(it.stockId); });
      ids.splice(d.to, 0, ids.splice(d.from, 1)[0]);
      var byId = {};
      local.entries.forEach(function (it) { byId[String(it.stockId)] = it; });
      local.entries = ids.map(function (id) { return byId[id]; }).filter(Boolean);
      rebuildItems();
      emit('localMove', ids);
    }
    local.dirty = true;
    if (applyLocal()) local.dirty = false;
  }

  function syncLocalView(modal) {
    if (!local.loaded) return;
    if (local.dirty && !dragging() && applyLocal()) local.dirty = false;
    if (local.mode !== 'local') return;
    var h3 = modal.querySelector('.header h3');
    if (h3 && !h3.dataset.faTitle) {
      var font = getComputedStyle(h3);
      h3.style.setProperty('--fa-h3-size', font.fontSize);
      h3.style.setProperty('--fa-h3-weight', font.fontWeight);
      h3.style.setProperty('--fa-h3-family', font.fontFamily);
      h3.dataset.faTitle = '本地自选';
    }
    document.documentElement.classList.toggle('fa-local-empty', local.loaded && local.items.length === 0);
  }

  if (role === 'watch') {
    setInterval(function () {
      var modal = document.querySelector('section.watchlist-modal');
      if (modal) {
        patchWatch(modal);
        syncLocalView(modal);
        return;
      }
      var btn = document.querySelector('section.tool-bar li.gap-item .tb-item');
      if (btn && !btn.classList.contains('active')) btn.click();
    }, 300);
  }

  // 右侧切换个股：临时实例化一个不挂载的 WatchListModal，直接调用它的 stockClick，
  // 由站点自己更新个股 store、重置各模块数据并 router.push，和在站点里点自选条目完全一致。
  handlers.go = function (item) {
    var app = appVm();
    if (role !== 'detail' || !app || !item) return false;
    try {
      var Modal = app.$options._base.extend(app._setupState.WatchListModal);
      var modal = new Modal({ parent: app });
      modal._setupState.stockClick(item);
      modal.$destroy();
      return true;
    } catch (e) {
      console.error(e);
      return false;
    }
  };

  // 站点有个全局轮询模块：各模块（个股报价、分时图、资金、市场页榜单…）把刷新回调注册进去，
  // 它每 60 秒跑一遍；导出的 Ew() 立即全跑一遍（就是个股页「刷新」按钮）。模块不挂在 window 上，
  // 借 webpack 的 chunk 回调拿到 __webpack_require__，按导出特征找到它。
  var poller;
  function sitePoller() {
    if (poller !== undefined) return poller;
    var chunk = window.webpackChunk_futu_official_quote_client, req = null;
    if (!chunk || !rootVm()) return null;
    poller = null;
    try {
      chunk.push([['fa-poller-' + Date.now()], {}, function (r) { req = r; }]);
      var ids = Object.keys((req && req.m) || {}), sig = /\bEw:function[\s\S]*\bqk:function[\s\S]*\bxH:function/;
      ids.sort(function (a, b) { return (b === '39377') - (a === '39377'); });
      for (var i = 0; i < ids.length; i++) {
        var src = Function.prototype.toString.call(req.m[ids[i]]);
        if (src.length < 3000 && sig.test(src) && /6e4/.test(src)) {
          var mod = req(ids[i]);
          if (mod && typeof mod.Ew === 'function') { poller = mod; break; }
        }
      }
    } catch (e) {
      console.error(e);
    }
    return poller;
  }

  handlers.refresh = function () {
    if (role !== 'detail') return 'none';
    var p = sitePoller();
    if (p) p.Ew();
    return p ? 'site' : 'none';
  };

  handlers.back = function () {
    history.back();
    return true;
  };

  handlers.reload = function () {
    setTimeout(function () { location.reload(); }, 0);
    return true;
  };

  // ---------- 链接：左侧的任何跳转都交给扩展窗口在右侧打开；右侧只停留在个股页和市场页 ----------
  var STOCK_PATH_RE = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(stock|etfs|futures|index|options|currency|crypto|sectors)\/([^/?#]+)/i;
  var MARKET_PATH_RE = /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?quote(?:\/|$)/i;

  function stayInDetail(url) {
    return url.host === 'www.futunn.com' && (STOCK_PATH_RE.test(url.pathname) || MARKET_PATH_RE.test(url.pathname));
  }

  document.addEventListener('click', function (e) {
    if (!e.isTrusted || e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var url;
    try { url = new URL(a.href, location.href); } catch (err) { return; }
    if (!/^https?:$/.test(url.protocol)) return;
    if (role === 'watch' || a.target === '_blank' || !stayInDetail(url)) {
      e.preventDefault();
      emit('nav', url.href);
    }
  });

  // 站点 window.open 的新窗口（榜单、新闻等）同样交给扩展窗口处理
  var openWindow = window.open;
  window.open = function (href) {
    if (!href) return openWindow.apply(window, arguments);
    try { emit('nav', new URL(href, location.href).href); } catch (err) {}
    return null;
  };

  // 富途网关限流时接口返回 HTML「访问频繁」页面而不是 JSON，图表等模块会直接空白
  var blockedAt = 0;
  var xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    if (/\/quote-api\//.test(url)) {
      this.addEventListener('load', function () {
        if (!/json/.test(this.getResponseHeader('content-type') || '')) blockedAt = Date.now();
      });
    }
    return xhrOpen.apply(this, arguments);
  };

  // 未登录时点爱心 / 添加自选等按钮，站点会调用 $goLogin 弹出精简版注册框（gold-flow，
  // 在被隐藏的 #header 里）。用户刚点击过才算登录意图，交给扩展窗口打开完整登录页；
  // 没有点击就弹出来的是营销弹窗，保持隐藏即可。
  var lastClick = 0, loginRequested = false;
  document.addEventListener('click', function (e) {
    if (e.isTrusted) lastClick = Date.now();
  }, true);
  setInterval(function () {
    if (document.querySelector('.official-gold-flow.show-modal') && Date.now() - lastClick < 3000) {
      loginRequested = true;
      lastClick = 0;
    }
  }, 300);

  handlers.state = function () {
    var common = window.__COMMON || {};
    var text = document.body ? document.body.innerText.slice(0, 200) : '';
    var modal = document.querySelector('section.watchlist-modal');
    var wantLogin = loginRequested;
    loginRequested = false;
    var col = modal && modal.querySelector('.list-item .col.name');
    return {
      role: role,
      loginRequested: wantLogin,
      href: location.href,
      path: location.pathname,
      title: document.title,
      watch: !!modal,
      rows: modal ? modal.querySelectorAll('.list-item').length : 0,
      blocked: Date.now() - blockedAt < 5000,
      blockedAt: blockedAt,
      nameRight: col ? Math.ceil(col.getBoundingClientRect().right) : 0,
      ready: !!document.querySelector('section.tool-bar'),
      isLogin: common.isLogin === 'true',
      uid: String(common.uid || ''),
      waf: /"code"\s*:\s*-12011/.test(text),
    };
  };
})();
