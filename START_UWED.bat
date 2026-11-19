@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

REM ======================================================================
REM  UWED Campus Relay - ONE-FILE launcher (Windows)
REM  Double-click to set up once, then it runs HIDDEN in the background,
REM  syncs every 5 minutes, and sends status/logs to your Telegram.
REM
REM  Modes:
REM    (no arg)  interactive setup: ask token once, install, go background
REM    run       background engine (launched hidden by uwed_hidden.vbs)
REM ======================================================================
set "MODE=%~1"
if /i "%MODE%"=="run" ( set "PAUSE=" & title UWED Relay (background) ) else ( set "PAUSE=pause" & title UWED Relay (setup) )
color 0B

REM ---- shared secret with Vercel (UWED_RELAY_SECRET) ----
set "UWED_RELAY_SECRET=uwed_relay_b4e921e2d6cca69745a36e69b89e7f30ee46137006911066"

REM ---- fixed settings ----
set "PORT=8080"
set "SERVER_PY=uwed_campus_server.py"
set "CF_EXE=cloudflared.exe"
set "CF_LOG=cloudflared.log"
set "URLFILE=tunnel_url.txt"
set "TOKENFILE=bot_token.txt"
set "VBSFILE=uwed_hidden.vbs"
set "SERVER_SRC=https://raw.githubusercontent.com/BxDxBxY/telegram-reader/claude/quirky-newton-hmzh3d/uwed_campus_server.py"
set "CF_SRC=https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
set "PY_SRC=https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe"

REM ---- behaviour passed to the server (sync every 5 min, Telegram logs) ----
set "UWED_SYNC_INTERVAL_MINS=5"
set "UWED_ADMIN_CHAT_ID=6906730753"
set "UWED_NOTIFY_TELEGRAM=1"

REM ---- Bot token: used to match Vercel's admin key AND to send you logs.
REM      Read from bot_token.txt (saved on first run), never uploaded. Must be
REM      the SAME token set in Vercel's UWED_HELPDESK_TOKEN. ----
set "UWED_HELPDESK_TOKEN="
if exist "%TOKENFILE%" set /p UWED_HELPDESK_TOKEN=<"%TOKENFILE%"
if not defined UWED_HELPDESK_TOKEN if /i not "%MODE%"=="run" (
    echo.
    echo  ---------------------------------------------------------------
    echo   First-time setup: paste your Telegram bot token.
    echo   ^(The exact token that is set in Vercel UWED_HELPDESK_TOKEN.^)
    echo   Saved locally in %TOKENFILE% and never sent anywhere.
    echo  ---------------------------------------------------------------
    set /p "UWED_HELPDESK_TOKEN=Bot token: "
    if defined UWED_HELPDESK_TOKEN (>"%TOKENFILE%" echo !UWED_HELPDESK_TOKEN!)
)
if defined UWED_HELPDESK_TOKEN (
    call :derive_admin_key
    set "UWED_BOT_TOKEN=!UWED_HELPDESK_TOKEN!"
    if defined UWED_ADMIN_KEY echo [OK] Admin key derived - Vercel sync + Telegram logs enabled.
) else (
    echo [WARN] No bot token - Vercel sync will be 403 and no Telegram logs.
)

if /i not "%MODE%"=="run" cls
echo ======================================================================
echo             UWED CAMPUS RELAY  -  launcher (%MODE%)
echo ======================================================================
echo  Folder : %~dp0
echo  Sync   : every %UWED_SYNC_INTERVAL_MINS% min   Logs -^> Telegram
echo ======================================================================
echo.

REM ---- keep the PC awake 24/7 ----
powercfg /change standby-timeout-ac 0   >nul 2>nul
powercfg /change hibernate-timeout-ac 0 >nul 2>nul
powercfg /change monitor-timeout-ac 20  >nul 2>nul

REM ---- save the Vercel reminder file ----
> "VERCEL_SETUP.txt" (
  echo UWED Campus Relay - Vercel environment variables
  echo =================================================
  echo.
  echo In Vercel ^(project uwed-miniapp^), Settings -^> Environment Variables:
  echo   UWED_RELAY_SECRET   = %UWED_RELAY_SECRET%
  echo   UWED_HELPDESK_TOKEN = ^<your bot token, same as bot_token.txt^>
  echo Then press Redeploy.
)

