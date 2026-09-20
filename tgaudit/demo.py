"""Демо-данные: весь конвейер можно посмотреть, не подключаясь к Telegram.

`tgaudit demo` наполняет БД синтетическими чатами — удобно проверить отчёты,
пороги и формат батчей до того, как трогать реальный аккаунт.
"""

from __future__ import annotations

import random
from datetime import timedelta
from typing import Callable

from .models import Dialog, MessageSample
from .storage import Store
from .util import to_iso, utcnow

# (название, тип, дней с последней активности, непрочитано, флаги, тексты постов)
DEMO_CHATS: list[tuple] = [
    ("Python Academy & News", "channel", 2, 1240, {}, [
        "Вышел релиз Python 3.14. Основные фичи и что ломается",
        "Топ-5 библиотек для работы с Asyncio",
        "Реклама: покупайте курсы со скидкой 90%, промокод PY90",
        "Разбор: как устроен GIL в 3.13",
    ]),
    ("Питон Дайджест", "channel", 9, 310, {}, [
        "Дайджест недели: релизы, статьи, вакансии",
        "Гайд по uv и управлению зависимостями",
    ]),
    ("Python Jobs Feed", "channel", 1, 2400, {"muted": True}, [
        "Вакансия: Python-разработчик, 250к, удалёнка",
        "Вакансия: Data Engineer, Москва",
        "Реклама: курс по алгоритмам, скидка 70%",
    ]),
    ("Рабочий чат — платформа", "supergroup", 0, 18, {"pinned": True, "mentions": 3}, [
        "Деплой на прод в 18:00, мержим только хотфиксы",
        "@you посмотри, пожалуйста, ревью",
    ]),
    ("Семья", "dm", 1, 4, {}, ["Купи хлеб", "Во сколько будешь?"]),
    ("Бывший коллега", "dm", 520, 0, {}, ["Ну как ты?"]),
    ("Инвестиции без вложений 💰", "channel", 1, 5400, {"muted": True}, [
        "Гарантированный доход от 50 000 в месяц без вложений",
        "Мой закрытый клуб инвесторов, промокод на вход",
        "Airdrop: раздача токенов, успей забрать",
        "Ставки на спорт: прогноз на матч сегодня",
    ]),
    ("Крипта Сигналы PRO", "channel", 3, 980, {"muted": True}, [
        "BTC: вход от 60к, цель x10",
        "Реклама: 1win бонус на первый депозит",
        "Схема заработка на арбитраже",
    ]),
    ("Crypto News Daily", "channel", 4, 640, {}, [
        "ETF на эфир: что решил регулятор",
        "Отчёт по ончейн-метрикам за неделю",
    ]),
    ("Наставник по мышлению", "channel", 15, 200, {}, [
        "Бесплатный интенсив: выйти на 300к за 3 месяца",
        "Марафон желаний стартует завтра",
        "Мой курс со скидкой только сегодня",
    ]),
    ("Дизайн-кухня", "channel", 30, 120, {}, [
        "Разбор редизайна интерфейса банка",
        "Figma: новые переменные и режимы",
    ]),
    ("UX-чат", "supergroup", 45, 95, {}, [
        "Кто как решает проблему с onboarding?",
        "Поделитесь кейсами исследований",
    ]),
    ("Мемы 24/7", "channel", 0, 9800, {"muted": True}, [
        "мем", "мем 2", "мем 3", "подпишись на второй канал, жми сюда",
    ]),
    ("Старый бот погоды", "bot", 400, 0, {}, ["Погода на завтра: +5"]),
    ("QR-бот", "bot", 700, 0, {}, []),
    ("Новости города", "channel", 220, 3100, {}, ["Пробки на выезде"]),
    ("Вебинары для всех", "channel", 190, 60, {}, ["Вебинар: как начать зарабатывать"]),
    ("Заброшенный чат курса", "supergroup", 380, 45, {}, ["Всем привет!"]),
    ("Telegram", "dm", 5, 1, {"id": 777000}, ["Код для входа: 12345"]),
    ("Архив: чеки и документы", "channel", 150, 0, {"archived": True}, ["скрин чека"]),
    ("DevOps Notes", "channel", 6, 210, {}, [
        "Kubernetes 1.33: что нового в API",
        "Шпаргалка по systemd-юнитам",
    ]),
    ("Linux для людей", "channel", 12, 480, {}, [
        "Настройка systemd-boot за 10 минут",
        "Реклама: VPS со скидкой, промокод",
    ]),
]


def seed_demo(store: Store, *, log: Callable[[str], None] = print, seed: int = 42) -> int:
    """Наполняет БД синтетическими данными (реальный Telegram не трогается)."""
    rng = random.Random(seed)
    now = utcnow()
    dialogs: list[Dialog] = []
    samples: list[MessageSample] = []

    for index, (title, kind, age_days, unread, flags, texts) in enumerate(DEMO_CHATS):
        dialog_id = flags.get("id") or (
            -(1000000000000 + index) if kind in ("channel", "supergroup") else 100000 + index
        )
        last_date = now - timedelta(days=age_days, hours=rng.randint(0, 12))
        dialogs.append(
            Dialog(
                id=dialog_id,
                kind=kind,
                title=title,
                username=f"demo_{index}" if kind == "channel" else None,
                participants_count=rng.randint(500, 90000) if kind != "dm" else None,
                unread_count=unread,
                unread_mentions=flags.get("mentions", 0),
                is_pinned=flags.get("pinned", False),
                is_archived=flags.get("archived", False),
                is_muted=flags.get("muted", False),
                last_message_date=to_iso(last_date),
                last_message_id=1000 + index,
                last_message_preview=texts[0] if texts else "",
                collected_at=to_iso(now),
            )
        )
        for position, text in enumerate(texts):
            samples.append(
                MessageSample(
                    dialog_id=dialog_id,
                    message_id=1000 + index * 100 + position,
                    date=to_iso(last_date - timedelta(days=position * rng.uniform(0.5, 3))),
                    text=text,
                    views=rng.randint(100, 50000) if kind == "channel" else None,
                    collected_at=to_iso(now),
                )
            )

    store.upsert_dialogs(dialogs)
    store.save_samples(samples)
    for dialog in dialogs:
        if any(s.dialog_id == dialog.id for s in samples):
            store.mark_sampled(dialog.id)
    log(f"  демо-данные: {len(dialogs)} чатов, {len(samples)} сообщений")
    return len(dialogs)
