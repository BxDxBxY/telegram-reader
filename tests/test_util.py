"""Утилиты: время, форматирование, обрезка текста."""

import unittest
from datetime import datetime, timezone

from tgaudit.config import Settings, load_env_file
from tgaudit.util import days_since, human_days, human_minutes, one_line, parse_iso, to_iso


class TimeTests(unittest.TestCase):
    def test_naive_datetime_is_treated_as_utc(self):
        parsed = parse_iso("2026-09-20T12:00:00")
        self.assertEqual(parsed.tzinfo, timezone.utc)

    def test_broken_value_is_none(self):
        self.assertIsNone(parse_iso("вчера вечером"))
        self.assertIsNone(parse_iso(None))

    def test_roundtrip(self):
        moment = datetime(2026, 9, 20, 12, 0, tzinfo=timezone.utc)
        self.assertEqual(parse_iso(to_iso(moment)), moment)

    def test_days_since(self):
        now = datetime(2026, 9, 20, tzinfo=timezone.utc)
        self.assertAlmostEqual(days_since("2026-09-13T00:00:00+00:00", now), 7.0)
        self.assertIsNone(days_since(None, now))

    def test_human_days_reads_naturally(self):
        self.assertEqual(human_days(0.5), "сегодня")
        self.assertEqual(human_days(1.2), "вчера")
        self.assertEqual(human_days(5), "5 дн. назад")
        self.assertEqual(human_days(90), "3 мес. назад")
        self.assertEqual(human_days(400), "год назад")
        self.assertEqual(human_days(None), "нет данных")

    def test_human_minutes_never_says_zero(self):
        self.assertEqual(human_minutes(0.4), "меньше минуты")
        self.assertEqual(human_minutes(9.6), "≈10 мин")
        self.assertIn("ч", human_minutes(120))


class TextTests(unittest.TestCase):
    def test_one_line_collapses_whitespace(self):
        self.assertEqual(one_line("раз\n\n   два\tтри"), "раз два три")

    def test_one_line_trims_to_limit(self):
        trimmed = one_line("а" * 500, 50)
        self.assertEqual(len(trimmed), 50)
        self.assertTrue(trimmed.endswith("…"))

    def test_empty_text(self):
        self.assertEqual(one_line(None), "")


class EnvTests(unittest.TestCase):
    def test_missing_env_file_is_not_an_error(self):
        self.assertEqual(load_env_file("нет-такого-файла.env"), {})

    def test_example_env_is_parsed(self):
        settings = Settings.load(".env.example")
        self.assertEqual(settings.session, "sessions/main")
        self.assertEqual(settings.sample_limit, 25)
        self.assertEqual(settings.ai_provider, "none")

    def test_cli_overrides_win_over_env(self):
        settings = Settings.load(".env.example").with_overrides(sample_limit=7, db_path=None)
        self.assertEqual(settings.sample_limit, 7)
        self.assertEqual(settings.db_path, "data/tgaudit.db")


if __name__ == "__main__":
    unittest.main()
