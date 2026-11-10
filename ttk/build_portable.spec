# -*- mode: python ; coding: utf-8 -*-
# 免安装便携版：所有依赖与 exe 同目录（不用 _internal）

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=[],
    datas=[
        ("web", "web"),
        ("assets", "assets"),
    ],
    hiddenimports=[
        "clr",
        "clr_loader",
        "bottle",
        "proxy_tools",
        "webview",
        "webview.platforms.edgechromium",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "PyQt5",
        "PyQt6",
        "PySide2",
        "PySide6",
        "gi",
        "android",
        "tkinter",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="TTK",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    # 关键：依赖与 exe 同目录，避免找不到 python314.dll
    contents_directory=".",
    icon="assets/app.ico",
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="ttk-portable",
)
