@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title UWED Campus Relay
color 0B

echo ======================================================================
echo              UWED CAMPUS RELAY  -  starting...
echo ======================================================================
echo  Folder: %~dp0
echo.

REM ---- settings ----
set "PORT=8080"
set "SERVER_PY=uwed_campus_server.py"
set "CF_EXE=cloudflared.exe"
set "CF_LOG=cloudflared.log"
set "URLFILE=tunnel_url.txt"
set "TOKENFILE=bot_token.txt"
set "SERVER_SRC=https://raw.githubusercontent.com/BxDxBxY/telegram-reader/main/uwed_campus_server.py"
set "CF_SRC=https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
set "PY_SRC=https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe"
set "UWED_RELAY_SECRET=uwed_relay_b4e921e2d6cca69745a36e69b89e7f30ee46137006911066"
set "UWED_SYNC_INTERVAL_MINS=5"
set "UWED_ADMIN_CHAT_ID=6906730753"
set "UWED_NOTIFY_TELEGRAM=1"

REM ---- stop any previous copies so we start clean ----
echo [1/6] Stopping any previous copies...
taskkill /f /im cloudflared.exe >nul 2>nul
for /f "tokens=5" %%P in ('netstat -ano ^| find ":%PORT%" ^| find "LISTENING"') do taskkill /f /pid %%P >nul 2>nul

REM ---- keep the PC awake ----
powercfg /change standby-timeout-ac 0   >nul 2>nul
powercfg /change hibernate-timeout-ac 0 >nul 2>nul
powercfg /change monitor-timeout-ac 20  >nul 2>nul

REM ---- bot token (used for the admin key AND to send you logs) ----
echo [2/6] Checking bot token...
set "UWED_HELPDESK_TOKEN="
if exist "%TOKENFILE%" set /p UWED_HELPDESK_TOKEN=<"%TOKENFILE%"
if not defined UWED_HELPDESK_TOKEN (
    echo.
    echo  Paste your Telegram bot token ^(the SAME one set in Vercel
    echo  UWED_HELPDESK_TOKEN^), then press Enter. Saved locally only.
    echo.
    set /p "UWED_HELPDESK_TOKEN=Bot token: "
    if defined UWED_HELPDESK_TOKEN (>"%TOKENFILE%" echo !UWED_HELPDESK_TOKEN!)
)
if not defined UWED_HELPDESK_TOKEN (
    echo [ERROR] No token entered. Delete %TOKENFILE% and run again.
    echo.
    pause
    exit /b 1
)
set "UWED_BOT_TOKEN=!UWED_HELPDESK_TOKEN!"
call :derive_admin_key
echo       Token OK, admin key derived.

REM ---- send a test message to your Telegram now ----
echo [3/6] Sending a TEST message to your Telegram...
call :tg "UWED launcher: test message. If you see this, Telegram logs work."
echo       curl result: !TG_RESULT!
if /i "!TG_OK!"=="1" (
    echo       ^>^> Delivered. Check your bot chat.
) else (
    echo       ^>^> NOT delivered. Open your bot, press START, and make sure the
    echo          token matches Vercel. Details above. Continuing anyway...
)
echo.

REM ---- python ----
echo [4/6] Checking Python...
call :find_python
if not defined PY (
    echo       Python not found - installing ^(one-time^)...
    call :install_python
    call :find_python
)
if not defined PY (
    echo [ERROR] Could not find/install Python. Install from python.org and retry.
    echo.
    pause
    exit /b 1
)
echo       Python: %PY% %PYARGS%

REM ---- server script (always refresh) ----
echo [5/6] Downloading the latest campus server...
del "%SERVER_PY%" >nul 2>nul
call :download "%SERVER_SRC%" "%SERVER_PY%" "campus server"
if not exist "%SERVER_PY%" (
    echo [ERROR] Could not download the server. Check internet and retry.
    echo.
    pause
    exit /b 1
)
echo       Server script ready.

REM ---- cloudflared ----
echo [6/6] Checking the tunnel tool ^(cloudflared^)...
call :ensure_cloudflared
set "CF_OK="
if exist "%CF_EXE%" for %%A in ("%CF_EXE%") do if %%~zA GTR 40000000 set "CF_OK=1"
if not defined CF_OK (
    echo [ERROR] cloudflared did not download fully ^(~52 MB^). Run again to resume,
    echo         or download it manually from:
    echo         %CF_SRC%
    echo.
    pause
    exit /b 1
)
echo       Tunnel tool ready.
echo.
call :tg "UWED: setup done on %COMPUTERNAME%. Opening tunnel..."

REM ================= RUN (keep this window open) =================
:MAINLOOP
echo [TUNNEL] Opening a public Cloudflare tunnel...
call :start_tunnel
call :get_url
if not defined TUNNEL_URL (
    echo [WARN] Tunnel not up yet - retrying in 10s. If this repeats, this
    echo        network may be blocking Cloudflare.
    call :tg "UWED: tunnel not up yet, retrying..."
    taskkill /f /im cloudflared.exe >nul 2>nul
    timeout /t 10 >nul
    goto MAINLOOP
)
cls
echo ======================================================================
echo   UWED CAMPUS RELAY IS RUNNING  -  keep this window open (minimize it)
echo ======================================================================
echo   Tunnel : %TUNNEL_URL%
echo   Sync   : every %UWED_SYNC_INTERVAL_MINS% min   Logs -^> your Telegram
echo   Started: %date% %time%
echo ======================================================================
echo.
call :tg "UWED: tunnel up. Starting campus server + sync now."
"%PY%" %PYARGS% "%SERVER_PY%" --relay-url "%TUNNEL_URL%"
echo.
echo [WATCHDOG] Server stopped. Restarting in 5 seconds... (close window to quit)
call :tg "UWED: server stopped, auto-restarting in 5s."
timeout /t 5 >nul
goto MAINLOOP


