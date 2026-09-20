"""Эвристики этапа 1: триаж, тематика, детекторы мусора, дубли."""

import unittest

from tests.helpers import NOW, days_ago, make_dialog
from tgaudit.heuristics import (
    detect_language,
    detect_topic,
    duplicate_groups,
    is_service_dialog,
    text_flags,
    title_tokens,
    triage_dialog,
)
from tgaudit.models import TRIAGE_DROP, TRIAGE_KEEP, TRIAGE_SAMPLE


class TriageTests(unittest.TestCase):
    def triage(self, dialog, **kwargs):
        return triage_dialog(dialog, now=NOW, **kwargs)

    def test_dead_channel_is_dropped_without_reading(self):
        result = self.triage(make_dialog(last_message_date=days_ago(400).isoformat()))
        self.assertEqual(result.action, TRIAGE_DROP)
        self.assertIn("года", result.reasons[0])

    def test_channel_silent_longer_than_dead_days_is_dropped(self):
        result = self.triage(make_dialog(last_message_date=days_ago(200).isoformat()))
        self.assertEqual(result.action, TRIAGE_DROP)

    def test_live_channel_needs_message_sample(self):
        result = self.triage(make_dialog(last_message_date=days_ago(3).isoformat()))
        self.assertEqual(result.action, TRIAGE_SAMPLE)

    def test_pinned_chat_is_kept_as_is(self):
        result = self.triage(make_dialog(is_pinned=True))
        self.assertEqual(result.action, TRIAGE_KEEP)

    def test_private_chat_is_not_analysed_by_default(self):
        dialog = make_dialog(id=555, kind="dm", last_message_date=days_ago(900).isoformat())
        self.assertEqual(self.triage(dialog).action, TRIAGE_KEEP)
        # ...но по явной просьбе анализируем и его
        self.assertEqual(self.triage(dialog, include_dms=True).action, TRIAGE_DROP)

    def test_service_account_is_untouchable(self):
        dialog = make_dialog(id=777000, kind="dm", title="Telegram")
        self.assertTrue(is_service_dialog(dialog))
        self.assertEqual(self.triage(dialog).action, TRIAGE_KEEP)

    def test_scam_flag_wins_over_activity(self):
        result = self.triage(make_dialog(is_scam=True, last_message_date=days_ago(0).isoformat()))
        self.assertEqual(result.action, TRIAGE_DROP)

    def test_stale_bot_is_dropped(self):
        dialog = make_dialog(id=42, kind="bot", last_message_date=days_ago(120).isoformat())
        self.assertEqual(self.triage(dialog).action, TRIAGE_DROP)

    def test_archived_and_stale_is_dropped(self):
        dialog = make_dialog(is_archived=True, last_message_date=days_ago(120).isoformat())
        self.assertEqual(self.triage(dialog).action, TRIAGE_DROP)

    def test_missing_date_falls_back_to_sampling(self):
        self.assertEqual(self.triage(make_dialog(last_message_date=None)).action, TRIAGE_SAMPLE)

    def test_unread_flood_is_mentioned_in_reasons(self):
        dialog = make_dialog(unread_count=5000, is_muted=True)
        reasons = " ".join(self.triage(dialog).reasons)
        self.assertIn("5000", reasons)


class TextDetectorTests(unittest.TestCase):
    def test_ads_and_infogypsy_detected(self):
        flags = text_flags("Реклама: мой курс со скидкой, промокод, erid: 2Vf")
        self.assertIn("ads", flags)
        self.assertIn("infogypsy", flags)

    def test_scam_detected(self):
        self.assertIn("scam", text_flags("Гарантированный доход без вложений, airdrop"))

    def test_clean_text_has_no_flags(self):
        self.assertEqual(text_flags("Вышел релиз Python 3.14, разбираем изменения"), set())

    def test_topic_matches_word_start_only(self):
        # «Daily» не должно превращаться в AI, «инвестиции» — в «ИИ»
        self.assertEqual(detect_topic("Crypto News Daily"), "crypto")
        self.assertEqual(detect_topic("Инвестиции для всех"), "finance")
        self.assertEqual(detect_topic("AI Weekly"), "ai_ml")
        self.assertIsNone(detect_topic("Методичка по методу"))

    def test_topic_keyword_works_as_stem(self):
        self.assertEqual(detect_topic("Мемы 24/7"), "memes")
        self.assertEqual(detect_topic("Криптовалюты сегодня"), "crypto")

    def test_language_detection(self):
        self.assertEqual(detect_language(["Привет, это длинный русский текст про разработку"]), "ru")
        self.assertEqual(detect_language(["Hello, this is a long english text about code"]), "en")
        self.assertEqual(detect_language(["ok"]), "unknown")

    def test_title_tokens_skip_stopwords_and_emoji(self):
        self.assertEqual(title_tokens("🔥 Новости | Python канал"), {"python"})


class DuplicateTests(unittest.TestCase):
    def test_same_topic_channels_are_grouped(self):
        dialogs = [
            make_dialog(id=1, title="Python News"),
            make_dialog(id=2, title="Питон Дайджест"),
            make_dialog(id=3, title="Садоводство и дача"),
        ]
        groups = duplicate_groups(dialogs)
        self.assertEqual(groups.get(1), "topic:python")
        self.assertEqual(groups.get(2), "topic:python")
        self.assertNotIn(3, groups)

    def test_single_channel_is_not_a_duplicate(self):
        self.assertEqual(duplicate_groups([make_dialog(id=1, title="Python News")]), {})

    def test_private_chats_are_never_duplicates(self):
        dialogs = [
            make_dialog(id=1, kind="dm", title="Иван Петров"),
            make_dialog(id=2, kind="dm", title="Иван Сидоров"),
        ]
        self.assertEqual(duplicate_groups(dialogs), {})

    def test_rare_shared_word_groups_channels(self):
        dialogs = [
            make_dialog(id=1, title="Кружок керамики Восток"),
            make_dialog(id=2, title="Керамика мастерская"),
        ]
        groups = duplicate_groups(dialogs)
        self.assertEqual(len(groups), 2)


if __name__ == "__main__":
    unittest.main()
