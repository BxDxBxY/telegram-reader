"""Командная строка tgaudit.

    tgaudit login    — один раз создать файл сессии
    tgaudit stage1   — инвентаризация метаданных (+ триаж)
    tgaudit stage2   — срезы сообщений по «сомнительным» чатам
    tgaudit score    — баллы и корзины (опционально с ИИ)
    tgaudit report   — отчёты, таблица, батчи для ручного анализа
    tgaudit run      — все этапы подряд
    tgaudit demo     — весь конвейер на синтетических данных, без Telegram
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path
from typing import Any, Awaitable, Callable

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from . import __version__
from .config import Settings
from .demo import seed_demo
from .models import BUCKETS_RU, TRIAGE_RU
from .report import write_all
from .safety import READ_ONLY_NOTICE, BudgetExhausted, FloodWaitTooLong
from .stage1 import run_inventory, run_triage
from .stage2 import estimate_minutes, run_sampling
from .stage3 import run_scoring
from .storage import Store
from .util import human_minutes


def _log(message: str = "") -> None:
    print(message, flush=True)


def _quiet(_message: str = "") -> None:
    pass


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tgaudit",
        description="Аудит Telegram-аккаунта: инвентаризация, срезы логов, скоринг. Только чтение.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=READ_ONLY_NOTICE,
    )
    parser.add_argument("--version", action="version", version=f"tgaudit {__version__}")
    parser.add_argument("--env", default=".env", help="файл с настройками (по умолчанию .env)")
    parser.add_argument("--db", help="путь к базе (по умолчанию из .env)")
    parser.add_argument("--out", help="каталог отчётов (по умолчанию из .env)")
    parser.add_argument("--session", help="файл сессии без расширения (для нескольких аккаунтов)")
    parser.add_argument("-y", "--yes", action="store_true", help="не спрашивать подтверждение")
    parser.add_argument("-q", "--quiet", action="store_true", help="меньше вывода")

    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("login", help="создать файл сессии (один раз)")

    p1 = sub.add_parser("stage1", help="этап 1: метаданные всех диалогов")
    p1.add_argument("--limit", type=int, help="ограничить число диалогов (для пробы)")
    p1.add_argument("--no-triage", action="store_true", help="не раскладывать на drop/keep/sample")
    p1.add_argument("--include-dms", action="store_true", help="анализировать и личные чаты")

    pt = sub.add_parser("triage", help="пересчитать фильтрацию по БД (без сети)")
    pt.add_argument("--include-dms", action="store_true")
    pt.add_argument("--dead-days", type=int, help="сколько дней тишины считать смертью")

    p2 = sub.add_parser("stage2", help="этап 2: срезы сообщений")
    p2.add_argument("--limit", type=int, help="максимум чатов за прогон")
    p2.add_argument("--sample-limit", type=int, help="сообщений на чат (15–30)")
    p2.add_argument("--include-dms", action="store_true", help="читать и личные переписки")
    p2.add_argument("--resample", action="store_true", help="перечитать уже собранные чаты")

    p3 = sub.add_parser("score", help="этап 3: баллы и корзины")
    p3.add_argument("--ai", dest="ai_provider", choices=["none", "groq", "gemini", "openai-compatible"])
    p3.add_argument("--ai-key", dest="ai_key")
    p3.add_argument("--ai-model", dest="ai_model")

    pr = sub.add_parser("report", help="собрать отчёты и батчи")
    pr.add_argument("--batch-size", type=int, default=20, help="чатов в батче для ИИ (20–30)")
    pr.add_argument("--per-day", type=int, default=25, help="отписок в день в плане")

    pa = sub.add_parser("run", help="все этапы подряд")
    pa.add_argument("--limit", type=int, help="максимум чатов на этапе 2")
    pa.add_argument("--include-dms", action="store_true")
    pa.add_argument("--ai", dest="ai_provider", choices=["none", "groq", "gemini", "openai-compatible"])

    pd = sub.add_parser("demo", help="конвейер на синтетических данных (Telegram не трогается)")
    pd.add_argument("--batch-size", type=int, default=20)

    sub.add_parser("stats", help="что уже лежит в базе")

    return parser


def _settings_from_args(args: argparse.Namespace) -> Settings:
    settings = Settings.load(args.env)
    return settings.with_overrides(
        db_path=getattr(args, "db", None),
        out_dir=getattr(args, "out", None),
        session=getattr(args, "session", None),
        sample_limit=getattr(args, "sample_limit", None),
        dead_days=getattr(args, "dead_days", None),
        ai_provider=getattr(args, "ai_provider", None),
        ai_key=getattr(args, "ai_key", None) or None,
        ai_model=getattr(args, "ai_model", None) or None,
    )


def _confirm(question: str, *, assume_yes: bool) -> bool:
    """Спрашивает подтверждение только у живого терминала."""
    if assume_yes or not sys.stdin.isatty():
        return True
    answer = input(f"{question} [y/N]: ").strip().lower()
    return answer in {"y", "yes", "д", "да"}


def _warn_about_settings(settings: Settings, log: Callable[[str], None]) -> None:
    for warning in settings.safety_warnings():
        log(f"  ⚠ {warning}")


async def _with_client(settings: Settings, action: Callable[[Any], Awaitable[Any]], log) -> Any:
    """Подключается существующей сессией. Повторные логины — путь к заморозке."""
    from .tg import build_client, describe_me

    client = build_client(settings)
    await client.connect()
    try:
        if not await client.is_user_authorized():
            raise RuntimeError(
                f"Сессия «{settings.session}» не авторизована. Выполните `tgaudit login` "
                f"один раз и больше не логиньтесь заново."
            )
        log(f"  аккаунт: {await describe_me(client)}")
        return await action(client)
    finally:
        await client.disconnect()


# ── команды ──────────────────────────────────────────────────────────────
def cmd_login(args: argparse.Namespace, settings: Settings, log) -> int:
    from .tg import build_client, describe_me

    problems = settings.validate_credentials()
    if problems:
        log("Не хватает данных для входа:")
        for problem in problems:
            log(f"  - {problem}")
        log("Скопируйте .env.example в .env и заполните TG_API_ID/TG_API_HASH.")
        return 2

    settings.ensure_dirs(session=True)

    session_file = Path(f"{settings.session}.session")
    if session_file.exists():
        log(f"Сессия уже есть: {session_file}. Повторный вход не нужен.")

    async def _run() -> int:
        client = build_client(settings)
        async with client:
            log(f"Готово. Вы вошли как {await describe_me(client)}")
            log(f"Файл сессии: {session_file} — храните локально, в git он не попадёт.")
        return 0

    return asyncio.run(_run())


def cmd_stage1(args: argparse.Namespace, settings: Settings, log) -> int:
    settings.ensure_dirs()
    with Store(settings.db_path) as store:

        async def action(client):
            return await run_inventory(client, store, settings, limit=args.limit, log=log)

        asyncio.run(_with_client(settings, action, log))
        if not args.no_triage:
            run_triage(store, settings, include_dms=args.include_dms, log=log)
    return 0


def cmd_triage(args: argparse.Namespace, settings: Settings, log) -> int:
    with Store(settings.db_path) as store:
        run_triage(store, settings, include_dms=args.include_dms, log=log)
    return 0


def cmd_stage2(args: argparse.Namespace, settings: Settings, log) -> int:
    settings.ensure_dirs()
    with Store(settings.db_path) as store:
        queue = store.dialogs_to_sample(
            limit=args.limit or settings.max_chats_per_run,
            include_dms=args.include_dms,
            resample=args.resample,
        )
        if not queue:
            log("Очередь пуста: сначала `tgaudit stage1`, затем `tgaudit triage`.")
            return 0
        log(
            f"К выгрузке: {len(queue)} чатов × {settings.sample_limit} сообщений, "
            f"{human_minutes(estimate_minutes(len(queue), settings))} с безопасными паузами."
        )
        _warn_about_settings(settings, log)
        if not _confirm("Начинать?", assume_yes=args.yes):
            log("Отменено.")
            return 1

        async def action(client):
            return await run_sampling(
                client,
                store,
                settings,
                limit=args.limit,
                include_dms=args.include_dms,
                resample=args.resample,
                log=log,
            )

        asyncio.run(_with_client(settings, action, log))
    return 0


def cmd_score(args: argparse.Namespace, settings: Settings, log) -> int:
    with Store(settings.db_path) as store:
        run_scoring(store, settings, log=log)
    return 0


def cmd_report(args: argparse.Namespace, settings: Settings, log) -> int:
    settings.ensure_dirs()
    with Store(settings.db_path) as store:
        records = store.records()
        if not records:
            log("В базе пусто — начните с `tgaudit stage1` или посмотрите `tgaudit demo`.")
            return 1
        written = write_all(
            records, settings.out_dir, batch_size=args.batch_size, per_day=args.per_day
        )
    _print_written(written, log)
    return 0


def cmd_run(args: argparse.Namespace, settings: Settings, log) -> int:
    settings.ensure_dirs()
    log("Полный прогон: этап 1 → фильтрация → этап 2 → скоринг → отчёты\n")
    with Store(settings.db_path) as store:

        async def inventory(client):
            return await run_inventory(client, store, settings, log=log)

        asyncio.run(_with_client(settings, inventory, log))
        run_triage(store, settings, include_dms=args.include_dms, log=log)

        queue = store.dialogs_to_sample(
            limit=args.limit or settings.max_chats_per_run, include_dms=args.include_dms
        )
        log("")
        log(
            f"Этап 2 затронет {len(queue)} чатов, "
            f"{human_minutes(estimate_minutes(len(queue), settings))}."
        )
        _warn_about_settings(settings, log)
        if queue and _confirm("Продолжать этап 2?", assume_yes=args.yes):

            async def sampling(client):
                return await run_sampling(
                    client,
                    store,
                    settings,
                    limit=args.limit,
                    include_dms=args.include_dms,
                    log=log,
                )

            asyncio.run(_with_client(settings, sampling, log))
        else:
            log("Этап 2 пропущен — скоринг пойдёт только по метаданным.")

        log("")
        run_scoring(store, settings, log=log)
        written = write_all(store.records(), settings.out_dir)
    _print_written(written, log)
    return 0


def cmd_demo(args: argparse.Namespace, settings: Settings, log) -> int:
    settings.ensure_dirs()
    log("Демо-режим: реальный Telegram не используется.\n")
    with Store(settings.db_path) as store:
        seed_demo(store, log=log)
        run_triage(store, settings, log=log)
        log("")
        run_scoring(store, settings, use_ai=False, log=log)
        written = write_all(store.records(), settings.out_dir, batch_size=args.batch_size)
    _print_written(written, log)
    return 0


def cmd_stats(args: argparse.Namespace, settings: Settings, log) -> int:
    with Store(settings.db_path) as store:
        stats = store.stats()
        last_inventory = store.get_meta("last_stage1_at")
    log(f"База: {stats['db_path']}")
    if last_inventory:
        log(f"  последняя инвентаризация: {last_inventory}")
    log(f"  диалогов: {stats['dialogs']}, со срезами: {stats['sampled']}, "
        f"сообщений: {stats['messages']}, оценено: {stats['scored']}")
    if stats["by_kind"]:
        log("  по типам:   " + ", ".join(f"{k}={v}" for k, v in sorted(stats["by_kind"].items())))
    if stats["by_triage"]:
        log("  фильтрация: " + ", ".join(
            f"{TRIAGE_RU.get(k, k)}={v}" for k, v in sorted(stats["by_triage"].items())))
    if stats["by_bucket"]:
        log("  корзины:    " + ", ".join(
            f"{BUCKETS_RU.get(k, k)}={v}" for k, v in sorted(stats["by_bucket"].items())))
    return 0


def _print_written(written: dict[str, Path], log) -> None:
    log("")
    log("Готово. Файлы отчёта:")
    for key in ("report", "csv", "jsonl", "plan"):
        if key in written:
            log(f"  {written[key]}")
    batches = [p for k, p in written.items() if k.startswith("batch_")]
    if batches:
        log(f"  {batches[0].parent}/ — {len(batches)} батч(ей) для ручной загрузки в ИИ")


COMMANDS: dict[str, Callable[..., int]] = {
    "login": cmd_login,
    "stage1": cmd_stage1,
    "triage": cmd_triage,
    "stage2": cmd_stage2,
    "score": cmd_score,
    "report": cmd_report,
    "run": cmd_run,
    "demo": cmd_demo,
    "stats": cmd_stats,
}


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    settings = _settings_from_args(args)
    log = _quiet if args.quiet else _log
    handler = COMMANDS[args.command]
    try:
        return handler(args, settings, log)
    except (FloodWaitTooLong, BudgetExhausted) as exc:
        _log(f"\n⏹ {exc}")
        return 3
    except KeyboardInterrupt:
        _log("\nПрервано. Прогресс сохранён в БД — продолжите той же командой.")
        return 130
    except RuntimeError as exc:
        _log(f"\nОшибка: {exc}")
        return 2


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
