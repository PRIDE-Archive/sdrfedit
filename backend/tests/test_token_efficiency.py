"""Terminal auto proposals save a round without bypassing gates or evidence."""
import json
from unittest.mock import AsyncMock

import httpx
import pytest

from app.config import Settings
from app.llm import agent
from app.llm.client import LlmClient, StreamEvent, ToolCall
from app.schemas import ChatRequest
from app.session import SessionStore


@pytest.mark.parametrize('case,expected_rounds', [
    ('ready', 1), ('noop', 1), ('manual', 2), ('blocked', 2),
    ('rejected', 2), ('mixed', 2), ('missing_report', 2),
])
async def test_terminal_proposal_conditions(monkeypatch, case, expected_rounds):
    count = 0
    dispatch = AsyncMock(return_value='{"documents": []}')
    class Client:
        def __init__(self, settings): pass
        async def stream(self, messages, tools):
            nonlocal count
            count += 1
            yield StreamEvent(type='usage', usage={'prompt_tokens': 123, 'completion_tokens': 45})
            if count > 1:
                yield StreamEvent(type='token', text='Follow-up complete.')
                return
            actions = [] if case == 'noop' else [{'op': 'setPrecursorMassTolerance', 'argsJson': '["10 ppm"]'}]
            if case == 'rejected': actions = [{'op': 'setSampleCount', 'argsJson': '[2]'}]
            payload = {'actions': actions}
            if case != 'missing_report':
                payload['automation'] = {'status': 'blocked' if case == 'blocked' else 'ready',
                                         'issues': ['Missing evidence'] if case == 'blocked' else []}
            calls = [ToolCall('p', 'propose_wizard_actions', json.dumps(payload))]
            if case == 'mixed': calls.append(ToolCall('d', 'list_documents', '{}'))
            yield StreamEvent(type='tool_calls', tool_calls=calls)
    monkeypatch.setattr(agent, 'LlmClient', Client)
    monkeypatch.setattr(agent, 'get_session_store', lambda: SessionStore())
    monkeypatch.setattr(agent.registry, 'dispatch', dispatch)
    events = [e async for e in agent.run_agent(ChatRequest(
        sessionId='efficiency', executionMode='manual' if case == 'manual' else 'auto',
        focusStep='protocol', messages=[]))]
    result = events[-1]['result']
    assert count == expected_rounds
    assert result['trace']['llmRounds'] == count
    assert result['trace']['stoppedAfterReady'] == (expected_rounds == 1)
    assert result['trace']['llmRoundMetrics'][0]['usage']['prompt_tokens'] == 123
    if case == 'mixed': dispatch.assert_awaited_once()
    if case == 'rejected':
        assert not result['actions']
        assert result['automation']['status'] == 'blocked'


@pytest.mark.parametrize('include_usage', [True, False])
async def test_client_reads_usage_only_chunk_without_changing_default_contract(monkeypatch, include_usage):
    actual_client = httpx.AsyncClient
    usage = {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120,
             'prompt_tokens_details': {'cached_tokens': 80}}
    def handle(request):
        body = json.loads(request.content)
        assert body.get('stream_options') == ({'include_usage': True} if include_usage else None)
        return httpx.Response(200, text='data: ' + json.dumps({'choices': [], 'usage': usage}) + '\n\ndata: [DONE]\n\n')
    monkeypatch.setattr('app.llm.client.httpx.AsyncClient',
                        lambda **kwargs: actual_client(transport=httpx.MockTransport(handle), **kwargs))
    client = LlmClient(Settings(llm_base_url='http://localhost/v1', llm_stream_include_usage=include_usage))
    events = [e async for e in client.stream([{'role': 'user', 'content': 'test'}])]
    assert events[0].type == 'usage' and events[0].usage == usage
    assert events[-1].type == 'done'


@pytest.mark.parametrize('step', ['setup', 'samples', 'runs-files', 'protocol', 'review'])
def test_skill_scoping_preserves_shared_and_current_procedures(step):
    import re
    from app.skills import parse_slash_command
    from app.llm.prompts import render_annotation_skill
    original = parse_slash_command('/sdrf-annotate').instructions
    scoped = render_annotation_skill(original, step)
    for part in re.split(r'(?=^### )', original, flags=re.MULTILINE):
        match = re.match(r'### When focus is `([^`]+)`', part)
        active = {'samples', 'characteristics'} if step == 'samples' else {step}
        if not match or match.group(1) in active:
            assert part in scoped
        else:
            assert part not in scoped
    assert len(scoped) < len(original)
    assert '## Rules' in scoped and '### After proposing' in scoped


@pytest.mark.parametrize('step', ['setup', 'samples'])
async def test_ready_noop_does_not_emit_missing_cards_warning(monkeypatch, step):
    class Client:
        def __init__(self, settings): pass
        async def stream(self, messages, tools):
            yield StreamEvent(type='tool_calls', tool_calls=[ToolCall('noop', 'propose_wizard_actions',
                json.dumps({'actions': [], 'automation': {'status': 'ready', 'issues': [], 'notes': ['Existing values match.']}}))])
    monkeypatch.setattr(agent, 'LlmClient', Client)
    monkeypatch.setattr(agent, 'get_session_store', lambda: SessionStore())
    events = [e async for e in agent.run_agent(ChatRequest(
        sessionId='noop', mode='step', focusStep=step, executionMode='auto', messages=[]))]
    result = events[-1]['result']
    assert result['content'] == ''
    assert result['automation']['status'] == 'ready'
    assert result['trace']['llmRounds'] == 1
    assert result['trace']['llmRoundMetrics'][0]['usage'] is None
    assert not any('No characteristic' in e.get('text', '') or 'No setup cards' in e.get('text', '') for e in events)
