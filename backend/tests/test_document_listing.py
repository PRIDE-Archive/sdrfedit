import pytest
import json
from unittest.mock import AsyncMock

from app.parsing.base import ParsedDocument
from app.session import SessionStore
from app.tools import registry


async def test_publication_discovery_omits_content_and_duplicate_urls(monkeypatch):
    pdf = {"url": "https://example.org/paper.pdf", "license": "cc-by", "version": "publishedVersion"}
    monkeypatch.setattr(registry.literature, "lookup_publication", AsyncMock(return_value={
        "found": True, "status": "full_text_available", "pmcid": "PMC123", "title": "Paper",
        "fullTextAvailable": True, "abstract": "Long abstract" * 100,
        "journal": "Journal", "year": "2024", "pdfUrls": [pdf["url"]], "pdfCandidates": [pdf],
        "nextStep": "Try pdfUrls", "warnings": [],
    }))
    result = await registry._find_publication({"pmid": "123"}, "session")
    assert result["abstract"]["evidenceKind"] == "abstract"
    assert result["abstract"]["documentId"]
    assert result["supplements"]["status"] == "not_checked"
    assert "find_publication_supplements" in result["nextStep"]
    assert {k: result[k] for k in ("found", "status", "pmcid", "title", "fullTextAvailable", "pdfCandidates")} == {"found": True, "status": "full_text_available", "pmcid": "PMC123",
                      "title": "Paper", "fullTextAvailable": True, "pdfCandidates": [pdf]}
    assert "1 PDF link(s)" in registry._summarize_publication(result)


async def test_publication_confirmation_does_not_include_upstream_records(monkeypatch):
    monkeypatch.setattr(registry.literature, "lookup_publication", AsyncMock(return_value={
        "found": False, "status": "needs_confirmation", "nextStep": "Confirm identifiers",
        "candidates": [{"id": "123", "source": "MED", "title": "Paper", "abstractText": "Long abstract"}],
    }))
    result = await registry._find_publication({"title": "Paper"}, "session")
    assert result["status"] == "needs_confirmation"
    assert result["candidates"] == [{"pmid": "123", "title": "Paper"}]


@pytest.fixture
def documents(monkeypatch):
    store = SessionStore()
    monkeypatch.setattr(registry, "get_session_store", lambda: store)
    return store


async def test_listing_is_compact_and_document_can_still_be_read(documents):
    stored = documents.add_document(
        "session", "paper.xml", ParsedDocument("Article", {"methods": "Protocol"}),
        origin="https://example.org/paper",
        metadata={"title": "Example paper", "rawPath": "/internal/cache/paper.raw", "pmcid": "PMC123"},
    )
    documents.add_document("other", "private.pdf", ParsedDocument("Other"))
    result = await registry._list_documents({}, "session")
    assert result == {"documents": [{
        "documentId": stored.document_id, "fileName": "paper.xml",
        "title": "Example paper", "availableSections": ["methods"],
        "identifiers": {"pmcid": "PMC123"},
        "nextReads": [{"documentId": stored.document_id, "sections": ["methods"], "offset": 0}],
    }]}
    read = await registry._read_document({"documentId": stored.document_id, "sections": ["methods"]}, "session")
    assert read["sections"] == {"methods": "Protocol"}
    assert stored.metadata["rawPath"] == "/internal/cache/paper.raw"


async def test_plain_document_lists_readable_body_without_empty_title(documents):
    stored = documents.add_document("session", "notes.txt", ParsedDocument("Notes"))
    result = await registry._list_documents({}, "session")
    assert result == {"documents": [{
        "documentId": stored.document_id, "fileName": "notes.txt", "availableSections": ["body"],
        "identifiers": {},
        "nextReads": [{"documentId": stored.document_id, "sections": ["body"], "offset": 0}],
    }]}
    read = await registry._read_document({"documentId": stored.document_id, "sections": ["body"]}, "session")
    assert read["sections"] == {"body": "Notes"}


