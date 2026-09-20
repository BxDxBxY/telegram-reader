"""Отчёты: Markdown для глаз, CSV для таблицы, JSONL для кода,
батчи для ручной загрузки в любой бесплатный веб-чат с ИИ.
"""

from __future__ import annotations

import csv
import json
from datetime import datetime
from pathlib import Path
from typing import Sequence

from .models import (
    BUCKET_ARCHIVE,
    BUCKET_DROP,
    BUCKET_KEEP,
    BUCKETS_RU,
    ChatRecord,
    Dialog,
)
from .safety import READ_ONLY_NOTICE
from .util import days_since, human_days, one_line, thousands, utcnow

BATCH_PROMPT = """Вот список моих Telegram-каналов и чатов с последними постами.
Сгруппируй их по тематикам, укажи явный мусор (реклама, инфоцыганство, скам, дубли)
и порекомендуй, от чего отписаться. Формат ответа: таблица
«ID | название | тема | вердикт (оставить/архив/отписаться) | причина».
"""


def _unread(dialog: Dialog) -> str:
    return thousands(dialog.unread_count) if dialog.unread_count else "0"


def render_chat_block(record: ChatRecord, *, max_messages: int = 5, with_verdict: bool = True) -> str:
    """Один чат в компактном Markdown — формат для чтения глазами и для ИИ."""
    dialog, score = record.dialog, record.score
    age = days_since(dialog.last_message_date)
    lines = [
        "---",
        f"### [ID: {dialog.id}] {dialog.title or 'без названия'}",
        f"- **Тип:** {dialog.kind_ru}" + (f" (@{dialog.username})" if dialog.username else ""),
        f"- **Непрочитанных:** {_unread(dialog)}",
        f"- **Последняя активность:** {human_days(age)}",
    ]
    marks = []
    if dialog.is_pinned:
        marks.append("закреплён")
    if dialog.is_archived:
        marks.append("в архиве")
    if dialog.is_muted:
        marks.append("без звука")
    if dialog.is_scam or dialog.is_fake:
        marks.append("метка scam/fake")
    if marks:
        lines.append(f"- **Пометки:** {', '.join(marks)}")

    if with_verdict and score:
        lines.append(f"- **Балл:** {score.score:.0f}/100 — {score.bucket_ru}")
        if score.topic:
            lines.append(f"- **Тема:** {score.topic}")
        if score.reasons:
            lines.append(f"- **Почему:** {'; '.join(score.reasons)}")
        if score.ai_bucket:
            ai_line = f"- **Мнение ИИ:** {score.ai_bucket}"
            if score.ai_topic:
                ai_line += f" / {score.ai_topic}"
            if score.ai_reason:
                ai_line += f" — {score.ai_reason}"
            lines.append(ai_line)

    content = [s for s in record.samples if not s.is_service and (s.text or s.has_media)]
    if content:
        lines.append("- **Срез последних постов:**")
        for index, sample in enumerate(content[:max_messages], start=1):
            text = one_line(sample.text, 160) or f"[{sample.media_type or 'медиа'}]"
            lines.append(f'  {index}. "{text}"')
    elif record.dialog.sample_error:
        lines.append(f"- **Срез:** не собран ({record.dialog.sample_error})")
    else:
        lines.append("- **Срез:** не требовался (вердикт по метаданным)")

    lines.append("---")
    return "\n".join(lines)


def render_report(records: Sequence[ChatRecord], *, now: datetime | None = None) -> str:
    """Полный отчёт: сводка + чаты по корзинам (худшие первыми внутри корзины)."""
    now = now or utcnow()
    buckets: dict[str, list[ChatRecord]] = {BUCKET_KEEP: [], BUCKET_ARCHIVE: [], BUCKET_DROP: []}
    for record in records:
        bucket = record.score.bucket if record.score else BUCKET_KEEP
        buckets.setdefault(bucket, []).append(record)

    total = len(records)
    lines = [
        "# Аудит Telegram-аккаунта",
        "",
        f"Дата отчёта: {now:%Y-%m-%d %H:%M UTC} · всего диалогов: {total}",
        "",
        "| Корзина | Чатов | Доля |",
        "| --- | ---: | ---: |",
    ]
    for bucket in (BUCKET_KEEP, BUCKET_ARCHIVE, BUCKET_DROP):
        count = len(buckets.get(bucket, []))
        share = count / total * 100 if total else 0
        lines.append(f"| {BUCKETS_RU[bucket]} | {count} | {share:.0f} % |")

    lines += ["", f"> {READ_ONLY_NOTICE}", ""]

    for bucket in (BUCKET_DROP, BUCKET_ARCHIVE, BUCKET_KEEP):
        items = sorted(
            buckets.get(bucket, []), key=lambda r: (r.score.score if r.score else 50.0)
        )
        lines.append(f"## {BUCKETS_RU[bucket]} — {len(items)}")
        lines.append("")
        if not items:
            lines += ["_пусто_", ""]
            continue
        for record in items:
            lines.append(render_chat_block(record))
            lines.append("")
    return "\n".join(lines)


def render_batches(
    records: Sequence[ChatRecord], *, size: int = 20, prompt: str = BATCH_PROMPT
) -> list[str]:
    """Блоки по 20–30 чатов: копируете в ChatGPT/Claude/Gemini и получаете разбор."""
    chunks: list[str] = []
    batch: list[ChatRecord] = []
    for record in records:
        batch.append(record)
        if len(batch) >= size:
            chunks.append(_render_batch(batch, len(chunks) + 1, prompt))
            batch = []
    if batch:
        chunks.append(_render_batch(batch, len(chunks) + 1, prompt))
    return chunks


