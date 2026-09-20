"""Сквозной прогон конвейера через CLI на демо-данных (без Telegram)."""

import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from tgaudit.cli import main
from tgaudit.storage import Store


class DemoPipelineTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "audit.db")
        self.out = str(Path(self.tmp.name) / "out")
        self.session = str(Path(self.tmp.name) / "sessions" / "test")

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *args) -> tuple[int, str]:
        buffer = io.StringIO()
        with redirect_stdout(buffer):
            code = main([
                "--env", "нет-такого-файла.env",
                "--db", self.db,
                "--out", self.out,
                "--session", self.session,
                *args,
            ])
        return code, buffer.getvalue()

    def test_demo_produces_full_report(self):
        code, output = self.run_cli("demo")
        self.assertEqual(code, 0)
        self.assertIn("Демо-режим", output)

        out_dir = Path(self.out)
        self.assertTrue((out_dir / "report.md").exists())
        self.assertTrue((out_dir / "report.csv").exists())
        self.assertTrue((out_dir / "chats.jsonl").exists())
        self.assertTrue((out_dir / "unsubscribe_plan.md").exists())
        self.assertTrue(list(out_dir.glob("batches/batch_*.md")))

        report = (out_dir / "report.md").read_text(encoding="utf-8")
        self.assertIn("# Аудит Telegram-аккаунта", report)
        self.assertIn("## Оставить", report)

    def test_triage_filters_out_a_large_share_without_reading_messages(self):
        self.run_cli("demo")
        with Store(self.db) as store:
            stats = store.stats()
        triaged = stats["by_triage"]
        decided_without_logs = triaged.get("drop", 0) + triaged.get("keep", 0)
        self.assertGreaterEqual(decided_without_logs / stats["dialogs"], 0.3)

    def test_service_and_work_chats_survive(self):
        self.run_cli("demo")
        with Store(self.db) as store:
            by_title = {r.dialog.title: r for r in store.records()}
        self.assertEqual(by_title["Telegram"].score.bucket, "keep")
        self.assertEqual(by_title["Рабочий чат — платформа"].score.bucket, "keep")

    def test_private_chats_never_get_unsubscribe_verdict(self):
        self.run_cli("demo")
        with Store(self.db) as store:
            private = [r for r in store.records() if r.dialog.kind == "dm"]
        self.assertTrue(private)
        self.assertTrue(all(r.score.bucket != "unsubscribe" for r in private))

    def test_stats_command_reads_the_database(self):
        self.run_cli("demo")
        code, output = self.run_cli("stats")
        self.assertEqual(code, 0)
        self.assertIn("диалогов:", output)

    def test_report_on_empty_database_is_friendly(self):
        code, output = self.run_cli("report")
        self.assertEqual(code, 1)
        self.assertIn("пусто", output)

    def test_stage1_without_credentials_fails_clearly(self):
        code, output = self.run_cli("stage1")
        self.assertEqual(code, 2)
        self.assertIn("TG_API_ID", output)

    def test_login_without_credentials_explains_what_to_do(self):
        code, output = self.run_cli("login")
        self.assertEqual(code, 2)
        self.assertIn(".env", output)
        # Бесполезных каталогов при неудачном входе не создаём.
        self.assertFalse(Path(self.session).parent.exists())

    def test_second_demo_run_is_idempotent(self):
        self.run_cli("demo")
        self.run_cli("demo")
        with Store(self.db) as store:
            self.assertEqual(store.stats()["dialogs"], store.count_dialogs())


if __name__ == "__main__":
    unittest.main()
