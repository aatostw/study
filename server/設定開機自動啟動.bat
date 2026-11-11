@echo off
chcp 65001 >nul
title Auto start on login
cd /d "%~dp0"
rem Start the study server 60 s after you log in (Docker Desktop needs time to start).
schtasks /create /f /tn "StudyServer" /sc onlogon /delay 0001:00 /tr "\"%~dp0啟動學習伺服器.bat\""
set VOICE=D:\GPT-SoVITS-v2pro-20250604\啟動語音伺服器.bat
if exist "%VOICE%" (
  schtasks /create /f /tn "VoiceServer" /sc onlogon /delay 0000:30 /tr "\"%VOICE%\""
)
echo.
echo Done. Both servers will open automatically after you log in.
echo To remove: schtasks /delete /tn StudyServer /f
pause
