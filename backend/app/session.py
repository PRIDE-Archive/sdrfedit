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
    read_ranges: dict[str, list[tuple[int, int]]] = field(default_factory=dict)

    def evidence_sections(self) -> dict[str, str]:
        if self.metadata.get("evidenceKind") == "abstract":
            return {}
        if self.metadata.get("evidenceKind") == "supplement":
            return {name: text for name, text in (self.document.sections or {"body": self.document.markdown}).items() if text.strip()}
        return self.document.evidence_sections()

    def reading_status(self) -> dict:
        sections = self.document.sections or {"body": self.document.markdown}
        return {name: {"totalChars": len(text), "readRanges": self.read_ranges.get(name, []),
                       "readChars": sum(end - start for start, end in self.read_ranges.get(name, []))}
                for name, text in sections.items()}

    def unread_sections(self) -> dict[str, int]:
        sections = self.document.sections or {"body": self.document.markdown}
        pending = {}
        for name in sections:
            end = 0
            for start, stop in sorted(self.read_ranges.get(name, [])):
                if start > end:
                    break
                end = max(end, stop)
            if end < len(sections[name]):
                pending[name] = end
        return pending


@dataclass
class EvidenceNote:
    """A compact record of something a tool established, keyed for de-duplication."""

    key: str
    text: str
    created_at: float = field(default_factory=time.time)


class SessionStore:
    def __init__(self) -> None:
        self._documents: dict[str, StoredDocument] = {}
        self._setup_context: dict[tuple[str, str | None], tuple[float, dict]] = {}
        self._evidence: dict[str, dict[str, EvidenceNote]] = {}
        self._pdf_sources: dict[str, dict[str, tuple[str, float, dict]]] = {}

    def setup_context(self, session_id: str, accession: str | None) -> dict:
        self._evict()
        return dict(self._setup_context.get((session_id, accession), (0, {}))[1])

    def save_setup_context(self, session_id: str, accession: str | None, context: dict) -> None:
        self._evict()
        self._setup_context[(session_id, accession)] = (time.time(), dict(context))

    def remember_pdf_source(self, session_id: str, url: str, source: str, identifiers: dict | None = None) -> None:
        """Keep discovery provenance so downloads need no model-supplied proxy flags."""
        self._evict()
        sources = self._pdf_sources.setdefault(session_id, {})
        sources[url] = (source, time.time(), dict(identifiers or {}))
        while len(sources) > 64:
            del sources[min(sources, key=lambda key: sources[key][1])]

    def pdf_source(self, session_id: str, url: str) -> str | None:
        self._evict()
        entry = self._pdf_sources.get(session_id, {}).get(url)
        return entry[0] if entry else None

    def pdf_identifiers(self, session_id: str, url: str) -> dict:
        self._evict()
        entry = self._pdf_sources.get(session_id, {}).get(url)
        return dict(entry[2]) if entry else {}

    def record_document_read(self, session_id: str, document_id: str, info: dict) -> None:
        doc = self.get(document_id)
        if not doc or doc.session_id != session_id:
            return
        sections = doc.document.sections or {"body": doc.document.markdown}
        for name, page in info.items():
            start, count = page.get("offset"), page.get("returnedChars")
            if (name not in sections or type(start) is not int or type(count) is not int
                    or start < 0 or count <= 0 or start + count > len(sections[name])):
                continue
            merged = []
            for left, right in sorted([*doc.read_ranges.get(name, []), (start, start + count)]):
                if merged and left <= merged[-1][1]:
                    merged[-1] = (merged[-1][0], max(merged[-1][1], right))
                else:
                    merged.append((left, right))
            doc.read_ranges[name] = merged

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
        for key, (created_at, _) in list(self._setup_context.items()):
            if created_at < cutoff:
                del self._setup_context[key]
        stale = [key for key, value in self._documents.items() if value.created_at < cutoff]
        for key in stale:
            del self._documents[key]

        for session_id, notes in list(self._evidence.items()):
            for key in [k for k, note in notes.items() if note.created_at < cutoff]:
                del notes[key]
            if not notes:
                del self._evidence[session_id]

        for session_id, sources in list(self._pdf_sources.items()):
            for url in [url for url, (_, created_at, _) in sources.items() if created_at < cutoff]:
                del sources[url]
            if not sources:
                del self._pdf_sources[session_id]


_store: SessionStore | None = None


def get_session_store() -> SessionStore:
    global _store
    if _store is None:
        _store = SessionStore()
    return _store
