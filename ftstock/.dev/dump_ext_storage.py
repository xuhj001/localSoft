"""只读解析 Edge 扩展 chrome.storage.local 的 LevelDB 日志。
用法：
  python dump_ext_storage.py [扩展ID]            按顺序列出每次写入
  python dump_ext_storage.py --latest [扩展ID]   输出当前的本地自选（和 defaults.json / 导出文件同格式）
  python dump_ext_storage.py --latest --out=文件  写成 UTF-8 文件（PowerShell 的 > 重定向会写成 UTF-16）
只读日志文件（.log）；Edge 压缩过存储（出现 .ldb 文件）后旧数据不在日志里，以扩展里的「导出」为准。"""
import json, os, struct, sys

args = [a for a in sys.argv[1:] if not a.startswith("--")]
latest = "--latest" in sys.argv
out = next((a[6:] for a in sys.argv if a.startswith("--out=")), "")
ext_id = args[0] if args else "lagikhdcibhkdfjpibelemdjeebcpdhn"
d = os.path.join(os.environ["LOCALAPPDATA"], r"Microsoft\Edge\User Data\Default\Local Extension Settings", ext_id)
FIELDS = ["stockId", "stockCode", "marketType", "marketLabel", "name", "instrumentType", "subInstrumentType"]


def varint(b, i):
    r = s = 0
    while True:
        c = b[i]; i += 1
        r |= (c & 0x7F) << s; s += 7
        if c < 0x80: return r, i


def records(data):
    buf = b""
    for blk in range(0, len(data), 32768):
        i, end = blk, min(blk + 32768, len(data))
        while i + 7 <= end:
            n, t = struct.unpack_from("<HB", data, i + 4)
            if n == 0 and t == 0: break
            frag = data[i + 7:i + 7 + n]; i += 7 + n
            if t == 1: yield frag
            elif t == 2: buf = frag
            elif t == 3: buf += frag
            elif t == 4: yield buf + frag


def writes():
    for name in sorted(f for f in os.listdir(d) if f.endswith(".log")):
        with open(os.path.join(d, name), "rb") as fh: data = fh.read()
        for rec in records(data):
            seq, cnt = struct.unpack_from("<QI", rec, 0); i = 12
            for _ in range(cnt):
                tag = rec[i]; i += 1
                kl, i = varint(rec, i); k = rec[i:i + kl].decode(); i += kl
                if tag == 1:
                    vl, i = varint(rec, i); v = rec[i:i + vl].decode("utf-8", "replace"); i += vl
                    yield seq, k, v
                else:
                    yield seq, k, None


def summary(v):
    try: x = json.loads(v)
    except Exception: return v[:80]
    if isinstance(x, list):
        return f"{len(x)} 只: " + " ".join(e.get("stockCode", "?") for e in x if isinstance(e, dict))
    return json.dumps(x, ensure_ascii=False)[:120]


if latest:
    value = None
    for _, k, v in writes():
        if k == "watchlist": value = v
    if value is None: sys.exit("日志里没有 watchlist 的写入记录")
    entries = [{f: e[f] for f in FIELDS} for e in json.loads(value)]
    text = json.dumps(entries, ensure_ascii=False, indent=2) + "\n"
    if out:
        with open(out, "w", encoding="utf-8", newline="\n") as fh: fh.write(text)
        print(f"已写入 {out}：{len(entries)} 只")
    else:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stdout.write(text)
else:
    for seq, k, v in writes():
        print(f"#{seq} PUT {k}: {summary(v)}" if v is not None else f"#{seq} DEL {k}")
