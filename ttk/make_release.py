# -*- coding: utf-8 -*-
"""整理免安装发布目录，并清理 build/dist 中间产物。"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "dist" / "ttk-portable"
OUT = ROOT / "release" / "抖音本地版"


def main() -> int:
    if not SRC.is_dir():
        print("missing", SRC)
        return 1

    shutil.rmtree(OUT, ignore_errors=True)
    shutil.copytree(SRC, OUT)

    for old in ("TTK.exe", "ttk.exe"):
        p = OUT / old
        if p.exists():
            dest = OUT / "抖音本地版.exe"
            if dest.exists():
                dest.unlink()
            p.rename(dest)

    dll = OUT / "python314.dll"
    if not dll.exists():
        for hit in OUT.rglob("python314.dll"):
            shutil.copy2(hit, dll)
            print("copied", hit, "->", dll)
            break

    (OUT / "videos").mkdir(exist_ok=True)
    (OUT / "data").mkdir(exist_ok=True)
    (OUT / "videos" / "放视频到这里.txt").write_text(
        "把视频文件放到本文件夹，或在设置里选择其他目录。\n",
        encoding="utf-8",
    )
    (OUT / "使用说明.txt").write_text(
        "抖音本地版 - 免安装版\n\n"
        "1. 双击本目录中的「抖音本地版.exe」即可\n"
        "2. 本目录内已包含全部依赖（含 python314.dll），请整个文件夹一起拷贝\n"
        "3. 工作目录自动为本文件夹；视频默认放 videos\n"
        "4. 需要 Microsoft Edge WebView2（Win10/11 通常自带）\n",
        encoding="utf-8",
    )

    exe = OUT / "抖音本地版.exe"
    if not exe.exists():
        print("exe missing")
        return 1
    if not dll.exists():
        print("python314.dll missing beside exe")
        return 1

    # 只保留最终 release，清掉 PyInstaller 中间目录
    for junk in ("build", "dist"):
        p = ROOT / junk
        if p.exists():
            shutil.rmtree(p, ignore_errors=True)
            print("removed", p)

    print("OK", OUT.resolve())
    print("exe:", exe.name)
    print("dll:", dll.name, dll.stat().st_size)
    return 0


if __name__ == "__main__":
    sys.exit(main())
