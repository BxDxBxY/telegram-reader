@echo off
setlocal EnableExtensions EnableDelayedExpansion
title UWED Campus Relay (auto)
color 0B
cd /d "%~dp0"

REM ======================================================================
REM  UWED Campus Relay - ONE-FILE launcher (Windows)
REM  Just put this file on the USB stick and double-click it.
REM  It will, by itself:
REM    1) find or install Python 3
REM    2) download the campus server + cloudflared next to this file
REM    3) open a public tunnel and auto-detect its URL
REM    4) start the relay and keep it alive (auto-restart)
REM
REM  THE ONLY MANUAL STEP (once): copy the secret below into Vercel
REM  Settings -> Environment Variables -> UWED_RELAY_SECRET -> Redeploy.
REM  The script also saves it into VERCEL_SETUP.txt next to this file.
REM ======================================================================
set "UWED_RELAY_SECRET=uwed_relay_b4e921e2d6cca69745a36e69b89e7f30ee46137006911066"

REM ---- fixed settings (normally no need to change) ----
set "PORT=8080"
set "SERVER_PY=uwed_campus_server.py"
set "CF_EXE=cloudflared.exe"
set "CF_LOG=cloudflared.log"
set "URLFILE=tunnel_url.txt"
set "SERVER_SRC=https://raw.githubusercontent.com/BxDxBxY/telegram-reader/main/uwed_campus_server.py"
set "CF_SRC=https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
set "PY_SRC=https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe"

cls
echo ======================================================================
echo             UWED CAMPUS RELAY  -  automatic launcher
echo ======================================================================
echo.
echo  Working folder : %~dp0
echo  Relay secret   : %UWED_RELAY_SECRET%
echo.
echo  (this same secret must be set in Vercel as UWED_RELAY_SECRET)
echo ======================================================================
echo.

REM ---- keep the PC awake 24/7 ----
powercfg /change standby-timeout-ac 0   >nul 2>nul
powercfg /change hibernate-timeout-ac 0 >nul 2>nul
powercfg /change monitor-timeout-ac 20  >nul 2>nul

REM ---- save the Vercel reminder file ----
> "VERCEL_SETUP.txt" (
  echo UWED Campus Relay - Vercel setup
  echo =================================
  echo.
  echo In Vercel, for the project uwed-miniapp ^(and the root telegram-reader
  echo project if you use it too^):
  echo   Settings  -^>  Environment Variables  -^>  Add
  echo     Name  : UWED_RELAY_SECRET
  echo     Value : %UWED_RELAY_SECRET%
  echo   Then press Redeploy.
  echo.
  echo After that, the bot stops showing "fallback": true and serves live data.
)

REM ================= 1. PYTHON =================
call :find_python
if not defined PY (
    echo [SETUP] Python 3 not found - installing it now ^(one-time^)...
    call :install_python
    call :find_python
)
if not defined PY (
    echo.
    echo [ERROR] Could not find or install Python automatically.
    echo         Install Python 3 from https://www.python.org/downloads/
    echo         ^(tick "Add python.exe to PATH"^), then run this file again.
    echo.
    pause
    exit /b 1
)
echo [OK] Python: %PY% %PYARGS%

REM ================= 2. SERVER SCRIPT =================
if not exist "%SERVER_PY%" (
    call :download "%SERVER_SRC%" "%SERVER_PY%" "campus server"
)
if not exist "%SERVER_PY%" (
    echo [ERROR] Could not download %SERVER_PY%. Check the internet connection.
    pause
    exit /b 1
)
echo [OK] Server script ready: %SERVER_PY%

REM ================= 3. CLOUDFLARED =================
call :ensure_cloudflared
if not exist "%CF_EXE%" (
    echo [ERROR] Could not download cloudflared.exe. Check the internet connection.
    pause
    exit /b 1
)
echo [OK] Tunnel tool ready: %CF_EXE%
echo.

REM ================= 4. RUN (with watchdog) =================
:MAINLOOP
call :start_tunnel
call :get_url
if not defined TUNNEL_URL (
    echo.
    echo [WARN] Could not get a tunnel URL yet. Cloudflare may be slow or the
    echo        network may block it. Retrying in 10 seconds...
    timeout /t 10 >nul
    goto MAINLOOP
)

cls
echo ======================================================================
echo   UWED CAMPUS RELAY IS RUNNING
echo ======================================================================
echo   Tunnel URL : %TUNNEL_URL%
echo   Secret     : %UWED_RELAY_SECRET%
echo.
echo   -^> Make sure UWED_RELAY_SECRET above is set in Vercel (see
echo      VERCEL_SETUP.txt) and the project is redeployed.
echo   -^> Keep THIS window and the minimized "cloudflared" window open.
echo   -^> Closing them stops the relay (bot falls back to a static snapshot).
echo ======================================================================
echo.

