"""SQLite-хранилище: структурированная БД по вашему Telegram.

Одна БД = один аккаунт. Все этапы пишут сюда, поэтому прогон можно прерывать
и продолжать: этап 2 не будет заново качать уже собранные чаты.
"""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence

from .models import ChatRecord, Dialog, MessageSample, Score, group_samples
from .util import to_iso, utcnow

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);

CREATE TABLE IF NOT EXISTS dialogs (
    id                   INTEGER PRIMARY KEY,
    kind                 TEXT    NOT NULL DEFAULT 'unknown',
    title                TEXT    NOT NULL DEFAULT '',
    username             TEXT,
    participants_count   INTEGER,
    unread_count         INTEGER NOT NULL DEFAULT 0,
    unread_mentions      INTEGER NOT NULL DEFAULT 0,
    is_pinned            INTEGER NOT NULL DEFAULT 0,
    is_archived          INTEGER NOT NULL DEFAULT 0,
    is_muted             INTEGER NOT NULL DEFAULT 0,
    is_verified          INTEGER NOT NULL DEFAULT 0,
    is_scam              INTEGER NOT NULL DEFAULT 0,
    is_fake              INTEGER NOT NULL DEFAULT 0,
    last_message_date    TEXT,
    last_message_id      INTEGER,
    last_message_preview TEXT    NOT NULL DEFAULT '',
    collected_at         TEXT,
    triage_action        TEXT,
    triage_reasons       TEXT    NOT NULL DEFAULT '[]',
    sampled_at           TEXT,
    sample_error         TEXT
);

CREATE INDEX IF NOT EXISTS idx_dialogs_kind   ON dialogs(kind);
CREATE INDEX IF NOT EXISTS idx_dialogs_triage ON dialogs(triage_action);
CREATE INDEX IF NOT EXISTS idx_dialogs_last   ON dialogs(last_message_date);

