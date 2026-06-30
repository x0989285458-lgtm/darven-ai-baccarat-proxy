@echo off
chcp 65001 >nul
cd /d "%~dp0"
title DarevnAI 前台啟動器

echo ========================================
echo DarevnAI Version 010 - AI百家預測軟體
echo ========================================
echo.
echo 前台將使用固定網址：
echo http://127.0.0.1:5174/
echo.

if not exist "node_modules\" (
  echo 第一次啟動，正在安裝必要套件...
  npm.cmd install --omit=dev
  if errorlevel 1 (
    echo.
    echo 套件安裝失敗，請確認 Node.js / npm 是否正常。
    pause
    exit /b 1
  )
)

echo 正在啟動前台伺服器...
start "DarevnAI 前台伺服器 - 請保持開啟" cmd /k "cd /d "%~dp0" && npm.cmd run dev -- --host 127.0.0.1 --port 5174 --strictPort"

echo 等待伺服器啟動...
timeout /t 4 /nobreak >nul

echo 正在開啟瀏覽器...
start "" "http://127.0.0.1:5174/"

echo.
echo 如果瀏覽器沒有自動打開，請手動複製這個網址：
echo http://127.0.0.1:5174/
echo.
echo 這個啟動器視窗可以關閉；但「DarevnAI 前台伺服器」視窗請保持開啟。
pause
