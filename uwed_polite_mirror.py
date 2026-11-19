#!/usr/bin/env python3
"""
UWED Polite Full Database Mirror (УМЭД / JIDU)
===============================================
Gently mirrors public timetable data from manage.uwed.uz into a local SQLite
database (data/uwed_mirror.db) and exports an offline-ready snapshot.json.

Design principles:
- Gentle rate limiting: 1 request at a time with configurable delay + jitter
  (default 0.9s - 1.4s) so the university server is NEVER loaded.
- Automatic exponential backoff on HTTP 429 / 503 / timeouts.
- Full checkpoint/resume: if interrupted, restarts from the exact step & key
  where it left off without re-fetching completed items.
- Exports compact public/snapshot.json & uwed-miniapp/public/snapshot.json
  for 100% offline resilience when manage.uwed.uz is unreachable.

Usage:
  python uwed_polite_mirror.py                   # Polite resume/mirror
  python uwed_polite_mirror.py --delay 1.5       # Extra gentle (1.5s/req)
  python uwed_polite_mirror.py --reset           # Start fresh sweep
  python uwed_polite_mirror.py --export-only     # Rebuild snapshot.json from SQLite
  python uwed_polite_mirror.py --upload          # Also push snapshot to Vercel
"""
from __future__ import annotations

import argparse
import datetime as dt
import http.client
import json
import os
import random
import re
import sqlite3
import ssl
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROOT_DIR = Path(__file__).resolve().parent
DB_PATH = ROOT_DIR / "data" / "uwed_mirror.db"
UWED_HOST = "manage.uwed.uz"
TASHKENT_TZ = dt.timezone(dt.timedelta(hours=5))
VERCEL_SYNC_URL = os.environ.get(
    "VERCEL_SYNC_URL",
    "https://uwed-miniapp.vercel.app/api/telemetry?action=sync_snapshot",
)
ADMIN_KEY = os.environ.get("UWED_ADMIN_KEY", "")

ROOM_QUERIES = [
    "A-", "B-", "C-", "D-", "E-", "A", "B", "D",
    "10", "20", "30", "40", "50", "60", "70",
    "Coworking", "Majlislar", "Zal", "Lab",
]

# Polite 2-letter prefixes covering Uzbek/Russian/English Latin names at UWED
NAME_PREFIXES = [
    "ab", "ad", "af", "ag", "ah", "ak", "al", "am", "an", "ar", "as", "at", "av", "ax", "az",
    "ba", "be", "bi", "bo", "bu", "ch", "da", "de", "di", "do", "du", "eg", "el", "em", "er", "es",
    "fa", "fe", "fi", "fo", "ga", "ge", "gi", "go", "gu", "ha", "hi", "ho", "hu",
    "ib", "id", "ik", "il", "im", "in", "ir", "is", "iz", "ja", "ji", "jo", "ju",
    "ka", "ke", "ki", "ko", "ku", "la", "le", "li", "lo", "lu",
    "ma", "me", "mi", "mo", "mu", "na", "ne", "ni", "no", "nu",
    "ob", "od", "og", "ok", "ol", "om", "or", "os", "ot", "ox", "oz",
    "pa", "pe", "pi", "po", "pu", "qa", "qi", "qo", "qu",
    "ra", "re", "ri", "ro", "ru", "sa", "se", "sh", "si", "so", "su",
    "ta", "te", "ti", "to", "tu", "ub", "ul", "um", "ur", "us", "ut",
    "va", "ve", "vi", "vo", "xa", "xe", "xi", "xo", "xu",
    "ya", "ye", "yo", "yu", "za", "ze", "zi", "zo", "zu",
]


def get_monday_str() -> str:
    now = dt.datetime.now(tz=TASHKENT_TZ).date()
    return (now - dt.timedelta(days=now.weekday())).isoformat()


def extract_floor(room: dict[str, Any]) -> int | None:
    num = str(room.get("room_number") or room.get("number") or "").strip()
    if num and num[0].isdigit():
        return int(num[0])
    name = str(room.get("room_name") or room.get("name") or "").strip()
    m = re.search(r"-[0]*([1-9])\d{1,2}", name)
    return int(m.group(1)) if m else None


