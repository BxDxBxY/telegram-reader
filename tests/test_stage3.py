"""Этап 3 целиком: скоринг пишется в БД, сбой ИИ не ломает аудит."""

import tempfile
import unittest
from pathlib import Path

from tests.helpers import make_dialog, make_samples
from tgaudit.config import Settings
from tgaudit.stage3 import run_scoring
from tgaudit.storage import Store


class ScoringStageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / "db.sqlite")
        self.store.upsert_dialogs([
            make_dialog(id=1, title="Живой канал"),
            make_dialog(id=2, title="Мёртвый канал",
                        last_message_date="2020-01-01T00:00:00+00:00"),
        ])
        self.store.save_samples(make_samples(1, ["полезный разбор релиза"]))

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_scores_are_saved_for_every_dialog(self):
        counts = run_scoring(self.store, Settings(), use_ai=False, log=lambda _m: None)
        self.assertEqual(sum(counts.values()), 2)
        self.assertEqual(len(self.store.scores()), 2)

    def test_ai_failure_does_not_break_the_audit(self):
        messages: list[str] = []
        # Провайдер указан, но ключа нет — этап обязан доработать на эвристике.
        settings = Settings(ai_provider="groq", ai_key="")
        counts = run_scoring(self.store, settings, log=messages.append)
        self.assertEqual(sum(counts.values()), 2)
        self.assertTrue(any("ИИ пропущен" in m for m in messages))

    def test_rescoring_replaces_previous_verdicts(self):
        run_scoring(self.store, Settings(), use_ai=False, log=lambda _m: None)
        run_scoring(self.store, Settings(), use_ai=False, log=lambda _m: None)
        self.assertEqual(len(self.store.scores()), 2)

    def test_empty_database_is_handled(self):
        with tempfile.TemporaryDirectory() as tmp:
            with Store(Path(tmp) / "empty.db") as store:
                self.assertEqual(run_scoring(store, Settings(), log=lambda _m: None), {})


if __name__ == "__main__":
    unittest.main()
