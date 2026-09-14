"""LLM access through any OpenAI-compatible endpoint (OpenRouter by default).

Deliberately thin: one function, `complete`, that posts a message list plus tool
specs and returns the assistant message. Tool orchestration lives in `loop.py`,
which makes both easy to reason about and lets tests inject a fake LLM.
"""

from __future__ import annotations

from typing import Any, Optional, Protocol

import httpx

from ..config import settings


class LLMError(Exception):
    """Provider-level failure (auth, quota, timeout, malformed response)."""


class LLM(Protocol):
    async def complete(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> dict[str, Any]: ...


class OpenAICompatibleLLM:
    def __init__(
        self,
        base_url: Optional[str] = None,
        api_key: Optional[str] = None,
        model: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> None:
        self.base_url = (base_url or settings.llm_base_url).rstrip("/")
        self.api_key = api_key if api_key is not None else settings.llm_api_key
        self.model = model or settings.llm_model
        self.timeout = timeout or settings.llm_timeout_seconds

    async def complete(
        self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> dict[str, Any]:
        if not self.api_key:
            raise LLMError(
                "LLM не настроен: задайте OPENROUTER_API_KEY в backend/.env "
                "(см. .env.example)."
            )

        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "temperature": 0.2,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": settings.app_url,
            "X-Title": settings.app_title,
        }

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(
                    f"{self.base_url}/chat/completions", json=payload, headers=headers
                )
        except httpx.HTTPError as exc:
            raise LLMError(f"Сеть до LLM недоступна: {exc}") from exc

        if response.status_code >= 400:
            raise LLMError(_explain_http_error(response))

        try:
            data = response.json()
            return data["choices"][0]["message"]
        except Exception as exc:
            raise LLMError(f"Неожиданный ответ провайдера: {response.text[:400]}") from exc


def _explain_http_error(response: httpx.Response) -> str:
    detail = response.text[:400]
    try:
        body = response.json()
        detail = body.get("error", {}).get("message") or body.get("message") or detail
    except Exception:
        pass
    if response.status_code in (401, 403):
        return f"LLM отклонил ключ ({response.status_code}): {detail}"
    if response.status_code == 402:
        return f"Недостаточно средств на аккаунте LLM: {detail}"
    if response.status_code == 429:
        return f"Лимит запросов к LLM исчерпан, попробуйте позже: {detail}"
    return f"LLM вернул ошибку {response.status_code}: {detail}"
