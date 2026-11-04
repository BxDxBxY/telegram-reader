#!/usr/bin/env python3
"""
UWED Campus Agent — Автономный агент синхронизации расписания для офисного ПК в кампусе УМЭД.
Запускается на компьютере внутри сети UWED (Wi-Fi или кабель) и автоматически
выгружает актуальное расписание, слоты, аудитории и преподавателей на сервер Vercel.

Особенности:
- Чистый Python 3 (без сторонних библиотек, работает из коробки)
- Защита от спящего режима Windows (ПК не уснёт и не отключит Wi-Fi)
- Многопоточная выгрузка расписания за 3-5 секунд
- Автоматический повтор при временном падении Wi-Fi
- Возможность автозапуска при включении компьютера
"""
from __future__ import annotations

import ctypes
import datetime as dt
import http.client
import json
import os
import re
import ssl
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

# Настройки сервера Vercel и аутентификации
VERCEL_SYNC_URL = "https://uwed-miniapp.vercel.app/api/telemetry?action=sync_snapshot"
ADMIN_KEY = "ec86c4b6c733d52d0471cfd9b26ab707"
UWED_HOST = "manage.uwed.uz"
SYNC_INTERVAL_MINUTES = 30

CLASSROOM_TYPES = {"PRACTICE", "LECTURE", "LANGUAGE_LAB", "COMPUTER", "SPORT_CENTER"}
TASHKENT_TZ = dt.timezone(dt.timedelta(hours=5))

# Предотвращение перехода Windows в спящий режим
def prevent_windows_sleep():
    if sys.platform == "win32":
        try:
            # ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x00000001, ES_AWAYMODE_REQUIRED = 0x00000040
            ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | 0x00000001 | 0x00000040)
            print("[power] Защита от спящего режима Windows активна (ПК не уснёт)")
        except Exception as e:
            print(f"[power] Предупреждение SetThreadExecutionState: {e}")

def get_monday_str() -> str:
    now = dt.datetime.now(tz=TASHKENT_TZ).date()
    monday = now - dt.timedelta(days=now.weekday())
    return monday.isoformat()

def extract_floor(room: dict[str, Any]) -> int | None:
    num = str(room.get("room_number", "")).strip()
    if num and num[0].isdigit():
        return int(num[0])
    name = str(room.get("room_name", "")).strip()
    m = re.search(r"-[0]*([1-9])\d{1,2}", name)
    if m:
        return int(m.group(1))
    return None

class CampusFetcher:
    def __init__(self):
        self._tls = threading.local()

    def _get_conn(self) -> http.client.HTTPSConnection:
        conn = getattr(self._tls, "conn", None)
        if conn is None:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            conn = http.client.HTTPSConnection(UWED_HOST, timeout=12, context=ctx)
            self._tls.conn = conn
        return conn

    def api_get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        full_path = f"/api{path}"
        if params:
            full_path += "?" + urllib.parse.urlencode(params)
        for attempt in range(3):
            try:
                conn = self._get_conn()
                conn.request(
                    "GET",
                    full_path,
                    headers={
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) UWED-Campus-Agent/1.0",
                        "Accept": "application/json",
                        "Connection": "keep-alive",
                        "Referer": f"https://{UWED_HOST}/",
                    },
                )
                resp = conn.getresponse()
                raw = resp.read().decode("utf-8", errors="ignore")
                if resp.status == 200 and raw:
                    return json.loads(raw)
            except Exception:
                self._tls.conn = None
                time.sleep(0.3 * (attempt + 1))
        return {}

    def fetch_full_snapshot(self) -> dict[str, Any]:
        monday = get_monday_str()
        print(f"\n[{dt.datetime.now().strftime('%H:%M:%S')}] 🔄 Начинаю скачивание расписания из сети UWED...")

        # 1. Слоты (пары)
        slots_res = self.api_get("/timetable/public/v1/slots/by/academic/year", {"academic_year_id": "null"})
        slots = slots_res.get("data") if isinstance(slots_res.get("data"), list) else []
        print(f"  • Получено учебных слотов: {len(slots)}")

        # 2. Аудитории (все блоки)
        rooms_dict = {}
        for query in ("A-", "B-", "C-", "D-", "E-", "A", "B", "D"):
            res = self.api_get("/timetable/public/v1/search/rooms", {"search": query})
            for r in res.get("data") or []:
                rid = str(r.get("id") or "")
                if rid and rid not in rooms_dict:
                    r["floor"] = extract_floor(r)
                    rooms_dict[rid] = r
        rooms = list(rooms_dict.values())
        print(f"  • Найдено уникальных аудиторий: {len(rooms)}")

        # 3. Преподаватели (популярные запросы + поиск)
        teachers_dict = {}
        alphabet = "abcdefghijklmnopqrstuvwxyz"
        for letter in alphabet:
            res = self.api_get("/timetable/public/v1/search/teachers", {"search": letter})
            for t in res.get("data") or []:
                tid = str(t.get("id") or "")
                if tid and tid not in teachers_dict:
                    teachers_dict[tid] = t
        teachers = list(teachers_dict.values())
        print(f"  • Найдено преподавателей: {len(teachers)}")

        # 4. Расписание для аудиторий на текущую неделю
        rooms_to_fetch = [
            r["id"]
            for r in rooms
            if str(r.get("building", "")).upper() in ("A", "B", "D")
            and (r.get("room_type") in CLASSROOM_TYPES or r.get("room_name") == "A-210")
        ]
        events_by_room = {}

        def fetch_events_for_room(rid: str) -> tuple[str, list[dict[str, Any]]]:
            res = self.api_get(
                "/timetable/public/v1/events",
                {"request_id": rid, "type": "ROOM", "start_time": monday},
            )
            evs = res.get("data")
            return rid, (evs if isinstance(evs, list) else [])

        print(f"  • Выгрузка расписания для {len(rooms_to_fetch)} аудиторий (параллельно)...")
        with ThreadPoolExecutor(max_workers=20) as pool:
            for rid, evs in pool.map(fetch_events_for_room, rooms_to_fetch):
                events_by_room[rid] = evs

        active_events_count = sum(len(evs) for evs in events_by_room.values())
        print(f"  • Всего занятий в расписании на эту неделю: {active_events_count}")

        snapshot = {
            "updated_at": int(time.time() * 1000),
            "week_monday": monday,
            "slots": slots,
            "rooms": rooms,
            "teachers": teachers,
            "events": events_by_room,
        }
        return snapshot

