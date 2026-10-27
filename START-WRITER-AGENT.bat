@echo off
title SYUW1 SYU Writer Agent - keep this window open
cd /d "E:\SYU WRITER Agent"

rem Node.js is needed to run the agent.
where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js is not installed. Install it from https://nodejs.org ^(LTS^), then run this file again.
  pause
  exit /b
)

rem Already running? Restart it (to load the latest changes) or just open the dashboard.
set PID=
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3002 " ^| findstr "LISTENING"') do set PID=%%p
if defined PID (
  echo  The agent is already running.
  choice /c RO /t 10 /d O /m "  Press R to restart it (loads the latest changes), or O to just open the dashboard"
  if errorlevel 2 (
    start chrome http://localhost:3002
    exit /b
  )
  echo  Restarting...
  taskkill /pid %PID% /f >nul
  timeout /t 2 >nul
)

rem Install packages on first run, or again when the package list has changed.
if not exist node_modules\.package-lock.json goto install
powershell -NoProfile -Command "exit [int]((Get-Item package-lock.json).LastWriteTime -gt (Get-Item node_modules\.package-lock.json).LastWriteTime)"
if errorlevel 1 goto install
goto run
:install
echo  Installing packages, please wait...
call npm install --no-audit --no-fund

:run
echo.
echo  ==========================================================
echo   SYU Writer Agent - SYUW1 (beta 0.0)
echo   Dashboard: http://localhost:3002
echo   KEEP THIS WINDOW OPEN. Closing it stops the agent.
echo  ==========================================================
echo.
start "" cmd /c "timeout /t 4 >nul & start chrome http://localhost:3002"
node src/server.js
echo.
echo  The agent stopped. Take a screenshot of any error above and send it to Claude.
pause
