@echo off
setlocal enabledelayedexpansion
title UWED Campus Server

cd /d "%~dp0"

echo ========================================================
echo       UWED Campus Server Launcher (Windows 24/7)
echo ========================================================
echo.

:: 1. Disable Windows Sleep and Wi-Fi disconnect
powercfg /change standby-timeout-ac 0 >nul 2>nul
powercfg /change monitor-timeout-ac 15 >nul 2>nul
powercfg /change hibernate-timeout-ac 0 >nul 2>nul

:: 2. Find Python 3
set "PY_CMD="
where py >nul 2>nul && set "PY_CMD=py -3"
if not defined PY_CMD (
    where python >nul 2>nul && set "PY_CMD=python"
)
if not defined PY_CMD (
    for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do (
        if exist "%%D\python.exe" set "PY_CMD=%%D\python.exe"
    )
)
if not defined PY_CMD (
    for /d %%D in ("%ProgramFiles%\Python3*") do (
        if exist "%%D\python.exe" set "PY_CMD=%%D\python.exe"
    )
)

if not defined PY_CMD (
    echo [ERROR] Python 3 was not detected on this system!
    echo Please install Python 3 from https://www.python.org/
    echo Make sure to check "Add Python to PATH" during installation.
    pause
    exit /b 1
)

echo Python detected: !PY_CMD!
echo Starting UWED Campus Server (Auto-restart enabled)...
echo.

:LOOP
!PY_CMD! "%~dp0uwed_campus_server.py" %*
echo.
echo [WATCHDOG] Process exited. Restarting in 5 seconds (Press Ctrl+C to stop)...
timeout /t 5 >nul
goto LOOP
