#!/usr/bin/env python3
"""
UWED Campus Server & Sync Engine (УМЭД / JIDU)
==============================================
All-in-one local server for university campus machine:
1. Direct UWED Timetable Fetcher (0ms intranet access to manage.uwed.uz)
2. Harvester for Rooms, Slots, Teachers, Students & Weekly Class Events
3. Cloud Sync Engine: pushes live snapshots to Vercel Mini App & Gist
4. Local HTTP Relay & Tunnel Proxy (allows Vercel to query manage.uwed.uz)
5. Standalone Telegram Bot (Long-polling getUpdates without webhook conflicts)
6. 24/7 Windows Keep-Alive (prevents sleep mode and Wi-Fi drop)

Works on Windows & Linux. Zero external pip dependencies required.
"""
from __future__ import annotations

import argparse
import ctypes
import datetime as dt
import http.client
import http.server
import json
import os
import re
import socketserver
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

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BOT_TOKEN = os.environ.get(
    "UWED_BOT_TOKEN",
    "9214404778:AAE45Ty8GF45qKluBfFkuOpQxGiih42nYeE",
)
ADMIN_KEY = os.environ.get("UWED_ADMIN_KEY", "ec86c4b6c733d52d0471cfd9b26ab707")
VERCEL_BASE_URL = os.environ.get("VERCEL_BASE_URL", "https://uwed-miniapp.vercel.app")
VERCEL_SYNC_URL = f"{VERCEL_BASE_URL}/api/telemetry?action=sync_snapshot"
VERCEL_CHECK_URL = f"{VERCEL_BASE_URL}/api/telemetry?action=check_sync_request"
VERCEL_RELAY_REGISTER_URL = f"{VERCEL_BASE_URL}/api/telemetry?action=set_relay_url"
UWED_HOST = "manage.uwed.uz"
DEFAULT_PORT = int(os.environ.get("PORT", 8080))
DEFAULT_SYNC_INTERVAL_MINS = 20
REMOTE_POLL_INTERVAL_SECS = 15

TASHKENT_TZ = dt.timezone(dt.timedelta(hours=5))
CLASSROOM_TYPES = {"PRACTICE", "LECTURE", "LANGUAGE_LAB", "COMPUTER", "SPORT_CENTER"}

DEFAULT_SLOTS = [
    {"id": 1, "start_time": "08:30", "end_time": "09:40", "label": "1-пара"},
    {"id": 2, "start_time": "09:55", "end_time": "11:05", "label": "2-пара"},
    {"id": 3, "start_time": "11:20", "end_time": "12:30", "label": "3-пара"},
    {"id": 4, "start_time": "12:45", "end_time": "13:55", "label": "4-пара"},
    {"id": 5, "start_time": "14:30", "end_time": "15:40", "label": "5-пара"},
    {"id": 6, "start_time": "15:55", "end_time": "17:05", "label": "6-пара"},
    {"id": 7, "start_time": "17:20", "end_time": "18:30", "label": "7-пара"},
    {"id": 8, "start_time": "18:45", "end_time": "19:55", "label": "8-пара"},
]

WEEKDAY_NAMES_RU = {
    1: "Понедельник", 2: "Вторник", 3: "Среда", 4: "Четверг",
    5: "Пятница", 6: "Суббота", 7: "Воскресенье",
}

SEARCH_PREFIXES = [
    "al", "ab", "ax", "az", "ba", "be", "bo", "da", "di", "ga", "gu",
    "ha", "ho", "ib", "ik", "il", "im", "in", "ir", "is", "ja", "jo",
    "ka", "ko", "ma", "me", "mi", "mu", "na", "no", "nu", "ol", "om",
    "or", "os", "ot", "pa", "pu", "qa", "qu", "ra", "re", "ri", "ro",
    "ru", "sa", "se", "si", "so", "su", "sh", "ch", "ta", "ti", "to",
    "tu", "ul", "um", "ur", "us", "va", "xa", "xo", "xu", "ya", "yo",
    "yu", "za", "zo", "zu"
]

sync_lock = threading.Lock()
manual_trigger_event = threading.Event()
latest_snapshot: dict[str, Any] = {}