CREATE TABLE IF NOT EXISTS messages (
    dialog_id    INTEGER NOT NULL,
    message_id   INTEGER NOT NULL,
    date         TEXT,
    text         TEXT    NOT NULL DEFAULT '',
    has_media    INTEGER NOT NULL DEFAULT 0,
    media_type   TEXT,
    views        INTEGER,
    forwards     INTEGER,
    is_forward   INTEGER NOT NULL DEFAULT 0,
    is_service   INTEGER NOT NULL DEFAULT 0,
    url_count    INTEGER NOT NULL DEFAULT 0,
    collected_at TEXT,
    PRIMARY KEY (dialog_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_dialog ON messages(dialog_id);

CREATE TABLE IF NOT EXISTS scores (
    dialog_id       INTEGER PRIMARY KEY,
    score           REAL    NOT NULL DEFAULT 50,
    bucket          TEXT    NOT NULL DEFAULT 'keep',
    reasons         TEXT    NOT NULL DEFAULT '[]',
    language        TEXT,
    topic           TEXT,
    ads_ratio       REAL,
    posts_per_week  REAL,
    duplicate_group TEXT,
    ai_bucket       TEXT,
    ai_topic        TEXT,
    ai_reason       TEXT,
    ai_model        TEXT,
    scored_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_scores_bucket ON scores(bucket);

CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    stage       TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    status      TEXT,
    details     TEXT
);
"""


def _placeholders(row: dict[str, Any]) -> tuple[str, str, list[Any]]:
    columns = list(row)
    return (
        ", ".join(columns),
        ", ".join(":" + c for c in columns),
        [row[c] for c in columns],
    )


class Store:
    """Тонкая обёртка над sqlite3 с типизированными методами."""

    def __init__(self, path: str | Path = "data/tgaudit.db"):
        self.path = Path(path)
        if str(self.path.parent) not in ("", "."):
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self._init_schema()

    # ── служебное ────────────────────────────────────────────────────────
    def _init_schema(self) -> None:
        with self.conn:
            self.conn.executescript(SCHEMA)
            self.conn.execute(
                "INSERT INTO meta(key, value) VALUES('schema_version', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (str(SCHEMA_VERSION),),
            )

    def close(self) -> None:
        self.conn.close()

    def __enter__(self) -> "Store":
        return self

    def __exit__(self, *exc_info) -> None:
        self.close()

    def set_meta(self, key: str, value: str) -> None:
        with self.conn:
            self.conn.execute(
                "INSERT INTO meta(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value),
            )

    def get_meta(self, key: str, default: str | None = None) -> str | None:
        row = self.conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row["value"] if row else default

    # ── диалоги ──────────────────────────────────────────────────────────
    def upsert_dialogs(self, dialogs: Iterable[Dialog]) -> int:
        """Вставляет/обновляет метаданные. Триаж и срезы не затираются."""
        count = 0
        with self.conn:
            for dialog in dialogs:
                row = dialog.to_row()
                # Эти поля принадлежат другим этапам — не трогаем при обновлении.
                protected = ("triage_action", "triage_reasons", "sampled_at", "sample_error")
                columns, binds, _ = _placeholders(row)
                updates = ", ".join(
                    f"{c}=excluded.{c}" for c in row if c not in ("id",) + protected
                )
                self.conn.execute(
                    f"INSERT INTO dialogs ({columns}) VALUES ({binds}) "
                    f"ON CONFLICT(id) DO UPDATE SET {updates}",
                    row,
                )
                count += 1
        return count

    def save_triage(self, dialog_id: int, action: str, reasons: Sequence[str]) -> None:
        with self.conn:
            self.conn.execute(
                "UPDATE dialogs SET triage_action=?, triage_reasons=? WHERE id=?",
                (action, json.dumps(list(reasons), ensure_ascii=False), dialog_id),
            )

    def mark_sampled(self, dialog_id: int, error: str | None = None) -> None:
        with self.conn:
            self.conn.execute(
                "UPDATE dialogs SET sampled_at=?, sample_error=? WHERE id=?",
                (to_iso(utcnow()), error, dialog_id),
            )

    def get_dialog(self, dialog_id: int) -> Dialog | None:
        row = self.conn.execute("SELECT * FROM dialogs WHERE id=?", (dialog_id,)).fetchone()
        return Dialog.from_row(row) if row else None

    def dialogs(
        self,
        *,
        kinds: Sequence[str] | None = None,
        triage: Sequence[str] | None = None,
        order: str = "last_message_date DESC",
    ) -> list[Dialog]:
        query = "SELECT * FROM dialogs"
        clauses: list[str] = []
        params: list[Any] = []
        if kinds:
            clauses.append(f"kind IN ({','.join('?' * len(kinds))})")
            params.extend(kinds)
        if triage:
            clauses.append(f"triage_action IN ({','.join('?' * len(triage))})")
            params.extend(triage)
        if clauses:
            query += " WHERE " + " AND ".join(clauses)
        query += f" ORDER BY {order}"
        return [Dialog.from_row(r) for r in self.conn.execute(query, params)]

    def dialogs_to_sample(
        self,
        *,
        limit: int | None = None,
        include_dms: bool = False,
        resample: bool = False,
    ) -> list[Dialog]:
        """Очередь этапа 2: помеченные `sample` и ещё не выгруженные."""
        query = "SELECT * FROM dialogs WHERE triage_action='sample'"
        if not resample:
            query += " AND sampled_at IS NULL"
        if not include_dms:
            query += " AND kind <> 'dm'"
        # Сначала живые и заметные: где вероятнее найти полезный контент.
        # `id` в конце делает порядок детерминированным — это важно для
        # прерванных прогонов: продолжение идёт ровно с того места.
        query += (
            " ORDER BY (last_message_date IS NULL), last_message_date DESC,"
            " unread_count DESC, id"
        )
        if limit:
            query += f" LIMIT {int(limit)}"
        return [Dialog.from_row(r) for r in self.conn.execute(query)]

    def count_dialogs(self) -> int:
        return int(self.conn.execute("SELECT COUNT(*) AS n FROM dialogs").fetchone()["n"])

    # ── сообщения ────────────────────────────────────────────────────────
    def save_samples(self, samples: Iterable[MessageSample]) -> int:
        count = 0
        with self.conn:
            for sample in samples:
                row = sample.to_row()
                columns, binds, _ = _placeholders(row)
                updates = ", ".join(
                    f"{c}=excluded.{c}" for c in row if c not in ("dialog_id", "message_id")
                )
                self.conn.execute(
                    f"INSERT INTO messages ({columns}) VALUES ({binds}) "
                    f"ON CONFLICT(dialog_id, message_id) DO UPDATE SET {updates}",
                    row,
                )
                count += 1
        return count

    def samples_for(self, dialog_id: int) -> list[MessageSample]:
        rows = self.conn.execute(
            "SELECT * FROM messages WHERE dialog_id=? ORDER BY message_id DESC", (dialog_id,)
        )
        return [MessageSample.from_row(r) for r in rows]

    def all_samples(self) -> dict[int, list[MessageSample]]:
        rows = self.conn.execute("SELECT * FROM messages")
        return group_samples(MessageSample.from_row(r) for r in rows)

    # ── оценки ───────────────────────────────────────────────────────────
    def save_scores(self, scores: Iterable[Score]) -> int:
        count = 0
        with self.conn:
            for score in scores:
                row = score.to_row()
                columns, binds, _ = _placeholders(row)
                updates = ", ".join(f"{c}=excluded.{c}" for c in row if c != "dialog_id")
                self.conn.execute(
                    f"INSERT INTO scores ({columns}) VALUES ({binds}) "
                    f"ON CONFLICT(dialog_id) DO UPDATE SET {updates}",
                    row,
                )
                count += 1
        return count

    def scores(self) -> dict[int, Score]:
        rows = self.conn.execute("SELECT * FROM scores")
        return {int(r["dialog_id"]): Score.from_row(r) for r in rows}

    # ── сводные выборки ──────────────────────────────────────────────────
    def records(self, *, with_samples: bool = True) -> list[ChatRecord]:
        """Диалоги + срезы + вердикты, отсортированные по баллу (худшие внизу)."""
        samples = self.all_samples() if with_samples else {}
        scores = self.scores()
        records = [
            ChatRecord(dialog=d, samples=samples.get(d.id, []), score=scores.get(d.id))
            for d in self.dialogs()
        ]
        records.sort(key=lambda r: (r.score.score if r.score else 50.0))
        return records

    def stats(self) -> dict[str, Any]:
        cur = self.conn.execute
        by_kind = {r["kind"]: r["n"] for r in cur("SELECT kind, COUNT(*) n FROM dialogs GROUP BY kind")}
        by_triage = {
            (r["triage_action"] or "—"): r["n"]
            for r in cur("SELECT triage_action, COUNT(*) n FROM dialogs GROUP BY triage_action")
        }
        by_bucket = {r["bucket"]: r["n"] for r in cur("SELECT bucket, COUNT(*) n FROM scores GROUP BY bucket")}
        return {
            "dialogs": self.count_dialogs(),
            "sampled": int(cur("SELECT COUNT(*) n FROM dialogs WHERE sampled_at IS NOT NULL").fetchone()["n"]),
            "messages": int(cur("SELECT COUNT(*) n FROM messages").fetchone()["n"]),
            "scored": int(cur("SELECT COUNT(*) n FROM scores").fetchone()["n"]),
            "by_kind": by_kind,
            "by_triage": by_triage,
            "by_bucket": by_bucket,
            "db_path": str(self.path),
        }

    # ── журнал запусков ──────────────────────────────────────────────────
    @contextmanager
    def run(self, stage: str, details: str = "") -> Iterator[int]:
        """Пишет запись в журнал: когда и чем закончился этап."""
        with self.conn:
            cursor = self.conn.execute(
                "INSERT INTO runs(stage, started_at, status, details) VALUES(?,?,?,?)",
                (stage, to_iso(utcnow()), "running", details),
            )
        run_id = int(cursor.lastrowid)
        status = "ok"
        try:
            yield run_id
        except BaseException as exc:  # noqa: BLE001 — журналируем любой исход
            status = f"failed: {type(exc).__name__}"
            raise
        finally:
            with self.conn:
                self.conn.execute(
                    "UPDATE runs SET finished_at=?, status=? WHERE id=?",
                    (to_iso(utcnow()), status, run_id),
                )

    def finish_run(self, run_id: int, details: str) -> None:
        with self.conn:
            self.conn.execute("UPDATE runs SET details=? WHERE id=?", (details, run_id))
