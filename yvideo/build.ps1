# 央视频 — 打包绿色免安装版
#
# 用法（在项目根目录）:
#   powershell -ExecutionPolicy Bypass -File build.ps1
#
# 产物（两处相同，任选其一双击 YVideo.exe）:
#   build\YVideo\
#   dist\YVideo\
#
# 运行时目录（exe 同级）: assets\  data\  logs\  temp\

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

Write-Host "==> 安装打包依赖..." -ForegroundColor Cyan
python -m pip install -r requirements.txt pyinstaller -i https://pypi.tuna.tsinghua.edu.cn/simple --default-timeout=120

if (-not (Test-Path "assets\ysp_logo.ico")) {
    Write-Host "==> 生成 logo..." -ForegroundColor Cyan
    python -c "from main import ensure_logo_assets; print(ensure_logo_assets() or 'logo fail')"
}

Write-Host "==> 清理旧构建..." -ForegroundColor Cyan
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue build, dist

Write-Host "==> PyInstaller 打包..." -ForegroundColor Cyan
python -m PyInstaller --noconfirm YVideo.spec

if (-not (Test-Path "dist\YVideo\YVideo.exe")) {
    throw "PyInstaller 失败：找不到 dist\YVideo\YVideo.exe"
}

function Prepare-PortableDir([string]$Dir) {
    foreach ($d in @("data", "data\webview_storage", "logs", "temp", "assets")) {
        New-Item -ItemType Directory -Force -Path (Join-Path $Dir $d) | Out-Null
    }
    Copy-Item -Force "assets\ysp_logo.ico" (Join-Path $Dir "assets\") -ErrorAction SilentlyContinue
    Copy-Item -Force "assets\ysp_logo.png" (Join-Path $Dir "assets\") -ErrorAction SilentlyContinue
}

Prepare-PortableDir "dist\YVideo"

Write-Host "==> 同步到 build\YVideo ..." -ForegroundColor Cyan
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "build\YVideo"
Copy-Item -Recurse "dist\YVideo" "build\YVideo"
Prepare-PortableDir "build\YVideo"

Write-Host ""
Write-Host "免安装版已就绪，请双击:" -ForegroundColor Green
Write-Host "  $Root\build\YVideo\YVideo.exe"
Write-Host "（或 dist\YVideo\YVideo.exe，内容相同）"
