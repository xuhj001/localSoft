"""
抖音本地版

用 Edge WebView2 播放本地文件夹视频，上/下滑切换。
"""

from __future__ import annotations

import json
import mimetypes
import os
import socket
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

def app_dir() -> Path:
    """可写根目录：开发时用项目目录；打包后用 exe 所在目录。"""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def resource_dir() -> Path:
    """只读资源目录（web / 图标等）。"""
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return Path(meipass)
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


BASE_DIR = app_dir()
WEB_DIR = resource_dir() / "web"
DEFAULT_VIDEOS = BASE_DIR / "videos"
CONFIG_PATH = BASE_DIR / "data" / "config.json"
ICON_PATH = resource_dir() / "assets" / "app.ico"

VIDEO_EXTS = {".mp4", ".webm", ".mkv", ".mov", ".avi", ".m4v"}

_state = {
    "folder": str(DEFAULT_VIDEOS),
    "port": 0,
}


def bind_to_exe_dir() -> Path:
    """工作目录固定为 exe（或源码）所在目录，路径/相对文件都相对这里。"""
    global BASE_DIR, WEB_DIR, DEFAULT_VIDEOS, CONFIG_PATH, ICON_PATH
    root = app_dir()
    try:
        os.chdir(root)
    except OSError:
        pass
    BASE_DIR = root
    WEB_DIR = resource_dir() / "web"
    DEFAULT_VIDEOS = BASE_DIR / "videos"
    CONFIG_PATH = BASE_DIR / "data" / "config.json"
    ICON_PATH = resource_dir() / "assets" / "app.ico"
    _state["folder"] = str(DEFAULT_VIDEOS)
    return root


def ensure_dirs() -> None:
    DEFAULT_VIDEOS.mkdir(parents=True, exist_ok=True)
    (BASE_DIR / "data").mkdir(parents=True, exist_ok=True)
    (BASE_DIR / "logs").mkdir(parents=True, exist_ok=True)


def load_config() -> dict:
    ensure_dirs()
    if CONFIG_PATH.is_file():
        try:
            return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"folder": str(DEFAULT_VIDEOS)}


def save_config(cfg: dict) -> None:
    ensure_dirs()
    CONFIG_PATH.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


def list_videos(folder: str) -> list[dict]:
    root = Path(folder)
    if not root.is_dir():
        return []
    items: list[dict] = []
    try:
        paths = sorted(root.rglob("*"))
    except OSError:
        return []
    for p in paths:
        try:
            if not p.is_file():
                continue
            if p.suffix.lower() not in VIDEO_EXTS:
                continue
            rel = p.relative_to(root).as_posix()
            items.append(
                {
                    "id": quote(rel, safe=""),
                    "name": p.stem,
                    "file": p.name,
                    "rel": rel,
                    "size": p.stat().st_size,
                }
            )
        except OSError:
            continue
    return items


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def log_message(self, fmt: str, *args) -> None:
        return

    def handle(self) -> None:
        try:
            super().handle()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, TimeoutError):
            return
        except OSError as exc:
            # WinError 10053/10054 等
            if getattr(exc, "winerror", None) in (10053, 10054):
                return
            raise

    def _json(self, code: int, data) -> None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/list":
            folder = _state["folder"]
            self._json(
                200,
                {
                    "folder": folder,
                    "videos": list_videos(folder),
                },
            )
            return

        if path.startswith("/video/"):
            rel = unquote(path[len("/video/") :])
            self._serve_video(rel)
            return

        if path == "/" or path == "/index.html":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except Exception:
            payload = {}

        if parsed.path == "/api/set_folder":
            folder = str(payload.get("folder") or "").strip()
            if folder and Path(folder).is_dir():
                _state["folder"] = folder
                cfg = load_config()
                cfg["folder"] = folder
                save_config(cfg)
                self._json(200, {"ok": True, "folder": folder, "videos": list_videos(folder)})
            else:
                self._json(400, {"ok": False, "error": "invalid folder"})
            return

        self._json(404, {"error": "not found"})

    def _client_gone(self, exc: BaseException) -> bool:
        return isinstance(
            exc,
            (
                BrokenPipeError,
                ConnectionResetError,
                ConnectionAbortedError,
                TimeoutError,
            ),
        )

    def _write_file_range(self, target: Path, start: int, length: int) -> None:
        with target.open("rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(1024 * 256, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def _serve_video(self, rel: str) -> None:
        # 禁止路径穿越
        root = Path(_state["folder"]).resolve()
        try:
            target = (root / rel).resolve()
            target.relative_to(root)
        except (ValueError, OSError):
            self.send_error(403)
            return
        if not target.is_file():
            self.send_error(404)
            return

        try:
            size = target.stat().st_size
        except OSError:
            self.send_error(404)
            return

        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        range_header = self.headers.get("Range")
        headers_sent = False

        try:
            if range_header and range_header.startswith("bytes="):
                unit = range_header.replace("bytes=", "").strip()
                start_s, end_s = (unit.split("-", 1) + [""])[:2]
                try:
                    start = int(start_s) if start_s else 0
                    end = int(end_s) if end_s else size - 1
                except ValueError:
                    self.send_error(416)
                    return
                end = min(end, size - 1)
                if start > end or start < 0 or start >= size:
                    self.send_error(416)
                    return
                length = end - start + 1
                self.send_response(206)
                self.send_header("Content-Type", ctype)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
                self.send_header("Content-Length", str(length))
                self.end_headers()
                headers_sent = True
                self._write_file_range(target, start, length)
                return

            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(size))
            self.end_headers()
            headers_sent = True
            self._write_file_range(target, 0, size)
        except Exception as exc:
            # 切集/拖进度时客户端常会中断连接，属正常，勿再 send_error
            if self._client_gone(exc) or headers_sent:
                return
            try:
                self.send_error(500)
            except Exception:
                return


