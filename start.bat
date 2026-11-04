@echo off
rem Double-click to start the Rainy Words server on Windows. Close this window to stop it.
rem It first writes this computer's current network address into public/config.js.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org and try again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing packages, first run only...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

node scripts\set-host.js --start
if errorlevel 1 (
  pause
  exit /b 1
)

call npm start
pause
