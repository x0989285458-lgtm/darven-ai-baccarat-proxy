@echo off
chcp 65001 >nul
setlocal

set "ROOT=%~dp0"
set "PROXY_DIR=%ROOT%proxy"
set "FRONTEND_DIR=%ROOT%frontend"
set "PROXY_URL=http://127.0.0.1:8787"
set "FRONTEND_URL=http://127.0.0.1:5174/"
set "ADMIN_URL=http://127.0.0.1:5174/admin"

echo ========================================
echo Draven 本機整合運行版 版本 036
echo ========================================
echo.

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
  echo [1/4] proxy 尚未安裝套件，正在 npm install...
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

if not exist "%FRONTEND_DIR%\node_modules" (
  echo [2/4] frontend 尚未安裝套件，正在 npm install...
  pushd "%FRONTEND_DIR%"
  call npm.cmd install --omit=dev
  if errorlevel 1 (
    echo [錯誤] frontend npm install 失敗。
    popd
    pause
    exit /b 1
  )
  popd
)

echo [3/5] 清除舊版占用的 ports 5174 / 8787 / 9226...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5174" ^| findstr "LISTENING"') do taskkill /PID %%a /T /F >nul 2>nul
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do taskkill /PID %%a /T /F >nul 2>nul
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":9226" ^| findstr "LISTENING"') do taskkill /PID %%a /T /F >nul 2>nul

echo [4/5] 啟動 MT 本機代理伺服器...
start "Draven MT代理 8787" cmd /k "cd /d "%PROXY_DIR%" && npm.cmd start"

echo [5/5] 啟動前台/後台本機伺服器...
start "Draven 前後台 5174" cmd /k "cd /d "%FRONTEND_DIR%" && npm.cmd run dev -- --host 127.0.0.1 --port 5174 --strictPort"

timeout /t 5 /nobreak >nul
start "" "%FRONTEND_URL%"

echo.
echo 已啟動：
echo 前台：%FRONTEND_URL%
echo 後台：%ADMIN_URL%
echo 登入：http://127.0.0.1:5174/login
echo 代理：%PROXY_URL%/api/status
echo.
echo 若 MT token 過期，請修改：proxy\.env 的 CHROME_CAPTURE_URL。
echo 關閉時請把兩個黑色視窗關掉，或執行 停止Draven本機整合運行版.bat
echo.
pause
