@echo off
chcp 65001 >nul
title Draven MT代理 v033 Chrome已登入頁面抓取
cd /d "%~dp0"

echo ========================================
echo Draven v033 Chrome已登入頁面抓取模式
echo ========================================
echo.
echo 請貼上完整 MT 網址（建議從已登入 MT 頁面網址列完整複製）：
echo 例如：https://gsa.ofalive99.net/?token=...^&lang=zhtw
echo.
set /p MT_URL=完整MT網址：
if "%MT_URL%"=="" (
  echo [錯誤] 未輸入完整 MT 網址。
  pause
  exit /b 1
)

echo.
echo [Draven] 安裝/確認依賴...
call npm.cmd install --omit=dev
if errorlevel 1 (
  echo [錯誤] npm install 失敗。
  pause
  exit /b 1
)

echo.
echo [Draven] 啟動 v033 Chrome抓取模式...
echo 資料來源：local_chrome
echo 雲端銜接預留：cloud_browser
set AUTO_CONNECT=true
set PORT=8787
set CHROME_CAPTURE_URL=%MT_URL%
call npm.cmd start
pause
