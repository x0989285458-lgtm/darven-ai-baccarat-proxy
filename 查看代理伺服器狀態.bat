@echo off
chcp 65001 >nul
title Draven MT代理 狀態檢查
cd /d "%~dp0"
echo [Draven] PM2 狀態：
call npx.cmd pm2 status
echo.
echo [Draven] API 健康檢查：
call node scripts/health-check.mjs
echo.
echo [Draven] 最近 log 可用：npx.cmd pm2 logs draven-mt-proxy-v003
pause