def screen_work_area() -> tuple[int, int]:
    """可用桌面区域（不含任务栏），失败则回退常见分辨率。"""
    try:
        import ctypes
        from ctypes import wintypes

        class RECT(ctypes.Structure):
            _fields_ = [
                ("left", wintypes.LONG),
                ("top", wintypes.LONG),
                ("right", wintypes.LONG),
                ("bottom", wintypes.LONG),
            ]

        rect = RECT()
        # SPI_GETWORKAREA = 0x0030
        if ctypes.windll.user32.SystemParametersInfoW(0x0030, 0, ctypes.byref(rect), 0):
            w = int(rect.right - rect.left)
            h = int(rect.bottom - rect.top)
            if w > 200 and h > 200:
                return w, h
    except Exception:
        pass
    return 1920, 1080


class Api:
    def pick_folder(self) -> dict:
        """原生文件夹选择对话框。"""
        try:
            import webview

            window = webview.windows[0] if webview.windows else None
            if window is None:
                return {"ok": False, "error": "no window"}
            result = window.create_file_dialog(webview.FOLDER_DIALOG)
            if not result:
                return {"ok": False, "cancelled": True}
            folder = result[0] if isinstance(result, (list, tuple)) else str(result)
            if not folder or not Path(folder).is_dir():
                return {"ok": False, "error": "invalid"}
            _state["folder"] = folder
            cfg = load_config()
            cfg["folder"] = folder
            save_config(cfg)
            return {"ok": True, "folder": folder, "videos": list_videos(folder)}
        except Exception as exc:
            return {"ok": False, "error": str(exc)}

    def get_state(self) -> dict:
        folder = _state.get("folder") or str(DEFAULT_VIDEOS)
        if not Path(folder).is_dir():
            folder = str(DEFAULT_VIDEOS)
            _state["folder"] = folder
        try:
            videos = list_videos(folder)
        except OSError:
            videos = []
        return {"folder": folder, "videos": videos}

    def resize_for_video(self, video_w: int = 0, video_h: int = 0) -> dict:
        """按视频比例调整窗口。

        竖版：固定手机窗。
        非标：原始尺寸显示；原始宽度 > 屏幕宽 70% 时，宽度压到 70%，高度按比例缩放。
        底部为控件条预留高度。
        """
        try:
            import webview

            window = webview.windows[0] if webview.windows else None
            if window is None:
                return {"ok": False, "error": "no window"}

            vw = int(video_w or 0)
            vh = int(video_h or 0)
            if vw <= 0 or vh <= 0:
                return {"ok": False, "error": "bad size"}

            aspect = vw / vh
            is_portrait = aspect <= 0.72
            screen_w, _screen_h = screen_work_area()
            hud_chrome = 56
            max_w = max(1, int(screen_w * 0.7))

            if is_portrait:
                tw, th = 420, 840
                layout = "portrait"
                content_w, content_h = tw, th
                capped = False
            else:
                # 原始宽度 > 屏幕宽 70% → 宽度压到 70%，高度按比例
                if vw > max_w:
                    content_w = max_w
                    content_h = max(1, int(round(content_w / aspect)))
                    capped = True
                else:
                    content_w = vw
                    content_h = vh
                    capped = False
                tw = content_w
                th = content_h + hud_chrome
                layout = "fit"

            prev = _state.get("win_size")
            size = (tw, th, layout)
            if prev != size:
                try:
                    window.resize(tw, th)
                except Exception:
                    try:
                        window.set_window_size(tw, th)
                    except Exception as exc:
                        return {"ok": False, "error": str(exc)}
                _state["win_size"] = size

            return {
                "ok": True,
                "width": tw,
                "height": th,
                "content_width": content_w,
                "content_height": content_h,
                "layout": layout,
                "hud_chrome": hud_chrome if layout == "fit" else 0,
                "aspect": aspect,
                "capped": capped,
                "max_width": max_w,
            }
        except Exception as exc:
            return {"ok": False, "error": str(exc)}


def start_server() -> ThreadingHTTPServer:
    port = free_port()
    _state["port"] = port
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def main() -> None:
    bind_to_exe_dir()

    try:
        import webview
    except ImportError as e:
        raise SystemExit("缺少 pywebview，请执行: pip install pywebview") from e

    ensure_dirs()
    cfg = load_config()
    folder = cfg.get("folder") or str(DEFAULT_VIDEOS)
    if not Path(folder).is_dir():
        folder = str(DEFAULT_VIDEOS)
    _state["folder"] = folder

    server = start_server()
    url = f"http://127.0.0.1:{_state['port']}/"
    api = Api()

    webview.create_window(
        "抖音本地版",
        url,
        width=420,
        height=840,
        min_size=(160, 120),
        js_api=api,
        text_select=False,
    )

    icon = str(ICON_PATH) if ICON_PATH.is_file() else None
    try:
        webview.start(gui="edgechromium", debug=False, icon=icon)
    except Exception:
        webview.start(debug=False, icon=icon)
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
