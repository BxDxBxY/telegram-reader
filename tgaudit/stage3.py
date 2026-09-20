"""Этап 3. Скоринг и категоризация: keep / archive / unsubscribe.

Сеть нужна только если включён внешний ИИ. Эвристика считается всегда,
ИИ добавляет мнение поверх и в любой момент может быть отключён.
"""

from __future__ import annotations

from datetime import datetime
from typing import Callable

from .ai import AIError, apply_verdicts, classifier_from_settings
from .config import Settings
from .models import BUCKETS_RU, ChatRecord
from .scoring import ScoringConfig, score_all, summarize
from .storage import Store
from .util import utcnow


def run_scoring(
    store: Store,
    settings: Settings,
    *,
    use_ai: bool | None = None,
    now: datetime | None = None,
    log: Callable[[str], None] = print,
) -> dict[str, int]:
    """Считает баллы по всем диалогам и раскладывает по корзинам."""
    now = now or utcnow()
    dialogs = store.dialogs()
    if not dialogs:
        log("  в БД нет диалогов — сначала выполните `stage1`")
        return {}

    samples = store.all_samples()
    config = ScoringConfig(dead_days=settings.dead_days, stale_days=settings.stale_days)

    with store.run("stage3") as run_id:
        scores = score_all(dialogs, samples, config=config, now=now)

        wants_ai = settings.ai_provider != "none" if use_ai is None else use_ai
        if wants_ai:
            classifier = classifier_from_settings(settings, log=log)
            records = [
                ChatRecord(dialog=d, samples=samples.get(d.id, []))
                for d in dialogs
                if samples.get(d.id)  # ИИ имеет смысл только там, где есть срез
            ]
            try:
                verdicts = classifier.classify(records, include_dms=settings.ai_include_dms)
                applied = apply_verdicts(scores, verdicts, model=classifier.model)
                log(f"  ИИ разметил чатов: {applied}")
            except AIError as exc:
                # Отсутствие ИИ не ломает аудит: эвристика уже посчитана.
                log(f"  ⚠ ИИ пропущен: {exc}")

        saved = store.save_scores(scores)
        counts = summarize(scores)
        store.finish_run(
            run_id,
            "; ".join(f"{BUCKETS_RU[b]}: {n}" for b, n in counts.items()),
        )

    log(f"Скоринг готов ({saved} чатов):")
    total = sum(counts.values()) or 1
    for bucket, count in counts.items():
        log(f"  {BUCKETS_RU[bucket]:22} {count:5}  ({count / total * 100:4.1f} %)")
    return counts
