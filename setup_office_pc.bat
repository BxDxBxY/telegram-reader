@echo off
setlocal enabledelayedexpansion
title UWED Campus Agent Setup

echo =======================================================
echo     UWED Campus Agent Setup for Windows 24/7
echo =======================================================
echo.

:: 1. Detect Python 3
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
    echo [ERROR] Python 3 was not detected on this computer!
    echo.
    echo Please install Python 3:
    echo 1. Download from: https://www.python.org/downloads/
    echo 2. IMPORTANT: Check the box "Add Python to PATH" during installation.
    echo 3. Run this script again.
    echo.
    pause
    exit /b 1
)

echo [1/3] Python detected: !PY_CMD!

:: 2. Configure Power Settings (Prevent Windows Sleep & Wi-Fi disconnect)
echo [2/3] Configuring Windows power settings (disabling sleep mode)...
powercfg /change standby-timeout-ac 0 >nul 2>nul
powercfg /change monitor-timeout-ac 15 >nul 2>nul
powercfg /change hibernate-timeout-ac 0 >nul 2>nul
echo       Power sleep disabled successfully.

:: 3. Setup Startup Shortcut
echo [3/3] Setting up Windows Auto-Start shortcut...
set "SCRIPT_DIR=%~dp0"
set "AGENT_PY=%SCRIPT_DIR%uwed_campus_agent.py"
set "STARTUP_BAT=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\uwed_campus_agent.bat"

(
    echo @echo off
    echo cd /d "%SCRIPT_DIR%"
    echo start "UWED Campus Agent" !PY_CMD! "%AGENT_PY%"
) > "%STARTUP_BAT%"
echo       Auto-start created at: %STARTUP_BAT%

echo.
echo =======================================================
echo  [SUCCESS] Configuration completed!
echo  Starting UWED Campus Agent now...
echo =======================================================
echo.

cd /d "%SCRIPT_DIR%"
start "UWED Campus Agent" !PY_CMD! "%AGENT_PY%"

pause
