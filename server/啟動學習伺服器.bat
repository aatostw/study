@echo off
chcp 65001 >nul
title Study server
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo [!] Not installed yet. Double-click the installer first.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -X utf8 study_server.py %*
echo.
pause
