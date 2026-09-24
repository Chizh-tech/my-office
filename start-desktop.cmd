@echo off
setlocal
if not exist "%~dp0desktop\My Office.exe" (
  echo Desktop app is not built yet.
  echo Run: npm --prefix "%~dp0app" run build:desktop
  pause
  exit /b 1
)
start "" "%~dp0desktop\My Office.exe"
exit /b %ERRORLEVEL%
