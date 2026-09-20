"""Скоринг: баллы, корзины, штрафы за дубли, защита личных чатов."""

import unittest

from tests.helpers import NOW, days_ago, make_dialog, make_samples
from tgaudit.models import BUCKET_ARCHIVE, BUCKET_DROP, BUCKET_KEEP
from tgaudit.scoring import ScoringConfig, analyze_samples, score_all, score_dialog, summarize

ADS = ["Реклама: курс со скидкой 90%, промокод"] * 10
CLEAN = ["Разбор нового релиза и бенчмарки"] * 10


class ScoreDialogTests(unittest.TestCase):
    def score(self, dialog, samples=(), **kwargs):
        return score_dialog(dialog, samples, now=NOW, **kwargs)

    def test_pinned_working_chat_is_kept(self):
        dialog = make_dialog(kind="supergroup", is_pinned=True, unread_mentions=2)
        self.assertEqual(self.score(dialog).bucket, BUCKET_KEEP)

    def test_dead_channel_goes_to_unsubscribe(self):
        dialog = make_dialog(last_message_date=days_ago(400).isoformat())
        self.assertEqual(self.score(dialog).bucket, BUCKET_DROP)

    def test_ad_heavy_channel_loses_points(self):
        dialog = make_dialog(unread_count=2000, is_muted=True)
        spammy = self.score(dialog, make_samples(dialog.id, ADS))
        clean = self.score(dialog, make_samples(dialog.id, CLEAN))
        self.assertLess(spammy.score, clean.score)
        self.assertEqual(spammy.bucket, BUCKET_DROP)

    def test_small_sample_penalises_less_than_large_one(self):
        """Два сообщения — не приговор: штраф масштабируется размером среза."""
        dialog = make_dialog()
        tiny = self.score(dialog, make_samples(dialog.id, ADS[:2]))
        full = self.score(dialog, make_samples(dialog.id, ADS))
        self.assertGreater(tiny.score, full.score)

    def test_private_chat_never_lands_in_unsubscribe(self):
        dialog = make_dialog(id=500, kind="dm", last_message_date=days_ago(900).isoformat())
        result = self.score(dialog)
        self.assertEqual(result.bucket, BUCKET_ARCHIVE)
        self.assertTrue(any("личный чат" in r for r in result.reasons))

    def test_service_account_is_always_kept(self):
        result = self.score(make_dialog(id=777000, kind="dm", title="Telegram"))
        self.assertEqual(result.bucket, BUCKET_KEEP)
        self.assertEqual(result.score, 100.0)

    def test_scam_flag_sinks_the_score(self):
        flagged = self.score(make_dialog(is_scam=True))
        normal = self.score(make_dialog())
        self.assertLess(flagged.score, normal.score - 40)

    def test_reasons_are_human_readable(self):
        result = self.score(make_dialog(unread_count=1500))
        self.assertTrue(result.reasons)
        self.assertTrue(all(isinstance(r, str) and r for r in result.reasons))

    def test_score_is_bounded(self):
        best = self.score(make_dialog(is_pinned=True, unread_mentions=9, is_verified=True))
        worst = self.score(
            make_dialog(is_scam=True, is_muted=True, unread_count=99999,
                        last_message_date=days_ago(1000).isoformat()),
            make_samples(-1001, ADS),
        )
        self.assertLessEqual(best.score, 100.0)
        self.assertGreaterEqual(worst.score, 0.0)


class SampleStatsTests(unittest.TestCase):
    def test_empty_samples(self):
        stats = analyze_samples([])
        self.assertEqual(stats.count, 0)
        self.assertEqual(stats.ads_ratio, 0.0)

    def test_ads_ratio_and_frequency(self):
        samples = make_samples(-1, ADS[:5] + CLEAN[:5])
        stats = analyze_samples(samples)
        self.assertEqual(stats.count, 10)
        self.assertAlmostEqual(stats.ads_ratio, 0.5)
        self.assertIsNotNone(stats.posts_per_week)
        self.assertEqual(stats.language, "ru")


class DuplicateScoringTests(unittest.TestCase):
    def test_flagship_survives_and_duplicate_is_penalised(self):
        dialogs = [
            make_dialog(id=1, title="Python Daily", last_message_date=days_ago(1).isoformat()),
            make_dialog(id=2, title="Питон каждый день",
                        last_message_date=days_ago(40).isoformat()),
        ]
        scores = {s.dialog_id: s for s in score_all(dialogs, {}, now=NOW)}
        self.assertGreater(scores[1].score, scores[2].score)
        self.assertEqual(scores[1].duplicate_group, "topic:python")
        self.assertTrue(any("флагман" in r for r in scores[1].reasons))
        self.assertTrue(any("дубль" in r for r in scores[2].reasons))

    def test_duplicate_penalty_alone_does_not_cause_unsubscribe(self):
        dialogs = [
            make_dialog(id=1, title="Python Daily"),
            make_dialog(id=2, title="Питон каждый день", unread_count=600),
        ]
        scores = {s.dialog_id: s for s in score_all(dialogs, {}, now=NOW)}
        self.assertNotEqual(scores[2].bucket, BUCKET_DROP)

    def test_summarize_counts_buckets(self):
        dialogs = [
            make_dialog(id=1, is_pinned=True),
            make_dialog(id=2, last_message_date=days_ago(900).isoformat()),
        ]
        counts = summarize(score_all(dialogs, {}, now=NOW))
        self.assertEqual(counts[BUCKET_KEEP], 1)
        self.assertEqual(counts[BUCKET_DROP], 1)


class ConfigTests(unittest.TestCase):
    def test_thresholds_are_configurable(self):
        dialog = make_dialog(last_message_date=days_ago(100).isoformat())
        strict = score_dialog(dialog, now=NOW, config=ScoringConfig(keep_threshold=10))
        lenient = score_dialog(dialog, now=NOW, config=ScoringConfig(keep_threshold=99))
        self.assertEqual(strict.bucket, BUCKET_KEEP)
        self.assertNotEqual(lenient.bucket, BUCKET_KEEP)


if __name__ == "__main__":
    unittest.main()