class MirrorDB:
    """Local SQLite mirror with checkpoint/resume tracking."""

    def __init__(self, path: Path = DB_PATH) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(path))
        self.conn.execute("PRAGMA journal_mode=WAL;")
        self._init_schema()

    def _init_schema(self) -> None:
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT
            );
            CREATE TABLE IF NOT EXISTS slots (
                id INTEGER PRIMARY KEY,
                raw_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS rooms (
                id TEXT PRIMARY KEY,
                name TEXT,
                building TEXT,
                floor INTEGER,
                raw_json TEXT NOT NULL,
                updated_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS teachers (
                id TEXT PRIMARY KEY,
                full_name TEXT,
                raw_json TEXT NOT NULL,
                updated_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS students (
                id TEXT PRIMARY KEY,
                full_name TEXT,
                group_name TEXT,
                raw_json TEXT NOT NULL,
                updated_at INTEGER
            );
            CREATE TABLE IF NOT EXISTS room_events (
                room_id TEXT NOT NULL,
                week_monday TEXT NOT NULL,
                events_json TEXT NOT NULL,
                updated_at INTEGER,
                PRIMARY KEY (room_id, week_monday)
            );
            CREATE TABLE IF NOT EXISTS checkpoints (
                stage TEXT NOT NULL,
                item_key TEXT NOT NULL,
                done_at INTEGER,
                PRIMARY KEY (stage, item_key)
            );
            """
        )
        self.conn.commit()

    def reset_checkpoints(self) -> None:
        self.conn.execute("DELETE FROM checkpoints;")
        self.conn.commit()

    def is_done(self, stage: str, item_key: str) -> bool:
        cur = self.conn.execute(
            "SELECT 1 FROM checkpoints WHERE stage=? AND item_key=?",
            (stage, item_key),
        )
        return cur.fetchone() is not None

    def mark_done(self, stage: str, item_key: str) -> None:
        self.conn.execute(
            "INSERT OR REPLACE INTO checkpoints(stage, item_key, done_at) VALUES (?, ?, ?)",
            (stage, item_key, int(time.time())),
        )
        self.conn.commit()

    def upsert_slots(self, slots: list[dict[str, Any]]) -> None:
        for s in slots:
            sid = int(s.get("id", 0))
            if sid:
                self.conn.execute(
                    "INSERT OR REPLACE INTO slots(id, raw_json) VALUES (?, ?)",
                    (sid, json.dumps(s, ensure_ascii=False)),
                )
        self.conn.commit()

    def upsert_room(self, r: dict[str, Any]) -> None:
        rid = str(r.get("id") or "")
        if not rid:
            return
        name = str(r.get("name") or r.get("room_name") or "").strip()
        num = str(r.get("number") or r.get("room_number") or "").strip()
        rtype = str(r.get("type") or r.get("room_type") or "PRACTICE")
        bld = str(r.get("building") or (name[0].upper() if name else "A"))
        fl = extract_floor(r)
        norm = {
            **r,
            "id": rid,
            "name": name,
            "room_name": name,
            "number": num,
            "room_number": num,
            "type": rtype,
            "room_type": rtype,
            "building": bld,
            "floor": fl,
            "capacity": r.get("capacity") if r.get("capacity") is not None else 30,
        }
        self.conn.execute(
            "INSERT OR REPLACE INTO rooms(id, name, building, floor, raw_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (rid, name, bld, fl, json.dumps(norm, ensure_ascii=False), int(time.time())),
        )

    def upsert_teacher(self, t: dict[str, Any]) -> None:
        tid = str(t.get("id") or "")
        if not tid:
            return
        fn = str(t.get("full_name") or t.get("name") or "").strip()
        self.conn.execute(
            "INSERT OR REPLACE INTO teachers(id, full_name, raw_json, updated_at) VALUES (?, ?, ?, ?)",
            (tid, fn, json.dumps(t, ensure_ascii=False), int(time.time())),
        )

    def upsert_student(self, s: dict[str, Any]) -> None:
        sid = str(s.get("id") or "")
        if not sid:
            return
        fn = str(s.get("full_name") or s.get("name") or "").strip()
        grp = str(s.get("group") or s.get("group_name") or "").strip()
        self.conn.execute(
            "INSERT OR REPLACE INTO students(id, full_name, group_name, raw_json, updated_at) VALUES (?, ?, ?, ?, ?)",
            (sid, fn, grp, json.dumps(s, ensure_ascii=False), int(time.time())),
        )

    def upsert_room_events(self, room_id: str, week_monday: str, events: list[dict[str, Any]]) -> None:
        cleaned = [
            {
                "d": e.get("week_day"),
                "s": e.get("slot_id"),
                "t": e.get("title"),
                "i": e.get("instructor"),
                "g": e.get("groups"),
                "r": e.get("room_number"),
            }
            for e in events
        ]
        self.conn.execute(
            "INSERT OR REPLACE INTO room_events(room_id, week_monday, events_json, updated_at) VALUES (?, ?, ?, ?)",
            (room_id, week_monday, json.dumps(cleaned, ensure_ascii=False), int(time.time())),
        )

    def stats(self) -> dict[str, int]:
        out = {}
        for tbl in ("slots", "rooms", "teachers", "students", "room_events"):
            out[tbl] = self.conn.execute(f"SELECT COUNT(*) FROM {tbl}").fetchone()[0]
        return out

    def export_snapshot(self, week_monday: str) -> dict[str, Any]:
        slots = [
            json.loads(r[0])
            for r in self.conn.execute("SELECT raw_json FROM slots ORDER BY id ASC")
        ]
        rooms = [
            json.loads(r[0])
            for r in self.conn.execute("SELECT raw_json FROM rooms ORDER BY building, name")
        ]
        teachers = [
            json.loads(r[0])
            for r in self.conn.execute("SELECT raw_json FROM teachers ORDER BY full_name")
        ]
        students = [
            json.loads(r[0])
            for r in self.conn.execute("SELECT raw_json FROM students ORDER BY full_name")
        ]
        events: dict[str, list[dict[str, Any]]] = {}
        for rid, ev_json in self.conn.execute(
            "SELECT room_id, events_json FROM room_events WHERE week_monday=?",
            (week_monday,),
        ):
            events[rid] = json.loads(ev_json)

        # Fallback: if no events for current week_monday, use latest available per room
        if not events:
            for rid, ev_json in self.conn.execute(
                "SELECT room_id, events_json FROM room_events ORDER BY updated_at ASC"
            ):
                events[rid] = json.loads(ev_json)

        # Ensure all academic groups from events are also searchable in students
        seen_ids = {str(s.get("id")) for s in students}
        groups = set()
        for elist in events.values():
            for e in elist:
                g = e.get("g")
                if not g:
                    continue
                for part in re.findall(r"[A-Za-z0-9\-]+", str(g)):
                    if len(part) >= 3 and "-" in part:
                        groups.add(part)
        for grp in sorted(groups):
            gid = f"grp:{grp}"
            if gid not in seen_ids:
                students.append(
                    {
                        "id": gid,
                        "full_name": f"Guruh {grp} (Группа {grp})",
                        "group": grp,
                        "is_group": True,
                    }
                )
                seen_ids.add(gid)

        return {
            "updated_at": int(time.time() * 1000),
            "week_monday": week_monday,
            "slots": slots,
            "rooms": rooms,
            "teachers": teachers,
            "students": students,
            "events": events,
        }


class PoliteClient:
    """Single-threaded, rate-limited HTTPS client with polite backoff."""

    def __init__(self, base_delay: float = 0.9, jitter: float = 0.4) -> None:
        self.base_delay = max(0.3, base_delay)
        self.jitter = max(0.0, jitter)
        self._last_req_ts = 0.0
        self._ctx = ssl.create_default_context()
        self._ctx.check_hostname = False
        self._ctx.verify_mode = ssl.CERT_NONE
        self._conn: http.client.HTTPSConnection | None = None

    def _sleep_politely(self) -> None:
        elapsed = time.time() - self._last_req_ts
        target = self.base_delay + random.uniform(0.0, self.jitter)
        if elapsed < target:
            time.sleep(target - elapsed)
        self._last_req_ts = time.time()

    def _get_conn(self) -> http.client.HTTPSConnection:
        if self._conn is None:
            self._conn = http.client.HTTPSConnection(UWED_HOST, timeout=15, context=self._ctx)
        return self._conn

    def get_json(self, paths: list[str], params: dict[str, Any] | None = None) -> dict[str, Any] | None:
        """Tries candidate paths in order with polite delay and exponential backoff on 429/503."""
        qs = ("?" + urllib.parse.urlencode(params)) if params else ""
        for p in paths:
            full_path = p + qs
            for attempt in range(4):
                self._sleep_politely()
                try:
                    conn = self._get_conn()
                    conn.request(
                        "GET",
                        full_path,
                        headers={
                            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) UWED-Mirror/1.0",
                            "Accept": "application/json",
                            "Referer": f"https://{UWED_HOST}/",
                        },
                    )
                    resp = conn.getresponse()
                    raw = resp.read().decode("utf-8", errors="ignore")
                    if resp.status == 200 and raw.strip().startswith("{"):
                        return json.loads(raw)
                    if resp.status in (429, 502, 503, 504):
                        wait = min(30.0, (2 ** attempt) * 2.5 + random.uniform(0.5, 2.0))
                        print(f"  [Backoff] HTTP {resp.status} on {p}, sleeping {wait:.1f}s...")
                        self._conn = None
                        time.sleep(wait)
                        continue
                    if resp.status == 404:
                        break  # Try next candidate path
                except Exception as e:
                    self._conn = None
                    wait = min(15.0, (attempt + 1) * 2.0)
                    print(f"  [Retry] {p}: {e} (wait {wait:.1f}s)")
                    time.sleep(wait)
        return None


def write_snapshots(snap: dict[str, Any]) -> None:
    targets = [
        ROOT_DIR / "public" / "snapshot.json",
        ROOT_DIR / "uwed-miniapp" / "public" / "snapshot.json",
        ROOT_DIR / "data" / "last_mirror_snapshot.json",
    ]
    raw = json.dumps(snap, ensure_ascii=False)
    for t in targets:
        try:
            t.parent.mkdir(parents=True, exist_ok=True)
            t.write_text(raw, encoding="utf-8")
            print(f"  [Export] Saved {t} ({len(raw) // 1024} KB)")
        except Exception as e:
            print(f"  [Warn] Failed saving {t}: {e}")


def upload_snapshot(snap: dict[str, Any]) -> bool:
    if not ADMIN_KEY:
        print("  [Upload] Skipped: UWED_ADMIN_KEY env var not set.")
        return False
    payload = json.dumps({"snapshot": snap, "source": "polite_mirror"}).encode("utf-8")
    req = urllib.request.Request(
        VERCEL_SYNC_URL,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "X-Admin-Key": ADMIN_KEY,
            "User-Agent": "UWED-Polite-Mirror/1.0",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            res = json.loads(resp.read().decode("utf-8"))
            print(f"  [Upload] Vercel response: {res}")
            return bool(res.get("success"))
    except Exception as e:
        print(f"  [Upload] Error: {e}")
        return False


def run_mirror(args: argparse.Namespace) -> None:
    db = MirrorDB(DB_PATH)
    monday = get_monday_str()

    if args.reset:
        print("[Mirror] Resetting checkpoints for fresh full sweep...")
        db.reset_checkpoints()

    if args.export_only:
        snap = db.export_snapshot(monday)
        write_snapshots(snap)
        if args.upload:
            upload_snapshot(snap)
        print("[Mirror] Export-only complete. Stats:", db.stats())
        return

    client = PoliteClient(base_delay=args.delay, jitter=0.4)
    print(f"=== UWED Polite Mirror Started (delay={args.delay}s, week={monday}) ===")

    # 1. Slots
    if not db.is_done("slots", "all"):
        res = client.get_json(
            [
                "/api/public/timetable/v1/slots/by/academic/year",
                "/api/timetable/public/v1/slots/by/academic/year",
            ],
            {"academic_year_id": "null"},
        )
        if res and isinstance(res.get("data"), list) and res["data"]:
            db.upsert_slots(res["data"])
            db.mark_done("slots", "all")
            print(f"[1/5] Slots mirrored: {len(res['data'])}")
        else:
            print("[1/5] Slots endpoint unavailable right now; will retry on next run.")

    # 2. Rooms
    print(f"[2/5] Mirroring rooms ({len(ROOM_QUERIES)} gentle queries)...")
    for q in ROOM_QUERIES:
        if db.is_done("rooms", q):
            continue
        res = client.get_json(
            [
                "/api/public/timetable/v1/search/rooms",
                "/api/timetable/public/v1/search/rooms",
            ],
            {"search": q},
        )
        if res and isinstance(res.get("data"), list):
            for r in res["data"]:
                db.upsert_room(r)
            db.conn.commit()
            db.mark_done("rooms", q)
    print(f"      Rooms in local DB: {db.stats()['rooms']}")

    # 3. Teachers
    print(f"[3/5] Mirroring teachers ({len(NAME_PREFIXES)} gentle prefix queries)...")
    for idx, p in enumerate(NAME_PREFIXES, 1):
        if db.is_done("teachers", p):
            continue
        res = client.get_json(
            [
                "/api/public/timetable/v1/search/teachers",
                "/api/timetable/public/v1/search/teachers",
            ],
            {"search": p},
        )
        if res and isinstance(res.get("data"), list):
            for t in res["data"]:
                db.upsert_teacher(t)
            db.conn.commit()
            db.mark_done("teachers", p)
        if idx % 20 == 0:
            print(f"      Progress: {idx}/{len(NAME_PREFIXES)} prefixes | Teachers: {db.stats()['teachers']}")
    print(f"      Teachers in local DB: {db.stats()['teachers']}")

    # 4. Students
    print(f"[4/5] Mirroring students ({len(NAME_PREFIXES)} gentle prefix queries)...")
    for idx, p in enumerate(NAME_PREFIXES, 1):
        if db.is_done("students", p):
            continue
        res = client.get_json(
            [
                "/api/public/education/v1/student/search/for-timetable",
                "/api/education/public/v1/student/search/for-timetable",
            ],
            {"search": p},
        )
        if res and isinstance(res.get("data"), list):
            for s in res["data"]:
                db.upsert_student(s)
            db.conn.commit()
            db.mark_done("students", p)
        if idx % 20 == 0:
            print(f"      Progress: {idx}/{len(NAME_PREFIXES)} prefixes | Students: {db.stats()['students']}")
    print(f"      Students in local DB: {db.stats()['students']}")

    # 5. Room Weekly Schedules
    room_rows = db.conn.execute("SELECT id, name FROM rooms ORDER BY building, name").fetchall()
    print(f"[5/5] Mirroring weekly schedules for {len(room_rows)} rooms (week {monday})...")
    for idx, (rid, rname) in enumerate(room_rows, 1):
        ck = f"{monday}:{rid}"
        if db.is_done("room_events", ck):
            continue
        res = client.get_json(
            [
                "/api/public/timetable/v1/events/list",
                "/api/timetable/public/v1/events/list",
            ],
            {"request_id": rid, "type": "ROOM", "start_time": monday},
        )
        if res and isinstance(res.get("data"), list):
            db.upsert_room_events(rid, monday, res["data"])
            db.conn.commit()
            db.mark_done("room_events", ck)
        if idx % 25 == 0:
            print(f"      Schedules progress: {idx}/{len(room_rows)} rooms...")

    print("\n=== Mirror Pass Finished ===")
    print("Local SQLite Stats:", db.stats())

    snap = db.export_snapshot(monday)
    if snap["rooms"] and snap["slots"]:
        write_snapshots(snap)
        if args.upload:
            upload_snapshot(snap)
    else:
        print("[Warn] Snapshot incomplete (API unreachable?), keeping existing snapshot.json untouched.")


def main() -> None:
    ap = argparse.ArgumentParser(description="UWED Polite Full Database Mirror")
    ap.add_argument("--delay", type=float, default=1.0, help="Polite delay between requests in seconds (default: 1.0)")
    ap.add_argument("--reset", action="store_true", help="Clear checkpoints and do a full fresh sweep")
    ap.add_argument("--export-only", action="store_true", help="Only export snapshot.json from existing SQLite DB")
    ap.add_argument("--upload", action="store_true", help="Also upload exported snapshot to Vercel")
    run_mirror(ap.parse_args())


if __name__ == "__main__":
    main()
