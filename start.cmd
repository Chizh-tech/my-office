@echo off
setlocal
cd /d "%~dp0app"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 24 or later is required. Nothing was installed.
  pause
  exit /b 1
)
if not exist "node_modules\lucide\dist\umd\lucide.js" (
  echo Local dependencies are missing. See README.md before installing.
  pause
  exit /b 1
)
node src\server.mjs --open
set "officeExitCode=%ERRORLEVEL%"
if not "%officeExitCode%"=="0" pause
exit /b %officeExitCode%
