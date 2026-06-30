@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0"
set "FRONTEND_LAUNCHER=%ROOT%frontend\開啟前台.bat"

if exist "%FRONTEND_LAUNCHER%" (
  call "%FRONTEND_LAUNCHER%"
) else (
  echo 找不到前台啟動器：%FRONTEND_LAUNCHER%
  pause
  exit /b 1
)
