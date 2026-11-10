"""Слой Telegram: классификация сущностей и преобразование объектов."""

import unittest
from datetime import datetime, timedelta, timezone

from tests.helpers import (
    NOW,
    FakeChannel,
    FakeChat,
    FakeClient,
    FakeDialog,
    FakeMessage,
    FakeNotifySettings,
    FakeRawDialog,
    FakeUser,
    no_sleep,
)
from tgaudit.models import KIND_BOT, KIND_CHANNEL, KIND_DM, KIND_GROUP, KIND_SUPERGROUP
from tgaudit.tg import (
    classify_entity,
    collect_dialogs,
    dialog_to_record,
    fetch_samples,
    is_muted,
    message_to_sample,
)


class ClassifyTests(unittest.TestCase):
    def test_all_entity_kinds(self):
        self.assertEqual(classify_entity(FakeUser()), KIND_DM)
        self.assertEqual(classify_entity(FakeUser(bot=True)), KIND_BOT)
        self.assertEqual(classify_entity(FakeChannel()), KIND_CHANNEL)
        self.assertEqual(classify_entity(FakeChannel(megagroup=True)), KIND_SUPERGROUP)
        self.assertEqual(classify_entity(FakeChat()), KIND_GROUP)
        self.assertEqual(classify_entity(None), "unknown")


class MuteTests(unittest.TestCase):
    def test_future_mute_until_means_muted(self):
        dialog = type("D", (), {})()
        dialog.dialog = FakeRawDialog(FakeNotifySettings(mute_until=datetime.now(timezone.utc) + timedelta(days=365)))
        self.assertTrue(is_muted(dialog))

    def test_no_notify_settings_means_not_muted(self):
        self.assertFalse(is_muted(type("D", (), {"dialog": None})()))


class MappingTests(unittest.TestCase):
    def test_dialog_fields_are_mapped(self):
        entity = FakeChannel(username="pynews", verified=True, participants_count=4200)
        source = FakeDialog(-1001, "Python News", entity=entity, unread_count=1240, muted=True)
        record = dialog_to_record(source)

        self.assertEqual(record.id, -1001)
        self.assertEqual(record.kind, KIND_CHANNEL)
        self.assertEqual(record.title, "Python News")
        self.assertEqual(record.username, "pynews")
        self.assertEqual(record.unread_count, 1240)
        self.assertEqual(record.participants_count, 4200)
        self.assertTrue(record.is_muted)
        self.assertTrue(record.is_verified)
        self.assertTrue(record.last_message_date.startswith("2026-09-20"))

    def test_preview_is_trimmed_to_one_line(self):
        message = FakeMessage(1, "первая строка\n\n   вторая строка")
        record = dialog_to_record(FakeDialog(-1, "Канал", message=message))
        self.assertEqual(record.last_message_preview, "первая строка вторая строка")

    def test_message_sample_counts_links_and_media(self):
        media = type("MessageMediaPhoto", (), {})()
        message = FakeMessage(9, "смотри https://t.me/x и http://y.z", media=media)
        sample = message_to_sample(-1, message)
        self.assertEqual(sample.url_count, 2)
        self.assertTrue(sample.has_media)
        self.assertEqual(sample.media_type, "photo")
        self.assertFalse(sample.is_service)

    def test_service_message_is_marked(self):
        message = FakeMessage(9, "", action=object())
        self.assertTrue(message_to_sample(-1, message).is_service)

    def test_long_text_is_trimmed(self):
        sample = message_to_sample(-1, FakeMessage(1, "а" * 1000), text_limit=100)
        self.assertLessEqual(len(sample.text), 100)


class CollectorTests(unittest.IsolatedAsyncioTestCase):
    async def test_collect_dialogs_reads_every_dialog_once(self):
        client = FakeClient(dialogs=[FakeDialog(-i, f"Канал {i}") for i in range(1, 4)])
        records = await collect_dialogs(client, log=lambda _m: None, sleep=no_sleep)
        self.assertEqual([r.id for r in records], [-1, -2, -3])

    async def test_fetch_samples_limits_messages(self):
        messages = [FakeMessage(i, f"пост {i}") for i in range(10)]
        client = FakeClient(messages={-1: messages})
        from tests.helpers import make_dialog

        samples = await fetch_samples(
            client, make_dialog(id=-1, username=None), limit=3, log=lambda _m: None, sleep=no_sleep
        )
        self.assertEqual(len(samples), 3)
        self.assertTrue(all(s.dialog_id == -1 for s in samples))


if __name__ == "__main__":
    unittest.main()
