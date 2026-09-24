import json
import pytest
from unittest.mock import AsyncMock
from app.llm.setup_gate import SetupGate
from app.llm.agent import _parse_actions
from app.parsing.base import ParsedDocument
from app.session import SessionStore
from app.tools import registry, templates
from app.llm import agent
from app.llm.client import StreamEvent, ToolCall
from app.schemas import ChatRequest


def action(op, args):
    return _parse_actions(json.dumps({"actions": [{"op": op, "argsJson": json.dumps(args)}]}), "setup")


@pytest.mark.parametrize("count", [-1, 0, 1.5, True, "10", 10001, 1000000000])
def test_invalid_counts_rejected(count):
    actions, rejected, _ = action("setSampleCount", [count])
    assert not actions and rejected


@pytest.mark.parametrize("count", [1, 10000])
def test_count_bounds_accepted(count):
    actions, rejected, _ = action("setSampleCount", [count])
    assert actions and not rejected


async def test_gate_requires_matching_read_content_not_all_pages(monkeypatch):
    store = SessionStore()
    monkeypatch.setattr(registry, "get_session_store", lambda: store)
    doc = store.add_document("s", "paper", ParsedDocument("", {"methods": "abcdef", "tables": "rows"}), metadata={"pmcid": "PMC1"})
    gate = SetupGate(store, "s", "PXD1")
    assert gate.reason()
    gate.observe("get_pride_metadata", {"accession": "PXD1"})
    gate.observe("find_publication", {"found": True, "pmcid": "PMC2"})
    read = await registry._read_document({"documentId": doc.document_id, "maxChars": 3}, "s")
    gate.observe("read_document", read)
    assert gate.reason()
    gate.observe("find_publication", {"found": True, "pmcid": "PMC1"})
    assert gate.reason() is None
    assert doc.unread_sections() == {"methods": 3, "tables": 0}
    for args in read["nextReads"]:
        args["maxChars"] = 12000
        gate.observe("read_document", await registry._read_document(args, "s"))
    assert gate.reason() is None
    gate.observe("find_publication", {"found": False, "status": "identifier_conflict"})
    assert "conflict" in gate.reason()


async def test_setup_rejected_without_read_evidence():
    gate = SetupGate(SessionStore(), "s")
    kept, rejected = await gate.filter(action("setSampleCount", [10])[0])
    assert not kept and rejected


async def test_pride_only_still_requires_metadata_and_valid_templates(monkeypatch):
    gate = SetupGate(SessionStore(), "s", "PXD1", pride_only=True)
    assert gate.reason()
    gate.observe("get_pride_metadata", {"accession": "PXD1"})
    monkeypatch.setattr(templates, "_load_manifest", AsyncMock(return_value={"templates": {"ms": {"layer": "technology"}}}))
    kept, rejected = await gate.filter(action("setTechnologyTemplate", ["fake"])[0])
    assert not kept and rejected
    kept, rejected = await gate.filter(action("setTechnologyTemplate", ["ms"])[0])
    assert kept[0].confidence == "low" and not rejected


@pytest.mark.parametrize("execution_mode", ["manual", "auto"])
async def test_prose_only_setup_returns_without_card_retry(monkeypatch, execution_mode):
    class Client:
        calls = 0
        def __init__(self, settings): pass
        async def stream(self, *args, **kwargs):
            Client.calls += 1
            if Client.calls == 2:
                yield StreamEvent(type="tool_calls", tool_calls=[ToolCall("p", "propose_wizard_actions", json.dumps({"actions": [{"op": "setSampleCount", "argsJson": "[3]"}]}))])
            else:
                yield StreamEvent(type="token", text="Here is the explanation.")
    monkeypatch.setattr(agent, "LlmClient", Client)
    monkeypatch.setattr(SetupGate, "reason", lambda self: None)
    request = ChatRequest(sessionId="test", messages=[{"role": "user", "content": "Help with setup"}], focusStep="setup", mode="step", executionMode=execution_mode)
    events = [event async for event in agent.run_agent(request)]
    assert not any(event["type"] == "actions" for event in events)
    assert "Here is the explanation." in events[-1]["result"]["content"]
    assert events[-1]["type"] == "done"
    assert Client.calls == 1


