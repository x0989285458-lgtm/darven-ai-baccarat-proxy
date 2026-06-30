@echo off
chcp 65001 >nul
title Draven MT代理 PM2停止
cd /d "%~dp0"
echo [Draven] 停止 PM2 常駐服務：draven-mt-proxy-v003
call npx.cmd pm2 stop draven-mt-proxy-v003
call npx.cmd pm2 save
echo.
echo [Draven] 已送出停止指令。
pause
