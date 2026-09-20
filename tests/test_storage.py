"""Хранилище: апсерты, очередь этапа 2, устойчивость к перезапускам."""

import tempfile
import unittest
from pathlib import Path

from tests.helpers import make_dialog, make_samples
from tgaudit.models import Score
from tgaudit.storage import Store


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / "test.db")

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_upsert_is_idempotent(self):
        dialog = make_dialog(id=1)
        self.store.upsert_dialogs([dialog])
        self.store.upsert_dialogs([dialog])
        self.assertEqual(self.store.count_dialogs(), 1)

    def test_repeated_inventory_keeps_triage_and_samples(self):
        """Повторный этап 1 обновляет метаданные, но не стирает работу этапа 2."""
        self.store.upsert_dialogs([make_dialog(id=1, title="Старое имя")])
        self.store.save_triage(1, "sample", ["нужен срез"])
        self.store.save_samples(make_samples(1, ["привет"]))
        self.store.mark_sampled(1)

        self.store.upsert_dialogs([make_dialog(id=1, title="Новое имя")])

        dialog = self.store.get_dialog(1)
        self.assertEqual(dialog.title, "Новое имя")
        self.assertEqual(dialog.triage_action, "sample")
        self.assertEqual(dialog.triage_reasons, ["нужен срез"])
        self.assertIsNotNone(dialog.sampled_at)

    def test_sampling_queue_skips_done_and_private(self):
        self.store.upsert_dialogs([
            make_dialog(id=1),
            make_dialog(id=2),
            make_dialog(id=3, kind="dm"),
        ])
        for dialog_id in (1, 2, 3):
            self.store.save_triage(dialog_id, "sample", [])
        self.store.mark_sampled(1)

        queue = [d.id for d in self.store.dialogs_to_sample()]
        self.assertEqual(queue, [2])
        self.assertIn(3, [d.id for d in self.store.dialogs_to_sample(include_dms=True)])
        self.assertIn(1, [d.id for d in self.store.dialogs_to_sample(resample=True)])

    def test_queue_respects_limit(self):
        self.store.upsert_dialogs([make_dialog(id=i) for i in range(1, 6)])
        for i in range(1, 6):
            self.store.save_triage(i, "sample", [])
        self.assertEqual(len(self.store.dialogs_to_sample(limit=2)), 2)

    def test_samples_and_scores_roundtrip(self):
        self.store.upsert_dialogs([make_dialog(id=1)])
        self.store.save_samples(make_samples(1, ["раз", "два"]))
        self.store.save_scores([Score(dialog_id=1, score=73.5, bucket="keep", reasons=["ок"])])

        record = self.store.records()[0]
        self.assertEqual(len(record.samples), 2)
        self.assertEqual(record.score.score, 73.5)
        self.assertEqual(record.score.reasons, ["ок"])

    def test_sample_error_is_recorded(self):
        self.store.upsert_dialogs([make_dialog(id=1)])
        self.store.mark_sampled(1, error="ChannelPrivateError: нет доступа")
        self.assertIn("ChannelPrivate", self.store.get_dialog(1).sample_error)

    def test_stats_report_progress(self):
        self.store.upsert_dialogs([make_dialog(id=1), make_dialog(id=2, kind="bot")])
        self.store.save_samples(make_samples(1, ["текст"]))
        stats = self.store.stats()
        self.assertEqual(stats["dialogs"], 2)
        self.assertEqual(stats["messages"], 1)
        self.assertEqual(stats["by_kind"]["bot"], 1)

    def test_run_journal_records_failures(self):
        with self.assertRaises(ValueError):
            with self.store.run("stage2"):
                raise ValueError("сеть отвалилась")
        row = self.store.conn.execute("SELECT status FROM runs ORDER BY id DESC").fetchone()
        self.assertIn("failed", row["status"])

    def test_database_is_created_with_parent_dirs(self):
        nested = Path(self.tmp.name) / "deep" / "dir" / "audit.db"
        with Store(nested) as store:
            self.assertEqual(store.count_dialogs(), 0)
        self.assertTrue(nested.exists())


if __name__ == "__main__":
    unittest.main()
