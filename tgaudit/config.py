"""Настройки проекта: .env + переменные окружения + флаги CLI.

Свой мини-парсер .env, чтобы не тащить python-dotenv ради двадцати строк.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field, replace
from pathlib import Path

DEFAULT_ENV_FILE = ".env"


def load_env_file(path: str | Path = DEFAULT_ENV_FILE) -> dict[str, str]:
    """Читает KEY=VALUE из .env. Отсутствующий файл — не ошибка."""
    env_path = Path(path)
    if not env_path.is_file():
        return {}
    values: dict[str, str] = {}
    for raw in env_path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        values[key.strip()] = value
    return values


def _get(env: dict[str, str], key: str, default: str = "") -> str:
    """Приоритет: реальное окружение > .env > значение по умолчанию."""
    return os.environ.get(key) or env.get(key) or default


def _get_int(env: dict[str, str], key: str, default: int) -> int:
    try:
        return int(float(_get(env, key, str(default))))
    except ValueError:
        return default


def _get_float(env: dict[str, str], key: str, default: float) -> float:
    try:
        return float(_get(env, key, str(default)))
    except ValueError:
        return default


def _get_bool(env: dict[str, str], key: str, default: bool = False) -> bool:
    raw = _get(env, key, "1" if default else "0").strip().lower()
    return raw in {"1", "true", "yes", "y", "on", "да"}


@dataclass
class Settings:
    """Полная конфигурация прогона."""

    # Доступ
    api_id: int | None = None
    api_hash: str | None = None
    session: str = "sessions/main"

    # Маскировка под официальный клиент
    device_model: str = "Desktop PC"
    system_version: str = "Linux 6.x"
    app_version: str = "5.0.1"
    lang_code: str = "ru"
    system_lang_code: str = "ru"

    # Бережный режим
    min_delay: float = 1.5
    max_delay: float = 3.5
    long_pause_every: int = 25
    long_pause_min: float = 15.0
    long_pause_max: float = 40.0
    sample_limit: int = 25
    max_chats_per_run: int = 150
    flood_wait_limit: int = 600

    # Пороги эвристики
    dead_days: int = 180
    stale_days: int = 90

    # Пути
    db_path: str = "data/tgaudit.db"
    out_dir: str = "out"

    # ИИ (необязательно)
    ai_provider: str = "none"
    ai_key: str = ""
    ai_model: str = ""
    ai_base_url: str = ""
    ai_include_dms: bool = False
    ai_batch_size: int = 15

    source_env: dict[str, str] = field(default_factory=dict, repr=False)

    @classmethod
    def load(cls, env_file: str | Path = DEFAULT_ENV_FILE) -> "Settings":
        env = load_env_file(env_file)
        api_id_raw = _get(env, "TG_API_ID")
        return cls(
            api_id=int(api_id_raw) if api_id_raw.isdigit() else None,
            api_hash=_get(env, "TG_API_HASH") or None,
            session=_get(env, "TG_SESSION", "sessions/main"),
            device_model=_get(env, "TG_DEVICE_MODEL", "Desktop PC"),
            system_version=_get(env, "TG_SYSTEM_VERSION", "Linux 6.x"),
            app_version=_get(env, "TG_APP_VERSION", "5.0.1"),
            lang_code=_get(env, "TG_LANG_CODE", "ru"),
            system_lang_code=_get(env, "TG_SYSTEM_LANG_CODE", "ru"),
            min_delay=_get_float(env, "TGAUDIT_MIN_DELAY", 1.5),
            max_delay=_get_float(env, "TGAUDIT_MAX_DELAY", 3.5),
            long_pause_every=_get_int(env, "TGAUDIT_LONG_PAUSE_EVERY", 25),
            long_pause_min=_get_float(env, "TGAUDIT_LONG_PAUSE_MIN", 15.0),
            long_pause_max=_get_float(env, "TGAUDIT_LONG_PAUSE_MAX", 40.0),
            sample_limit=_get_int(env, "TGAUDIT_SAMPLE_LIMIT", 25),
            max_chats_per_run=_get_int(env, "TGAUDIT_MAX_CHATS_PER_RUN", 150),
            flood_wait_limit=_get_int(env, "TGAUDIT_FLOOD_WAIT_LIMIT", 600),
            dead_days=_get_int(env, "TGAUDIT_DEAD_DAYS", 180),
            stale_days=_get_int(env, "TGAUDIT_STALE_DAYS", 90),
            db_path=_get(env, "TGAUDIT_DB", "data/tgaudit.db"),
            out_dir=_get(env, "TGAUDIT_OUT", "out"),
            ai_provider=_get(env, "TGAUDIT_AI_PROVIDER", "none").lower(),
            ai_key=_get(env, "TGAUDIT_AI_KEY"),
            ai_model=_get(env, "TGAUDIT_AI_MODEL"),
            ai_base_url=_get(env, "TGAUDIT_AI_BASE_URL"),
            ai_include_dms=_get_bool(env, "TGAUDIT_AI_INCLUDE_DMS", False),
            ai_batch_size=_get_int(env, "TGAUDIT_AI_BATCH_SIZE", 15),
            source_env=env,
        )

    def with_overrides(self, **kwargs) -> "Settings":
        """Копия настроек с переопределениями (флаги CLI важнее .env)."""
        clean = {k: v for k, v in kwargs.items() if v is not None}
        return replace(self, **clean) if clean else self

    def validate_credentials(self) -> list[str]:
        """Список проблем, мешающих подключиться к Telegram."""
        problems: list[str] = []
        if not self.api_id:
            problems.append("TG_API_ID не задан (my.telegram.org -> API development tools)")
        if not self.api_hash:
            problems.append("TG_API_HASH не задан")
        return problems

    def safety_warnings(self) -> list[str]:
        """Предупреждения про слишком агрессивные настройки — до похода в API."""
        warnings: list[str] = []
        if self.min_delay < 1.0:
            warnings.append(
                f"min_delay={self.min_delay}с — слишком быстро; безопасный минимум 1.0–1.5с"
            )
        if self.max_delay < self.min_delay:
            warnings.append("max_delay меньше min_delay — паузы будут некорректными")
        if self.sample_limit > 100:
            warnings.append(
                f"sample_limit={self.sample_limit}: для оценки темы хватает 15–30 сообщений"
            )
        if self.max_chats_per_run > 400:
            warnings.append(
                f"max_chats_per_run={self.max_chats_per_run}: разбейте обход на несколько дней"
            )
        return warnings

    def ensure_dirs(self, *, session: bool = False) -> None:
        """Создаёт каталоги под БД и отчёты; каталог сессии — только при логине."""
        paths = [Path(self.db_path).parent, Path(self.out_dir)]
        if session:
            paths.append(Path(self.session).parent)
        for path in paths:
            if str(path) not in ("", "."):
                path.mkdir(parents=True, exist_ok=True)
