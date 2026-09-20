"""Этап 3: балл полезности 0–100 и распределение по корзинам.

Скоринг детерминированный и объяснимый: у каждого вердикта есть список причин
на русском, который попадает в отчёт. ИИ (если включён) добавляет своё мнение
отдельным полем и не переписывает эвристику молча.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from statistics import mean
from typing import Sequence

from .heuristics import (
    CATEGORY_RU,
    count_urls,
    detect_language,
    detect_topic,
    duplicate_groups,
    is_service_dialog,
    text_flags,
)
from .models import (
    BUCKET_ARCHIVE,
    BUCKET_DROP,
    BUCKET_KEEP,
    KIND_BOT,
    KIND_DM,
    KIND_GROUP,
    KIND_SUPERGROUP,
    Dialog,
    MessageSample,
    Score,
)
from .util import days_since, human_days, parse_iso, to_iso, utcnow


# Срез меньше этого размера считается слабым доказательством, и штрафы за
# содержимое применяются пропорционально: 2 сообщения ≠ приговор каналу.
FULL_EVIDENCE_SAMPLES = 8


@dataclass
class ScoringConfig:
    """Пороги и веса. Меняются флагами CLI, если ваш вкус отличается."""

    dead_days: int = 180
    stale_days: int = 90
    keep_threshold: float = 60.0
    archive_threshold: float = 35.0
    duplicate_penalty: float = 15.0
    base_score: float = 50.0


@dataclass
class SampleStats:
    """Выжимка из среза сообщений одного чата."""

    count: int = 0
    span_days: float = 0.0
    posts_per_week: float | None = None
    ads_ratio: float = 0.0
    flag_counts: dict[str, int] = field(default_factory=dict)
    avg_length: float = 0.0
    url_ratio: float = 0.0
    forward_ratio: float = 0.0
    language: str = "unknown"
    topic: str | None = None


def analyze_samples(samples: Sequence[MessageSample]) -> SampleStats:
    """Считает частоту публикаций, долю рекламы и прочие сигналы среза."""
    content = [s for s in samples if not s.is_service]
    if not content:
        return SampleStats()

    texts = [s.text or "" for s in content]
    flag_counts: dict[str, int] = {}
    flagged_messages = 0
    for text in texts:
        flags = text_flags(text)
        if flags & {"ads", "infogypsy", "scam", "job_spam"}:
            flagged_messages += 1
        for flag in flags:
            flag_counts[flag] = flag_counts.get(flag, 0) + 1

    dates = sorted(d for d in (parse_iso(s.date) for s in content) if d is not None)
    span_days = (dates[-1] - dates[0]).total_seconds() / 86400.0 if len(dates) > 1 else 0.0
    posts_per_week = (len(dates) / span_days * 7) if span_days >= 1 else None

    return SampleStats(
        count=len(content),
        span_days=span_days,
        posts_per_week=posts_per_week,
        ads_ratio=flagged_messages / len(content),
        flag_counts=flag_counts,
        avg_length=mean(len(t) for t in texts),
        url_ratio=mean(1.0 if (s.url_count or count_urls(s.text)) else 0.0 for s in content),
        forward_ratio=mean(1.0 if s.is_forward else 0.0 for s in content),
        language=detect_language(texts),
        topic=detect_topic(" ".join(texts)[:4000]),
    )


def _bucket_for(score: float, config: ScoringConfig) -> str:
    if score >= config.keep_threshold:
        return BUCKET_KEEP
    if score >= config.archive_threshold:
        return BUCKET_ARCHIVE
    return BUCKET_DROP


def score_dialog(
    dialog: Dialog,
    samples: Sequence[MessageSample] = (),
    *,
    config: ScoringConfig | None = None,
    now: datetime | None = None,
) -> Score:
    """Балл одного чата без учёта дублей (их применяет `score_all`)."""
    config = config or ScoringConfig()
    now = now or utcnow()
    stats = analyze_samples(samples)
    points = config.base_score
    reasons: list[str] = []

    # Служебное и закреплённое — вне конкурса.
    if is_service_dialog(dialog):
        return Score(
            dialog_id=dialog.id,
            score=100.0,
            bucket=BUCKET_KEEP,
            reasons=["служебный аккаунт Telegram"],
            language=stats.language,
            topic=stats.topic or detect_topic(dialog.title),
            ads_ratio=stats.ads_ratio,
            posts_per_week=stats.posts_per_week,
            scored_at=to_iso(now),
        )

    # 1. Свежесть
    age = days_since(dialog.last_message_date, now)
    if age is None:
        points -= 5
        reasons.append("неизвестна дата последней активности")
    elif age < 7:
        points += 15
        reasons.append(f"активен ({human_days(age)})")
    elif age < 30:
        points += 8
        reasons.append(f"живой ({human_days(age)})")
    elif age < config.stale_days:
        reasons.append(f"вялый ({human_days(age)})")
    elif age < config.dead_days:
        points -= 12
        reasons.append(f"затухает ({human_days(age)})")
    elif age < 365:
        points -= 25
        reasons.append(f"мёртвый ({human_days(age)})")
    else:
        points -= 40
        reasons.append(f"молчит больше года ({human_days(age)})")

    # 2. Ваше поведение: закрепления, звук, архив, непрочитанные
    if dialog.is_pinned:
        points += 25
        reasons.append("закреплён вами")
    if dialog.is_archived:
        points -= 10
        reasons.append("лежит в архиве")
    if dialog.is_muted:
        points -= 8
        reasons.append("уведомления выключены")
    if dialog.unread_count > 1000:
        points -= 12
        reasons.append(f"{dialog.unread_count} непрочитанных — поток не читается")
    elif dialog.unread_count > 300:
        points -= 6
        reasons.append(f"{dialog.unread_count} непрочитанных")
    elif dialog.unread_count == 0 and age is not None and age < 30:
        points += 6
        reasons.append("читаете вовремя")
    if dialog.unread_mentions:
        points += 10
        reasons.append(f"вас упоминали ({dialog.unread_mentions}) — вероятно, рабочий чат")

    # 3. Метки самого Telegram
    if dialog.is_scam or dialog.is_fake:
        points -= 45
        reasons.append("Telegram пометил как scam/fake")
    if dialog.is_verified:
        points += 5
        reasons.append("верифицирован")

    # 4. Содержимое среза (этап 2).
    # Два сообщения — это не статистика: вес выводов растёт с размером среза.
    if stats.count:
        evidence = min(1.0, stats.count / FULL_EVIDENCE_SAMPLES)
        weak = stats.count < FULL_EVIDENCE_SAMPLES
        suffix = f" — срез {stats.count} сообщ." if weak else ""

        if stats.ads_ratio >= 0.5:
            points -= 30 * evidence
            reasons.append(f"реклама/мусор в {stats.ads_ratio:.0%} постов среза{suffix}")
        elif stats.ads_ratio >= 0.3:
            points -= 18 * evidence
            reasons.append(f"много рекламы ({stats.ads_ratio:.0%} постов){suffix}")
        elif stats.ads_ratio >= 0.15:
            points -= 8 * evidence
            reasons.append(f"попадается реклама ({stats.ads_ratio:.0%} постов){suffix}")

        for flag in ("scam", "infogypsy"):
            if stats.flag_counts.get(flag, 0) >= 2:
                points -= (20 if flag == "scam" else 12) * evidence
                reasons.append(f"признаки: {CATEGORY_RU[flag]}")

        if stats.posts_per_week is not None:
            if stats.posts_per_week > 70:
                points -= 12
                reasons.append(f"флудит ~{stats.posts_per_week:.0f} постов/нед.")
            elif stats.posts_per_week < 0.5:
                points -= 8
                reasons.append("публикуется реже раза в две недели")

        if stats.forward_ratio >= 0.7:
            points -= 10 * evidence
            reasons.append("почти всё — репосты чужих каналов")
        if stats.avg_length < 40 and stats.url_ratio > 0.6:
            points -= 8 * evidence
            reasons.append("посты — сплошные ссылки без текста")
    elif dialog.triage_action == "sample":
        reasons.append("срез сообщений не собран — оценка только по метаданным")

    # 5. Тип чата
    if dialog.kind in (KIND_GROUP, KIND_SUPERGROUP) and dialog.unread_mentions:
        points += 5
    if dialog.kind == KIND_BOT and age is not None and age > config.stale_days:
        points -= 10
        reasons.append("ботом давно не пользовались")

    score = max(0.0, min(100.0, points))
    bucket = _bucket_for(score, config)

    # Личные переписки — это люди. Скрипт не предлагает их «отписать».
    if dialog.kind == KIND_DM and bucket == BUCKET_DROP:
        bucket = BUCKET_ARCHIVE
        reasons.append("личный чат: максимум в архив, решение за вами")

    return Score(
        dialog_id=dialog.id,
        score=round(score, 1),
        bucket=bucket,
        reasons=reasons,
        language=stats.language,
        topic=stats.topic or detect_topic(dialog.title),
        ads_ratio=round(stats.ads_ratio, 3),
        posts_per_week=round(stats.posts_per_week, 2) if stats.posts_per_week else None,
        scored_at=to_iso(now),
    )


def score_all(
    dialogs: Sequence[Dialog],
    samples_by_dialog: dict[int, list[MessageSample]] | None = None,
    *,
    config: ScoringConfig | None = None,
    now: datetime | None = None,
) -> list[Score]:
    """Скоринг всех чатов + штраф дублям, кроме флагмана каждой группы."""
    config = config or ScoringConfig()
    now = now or utcnow()
    samples_by_dialog = samples_by_dialog or {}

    scores = {
        d.id: score_dialog(d, samples_by_dialog.get(d.id, []), config=config, now=now)
        for d in dialogs
    }
    by_id = {d.id: d for d in dialogs}

    groups = duplicate_groups(dialogs)
    clustered: dict[str, list[int]] = {}
    for dialog_id, key in groups.items():
        clustered.setdefault(key, []).append(dialog_id)

    for key, members in clustered.items():
        if len(members) < 2:
            continue
        # Флагман — лучший балл; при равенстве побеждает тот, по кому есть срез
        # сообщений (есть доказательства пользы), затем более крупный канал.
        flagship = max(
            members,
            key=lambda i: (
                scores[i].score,
                bool(samples_by_dialog.get(i)),
                by_id[i].participants_count or 0,
                -abs(int(i)),
            ),
        )
        topic_name = key.split(":", 1)[1]
        for dialog_id in members:
            score = scores[dialog_id]
            score.duplicate_group = key
            if dialog_id == flagship:
                score.reasons.append(
                    f"флагман темы «{topic_name}» среди {len(members)} похожих — оставить этот"
                )
                continue
            previous_bucket = score.bucket
            score.score = round(max(0.0, score.score - config.duplicate_penalty), 1)
            score.reasons.append(
                f"дубль темы «{topic_name}»: {len(members)} похожих чатов, "
                f"флагман — «{by_id[flagship].title}»"
            )
            new_bucket = _bucket_for(score.score, config)
            # Дублирование само по себе не приговор: полезный, но повторяющийся
            # канал уходит в архив, а не в отписку.
            if new_bucket == BUCKET_DROP and previous_bucket != BUCKET_DROP:
                new_bucket = BUCKET_ARCHIVE
                score.reasons.append("дубль сам по себе не повод удалять — в архив")
            if by_id[dialog_id].kind == KIND_DM and new_bucket == BUCKET_DROP:
                new_bucket = BUCKET_ARCHIVE
            score.bucket = new_bucket

    return [scores[d.id] for d in dialogs]


def summarize(scores: Sequence[Score]) -> dict[str, int]:
    """Сколько чатов в каждой корзине."""
    result = {BUCKET_KEEP: 0, BUCKET_ARCHIVE: 0, BUCKET_DROP: 0}
    for score in scores:
        result[score.bucket] = result.get(score.bucket, 0) + 1
    return result
