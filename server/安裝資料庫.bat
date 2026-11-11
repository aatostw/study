@echo off
chcp 65001 >nul
title Study server - database
cd /d "%~dp0"
where docker >nul 2>nul
if errorlevel 1 (
  echo [!] Docker not found. Install Docker Desktop first:
  echo     winget install Docker.DockerDesktop
  echo     then open Docker Desktop once and wait for "Engine running".
  pause
  exit /b 1
)
docker compose -f docker-compose.yml up -d
if errorlevel 1 (
  echo [!] Failed. Make sure Docker Desktop is open and shows "Engine running".
  pause
  exit /b 1
)
echo.
echo Database is running (PostgreSQL + pgvector on 127.0.0.1:5433).
echo It will start automatically whenever Docker Desktop starts.
pause
