"""Chat endpoints for the wizard assistant."""

from __future__ import annotations

import json
from collections.abc import AsyncGenerator

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from ..llm.agent import run_agent
from ..schemas import ChatRequest, ChatResult

router = APIRouter(prefix="/api", tags=["chat"])


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


@router.post("/chat")
async def chat(request: ChatRequest) -> StreamingResponse:
    """Stream the assistant turn as server-sent events.

    Event types: `status`, `thinking`, `token`, `tool_start`, `tool`, `actions`, `citations`,
    `next_step`, `error`, `done`.
    """

    async def generator() -> AsyncGenerator[str, None]:
        async for event in run_agent(request):
            yield _sse(event)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.post("/chat/sync", response_model=ChatResult)
async def chat_sync(request: ChatRequest) -> ChatResult:
    """Non-streaming variant, handy for scripting and smoke tests."""
    result = ChatResult()
    tokens: list[str] = []

    async for event in run_agent(request):
        if event["type"] == "token":
            tokens.append(event["text"])
        elif event["type"] == "error":
            result.content = event["text"]
            return result
        elif event["type"] == "done":
            result = ChatResult(**event["result"])

    if not result.content:
        result.content = "".join(tokens)
    return result