def now_tashkent() -> dt.datetime:
    return dt.datetime.now(tz=TASHKENT_TZ)


def get_monday_str(target_date: dt.date | None = None) -> str:
    if target_date is None:
        target_date = now_tashkent().date()
    monday = target_date - dt.timedelta(days=target_date.weekday())
    return monday.isoformat()


def prevent_windows_sleep() -> None:
    """Disables Windows Sleep Mode & Wi-Fi hibernation for 24/7 continuous uptime."""
    if sys.platform == "win32":
        try:
            # ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED
            ctypes.windll.kernel32.SetThreadExecutionState(0x80000000 | 0x00000001 | 0x00000040)
            print("[Power] Windows Sleep Mode DISABLED (PC will stay online 24/7)")
        except Exception as e:
            print(f"[Power] Warning setting power state: {e}")


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
    """High-speed HTTP client for manage.uwed.uz inside university intranet."""

    def __init__(self) -> None:
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

    def check_intranet_access(self) -> bool:
        """Verifies if manage.uwed.uz is directly reachable from this machine."""
        try:
            data = self.api_get("/timetable/public/v1/slots/by/academic/year", {"academic_year_id": "null"})
            return bool(data.get("data"))
        except Exception:
            return False

    def api_get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        clean_path = path if path.startswith("/") else f"/{path}"
        full_path = f"/api{clean_path}" if not clean_path.startswith("/api") else clean_path
        if params:
            full_path += "?" + urllib.parse.urlencode(params)
        for attempt in range(3):
            try:
                conn = self._get_conn()
                conn.request(
                    "GET",
                    full_path,
                    headers={
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) UWED-Campus-Server/3.0",
                        "Accept": "application/json, text/plain, */*",
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
                time.sleep(0.2 * (attempt + 1))
        return {}

    def fetch_full_snapshot(self) -> dict[str, Any]:
        monday = get_monday_str()
        ts_now = dt.datetime.now().strftime("%H:%M:%S")
        print(f"\n[{ts_now}] === Starting Deep Campus Harvest (manage.uwed.uz) ===")

        # 1. Slots
        slots_res = self.api_get("/timetable/public/v1/slots/by/academic/year", {"academic_year_id": "null"})
        slots = slots_res.get("data") if isinstance(slots_res.get("data"), list) else list(DEFAULT_SLOTS)
        print(f"  [+] Slots: {len(slots)}")

        # 2. Rooms
        rooms_dict = {}
        for query in ("A-", "B-", "C-", "D-", "E-", "A", "B", "D", "Coworking", "Majlislar"):
            res = self.api_get("/timetable/public/v1/search/rooms", {"search": query})
            for r in res.get("data") or []:
                rid = str(r.get("id") or "")
                if rid and rid not in rooms_dict:
                    name = str(r.get("name") or r.get("room_name") or "").strip()
                    num = str(r.get("number") or r.get("room_number") or "").strip()
                    rtype = str(r.get("type") or r.get("room_type") or "PRACTICE")
                    bld = str(r.get("building") or (name[0].upper() if name else "A"))
                    r["name"] = name
                    r["room_name"] = name
                    r["number"] = num
                    r["room_number"] = num
                    r["type"] = rtype
                    r["room_type"] = rtype
                    r["building"] = bld
                    r["floor"] = extract_floor(r)
                    if "capacity" not in r or r["capacity"] is None:
                        r["capacity"] = 30
                    rooms_dict[rid] = r
        rooms = list(rooms_dict.values())
        print(f"  [+] Rooms: {len(rooms)}")

        # 3. Teachers (parallel syllable harvester)
        teachers_dict = {}
        with ThreadPoolExecutor(max_workers=16) as pool:
            for tlist in pool.map(lambda p: self.api_get("/timetable/public/v1/search/teachers", {"search": p}).get("data") or [], SEARCH_PREFIXES):
                for t in tlist:
                    tid = str(t.get("id") or "")
                    if tid and tid not in teachers_dict:
                        teachers_dict[tid] = t
        teachers = list(teachers_dict.values())
        print(f"  [+] Teachers: {len(teachers)}")

        # 4. Students & Groups (parallel syllable harvester)
        students_dict = {}
        with ThreadPoolExecutor(max_workers=16) as pool:
            for slist in pool.map(lambda p: self.api_get("/education/public/v1/student/search/for-timetable", {"search": p}).get("data") or [], SEARCH_PREFIXES):
                for s in slist:
                    sid = str(s.get("id") or "")
                    if sid and sid not in students_dict:
                        students_dict[sid] = s
        students = list(students_dict.values())
        print(f"  [+] Students harvested: {len(students)}")

        # 5. Timetable events for active classrooms
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

        print(f"  [+] Fetching weekly schedules for {len(rooms_to_fetch)} classrooms (concurrent)...")
        with ThreadPoolExecutor(max_workers=20) as pool:
            for rid, evs in pool.map(fetch_events_for_room, rooms_to_fetch):
                events_by_room[rid] = evs

        active_events = sum(len(evs) for evs in events_by_room.values())
        print(f"  [+] Total weekly classes: {active_events}")

        # 6. Extract unique groups from events and synthesize group records if needed
        groups_seen = set()
        for evs in events_by_room.values():
            for e in evs:
                g = e.get("g")
                if not g:
                    continue
                parts = re.findall(r"[A-Za-z0-9\-]+", str(g))
                for p in parts:
                    if len(p) >= 3 and "-" in p:
                        groups_seen.add(p)

        print(f"  [+] Unique student academic groups: {len(groups_seen)}")
        for grp in sorted(groups_seen):
            grp_id = f"grp:{grp}"
            if grp_id not in students_dict:
                students.append({
                    "id": grp_id,
                    "full_name": f"Guruh {grp} (Группа {grp})",
                    "group": grp,
                    "is_group": True,
                })

        return {
            "updated_at": int(time.time() * 1000),
            "week_monday": monday,
            "slots": slots,
            "rooms": rooms,
            "teachers": teachers,
            "students": students,
            "events": events_by_room,
        }


def upload_snapshot_to_vercel(snapshot: dict[str, Any], trigger_source: str = "campus_server") -> bool:
    global latest_snapshot
    latest_snapshot = snapshot
    ts_now = dt.datetime.now().strftime("%H:%M:%S")
    print(f"[{ts_now}] Uploading full snapshot to Vercel Cloud (source: {trigger_source})...")
    payload = json.dumps({"snapshot": snapshot, "source": trigger_source}).encode("utf-8")
    req = urllib.request.Request(
        VERCEL_SYNC_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-Admin-Key": ADMIN_KEY,
            "User-Agent": "UWED-Campus-Server/3.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=35) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("success"):
                counts = data.get("counts", {})
                print(f"[{ts_now}] [SUCCESS] Live update synced with Vercel!")
                print(f"          Rooms: {counts.get('rooms')} | Teachers: {counts.get('teachers')} | Students: {len(snapshot.get('students', []))} | Events: {counts.get('events')}")
                return True
    except Exception as e:
        print(f"[{ts_now}] [ERROR] Upload failed: {e}")
    return False


def register_relay_url_with_vercel(relay_url: str) -> bool:
    try:
        payload = json.dumps({"relay_url": relay_url, "admin_key": ADMIN_KEY}).encode("utf-8")
        req = urllib.request.Request(
            VERCEL_RELAY_REGISTER_URL,
            data=payload,
            headers={"Content-Type": "application/json", "X-Admin-Key": ADMIN_KEY},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return bool(data.get("success"))
    except Exception as e:
        print(f"[Relay] Warning registering relay URL with Vercel: {e}")
        return False


def check_remote_sync_request() -> bool:
    try:
        req = urllib.request.Request(
            f"{VERCEL_CHECK_URL}&key={ADMIN_KEY}",
            headers={"X-Admin-Key": ADMIN_KEY, "User-Agent": "UWED-Campus-Server/3.0"},
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
                # Save locally to last_snapshot.json and public/snapshot.json
                for target_path in (
                    Path(__file__).resolve().parent / "last_snapshot.json",
                    Path(__file__).resolve().parent / "public" / "snapshot.json",
                    Path(__file__).resolve().parent / "uwed-miniapp" / "public" / "snapshot.json",
                ):
                    try:
                        target_path.parent.mkdir(parents=True, exist_ok=True)
                        target_path.write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
                    except Exception:
                        pass
                return upload_snapshot_to_vercel(snapshot, trigger_source=f"campus_server_{reason}")
            else:
                print("[!] Warning: Received incomplete data from UWED network. Will retry.")
        except Exception as e:
            print(f"[!] Sync exception: {e}")
        return False


# ==============================================================================
# Built-in HTTP Relay Proxy for Port 8080
# ==============================================================================
class CampusRelayHandler(http.server.BaseHTTPRequestHandler):
    fetcher = CampusFetcher()

    def do_OPTIONS(self) -> None:
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Key, X-UWED-Client")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)
        params = {k: v[0] if len(v) == 1 else v for k, v in qs.items()}

        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        if path in ("/health", "/ping"):
            res = {"status": "ok", "intranet": "connected", "time": int(time.time() * 1000)}
            self.wfile.write(json.dumps(res).encode("utf-8"))
            return

        if path == "/snapshot":
            res = latest_snapshot or {"status": "empty"}
            self.wfile.write(json.dumps(res, ensure_ascii=False).encode("utf-8"))
            return

        # Direct forward to manage.uwed.uz
        result = self.fetcher.api_get(path, params)
        if not result:
            result = {"success": True, "data": [], "relay_empty": True}
        self.wfile.write(json.dumps(result, ensure_ascii=False).encode("utf-8"))

    def log_message(self, format: str, *args: Any) -> None:
        # Keep console output clean
        pass


class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def start_relay_server(port: int = DEFAULT_PORT) -> ThreadedHTTPServer:
    server = ThreadedHTTPServer(("0.0.0.0", port), CampusRelayHandler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    print(f"[Relay] Local HTTP Proxy listening on http://0.0.0.0:{port}")
    return server


# ==============================================================================
# Standalone Telegram Bot for Direct Campus Operation
# ==============================================================================
class StandaloneCampusBot:
    """Telegram Bot operating natively from inside university campus via long-polling."""

    def __init__(self, token: str, fetcher: CampusFetcher) -> None:
        self.token = token
        self.fetcher = fetcher
        self.offset = 0

    def api_call(self, method: str, payload: dict[str, Any] | None = None, timeout: int = 20) -> dict[str, Any]:
        url = f"https://api.telegram.org/bot{self.token}/{method}"
        data = json.dumps(payload).encode("utf-8") if payload else None
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": "application/json"} if data else {},
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except Exception:
            return {}

    def delete_webhook(self) -> bool:
        res = self.api_call("deleteWebhook", {"drop_pending_updates": False})
        return bool(res.get("ok"))

    def send_message(self, chat_id: int | str, text: str, reply_markup: dict[str, Any] | None = None) -> None:
        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }
        if reply_markup:
            payload["reply_markup"] = reply_markup
        self.api_call("sendMessage", payload)

    def handle_message(self, msg: dict[str, Any]) -> None:
        chat_id = msg.get("chat", {}).get("id")
        text = str(msg.get("text", "")).strip()
        if not chat_id or not text:
            return

        cmd = text.split()[0].lower() if text.startswith("/") else ""

        if cmd in ("/start", "/help"):
            kb = {
                "inline_keyboard": [
                    [{"text": "🚀 Открыть UWED Mini App", "web_app": {"url": VERCEL_BASE_URL}}],
                    [
                        {"text": "🔍 Свободные аудитории", "callback_data": "now"},
                        {"text": "🔄 Синхронизировать", "callback_data": "sync"},
                    ],
                ]
            }
            welcome = (
                f"🏛 <b>UWED Smart Campus Bot (УМЭД / JIDU)</b>\n\n"
                f"Бот работает <b>напрямую внутри сервера университета</b> с моментальным доступом к расписанию!\n\n"
                f"🔹 Нажмите <b>Открыть UWED Mini App</b> для интерактивной карты\n"
                f"🔹 Введите номер аудитории (напр. <code>A-210</code>, <code>B-301</code>)\n"
                f"🔹 Введите фамилию преподавателя или группу (напр. <code>10a-24</code>)\n"
                f"🔹 Команды: /now, /sync, /status, /fix"
            )
            self.send_message(chat_id, welcome, reply_markup=kb)
            return

        if cmd == "/sync":
            self.send_message(chat_id, "🔄 Запускаю принудительную синхронизацию с manage.uwed.uz...")
            ok = perform_sync(self.fetcher, reason="tg_command")
            if ok:
                self.send_message(chat_id, "✅ <b>Синхронизация завершена успешно!</b>\nВсе данные выгружены на Vercel.")
            else:
                self.send_message(chat_id, "⚠️ Ошибка синхронизации. Проверьте соединение.")
            return

        if cmd in ("/fix", "/status"):
            is_ok = self.fetcher.check_intranet_access()
            st_text = (
                f"🛠 <b>UWED Campus Server Status</b>\n\n"
                f"📡 Кампусная сеть (manage.uwed.uz): {'🟢 ДОСТУПНА' if is_ok else '🔴 НЕДОСТУПНА'}\n"
                f"⏱ Время сервера: {now_tashkent().strftime('%Y-%m-%d %H:%M:%S')}\n"
                f"📦 Кэш аудиторий: {len(latest_snapshot.get('rooms', []))}\n"
                f"👨‍🏫 Преподавателей: {len(latest_snapshot.get('teachers', []))}\n"
                f"🎓 Студентов / групп: {len(latest_snapshot.get('students', []))}\n"
                f"⚡️ Mini App: {VERCEL_BASE_URL}"
            )
            self.send_message(chat_id, st_text)
            return

        if cmd == "/now":
            self.send_message(chat_id, "🔍 Поиск свободных аудиторий прямо сейчас...\n(Откройте Mini App для полной интерактивной 3D-карты!)")
            return

        # Direct search by room or teacher name
        rooms_found = self.fetcher.api_get("/timetable/public/v1/search/rooms", {"search": text}).get("data") or []
        teachers_found = self.fetcher.api_get("/timetable/public/v1/search/teachers", {"search": text}).get("data") or []
        students_found = self.fetcher.api_get("/education/public/v1/student/search/for-timetable", {"search": text}).get("data") or []

        resp_lines = [f"🔎 Результаты поиска по запросу «<b>{text}</b>»:\n"]
        if rooms_found:
            resp_lines.append("🚪 <b>Аудитории:</b>")
            for r in rooms_found[:5]:
                resp_lines.append(f"• {r.get('room_name')} ({r.get('room_type', 'PRACTICE')})")
        if teachers_found:
            resp_lines.append("\n👨‍🏫 <b>Преподаватели:</b>")
            for t in teachers_found[:5]:
                resp_lines.append(f"• {t.get('full_name')}")
        if students_found:
            resp_lines.append("\n🎓 <b>Студенты / Группы:</b>")
            for s in students_found[:5]:
                resp_lines.append(f"• {s.get('full_name')}")

        if not rooms_found and not teachers_found and not students_found:
            resp_lines.append("Ничего не найдено. Попробуйте ввести номер аудитории (напр. B-201) или код группы.")

        self.send_message(chat_id, "\n".join(resp_lines))

    def run_polling(self) -> None:
        print("[Bot] Removing old webhook to enable direct campus polling...")
        self.delete_webhook()
        me = self.api_call("getMe")
        bot_info = me.get("result") or {}
        print(f"[Bot] Standalone Campus Bot @{bot_info.get('username')} is active!")

        while True:
            try:
                res = self.api_call(
                    "getUpdates",
                    {"offset": self.offset, "timeout": 20, "allowed_updates": ["message", "callback_query"]},
                    timeout=30,
                )
                for upd in res.get("result") or []:
                    self.offset = int(upd["update_id"]) + 1
                    if "message" in upd:
                        threading.Thread(target=self.handle_message, args=(upd["message"],), daemon=True).start()
                    elif "callback_query" in upd:
                        cb = upd["callback_query"]
                        data = cb.get("data")
                        cid = cb.get("message", {}).get("chat", {}).get("id")
                        if data == "sync" and cid:
                            self.send_message(cid, "🔄 Запуск синхронизации...")
                            perform_sync(self.fetcher, reason="cb_sync")
                            self.send_message(cid, "✅ Синхронизация завершена!")
            except Exception as e:
                time.sleep(2)


# ==============================================================================
# Main Orchestrator
# ==============================================================================
def keyboard_listener():
    while True:
        try:
            line = input().strip()
            if line.lower() == "q":
                print("\n[Exit] Stopping server...")
                os._exit(0)
            print("\n[Input] Key pressed! Triggering immediate campus sync right now...")
            manual_trigger_event.set()
        except (EOFError, KeyboardInterrupt):
            break


def remote_poll_worker(fetcher: CampusFetcher):
    while True:
        time.sleep(REMOTE_POLL_INTERVAL_SECS)
        try:
            if check_remote_sync_request():
                print("\n[Remote Trigger] Received /sync command from Telegram / Mini App! Syncing...")
                perform_sync(fetcher, reason="remote_trigger")
        except Exception:
            pass


def main() -> None:
    parser = argparse.ArgumentParser(description="UWED Campus Server & Sync Engine")
    parser.add_argument("--bot", action="store_true", help="Run standalone Telegram Bot directly on campus")
    parser.add_argument("--relay-only", action="store_true", help="Run only HTTP relay server without bot")
    parser.add_argument("--sync-only", action="store_true", help="Perform one-time harvest & sync and exit")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Port for local HTTP Relay (default: 8080)")
    parser.add_argument("--relay-url", type=str, default="", help="Public Tunnel URL (e.g. from cloudflared) to register with Vercel")
    args = parser.parse_args()

    print("=" * 65)
    print("   UWED Smart Campus Server & Sync Engine v3.0")
    print("   University of World Economy and Diplomacy")
    print("=" * 65)

    prevent_windows_sleep()

    fetcher = CampusFetcher()
    print("[Intranet] Checking connection to manage.uwed.uz...")
    if fetcher.check_intranet_access():
        print("  [OK] Successfully connected to UWED Intranet (manage.uwed.uz)!")
    else:
        print("  [!] WARNING: Could not connect to manage.uwed.uz. Please check Wi-Fi / LAN connection.")

    if args.sync_only:
        perform_sync(fetcher, reason="cli_sync_only")
        print("\n[Done] One-time sync complete.")
        return

    # Start HTTP Relay Server
    start_relay_server(args.port)

    # Register Relay URL if provided
    if args.relay_url:
        print(f"[Relay] Registering public URL {args.relay_url} with Vercel...")
        if register_relay_url_with_vercel(args.relay_url):
            print("  [OK] Vercel is now routing live student & schedule queries through this server!")

    # Start Background Listeners
    t_key = threading.Thread(target=keyboard_listener, daemon=True)
    t_key.start()

    t_remote = threading.Thread(target=remote_poll_worker, args=(fetcher,), daemon=True)
    t_remote.start()

    # Initial sync on launch
    print("[Sync] Running initial harvest and sync with Vercel...")
    perform_sync(fetcher, reason="startup")

    # If --bot is requested or run interactively
    if args.bot:
        bot = StandaloneCampusBot(BOT_TOKEN, fetcher)
        t_bot = threading.Thread(target=bot.run_polling, daemon=True)
        t_bot.start()

    print("\n" + "=" * 65)
    print(" [READY] UWED Campus Engine is active 24/7!")
    print(f" - Local Relay: http://localhost:{args.port}/api/...")
    print(f" - Mini App:    {VERCEL_BASE_URL}")
    print(" - Press [ENTER] in this window anytime to force instant sync")
    print(" - Send /sync to @uwedhelpdesk_bot in Telegram to sync remotely")
    print(" - Auto-sync interval: every 20 minutes")
    print("=" * 65 + "\n")

    last_sync_time = time.time()
    interval_seconds = DEFAULT_SYNC_INTERVAL_MINS * 60

    while True:
        try:
            triggered = manual_trigger_event.wait(timeout=10)
            if triggered:
                manual_trigger_event.clear()
                perform_sync(fetcher, reason="manual_enter")
                last_sync_time = time.time()
            elif (time.time() - last_sync_time) >= interval_seconds:
                perform_sync(fetcher, reason="timer")
                last_sync_time = time.time()
        except KeyboardInterrupt:
            print("\nExiting server.")
            break
        except Exception as e:
            time.sleep(5)


if __name__ == "__main__":
    main()
