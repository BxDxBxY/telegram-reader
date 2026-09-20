"""Модели данных аудита. Один слой между Telegram, SQLite и отчётами."""

from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field, fields
from typing import Any, Iterable

# Типы диалогов, которыми оперирует весь проект.
KIND_CHANNEL = "channel"      # публичный/приватный канал (broadcast)
KIND_SUPERGROUP = "supergroup"  # супергруппа/чат-сообщество
KIND_GROUP = "group"          # старая маленькая группа
KIND_DM = "dm"                # личная переписка с человеком
KIND_BOT = "bot"              # диалог с ботом
KIND_UNKNOWN = "unknown"

KINDS_RU = {
    KIND_CHANNEL: "Канал",
    KIND_SUPERGROUP: "Супергруппа",
    KIND_GROUP: "Группа",
    KIND_DM: "Личный чат",
    KIND_BOT: "Бот",
    KIND_UNKNOWN: "Неизвестно",
}

# Корзины вердикта.
BUCKET_KEEP = "keep"
BUCKET_ARCHIVE = "archive"
BUCKET_DROP = "unsubscribe"

BUCKETS_RU = {
    BUCKET_KEEP: "Оставить",
    BUCKET_ARCHIVE: "В архив",
    BUCKET_DROP: "Отписаться / удалить",
}

# Решения этапа 1 (что делать с диалогом дальше).
TRIAGE_KEEP = "keep"        # полезно и так, читать сообщения незачем
TRIAGE_SAMPLE = "sample"    # непонятно — нужен срез логов (этап 2)
TRIAGE_DROP = "drop"        # мусор виден по метаданным, логи не нужны

TRIAGE_RU = {
    TRIAGE_KEEP: "оставить без анализа логов",
    TRIAGE_SAMPLE: "нужен срез сообщений",
    TRIAGE_DROP: "кандидат на удаление без чтения",
}


@dataclass
class Dialog:
    """Метаданные диалога — результат этапа 1 (без чтения сообщений)."""

    id: int
    kind: str = KIND_UNKNOWN
    title: str = ""
    username: str | None = None
    participants_count: int | None = None
    unread_count: int = 0
    unread_mentions: int = 0
    is_pinned: bool = False
    is_archived: bool = False
    is_muted: bool = False
    is_verified: bool = False
    is_scam: bool = False
    is_fake: bool = False
    last_message_date: str | None = None
    last_message_id: int | None = None
    last_message_preview: str = ""
    collected_at: str | None = None
    triage_action: str | None = None
    triage_reasons: list[str] = field(default_factory=list)
    sampled_at: str | None = None
    sample_error: str | None = None

    @property
    def link(self) -> str | None:
        return f"https://t.me/{self.username}" if self.username else None

    @property
    def kind_ru(self) -> str:
        return KINDS_RU.get(self.kind, self.kind)

    @property
    def is_personal(self) -> bool:
        """Личные диалоги — люди, а не контент. Их не «отписывают» автоматом."""
        return self.kind == KIND_DM

    def to_row(self) -> dict[str, Any]:
        row = asdict(self)
        row["triage_reasons"] = json.dumps(self.triage_reasons, ensure_ascii=False)
        for key in ("is_pinned", "is_archived", "is_muted", "is_verified", "is_scam", "is_fake"):
            row[key] = int(bool(row[key]))
        return row

    @classmethod
    def from_row(cls, row: Any) -> "Dialog":
        data = dict(row)
        reasons = data.get("triage_reasons")
        if isinstance(reasons, str):
            try:
                data["triage_reasons"] = json.loads(reasons)
            except json.JSONDecodeError:
                data["triage_reasons"] = []
        known = {f.name for f in fields(cls)}
        clean = {k: v for k, v in data.items() if k in known}
        for key in ("is_pinned", "is_archived", "is_muted", "is_verified", "is_scam", "is_fake"):
            if key in clean:
                clean[key] = bool(clean[key])
        for key in ("unread_count", "unread_mentions"):
            if clean.get(key) is None:
                clean[key] = 0
        clean.setdefault("triage_reasons", [])
        return cls(**clean)


@dataclass
class MessageSample:
    """Одно сообщение из среза этапа 2 (текст обрезан, медиа не качаются)."""

    dialog_id: int
    message_id: int
    date: str | None = None
    text: str = ""
    has_media: bool = False
    media_type: str | None = None
    views: int | None = None
    forwards: int | None = None
    is_forward: bool = False
    is_service: bool = False
    url_count: int = 0
    collected_at: str | None = None

    def to_row(self) -> dict[str, Any]:
        row = asdict(self)
        for key in ("has_media", "is_forward", "is_service"):
            row[key] = int(bool(row[key]))
        return row

    @classmethod
    def from_row(cls, row: Any) -> "MessageSample":
        data = dict(row)
        known = {f.name for f in fields(cls)}
        clean = {k: v for k, v in data.items() if k in known}
        for key in ("has_media", "is_forward", "is_service"):
            if key in clean:
                clean[key] = bool(clean[key])
        if clean.get("url_count") is None:
            clean["url_count"] = 0
        return cls(**clean)


@dataclass
class Score:
    """Результат этапа 3: балл полезности, корзина и объяснение вердикта."""

    dialog_id: int
    score: float = 50.0
    bucket: str = BUCKET_KEEP
    reasons: list[str] = field(default_factory=list)
    language: str | None = None
    topic: str | None = None
    ads_ratio: float | None = None
    posts_per_week: float | None = None
    duplicate_group: str | None = None
    ai_bucket: str | None = None
    ai_topic: str | None = None
    ai_reason: str | None = None
    ai_model: str | None = None
    scored_at: str | None = None

    @property
    def bucket_ru(self) -> str:
        return BUCKETS_RU.get(self.bucket, self.bucket)

    def to_row(self) -> dict[str, Any]:
        row = asdict(self)
        row["reasons"] = json.dumps(self.reasons, ensure_ascii=False)
        return row

    @classmethod
    def from_row(cls, row: Any) -> "Score":
        data = dict(row)
        reasons = data.get("reasons")
        if isinstance(reasons, str):
            try:
                data["reasons"] = json.loads(reasons)
            except json.JSONDecodeError:
                data["reasons"] = []
        known = {f.name for f in fields(cls)}
        clean = {k: v for k, v in data.items() if k in known}
        clean.setdefault("reasons", [])
        return cls(**clean)


@dataclass
class ChatRecord:
    """Диалог + его срез сообщений + вердикт. Единица отчёта."""

    dialog: Dialog
    samples: list[MessageSample] = field(default_factory=list)
    score: Score | None = None

    @property
    def id(self) -> int:
        return self.dialog.id

    def to_dict(self) -> dict[str, Any]:
        return {
            "dialog": asdict(self.dialog),
            "samples": [asdict(s) for s in self.samples],
            "score": asdict(self.score) if self.score else None,
        }


def group_samples(samples: Iterable[MessageSample]) -> dict[int, list[MessageSample]]:
    """Группирует плоский список сообщений по диалогам (новые сверху)."""
    grouped: dict[int, list[MessageSample]] = {}
    for sample in samples:
        grouped.setdefault(sample.dialog_id, []).append(sample)
    for items in grouped.values():
        items.sort(key=lambda s: (s.date or "", s.message_id), reverse=True)
    return grouped