async def test_missing_evidence_does_not_force_cards_at_round_limit(monkeypatch):
    from types import SimpleNamespace
    class Client:
        calls = 0
        def __init__(self, settings): pass
        async def stream(self, *args, **kwargs):
            Client.calls += 1
            yield StreamEvent(type="tool_calls", tool_calls=[ToolCall("p", "propose_wizard_actions", json.dumps({"actions": [{"op": "setSampleCount", "argsJson": "[3]"}]}))])
    monkeypatch.setattr(agent, "LlmClient", Client)
    monkeypatch.setattr(agent, "get_settings", lambda: SimpleNamespace(llm_max_tool_rounds=1))
    monkeypatch.setattr(agent, "get_session_store", SessionStore)
    request = ChatRequest(sessionId="test", messages=[{"role": "user", "content": "Help with setup"}], focusStep="setup", mode="step")
    events = [event async for event in agent.run_agent(request)]
    assert not any(event["type"] == "actions" for event in events)
    assert "No setup cards" in events[-1]["result"]["content"]
    assert Client.calls == 1


@pytest.mark.parametrize("focus_step", ["setup", "characteristics"])
@pytest.mark.parametrize("execution_mode", ["manual", "auto"])
async def test_round_limit_returns_without_forced_card_request(monkeypatch, focus_step, execution_mode):
    from types import SimpleNamespace

    class Client:
        calls = 0

        def __init__(self, settings):
            pass

        async def stream(self, *args, **kwargs):
            Client.calls += 1
            yield StreamEvent(type="tool_calls", tool_calls=[
                ToolCall("p", "propose_wizard_actions", json.dumps({"actions": []}))
            ])

    monkeypatch.setattr(agent, "LlmClient", Client)
    monkeypatch.setattr(agent, "get_settings", lambda: SimpleNamespace(llm_max_tool_rounds=1))
    monkeypatch.setattr(agent, "get_session_store", SessionStore)
    monkeypatch.setattr(SetupGate, "reason", lambda self: None)
    request = ChatRequest(sessionId="test", messages=[{"role": "user", "content": "Help me annotate"}],
                          focusStep=focus_step, mode="step", executionMode=execution_mode)
    events = [event async for event in agent.run_agent(request)]
    assert Client.calls == 1
    assert not any(event["type"] == "actions" for event in events)
    assert events[-1]["type"] == "done"


async def test_read_progress_survives_turns_without_skipping_gaps(monkeypatch):
    store = SessionStore()
    monkeypatch.setattr(registry, "get_session_store", lambda: store)
    doc = store.add_document("s", "paper.pdf", ParsedDocument("methods", {"methods": "abcdefghij"}),
                             metadata={"doi": "10.1002/pmic.201400203"})

    def new_gate(doi="10.1002/pmic.201400203", session="s"):
        gate = SetupGate(store, session, "PXD1")
        gate.observe("get_pride_metadata", {"accession": "PXD1"})
        gate.observe("find_publication", {"found": True, "doi": doi, "fullTextAvailable": False})
        return gate

    await registry._read_document({"documentId": doc.document_id, "sections": ["methods"], "maxChars": 3}, "s")
    await registry._read_document({"documentId": doc.document_id, "sections": ["methods"], "offset": 6}, "s")
    assert new_gate().reason() is None
    assert doc.unread_sections() == {"methods": 3}
    await registry._read_document({"documentId": doc.document_id, "sections": ["methods"], "offset": 3, "maxChars": 3}, "s")
    assert new_gate().reason() is None
    assert new_gate("https://doi.org/10.1002/PMIC.201400203").reason() is None
    assert new_gate("10.123/another").reason()
    assert new_gate(session="other").reason()
    assert doc.read_ranges == {"methods": [(0, 10)]}
    assert (await registry._list_documents({}, "s"))["documents"][0]["nextReads"] == []


