@echo off
setlocal enabledelayedexpansion
title UWED Campus Setup

cd /d "%~dp0"

echo ========================================================
echo       UWED Campus Auto-Start Setup (Windows 24/7)
echo ========================================================
echo.

:: 1. Disable Windows Sleep
powercfg /change standby-timeout-ac 0 >nul 2>nul
powercfg /change monitor-timeout-ac 15 >nul 2>nul
powercfg /change hibernate-timeout-ac 0 >nul 2>nul

:: 2. Setup Startup Shortcut
set "STARTUP_BAT=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\uwed_campus_server.bat"
(
    echo @echo off
    echo cd /d "%~dp0"
    echo start "UWED Campus Server" "%~dp0run_campus_server.bat"
) > "%STARTUP_BAT%"

echo [SUCCESS] Windows Auto-Start configured at:
echo %STARTUP_BAT%
echo.
echo Launching UWED Campus Server now...
echo.

call "%~dp0run_campus_server.bat"
