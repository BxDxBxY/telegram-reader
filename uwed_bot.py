#!/usr/bin/env python3
"""
UWED Empty Classrooms Telegram Bot (УМЭД / JIDU).
Находит пустые аудитории по корпусам A (1-4 этаж), B (1-7 этаж), D (1-4 этаж)
через публичный API https://manage.uwed.uz
"""
from __future__ import annotations

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
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

BOT_TOKEN = os.environ.get(
    "UWED_BOT_TOKEN",
    "7739690853:AAGNPvkUR0zl5ZHdBEyqVXSMFq61Yr4p8bw",
)
UWED_HOST = "manage.uwed.uz"
UWED_API_BASE = f"https://{UWED_HOST}/api"
CACHE_PATH = Path(__file__).resolve().parent / "data" / "uwed_cache.json"

# Часовой пояс Ташкента (UTC+5)
TASHKENT_TZ = dt.timezone(dt.timedelta(hours=5))

# Этажи по блокам согласно структуре УМЭД
BLOCK_FLOORS: dict[str, list[int]] = {
    "A": [1, 2, 3, 4],
    "B": [1, 2, 3, 4, 5, 6, 7],
    "D": [1, 2, 3, 4],
}

# Типы аудиторий
CLASSROOM_TYPES = {"PRACTICE", "LECTURE", "LANGUAGE_LAB", "COMPUTER"}

ROOM_TYPE_LABELS = {
    "LECTURE": "🎤 Лекционная",
    "PRACTICE": "📝 Практика",
    "COMPUTER": "💻 Компьютерный",
    "LANGUAGE_LAB": "🎧 Лингафонный",
    "OFFICE": "🚪 Кабинет/Офис",
    "SPORT_CENTER": "🏀 Спортзал",
    "UNIMPORTANT": "📦 Помещение",
}

ROOM_TYPE_SHORT = {
    "LECTURE": "Лекц.",
    "PRACTICE": "Практ.",
    "COMPUTER": "Комп.",
    "LANGUAGE_LAB": "Линг.",
    "OFFICE": "Офис",
    "SPORT_CENTER": "Спорт",
    "UNIMPORTANT": "Пом.",
}

WEEKDAY_NAMES_SHORT = {
    1: "Пн",
    2: "Вт",
    3: "Ср",
    4: "Чт",
    5: "Пт",
    6: "Сб",
    7: "Вс",
}

WEEKDAY_NAMES_FULL = {
    1: "Понедельник",
    2: "Вторник",
    3: "Среда",
    4: "Четверг",
    5: "Пятница",
    6: "Суббота",
    7: "Воскресенье",
}

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


def now_tashkent() -> dt.datetime:
    return dt.datetime.now(tz=TASHKENT_TZ)


def get_monday_str(target_date: dt.date | None = None) -> str:
    if target_date is None:
        target_date = now_tashkent().date()
    monday = target_date - dt.timedelta(days=target_date.weekday())
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


