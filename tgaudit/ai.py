"""Необязательная классификация чатов бесплатным внешним ИИ.

Работает на стандартной библиотеке (urllib) — никаких SDK. Поддерживаются:

* groq   — Groq Cloud, бесплатный ключ без карты (Llama 3.x), ~30 запросов/мин;
* gemini — Google AI Studio, бесплатный ключ (Gemini Flash);
* openai-compatible — любой сервис с /chat/completions (в т.ч. локальная Ollama).

ИИ здесь — советчик, а не судья: его вердикт пишется в отдельные поля и не
переписывает прозрачную эвристику. Личные переписки по умолчанию наружу
не отправляются.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable, Iterable, Sequence

from .models import BUCKET_ARCHIVE, BUCKET_DROP, BUCKET_KEEP, KIND_DM, ChatRecord, Score
from .report import render_chat_block

PROVIDER_NONE = "none"
PROVIDER_GROQ = "groq"
PROVIDER_GEMINI = "gemini"
PROVIDER_OPENAI = "openai-compatible"

DEFAULT_MODELS = {
    PROVIDER_GROQ: "llama-3.3-70b-versatile",
    PROVIDER_GEMINI: "gemini-2.0-flash",
    PROVIDER_OPENAI: "gpt-4o-mini",
}

DEFAULT_BASE_URLS = {
    PROVIDER_GROQ: "https://api.groq.com/openai/v1",
    PROVIDER_GEMINI: "https://generativelanguage.googleapis.com/v1beta",
}

SYSTEM_PROMPT = (
    "Ты помогаешь навести порядок в подписках Telegram. Для каждого чата определи "
    "тематику и вердикт. Вердикты: keep (полезно, читать дальше), archive (редко нужно, "
    "справочник), unsubscribe (мёртвое, реклама, инфоцыганство, скам, дубль). "
    "Отвечай ТОЛЬКО массивом JSON без пояснений и без markdown-обёртки, формат: "
    '[{"id": <число>, "topic": "<тема>", "bucket": "keep|archive|unsubscribe", '
    '"reason": "<до 100 символов>", "confidence": <0..1>}]'
)

VALID_BUCKETS = {BUCKET_KEEP, BUCKET_ARCHIVE, BUCKET_DROP}


class AIError(RuntimeError):
    """Проблема с внешним ИИ: нет ключа, сеть, лимит, нечитаемый ответ."""


@dataclass
class AIVerdict:
    dialog_id: int
    bucket: str | None = None
    topic: str | None = None
    reason: str | None = None
    confidence: float | None = None


def _extract_json_array(text: str) -> list[dict]:
    """Достаёт JSON-массив из ответа модели, даже если он обёрнут в ```json."""
    cleaned = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.MULTILINE).strip()
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        start, end = cleaned.find("["), cleaned.rfind("]")
        if start == -1 or end <= start:
            raise AIError(f"Модель вернула не JSON: {cleaned[:200]}")
        try:
            data = json.loads(cleaned[start : end + 1])
        except json.JSONDecodeError as exc:
            raise AIError(f"Не разобрать JSON из ответа модели: {exc}") from exc
    if isinstance(data, dict):
        data = data.get("items") or data.get("chats") or [data]
    if not isinstance(data, list):
        raise AIError("Ожидался массив объектов в ответе модели")
    return [item for item in data if isinstance(item, dict)]


@dataclass
class AIClassifier:
    """Батчевый классификатор. Один HTTP-запрос на 10–20 чатов."""

    provider: str = PROVIDER_NONE
    api_key: str = ""
    model: str = ""
    base_url: str = ""
    batch_size: int = 15
    pause: float = 2.5  # выдерживает лимит ~30 запросов в минуту
    timeout: int = 90
    log: Callable[[str], None] = print
    sleep: Callable[[float], None] = time.sleep

    def __post_init__(self) -> None:
        self.provider = (self.provider or PROVIDER_NONE).lower()
        self.model = self.model or DEFAULT_MODELS.get(self.provider, "")
        self.base_url = (self.base_url or DEFAULT_BASE_URLS.get(self.provider, "")).rstrip("/")

    @property
    def enabled(self) -> bool:
        return self.provider != PROVIDER_NONE

    def check(self) -> None:
        if not self.enabled:
            return
        if self.provider not in (PROVIDER_GROQ, PROVIDER_GEMINI, PROVIDER_OPENAI):
            raise AIError(
                f"Неизвестный провайдер «{self.provider}». "
                f"Доступны: {PROVIDER_GROQ}, {PROVIDER_GEMINI}, {PROVIDER_OPENAI}, {PROVIDER_NONE}"
            )
        if not self.api_key:
            raise AIError(
                "Не задан TGAUDIT_AI_KEY. Бесплатные ключи: console.groq.com (Groq) "
                "или aistudio.google.com/apikey (Gemini). Либо используйте --ai none "
                "и батчи из out/batches/ для ручного анализа."
            )
        if self.provider == PROVIDER_OPENAI and not self.base_url:
            raise AIError("Для openai-compatible нужен TGAUDIT_AI_BASE_URL")

    # ── HTTP ─────────────────────────────────────────────────────────────
    def _post(self, url: str, payload: dict, headers: dict[str, str]) -> dict:
        request = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json", **headers},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", "replace")[:300]
            if exc.code == 429:
                raise AIError(f"Лимит запросов к {self.provider}: {body}") from exc
            raise AIError(f"HTTP {exc.code} от {self.provider}: {body}") from exc
        except urllib.error.URLError as exc:
            raise AIError(f"Сеть недоступна ({self.provider}): {exc.reason}") from exc

    def _complete(self, prompt: str) -> str:
        """Один запрос к модели -> текст ответа."""
        if self.provider == PROVIDER_GEMINI:
            url = f"{self.base_url}/models/{self.model}:generateContent?key={self.api_key}"
            payload = {
                "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT}]},
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.1, "responseMimeType": "application/json"},
            }
            data = self._post(url, payload, {})
            candidates = data.get("candidates") or []
            if not candidates:
                raise AIError(f"Пустой ответ Gemini: {str(data)[:200]}")
            parts = candidates[0].get("content", {}).get("parts", [])
            return "".join(part.get("text", "") for part in parts)

        # groq и любой openai-совместимый сервис
        url = f"{self.base_url}/chat/completions"
        payload = {
            "model": self.model,
            "temperature": 0.1,
            "messages": [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
        }
        data = self._post(url, payload, {"Authorization": f"Bearer {self.api_key}"})
        choices = data.get("choices") or []
        if not choices:
            raise AIError(f"Пустой ответ {self.provider}: {str(data)[:200]}")
        return choices[0].get("message", {}).get("content", "")

    # ── Классификация ────────────────────────────────────────────────────
    def classify(
        self, records: Sequence[ChatRecord], *, include_dms: bool = False
    ) -> dict[int, AIVerdict]:
        """Разбивает чаты на батчи и собирает вердикты модели."""
        self.check()
        if not self.enabled:
            return {}

        targets = [r for r in records if include_dms or r.dialog.kind != KIND_DM]
        skipped = len(records) - len(targets)
        if skipped:
            self.log(f"  личных чатов не отправляем наружу: {skipped}")

        verdicts: dict[int, AIVerdict] = {}
        batches = list(_chunks(targets, self.batch_size))
        for index, batch in enumerate(batches, start=1):
            prompt = _render_prompt(batch)
            self.log(f"  ИИ {self.provider}/{self.model}: батч {index}/{len(batches)} ({len(batch)} чатов)")
            raw = self._complete(prompt)
            for item in _extract_json_array(raw):
                try:
                    dialog_id = int(item.get("id"))
                except (TypeError, ValueError):
                    continue
                bucket = str(item.get("bucket", "")).strip().lower()
                verdicts[dialog_id] = AIVerdict(
                    dialog_id=dialog_id,
                    bucket=bucket if bucket in VALID_BUCKETS else None,
                    topic=(item.get("topic") or None),
                    reason=(item.get("reason") or None),
                    confidence=_as_float(item.get("confidence")),
                )
            if index < len(batches):
                self.sleep(self.pause)
        return verdicts


def _as_float(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _chunks(items: Sequence[ChatRecord], size: int) -> Iterable[Sequence[ChatRecord]]:
    size = max(1, size)
    for start in range(0, len(items), size):
        yield items[start : start + size]


def _render_prompt(batch: Sequence[ChatRecord]) -> str:
    blocks = [render_chat_block(r, max_messages=5, with_verdict=False) for r in batch]
    return "\n".join(blocks)


def apply_verdicts(scores: Sequence[Score], verdicts: dict[int, AIVerdict], *, model: str) -> int:
    """Пишет мнение ИИ в оценки. Эвристический вердикт остаётся главным."""
    applied = 0
    for score in scores:
        verdict = verdicts.get(score.dialog_id)
        if not verdict:
            continue
        score.ai_bucket = verdict.bucket
        score.ai_topic = verdict.topic
        score.ai_reason = verdict.reason
        score.ai_model = model
        if verdict.bucket and verdict.bucket != score.bucket:
            # Расхождение не скрываем — оно видно в отчёте и помогает решить руками.
            score.reasons.append(
                f"ИИ считает иначе ({verdict.bucket}): {verdict.reason or 'без пояснения'}"
            )
        applied += 1
    return applied


def classifier_from_settings(settings, *, log: Callable[[str], None] = print) -> AIClassifier:
    return AIClassifier(
        provider=settings.ai_provider,
        api_key=settings.ai_key,
        model=settings.ai_model,
        base_url=settings.ai_base_url,
        batch_size=settings.ai_batch_size,
        log=log,
    )
