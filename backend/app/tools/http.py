"""Shared HTTP helper for outbound tool calls."""

from __future__ import annotations

import asyncio
from functools import wraps
from typing import Any

import httpx

USER_AGENT = "sdrfedit-assistant/1.0 (+https://github.com/bigbio/sdrfedit)"


class ToolHttpError(RuntimeError):
    """Raised when an upstream service fails in a way the agent should see."""


def retry_request(function):
    @wraps(function)
    async def wrapped(*args, **kwargs):
        for attempt in range(3):
            try:
                return await function(*args, **kwargs)
            except (httpx.TransportError, RetryableHttpError) as error:
                if attempt == 2:
                    raise ToolHttpError(f"Upstream temporarily unavailable: {error}") from error
                await asyncio.sleep(0.5 * (2 ** attempt))
    return wrapped


class RetryableHttpError(ToolHttpError):
    pass


@retry_request
async def get_json(url: str, *, params: dict[str, Any] | None = None, timeout: float = 30.0) -> Any:
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        response = await client.get(url, params=params, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
        if response.status_code == 429 or response.status_code >= 500:
            raise RetryableHttpError(f"HTTP {response.status_code} for {url}")
        if response.status_code == 404:
            raise ToolHttpError(f"Not found: {url}")
        if response.status_code >= 400:
            raise ToolHttpError(f"Request failed ({response.status_code}) for {url}: {response.text[:200]}")
        try:
            return response.json()
        except ValueError as error:
            raise ToolHttpError(f"Invalid JSON response from {url}") from error


@retry_request
async def get_text(url: str, *, params: dict[str, Any] | None = None, timeout: float = 45.0) -> str:
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        response = await client.get(url, params=params, headers={"User-Agent": USER_AGENT})
        if response.status_code == 429 or response.status_code >= 500:
            raise RetryableHttpError(f"HTTP {response.status_code} for {url}")
        if response.status_code == 404:
            raise ToolHttpError(f"Not found: {url}")
        if response.status_code >= 400:
            raise ToolHttpError(f"Request failed ({response.status_code}) for {url}: {response.text[:200]}")
        return response.text


@retry_request
async def get_bytes(url: str, *, timeout: float = 120.0, max_bytes: int = 60 * 1024 * 1024,
                    trust_env: bool = True) -> tuple[bytes, str]:
    """Download a binary payload, returning (content, content_type)."""
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True, trust_env=trust_env) as client:
        async with client.stream("GET", url, headers={"User-Agent": USER_AGENT}) as response:
            if response.status_code == 429 or response.status_code >= 500:
                raise RetryableHttpError(f"HTTP {response.status_code} for {url}")
            if response.status_code >= 400:
                raise ToolHttpError(f"Download failed ({response.status_code}) for {url}")
            chunks: list[bytes] = []
            total = 0
            async for chunk in response.aiter_bytes():
                total += len(chunk)
                if total > max_bytes:
                    raise ToolHttpError(f"Download exceeds {max_bytes // (1024 * 1024)} MB limit: {url}")
                chunks.append(chunk)
            return b"".join(chunks), response.headers.get("content-type", "")
