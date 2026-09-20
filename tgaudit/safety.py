"""Протокол безопасности для MTProto: паузы, FloodWait, бюджет запросов.

Telegram блокирует не за чтение через Telethon/Pyrogram, а за поведение,
похожее на спам-бота: шквал запросов, параллельные потоки, массовые действия.
Весь модуль — про то, чтобы аккаунт выглядел как обычный человек за десктопом.
"""

from __future__ import annotations

import asyncio
import random
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, TypeVar

T = TypeVar("T")

# Telethon может быть не установлен (эвристики и отчёты работают без него).
try:  # pragma: no cover - зависит от окружения
    from telethon.errors import FloodWaitError as _FloodWaitError

    _FLOOD_TYPES: tuple[type[BaseException], ...] = (_FloodWaitError,)
except Exception:  # pragma: no cover
    _FLOOD_TYPES = ()

# Имена классов FloodWait в Telethon и Pyrogram — на случай импорта без telethon.
_FLOOD_NAMES = {"FloodWaitError", "FloodWait", "FloodPremiumWaitError"}


def flood_seconds(exc: BaseException) -> int | None:
    """Сколько секунд просит подождать Telegram. None — это не FloodWait."""
    if _FLOOD_TYPES and isinstance(exc, _FLOOD_TYPES):
        return int(getattr(exc, "seconds", 0) or 0)
    if type(exc).__name__ in _FLOOD_NAMES:
        seconds = getattr(exc, "seconds", None)
        if seconds is None:
            seconds = getattr(exc, "value", 0)
        try:
            return int(seconds or 0)
        except (TypeError, ValueError):
            return 0
    return None


class FloodWaitTooLong(RuntimeError):
    """Telegram просит ждать дольше лимита — корректно останавливаемся."""

    def __init__(self, seconds: int, limit: int):
        super().__init__(
            f"Telegram просит подождать {seconds} с (лимит {limit} с). "
            f"Останавливаемся — продолжите позже, прогресс сохранён в БД."
        )
        self.seconds = seconds
        self.limit = limit


class BudgetExhausted(RuntimeError):
    """Исчерпан дневной бюджет чатов/запросов за один прогон."""


@dataclass
class Throttle:
    """Случайные паузы между обращениями к API + редкие длинные передышки.

    `sleep` и `rng` вынесены в поля, чтобы тесты шли мгновенно и детерминированно.
    """

    min_delay: float = 1.5
    max_delay: float = 3.5
    long_pause_every: int = 25
    long_pause_min: float = 15.0
    long_pause_max: float = 40.0
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep
    rng: random.Random = field(default_factory=random.Random)
    calls: int = 0
    slept_total: float = 0.0

    def next_delay(self) -> float:
        """Обычная пауза между чатами; каждые N чатов — длинная."""
        self.calls += 1
        if self.long_pause_every and self.calls % self.long_pause_every == 0:
            return self.rng.uniform(self.long_pause_min, self.long_pause_max)
        low, high = self.min_delay, max(self.min_delay, self.max_delay)
        return self.rng.uniform(low, high)

    async def wait(self) -> float:
        delay = self.next_delay()
        self.slept_total += delay
        await self.sleep(delay)
        return delay


@dataclass
class Budget:
    """Ограничитель объёма работы за один запуск."""

    max_chats: int = 150
    used_chats: int = 0
    max_flood_waits: int = 5
    flood_waits: int = 0

    def take_chat(self) -> None:
        if self.used_chats >= self.max_chats:
            raise BudgetExhausted(
                f"Достигнут лимит {self.max_chats} чатов за прогон. "
                f"Запустите этап 2 ещё раз позже — он продолжит с места остановки."
            )
        self.used_chats += 1

    def note_flood(self) -> None:
        self.flood_waits += 1
        if self.flood_waits > self.max_flood_waits:
            raise BudgetExhausted(
                f"{self.flood_waits} FloodWait за прогон — Telegram явно просит "
                f"сбавить темп. Останавливаемся, продолжите через несколько часов."
            )


async def with_flood_retry(
    action: Callable[[], Awaitable[T]],
    *,
    limit: int = 600,
    attempts: int = 3,
    budget: Budget | None = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    log: Callable[[str], None] = print,
    label: str = "",
) -> T:
    """Выполняет запрос, корректно переживая FloodWaitError.

    Правило: получили FloodWait — спим ровно столько, сколько просят (+2 с
    запаса), и только потом повторяем. Никаких мгновенных ретраев.
    """
    last_error: BaseException | None = None
    for attempt in range(1, attempts + 1):
        try:
            return await action()
        except BaseException as exc:  # noqa: BLE001 — разбираем тип вручную
            seconds = flood_seconds(exc)
            if seconds is None:
                raise
            last_error = exc
            if seconds > limit:
                raise FloodWaitTooLong(seconds, limit) from exc
            if budget is not None:
                budget.note_flood()
            where = f" [{label}]" if label else ""
            log(f"⏳ FloodWait{where}: ждём {seconds} с (попытка {attempt}/{attempts})")
            await sleep(seconds + 2)
    raise RuntimeError(f"Не удалось выполнить запрос после {attempts} попыток") from last_error


def client_kwargs(settings: Any) -> dict[str, Any]:
    """Параметры «правдоподобного» устройства для TelegramClient.

    Пустые/дефолтные device_model и app_version — один из сигналов, по которым
    Telegram отличает самописный скрипт от обычного клиента.
    """
    return {
        "device_model": settings.device_model or "Desktop PC",
        "system_version": settings.system_version or "Linux 6.x",
        "app_version": settings.app_version or "5.0.1",
        "lang_code": settings.lang_code or "ru",
        "system_lang_code": settings.system_lang_code or "ru",
    }


READ_ONLY_NOTICE = (
    "tgaudit работает только на чтение: он не выходит из каналов, не удаляет "
    "чаты и не пишет сообщений. Массовая отписка скриптом за пару минут — "
    "самый быстрый способ получить ограничение аккаунта."
)
