@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo === Backup to GitHub ===
git add -A
git commit -m "backup %date% %time%"
git push
echo.
echo Done.
pause
