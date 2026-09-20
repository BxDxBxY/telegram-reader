"""Мелкие утилиты: время, текст, форматирование. Без внешних зависимостей."""

from __future__ import annotations

import re
from datetime import datetime, timezone


def utcnow() -> datetime:
    """Текущее время в UTC (tz-aware)."""
    return datetime.now(timezone.utc)


def to_iso(value: datetime | None) -> str | None:
    """datetime -> ISO-8601 в UTC. None пробрасывается как есть."""
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc).isoformat()


def parse_iso(value: str | datetime | None) -> datetime | None:
    """ISO-8601 -> datetime в UTC. Мусор и None превращаются в None."""
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def days_since(value: datetime | str | None, now: datetime | None = None) -> float | None:
    """Сколько дней прошло с момента `value`. None, если даты нет."""
    moment = parse_iso(value)
    if moment is None:
        return None
    reference = now or utcnow()
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=timezone.utc)
    return (reference - moment).total_seconds() / 86400.0


def human_days(days: float | None) -> str:
    """Человеческое описание давности: «2 дня назад», «больше года назад»."""
    if days is None:
        return "нет данных"
    if days < 1:
        return "сегодня"
    if days < 2:
        return "вчера"
    if days < 45:
        return f"{int(days)} дн. назад"
    if days < 365:
        return f"{int(days / 30)} мес. назад"
    years = days / 365
    return "год назад" if years < 2 else f"{years:.1f} года назад"


_WHITESPACE_RE = re.compile(r"\s+")


def one_line(text: str | None, limit: int = 300) -> str:
    """Схлопывает переносы и режет текст до `limit` символов."""
    if not text:
        return ""
    collapsed = _WHITESPACE_RE.sub(" ", str(text)).strip()
    if len(collapsed) <= limit:
        return collapsed
    return collapsed[: limit - 1].rstrip() + "…"


def human_minutes(minutes: float) -> str:
    """«меньше минуты» / «≈7 мин» / «≈1 ч 20 мин» — без обидного «≈0 мин»."""
    if minutes < 1:
        return "меньше минуты"
    if minutes < 90:
        return f"≈{minutes:.0f} мин"
    hours, rest = divmod(int(round(minutes)), 60)
    return f"≈{hours} ч {rest} мин" if rest else f"≈{hours} ч"


def thousands(value: int | float | None) -> str:
    """1240 -> «1 240» (узкий неразрывный пробел не используем — терминалы врут)."""
    if value is None:
        return "—"
    return f"{int(value):,}".replace(",", " ")
