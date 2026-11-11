@echo off
chcp 65001 >nul
title Backup study database
cd /d "%~dp0"
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmm"') do set TS=%%i
if not exist "D:\StudyData\backup" mkdir "D:\StudyData\backup"
docker exec study-db pg_dump -U study -Fc study > "D:\StudyData\backup\study-%TS%.dump"
echo Saved D:\StudyData\backup\study-%TS%.dump
echo Restore: docker exec -i study-db pg_restore -U study -d study --clean ^< file.dump
pause
