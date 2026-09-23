"""Automatic execution is opt-in; manual requests keep their existing contract."""

import json
from copy import deepcopy

import pytest

from app.llm import agent
from app.llm.auto_annotation import automatic_proposal_tool, parse_automation_report
from app.llm.client import StreamEvent, ToolCall
from app.llm.prompts import PROPOSE_ACTIONS_TOOL
from app.schemas import ChatRequest
from app.schemas import WizardSnapshot
from app.llm.prompts import render_wizard_context
from app.session import SessionStore


def test_automatic_tool_does_not_modify_manual_tool():
    original = deepcopy(PROPOSE_ACTIONS_TOOL)
    tool = automatic_proposal_tool()
    assert 'automation' in tool['function']['parameters']['required']
    assert PROPOSE_ACTIONS_TOOL == original
    assert 'automation' not in PROPOSE_ACTIONS_TOOL['function']['parameters']['properties']
    assert ChatRequest(sessionId='manual', messages=[]).executionMode == 'manual'


@pytest.mark.parametrize('payload', ['{}', '{broken', '[]', '{"automation": {"status": "done"}}'])
def test_missing_or_invalid_completion_report_blocks(payload):
    report = parse_automation_report(payload, [])
    assert report.status == 'blocked'
    assert report.issues


def test_rejected_actions_and_outstanding_issues_cannot_report_ready():
    ready = json.dumps({'automation': {'status': 'ready', 'issues': []}})
    assert parse_automation_report(ready, []).status == 'ready'
    rejected = parse_automation_report(ready, ['Unknown sample'])
    assert rejected.status == 'blocked'
    assert rejected.issues == ['Unknown sample']
    report = parse_automation_report(json.dumps({'automation': {'status': 'ready', 'issues': ['Missing paper']}}), [])
    assert report.status == 'blocked'


def test_detailed_snapshot_preserves_assignments_without_changing_legacy_context():
    assert 'existing per-sample assignments' not in render_wizard_context(WizardSnapshot())
    snapshot = WizardSnapshot(sampleAssignments=[{
        'index': 0, 'sourceName': 'donor_B', 'biologicalReplicate': 2,
        'characteristicValues': {'characteristics[compound]': 'treated'},
        'factorValues': {'time': '24 hour'},
    }])
    context = render_wizard_context(snapshot)
    assert 'zero-based action indices' in context
    assert 'donor_B' in context and '24 hour' in context and 'treated' in context


@pytest.mark.parametrize('mode', ['manual', 'auto'])
async def test_agent_scopes_automatic_prompt_and_returns_report_only_for_auto(monkeypatch, mode):
    requests = []
    proposals = []

    class Client:
        def __init__(self, settings):
            pass

        async def stream(self, messages, tools):
            requests.append(deepcopy(messages))
            proposals.append(next(t for t in tools if t['function']['name'] == 'propose_wizard_actions'))
            if len(requests) == 1:
                yield StreamEvent(type='tool_calls', tool_calls=[ToolCall('proposal', 'propose_wizard_actions', json.dumps({
                    'actions': [{'op': 'setPrecursorMassTolerance', 'argsJson': '["10 ppm"]', 'label': 'Tolerance'}],
                    'automation': {'status': 'ready', 'issues': []},
                }))])
            else:
                yield StreamEvent(type='token', text='Protocol ready.')

    monkeypatch.setattr(agent, 'LlmClient', Client)
    monkeypatch.setattr(agent, 'get_session_store', lambda: SessionStore())
    request = ChatRequest(sessionId='auto-test', executionMode=mode, focusStep='protocol',
                          messages=[{'role': 'user', 'content': 'Set tolerance from my methods.'}])
    events = [event async for event in agent.run_agent(request)]
    assert events[-1]['type'] == 'done'
    result = events[-1]['result']
    assert result['actions'][0]['op'] == 'setPrecursorMassTolerance'
    assert ('Automatic annotation is explicitly enabled' in requests[0][0]['content']) == (mode == 'auto')
    assert ('automation' in proposals[0]['function']['parameters']['required']) == (mode == 'auto')
    assert result['automation'] == ({'status': 'ready', 'issues': []} if mode == 'auto' else None)


async def test_automatic_report_does_not_bypass_step_gate(monkeypatch):
    count = 0

    class Client:
        def __init__(self, settings):
            pass

        async def stream(self, messages, tools):
            nonlocal count
            count += 1
            if count == 1:
                yield StreamEvent(type='tool_calls', tool_calls=[ToolCall('proposal', 'propose_wizard_actions', json.dumps({
                    'actions': [{'op': 'setSampleCount', 'argsJson': '[2]', 'label': 'Wrong step'}],
                    'automation': {'status': 'ready', 'issues': []},
                }))])
            else:
                yield StreamEvent(type='token', text='Cannot complete.')

    monkeypatch.setattr(agent, 'LlmClient', Client)
    monkeypatch.setattr(agent, 'get_session_store', lambda: SessionStore())
    events = [event async for event in agent.run_agent(ChatRequest(
        sessionId='auto-gate', executionMode='auto', focusStep='protocol', messages=[]))]
    result = events[-1]['result']
    assert result['actions'] == []
    assert result['automation']['status'] == 'blocked'
    assert result['automation']['issues']