REM ================= 1. PYTHON =================
call :find_python
if not defined PY (
    echo [SETUP] Python 3 not found - installing it now ^(one-time^)...
    call :install_python
    call :find_python
)
if not defined PY (
    echo [ERROR] Could not find or install Python. Install it from
    echo         https://www.python.org/downloads/ ^(tick "Add to PATH"^).
    %PAUSE%
    exit /b 1
)
echo [OK] Python: %PY% %PYARGS%

REM ================= 2. SERVER SCRIPT (always refresh) =================
del "%SERVER_PY%" >nul 2>nul
call :download "%SERVER_SRC%" "%SERVER_PY%" "campus server"
if not exist "%SERVER_PY%" (
    echo [ERROR] Could not download %SERVER_PY%. Check the internet connection.
    %PAUSE%
    exit /b 1
)
echo [OK] Server script ready.

REM ================= 3. CLOUDFLARED =================
call :ensure_cloudflared
set "CF_OK="
if exist "%CF_EXE%" for %%A in ("%CF_EXE%") do if %%~zA GTR 40000000 set "CF_OK=1"
if not defined CF_OK (
    echo [ERROR] cloudflared.exe did not download fully ^(~52 MB^). Run again
    echo         ^(it resumes^), or download it manually from:
    echo         %CF_SRC%
    %PAUSE%
    exit /b 1
)
echo [OK] Tunnel tool ready.
echo.

REM ============ HAND OFF TO HIDDEN BACKGROUND (setup mode only) ============
if /i "%MODE%"=="run" goto :run_guard
call :telegram_ping
call :write_vbs
echo ======================================================================
echo   Setup complete. Starting HIDDEN in the background now.
echo   - No terminal window will stay open.
echo   - Status + logs go to your Telegram bot chat.
echo   - It re-syncs every %UWED_SYNC_INTERVAL_MINS% minutes automatically.
echo   To STOP it later: Task Manager -^> end "python.exe" and "cloudflared.exe".
echo   This window closes in a few seconds...
echo ======================================================================
start "" wscript.exe "%VBSFILE%"
timeout /t 4 >nul
exit /b 0

:run_guard
REM Don't start a second engine if one is already listening on the port.
netstat -ano | find ":%PORT%" | find "LISTENING" >nul 2>nul && exit /b 0
> "server.log" echo [start] %date% %time% on %COMPUTERNAME%

REM ================= 4. RUN (with watchdog) =================
:MAINLOOP
call :start_tunnel
call :get_url
if not defined TUNNEL_URL (
    >> "server.log" echo [WARN] No tunnel URL yet; retrying in 10s
    taskkill /f /im cloudflared.exe >nul 2>nul
    timeout /t 10 >nul
    goto MAINLOOP
)
>> "server.log" echo [READY] Tunnel: %TUNNEL_URL% - starting campus server...
"%PY%" %PYARGS% "%SERVER_PY%" --relay-url "%TUNNEL_URL%" >> "server.log" 2>&1
>> "server.log" echo [WATCHDOG] Server stopped; restarting in 5s
timeout /t 5 >nul
goto MAINLOOP


REM ====================================================================
REM  Subroutines
REM ====================================================================

:derive_admin_key
REM UWED_ADMIN_KEY = first 32 hex of HMAC-SHA256(bot_token, label), exactly as
REM Vercel computes it, so the campus server authenticates (no more 403).
set "UWED_ADMIN_KEY="
powershell -NoProfile -ExecutionPolicy Bypass -Command "$h=New-Object System.Security.Cryptography.HMACSHA256; $h.Key=[Text.Encoding]::UTF8.GetBytes($env:UWED_HELPDESK_TOKEN.Trim()); $b=$h.ComputeHash([Text.Encoding]::UTF8.GetBytes('uwed_admin_6906730753_bxdxbxy')); [Console]::Out.WriteLine([BitConverter]::ToString($b).Replace('-','').ToLower().Substring(0,32))" > "adminkey.txt" 2>nul
set /p UWED_ADMIN_KEY=<"adminkey.txt"
del "adminkey.txt" >nul 2>nul
goto :eof

