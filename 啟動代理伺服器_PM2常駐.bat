@echo off
chcp 65001 >nul
title Draven MT代理 PM2常駐啟動
cd /d "%~dp0"
echo [Draven] 安裝/確認依賴...
call npm.cmd install
echo [Draven] 啟動 PM2 常駐服務：draven-mt-proxy-v003
call npx.cmd pm2 start ecosystem.config.cjs --update-env
call npx.cmd pm2 save
echo.
echo [Draven] PM2 常駐已啟動，可用 查看代理伺服器狀態.bat 檢查。
pause