async def test_empty_session_returns_empty_list(documents):
    assert await registry._list_documents({}, "empty") == {"documents": []}


async def test_read_pages_reconstruct_all_sections_in_requested_order(documents):
    original = {"tables": "Table rows", "results": "abcdefghijklm"}
    stored = documents.add_document("s", "paper", ParsedDocument("", original))
    result = await registry._read_document({"documentId": stored.document_id,
        "sections": ["results", "tables", "absent"], "maxChars": 5}, "s")
    assert result["sections"] == {"results": "abcde"}
    assert result["missingSections"] == ["absent"]
    assert result["sectionInfo"]["tables"]["returnedChars"] == 0
    collected = dict(result["sections"])
    pending = result["nextReads"]
    while pending:
        read = await registry._read_document(pending.pop(0), "s")
        for name, text in read["sections"].items():
            collected[name] = collected.get(name, "") + text
        pending.extend(read["nextReads"])
    assert collected == original


@pytest.mark.parametrize("patch", [{"maxChars": 0}, {"maxChars": -1}, {"maxChars": True},
    {"maxChars": "100"}, {"offset": -1}, {"offset": 99}, {"sections": ["unknown"]},
    {"sections": ["results", "tables"], "offset": 1}])
async def test_read_rejects_invalid_arguments(documents, patch):
    stored = documents.add_document("s", "paper", ParsedDocument("", {"results": "abc", "tables": "xyz"}))
    result = await registry._read_document({"documentId": stored.document_id, "sections": ["results"], **patch}, "s")
    assert result["ok"] is False


async def test_dispatch_keeps_escaped_pages_valid_and_caps_large_requests(documents):
    original = '\x00"\\\n' * 10000
    stored = documents.add_document("s", "paper", ParsedDocument(original))
    args = {"documentId": stored.document_id, "sections": ["body"], "maxChars": 999999}
    collected = ""
    while args:
        raw = await registry.dispatch("read_document", args, "s")
        assert len(raw) <= registry.MAX_RESULT_CHARS
        result = json.loads(raw)
        assert result["ok"]
        chunk = result["sections"]["body"]
        assert 0 < len(chunk) <= registry.MAX_DOCUMENT_CHARS
        collected += chunk
        args = result["nextReads"][0] if result["nextReads"] else None
    assert collected == original


async def test_filename_mistake_returns_session_scoped_recovery_candidates(documents):
    stored = documents.add_document('session', 'PMC4047622.xml', ParsedDocument('', {'methods':'Protocol'}))
    other = documents.add_document('other', 'private.pdf', ParsedDocument('Secret'))
    result = await registry._read_document({'documentId':'PMC4047622.xml'}, 'session')
    assert result['status'] == 'document_not_found'
    assert result['availableDocuments'][0]['documentId'] == stored.document_id
    assert other.document_id not in json.dumps(result)
    assert 'Secret' not in json.dumps(result)
    recovered = await registry._read_document({'documentId':result['availableDocuments'][0]['documentId'], 'sections':['methods']}, 'session')
    assert recovered['sections']['methods'] == 'Protocol'


async def test_missing_document_recommends_discovery_and_public_reacquisition(documents):
    result = await registry._read_document({'documentId':'doc_missing'}, 'session')
    assert result['availableDocuments'] == []
    assert 'list_documents' in result['nextStep']
    assert 'get_publication_full_text' in result['nextStep']
    assert 'user-provided' in result['nextStep']


def test_replayed_evidence_keeps_document_id_separate_from_filename():
    from app.llm.agent import _evidence_note
    from app.llm.prompts import render_evidence
    note = _evidence_note('get_publication_full_text', {
        'ok': True, 'documentId':'doc_1234567890', 'fileName':'PMC4047622.xml',
        'availableSections':['methods','results'],
    })
    text = render_evidence([note[1]])
    assert 'documentId=doc_1234567890' in text
    assert 'fileName=PMC4047622.xml' in text
    assert 'never the fileName' in text
