@echo off
chcp 65001 >nul
title Study server - install
cd /d "%~dp0"
echo ==================================================
echo   Study server: install Python packages (once)
echo ==================================================
where py >nul 2>nul
if errorlevel 1 (
  echo [!] Python not found. Run this in Command Prompt, then try again:
  echo     winget install Python.Python.3.11
  pause
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" (
  py -3.11 -m venv .venv || py -3 -m venv .venv
)
".venv\Scripts\python.exe" -m pip install --upgrade pip
echo.
echo [1/2] PyTorch with CUDA (about 2.5 GB) ...
".venv\Scripts\python.exe" -m pip install torch --index-url https://download.pytorch.org/whl/cu124
echo.
echo [2/2] Other packages ...
".venv\Scripts\python.exe" -m pip install -r requirements.txt
echo.
".venv\Scripts\python.exe" -c "import torch;print('GPU:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'NOT FOUND')"
echo.
echo Done. Next: double-click the database installer, then the fixed address setup.
pause
