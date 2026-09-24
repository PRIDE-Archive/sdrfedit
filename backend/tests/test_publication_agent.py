"""Exercise discovery results through agent post-processing, not just the tool."""
import json
from unittest.mock import AsyncMock

import pytest

from app.llm import agent
from app.llm.client import StreamEvent, ToolCall
from app.schemas import ChatRequest
from app.session import SessionStore
from app.tools import registry


@pytest.mark.parametrize('abstract,expected', [
    ({'status': 'ready', 'documentId': 'doc_123', 'evidenceKind': 'abstract'}, ''),
    ({'status': 'not_available'}, ''),
    (None, ''), ('Legacy abstract', 'Legacy abstract'), ('x' * 500, 'x' * 320),
])
def test_citations_accept_document_descriptor(abstract, expected):
    citations = agent._citations_from_tool('find_publication', {
        'found': True, 'title': 'Paper', 'url': 'https://doi.org/10.123/test', 'abstract': abstract})
    assert citations[0].snippet == expected


@pytest.mark.parametrize('execution_mode', ['manual', 'auto'])
async def test_real_discovery_contract_completes_agent_stream(monkeypatch, execution_mode):
    store = SessionStore()
    monkeypatch.setattr(registry, 'get_session_store', lambda: store)
    monkeypatch.setattr(agent, 'get_session_store', lambda: store)
    monkeypatch.setattr(registry.literature, 'lookup_publication', AsyncMock(return_value={
        'found': True, 'pmid': '25944712', 'doi': '10.1002/pmic.201400617',
        'title': 'N-terminome analysis', 'abstract': 'The study summary.',
        'fullTextAvailable': False, 'url': 'https://doi.org/10.1002/pmic.201400617'}))

    class Client:
        def __init__(self, settings):
            self.calls = 0

        async def stream(self, messages, tools):
            self.calls += 1
            if self.calls == 1:
                yield StreamEvent(type='tool_calls', tool_calls=[ToolCall(
                    'publication', 'find_publication', json.dumps({'pmid': '25944712'}))])
            elif self.calls == 2:
                result = json.loads(messages[-1]['content'])
                yield StreamEvent(type='tool_calls', tool_calls=[ToolCall(
                    'read', 'read_document', json.dumps({'documentId': result['abstract']['documentId']}))])
            else:
                yield StreamEvent(type='token', text='Abstract retrieved; supplementary evidence is still needed.')

    monkeypatch.setattr(agent, 'LlmClient', Client)
    request = ChatRequest(sessionId='test', messages=[{'role': 'user', 'content': 'Find the paper'}],
                          focusStep='setup', mode='step', executionMode=execution_mode)
    events = [event async for event in agent.run_agent(request)]
    assert not any(event['type'] == 'error' for event in events)
    assert events[-1]['type'] == 'done'
    result = events[-1]['result']
    assert 'Abstract retrieved' in result['content']
    assert result['citations'][0]['title'] == 'N-terminome analysis'
    assert [call['name'] for call in result['toolCalls']] == ['find_publication', 'read_document']
