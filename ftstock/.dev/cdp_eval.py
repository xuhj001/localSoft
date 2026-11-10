"""只连扩展窗口页面（app.html）执行一段 JS，不接触 iframe 里的 futunn 页面（避免被网关的挑战脚本当成机器人）。
用法：python cdp_eval.py PORT "JS 表达式"   —— Edge 需要带 --remote-debugging-port=PORT 启动。只用标准库。"""
import base64
import json
import os
import socket
import struct
import sys
import urllib.request
from urllib.parse import urlparse


def ws_connect(url):
    u = urlparse(url)
    sock = socket.create_connection((u.hostname, u.port), timeout=90)
    key = base64.b64encode(os.urandom(16)).decode()
    sock.sendall((f"GET {u.path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\n"
                  f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
    buf = b""
    while b"\r\n\r\n" not in buf:
        buf += sock.recv(4096)
    return sock, buf.split(b"\r\n\r\n", 1)[1]


def ws_send(sock, text):
    data = text.encode()
    mask = os.urandom(4)
    n = len(data)
    head = struct.pack("!B", 0x81) + (struct.pack("!B", 0x80 | n) if n < 126 else struct.pack("!BH", 0x80 | 126, n)
                                      if n < 65536 else struct.pack("!BQ", 0x80 | 127, n))
    sock.sendall(head + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))


def ws_recv(sock, buf):
    def need(k):
        nonlocal buf
        while len(buf) < k:
            buf += sock.recv(65536)
    need(2)
    n = buf[1] & 0x7F
    off = 2
    if n == 126:
        need(4)
        n, off = struct.unpack("!H", buf[2:4])[0], 4
    elif n == 127:
        need(10)
        n, off = struct.unpack("!Q", buf[2:10])[0], 10
    need(off + n)
    return buf[off:off + n].decode("utf-8", "replace"), buf[off + n:]


def main():
    port, expr = sys.argv[1], sys.argv[2]
    if expr.startswith("@"):  # 从文件读，免得命令行转义把 JS 弄坏
        expr = open(expr[1:], encoding="utf-8").read()
    targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{port}/json"))
    app = next(t for t in targets if t["type"] == "page" and t["url"].endswith("/app.html"))
    sock, buf = ws_connect(app["webSocketDebuggerUrl"])
    ws_send(sock, json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {
        "expression": expr, "awaitPromise": True, "returnByValue": True}}))
    while True:
        msg, buf = ws_recv(sock, buf)
        if "-v" in sys.argv:
            print("raw:", msg[:500])
        data = json.loads(msg)
        if data.get("id") == 1:
            res = data.get("result", {})
            inner = res.get("result", {})
            print(json.dumps(inner["value"] if "value" in inner else data, ensure_ascii=False, indent=1))
            break


if __name__ == "__main__":
    main()
