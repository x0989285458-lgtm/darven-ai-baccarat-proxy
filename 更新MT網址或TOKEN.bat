@echo off
chcp 65001 >nul
title Draven MT代理 更新TOKEN
cd /d "%~dp0"
echo 請貼上完整 MT 網址或 token：
set /p MT_INPUT=MT網址或TOKEN: 
call node scripts/update-token.mjs "%MT_INPUT%"
echo.
echo 如 PM2 正在運行，正在用新環境重啟...
call npx.cmd pm2 restart draven-mt-proxy-v003 --update-env
echo.
echo [Draven] 更新完成。
pause
