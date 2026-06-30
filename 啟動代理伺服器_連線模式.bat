@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PORT=8787
set AUTO_CONNECT=true

if "%MT_TOKEN%"=="" (
  echo [錯誤] 尚未設定 MT_TOKEN。
  echo.
  echo 請先在此視窗輸入：
  echo set MT_TOKEN=你的MT_TOKEN
  echo.
  echo 或先使用「啟動代理伺服器_測試模式.bat」。
  pause
  exit /b 1
)

echo ========================================
echo Draven MT資料代理伺服器 v001
echo ========================================
echo API: http://127.0.0.1:8787
echo 健康檢查: http://127.0.0.1:8787/health
echo.
call npm.cmd start
pause