"%PY%" %PYARGS% "%SERVER_PY%" --relay-url "%TUNNEL_URL%"

echo.
echo [WATCHDOG] Server stopped. Restarting in 5 seconds... (close window to quit)
timeout /t 5 >nul
goto MAINLOOP


REM ====================================================================
REM  Subroutines
REM ====================================================================

:find_python
set "PY="
set "PYARGS="
REM -- prefer the py launcher if it actually works --
where py >nul 2>nul && ( py -3 --version >nul 2>nul && ( set "PY=py" & set "PYARGS=-3" ) )
if defined PY goto :eof
REM -- python on PATH, but skip the Microsoft Store stub --
for /f "delims=" %%P in ('where python 2^>nul') do (
    echo %%P | find /i "WindowsApps" >nul
    if errorlevel 1 if not defined PY (
        "%%P" --version >nul 2>nul && set "PY=%%P"
    )
)
if defined PY goto :eof
REM -- search the usual install locations --
for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do if exist "%%D\python.exe" set "PY=%%D\python.exe"
if defined PY goto :eof
for /d %%D in ("%ProgramFiles%\Python3*") do if exist "%%D\python.exe" set "PY=%%D\python.exe"
if defined PY goto :eof
for /d %%D in ("%ProgramFiles(x86)%\Python3*") do if exist "%%D\python.exe" set "PY=%%D\python.exe"
goto :eof

:install_python
where winget >nul 2>nul
if not errorlevel 1 (
    echo [SETUP] Installing Python via winget...
    winget install -e --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements
    goto :eof
)
echo [SETUP] winget not available - downloading the official installer...
call :download "%PY_SRC%" "python-setup.exe" "Python installer"
if exist "python-setup.exe" (
    echo [SETUP] Installing Python silently (please wait)...
    start /wait "" "python-setup.exe" /quiet InstallAllUsers=0 PrependPath=1 Include_pip=1 Include_launcher=1
)
goto :eof

:ensure_cloudflared
if exist "%CF_EXE%" (
    for %%A in ("%CF_EXE%") do if %%~zA GTR 1000000 goto :eof
)
call :download "%CF_SRC%" "%CF_EXE%" "cloudflared tunnel"
goto :eof

:start_tunnel
tasklist /fi "imagename eq cloudflared.exe" 2>nul | find /i "cloudflared.exe" >nul
if not errorlevel 1 goto :eof
echo [TUNNEL] Opening a public Cloudflare tunnel...
del "%CF_LOG%" >nul 2>nul
start "cloudflared" /min cmd /c ""%CF_EXE%" tunnel --no-autoupdate --protocol http2 --url http://localhost:%PORT% > "%CF_LOG%" 2>&1"
goto :eof

:get_url
set "TUNNEL_URL="
set /a _tries=0
:get_url_loop
set "TUNNEL_URL="
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p='%CF_LOG%'; if(Test-Path $p){$m=[regex]::Matches((Get-Content -Raw -ErrorAction SilentlyContinue $p),'(?i)https://[a-z0-9.-]+\.trycloudflare\.com'); if($m.Count){[Console]::Out.WriteLine($m[$m.Count-1].Value)}}" > "%URLFILE%" 2>nul
set /p TUNNEL_URL=<"%URLFILE%"
if defined TUNNEL_URL goto :eof
set /a _tries+=1
if !_tries! GEQ 20 goto :eof
echo   ...waiting for the tunnel to come up (!_tries!/20)
timeout /t 2 >nul
goto get_url_loop

:download
REM %1 = url  %2 = destination  %3 = label
echo [DOWNLOAD] %~3 ...
where curl >nul 2>nul
if not errorlevel 1 (
    curl -L --fail --retry 4 --retry-delay 2 --connect-timeout 20 -o "%~2" "%~1"
    if not errorlevel 1 if exist "%~2" goto :eof
)
echo [DOWNLOAD] retrying with PowerShell...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try{[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13}catch{}; try{Invoke-WebRequest -Uri '%~1' -OutFile '%~2' -UseBasicParsing}catch{exit 1}"
if not errorlevel 1 if exist "%~2" goto :eof
echo [DOWNLOAD] retrying with bitsadmin...
bitsadmin /transfer uweddl /priority foreground "%~1" "%~2" >nul 2>nul
goto :eof
