@echo off
chcp 65001 >nul
setlocal

set "ROOT=%~dp0"
set "PROXY_DIR=%ROOT%proxy"

where node >nul 2>nul
if errorlevel 1 (
  echo [錯誤] 找不到 Node.js，請先安裝 Node.js LTS。
  echo 下載網址：https://nodejs.org/
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [錯誤] 找不到 npm.cmd，請重新安裝 Node.js LTS。
  pause
  exit /b 1
)

if not exist "%PROXY_DIR%\node_modules" (
  echo proxy 尚未安裝套件，正在 npm install...
  pushd "%PROXY_DIR%"
  call npm.cmd install --omit=dev
  if errorlevel 1 (
    echo [錯誤] proxy npm install 失敗。
    popd
    pause
    exit /b 1
  )
  popd
)

echo ========================================
echo Draven v021 權重反查與信心校準報表工具
echo ========================================
echo.
echo 預設：抓取 1-9 桌 / 10 分鐘 / 每 5 秒寫 partial 暫存
echo 輸出：proxy\reports\stable-report-v021-partial.md 和 final.md
echo.
echo 注意：請先啟動 Draven 本機整合運行版，並確認代理 8787 已連線。
echo.

pushd "%PROXY_DIR%"
call npm.cmd run stable-report -- --duration=10m --interval=5s --preflight=30s --tables=9
popd

echo.
echo 報表完成或已輸出 partial。
pause
