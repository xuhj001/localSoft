# -*- mode: python ; coding: utf-8 -*-
# 绿色免安装目录版：exe 与动态库同目录，整夹拷贝即可用

block_cipher = None

a = Analysis(
    ["main.py"],
    pathex=[],
    binaries=[],
    datas=[
        ("assets/ysp_logo.png", "assets"),
        ("assets/ysp_logo.ico", "assets"),
    ],
    hiddenimports=[
        "clr",
        "webview",
        "webview.platforms.winforms",
        "bottle",
        "proxy_tools",
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        "PyQt5",
        "PyQt6",
        "PySide2",
        "PySide6",
        "tkinter",
        "matplotlib",
        "numpy",
        "pandas",
        "PIL",
        "Pillow",
        "setuptools",
        "pkg_resources",
        "jaraco",
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="YVideo",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon="assets/ysp_logo.ico",
    contents_directory=".",
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name="YVideo",
)
