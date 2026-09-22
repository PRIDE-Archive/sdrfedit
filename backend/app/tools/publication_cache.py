"""Bounded on-disk cache of validated public article downloads (shared across sessions)."""
from __future__ import annotations

import hashlib
import os
import tempfile
import time
from pathlib import Path

from ..config import get_settings
from .http import ToolHttpError, get_bytes


def cache_root() -> Path:
    settings = get_settings()
    root = settings._resolve(settings.publication_cache_dir)
    root.mkdir(parents=True, exist_ok=True)
    return root


async def cached_download(url: str, kind: str) -> tuple[bytes, str]:
    if kind not in {"pdf", "xml"}:
        raise ValueError("Unsupported article format")
    root = cache_root()
    settings = get_settings()
    cutoff = time.time() - settings.publication_cache_ttl_seconds
    files = sorted(root.glob("*.raw"), key=lambda p: p.stat().st_mtime)
    total = sum(p.stat().st_size for p in files)
    for file in files:
        size = file.stat().st_size
        if file.stat().st_mtime < cutoff or total > settings.publication_cache_max_mb * 1024 * 1024:
            file.unlink(missing_ok=True)
            total -= size
    path = root / (hashlib.sha256(f"{kind}:{url}".encode()).hexdigest() + ".raw")
    if path.exists():
        return path.read_bytes(), str(path)
    data, _ = await get_bytes(url, max_bytes=min(settings.max_upload_mb, settings.publication_cache_max_mb) * 1024 * 1024)
    if kind == "pdf" and not data.startswith(b"%PDF-"):
        raise ToolHttpError("Downloaded response is not a PDF (possibly a login or error page).")
    if kind == "xml":
        from lxml import etree
        try:
            tree = etree.fromstring(data, parser=etree.XMLParser(resolve_entities=False, no_network=True))
            if tree.tag != "article" or tree.find("body") is None:
                raise ValueError("Missing article/body")
        except (etree.XMLSyntaxError, ValueError) as error:
            raise ToolHttpError("Downloaded response is not full-text JATS XML.") from error
    # Make room before committing a new original, keeping the configured bound.
    files = sorted(root.glob("*.raw"), key=lambda p: p.stat().st_mtime)
    total = sum(p.stat().st_size for p in files)
    for file in files:
        if total + len(data) <= settings.publication_cache_max_mb * 1024 * 1024:
            break
        total -= file.stat().st_size
        file.unlink(missing_ok=True)
    # Atomic replacement prevents concurrent readers from seeing partial files.
    with tempfile.NamedTemporaryFile(dir=root, delete=False) as output:
        temporary = Path(output.name)
        output.write(data)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
    return data, str(path)
