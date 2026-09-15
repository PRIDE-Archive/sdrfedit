"""Streaming chat client for an OpenAI-compatible endpoint with tool calling.

Streaming is used for every round, including rounds that end in tool calls, so
the panel can show the model's narration while evidence is being gathered.
Tool-call deltas arrive fragmented across chunks and are reassembled by index.
"""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator
from dataclasses import dataclass, field
from typing import Any

import httpx

from ..config import Settings, get_settings


class LlmError(RuntimeError):
    pass


@dataclass
class ToolCall:
    id: str
    name: str
    arguments: str = ""


@dataclass
class StreamEvent:
    type: str  # token | tool_calls | done
    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str | None = None


class LlmClient:
    def __init__(self, settings: Settings | None = None) -> None:
        self._settings = settings or get_settings()

    @property
    def model(self) -> str:
        return self._settings.llm_model

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self._settings.llm_api_key:
            # Most OpenAI-compatible providers use "Authorization: Bearer <key>".
            # Some gateways instead expect a distinct header (e.g. X-API-Key)
            # because Authorization is reserved for a different credential
            # type -- set LLM_AUTH_HEADER to switch.
            if self._settings.llm_auth_header.lower() == "x-api-key":
                headers["X-API-Key"] = self._settings.llm_api_key
            else:
                headers["Authorization"] = f"Bearer {self._settings.llm_api_key}"
        return headers

    async def stream(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict] | None = None,
        *,
        temperature: float | None = None,
    ) -> AsyncGenerator[StreamEvent, None]:
        if not self._settings.llm_configured:
            raise LlmError(
                "The assistant is not configured: set LLM_API_KEY (and LLM_BASE_URL / LLM_MODEL) in backend/.env."
            )

        body: dict[str, Any] = {
            "model": self._settings.llm_model,
            "messages": messages,
            "stream": True,
            "temperature": self._settings.llm_temperature if temperature is None else temperature,
        }
        if tools:
            body["tools"] = tools
            body["tool_choice"] = "auto"

        url = f"{self._settings.llm_base_url.rstrip('/')}/chat/completions"
        pending: dict[int, ToolCall] = {}
        finish_reason: str | None = None

        async with httpx.AsyncClient(timeout=self._settings.llm_timeout_seconds) as client:
            async with client.stream("POST", url, headers=self._headers(), json=body) as response:
                if response.status_code >= 400:
                    detail = (await response.aread()).decode("utf-8", errors="replace")
                    raise LlmError(f"LLM request failed ({response.status_code}): {detail[:400]}")

                async for line in response.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload in ("", "[DONE]"):
                        continue
                    try:
                        chunk = json.loads(payload)
                    except json.JSONDecodeError:
                        continue

                    # Some gateways (e.g. pride-llm-api) answer 200 and stream an
                    # error as a chunk rather than failing the initial response --
                    # surface it instead of silently producing an empty answer.
                    error = chunk.get("error")
                    if error:
                        detail = error.get("message") if isinstance(error, dict) else str(error)
                        raise LlmError(f"LLM stream error: {(detail or '')[:400]}")

                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    choice = choices[0]
                    delta = choice.get("delta") or {}

                    content = delta.get("content")
                    if content:
                        yield StreamEvent(type="token", text=content)

                    for fragment in delta.get("tool_calls") or []:
                        index = fragment.get("index", 0)
                        call = pending.setdefault(index, ToolCall(id="", name=""))
                        if fragment.get("id"):
                            call.id = fragment["id"]
                        function = fragment.get("function") or {}
                        if function.get("name"):
                            call.name = function["name"]
                        if function.get("arguments"):
                            call.arguments += function["arguments"]

                    if choice.get("finish_reason"):
                        finish_reason = choice["finish_reason"]

        calls = [pending[i] for i in sorted(pending) if pending[i].name]
        if calls:
            for index, call in enumerate(calls):
                if not call.id:
                    call.id = f"call_{index}"
            yield StreamEvent(type="tool_calls", tool_calls=calls, finish_reason=finish_reason or "tool_calls")
        yield StreamEvent(type="done", finish_reason=finish_reason)