def _render_batch(batch: Sequence[ChatRecord], index: int, prompt: str) -> str:
    header = f"# Батч {index} · чатов: {len(batch)}\n\n{prompt.strip()}\n"
    body = "\n\n".join(render_chat_block(r, with_verdict=False) for r in batch)
    return f"{header}\n{body}\n"


CSV_COLUMNS = [
    "id", "title", "kind", "username", "link", "unread", "unread_mentions",
    "last_activity_days", "pinned", "archived", "muted", "score", "bucket",
    "topic", "language", "ads_ratio", "posts_per_week", "duplicate_group",
    "ai_bucket", "ai_topic", "reasons",
]


def write_csv(records: Sequence[ChatRecord], path: str | Path) -> Path:
    """Таблица для Excel/Google Sheets: отсортировать, отфильтровать, решить."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=CSV_COLUMNS, delimiter=";")
        writer.writeheader()
        for record in records:
            dialog, score = record.dialog, record.score
            age = days_since(dialog.last_message_date)
            writer.writerow(
                {
                    "id": dialog.id,
                    "title": dialog.title,
                    "kind": dialog.kind,
                    "username": dialog.username or "",
                    "link": dialog.link or "",
                    "unread": dialog.unread_count,
                    "unread_mentions": dialog.unread_mentions,
                    "last_activity_days": f"{age:.0f}" if age is not None else "",
                    "pinned": int(dialog.is_pinned),
                    "archived": int(dialog.is_archived),
                    "muted": int(dialog.is_muted),
                    "score": f"{score.score:.0f}" if score else "",
                    "bucket": score.bucket if score else "",
                    "topic": (score.topic if score else "") or "",
                    "language": (score.language if score else "") or "",
                    "ads_ratio": f"{score.ads_ratio:.2f}" if score and score.ads_ratio else "",
                    "posts_per_week": f"{score.posts_per_week:.1f}"
                    if score and score.posts_per_week
                    else "",
                    "duplicate_group": (score.duplicate_group if score else "") or "",
                    "ai_bucket": (score.ai_bucket if score else "") or "",
                    "ai_topic": (score.ai_topic if score else "") or "",
                    "reasons": "; ".join(score.reasons) if score else "",
                }
            )
    return target


def write_jsonl(records: Sequence[ChatRecord], path: str | Path) -> Path:
    """Машиночитаемый срез — для своих скриптов и внешнего ИИ."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8") as handle:
        for record in records:
            handle.write(json.dumps(record.to_dict(), ensure_ascii=False) + "\n")
    return target


def render_unsubscribe_plan(records: Sequence[ChatRecord], *, per_day: int = 25) -> str:
    """План ручной отписки пачками по дням — чтобы не поймать ограничение."""
    targets = sorted(
        (r for r in records if r.score and r.score.bucket == BUCKET_DROP),
        key=lambda r: r.score.score,
    )
    lines = [
        "# План ручной отписки",
        "",
        f"Кандидатов: {len(targets)}. Порядок — от самых бесполезных к спорным.",
        "",
        "**Правила безопасности:**",
        f"- не больше {per_day} отписок в день, с паузами в несколько минут;",
        "- отписывайтесь руками в обычном клиенте, не скриптом;",
        "- личные переписки в этот список не попадают — их вы решаете сами.",
        "",
    ]
    if not targets:
        lines.append("_Кандидатов на отписку нет._")
        return "\n".join(lines)

    for day, start in enumerate(range(0, len(targets), per_day), start=1):
        chunk = targets[start : start + per_day]
        lines.append(f"## День {day} — {len(chunk)} шт.")
        lines.append("")
        for record in chunk:
            dialog = record.dialog
            link = f" — {dialog.link}" if dialog.link else ""
            reason = record.score.reasons[0] if record.score and record.score.reasons else ""
            lines.append(
                f"- [ ] **{dialog.title or dialog.id}**{link} "
                f"({record.score.score:.0f}/100; {reason})"
            )
        lines.append("")
    return "\n".join(lines)


def write_all(
    records: Sequence[ChatRecord],
    out_dir: str | Path,
    *,
    batch_size: int = 20,
    per_day: int = 25,
    now: datetime | None = None,
) -> dict[str, Path]:
    """Складывает все артефакты отчёта в каталог и возвращает пути."""
    out = Path(out_dir)
    (out / "batches").mkdir(parents=True, exist_ok=True)
    written: dict[str, Path] = {}

    report_path = out / "report.md"
    report_path.write_text(render_report(records, now=now), encoding="utf-8")
    written["report"] = report_path

    written["csv"] = write_csv(records, out / "report.csv")
    written["jsonl"] = write_jsonl(records, out / "chats.jsonl")

    plan_path = out / "unsubscribe_plan.md"
    plan_path.write_text(render_unsubscribe_plan(records, per_day=per_day), encoding="utf-8")
    written["plan"] = plan_path

    # Для ручного анализа отдаём только то, что реально требует решения.
    manual = [r for r in records if not r.score or r.score.bucket != BUCKET_KEEP]
    for index, chunk in enumerate(render_batches(manual, size=batch_size), start=1):
        path = out / "batches" / f"batch_{index:02d}.md"
        path.write_text(chunk, encoding="utf-8")
        written[f"batch_{index:02d}"] = path
    return written
