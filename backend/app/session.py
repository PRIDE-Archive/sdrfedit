"""In-memory session store for documents and evidence the assistant gathered.

Papers are large; re-sending them on every turn would blow the context window.
Instead the parsed text lives here and the agent pulls the sections it needs by
`documentId`.

The store also keeps a short digest of what the tools already found. Because the
assistant advises one wizard step at a time, it would otherwise re-fetch PRIDE
and the paper on every step; the digest is replayed into the prompt instead.
Entries expire after SESSION_TTL_SECONDS.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field

from .config import get_settings
from .parsing.base import ParsedDocument


MAX_EVIDENCE_CHARS = 1200
MAX_EVIDENCE_ENTRIES = 12


@dataclass
class StoredDocument:
    document_id: str
    session_id: str
    file_name: str
    origin: str
    document: ParsedDocument
    metadata: dict = field(default_factory=dict)
    created_at: float = field(default_factory=time.time)


@dataclass
class EvidenceNote:
    """A compact record of something a tool established, keyed for de-duplication."""

    key: str
    text: str
    created_at: float = field(default_factory=time.time)


class SessionStore:
    def __init__(self) -> None:
        self._documents: dict[str, StoredDocument] = {}
        self._evidence: dict[str, dict[str, EvidenceNote]] = {}

    def add_document(
        self, session_id: str, file_name: str, document: ParsedDocument, origin: str = "upload", metadata: dict | None = None
    ) -> StoredDocument:
        self._evict()
        document_id = f"doc_{uuid.uuid4().hex[:10]}"
        stored = StoredDocument(
            document_id=document_id,
            session_id=session_id,
            file_name=file_name,
            origin=origin,
            document=document,
            metadata=metadata or {},
        )
        self._documents[document_id] = stored
        return stored

    def get(self, document_id: str) -> StoredDocument | None:
        self._evict()
        return self._documents.get(document_id)

    def list_for_session(self, session_id: str) -> list[StoredDocument]:
        self._evict()
        return [d for d in self._documents.values() if d.session_id == session_id]

    # ------------------------------------------------------------------ evidence

    def add_evidence(self, session_id: str, key: str, text: str) -> None:
        """Remember a finding under `key`; re-adding the same key replaces it."""
        if not text.strip():
            return
        self._evict()
        notes = self._evidence.setdefault(session_id, {})
        notes[key] = EvidenceNote(key=key, text=text.strip()[:MAX_EVIDENCE_CHARS])
        while len(notes) > MAX_EVIDENCE_ENTRIES:
            oldest = min(notes.values(), key=lambda note: note.created_at)
            del notes[oldest.key]

    def get_evidence(self, session_id: str) -> list[EvidenceNote]:
        self._evict()
        notes = self._evidence.get(session_id) or {}
        return sorted(notes.values(), key=lambda note: note.created_at)

    def _evict(self) -> None:
        ttl = get_settings().session_ttl_seconds
        cutoff = time.time() - ttl
        stale = [key for key, value in self._documents.items() if value.created_at < cutoff]
        for key in stale:
            del self._documents[key]

        for session_id, notes in list(self._evidence.items()):
            for key in [k for k, note in notes.items() if note.created_at < cutoff]:
                del notes[key]
            if not notes:
                del self._evidence[session_id]


_store: SessionStore | None = None


def get_session_store() -> SessionStore:
    global _store
    if _store is None:
        _store = SessionStore()
    return _store
