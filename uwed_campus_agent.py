#!/usr/bin/env python3
"""
UWED Campus Agent — Автономный агент синхронизации расписания для кампуса УМЭД.
Работает на ПК в кампусе UWED и выгружает актуальное расписание на сервер Vercel.

Триггеры синхронизации ("когда угодно"):
1. Нажмите [ENTER] в этом окне в любой момент для немедленной синхронизации.
2. Отправьте команду /sync боту @uwedhelpdesk_bot в Telegram — агент поймает сигнал и обновит данные.
3. Нажмите кнопку "Синхронизировать" в Mini App.
4. Фоновый таймер (каждые 30 минут по умолчанию).
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

VERCEL_SYNC_URL = "https://uwed-miniapp.vercel.app/api/telemetry?action=sync_snapshot"
VERCEL_CHECK_URL = "https://uwed-miniapp.vercel.app/api/telemetry?action=check_sync_request"
ADMIN_KEY = "ec86c4b6c733d52d0471cfd9b26ab707"
UWED_HOST = "manage.uwed.uz"
DEFAULT_INTERVAL_MINUTES = 30
REMOTE_POLL_INTERVAL_SECONDS = 15

CLASSROOM_TYPES = {"PRACTICE", "LECTURE", "LANGUAGE_LAB", "COMPUTER", "SPORT_CENTER"}
TASHKENT_TZ = dt.timezone(dt.timedelta(hours=5))

sync_lock = threading.Lock()
manual_trigger_event = threading.Event()

def prevent_windows_sleep():
    """Предотвращает переход Windows в спящий режим и отключение сети."""
    if sys.platform == "win32":
        try:
            # ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x00000001, ES_AWAYMODE_REQUIRED = 0x00000040
            ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | 0x00000001 | 0x00000040)
            print("[Power] Windows Sleep Mode DISABLED (PC will stay online 24/7)")
        except Exception as e:
            print(f"[Power] Warning: {e}")

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
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) UWED-Campus-Agent/2.0",
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
        ts_now = dt.datetime.now().strftime("%H:%M:%S")
        print(f"\n[{ts_now}] === Starting Schedule Download from UWED Intranet ===")

        # 1. Slots
        slots_res = self.api_get("/timetable/public/v1/slots/by/academic/year", {"academic_year_id": "null"})
        slots = slots_res.get("data") if isinstance(slots_res.get("data"), list) else []
        print(f"  [+] Slots loaded: {len(slots)}")

        # 2. Rooms
        rooms_dict = {}
        for query in ("A-", "B-", "C-", "D-", "E-", "A", "B", "D"):
            res = self.api_get("/timetable/public/v1/search/rooms", {"search": query})
            for r in res.get("data") or []:
                rid = str(r.get("id") or "")
                if rid and rid not in rooms_dict:
                    r["floor"] = extract_floor(r)
                    rooms_dict[rid] = r
        rooms = list(rooms_dict.values())
        print(f"  [+] Rooms found: {len(rooms)}")

        # 3. Teachers (harvest by common 2-letter syllables)
        teachers_dict = {}
        prefixes = [
            "al", "ab", "ax", "az", "ba", "be", "bo", "da", "di", "ga", "gu",
            "ha", "ho", "ib", "ik", "il", "im", "in", "ir", "is", "ja", "jo",
            "ka", "ko", "ma", "me", "mi", "mu", "na", "no", "nu", "ol", "om",
            "or", "os", "ot", "pa", "pu", "qa", "qu", "ra", "re", "ri", "ro",
            "ru", "sa", "se", "si", "so", "su", "sh", "ch", "ta", "ti", "to",
            "tu", "ul", "um", "ur", "us", "va", "xa", "xo", "xu", "ya", "yo",
            "yu", "za", "zo", "zu"
        ]
        with ThreadPoolExecutor(max_workers=16) as pool:
            for tlist in pool.map(lambda p: self.api_get("/timetable/public/v1/search/teachers", {"search": p}).get("data") or [], prefixes):
                for t in tlist:
                    tid = str(t.get("id") or "")
                    if tid and tid not in teachers_dict:
                        teachers_dict[tid] = t
        teachers = list(teachers_dict.values())
        print(f"  [+] Teachers found: {len(teachers)}")

        # 4. Timetable events for active rooms (using NEW /events/list route)
        rooms_to_fetch = [
            r["id"]
            for r in rooms
            if str(r.get("building", "")).upper() in ("A", "B", "D")
            and (r.get("room_type") in CLASSROOM_TYPES or r.get("room_name") == "A-210")
        ]
        events_by_room = {}

        def fetch_events_for_room(rid: str) -> tuple[str, list[dict[str, Any]]]:
            res = self.api_get(
                "/timetable/public/v1/events/list",
                {"request_id": rid, "type": "ROOM", "start_time": monday},
            )
            evs = res.get("data")
            if not isinstance(evs, list):
                return rid, []
            cleaned = []
            for e in evs:
                cleaned.append({
                    "d": e.get("week_day"),
                    "s": e.get("slot_id"),
                    "t": e.get("title"),
                    "i": e.get("instructor"),
                    "g": e.get("groups"),
                    "r": e.get("room_number"),
                })
            return rid, cleaned

        print(f"  [+] Fetching schedules for {len(rooms_to_fetch)} classrooms (concurrent)...")
        with ThreadPoolExecutor(max_workers=20) as pool:
            for rid, evs in pool.map(fetch_events_for_room, rooms_to_fetch):
                events_by_room[rid] = evs

        active_events = sum(len(evs) for evs in events_by_room.values())
        print(f"  [+] Total weekly class events: {active_events}")

        return {
            "updated_at": int(time.time() * 1000),
            "week_monday": monday,
            "slots": slots,
            "rooms": rooms,
            "teachers": teachers,
            "events": events_by_room,
        }

def upload_snapshot_to_vercel(snapshot: dict[str, Any], trigger_source: str = "office_pc") -> bool:
    ts_now = dt.datetime.now().strftime("%H:%M:%S")
    print(f"[{ts_now}] Uploading to Vercel (source: {trigger_source})...")
    payload = json.dumps({"snapshot": snapshot, "source": trigger_source}).encode("utf-8")
    req = urllib.request.Request(
        VERCEL_SYNC_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-Admin-Key": ADMIN_KEY,
            "User-Agent": "UWED-Campus-Agent/2.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("success"):
                counts = data.get("counts", {})
                print(f"[{ts_now}] [SUCCESS] Live update saved to Vercel cloud!")
                print(f"          Rooms: {counts.get('rooms')} | Teachers: {counts.get('teachers')} | Events: {counts.get('events')}")
                return True
    except Exception as e:
        print(f"[{ts_now}] [ERROR] Upload failed: {e}")
    return False

def check_remote_sync_request() -> bool:
    """Проверяет, не нажал ли админ кнопку /sync в Telegram или в Mini App."""
    try:
        req = urllib.request.Request(
            f"{VERCEL_CHECK_URL}&key={ADMIN_KEY}",
            headers={"X-Admin-Key": ADMIN_KEY, "User-Agent": "UWED-Campus-Agent/2.0"},
        )
        with urllib.request.urlopen(req, timeout=8) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return bool(data.get("pending"))
    except Exception:
        return False

def perform_sync(fetcher: CampusFetcher, reason: str = "scheduled") -> bool:
    with sync_lock:
        try:
            snapshot = fetcher.fetch_full_snapshot()
            if snapshot.get("rooms") and snapshot.get("slots"):
                # Save local backup
                try:
                    local_f = Path(__file__).resolve().parent / "last_snapshot.json"
                    local_f.write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
                except Exception:
                    pass
                return upload_snapshot_to_vercel(snapshot, trigger_source=f"office_pc_{reason}")
            else:
                print(f"[!] Warning: Received empty data from UWED network. Will retry.")
        except Exception as e:
            print(f"[!] Sync exception: {e}")
        return False

def keyboard_listener():
    """Слушатель нажатия ENTER для мгновенной ручной синхронизации."""
    while True:
        try:
            input()
            print("\n[Input] Key pressed! Triggering immediate sync right now...")
            manual_trigger_event.set()
        except (EOFError, KeyboardInterrupt):
            break

def remote_poll_worker(fetcher: CampusFetcher):
    """Слушатель удаленных команд из Telegram (/sync) и Mini App."""
    while True:
        time.sleep(REMOTE_POLL_INTERVAL_SECONDS)
        try:
            if check_remote_sync_request():
                print("\n[Remote Trigger] Received /sync command from Telegram / Mini App! Syncing...")
                perform_sync(fetcher, reason="remote_trigger")
        except Exception:
            pass

def main():
    print("=" * 65)
    print("   UWED Smart Campus Sync Agent v2.0")
    print("   University of World Economy and Diplomacy")
    print("=" * 65)
    print(" * Real-time sync available ON-DEMAND anytime:")
    print("   - Press [ENTER] in this window at any second to sync")
    print("   - Send /sync to @uwedhelpdesk_bot in Telegram to sync remotely")
    print("   - Tap 'Sync' inside UWED Mini App")
    print("   - Auto-sync running every 30 minutes")
    print("=" * 65)

    prevent_windows_sleep()

    fetcher = CampusFetcher()

    # Запускаем фоновые слушатели
    t_key = threading.Thread(target=keyboard_listener, daemon=True)
    t_key.start()

    t_remote = threading.Thread(target=remote_poll_worker, args=(fetcher,), daemon=True)
    t_remote.start()

    # Первая немедленная синхронизация при запуске
    perform_sync(fetcher, reason="startup")

    # Главный цикл таймера
    last_sync_time = time.time()
    interval_seconds = DEFAULT_INTERVAL_MINUTES * 60

    while True:
        try:
            # Ждём либо нажатия кнопки, либо истечения таймера
            triggered = manual_trigger_event.wait(timeout=10)
            if triggered:
                manual_trigger_event.clear()
                perform_sync(fetcher, reason="manual_enter")
                last_sync_time = time.time()
            elif (time.time() - last_sync_time) >= interval_seconds:
                perform_sync(fetcher, reason="timer")
                last_sync_time = time.time()
        except KeyboardInterrupt:
            print("\nExiting agent.")
            break
        except Exception as e:
            time.sleep(5)

if __name__ == "__main__":
    main()
