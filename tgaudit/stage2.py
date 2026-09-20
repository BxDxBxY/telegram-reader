"""Этап 2. Срезы логов: последние 15–30 сообщений по «сомнительным» чатам.

Главное здесь — темп. Обход строго последовательный, между чатами случайная
пауза, FloodWait уважается, на прогон действует бюджет. Прерывание безопасно:
прогресс уже в БД, повторный запуск продолжит с места остановки.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any, Callable

from .config import Settings
from .models import Dialog
from .safety import Budget, BudgetExhausted, FloodWaitTooLong
from .storage import Store
from .tg import fetch_samples, make_throttle
from .util import human_minutes, one_line


@dataclass
class SamplingReport:
    """Итоги прогона этапа 2."""

    planned: int = 0
    done: int = 0
    failed: int = 0
    messages: int = 0
    stopped_reason: str | None = None

    def as_text(self) -> str:
        parts = [
            f"обработано {self.done}/{self.planned} чатов",
            f"сообщений сохранено: {self.messages}",
        ]
        if self.failed:
            parts.append(f"недоступны: {self.failed}")
        if self.stopped_reason:
            parts.append(f"остановка: {self.stopped_reason}")
        return "; ".join(parts)


def estimate_minutes(count: int, settings: Settings) -> float:
    """Ожидаемая длительность прогона — чтобы не запускать вслепую."""
    average_pause = (settings.min_delay + settings.max_delay) / 2
    long_pauses = count / settings.long_pause_every if settings.long_pause_every else 0
    average_long = (settings.long_pause_min + settings.long_pause_max) / 2
    seconds = count * (average_pause + 1.0) + long_pauses * average_long
    return seconds / 60


async def run_sampling(
    client: Any,
    store: Store,
    settings: Settings,
    *,
    limit: int | None = None,
    include_dms: bool = False,
    resample: bool = False,
    log: Callable[[str], None] = print,
    sleep: Callable[[float], Any] = asyncio.sleep,
) -> SamplingReport:
    """Последовательно выгружает срезы сообщений для очереди этапа 2."""
    max_chats = limit or settings.max_chats_per_run
    queue: list[Dialog] = store.dialogs_to_sample(
        limit=max_chats, include_dms=include_dms, resample=resample
    )
    report = SamplingReport(planned=len(queue))
    if not queue:
        log("  очередь пуста: нечего выгружать (сначала `stage1`, потом `triage`)")
        return report

    throttle = make_throttle(settings, sleep=sleep)
    budget = Budget(max_chats=max_chats)
    log(
        f"Этап 2: {len(queue)} чатов по {settings.sample_limit} сообщений, "
        f"паузы {settings.min_delay}–{settings.max_delay} с "
        f"({human_minutes(estimate_minutes(len(queue), settings))})"
    )

    with store.run("stage2") as run_id:
        for index, dialog in enumerate(queue, start=1):
            try:
                budget.take_chat()
            except BudgetExhausted as exc:
                report.stopped_reason = str(exc)
                log(f"  ⏹ {exc}")
                break

            title = one_line(dialog.title or str(dialog.id), 40)
            try:
                samples = await fetch_samples(
                    client,
                    dialog,
                    limit=settings.sample_limit,
                    flood_limit=settings.flood_wait_limit,
                    budget=budget,
                    sleep=sleep,
                    log=log,
                )
            except (FloodWaitTooLong, BudgetExhausted) as exc:
                # Telegram явно просит сбавить темп — выходим, не теряя прогресс.
                report.stopped_reason = str(exc)
                log(f"  ⏹ {exc}")
                break
            except (asyncio.CancelledError, KeyboardInterrupt):
                report.stopped_reason = "прервано пользователем"
                raise
            except Exception as exc:  # noqa: BLE001 - приватные/удалённые чаты
                report.failed += 1
                store.mark_sampled(dialog.id, error=f"{type(exc).__name__}: {exc}")
                log(f"  [{index}/{len(queue)}] {title}: недоступен ({type(exc).__name__})")
            else:
                store.save_samples(samples)
                store.mark_sampled(dialog.id)
                report.done += 1
                report.messages += len(samples)
                log(f"  [{index}/{len(queue)}] {title}: {len(samples)} сообщений")

            if index < len(queue):
                await throttle.wait()

        store.finish_run(run_id, report.as_text())

    log(f"  {report.as_text()}")
    return report
