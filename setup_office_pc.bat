@echo off
chcp 65001 > nul
title UWED Campus Agent Setup
echo =======================================================
echo    Настройка офисного ПК UWED для 24/7 синхронизации
echo =======================================================
echo.
echo [1/3] Отключение спящего режима Windows...
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 15
powercfg /change hibernate-timeout-ac 0

echo [2/3] Добавление агента в автозагрузку Windows...
set STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup
echo @echo off > "%STARTUP_DIR%\uwed_campus_agent.bat"
echo cd /d "%~dp0" >> "%STARTUP_DIR%\uwed_campus_agent.bat"
echo python uwed_campus_agent.py >> "%STARTUP_DIR%\uwed_campus_agent.bat"

echo [3/3] Запуск агента прямо сейчас...
start "UWED Campus Agent" python uwed_campus_agent.py

echo.
echo =======================================================
echo  ✅ НАСТРОЙКА УСПЕШНО ЗАВЕРШЕНА!
echo  Агент запущен в отдельном окне.
echo  При перезагрузке ПК он запустится сам.
echo  Спящий режим отключен.
echo =======================================================
pause
