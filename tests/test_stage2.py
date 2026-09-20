"""Этап 2: последовательность, паузы, обработка ошибок и остановок."""

import tempfile
import unittest
from pathlib import Path

from tests.helpers import FakeClient, FakeFloodWaitError, FakeMessage, make_dialog, no_sleep
from tgaudit.config import Settings
from tgaudit.stage1 import run_triage
from tgaudit.stage2 import estimate_minutes, run_sampling
from tgaudit.storage import Store


class SamplingTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / "db.sqlite")
        self.settings = Settings(sample_limit=5, max_chats_per_run=10, min_delay=0, max_delay=0)
        self.dialogs = [make_dialog(id=-i, title=f"Канал {i}", username=None) for i in (1, 2, 3)]
        self.store.upsert_dialogs(self.dialogs)
        for dialog in self.dialogs:
            self.store.save_triage(dialog.id, "sample", [])

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def _client(self, **kwargs):
        messages = {d.id: [FakeMessage(i, f"пост {i}") for i in range(5)] for d in self.dialogs}
        return FakeClient(messages=messages, **kwargs)

    async def test_all_chats_are_processed_sequentially(self):
        expected_order = [d.id for d in self.store.dialogs_to_sample()]
        client = self._client()
        report = await run_sampling(
            client, self.store, self.settings, log=lambda _m: None, sleep=no_sleep
        )
        self.assertEqual(report.done, 3)
        self.assertEqual(report.messages, 15)
        # Никакой конкурентности: чаты запрашиваются строго по очереди.
        self.assertEqual(client.get_messages_calls, expected_order)

    async def test_second_run_skips_already_sampled(self):
        await run_sampling(self._client(), self.store, self.settings,
                           log=lambda _m: None, sleep=no_sleep)
        again = await run_sampling(self._client(), self.store, self.settings,
                                   log=lambda _m: None, sleep=no_sleep)
        self.assertEqual(again.planned, 0)

    async def test_private_channel_error_is_recorded_and_loop_continues(self):
        second = [d.id for d in self.store.dialogs_to_sample()][1]
        client = self._client(errors={second: RuntimeError("ChannelPrivateError")})
        report = await run_sampling(
            client, self.store, self.settings, log=lambda _m: None, sleep=no_sleep
        )
        self.assertEqual(report.done, 2)
        self.assertEqual(report.failed, 1)
        self.assertIn("ChannelPrivate", self.store.get_dialog(second).sample_error)

    async def test_long_flood_wait_stops_the_run_but_keeps_progress(self):
        first, second, third = [d.id for d in self.store.dialogs_to_sample()]
        client = self._client(errors={second: FakeFloodWaitError(5000)})
        report = await run_sampling(
            client, self.store, self.settings, log=lambda _m: None, sleep=no_sleep
        )
        self.assertEqual(report.done, 1)
        self.assertIsNotNone(report.stopped_reason)
        # Собранное сохранено, до остальных очередь дойдёт при следующем запуске.
        self.assertIsNotNone(self.store.get_dialog(first).sampled_at)
        self.assertIsNone(self.store.get_dialog(third).sampled_at)
        self.assertEqual([d.id for d in self.store.dialogs_to_sample()], [second, third])

    async def test_short_flood_wait_is_survived(self):
        second = [d.id for d in self.store.dialogs_to_sample()][1]
        client = self._client(errors={second: [FakeFloodWaitError(3), None]})
        report = await run_sampling(
            client, self.store, self.settings, log=lambda _m: None, sleep=no_sleep
        )
        self.assertEqual(report.done, 3)

    async def test_run_limit_caps_the_number_of_chats(self):
        report = await run_sampling(
            self._client(), self.store, self.settings, limit=2,
            log=lambda _m: None, sleep=no_sleep,
        )
        self.assertEqual(report.done, 2)

    async def test_pauses_happen_between_chats(self):
        slept: list[float] = []

        async def spy(seconds: float) -> None:
            slept.append(seconds)

        settings = Settings(sample_limit=5, min_delay=1.5, max_delay=3.5, long_pause_every=0)
        await run_sampling(self._client(), self.store, settings, log=lambda _m: None, sleep=spy)
        self.assertEqual(len(slept), 2)  # между тремя чатами — две паузы
        self.assertTrue(all(1.5 <= value <= 3.5 for value in slept), slept)


class TriageIntegrationTests(unittest.TestCase):
    def test_triage_writes_queue_for_stage2(self):
        with tempfile.TemporaryDirectory() as tmp:
            with Store(Path(tmp) / "db.sqlite") as store:
                store.upsert_dialogs([
                    make_dialog(id=1, last_message_date="2020-01-01T00:00:00+00:00"),
                    make_dialog(id=2),
                ])
                counts = run_triage(store, Settings(), log=lambda _m: None)
                self.assertEqual(counts["drop"], 1)
                self.assertEqual([d.id for d in store.dialogs_to_sample()], [2])


class EstimateTests(unittest.TestCase):
    def test_estimate_grows_with_chat_count(self):
        settings = Settings()
        self.assertLess(estimate_minutes(10, settings), estimate_minutes(100, settings))


if __name__ == "__main__":
    unittest.main()