REM ====================================================================
REM  Subroutines
REM ====================================================================

:derive_admin_key
set "UWED_ADMIN_KEY="
powershell -NoProfile -ExecutionPolicy Bypass -Command "$h=New-Object System.Security.Cryptography.HMACSHA256; $h.Key=[Text.Encoding]::UTF8.GetBytes($env:UWED_HELPDESK_TOKEN.Trim()); $b=$h.ComputeHash([Text.Encoding]::UTF8.GetBytes('uwed_admin_6906730753_bxdxbxy')); [Console]::Out.WriteLine([BitConverter]::ToString($b).Replace('-','').ToLower().Substring(0,32))" > "adminkey.txt" 2>nul
set /p UWED_ADMIN_KEY=<"adminkey.txt"
del "adminkey.txt" >nul 2>nul
goto :eof

:tg
REM %~1 = message text (plain ASCII). Sends to your Telegram, sets TG_OK/TG_RESULT.
set "TG_OK="
set "TG_RESULT=(no token)"
if not defined UWED_HELPDESK_TOKEN goto :eof
set "TG_RESULT=(no response - telegram unreachable?)"
curl -s --max-time 15 "https://api.telegram.org/bot!UWED_HELPDESK_TOKEN!/sendMessage" --data-urlencode "chat_id=%UWED_ADMIN_CHAT_ID%" --data-urlencode "text=%~1" > "tg.txt" 2>nul
set /p TG_RESULT=<"tg.txt"
findstr /i "ok.:true" "tg.txt" >nul 2>nul && set "TG_OK=1"
del "tg.txt" >nul 2>nul
goto :eof

:find_python
set "PY="
set "PYARGS="
where py >nul 2>nul && ( py -3 --version >nul 2>nul && ( set "PY=py" & set "PYARGS=-3" ) )
if defined PY goto :eof
for /f "delims=" %%P in ('where python 2^>nul') do (
    echo %%P | find /i "WindowsApps" >nul
    if errorlevel 1 if not defined PY (
        "%%P" --version >nul 2>nul && set "PY=%%P"
    )
)
if defined PY goto :eof
for /d %%D in ("%LOCALAPPDATA%\Programs\Python\Python3*") do if exist "%%D\python.exe" set "PY=%%D\python.exe"
if defined PY goto :eof
for /d %%D in ("%ProgramFiles%\Python3*") do if exist "%%D\python.exe" set "PY=%%D\python.exe"
if defined PY goto :eof
for /d %%D in ("%ProgramFiles(x86)%\Python3*") do if exist "%%D\python.exe" set "PY=%%D\python.exe"
goto :eof

:install_python
where winget >nul 2>nul
if not errorlevel 1 (
    winget install -e --id Python.Python.3.12 --silent --accept-package-agreements --accept-source-agreements
    goto :eof
)
call :download "%PY_SRC%" "python-setup.exe" "Python installer"
if exist "python-setup.exe" start /wait "" "python-setup.exe" /quiet InstallAllUsers=0 PrependPath=1 Include_pip=1 Include_launcher=1
goto :eof

:ensure_cloudflared
set /a _cf=0
:ensure_cf_loop
if exist "%CF_EXE%" for %%A in ("%CF_EXE%") do if %%~zA GTR 40000000 goto :eof
set /a _cf+=1
if !_cf! GTR 3 goto :eof
echo       Fetching cloudflared (attempt !_cf!/3, ~52 MB)...
call :download "%CF_SRC%" "%CF_EXE%" "cloudflared"
goto ensure_cf_loop

:start_tunnel
tasklist /fi "imagename eq cloudflared.exe" 2>nul | find /i "cloudflared.exe" >nul
if not errorlevel 1 goto :eof
del "%CF_LOG%" >nul 2>nul
start "cloudflared" /min cmd /c ""%CF_EXE%" tunnel --no-autoupdate --protocol http2 --url http://localhost:%PORT% > "%CF_LOG%" 2>&1"
goto :eof

:get_url
set /a _tries=0
:get_url_loop
set "TUNNEL_URL="
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p='%CF_LOG%'; if(Test-Path $p){$m=[regex]::Matches((Get-Content -Raw -ErrorAction SilentlyContinue $p),'(?i)https://[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com'); if($m.Count){[Console]::Out.WriteLine($m[$m.Count-1].Value)}}" > "%URLFILE%" 2>nul
set /p TUNNEL_URL=<"%URLFILE%"
if defined TUNNEL_URL goto :eof
set /a _tries+=1
if !_tries! GEQ 20 goto :eof
echo       ...waiting for the tunnel (!_tries!/20)
timeout /t 2 >nul
goto get_url_loop

:download
echo       [download] %~3 ...
where curl >nul 2>nul
if not errorlevel 1 (
    curl -C - -L --fail --retry 8 --retry-delay 2 --retry-all-errors --connect-timeout 20 -o "%~2" "%~1"
    if not errorlevel 1 if exist "%~2" goto :eof
)
echo       [download] retry via PowerShell...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try{[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13}catch{}; try{Invoke-WebRequest -Uri '%~1' -OutFile '%~2' -UseBasicParsing}catch{exit 1}"
if not errorlevel 1 if exist "%~2" goto :eof
echo       [download] retry via bitsadmin...
bitsadmin /transfer uweddl /priority foreground "%~1" "%~2" >nul 2>nul
goto :eof
