"""Фейковые объекты Telethon и фабрики данных для тестов."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from tgaudit.models import Dialog, MessageSample

NOW = datetime(2026, 9, 20, 12, 0, tzinfo=timezone.utc)


def days_ago(days: float) -> datetime:
    return NOW - timedelta(days=days)


def make_dialog(**kwargs) -> Dialog:
    defaults = dict(
        id=-1001,
        kind="channel",
        title="Тестовый канал",
        last_message_date=days_ago(1).isoformat(),
    )
    defaults.update(kwargs)
    return Dialog(**defaults)


def make_samples(dialog_id: int, texts, *, start_days: float = 1.0) -> list[MessageSample]:
    return [
        MessageSample(
            dialog_id=dialog_id,
            message_id=100 + index,
            date=days_ago(start_days + index).isoformat(),
            text=text,
        )
        for index, text in enumerate(texts)
    ]


# ── фейковый Telethon ────────────────────────────────────────────────────
class FakeUser:
    def __init__(self, bot: bool = False, username: str | None = None, **kwargs):
        self.bot = bot
        self.username = username
        self.__dict__.update(kwargs)


class FakeChannel:
    def __init__(self, megagroup: bool = False, **kwargs):
        self.megagroup = megagroup
        self.gigagroup = False
        self.username = kwargs.pop("username", None)
        self.verified = kwargs.pop("verified", False)
        self.scam = kwargs.pop("scam", False)
        self.fake = kwargs.pop("fake", False)
        self.participants_count = kwargs.pop("participants_count", None)
        self.__dict__.update(kwargs)


class FakeChat:
    pass


# Telethon различает сущности по классам User/Chat/Channel — фейки называются
# так же, иначе тесты проверяли бы не тот код, что работает в проде.
FakeUser.__name__ = "User"
FakeChannel.__name__ = "Channel"
FakeChat.__name__ = "Chat"


class FakeNotifySettings:
    def __init__(self, mute_until=None, silent=False):
        self.mute_until = mute_until
        self.silent = silent


class FakeRawDialog:
    def __init__(self, notify_settings=None):
        self.notify_settings = notify_settings or FakeNotifySettings()


class FakeMessage:
    def __init__(self, id: int, message: str = "", date=None, media=None, action=None):
        self.id = id
        self.message = message
        self.date = date or NOW
        self.media = media
        self.action = action
        self.views = 1000
        self.forwards = 5
        self.fwd_from = None


class FakeDialog:
    """Повторяет интерфейс telethon.tl.custom.Dialog в объёме, который читает tgaudit."""

    def __init__(
        self,
        id: int,
        name: str = "Канал",
        entity=None,
        unread_count: int = 0,
        pinned: bool = False,
        archived: bool = False,
        muted: bool = False,
        date=None,
        message=None,
    ):
        self.id = id
        self.name = self.title = name
        self.entity = entity if entity is not None else FakeChannel()
        self.unread_count = unread_count
        self.unread_mentions_count = 0
        self.pinned = pinned
        self.archived = archived
        self.date = date or NOW
        self.message = message or FakeMessage(1, "последний пост", self.date)
        # mute_until сравнивается с реальным utcnow(), а не с фиксированным NOW —
        # иначе тест «протухает», когда NOW + 30 дней остаётся в прошлом.
        mute_until = datetime.now(timezone.utc) + timedelta(days=30) if muted else None
        self.dialog = FakeRawDialog(FakeNotifySettings(mute_until=mute_until))


class FakeFloodWaitError(Exception):
    """Имитация telethon.errors.FloodWaitError (распознаётся по имени класса)."""

    def __init__(self, seconds: int):
        super().__init__(f"flood wait {seconds}")
        self.seconds = seconds


FakeFloodWaitError.__name__ = "FloodWaitError"


class FakeClient:
    """Клиент, который отдаёт заготовленные диалоги и сообщения."""

    def __init__(self, dialogs=None, messages=None, errors=None):
        self._dialogs = dialogs or []
        self._messages = messages or {}
        self._errors = errors or {}
        self.get_messages_calls: list[int] = []

    def iter_dialogs(self, limit=None):
        items = self._dialogs[:limit] if limit else self._dialogs

        async def generator():
            for item in items:
                yield item

        return generator()

    async def get_input_entity(self, peer):
        return ("input", peer)

    async def get_messages(self, peer, limit=25):
        key = peer[1] if isinstance(peer, tuple) else peer
        dialog_id = key if isinstance(key, int) else key
        self.get_messages_calls.append(dialog_id)
        error = self._errors.get(dialog_id)
        if error is not None:
            if isinstance(error, list):
                raised = error.pop(0)
                if raised is not None:
                    raise raised
            else:
                raise error
        return self._messages.get(dialog_id, [])[:limit]


async def no_sleep(_seconds: float) -> None:
    """Заменяет asyncio.sleep в тестах: паузы проверяем, но не ждём."""
    return None
