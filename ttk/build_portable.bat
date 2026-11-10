@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo [1/4] 安装打包依赖...
python -m pip install -q -r requirements.txt pyinstaller
if errorlevel 1 goto :fail

echo [2/4] 停止旧进程...
taskkill /IM "抖音本地版.exe" /F >nul 2>&1
taskkill /IM "TTK.exe" /F >nul 2>&1
taskkill /IM "ttk.exe" /F >nul 2>&1

echo [3/4] PyInstaller 打包...
python -m PyInstaller --noconfirm --clean build_portable.spec
if errorlevel 1 goto :fail

echo [4/4] 输出到 release，并删除 build/dist...
python make_release.py
if errorlevel 1 goto :fail

echo.
echo ========================================
echo 最终输出（仅保留这一份）:
echo   %CD%\release\抖音本地版\
echo 启动: release\抖音本地版\抖音本地版.exe
echo 调试: python main.py
echo ========================================
exit /b 0

:fail
echo 打包失败。
exit /b 1
