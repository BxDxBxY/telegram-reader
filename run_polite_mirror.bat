@echo off
setlocal enabledelayedexpansion
title UWED Polite Database Mirror

cd /d "%~dp0"

echo ========================================================
echo     UWED Polite Full Database Mirror (Gentle Mode)
echo ========================================================
echo  - 1 request every 1.0 - 1.4s (zero load on campus API)
echo  - Automatic checkpoint/resume if interrupted
echo  - Saves to data\uwed_mirror.db + public\snapshot.json
echo ========================================================
echo.

set "PY_CMD="
where py >nul 2>nul && set "PY_CMD=py -3"
if not defined PY_CMD (
    where python >nul 2>nul && set "PY_CMD=python"
)
if not defined PY_CMD (
    echo [ERROR] Python 3 not found.
    pause
    exit /b 1
)

!PY_CMD! "%~dp0uwed_polite_mirror.py" --delay 1.0 --upload %*
echo.
pause
