"""Необязательный ИИ: разбор ответа, приватность, устойчивость к сбоям."""

import unittest

from tests.helpers import make_dialog, make_samples
from tgaudit.ai import (
    AIClassifier,
    AIError,
    AIVerdict,
    _extract_json_array,
    apply_verdicts,
    classifier_from_settings,
)
from tgaudit.config import Settings
from tgaudit.models import ChatRecord, Score


def records():
    channel = make_dialog(id=-100, title="Крипта")
    private = make_dialog(id=55, kind="dm", title="Друг")
    return [
        ChatRecord(dialog=channel, samples=make_samples(-100, ["сигналы"])),
        ChatRecord(dialog=private, samples=make_samples(55, ["привет"])),
    ]


class ParsingTests(unittest.TestCase):
    def test_json_in_code_fence(self):
        data = _extract_json_array('```json\n[{"id": 1, "bucket": "keep"}]\n```')
        self.assertEqual(data[0]["id"], 1)

    def test_json_surrounded_by_chatter(self):
        data = _extract_json_array('Конечно! [{"id": 2, "bucket": "archive"}] Готово.')
        self.assertEqual(data[0]["bucket"], "archive")

    def test_broken_answer_raises(self):
        with self.assertRaises(AIError):
            _extract_json_array("я не умею в json")


class ClassifierTests(unittest.TestCase):
    def test_private_chats_are_not_sent_by_default(self):
        seen: list[str] = []
        classifier = AIClassifier(provider="groq", api_key="k", log=lambda _m: None)
        classifier._complete = lambda prompt: seen.append(prompt) or '[{"id": -100, "bucket": "keep"}]'
        classifier.classify(records())
        self.assertIn("-100", seen[0])
        self.assertNotIn("Друг", seen[0])

    def test_private_chats_can_be_included_explicitly(self):
        seen: list[str] = []
        classifier = AIClassifier(provider="groq", api_key="k", log=lambda _m: None)
        classifier._complete = lambda prompt: seen.append(prompt) or "[]"
        classifier.classify(records(), include_dms=True)
        self.assertIn("Друг", seen[0])

    def test_unknown_bucket_is_ignored(self):
        classifier = AIClassifier(provider="groq", api_key="k", log=lambda _m: None)
        classifier._complete = lambda prompt: '[{"id": -100, "bucket": "мусор"}]'
        verdicts = classifier.classify(records())
        self.assertIsNone(verdicts[-100].bucket)

    def test_missing_key_is_a_clear_error(self):
        with self.assertRaises(AIError) as ctx:
            AIClassifier(provider="groq").check()
        self.assertIn("TGAUDIT_AI_KEY", str(ctx.exception))

    def test_unknown_provider_is_rejected(self):
        with self.assertRaises(AIError):
            AIClassifier(provider="скайнет", api_key="k").check()

    def test_none_provider_is_disabled(self):
        classifier = AIClassifier(provider="none")
        self.assertFalse(classifier.enabled)
        self.assertEqual(classifier.classify(records()), {})

    def test_defaults_come_from_settings(self):
        classifier = classifier_from_settings(Settings(ai_provider="gemini", ai_key="x"))
        self.assertEqual(classifier.model, "gemini-2.0-flash")
        self.assertIn("generativelanguage", classifier.base_url)


class MergeTests(unittest.TestCase):
    def test_ai_opinion_is_recorded_without_overriding_heuristics(self):
        scores = [Score(dialog_id=-100, bucket="keep", score=70, reasons=[])]
        applied = apply_verdicts(
            scores,
            {-100: AIVerdict(dialog_id=-100, bucket="unsubscribe", reason="реклама")},
            model="llama",
        )
        self.assertEqual(applied, 1)
        self.assertEqual(scores[0].bucket, "keep")  # решает эвристика
        self.assertEqual(scores[0].ai_bucket, "unsubscribe")
        self.assertTrue(any("ИИ считает иначе" in r for r in scores[0].reasons))


if __name__ == "__main__":
    unittest.main()
