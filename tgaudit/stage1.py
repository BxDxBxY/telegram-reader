"""Этап 1. Первичная инвентаризация: только метаданные, без чтения сообщений.

Задача этапа — получить полный список диалогов и чистой эвристикой отсеять
40–50 % мусора, не потратив ни одного лишнего запроса к API.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Callable

from .config import Settings
from .heuristics import triage_all
from .models import TRIAGE_DROP, TRIAGE_KEEP, TRIAGE_SAMPLE, TRIAGE_RU
from .storage import Store
from .tg import collect_dialogs
from .util import to_iso, utcnow


async def run_inventory(
    client: Any,
    store: Store,
    settings: Settings,
    *,
    limit: int | None = None,
    log: Callable[[str], None] = print,
) -> int:
    """Скачивает список диалогов и кладёт метаданные в БД."""
    log("Этап 1: инвентаризация диалогов (сообщения не читаются)")
    with store.run("stage1") as run_id:
        dialogs = await collect_dialogs(
            client, limit=limit, log=log, flood_limit=settings.flood_wait_limit
        )
        saved = store.upsert_dialogs(dialogs)
        store.set_meta("last_stage1_at", to_iso(utcnow()) or "")
        store.finish_run(run_id, f"диалогов: {saved}")
    log(f"  сохранено в БД: {saved}")
    return saved


def run_triage(
    store: Store,
    settings: Settings,
    *,
    now: datetime | None = None,
    include_dms: bool = False,
    log: Callable[[str], None] = print,
) -> dict[str, int]:
    """Раскладывает диалоги на drop / keep / sample. Сеть не нужна."""
    now = now or utcnow()
    dialogs = store.dialogs()
    if not dialogs:
        log("  в БД нет диалогов — сначала выполните `stage1`")
        return {}

    results = triage_all(
        dialogs,
        dead_days=settings.dead_days,
        stale_days=settings.stale_days,
        now=now,
        include_dms=include_dms,
    )
    counts = {TRIAGE_KEEP: 0, TRIAGE_SAMPLE: 0, TRIAGE_DROP: 0}
    for dialog_id, result in results.items():
        store.save_triage(dialog_id, result.action, result.reasons)
        counts[result.action] = counts.get(result.action, 0) + 1

    total = len(dialogs) or 1
    filtered = counts[TRIAGE_DROP] + counts[TRIAGE_KEEP]
    log("Фильтрация по метаданным:")
    for action in (TRIAGE_DROP, TRIAGE_KEEP, TRIAGE_SAMPLE):
        share = counts[action] / total * 100
        log(f"  {TRIAGE_RU[action]:34} {counts[action]:5}  ({share:4.1f} %)")
    log(
        f"  → этап 2 понадобится для {counts[TRIAGE_SAMPLE]} чатов из {total} "
        f"({filtered / total * 100:.0f} % отсеяно без чтения сообщений)"
    )
    return counts