def upload_snapshot_to_vercel(snapshot: dict[str, Any]) -> bool:
    print(f"[{dt.datetime.now().strftime('%H:%M:%S')}] 📡 Отправка слепка на сервер Vercel...")
    payload = json.dumps({"snapshot": snapshot, "source": "uwed_office_pc"}).encode("utf-8")
    req = urllib.request.Request(
        VERCEL_SYNC_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-Admin-Key": ADMIN_KEY,
            "User-Agent": "UWED-Campus-Agent/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            raw = resp.read().decode("utf-8")
            data = json.loads(raw)
            if data.get("success"):
                counts = data.get("counts", {})
                print(f"✅ УСПЕШНО синхронизировано на сервере!")
                print(f"   Аудиторий: {counts.get('rooms')} | Преподавателей: {counts.get('teachers')} | Расписаний: {counts.get('events')}")
                return True
            else:
                print(f"❌ Сервер вернул ошибку: {data}")
                return False
    except Exception as e:
        print(f"❌ Ошибка отправки на Vercel: {e}")
        return False

def setup_windows_autostart():
    """Добавляет скрипт в автозагрузку текущего пользователя Windows."""
    if sys.platform != "win32":
        return
    try:
        startup_dir = Path(os.environ.get("APPDATA", "")) / "Microsoft" / "Windows" / "Start Menu" / "Programs" / "Startup"
        if startup_dir.exists():
            bat_path = startup_dir / "uwed_campus_agent.bat"
            py_path = sys.executable
            script_path = Path(__file__).resolve()
            bat_content = f'@echo off\r\nstart "" "{py_path}" "{script_path}"\r\n'
            bat_path.write_text(bat_content, encoding="utf-8")
            print(f"[autostart] ✅ Ярлык автозапуска создан: {bat_path}")
    except Exception as e:
        print(f"[autostart] Не удалось создать автозапуск: {e}")

def main():
    print("=" * 60)
    print("  UWED Smart Campus Sync Agent v1.0")
    print("  Автономный агент синхронизации расписания для кампуса УМЭД")
    print("=" * 60)
    prevent_windows_sleep()
    setup_windows_autostart()

    fetcher = CampusFetcher()

    while True:
        try:
            snapshot = fetcher.fetch_full_snapshot()
            if snapshot.get("rooms") and snapshot.get("slots"):
                # Сохраняем локальную копию
                local_file = Path(__file__).resolve().parent / "last_snapshot.json"
                local_file.write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
                upload_snapshot_to_vercel(snapshot)
            else:
                print("⚠️ Получены пустые данные, возможно, временный сбой сети UWED. Повтор через 2 минуты.")
                time.sleep(120)
                continue
        except Exception as e:
            print(f"⚠️ Ошибка в цикле синхронизации: {e}")
            time.sleep(60)
            continue

        next_time = dt.datetime.now() + dt.timedelta(minutes=SYNC_INTERVAL_MINUTES)
        print(f"\n⏳ Ожидание {SYNC_INTERVAL_MINUTES} мин. Следующая синхронизация в {next_time.strftime('%H:%M:%S')}...\n")
        time.sleep(SYNC_INTERVAL_MINUTES * 60)

if __name__ == "__main__":
    main()
