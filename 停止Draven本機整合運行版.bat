@echo off
chcp 65001 >nul
echo 正在停止 Draven 本機整合運行版 ports 5174 / 8787 / 9226...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5174" ^| findstr "LISTENING"') do taskkill /PID %%a /T /F >nul 2>nul
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do taskkill /PID %%a /T /F >nul 2>nul
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":9226" ^| findstr "LISTENING"') do taskkill /PID %%a /T /F >nul 2>nul
echo 已送出停止指令。
pause
