"""Слой Telegram (Telethon): клиент, преобразование объектов, сбор данных.

Telethon импортируется лениво — эвристики, скоринг и отчёты работают
на машине, где библиотека не установлена. Функции преобразования написаны
на «утиной типизации», поэтому их легко тестировать на фейковых объектах.
"""

from __future__ import annotations

import asyncio
from datetime import datetime
from typing import Any, Awaitable, Callable

from .config import Settings
from .heuristics import count_urls
from .models import (
    KIND_BOT,
    KIND_CHANNEL,
    KIND_DM,
    KIND_GROUP,
    KIND_SUPERGROUP,
    KIND_UNKNOWN,
    Dialog,
    MessageSample,
)
from .safety import Budget, Throttle, client_kwargs, with_flood_retry
from .util import one_line, to_iso, utcnow


def build_client(settings: Settings):
    """TelegramClient с правдоподобными параметрами устройства.

    Пустые device_model/app_version — типичный признак самописного скрипта,
    поэтому заполняем их как обычный десктоп-клиент (см. docs/SAFETY.md).
    """
    problems = settings.validate_credentials()
    if problems:
        raise RuntimeError("Нет доступа к Telegram API:\n  - " + "\n  - ".join(problems))
    try:
        from telethon import TelegramClient
    except ImportError as exc:  # pragma: no cover - зависит от окружения
        raise RuntimeError(
            "Не установлен telethon. Установите: pip install -r requirements.txt"
        ) from exc

    return TelegramClient(
        settings.session,
        settings.api_id,
        settings.api_hash,
        **client_kwargs(settings),
    )


# ── Преобразование объектов Telethon в наши модели ───────────────────────
def classify_entity(entity: Any) -> str:
    """Тип диалога: канал, супергруппа, группа, личка или бот.

    Сначала смотрим на характерные поля, потом на имя класса: так код переживёт
    и ChannelForbidden, и смену версии Telethon.
    """
    if entity is None:
        return KIND_UNKNOWN

    if hasattr(entity, "bot") or hasattr(entity, "first_name"):
        return KIND_BOT if getattr(entity, "bot", False) else KIND_DM
    if hasattr(entity, "megagroup") or hasattr(entity, "broadcast"):
        if getattr(entity, "megagroup", False) or getattr(entity, "gigagroup", False):
            return KIND_SUPERGROUP
        return KIND_CHANNEL

    name = type(entity).__name__
    if name.startswith("User"):
        return KIND_DM
    if name.startswith("Chat"):
        return KIND_GROUP
    if name.startswith("Channel") or name.startswith("Community"):
        return KIND_CHANNEL
    return KIND_UNKNOWN


def _entity_username(entity: Any) -> str | None:
    username = getattr(entity, "username", None)
    if username:
        return str(username)
    usernames = getattr(entity, "usernames", None) or []
    for item in usernames:
        value = getattr(item, "username", None)
        if value:
            return str(value)
    return None


def is_muted(tg_dialog: Any) -> bool:
    """Выключены ли уведомления: важный сигнал «я это не читаю»."""
    raw = getattr(tg_dialog, "dialog", None)
    settings = getattr(raw, "notify_settings", None)
    if settings is None:
        return False
    if getattr(settings, "silent", False):
        return True
    mute_until = getattr(settings, "mute_until", None)
    if mute_until is None:
        return False
    if isinstance(mute_until, datetime):
        reference = utcnow()
        if mute_until.tzinfo is None:
            mute_until = mute_until.replace(tzinfo=reference.tzinfo)
        return mute_until > reference
    try:
        return int(mute_until) > 0
    except (TypeError, ValueError):
        return False


def dialog_to_record(tg_dialog: Any, *, now: datetime | None = None) -> Dialog:
    """Telethon Dialog -> наша модель. Сообщения при этом НЕ читаются:
    превью берётся из того же ответа, что и список диалогов."""
    entity = getattr(tg_dialog, "entity", None)
    message = getattr(tg_dialog, "message", None)
    return Dialog(
        id=int(getattr(tg_dialog, "id", 0) or 0),
        kind=classify_entity(entity),
        title=str(getattr(tg_dialog, "name", None) or getattr(tg_dialog, "title", "") or ""),
        username=_entity_username(entity),
        participants_count=getattr(entity, "participants_count", None),
        unread_count=int(getattr(tg_dialog, "unread_count", 0) or 0),
        unread_mentions=int(getattr(tg_dialog, "unread_mentions_count", 0) or 0),
        is_pinned=bool(getattr(tg_dialog, "pinned", False)),
        is_archived=bool(getattr(tg_dialog, "archived", False)),
        is_muted=is_muted(tg_dialog),
        is_verified=bool(getattr(entity, "verified", False)),
        is_scam=bool(getattr(entity, "scam", False)),
        is_fake=bool(getattr(entity, "fake", False)),
        last_message_date=to_iso(getattr(tg_dialog, "date", None)),
        last_message_id=getattr(message, "id", None),
        last_message_preview=one_line(getattr(message, "message", "") or "", 200),
        collected_at=to_iso(now or utcnow()),
    )