class UwedScheduleService:
    """Сервис загрузки и кэширования расписания и аудиторий manage.uwed.uz."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self.slots: list[dict[str, Any]] = list(DEFAULT_SLOTS)
        self.rooms: dict[str, dict[str, Any]] = {}  # room_id -> room dict
        self.events_by_room: dict[str, list[dict[str, Any]]] = {}  # room_id -> list of events
        self.week_monday: str = get_monday_str()
        self.last_updated: float = 0.0
        self.is_refreshing: bool = False
        self._tls = threading.local()
        self._load_disk_cache()

    def _get_conn(self) -> http.client.HTTPSConnection:
        conn = getattr(self._tls, "conn", None)
        if conn is None:
            ctx = ssl.create_default_context()
            conn = http.client.HTTPSConnection(UWED_HOST, timeout=15, context=ctx)
            self._tls.conn = conn
        return conn

    def _api_get(self, path: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
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
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                        "Accept": "application/json",
                        "Connection": "keep-alive",
                    },
                )
                resp = conn.getresponse()
                body = resp.read().decode("utf-8", errors="ignore")
                if resp.status == 200:
                    return json.loads(body)
            except Exception:
                self._tls.conn = None
                time.sleep(0.2 * (attempt + 1))
        return {}

    def _load_disk_cache(self) -> None:
        if not CACHE_PATH.exists():
            return
        try:
            raw = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
            with self._lock:
                self.slots = raw.get("slots") or list(DEFAULT_SLOTS)
                self.rooms = raw.get("rooms") or {}
                self.events_by_room = raw.get("events_by_room") or {}
                self.week_monday = raw.get("week_monday") or get_monday_str()
                self.last_updated = float(raw.get("last_updated") or 0.0)
            print(
                f"[cache] Загружено из диска: {len(self.rooms)} аудиторий, "
                f"обновлено {dt.datetime.fromtimestamp(self.last_updated).strftime('%H:%M:%S') if self.last_updated else 'никогда'}"
            )
        except Exception as e:
            print(f"[cache] Ошибка чтения кэша: {e}")

    def _save_disk_cache(self) -> None:
        try:
            CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
            payload = {
                "slots": self.slots,
                "rooms": self.rooms,
                "events_by_room": self.events_by_room,
                "week_monday": self.week_monday,
                "last_updated": self.last_updated,
            }
            CACHE_PATH.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        except Exception as e:
            print(f"[cache] Ошибка записи кэша: {e}")

    def refresh(self, force: bool = False) -> tuple[int, float]:
        """Обновляет список пар, аудиторий A/B/D и расписание на текущую неделю."""
        monday = get_monday_str()
        with self._lock:
            if (
                not force
                and self.rooms
                and self.week_monday == monday
                and (time.time() - self.last_updated) < 1800
            ):
                return len(self.rooms), 0.0
            if self.is_refreshing:
                return len(self.rooms), 0.0
            self.is_refreshing = True

        t0 = time.time()
        try:
            # 1. Загружаем слоты (пары)
            slots_res = self._api_get(
                "/timetable/public/v1/slots/by/academic/year",
                {"academic_year_id": "null"},
            )
            slots_data = slots_res.get("data")
            if isinstance(slots_data, list) and slots_data:
                slots = []
                for s in sorted(slots_data, key=lambda x: int(x.get("id", 0))):
                    sid = int(s["id"])
                    slots.append(
                        {
                            "id": sid,
                            "start_time": s.get("start_time", ""),
                            "end_time": s.get("end_time", ""),
                            "label": f"{sid}-пара",
                            "orig_label": s.get("label", f"{sid}-juflik"),
                        }
                    )
            else:
                slots = list(DEFAULT_SLOTS)

            # 2. Загружаем все аудитории корпусов A, B, D
            rooms: dict[str, dict[str, Any]] = {}
            for query in ("A-", "B-", "D-"):
                res = self._api_get("/timetable/public/v1/search/rooms", {"search": query})
                for r in res.get("data") or []:
                    b = str(r.get("building", "")).upper().strip()
                    if b in ("A", "B", "D"):
                        r["floor"] = extract_floor(r)
                        rooms[r["id"]] = r

            # 3. Параллельно загружаем расписание для учебных аудиторий (офисы пропускаем кроме A-210)
            events_by_room: dict[str, list[dict[str, Any]]] = {rid: [] for rid in rooms}
            rooms_to_fetch = [
                rid
                for rid, r in rooms.items()
                if r.get("room_type") in CLASSROOM_TYPES
                or r.get("room_type") == "SPORT_CENTER"
                or r.get("room_name") == "A-210"
            ]

            def fetch_one(room_id: str) -> tuple[str, list[dict[str, Any]]]:
                ev_res = self._api_get(
                    "/timetable/public/v1/events",
                    {
                        "request_id": room_id,
                        "type": "ROOM",
                        "start_time": monday,
                    },
                )
                data = ev_res.get("data")
                return room_id, (data if isinstance(data, list) else [])

            with ThreadPoolExecutor(max_workers=24) as pool:
                for rid, evs in pool.map(fetch_one, rooms_to_fetch):
                    events_by_room[rid] = evs

            elapsed = time.time() - t0
            with self._lock:
                self.slots = slots
                self.rooms = rooms
                self.events_by_room = events_by_room
                self.week_monday = monday
                self.last_updated = time.time()
            self._save_disk_cache()
            print(f"[uwed] Обновлено {len(rooms)} аудиторий за {elapsed:.2f} сек.")
            return len(rooms), elapsed
        finally:
            with self._lock:
                self.is_refreshing = False

    def is_teaching_room(self, room: dict[str, Any]) -> bool:
        """Является ли кабинет учебной аудиторией (не пустым офисом)."""
        rtype = room.get("room_type", "")
        if rtype in CLASSROOM_TYPES:
            return True
        evs = self.events_by_room.get(room["id"], [])
        return len(evs) > 0

    def detect_current_slot_and_day(self) -> tuple[int, int, str]:
        """
        Возвращает (week_day 1..6, slot_id 1..8, пояснение статуса времени).
        """
        now = now_tashkent()
        wday = now.isoweekday()  # 1..7
        if wday == 7:
            wday = 1  # В воскресенье смотрим понедельник по умолчанию
        cur_hm = now.strftime("%H:%M")

        for s in self.slots:
            st = s["start_time"]
            et = s["end_time"]
            if st <= cur_hm <= et:
                return (
                    wday,
                    int(s["id"]),
                    f"Сейчас идёт {s['id']}-пара ({st}–{et})",
                )

        # Если между парами или до первой пары
        for s in self.slots:
            if cur_hm < s["start_time"]:
                return (
                    wday,
                    int(s["id"]),
                    f"Следующая {s['id']}-пара ({s['start_time']}–{s['end_time']})",
                )

        # После всех пар — показываем 1-ю пару следующего учебного дня
        next_day = wday + 1 if wday < 6 else 1
        s0 = self.slots[0]
        return (
            next_day,
            int(s0["id"]),
            f"Пары на сегодня закончились • {WEEKDAY_NAMES_SHORT[next_day]}, 1-пара ({s0['start_time']}–{s0['end_time']})",
        )

    def get_slot_info(self, slot_id: int) -> dict[str, Any]:
        for s in self.slots:
            if int(s["id"]) == int(slot_id):
                return s
        return DEFAULT_SLOTS[0]

    def get_room_events_for_day(self, room_id: str, week_day: int) -> dict[int, dict[str, Any]]:
        """Возвращает словарь {slot_id: event} для аудитории в указанный день недели (1..6)."""
        evs = self.events_by_room.get(room_id, [])
        by_slot: dict[int, dict[str, Any]] = {}
        for ev in evs:
            ev_wday = ev.get("week_day")
            if ev_wday is None and ev.get("date"):
                try:
                    ev_wday = dt.date.fromisoformat(ev["date"]).isoweekday()
                except Exception:
                    pass
            if ev_wday == week_day:
                sid = int(ev.get("slot_id") or 0)
                if not sid:
                    # Сопоставим по start_time
                    st = ev.get("start_time", "")
                    for s in self.slots:
                        if s["start_time"] == st:
                            sid = int(s["id"])
                            break
                if sid:
                    by_slot[sid] = ev
        return by_slot

    def free_until_text(self, room_id: str, week_day: int, current_slot: int) -> str:
        """Вычисляет, до какой пары/времени свободна аудитория начиная с current_slot."""
        day_events = self.get_room_events_for_day(room_id, week_day)
        next_busy_slot = None
        for s in self.slots:
            sid = int(s["id"])
            if sid > current_slot and sid in day_events:
                next_busy_slot = s
                break
        if next_busy_slot is None:
            if not day_events:
                return "свободна весь день"
            return "свободна до конца дня"
        free_pairs = int(next_busy_slot["id"]) - current_slot
        until_time = next_busy_slot["start_time"]
        if free_pairs == 1:
            return f"до {until_time} (1 пара)"
        return f"до {until_time} ({free_pairs} пары)"

    def query_floor_status(
        self,
        building: str,
        floor: int | None,
        week_day: int,
        slot_id: int,
        include_offices: bool = False,
    ) -> dict[str, Any]:
        """
        Возвращает свободные и занятые аудитории для выбранного блока и этажа.
        Если на выбранном этаже нет учебных аудиторий (например, B-1 или D-1, где в базе все помечены OFFICE),
        автоматически включает показ всех кабинетов на этом этаже.
        """
        building = building.upper()
        candidates = []
        all_on_floor = []

        for r in self.rooms.values():
            if building != "ALL" and r.get("building") != building:
                continue
            if floor is not None and r.get("floor") != floor:
                continue
            all_on_floor.append(r)
            if include_offices or self.is_teaching_room(r):
                candidates.append(r)

        auto_included_offices = False
        if not candidates and all_on_floor:
            candidates = all_on_floor
            auto_included_offices = True

        def sort_key(rm: dict[str, Any]) -> tuple[str, int, str]:
            b = str(rm.get("building", ""))
            fl = rm.get("floor") or 99
            return (b, fl, str(rm.get("room_name", "")))

        candidates.sort(key=sort_key)

        free_rooms = []
        busy_rooms = []

        for r in candidates:
            rid = r["id"]
            day_evs = self.get_room_events_for_day(rid, week_day)
            if slot_id in day_evs:
                busy_rooms.append((r, day_evs[slot_id]))
            else:
                free_rooms.append((r, self.free_until_text(rid, week_day, slot_id)))

        return {
            "free": free_rooms,
            "busy": busy_rooms,
            "total": len(candidates),
            "auto_included_offices": auto_included_offices,
        }

    def find_room_by_text(self, text: str) -> list[dict[str, Any]]:
        q = text.strip().upper().replace(" ", "")
        # Заменим кириллические А, В, Д на латинские A, B, D
        trans = str.maketrans({"А": "A", "В": "B", "Б": "B", "Д": "D"})
        q = q.translate(trans)
        if not q:
            return []

        exact = []
        partial = []
        for r in self.rooms.values():
            rname = str(r.get("room_name", "")).upper().replace(" ", "")
            rnum = str(r.get("room_number", "")).upper().replace(" ", "")
            rname_nodash = rname.replace("-", "")
            q_nodash = q.replace("-", "")
            if q in (rname, rnum, rname_nodash):
                exact.append(r)
            elif q in rname or q_nodash in rname_nodash:
                partial.append(r)

        res = exact if exact else partial
        res.sort(key=lambda x: str(x.get("room_name", "")))
        return res[:15]


# Глобальный экземпляр сервиса и пользовательские состояния фильтров
SERVICE = UwedScheduleService()
USER_STATE: dict[int, dict[str, Any]] = {}


def get_user_state(chat_id: int) -> dict[str, Any]:
    st = USER_STATE.get(chat_id)
    if not st:
        wday, slot_id, _ = SERVICE.detect_current_slot_and_day()
        st = {
            "building": "B",
            "floor": None,  # None = все этажи блока
            "day": wday,
            "slot": slot_id,
            "offices": False,
        }
        USER_STATE[chat_id] = st
    return st


# ──────────────────────────────────────────────────────────────────────────────
# Форматирование сообщений и клавиатур
# ──────────────────────────────────────────────────────────────────────────────

def build_reply_keyboard() -> dict[str, Any]:
    return {
        "keyboard": [
            [{"text": "🟢 Свободные сейчас"}, {"text": "📊 Сводка по всем блокам"}],
            [{"text": "🅰️ Блок A (1–4 эт.)"}, {"text": "🅱️ Блок B (1–7 эт.)"}, {"text": "🇩 Блок D (1–4 эт.)"}],
            [{"text": "🔎 Поиск кабинета"}, {"text": "🔄 Обновить расписание"}],
        ],
        "resize_keyboard": True,
        "is_persistent": True,
    }


def build_navigation_inline_kb(state: dict[str, Any], show_room_buttons: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    b_cur = state["building"]
    fl_cur = state["floor"]
    d_cur = int(state["day"])
    s_cur = int(state["slot"])
    inc_off = bool(state["offices"])

    rows: list[list[dict[str, str]]] = []

    # 1. Ряд выбора Блока
    block_row = []
    for b_code, b_title in [("A", "🅰️ Блок A"), ("B", "🅱️ Блок B"), ("D", "🇩 Блок D"), ("ALL", "🌐 Все")]:
        mark = "✅ " if b_cur == b_code else ""
        block_row.append({"text": f"{mark}{b_title}", "callback_data": f"blk:{b_code}"})
    rows.append(block_row)

    # 2. Ряды выбора Этажа (если выбран конкретный блок A, B или D)
    if b_cur in BLOCK_FLOORS:
        floors = BLOCK_FLOORS[b_cur]
        fl_btns = []
        all_mark = "✅ " if fl_cur is None else ""
        fl_btns.append({"text": f"{all_mark}Все этажи", "callback_data": "fl:ALL"})
        for fl in floors:
            m = "✅ " if fl_cur == fl else ""
            fl_btns.append({"text": f"{m}{fl} эт.", "callback_data": f"fl:{fl}"})
        # Разбиваем по 4 кнопки в ряд
        for i in range(0, len(fl_btns), 4):
            rows.append(fl_btns[i : i + 4])

    # 3. Ряд выбора Дня недели (Пн..Сб)
    day_row = []
    for d in range(1, 7):
        m = "✅" if d_cur == d else ""
        day_row.append({"text": f"{m}{WEEKDAY_NAMES_SHORT[d]}", "callback_data": f"day:{d}"})
    rows.append(day_row)

    # 4. Ряды выбора Пары (1..8)
    slot_row_1 = []
    slot_row_2 = []
    for s in SERVICE.slots[:8]:
        sid = int(s["id"])
        m = "✅" if s_cur == sid else ""
        btn = {"text": f"{m}{sid}п ({s['start_time']})", "callback_data": f"sl:{sid}"}
        if sid <= 4:
            slot_row_1.append(btn)
        else:
            slot_row_2.append(btn)
    if slot_row_1:
        rows.append(slot_row_1)
    if slot_row_2:
        rows.append(slot_row_2)

    # 5. Быстрые кнопки аудиторий для просмотра деталей (если выбран конкретный этаж)
    if show_room_buttons:
        rm_btns = []
        for rm in show_room_buttons[:12]:
            rm_btns.append({
                "text": f"📋 {rm['room_name']}",
                "callback_data": f"rm:{rm['room_name']}",
            })
        for i in range(0, len(rm_btns), 4):
            rows.append(rm_btns[i : i + 4])

    # 6. Нижний ряд: Сейчас + Переключатель офисов
    off_label = "🏢 Показаны: Все (+офисы)" if inc_off else "🎓 Показаны: Учебные"
    rows.append([
        {"text": "⚡ Сейчас", "callback_data": "now"},
        {"text": off_label, "callback_data": "toggle_off"},
    ])

    return {"inline_keyboard": rows}


def format_overview_all_blocks(state: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    wday = int(state["day"])
    slot_id = int(state["slot"])
    inc_off = bool(state["offices"])
    slot_info = SERVICE.get_slot_info(slot_id)

    lines = [
        f"🏛 <b>Сводка свободных аудиторий УМЭД (UWED)</b>",
        f"📅 <b>{WEEKDAY_NAMES_FULL[wday]}</b> • ⏰ <b>{slot_id}-пара ({slot_info['start_time']}–{slot_info['end_time']})</b>",
        "",
    ]

    for b in ("A", "B", "D"):
        floors = BLOCK_FLOORS[b]
        b_res = SERVICE.query_floor_status(b, None, wday, slot_id, inc_off)
        lines.append(
            f"━━━ <b>БЛОК {b}</b> (этажи 1–{floors[-1]}): свободно <b>{len(b_res['free'])}</b> из {b_res['total']} ━━━"
        )
        for fl in floors:
            fl_res = SERVICE.query_floor_status(b, fl, wday, slot_id, inc_off)
            free_names = [r["room_name"] for r, _ in fl_res["free"]]
            if not fl_res["total"]:
                continue
            if free_names:
                preview = ", ".join(free_names[:8])
                if len(free_names) > 8:
                    preview += f" (+ещё {len(free_names) - 8})"
                lines.append(f"  • <b>{fl} этаж</b> [{len(free_names)}/{fl_res['total']}]: 🟢 {preview}")
            else:
                lines.append(f"  • <b>{fl} этаж</b> [0/{fl_res['total']}]: 🔴 все заняты")
        lines.append("")

    if SERVICE.last_updated:
        upd = dt.datetime.fromtimestamp(SERVICE.last_updated, tz=TASHKENT_TZ).strftime("%H:%M")
        lines.append(f"<i>Данные manage.uwed.uz (обновлено в {upd}) • Нажми на блок/этаж ниже:</i>")

    return "\n".join(lines), build_navigation_inline_kb(state)


def format_block_or_floor_view(state: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    b = state["building"]
    if b == "ALL":
        return format_overview_all_blocks(state)

    fl = state["floor"]
    wday = int(state["day"])
    slot_id = int(state["slot"])
    inc_off = bool(state["offices"])
    slot_info = SERVICE.get_slot_info(slot_id)

    max_fl = BLOCK_FLOORS[b][-1]
    fl_title = f"{fl} этаж" if fl is not None else f"Все этажи (1–{max_fl})"

    res = SERVICE.query_floor_status(b, fl, wday, slot_id, inc_off)
    free_list = res["free"]
    busy_list = res["busy"]

    lines = [
        f"🏢 <b>Блок {b} • {fl_title}</b>",
        f"📅 <b>{WEEKDAY_NAMES_FULL[wday]}</b> | ⏰ <b>{slot_id}-пара ({slot_info['start_time']}–{slot_info['end_time']})</b>",
        f"🟢 Свободно: <b>{len(free_list)}</b>   🔴 Занято: <b>{len(busy_list)}</b>   (всего: {res['total']})",
    ]
    if res["auto_included_offices"]:
        lines.append("ℹ️ <i>На этом этаже все кабинеты в базе отмечены как OFFICE — показаны все кабинеты этажа.</i>")
    lines.append("")

    if fl is None:
        # Группируем по этажам внутри блока
        for floor_num in BLOCK_FLOORS[b]:
            fl_res = SERVICE.query_floor_status(b, floor_num, wday, slot_id, inc_off)
            fl_free = fl_res["free"]
            fl_busy = fl_res["busy"]
            lines.append(f"🪜 <b>{floor_num} ЭТАЖ</b> — свободно <b>{len(fl_free)}</b> из {fl_res['total']}:")
            if fl_free:
                for rm, until_str in fl_free:
                    rt = ROOM_TYPE_SHORT.get(rm.get("room_type", ""), "")
                    cap = rm.get("capacity") or "?"
                    lines.append(
                        f"  🟢 <b>{rm['room_name']}</b> ({rt}, {cap} мест) — <i>{until_str}</i>"
                    )
            else:
                lines.append("  🔴 <i>Нет пустых учебных аудиторий на этой паре</i>")
            if fl_busy:
                busy_names = ", ".join(r["room_name"] for r, _ in fl_busy)
                lines.append(f"  🔴 Заняты: {busy_names}")
            lines.append("")
        room_buttons = None
    else:
        # Подробный вид одного этажа
        lines.append(f"🟢 <b>ПУСТЫЕ АУДИТОРИИ ({len(free_list)}):</b>")
        if free_list:
            for rm, until_str in free_list:
                rt = ROOM_TYPE_LABELS.get(rm.get("room_type", ""), rm.get("room_type", ""))
                cap = rm.get("capacity") or "?"
                lines.append(
                    f"  • <b>{rm['room_name']}</b> — {rt} ({cap} мест) • <i>{until_str}</i>"
                )
        else:
            lines.append("  <i>На этом этаже сейчас все аудитории заняты.</i>")

        lines.append("")
        lines.append(f"🔴 <b>ЗАНЯТЫЕ АУДИТОРИИ ({len(busy_list)}):</b>")
        if busy_list:
            for rm, ev in busy_list:
                subj = ev.get("title") or ev.get("lesson_name") or "Занятие"
                instr = ev.get("instructor") or ""
                spec = ev.get("speciality_names") or ev.get("code") or ""
                meta = " • ".join(x for x in [subj, instr, spec] if x)
                lines.append(f"  • <b>{rm['room_name']}</b>: {meta}")
        else:
            lines.append("  <i>Ни одной занятой аудитории нет — все свободны!</i>")

        room_buttons = [r for r, _ in free_list] + [r for r, _ in busy_list]

    lines.append("")
    lines.append("💡 <i>Выбери другой этаж/пару кнопками ниже или напиши номер кабинета (например, <code>A-410</code> или <code>B-605</code>):</i>")
    return "\n".join(lines), build_navigation_inline_kb(state, show_room_buttons=room_buttons)


def format_room_schedule(room: dict[str, Any], week_day: int) -> tuple[str, dict[str, Any]]:
    rid = room["id"]
    rname = room["room_name"]
    b = room.get("building", "?")
    fl = room.get("floor") or "?"
    rt = ROOM_TYPE_LABELS.get(room.get("room_type", ""), room.get("room_type", ""))
    cap = room.get("capacity") or "?"

    day_events = SERVICE.get_room_events_for_day(rid, week_day)

    lines = [
        f"🚪 <b>Аудитория {rname}</b> (Блок {b}, {fl} этаж)",
        f"🏷 Тип: {rt} • 👥 Вместимость: <b>{cap} мест</b>",
        f"📅 Расписание на: <b>{WEEKDAY_NAMES_FULL[week_day]}</b>",
        "",
    ]

    for s in SERVICE.slots[:8]:
        sid = int(s["id"])
        st = s["start_time"]
        et = s["end_time"]
        if sid in day_events:
            ev = day_events[sid]
            subj = ev.get("title") or "Занятие"
            instr = ev.get("instructor") or ""
            code = ev.get("code") or ""
            spec = ev.get("speciality_names") or ""
            extra = " | ".join(x for x in [code, spec, instr] if x)
            lines.append(f"🔴 <b>{sid}-пара ({st}–{et})</b>: {subj}")
            if extra:
                lines.append(f"     └ <i>{extra}</i>")
        else:
            lines.append(f"🟢 <b>{sid}-пара ({st}–{et})</b> — <b>СВОБОДНО</b>")

    # Кнопки переключения дней для этой аудитории + возврат к этажу
    day_btns = []
    for d in range(1, 7):
        m = "✅" if d == week_day else ""
        day_btns.append({"text": f"{m}{WEEKDAY_NAMES_SHORT[d]}", "callback_data": f"rmday:{rname}:{d}"})

    back_fl = room.get("floor") or "ALL"
    kb = {
        "inline_keyboard": [
            day_btns,
            [{"text": f"⬅️ Назад к Блоку {b} ({fl} эт.)", "callback_data": f"back:{b}:{back_fl}"}],
        ]
    }
    return "\n".join(lines), kb


# ──────────────────────────────────────────────────────────────────────────────
# Telegram Bot API клиент (Long Polling)
# ──────────────────────────────────────────────────────────────────────────────

class TelegramBot:
    def __init__(self, token: str) -> None:
        self.token = token
        self.base_url = f"https://api.telegram.org/bot{token}"
        self.offset = 0

    def api_call(self, method: str, payload: dict[str, Any] | None = None, timeout: int = 35) -> dict[str, Any]:
        url = f"{self.base_url}/{method}"
        data = None
        headers = {"User-Agent": "UWED-EmptyRoomsBot/1.0"}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="ignore")
            if "message is not modified" not in err_body:
                print(f"[tg] HTTP {e.code} on {method}: {err_body}")
            return {}
        except Exception as e:
            print(f"[tg] Error on {method}: {e}")
            return {}

    def send_message(
        self,
        chat_id: int,
        text: str,
        reply_markup: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }
        if reply_markup:
            payload["reply_markup"] = reply_markup
        return self.api_call("sendMessage", payload)

    def edit_message(
        self,
        chat_id: int,
        message_id: int,
        text: str,
        reply_markup: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "chat_id": chat_id,
            "message_id": message_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }
        if reply_markup:
            payload["reply_markup"] = reply_markup
        return self.api_call("editMessageText", payload)

    def answer_callback(self, callback_id: str, text: str = "") -> None:
        payload: dict[str, Any] = {"callback_query_id": callback_id}
        if text:
            payload["text"] = text
        self.api_call("answerCallbackQuery", payload, timeout=10)

    def handle_message(self, msg: dict[str, Any]) -> None:
        chat_id = msg["chat"]["id"]
        text = (msg.get("text") or "").strip()
        if not text:
            return

        state = get_user_state(chat_id)

        if text.startswith("/start") or text.startswith("/help"):
            wday, slot_id, status_note = SERVICE.detect_current_slot_and_day()
            state["day"] = wday
            state["slot"] = slot_id
            state["building"] = "ALL"
            state["floor"] = None

            welcome = (
                "👋 <b>Привет! Я бот поиска свободных аудиторий УМЭД (UWED).</b>\n\n"
                "Я напрямую подключён к публичному расписанию <code>manage.uwed.uz</code> и знаю расписание всех корпусов:\n"
                "• 🅰️ <b>Блок A</b> — этажи 1, 2, 3, 4\n"
                "• 🅱️ <b>Блок B</b> — этажи 1, 2, 3, 4, 5, 6, 7\n"
                "• 🇩 <b>Блок D</b> — этажи 1, 2, 3, 4\n\n"
                f"⏱ <b>{status_note}</b>\n"
                "Выбирай корпус и этаж на кнопках ниже или просто напиши номер кабинета (например, <code>B-605</code>, <code>A-410</code>, <code>D-203</code>)!"
            )
            self.send_message(chat_id, welcome, reply_markup=build_reply_keyboard())
            body, ikb = format_overview_all_blocks(state)
            self.send_message(chat_id, body, reply_markup=ikb)
            return

        if text == "🟢 Свободные сейчас" or text.startswith("/now"):
            wday, slot_id, status_note = SERVICE.detect_current_slot_and_day()
            state["day"] = wday
            state["slot"] = slot_id
            body, ikb = format_block_or_floor_view(state)
            self.send_message(chat_id, f"⏱ <b>{status_note}</b>\n\n{body}", reply_markup=ikb)
            return

        if text == "📊 Сводка по всем блокам" or text.startswith("/all"):
            state["building"] = "ALL"
            state["floor"] = None
            body, ikb = format_overview_all_blocks(state)
            self.send_message(chat_id, body, reply_markup=ikb)
            return

        if text.startswith("🅰️ Блок A") or text.upper() in ("A", "БЛОК A", "БЛОК А"):
            state["building"] = "A"
            state["floor"] = None
            body, ikb = format_block_or_floor_view(state)
            self.send_message(chat_id, body, reply_markup=ikb)
            return

        if text.startswith("🅱️ Блок B") or text.upper() in ("B", "БЛОК B", "БЛОК Б", "БЛОК В"):
            state["building"] = "B"
            state["floor"] = None
            body, ikb = format_block_or_floor_view(state)
            self.send_message(chat_id, body, reply_markup=ikb)
            return

        if text.startswith("🇩 Блок D") or text.upper() in ("D", "БЛОК D", "БЛОК Д"):
            state["building"] = "D"
            state["floor"] = None
            body, ikb = format_block_or_floor_view(state)
            self.send_message(chat_id, body, reply_markup=ikb)
            return

        if text == "🔄 Обновить расписание" or text.startswith("/refresh"):
            self.send_message(chat_id, "⏳ Обновляю расписание всех аудиторий с <code>manage.uwed.uz</code>...")
            count, elapsed = SERVICE.refresh(force=True)
            body, ikb = format_block_or_floor_view(state)
            self.send_message(
                chat_id,
                f"✅ <b>Готово!</b> Загружено {count} аудиторий за {elapsed:.1f} сек.\n\n{body}",
                reply_markup=ikb,
            )
            return

        if text == "🔎 Поиск кабинета":
            self.send_message(
                chat_id,
                "🔎 Напиши номер аудитории в чат, например:\n"
                "• <code>A-410</code> или <code>A-201</code>\n"
                "• <code>B-705</code> или <code>B-608</code>\n"
                "• <code>D-305</code> или <code>405</code>",
            )
            return

        # Поиск аудитории по тексту
        matches = SERVICE.find_room_by_text(text)
        if not matches:
            self.send_message(
                chat_id,
                f"😕 Аудитория <b>{text}</b> не найдена. Попробуй написать, например, <code>A-410</code>, <code>B-605</code> или выбери блок на кнопках.",
                reply_markup=build_reply_keyboard(),
            )
            return

        if len(matches) == 1:
            body, ikb = format_room_schedule(matches[0], int(state["day"]))
            self.send_message(chat_id, body, reply_markup=ikb)
        else:
            btns = []
            for rm in matches[:12]:
                rt = ROOM_TYPE_SHORT.get(rm.get("room_type", ""), "")
                btns.append({"text": f"{rm['room_name']} ({rt})", "callback_data": f"rm:{rm['room_name']}"})
            rows = [btns[i : i + 3] for i in range(0, len(btns), 3)]
            self.send_message(
                chat_id,
                f"🔎 Найдено несколько аудиторий по запросу «<b>{text}</b>». Выбери нужную:",
                reply_markup={"inline_keyboard": rows},
            )

    def handle_callback(self, cb: dict[str, Any]) -> None:
        cb_id = cb["id"]
        msg = cb.get("message") or {}
        chat_id = msg.get("chat", {}).get("id")
        message_id = msg.get("message_id")
        data = cb.get("data") or ""
        if not chat_id or not message_id:
            self.answer_callback(cb_id)
            return

        state = get_user_state(chat_id)
        toast = ""

        if data.startswith("blk:"):
            b = data.split(":", 1)[1]
            state["building"] = b
            state["floor"] = None
            toast = f"Блок {b}" if b != "ALL" else "Все блоки"

        elif data.startswith("fl:"):
            fl_raw = data.split(":", 1)[1]
            if fl_raw == "ALL":
                state["floor"] = None
                toast = "Все этажи"
            else:
                state["floor"] = int(fl_raw)
                toast = f"{fl_raw} этаж"

        elif data.startswith("day:"):
            d = int(data.split(":", 1)[1])
            state["day"] = d
            toast = WEEKDAY_NAMES_FULL[d]

        elif data.startswith("sl:"):
            s = int(data.split(":", 1)[1])
            state["slot"] = s
            toast = f"{s}-пара"

        elif data == "now":
            wday, slot_id, status_note = SERVICE.detect_current_slot_and_day()
            state["day"] = wday
            state["slot"] = slot_id
            toast = status_note

        elif data == "toggle_off":
            state["offices"] = not state["offices"]
            toast = "Показаны все кабинеты (+офисы)" if state["offices"] else "Только учебные аудитории"

        elif data.startswith("rm:"):
            rname = data.split(":", 1)[1]
            matches = SERVICE.find_room_by_text(rname)
            if matches:
                body, ikb = format_room_schedule(matches[0], int(state["day"]))
                self.edit_message(chat_id, message_id, body, reply_markup=ikb)
                self.answer_callback(cb_id, f"Аудитория {rname}")
                return

        elif data.startswith("rmday:"):
            _, rname, d_str = data.split(":", 2)
            state["day"] = int(d_str)
            matches = SERVICE.find_room_by_text(rname)
            if matches:
                body, ikb = format_room_schedule(matches[0], int(state["day"]))
                self.edit_message(chat_id, message_id, body, reply_markup=ikb)
                self.answer_callback(cb_id, WEEKDAY_NAMES_FULL[int(d_str)])
                return

        elif data.startswith("back:"):
            _, b, fl_str = data.split(":", 2)
            state["building"] = b
            state["floor"] = int(fl_str) if fl_str.isdigit() else None

        body, ikb = format_block_or_floor_view(state)
        self.edit_message(chat_id, message_id, body, reply_markup=ikb)
        self.answer_callback(cb_id, toast)

    def run_forever(self) -> None:
        me = self.api_call("getMe")
        bot_info = me.get("result") or {}
        uname = bot_info.get("username", "unknown")
        print(f"[bot] Запущен бот @{uname} (ID: {bot_info.get('id')})")

        # Регистрируем команды меню в Telegram
        self.api_call(
            "setMyCommands",
            {
                "commands": [
                    {"command": "start", "description": "Главное меню и сводка по блокам"},
                    {"command": "now", "description": "Свободные аудитории прямо сейчас"},
                    {"command": "all", "description": "Сводка по всем блокам A, B, D"},
                    {"command": "refresh", "description": "Обновить расписание с manage.uwed.uz"},
                ]
            },
        )

        # Если кэша ещё нет — загружаем сразу, иначе обновляем в фоне
        if not SERVICE.rooms:
            print("[bot] Первичная загрузка расписания с manage.uwed.uz...")
            SERVICE.refresh(force=True)
        else:
            threading.Thread(target=SERVICE.refresh, kwargs={"force": False}, daemon=True).start()

        print("[bot] Слушаю сообщения в Telegram...")
        while True:
            try:
                res = self.api_call(
                    "getUpdates",
                    {
                        "offset": self.offset,
                        "timeout": 25,
                        "allowed_updates": ["message", "callback_query"],
                    },
                    timeout=35,
                )
                for upd in res.get("result") or []:
                    self.offset = int(upd["update_id"]) + 1
                    if "message" in upd:
                        threading.Thread(
                            target=self.handle_message,
                            args=(upd["message"],),
                            daemon=True,
                        ).start()
                    elif "callback_query" in upd:
                        threading.Thread(
                            target=self.handle_callback,
                            args=(upd["callback_query"],),
                            daemon=True,
                        ).start()
            except KeyboardInterrupt:
                print("\n[bot] Остановлен пользователем.")
                break
            except Exception as e:
                print(f"[bot] Ошибка цикла: {e}")
                time.sleep(2)


if __name__ == "__main__":
    bot = TelegramBot(BOT_TOKEN)
    bot.run_forever()
