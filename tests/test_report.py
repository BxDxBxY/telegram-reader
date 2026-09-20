"""Отчёты: формат блока, батчи, CSV, план отписки."""

import csv
import tempfile
import unittest
from pathlib import Path

from tests.helpers import make_dialog, make_samples
from tgaudit.models import ChatRecord, Score
from tgaudit.report import (
    render_batches,
    render_chat_block,
    render_report,
    render_unsubscribe_plan,
    write_all,
)


def record(dialog_id=-1001234567890, bucket="archive", score=42.0, **kwargs):
    dialog = make_dialog(
        id=dialog_id,
        title=kwargs.pop("title", "Python Academy & News"),
        username=kwargs.pop("username", "pyacademy"),
        unread_count=kwargs.pop("unread_count", 1240),
        **kwargs,
    )
    return ChatRecord(
        dialog=dialog,
        samples=make_samples(dialog.id, ["Вышел релиз Python 3.14", "Реклама: курсы со скидкой"]),
        score=Score(dialog_id=dialog.id, score=score, bucket=bucket,
                    reasons=["попадается реклама"], topic="python"),
    )


class BlockTests(unittest.TestCase):
    def test_block_has_expected_structure(self):
        text = render_chat_block(record())
        self.assertIn("### [ID: -1001234567890] Python Academy & News", text)
        self.assertIn("- **Тип:** Канал (@pyacademy)", text)
        self.assertIn("- **Непрочитанных:** 1 240", text)
        self.assertIn("- **Последняя активность:**", text)
        self.assertIn("- **Срез последних постов:**", text)
        self.assertIn('1. "Вышел релиз Python 3.14"', text)

    def test_verdict_can_be_hidden_for_ai_prompt(self):
        self.assertNotIn("Балл", render_chat_block(record(), with_verdict=False))
        self.assertIn("Балл", render_chat_block(record(), with_verdict=True))

    def test_block_without_samples_explains_why(self):
        empty = ChatRecord(dialog=make_dialog(id=1), samples=[], score=None)
        self.assertIn("не требовался", render_chat_block(empty))

    def test_sample_error_is_visible(self):
        broken = ChatRecord(
            dialog=make_dialog(id=1, sample_error="ChannelPrivateError"), samples=[], score=None
        )
        self.assertIn("ChannelPrivateError", render_chat_block(broken))

    def test_ai_opinion_is_shown_when_present(self):
        item = record()
        item.score.ai_bucket = "unsubscribe"
        item.score.ai_reason = "сплошная реклама"
        self.assertIn("Мнение ИИ", render_chat_block(item))


class ReportTests(unittest.TestCase):
    def test_report_groups_by_bucket(self):
        text = render_report([
            record(dialog_id=1, bucket="keep", score=80),
            record(dialog_id=2, bucket="unsubscribe", score=10),
        ])
        self.assertIn("## Оставить — 1", text)
        self.assertIn("## Отписаться / удалить — 1", text)
        self.assertIn("только на чтение", text)

    def test_batches_are_chunked(self):
        records = [record(dialog_id=i) for i in range(1, 8)]
        batches = render_batches(records, size=3)
        self.assertEqual(len(batches), 3)
        self.assertIn("Батч 1 · чатов: 3", batches[0])
        self.assertIn("Сгруппируй их по тематикам", batches[0])

    def test_unsubscribe_plan_is_split_by_days(self):
        records = [record(dialog_id=i, bucket="unsubscribe", score=5) for i in range(1, 31)]
        plan = render_unsubscribe_plan(records, per_day=25)
        self.assertIn("## День 1 — 25 шт.", plan)
        self.assertIn("## День 2 — 5 шт.", plan)
        self.assertIn("не больше 25 отписок в день", plan)

    def test_plan_is_empty_when_nothing_to_drop(self):
        self.assertIn("нет", render_unsubscribe_plan([record(bucket="keep")]).lower())


class WriteAllTests(unittest.TestCase):
    def test_all_artifacts_are_written(self):
        records = [
            record(dialog_id=1, bucket="keep", score=90),
            record(dialog_id=2, bucket="unsubscribe", score=5),
        ]
        with tempfile.TemporaryDirectory() as tmp:
            written = write_all(records, tmp, batch_size=1)
            for key in ("report", "csv", "jsonl", "plan"):
                self.assertTrue(written[key].exists(), key)
            batches = sorted(Path(tmp).glob("batches/batch_*.md"))
            # В батчи попадает только то, что требует решения (без «Оставить»).
            self.assertEqual(len(batches), 1)

            with written["csv"].open(encoding="utf-8-sig") as handle:
                rows = list(csv.DictReader(handle, delimiter=";"))
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]["bucket"], "keep")
            self.assertEqual(rows[0]["title"], "Python Academy & News")

            lines = written["jsonl"].read_text(encoding="utf-8").strip().splitlines()
            self.assertEqual(len(lines), 2)


if __name__ == "__main__":
    unittest.main()