:telegram_ping
if not defined UWED_HELPDESK_TOKEN goto :eof
echo [Telegram] Sending a test message to your bot chat...
curl -s --max-time 15 "https://api.telegram.org/bot!UWED_HELPDESK_TOKEN!/sendMessage" --data-urlencode "chat_id=%UWED_ADMIN_CHAT_ID%" --data-urlencode "text=UWED launcher: setup OK on %COMPUTERNAME%. Starting in background, sync every %UWED_SYNC_INTERVAL_MINS% min." > "tgping.txt" 2>nul
findstr /i "ok.:true" "tgping.txt" >nul 2>nul && (
    echo [OK] Test message delivered to your Telegram.
) || (
    echo [WARN] Could NOT message you on Telegram. Make sure you pressed START
    echo        in the bot once, and bot_token.txt matches Vercel's token.
    type "tgping.txt" 2>nul
)
del "tgping.txt" >nul 2>nul
goto :eof

:write_vbs
REM Create the helper that relaunches this .bat HIDDEN (no console window).
> "%VBSFILE%" (
  echo Set sh = CreateObject^("WScript.Shell"^)
  echo sh.CurrentDirectory = "%~dp0"
  echo sh.Run "cmd /c ""%~f0"" run", 0, False
)
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
set /a _cf=0
:ensure_cf_loop
if exist "%CF_EXE%" for %%A in ("%CF_EXE%") do if %%~zA GTR 40000000 goto :eof
set /a _cf+=1
if !_cf! GTR 3 goto :eof
echo [CF] Fetching cloudflared (attempt !_cf!/3, ~52 MB)...
call :download "%CF_SRC%" "%CF_EXE%" "cloudflared tunnel"
goto ensure_cf_loop

:start_tunnel
tasklist /fi "imagename eq cloudflared.exe" 2>nul | find /i "cloudflared.exe" >nul
if not errorlevel 1 goto :eof
echo [TUNNEL] Opening a public Cloudflare tunnel...
del "%CF_LOG%" >nul 2>nul
start "" /b cmd /c ""%CF_EXE%" tunnel --no-autoupdate --protocol http2 --url http://localhost:%PORT% > "%CF_LOG%" 2>&1"
goto :eof

:get_url
set "TUNNEL_URL="
set /a _tries=0
:get_url_loop
set "TUNNEL_URL="
powershell -NoProfile -ExecutionPolicy Bypass -Command "$p='%CF_LOG%'; if(Test-Path $p){$m=[regex]::Matches((Get-Content -Raw -ErrorAction SilentlyContinue $p),'(?i)https://[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com'); if($m.Count){[Console]::Out.WriteLine($m[$m.Count-1].Value)}}" > "%URLFILE%" 2>nul
set /p TUNNEL_URL=<"%URLFILE%"
if defined TUNNEL_URL goto :eof
set /a _tries+=1
if !_tries! GEQ 20 goto :eof
echo   ...waiting for the tunnel (!_tries!/20)
timeout /t 2 >nul
goto get_url_loop

:download
REM %1 = url  %2 = destination  %3 = label
echo [DOWNLOAD] %~3 ...
where curl >nul 2>nul
if not errorlevel 1 (
    curl -C - -L --fail --retry 8 --retry-delay 2 --retry-all-errors --connect-timeout 20 -o "%~2" "%~1"
    if not errorlevel 1 if exist "%~2" goto :eof
)
echo [DOWNLOAD] retrying with PowerShell...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try{[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls13}catch{}; try{Invoke-WebRequest -Uri '%~1' -OutFile '%~2' -UseBasicParsing}catch{exit 1}"
if not errorlevel 1 if exist "%~2" goto :eof
echo [DOWNLOAD] retrying with bitsadmin...
bitsadmin /transfer uweddl /priority foreground "%~1" "%~2" >nul 2>nul
goto :eof