@pytest.mark.parametrize("source", ["scihub", "upload"])
async def test_pdf_intake_uses_mineru_and_becomes_readable_evidence(monkeypatch, source):
    import io
    from types import SimpleNamespace
    from starlette.datastructures import UploadFile
    from app.routers import uploads

    store = SessionStore()
    monkeypatch.setattr(registry, "get_session_store", lambda: store)
    monkeypatch.setattr(uploads, "get_session_store", lambda: store)
    pdf = b"%PDF-example"
    parser = SimpleNamespace(parse_bytes=AsyncMock(return_value=ParsedDocument(
        "Parsed full paper", {"methods": "Three samples.", "results": "Measured proteins.", "tables": "Sample table."},
        parser="mineru-api")))
    monkeypatch.setattr(registry, "get_pdf_parser", lambda: parser)
    monkeypatch.setattr(uploads, "get_pdf_parser", lambda: parser)
    publication = {"found": True, "status": "abstract_only", "fullTextAvailable": False,
                   "doi": "10.1002/pmic.201400203", "pmid": "25476145"}
    if source == "scihub":
        url = "https://pdf.example/paper.pdf"
        monkeypatch.setattr(registry.literature, "lookup_publication", AsyncMock(return_value={
            **publication, "pdfCandidates": [{"url": url, "source": "scihub"}]}))
        await registry._find_publication({"doi": publication["doi"], "useFallback": True}, "s")
        monkeypatch.setattr(registry, "cached_download", AsyncMock(return_value=(pdf, "/cache/paper")))
        result = await registry._parse_pdf_url({"url": url}, "s")
        doc_id = result["documentId"]
        assert result["parser"] == "mineru-api"
        assert result["metadata"]["doi"] == publication["doi"]
        assert result["metadata"]["pmid"] == publication["pmid"]
        assert (await registry._parse_pdf_url({"url": url}, "s"))["documentId"] == doc_id
        assert (await registry._parse_pdf_url({"url": url, "doi": "10.123/wrong"}, "s"))["status"] == "identifier_conflict"
    else:
        result = await uploads.upload_pdf(sessionId="s", file=UploadFile(io.BytesIO(pdf), filename="paper.pdf"))
        doc_id = result.documentId
        assert result.parser == "mineru-api"
    parser.parse_bytes.assert_awaited_once_with(pdf, "paper.pdf")

    def gate():
        value = SetupGate(store, "s", "PXD1", explicit_documents=[doc_id] if source == "upload" else [])
        value.observe("get_pride_metadata", {"accession": "PXD1"})
        value.observe("find_publication", publication)
        return value

    assert "unread sections" in gate().reason()
    read = await registry._read_document({"documentId": doc_id, "sections": ["methods", "results", "tables"]}, "s")
    assert read["sections"]["methods"] == "Three samples."
    assert gate().reason() is None
    accepted, rejected = await gate().filter(action("setSampleCount", [3])[0])
    assert accepted and not rejected
    if source == "scihub":
        monkeypatch.setattr(registry.literature, "lookup_publication", AsyncMock(return_value=publication))
        result = await registry._find_publication({"doi": publication["doi"]}, "s")
        assert result["fullTextAvailable"] is False
        assert result["sessionDocuments"][0]["documentId"] == doc_id
        assert result["sessionDocuments"][0]["nextReads"] == []
        assert "already parsed" in result["nextStep"]


@pytest.mark.parametrize('heading', ['main text', 'full text', 'body', '2 main text'])
async def test_mineru_main_text_is_full_paper_evidence(monkeypatch, heading):
    from app.parsing.base import split_markdown_sections
    store = SessionStore()
    monkeypatch.setattr(registry, 'get_session_store', lambda: store)
    # Real MinerU section layout for DOI 10.1002/pmic.201400203; no paper text copied.
    doc = store.add_document('s', 'paper.pdf', ParsedDocument('Parsed paper', {
        'abstract': 'Summary',
        'proteomic analysis of n-glycosylation of human seminal plasma': 'Authors',
        'correspondence': 'Contact details',
        heading: 'Actual study methods and results',
        'acknowledgments': 'Thanks', 'supporting information': 'Supplementary files',
        'references': 'Bibliography',
    }, parser='mineru-official'), metadata={'doi': '10.1002/pmic.201400203'})
    gate = SetupGate(store, 's', 'PXD000959')
    gate.observe('get_pride_metadata', {'accession': 'PXD000959'})
    gate.observe('find_publication', {'found': True, 'doi': '10.1002/pmic.201400203', 'fullTextAvailable': False})
    assert heading in gate.reason()
    pending = registry._document_result(doc)['nextReads']
    assert {'documentId': doc.document_id, 'sections': [heading], 'offset': 0} in pending
    for page in pending:
        await registry._read_document(page, 's')
    assert gate.reason() is None
    assert split_markdown_sections(f'# {heading}\nActual study methods and results')['body']


