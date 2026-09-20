"""Эвристики этапа 1 и текстовые детекторы для этапа 3.

Здесь нет ни Telegram, ни сети — только чистые функции над данными.
Цель этапа 1: отсеять 40–50 % мусора, не прочитав ни одного сообщения.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from typing import Iterable, Sequence

from .models import (
    KIND_BOT,
    KIND_DM,
    TRIAGE_DROP,
    TRIAGE_KEEP,
    TRIAGE_SAMPLE,
    Dialog,
)
from .util import days_since, human_days

# Служебные аккаунты Telegram: коды входа и предупреждения о безопасности.
# Их нельзя ни удалять, ни советовать удалить.
SERVICE_PEER_IDS = {777000, 42777, 4244000, 333000}
SERVICE_USERNAMES = {"telegram", "notifications"}

# ── Словари детекторов ───────────────────────────────────────────────────
# Каждый паттерн — про поведение канала, а не про «плохие слова».
PATTERN_GROUPS: dict[str, tuple[str, ...]] = {
    "ads": (
        r"\bреклам\w*", r"\berid\b", r"\bна прав\w+ реклам", r"\bпартнёрск\w+ материал",
        r"\bпромокод\w*", r"\bскидк\w+\s*\d{2,3}\s*%", r"\bспонсор\w*",
        r"\bsponsored\b", r"\bpromo\s?code\b", r"\bad[s]?\s*:", r"\bреф(?:еральн\w+|ка)\b",
    ),
    "infogypsy": (
        r"\bмарафон\w*", r"\bвебинар\w*", r"\bнаставни\w+", r"\bментор\w*",
        r"\bзакрыт\w+ клуб", r"\bприватн\w+ канал", r"\bмой курс\b", r"\bкурс\w* со скидк",
        r"\bмышлени\w+ миллионер", r"\bденежн\w+ поток", r"\bпассивн\w+ доход",
        r"\bвыйти на \d+ ?[кk]\b", r"\bбесплатн\w+ интенсив",
    ),
    "scam": (
        r"\bгарантирован\w+ (?:доход|прибыл)", r"\bбез вложени", r"\bзаработ\w+ от \d+",
        r"\bairdrop\b", r"\bразда[чю]\w* (?:монет|токен|nft)", r"\bсхем\w+ заработк",
        r"\bинвестиц\w+ (?:от|с) \d+", r"\bумнож\w+ (?:депозит|вклад)", r"\bставк\w+ на спорт",
        r"\bпрогноз\w* на матч", r"\bказино\b", r"\b1win\b", r"\bfree\s?money\b",
        r"\bx\d{2,}\s*(?:за|к)\b",
    ),
    "engagement_bait": (
        r"\bподпиш\w+ на", r"\bжми\w* (?:сюда|на кнопк)", r"\bрепост\w*",
        r"\bучаствуй\b", r"\bрозыгрыш\w*", r"\bконкурс\w*\s*!", r"\bпоставь \S{0,3}?[👍❤🔥]",
        r"\bsubscribe now\b", r"\bjoin (?:now|us)\b",
    ),
    "job_spam": (
        r"\bудал[её]нн\w+ работ\w+ от \d+", r"\bподработк\w+ \d+\s*[кk]?\s*(?:в день|/день)",
        r"\bнужны люди\b", r"\bищем сотрудник\w+ без опыт",
    ),
    "forwarded_noise": (
        r"^forwarded from", r"^переслано из",
    ),
}

COMPILED_PATTERNS: dict[str, list[re.Pattern[str]]] = {
    group: [re.compile(p, re.IGNORECASE | re.UNICODE) for p in patterns]
    for group, patterns in PATTERN_GROUPS.items()
}

# Как называть категории в отчёте.
CATEGORY_RU = {
    "ads": "реклама",
    "infogypsy": "инфоцыганство",
    "scam": "скам/ставки",
    "engagement_bait": "накрутка вовлечения",
    "job_spam": "спам-вакансии",
    "forwarded_noise": "сплошные репосты",
}

# Темы для поиска дублей: 5 каналов про Python — повод оставить один.
TOPIC_KEYWORDS: dict[str, tuple[str, ...]] = {
    "python": ("python", "питон", "django", "fastapi", "pandas"),
    "js_web": ("javascript", "js", "typescript", "react", "vue", "frontend", "фронтенд"),
    "devops": ("devops", "docker", "kubernetes", "k8s", "linux", "sre", "ansible"),
    "ai_ml": ("ai", "ml", "нейросет", "нейронк", "machine learning", "llm", "gpt", "chatgpt",
              "midjourney", "ии"),
    "crypto": ("crypto", "крипт", "bitcoin", "btc", "eth", "web3", "nft", "trading", "трейд"),
    "news": ("news", "новост", "сми", "медиа", "лента", "breaking"),
    "jobs": ("job", "vacanc", "ваканс", "работа", "hiring", "career", "карьер"),
    "design": ("design", "дизайн", "ui", "ux", "figma"),
    "memes": ("мем", "meme", "юмор", "прикол", "смешн"),
    "finance": ("финанс", "инвест", "invest", "акци", "биржа", "econom", "эконом"),
    "games": ("game", "игр", "gaming", "steam", "киберспорт"),
    "study": ("курс", "обучен", "study", "教", "школа", "универ", "教育", "learn"),
}

STOPWORDS = {
    "и", "в", "на", "для", "по", "the", "a", "of", "channel", "канал", "чат", "chat",
    "group", "группа", "official", "официальный", "news", "новости", "|", "-", "—",
    "online", "онлайн", "ru", "rus", "russia", "россия", "tg", "telegram",
}

_TOKEN_RE = re.compile(r"[a-zа-яё0-9_]{3,}", re.IGNORECASE)
_EMOJI_RE = re.compile(
    "[" "\U0001F300-\U0001FAFF" "\U00002600-\U000027BF" "\U0001F1E6-\U0001F1FF" "]+",
    flags=re.UNICODE,
)
_URL_RE = re.compile(r"https?://\S+|t\.me/\S+", re.IGNORECASE)


def normalize_title(title: str | None) -> str:
    """Убирает эмодзи и лишние символы, оставляя сравнимый текст."""
    if not title:
        return ""
    cleaned = _EMOJI_RE.sub(" ", title)
    cleaned = re.sub(r"[^\w\s|/-]", " ", cleaned, flags=re.UNICODE)
    return re.sub(r"\s+", " ", cleaned).strip().lower()


def title_tokens(title: str | None) -> set[str]:
    """Значимые слова названия (без стоп-слов) — основа поиска дублей."""
    return {t for t in _TOKEN_RE.findall(normalize_title(title)) if t not in STOPWORDS}


def _keyword_pattern(keyword: str) -> re.Pattern[str]:
    """Ключ ищется как начало слова, а не как произвольная подстрока.

    Иначе «Daily» превращается в AI, а «инвестиции» — в «ИИ». При этом ключ
    остаётся корнем: «крипт» ловит «криптовалюту», «мем» — «мемы».
    """
    return re.compile(rf"(?<!\w){re.escape(keyword)}", re.IGNORECASE | re.UNICODE)


TOPIC_PATTERNS: dict[str, list[re.Pattern[str]]] = {
    topic: [_keyword_pattern(kw) for kw in keywords]
    for topic, keywords in TOPIC_KEYWORDS.items()
}


def stem_token(token: str, *, keep: int = 6) -> str:
    """Грубая основа слова: «керамики» и «керамика» должны совпасть.

    Полноценный стеммер тут не нужен — задача только сгруппировать похожие
    названия каналов, а ошибки видны в отчёте и правятся глазами.
    """
    return token[:keep] if len(token) > keep else token


def detect_topic(text: str | None) -> str | None:
    """Грубая тематика по ключевым словам названия/сообщений."""
    haystack = normalize_title(text)
    if not haystack:
        return None
    best: tuple[int, str] | None = None
    for topic, patterns in TOPIC_PATTERNS.items():
        hits = sum(1 for pattern in patterns if pattern.search(haystack))
        if hits and (best is None or hits > best[0]):
            best = (hits, topic)
    return best[1] if best else None


def text_flags(text: str | None) -> set[str]:
    """Какие категории мусора сработали на тексте сообщения."""
    if not text:
        return set()
    return {
        group
        for group, patterns in COMPILED_PATTERNS.items()
        if any(p.search(text) for p in patterns)
    }


def count_urls(text: str | None) -> int:
    return len(_URL_RE.findall(text or ""))


def detect_language(texts: Iterable[str]) -> str:
    """Язык по соотношению алфавитов — дёшево и достаточно для сортировки."""
    cyrillic = latin = 0
    for text in texts:
        for char in text or "":
            code = ord(char.lower())
            if 0x0430 <= code <= 0x044F or code == 0x0451:
                cyrillic += 1
            elif 0x61 <= code <= 0x7A:
                latin += 1
    total = cyrillic + latin
    if total < 20:
        return "unknown"
    ratio = cyrillic / total
    if ratio > 0.75:
        return "ru"
    if ratio < 0.25:
        return "en"
    return "mixed"


def is_service_dialog(dialog: Dialog) -> bool:
    """Системные аккаунты Telegram (коды входа, предупреждения)."""
    username = (dialog.username or "").lower()
    return dialog.id in SERVICE_PEER_IDS or username in SERVICE_USERNAMES


# ── Триаж этапа 1 ────────────────────────────────────────────────────────
@dataclass
class TriageResult:
    """Что делать с диалогом дальше и почему."""

    action: str
    reasons: list[str] = field(default_factory=list)


def triage_dialog(
    dialog: Dialog,
    *,
    dead_days: int = 180,
    stale_days: int = 90,
    now: datetime | None = None,
    include_dms: bool = False,
) -> TriageResult:
    """Решение по метаданным: выбросить, оставить или читать логи.

    Выгода этапа: каждый `drop`/`keep` — это минус один поход в API на этапе 2.
    """
    reasons: list[str] = []
    age = days_since(dialog.last_message_date, now)
    age_text = human_days(age)

    if is_service_dialog(dialog):
        return TriageResult(TRIAGE_KEEP, ["служебный аккаунт Telegram — не трогать"])

    if dialog.is_scam or dialog.is_fake:
        flag = "scam" if dialog.is_scam else "fake"
        return TriageResult(TRIAGE_DROP, [f"Telegram пометил чат как {flag}"])

    if dialog.is_pinned:
        return TriageResult(TRIAGE_KEEP, ["закреплён вами — считаем нужным"])

    if dialog.kind == KIND_DM and not include_dms:
        return TriageResult(TRIAGE_KEEP, ["личная переписка — не анализируем содержимое"])

    if age is None:
        reasons.append("нет данных о последней активности")
        return TriageResult(TRIAGE_SAMPLE, reasons)

    if age >= 365:
        return TriageResult(TRIAGE_DROP, [f"молчит больше года ({age_text})"])

    if age >= dead_days:
        return TriageResult(TRIAGE_DROP, [f"мёртвый: активность {age_text}"])

    if dialog.kind == KIND_BOT and age >= stale_days:
        return TriageResult(TRIAGE_DROP, [f"бот без использования {age_text}"])

    if dialog.is_archived and age >= stale_days:
        return TriageResult(
            TRIAGE_DROP, [f"уже в архиве и молчит {age_text} — архив стал свалкой"]
        )

    if dialog.unread_count > 1000 and dialog.is_muted:
        reasons.append(
            f"{dialog.unread_count} непрочитанных при выключенных уведомлениях — "
            f"вы его не читаете"
        )

    if dialog.is_archived:
        reasons.append("в архиве, но ещё живой")

    reasons.append(f"живой ({age_text}) — нужен срез сообщений")
    return TriageResult(TRIAGE_SAMPLE, reasons)


def triage_all(
    dialogs: Sequence[Dialog],
    *,
    dead_days: int = 180,
    stale_days: int = 90,
    now: datetime | None = None,
    include_dms: bool = False,
) -> dict[int, TriageResult]:
    return {
        d.id: triage_dialog(
            d, dead_days=dead_days, stale_days=stale_days, now=now, include_dms=include_dms
        )
        for d in dialogs
    }


# ── Поиск дублей ─────────────────────────────────────────────────────────
def duplicate_groups(dialogs: Sequence[Dialog], *, min_group: int = 2) -> dict[int, str]:
    """Группирует каналы по теме/общему слову в названии.

    Возвращает id -> ключ группы. Личные чаты и боты не группируются:
    два человека с одинаковым именем — не дубликат.
    """
    candidates = [d for d in dialogs if d.kind not in (KIND_DM, KIND_BOT)]

    by_key: dict[str, list[int]] = defaultdict(list)
    assigned: dict[int, str] = {}

    # 1) сильный сигнал — общая тема из словаря
    for dialog in candidates:
        topic = detect_topic(dialog.title)
        if topic:
            by_key[f"topic:{topic}"].append(dialog.id)
            assigned[dialog.id] = f"topic:{topic}"

    # 2) слабый сигнал — редкое общее слово в названии.
    # Сравниваем усечённые основы, иначе «керамики» и «керамика» не совпадут.
    token_index: dict[str, list[int]] = defaultdict(list)
    stem_display: dict[str, str] = {}
    for dialog in candidates:
        if dialog.id in assigned:
            continue
        for token in title_tokens(dialog.title):
            stem = stem_token(token)
            token_index[stem].append(dialog.id)
            if len(token) < len(stem_display.get(stem, token + "x")):
                stem_display[stem] = token

    for stem, ids in token_index.items():
        if len(set(ids)) >= min_group:
            key = f"word:{stem_display.get(stem, stem)}"
            for dialog_id in ids:
                assigned.setdefault(dialog_id, key)
                by_key[key].append(dialog_id)

    return {
        dialog_id: key
        for dialog_id, key in assigned.items()
        if len(set(by_key.get(key, []))) >= min_group
    }