def _media_type(message: Any) -> str | None:
    media = getattr(message, "media", None)
    if media is None:
        return None
    return type(media).__name__.replace("MessageMedia", "").lower() or None


def message_to_sample(
    dialog_id: int, message: Any, *, text_limit: int = 300, now: datetime | None = None
) -> MessageSample:
    """Telethon Message -> компактная запись. Текст режется, медиа не качаются."""
    text = getattr(message, "message", None) or getattr(message, "text", "") or ""
    trimmed = one_line(text, text_limit)
    return MessageSample(
        dialog_id=dialog_id,
        message_id=int(getattr(message, "id", 0) or 0),
        date=to_iso(getattr(message, "date", None)),
        text=trimmed,
        has_media=getattr(message, "media", None) is not None,
        media_type=_media_type(message),
        views=getattr(message, "views", None),
        forwards=getattr(message, "forwards", None),
        is_forward=getattr(message, "fwd_from", None) is not None,
        is_service=getattr(message, "action", None) is not None,
        url_count=count_urls(text),
        collected_at=to_iso(now or utcnow()),
    )


# ── Сбор данных ──────────────────────────────────────────────────────────
async def collect_dialogs(
    client: Any,
    *,
    limit: int | None = None,
    log: Callable[[str], None] = print,
    flood_limit: int = 600,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> list[Dialog]:
    """Этап 1: один последовательный проход по списку диалогов.

    `iter_dialogs` сам пагинирует запросы — это самая дешёвая для API операция,
    поэтому дополнительных пауз между страницами не нужно.
    """
    now = utcnow()
    records: list[Dialog] = []

    async def _pull() -> list[Dialog]:
        collected: list[Dialog] = []
        async for tg_dialog in client.iter_dialogs(limit=limit):
            collected.append(dialog_to_record(tg_dialog, now=now))
            if len(collected) % 100 == 0:
                log(f"  … собрано {len(collected)} диалогов")
        return collected

    records = await with_flood_retry(
        _pull, limit=flood_limit, sleep=sleep, log=log, label="iter_dialogs"
    )
    log(f"  всего диалогов: {len(records)}")
    return records


async def fetch_samples(
    client: Any,
    dialog: Dialog,
    *,
    limit: int = 25,
    flood_limit: int = 600,
    budget: Budget | None = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    log: Callable[[str], None] = print,
    text_limit: int = 300,
) -> list[MessageSample]:
    """Этап 2: последние `limit` сообщений одного чата. Строго по одному чату."""
    peer: Any = dialog.id
    get_input_entity = getattr(client, "get_input_entity", None)
    if callable(get_input_entity):
        # Сначала id: после этапа 1 он лежит в кеше сессии и резолвится без сети.
        # Резолв по @username — это лишний сетевой запрос на каждый чат.
        for candidate in (dialog.id, dialog.username):
            if candidate is None:
                continue
            try:
                peer = await get_input_entity(candidate)
                break
            except Exception:  # noqa: BLE001 - кеш мог не прогреться, пробуем дальше
                peer = dialog.id

    async def _pull() -> list[Any]:
        return await client.get_messages(peer, limit=limit)

    messages = await with_flood_retry(
        _pull,
        limit=flood_limit,
        budget=budget,
        sleep=sleep,
        log=log,
        label=dialog.title or str(dialog.id),
    )
    now = utcnow()
    return [
        message_to_sample(dialog.id, m, text_limit=text_limit, now=now)
        for m in (messages or [])
    ]


def make_throttle(settings: Settings, *, sleep=asyncio.sleep) -> Throttle:
    """Троттлер из настроек: паузы 1.5–3.5 с + длинная пауза каждые N чатов."""
    return Throttle(
        min_delay=settings.min_delay,
        max_delay=settings.max_delay,
        long_pause_every=settings.long_pause_every,
        long_pause_min=settings.long_pause_min,
        long_pause_max=settings.long_pause_max,
        sleep=sleep,
    )


async def describe_me(client: Any) -> str:
    """Короткая строка о владельце сессии — чтобы не перепутать аккаунт."""
    me = await client.get_me()
    if me is None:
        return "неизвестный аккаунт"
    username = _entity_username(me)
    name = " ".join(
        part for part in (getattr(me, "first_name", ""), getattr(me, "last_name", "")) if part
    )
    handle = f" @{username}" if username else ""
    return f"{name or 'без имени'}{handle} (id {getattr(me, 'id', '?')})"