async def test_abstract_only_document_is_not_full_paper(monkeypatch):
    store = SessionStore()
    monkeypatch.setattr(registry, 'get_session_store', lambda: store)
    doc = store.add_document('s', 'abstract.txt', ParsedDocument('Summary', {'abstract': 'Summary'}), metadata={'evidenceKind': 'abstract'})
    await registry._read_document({'documentId': doc.document_id}, 's')
    assert SetupGate(store, 's').reason() is not None


async def test_title_and_nested_headings_survive_reused_turn(monkeypatch):
    store = SessionStore()
    monkeypatch.setattr(registry, 'get_session_store', lambda: store)
    doc = store.add_document('s', 'paper.pdf', ParsedDocument('Paper', {
        'n-terminome analysis of the human mitochondrial proteome': 'Study description',
        'keywords': 'Human; mitochondria',
        '2.1 cell preparation': 'Actual sample preparation',
        'references': 'References',
    }, parser='mineru-official'), metadata={'doi': '10.1002/pmic.201400617'})
    gate = SetupGate(store, 's', 'PXD001522')
    gate.observe('get_pride_metadata', {'accession': 'PXD001522'})
    gate.observe('find_publication', {'found': True, 'doi': '10.1002/pmic.201400617'})
    await registry._read_document({'documentId': doc.document_id, 'sections': ['n-terminome analysis of the human mitochondrial proteome']}, 's')
    assert gate.reason() is None
    assert '2.1 cell preparation' in doc.unread_sections()
    await registry._read_document({'documentId': doc.document_id, 'sections': ['2.1 cell preparation']}, 's')
    assert gate.reason() is None
    resumed = SetupGate(store, 's', 'PXD001522')
    assert resumed.reason() is None
    resumed.observe('find_publication', {'found': False, 'status': 'unavailable'})
    assert resumed.reason() is None
    assert SetupGate(store, 's', 'PXD001523').reason()
    assert SetupGate(store, 'another-session', 'PXD001522').reason()
    resumed.observe('find_publication', {'found': False, 'status': 'identifier_conflict'})
    assert 'conflict' in SetupGate(store, 's', 'PXD001522').reason()


async def test_gate_diagnostics_identify_missing_identity_instead_of_reread(monkeypatch):
    store = SessionStore()
    monkeypatch.setattr(registry, 'get_session_store', lambda: store)
    doc = store.add_document('s', 'paper.pdf', ParsedDocument('Text', {'body': 'Text'}), metadata={'doi': '10.123/test'})
    await registry._read_document({'documentId': doc.document_id}, 's')
    gate = SetupGate(store, 's', 'PXD1')
    gate.observe('get_pride_metadata', {'accession': 'PXD1'})
    assert 'publication identity not resolved' in gate.reason()
    gate.observe('find_publication', {'found': True, 'doi': '10.123/wrong'})
    assert 'conflicts' in gate.reason()


@pytest.mark.parametrize('heading', ['references', 'abstract', '自定义标题', 'sample allocation', 'Sheet 7'])
async def test_heading_labels_never_determine_proposal_eligibility(monkeypatch, heading):
    store = SessionStore()
    monkeypatch.setattr(registry, 'get_session_store', lambda: store)
    doc = store.add_document('s', 'paper.pdf', ParsedDocument('Evidence', {
        heading.lower(): 'Evidence for a supported template.', 'unrelated appendix': 'Not needed for this field.'
    }), metadata={'evidenceKind': 'article'})
    gate = SetupGate(store, 's')
    assert gate.reason()
    await registry._read_document({'documentId': doc.document_id, 'sections': [heading.lower()], 'maxChars': 10}, 's')
    assert gate.reason() is None
    status = doc.reading_status()
    assert status[heading.lower()]['readRanges'] == [(0, 10)]
    assert status['unrelated appendix']['readChars'] == 0
    assert doc.unread_sections()[heading.lower()] == 10
