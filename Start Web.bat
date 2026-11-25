@echo off
cd /d "%~dp0"
powershell -NoProfile -Command "if (Test-NetConnection localhost -Port 8099 -InformationLevel Quiet) { exit 0 } else { exit 1 }" >nul 2>&1
if errorlevel 1 (
  start "Quoridor server" cmd /c "node serve.js 8099"
  timeout /t 2 >nul
  start "" "http://localhost:8099/"
  exit /b
)
start "" "http://localhost:8099/"