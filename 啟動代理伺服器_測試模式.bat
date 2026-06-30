@echo off
chcp 65001 >nul
cd /d "%~dp0"
set PORT=8787
set AUTO_CONNECT=false
echo ========================================
echo Draven MT資料代理伺服器測試版 v001
echo ========================================
echo.
echo 測試模式：不連接 MT，先啟動本機 API
echo API: http://127.0.0.1:8787
echo 健康檢查: http://127.0.0.1:8787/health
echo 狀態: http://127.0.0.1:8787/api/status
echo 桌台: http://127.0.0.1:8787/api/tables
echo.
echo 若要正式連 MT，請設定 MT_TOKEN 後將 AUTO_CONNECT 改為 true。
echo.
call npm.cmd start
pause
