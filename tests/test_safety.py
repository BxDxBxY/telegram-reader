"""Протокол безопасности: паузы, FloodWait, бюджет прогона."""

import asyncio
import random
import unittest

from tests.helpers import FakeFloodWaitError
from tgaudit.config import Settings
from tgaudit.safety import (
    Budget,
    BudgetExhausted,
    FloodWaitTooLong,
    Throttle,
    client_kwargs,
    flood_seconds,
    with_flood_retry,
)


class ThrottleTests(unittest.IsolatedAsyncioTestCase):
    async def test_delay_stays_inside_range(self):
        slept: list[float] = []
        throttle = Throttle(
            min_delay=1.5, max_delay=3.5, long_pause_every=0,
            sleep=lambda s: _record(slept, s), rng=random.Random(7),
        )
        for _ in range(20):
            await throttle.wait()
        self.assertTrue(all(1.5 <= value <= 3.5 for value in slept), slept)

    async def test_long_pause_every_n_chats(self):
        slept: list[float] = []
        throttle = Throttle(
            min_delay=1.0, max_delay=2.0, long_pause_every=3,
            long_pause_min=15, long_pause_max=20,
            sleep=lambda s: _record(slept, s), rng=random.Random(1),
        )
        for _ in range(3):
            await throttle.wait()
        self.assertGreaterEqual(slept[-1], 15)


async def _record(bucket: list[float], seconds: float) -> None:
    bucket.append(seconds)


class FloodWaitTests(unittest.IsolatedAsyncioTestCase):
    async def test_waits_exactly_as_requested_and_retries(self):
        slept: list[float] = []
        attempts = {"n": 0}

        async def flaky():
            attempts["n"] += 1
            if attempts["n"] == 1:
                raise FakeFloodWaitError(17)
            return "готово"

        result = await with_flood_retry(
            flaky, sleep=lambda s: _record(slept, s), log=lambda _m: None
        )
        self.assertEqual(result, "готово")
        self.assertEqual(slept, [19])  # 17 секунд + 2 запаса

    async def test_stops_when_wait_is_too_long(self):
        async def blocked():
            raise FakeFloodWaitError(4000)

        with self.assertRaises(FloodWaitTooLong):
            await with_flood_retry(
                blocked, limit=600, sleep=lambda s: asyncio.sleep(0), log=lambda _m: None
            )

    async def test_other_errors_are_not_swallowed(self):
        async def broken():
            raise ValueError("канал приватный")

        with self.assertRaises(ValueError):
            await with_flood_retry(broken, sleep=lambda s: asyncio.sleep(0), log=lambda _m: None)

    async def test_repeated_floods_exhaust_budget(self):
        budget = Budget(max_chats=100, max_flood_waits=1)

        async def always_flooding():
            raise FakeFloodWaitError(5)

        with self.assertRaises(BudgetExhausted):
            await with_flood_retry(
                always_flooding, attempts=5, budget=budget,
                sleep=lambda s: asyncio.sleep(0), log=lambda _m: None,
            )

    def test_flood_seconds_recognises_only_flood_errors(self):
        self.assertEqual(flood_seconds(FakeFloodWaitError(42)), 42)
        self.assertIsNone(flood_seconds(RuntimeError("boom")))


class BudgetTests(unittest.TestCase):
    def test_chat_limit(self):
        budget = Budget(max_chats=2)
        budget.take_chat()
        budget.take_chat()
        with self.assertRaises(BudgetExhausted):
            budget.take_chat()


class ClientKwargsTests(unittest.TestCase):
    def test_device_fields_are_never_empty(self):
        kwargs = client_kwargs(Settings(device_model="", system_version="", app_version=""))
        self.assertTrue(all(kwargs.values()))
        self.assertIn("device_model", kwargs)

    def test_settings_warn_about_aggressive_pauses(self):
        warnings = Settings(min_delay=0.1).safety_warnings()
        self.assertTrue(any("min_delay" in w for w in warnings))


if __name__ == "__main__":
    unittest.main()
