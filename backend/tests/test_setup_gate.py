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


async def test_gate_requires_matching_paper_and_complete_pages(monkeypatch):
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
    assert gate.reason()
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


async def test_prose_only_setup_gets_one_card_retry(monkeypatch):
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
    request = ChatRequest(sessionId="test", messages=[{"role": "user", "content": "Help with setup"}], focusStep="setup", mode="step")
    events = [event async for event in agent.run_agent(request)]
    assert len([event for event in events if event["type"] == "actions"]) == 1
    assert events[-1]["type"] == "done"
    assert Client.calls == 3


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
