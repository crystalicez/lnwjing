@echo off
chcp 65001 >nul
title lnwjing Secure Tunnel
if not exist "%~dp0start-lnwjing-tunnel.ps1" (
  echo Missing companion script: %~dp0start-lnwjing-tunnel.ps1
  exit /b 1
)
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0start-lnwjing-tunnel.ps1" -OpenDashboard
if errorlevel 1 pause
