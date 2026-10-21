@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-portable-windows-x64.ps1"
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" (
  echo.
  echo [FAILED] Portable build stopped with exit code %EXIT_CODE%.
  pause
  exit /b %EXIT_CODE%
)
echo.
echo [OK] The portable EXE is in apps\desktop\dist\installers
explorer "%~dp0apps\desktop\dist\installers"
pause
exit /b 0
