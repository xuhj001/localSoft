"""
央视频 Windows 客户端（绿色免安装）

Edge WebView2 嵌入官网电视页，仅保留播放器 / 频道列表 / 节目单。
配置 / 资源 / 缓存 / 日志均在 exe 同目录，整夹拷贝即可用。
"""

from __future__ import annotations

import ctypes
import json
import os
import sys
import threading
import time
import urllib.request
from ctypes import wintypes


def _app_root() -> str:
    """程序目录（打包后为 exe 所在目录；开发时为源码目录）。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def _bundle_root() -> str:
    """只读资源目录（PyInstaller 解包目录或源码目录）。"""
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        return sys._MEIPASS  # type: ignore[attr-defined]
    return _app_root()


BASE_DIR = _app_root()
BUNDLE_DIR = _bundle_root()
ASSETS_DIR = os.path.join(BASE_DIR, "assets")
DATA_DIR = os.path.join(BASE_DIR, "data")
LOG_DIR = os.path.join(BASE_DIR, "logs")
TEMP_DIR = os.path.join(BASE_DIR, "temp")
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
LOG_PATH = os.path.join(LOG_DIR, "app.log")
WEBVIEW_STORAGE = os.path.join(DATA_DIR, "webview_storage")

LOGO_URL = "https://img.yangshipin.cn/assets/indexhlogo-l3sfhbu38mhy.png"
LOGO_PNG = os.path.join(ASSETS_DIR, "ysp_logo.png")
LOGO_ICO = os.path.join(ASSETS_DIR, "ysp_logo.ico")
TV_HOME = "https://www.yangshipin.cn/tv/home"

# 官网电视页固定：播放器 .tv-main-con-l-vid=890px + 频道栏 .tv-main-con-r=300px
PLAYER_W = 890
CHANNEL_W = 300
CONTENT_W = PLAYER_W + CHANNEL_W  # 1190：正好容下播放界面和频道列表
DEFAULT_H = 700  # 接近折叠节目单后的高度，减少启动闪白

user32 = ctypes.windll.user32
dwmapi = ctypes.windll.dwmapi
GWL_STYLE = -16
GWL_EXSTYLE = -20
SWP_FRAMECHANGED = 0x0020
SWP_SHOWWINDOW = 0x0040
SWP_NOZORDER = 0x0004
HWND_TOP = 0
WS_CAPTION = 0x00C00000
WS_THICKFRAME = 0x00040000
WS_MINIMIZEBOX = 0x00020000
WS_MAXIMIZEBOX = 0x00010000
WS_SYSMENU = 0x00080000
WS_BORDER = 0x00800000
WS_VISIBLE = 0x10000000
WS_POPUP = 0x80000000
WS_EX_DLGMODALFRAME = 0x00000001
WS_EX_WINDOWEDGE = 0x00000100
WS_EX_CLIENTEDGE = 0x00000200
WS_EX_STATICEDGE = 0x00020000
MONITOR_DEFAULTTONEAREST = 2
SW_RESTORE = 9
DWMWA_WINDOW_CORNER_PREFERENCE = 33
DWMWA_BORDER_COLOR = 34
DWMWCP_DONOTROUND = 1
DWMWA_COLOR_NONE = 0xFFFFFFFE
DWMWA_COLOR_DEFAULT = 0xFFFFFFFF


class RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


class MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("rcMonitor", RECT),
        ("rcWork", RECT),
        ("dwFlags", wintypes.DWORD),
    ]


CLEAN_JS = r"""
(function () {
  if (window.__yspAppHooksInstalled) return 'already';
  window.__yspAppHooksInstalled = true;

  var STYLE_ID = 'ysp-app-clean-style';

  var CSS = `
    /* 站点顶栏、页脚、挂件等全部隐藏（保留 .tv 播放/频道 与 .tv-zhan 节目单） */
    .header,
    .header-fixed,
    .comPadding > .header,
    .tv-home > .header,
    .tv-home > .max-footer,
    .max-footer,
    .footer,
    .public,
    .own-toast {
      display: none !important;
    }

    /* 去掉给顶栏预留的空白 */
    html, body, #app {
      margin: 0 !important;
      padding: 0 !important;
      background: #fff !important;
    }
    .comPadding,
    .comPadding1 {
      padding-top: 0 !important;
      margin-top: 0 !important;
      margin: 0 !important;
    }

    /* 全屏时去掉最外层方框线 / 描边 */
    html:has(body.ysp-window-fs),
    body.ysp-window-fs,
    body.ysp-window-fs #app,
    body.ysp-window-fs .comPadding,
    body.ysp-window-fs .tv-home,
    body.ysp-window-fs .tv-main-con,
    body.ysp-window-fs .y-player,
    body.ysp-window-fs .y-full,
    body.ysp-window-fs video {
      border: 0 !important;
      outline: 0 !important;
      box-shadow: none !important;
    }
    body.ysp-window-fs {
      margin: 0 !important;
      background: #000 !important;
      overflow: hidden !important;
    }

    /* 节目单收起时不占位、不留白 */
    .tv-zhan-list:not(.height) {
      display: none !important;
      height: 0 !important;
      margin: 0 !important;
      padding: 0 !important;
      overflow: hidden !important;
    }
    html, body {
      overflow-x: hidden !important;
    }
  `;

  function callApi(name, arg) {
    try {
      if (window.pywebview && window.pywebview.api && window.pywebview.api[name]) {
        var r = (typeof arg === 'undefined')
          ? window.pywebview.api[name]()
          : window.pywebview.api[name](arg);
        if (r && r.then) r.catch(function () {});
      }
    } catch (e) {}
  }

  function ensureStyle() {
    var s = document.getElementById(STYLE_ID);
    if (!s) {
      s = document.createElement('style');
      s.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(s);
    }
    s.textContent = CSS;
  }

  var lastPlayerFs = false;
  var wantOsFs = false;   // 仅在用户点击全屏按钮后为 true
  var bootUntil = Date.now() + 4000;

  function isPlayerFs() {
    if (document.fullscreenElement || document.webkitFullscreenElement) return true;
    var nodes = document.getElementsByClassName('y-full');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].classList && nodes[i].classList.contains('y-full')) return true;
    }
    return false;
  }

  function doEnter() {
    if (!wantOsFs) return;
    document.body.classList.add('ysp-window-fs');
    // allow_enter 会清掉 Esc 后的短暂禁入
    callApi('allow_enter');
  }

  function exitOsOnly() {
    wantOsFs = false;
    document.body.classList.remove('ysp-window-fs');
    callApi('exit_fullscreen');
    lastPlayerFs = isPlayerFs();
  }

  function sync() {
    // 启动阶段只对齐状态，绝不进入 OS 全屏
    if (Date.now() < bootUntil) {
      lastPlayerFs = isPlayerFs();
      wantOsFs = false;
      document.body.classList.remove('ysp-window-fs');
      return;
    }

    var fs = isPlayerFs();
    var nativeFs = !!(document.fullscreenElement || document.webkitFullscreenElement);

    if (fs && !lastPlayerFs) {
      // 只有用户点过全屏按钮（wantOsFs）才跟进窗口全屏
      if (wantOsFs) doEnter();
    } else if (!fs && lastPlayerFs) {
      // 播放器已退出（含最后一个按钮的原生全屏结束）→ 同步退 OS
      exitOsOnly();
    } else if (!nativeFs && !fs && (wantOsFs || document.body.classList.contains('ysp-window-fs'))) {
      exitOsOnly();
    } else if (fs && wantOsFs) {
      callApi('allow_enter');
    } else if (fs && !wantOsFs) {
      document.body.classList.remove('ysp-window-fs');
    } else if (!fs) {
      callApi('remember_geometry');
    }

    lastPlayerFs = fs;
  }

  ensureStyle();
  setInterval(sync, 250);

  // —— 默认最高画质（.bei-list：蓝光1080P / 超清720P / 高清540P …）——
  var qualityDoneKey = '';
  var qualityUserOverride = false;

  function qualityScore(text) {
    text = String(text || '');
    if (/4\s*K|2160/i.test(text)) return 2160;
    var m = text.match(/(\d+)\s*[Pp]/);
    if (m) return parseInt(m[1], 10);
    if (/蓝光/.test(text)) return 1080;
    if (/超清/.test(text)) return 720;
    if (/高清/.test(text)) return 540;
    if (/标清|流畅/.test(text)) return 360;
    if (/自动/.test(text)) return 1;
    return 0;
  }

  function pickHighestQuality(force) {
    if (qualityUserOverride && !force) return false;
    var items = Array.prototype.slice.call(
      document.querySelectorAll('.bei-list-inner .item, .y-control-outside-slclist .item')
    );
    if (!items.length) return false;

    var best = null;
    var bestScore = -1;
    for (var i = 0; i < items.length; i++) {
      var t = (items[i].innerText || '').replace(/\s+/g, ' ').trim();
      var s = qualityScore(t);
      if (s > bestScore) {
        bestScore = s;
        best = items[i];
      }
    }
    if (!best || bestScore <= 0) return false;
    if (best.classList.contains('active')) {
      qualityDoneKey = bestScore + ':' + (best.innerText || '').trim();
      return true;
    }

    var bei = document.querySelector('.bei');
    try {
      if (bei) {
        bei.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        bei.click();
      }
    } catch (e) {}
    try {
      best.click();
    } catch (e2) {
      return false;
    }
    // 点完收起菜单（再点一次画质按钮）
    setTimeout(function () {
      try {
        if (bei) bei.click();
      } catch (e3) {}
    }, 80);
    qualityDoneKey = bestScore + ':' + (best.innerText || '').trim();
    return true;
  }

  function ensureHighestQuality() {
    if (qualityUserOverride) return;
    pickHighestQuality(false);
  }

  setTimeout(ensureHighestQuality, 1500);
  setTimeout(ensureHighestQuality, 3000);
  setTimeout(ensureHighestQuality, 6000);
  setInterval(ensureHighestQuality, 4000);

  // —— 节目单默认折叠，点击「节目单」再展开；窗口高度跟着收窄/加高 ——
  var epgPreferCollapsed = true;
  var lastFitBottom = -1;

  function isEpgExpanded() {
    var list = document.querySelector('.tv-zhan-list');
    return !!(list && list.classList.contains('height'));
  }

  function clickEpgToggle() {
    var kai = document.querySelector('.tv-zhan-kai');
    if (kai) {
      try { kai.click(); } catch (e) {}
    }
  }

  function contentBottomPx() {
    // 折叠：贴到节目单标题栏底；展开：贴到节目详单底
    var list = document.querySelector('.tv-zhan-list');
    var con = document.querySelector('.tv-zhan-con');
    var zhan = document.querySelector('.tv-zhan');
    var tv = document.querySelector('.tv') || document.querySelector('.tv-main-con');
    if (isEpgExpanded() && list) {
      return Math.ceil(list.getBoundingClientRect().bottom);
    }
    if (con) return Math.ceil(con.getBoundingClientRect().bottom);
    if (zhan) return Math.ceil(zhan.getBoundingClientRect().bottom);
    if (tv) return Math.ceil(tv.getBoundingClientRect().bottom);
    return 0;
  }

  function syncWindowHeight(force) {
    if (document.body.classList.contains('ysp-window-fs')) return;
    var bottom = contentBottomPx();
    if (bottom < 420) return;
    if (!force && Math.abs(bottom - lastFitBottom) < 4) return;
    lastFitBottom = bottom;
    callApi('fit_content_height', bottom);
  }

  function ensureEpgCollapsed() {
    if (!epgPreferCollapsed) {
      syncWindowHeight(false);
      return;
    }
    if (isEpgExpanded()) {
      clickEpgToggle();
      setTimeout(function () { syncWindowHeight(true); }, 120);
      setTimeout(function () { syncWindowHeight(true); }, 350);
    } else {
      syncWindowHeight(false);
    }
  }

  // 页面可能晚渲染 / 切台后重开节目单：偏好折叠时自动收起
  setInterval(ensureEpgCollapsed, 500);
  setTimeout(ensureEpgCollapsed, 800);
  setTimeout(ensureEpgCollapsed, 2000);
  setTimeout(ensureEpgCollapsed, 4000);

  document.addEventListener('click', function (e) {
    var t = e.target;
    // 用户手动改画质：尊重选择，不再强切最高
    if (t && t.closest && t.closest('.bei-list .item, .bei-list-inner .item')) {
      qualityUserOverride = true;
      return;
    }
    // 切台后画质可能被重置，重新选最高
    if (t && t.closest && t.closest('.tv-main-con-r-list, .tv-main-con-r-list-left')) {
      qualityUserOverride = false;
      setTimeout(ensureHighestQuality, 800);
      setTimeout(ensureHighestQuality, 2000);
      setTimeout(ensureHighestQuality, 4000);
    }
    // 用户点「节目单」：记下展开/折叠偏好，并同步窗口高度
    var kai = t && t.closest ? t.closest('.tv-zhan-kai') : null;
    if (kai) {
      setTimeout(function () {
        epgPreferCollapsed = !isEpgExpanded();
        syncWindowHeight(true);
      }, 100);
      setTimeout(function () { syncWindowHeight(true); }, 350);
      return;
    }
    var hit = t && t.closest
      ? t.closest('.y-full-control .full, .full.full2, .videoFull, button.full, .full')
      : null;
    if (!hit) return;
    wantOsFs = true;
    setTimeout(function () {
      if (isPlayerFs()) doEnter();
      sync();
    }, 80);
    setTimeout(sync, 250);
    setTimeout(sync, 500);
  }, true);

  function onNativeFsChange() {
    sync();
    // 最后一个全屏按钮常用 Fullscreen API：原生全屏一结束就退 OS
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
      if (wantOsFs || document.body.classList.contains('ysp-window-fs')) {
        exitOsOnly();
      }
    }
  }
  document.addEventListener('fullscreenchange', onNativeFsChange, true);
  document.addEventListener('webkitfullscreenchange', onNativeFsChange, true);

  // 捕获阶段监听 Esc：避免最后一个按钮把事件吃掉后窗口退不了
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' || e.keyCode === 27) {
      exitOsOnly();
      // 不 stopPropagation / preventDefault，让播放器继续处理退视频全屏
    }
  }, true);

  return 'ok';
})();
"""


_WINDOW_REF: dict[str, object] = {"window": None}


class WindowBridge:
    """显式进入/退出全屏（不用 toggle），状态清晰可重复。"""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._fullscreen = False
        self._saved: dict | None = None
        self._last_good: dict | None = None

    def _window(self):
        return _WINDOW_REF["window"]

    def _hwnd(self) -> int | None:
        window = self._window()
        native = getattr(window, "native", None) if window else None
        if native is None:
            return None
        try:
            return int(native.Handle.ToInt32())
        except Exception:
            return None

    def _default_geo(self) -> dict:
        return {
            "style": int(
                WS_VISIBLE
                | WS_CAPTION
                | WS_THICKFRAME
                | WS_SYSMENU
                | WS_MINIMIZEBOX
                | WS_MAXIMIZEBOX
            ),
            "x": 80,
            "y": 80,
            "w": CONTENT_W,
            "h": DEFAULT_H,
        }

    def fit_player_channel_width(self) -> bool:
        """客户区宽度 = 播放器 890 + 频道栏 300（只用 Win32，避免 pywebview.resize 二次放大）。"""
        return self._fit_outer(width=True, content_bottom=None)

    def fit_content_height(self, content_bottom: float | int = 0) -> bool:
        """客户区高度贴合页面内容底边（折叠节目单后收窄窗口）。"""
        return self._fit_outer(width=True, content_bottom=content_bottom)

    def _fit_outer(
        self, width: bool = True, content_bottom: float | int | None = None
    ) -> bool:
        hwnd = self._hwnd()
        if hwnd is None:
            return False
        with self._lock:
            if self._fullscreen:
                return False
            if user32.IsZoomed(hwnd):
                user32.ShowWindow(hwnd, SW_RESTORE)
            wr, cr = RECT(), RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(wr))
            user32.GetClientRect(hwnd, ctypes.byref(cr))
            chrome_h = int(wr.bottom - wr.top) - int(cr.bottom - cr.top)
            if chrome_h < 20:
                chrome_h = 40
            try:
                dpi = int(user32.GetDpiForWindow(hwnd))
            except Exception:
                dpi = 96
            scale = dpi / 96.0
            _, _, mw, mh = self._monitor(hwnd)

            outer_w = self._fitted_outer_width(hwnd) if width else int(wr.right - wr.left)
            if content_bottom is not None:
                bottom = int(round(float(content_bottom)))
                if bottom < 400:
                    return False
                client_h = int(round(bottom * scale))
                outer_h = client_h + chrome_h
                # 防双重缩放撑满屏
                if outer_h >= mh - 24:
                    outer_h = bottom + chrome_h
                if outer_h >= mh - 24:
                    outer_h = max(500, mh - 40)
                # 折叠态通常 < 780 CSS；展开可更大但不超过工作区
                if bottom < 780 and outer_h > int(round(780 * scale)) + chrome_h + 40:
                    outer_h = int(round(bottom * scale)) + chrome_h
            else:
                outer_h = int(wr.bottom - wr.top)
                if outer_h > mh - 40:
                    outer_h = max(540, mh - 80)

            if outer_w > mw - 20:
                outer_w = min(outer_w, mw - 40)
            x = int(wr.left)
            y = int(wr.top)
            if x + outer_w > mw:
                x = max(0, mw - outer_w)
            if y + outer_h > mh:
                y = max(0, mh - outer_h)
            user32.SetWindowPos(
                hwnd,
                HWND_TOP,
                x,
                y,
                outer_w,
                outer_h,
                SWP_NOZORDER | SWP_SHOWWINDOW | SWP_FRAMECHANGED,
            )
            cap = self._capture(hwnd)
            if cap is not None:
                self._last_good = cap
            return True

    def _fitted_outer_width(self, hwnd: int) -> int:
        """窗口外框宽度，使客户区正好 = CONTENT_W（与当前坐标单位一致，避免 DPI 双重缩放）。"""
        wr, cr = RECT(), RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(wr))
        user32.GetClientRect(hwnd, ctypes.byref(cr))
        outer = int(wr.right - wr.left)
        client = int(cr.right - cr.left)
        chrome_w = outer - client
        if chrome_w < 8:
            chrome_w = 16
        try:
            dpi = int(user32.GetDpiForWindow(hwnd))
        except Exception:
            dpi = 96
        # 用「当前客户区 / 逻辑宽度」估缩放；若客户区已接近屏宽则回退到 DPI
        scale = dpi / 96.0
        if client > 200 and not self._screen_like(hwnd, outer, int(wr.bottom - wr.top)):
            # 当前客户区对应的逻辑宽度 ≈ client/scale；目标按同一 scale
            pass
        client_w = int(round(CONTENT_W * scale))
        # 防止算出来接近全屏（双重缩放时常见）
        _, _, mw, _ = self._monitor(hwnd)
        target = client_w + chrome_w
        if target >= mw - 48:
            # 多半是单位错了，改按未缩放 CONTENT_W + chrome
            target = CONTENT_W + chrome_w
            if target >= mw - 48:
                target = max(600, mw - 80)
        return target

    def _monitor(self, hwnd: int) -> tuple[int, int, int, int]:
        hmon = user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
        info = MONITORINFO()
        info.cbSize = ctypes.sizeof(MONITORINFO)
        if not user32.GetMonitorInfoW(hmon, ctypes.byref(info)):
            return 0, 0, 1920, 1080
        r = info.rcMonitor
        return int(r.left), int(r.top), int(r.right - r.left), int(r.bottom - r.top)

    def _screen_like(self, hwnd: int, w: int, h: int) -> bool:
        _, _, mw, mh = self._monitor(hwnd)
        return w >= mw - 48 and h >= mh - 48

    def _capture(self, hwnd: int) -> dict | None:
        if user32.IsZoomed(hwnd):
            return None
        style = int(user32.GetWindowLongW(hwnd, GWL_STYLE))
        if (style & WS_CAPTION) == 0:
            return None
        rc = RECT()
        user32.GetWindowRect(hwnd, ctypes.byref(rc))
        x, y = int(rc.left), int(rc.top)
        w, h = int(rc.right - rc.left), int(rc.bottom - rc.top)
        if w < 500 or h < 360 or self._screen_like(hwnd, w, h):
            return None
        style |= WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX
        style &= ~WS_POPUP
        return {"style": style, "x": x, "y": y, "w": w, "h": h}

    def _restore_target(self, hwnd: int) -> dict:
        for geo in (self._saved, self._last_good):
            if not geo:
                continue
            w, h = int(geo["w"]), int(geo["h"])
            if w >= 500 and h >= 360 and not self._screen_like(hwnd, w, h):
                out = dict(geo)
                out["style"] = int(out.get("style", 0)) | self._default_geo()["style"]
                out["style"] &= ~WS_POPUP
                return out
        return self._default_geo()

    def _set_dwm_border(self, hwnd: int, hide: bool) -> None:
        """Win10/11 无边框窗口仍可能有 DWM 细边框，全屏时关掉。"""
        try:
            if hide:
                color = ctypes.c_uint(DWMWA_COLOR_NONE)
                corner = ctypes.c_int(DWMWCP_DONOTROUND)
            else:
                color = ctypes.c_uint(DWMWA_COLOR_DEFAULT)
                corner = ctypes.c_int(0)  # default
            dwmapi.DwmSetWindowAttribute(
                hwnd,
                DWMWA_BORDER_COLOR,
                ctypes.byref(color),
                ctypes.sizeof(color),
            )
            dwmapi.DwmSetWindowAttribute(
                hwnd,
                DWMWA_WINDOW_CORNER_PREFERENCE,
                ctypes.byref(corner),
                ctypes.sizeof(corner),
            )
        except Exception:
            pass

    def _apply_form_borderless(self, borderless: bool) -> None:
        form = getattr(self._window(), "native", None) if self._window() else None
        if form is None:
            return
        try:
            from System.Windows.Forms import FormBorderStyle, Padding

            def _apply() -> None:
                if borderless:
                    form.FormBorderStyle = getattr(FormBorderStyle, "None")
                    try:
                        form.Padding = Padding(0)
                    except Exception:
                        pass
                else:
                    form.FormBorderStyle = FormBorderStyle.Sizable

            if getattr(form, "InvokeRequired", False):
                from System import Action

                form.BeginInvoke(Action(_apply))
            else:
                _apply()
        except Exception:
            pass

    def remember_geometry(self) -> bool:
        hwnd = self._hwnd()
        if hwnd is None or self._fullscreen:
            return False
        with self._lock:
            cap = self._capture(hwnd)
            if cap is not None:
                self._last_good = cap
                return True
        return False

    def allow_enter(self) -> bool:
        """用户主动点全屏后进入 OS 全屏。"""
        return self._do_enter()

    def _do_enter(self) -> bool:
        hwnd = self._hwnd()
        if hwnd is None:
            return False

        with self._lock:
            style = int(user32.GetWindowLongW(hwnd, GWL_STYLE))
            if self._fullscreen and ((style & WS_POPUP) != 0 or (style & WS_CAPTION) == 0):
                # 已全屏时再刷一次去边框，防止 DWM 细线残留
                self._set_dwm_border(hwnd, True)
                return True

            if self._saved is None:
                cap = self._capture(hwnd)
                if cap is not None:
                    self._last_good = cap
                self._saved = dict(self._last_good or self._default_geo())

            try:
                if user32.IsZoomed(hwnd):
                    user32.ShowWindow(hwnd, SW_RESTORE)

                # 真正无边框：POPUP 窗口（Overlapped 即使去 caption 也常留细线）
                user32.SetWindowLongW(hwnd, GWL_STYLE, int(WS_POPUP | WS_VISIBLE))

                ex = int(user32.GetWindowLongW(hwnd, GWL_EXSTYLE))
                ex &= ~(
                    WS_EX_CLIENTEDGE
                    | WS_EX_WINDOWEDGE
                    | WS_EX_STATICEDGE
                    | WS_EX_DLGMODALFRAME
                )
                user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex)

                self._apply_form_borderless(True)
                self._set_dwm_border(hwnd, True)

                mx, my, mw, mh = self._monitor(hwnd)
                # 略微外扩 1px，盖住 Windows 仍可能画出的 1px 边线
                user32.SetWindowPos(
                    hwnd,
                    HWND_TOP,
                    mx - 1,
                    my - 1,
                    mw + 2,
                    mh + 2,
                    SWP_FRAMECHANGED | SWP_SHOWWINDOW,
                )
                self._fullscreen = True
                return True
            except Exception as exc:
                print("进入全屏失败:", exc, file=sys.stderr)
                return False

    def exit_fullscreen(self) -> bool:
        hwnd = self._hwnd()
        if hwnd is None:
            return False

        with self._lock:
            style = int(user32.GetWindowLongW(hwnd, GWL_STYLE))
            has_caption = (style & WS_CAPTION) != 0
            if not self._fullscreen and has_caption:
                rc = RECT()
                user32.GetWindowRect(hwnd, ctypes.byref(rc))
                w = int(rc.right - rc.left)
                h = int(rc.bottom - rc.top)
                if not self._screen_like(hwnd, w, h):
                    return True

            geo = self._restore_target(hwnd)
            x, y = int(geo["x"]), int(geo["y"])
            h = int(geo["h"])
            style = int(geo["style"]) | self._default_geo()["style"]
            style &= ~WS_POPUP
            _, _, mw, mh = self._monitor(hwnd)
            # 高度用进入全屏前的，但不超过工作区
            if h > mh - 40 or self._screen_like(hwnd, mw, h):
                h = min(int(geo["h"]), max(540, mh - 80))
            if h < 500:
                h = min(DEFAULT_H, max(540, mh - 80))

            try:
                if user32.IsZoomed(hwnd):
                    user32.ShowWindow(hwnd, SW_RESTORE)

                cur = int(user32.GetWindowLongW(hwnd, GWL_STYLE))
                cur &= ~(WS_CAPTION | WS_THICKFRAME | WS_BORDER | WS_POPUP)
                user32.SetWindowLongW(hwnd, GWL_STYLE, cur)

                # 先恢复标题栏样式，再按贴合宽度定尺寸（勿把物理像素传给 window.resize）
                user32.SetWindowLongW(hwnd, GWL_STYLE, style)
                ex = int(user32.GetWindowLongW(hwnd, GWL_EXSTYLE))
                ex |= WS_EX_WINDOWEDGE
                user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex)
                self._set_dwm_border(hwnd, False)
                self._apply_form_borderless(False)

                w = self._fitted_outer_width(hwnd)
                if x + w > mw:
                    x = max(0, mw - w)
                if y + h > mh:
                    y = max(0, mh - h)
                user32.SetWindowPos(
                    hwnd, HWND_TOP, x, y, w, h, SWP_FRAMECHANGED | SWP_SHOWWINDOW
                )

                self._fullscreen = False
                self._saved = None
                # 再贴合一次宽度（内部会 SW_RESTORE，不用 pywebview.resize）
                self.fit_player_channel_width()
                cap = self._capture(hwnd)
                if cap is not None:
                    self._last_good = cap
                else:
                    rc = RECT()
                    user32.GetWindowRect(hwnd, ctypes.byref(rc))
                    self._last_good = {
                        "style": style,
                        "x": int(rc.left),
                        "y": int(rc.top),
                        "w": int(rc.right - rc.left),
                        "h": int(rc.bottom - rc.top),
                    }
                return True
            except Exception as exc:
                print("退出全屏失败:", exc, file=sys.stderr)
                return False

    def hook_form(self) -> None:
        hwnd = self._hwnd()
        if hwnd is None:
            return
        with self._lock:
            self._fullscreen = False
            self._saved = None
            if user32.IsZoomed(hwnd):
                user32.ShowWindow(hwnd, SW_RESTORE)
            cap = self._capture(hwnd)
            if cap is not None:
                self._last_good = cap
        # 打开时宽度贴合播放器 + 频道列表
        self.fit_player_channel_width()


def ensure_runtime_dirs() -> None:
    """配置 / 缓存 / 日志 / 临时目录一律放在程序目录下。"""
    for path in (ASSETS_DIR, DATA_DIR, LOG_DIR, TEMP_DIR, WEBVIEW_STORAGE):
        os.makedirs(path, exist_ok=True)
        # 打包资源里的 logo 复制到程序目录（可写）
    for name in ("ysp_logo.png", "ysp_logo.ico"):
        dst = os.path.join(ASSETS_DIR, name)
        if os.path.isfile(dst):
            continue
        for root in (BUNDLE_DIR, os.path.join(BUNDLE_DIR, "assets"), ASSETS_DIR):
            src = os.path.join(root, name)
            if os.path.isfile(src) and os.path.abspath(src) != os.path.abspath(dst):
                try:
                    import shutil

                    shutil.copy2(src, dst)
                except Exception:
                    pass
                break


def load_config() -> dict:
    ensure_runtime_dirs()
    if not os.path.isfile(CONFIG_PATH):
        cfg = {"tv_home": TV_HOME, "version": 1}
        save_config(cfg)
        return cfg
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def save_config(cfg: dict) -> None:
    ensure_runtime_dirs()
    try:
        with open(CONFIG_PATH, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
    except Exception as exc:
        print("写入配置失败:", exc, file=sys.stderr)


def setup_logging() -> None:
    ensure_runtime_dirs()
    if not getattr(sys, "frozen", False):
        return
    try:
        # 写程序目录 logs\
        log_f = open(LOG_PATH, "a", encoding="utf-8", buffering=1)
        sys.stderr = log_f  # type: ignore[assignment]
        print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] start root={BASE_DIR}", file=log_f)
    except Exception:
        pass


def ensure_logo_assets() -> str | None:
    ensure_runtime_dirs()
    if not os.path.isfile(LOGO_PNG):
        try:
            urllib.request.urlretrieve(LOGO_URL, LOGO_PNG)
        except Exception as exc:
            print("下载 logo 失败:", exc, file=sys.stderr)
            return None
    if not os.path.isfile(LOGO_ICO):
        try:
            Image = __import__("PIL.Image", fromlist=["Image"]).Image
        except Exception as exc:
            print("缺少 Pillow，跳过生成 ico:", exc, file=sys.stderr)
            return LOGO_PNG if os.path.isfile(LOGO_PNG) else None
        try:
            im = Image.open(LOGO_PNG).convert("RGBA")
            h = im.height
            mark = im.crop((0, 0, min(h, im.width), h))
            sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
            imgs = [mark.resize(s, Image.Resampling.LANCZOS) for s in sizes]
            imgs[-1].save(
                LOGO_ICO,
                format="ICO",
                sizes=[(i.width, i.height) for i in imgs],
                append_images=imgs[:-1],
            )
        except Exception as exc:
            print("生成 ico 失败:", exc, file=sys.stderr)
            return LOGO_PNG if os.path.isfile(LOGO_PNG) else None
    return LOGO_ICO if os.path.isfile(LOGO_ICO) else (
        LOGO_PNG if os.path.isfile(LOGO_PNG) else None
    )


def main() -> None:
    try:
        import webview
    except ImportError as e:
        raise SystemExit("缺少 pywebview，请先执行:\n  pip install pywebview") from e

    # 绿色版：以 exe（或源码）所在目录为工作目录，配置/缓存/日志都落在旁边
    os.chdir(BASE_DIR)
    ensure_runtime_dirs()
    setup_logging()
    load_config()
    os.environ["TEMP"] = TEMP_DIR
    os.environ["TMP"] = TEMP_DIR
    os.environ["TMPDIR"] = TEMP_DIR

    icon_path = ensure_logo_assets()
    bridge = WindowBridge()

    window = webview.create_window(
        "央视频",
        TV_HOME,
        width=CONTENT_W,
        height=DEFAULT_H,
        min_size=(CONTENT_W, 500),
        text_select=True,
        js_api=bridge,
        fullscreen=False,
        maximized=False,
    )
    _WINDOW_REF["window"] = window

    def on_loaded():
        try:
            window.evaluate_js(CLEAN_JS)
        except Exception as exc:
            print("注入失败:", exc, file=sys.stderr)
        # 页面布局稳定后再贴合一次宽度
        def _refit():
            time.sleep(1.2)
            try:
                bridge.fit_player_channel_width()
            except Exception:
                pass

        threading.Thread(target=_refit, daemon=True).start()

    def on_shown():
        bridge.hook_form()

    window.events.loaded += on_loaded
    window.events.shown += on_shown

    start_kwargs = {
        "gui": "edgechromium",
        "debug": False,
        "private_mode": False,
        "storage_path": WEBVIEW_STORAGE,
    }
    if icon_path:
        start_kwargs["icon"] = icon_path

    try:
        webview.start(**start_kwargs)
    except Exception as exc:
        print("Edge 启动失败，尝试默认后端:", exc, file=sys.stderr)
        start_kwargs.pop("gui", None)
        webview.start(**start_kwargs)


if __name__ == "__main__":
    main()
