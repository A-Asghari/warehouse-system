@echo off
if "%~1"=="ELEVATED" goto :run

fsutil dirty query %systemdrive% >nul 2>&1
if %errorlevel% EQU 0 goto :run

echo Administrator permission is required. Requesting from Windows...
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList 'ELEVATED' -Verb RunAs"
exit /b

:run
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
echo.
pause
