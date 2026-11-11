@echo off
chcp 65001 >nul
title Study server - fixed address setup
cd /d "%~dp0"
".venv\Scripts\python.exe" -X utf8 study_server.py --setup
echo.
pause
