@echo off
setlocal
cd /d C:\WarehouseSystem

set "WINTITLE=WarehouseServer"

:menu
cls
echo ============================
echo    Warehouse System Menu
echo ============================
echo 1. Start Server
echo 2. Stop Server
echo 3. Reset Server (Stop + Start)
echo 4. Run Project (npm start)
echo 5. Clear Documents (node clear-docs-only.js)
echo 6. Exit
echo ============================
set /p choice="Choose an option (1-6): "
if "%choice%"=="1" goto start
if "%choice%"=="2" goto stop
if "%choice%"=="3" goto reset
if "%choice%"=="4" goto project
if "%choice%"=="5" goto clear
if "%choice%"=="6" exit
goto menu

:start
call :is_running
if "%RUNNING%"=="1" (
    echo ⚠️  Server is already running.
    pause
    goto menu
)
echo Starting server...
start "%WINTITLE%" cmd /k "node server.js"
timeout /t 2 >nul
echo ✅ Server started.
pause
goto menu

:stop
call :is_running
if "%RUNNING%"=="0" (
    echo ⚠️  Server is not running.
    pause
    goto menu
)
echo Stopping server...
taskkill /fi "WINDOWTITLE eq %WINTITLE%*" /t /f >nul 2>&1
timeout /t 1 >nul
echo ✅ Server stopped.
pause
goto menu

:reset
echo Resetting server (stop + start)...
taskkill /fi "WINDOWTITLE eq %WINTITLE%*" /t /f >nul 2>&1
timeout /t 2 >nul
start "%WINTITLE%" cmd /k "node server.js"
timeout /t 2 >nul
echo ✅ Server reset.
pause
goto menu

:project
npm start
pause
goto menu

:clear
node clear-docs-only.js
pause
goto menu

:is_running
set "RUNNING=0"
tasklist /fi "WINDOWTITLE eq %WINTITLE%*" 2>nul | find /i "cmd.exe" >nul
if not errorlevel 1 set "RUNNING=1"
goto :eof
