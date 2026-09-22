"""Progress remains visible between tools without extra LLM calls or user turns."""
from copy import deepcopy
from unittest.mock import AsyncMock

from app.llm import agent
from app.llm.client import StreamEvent, ToolCall
from app.schemas import ChatRequest
from app.session import SessionStore


async def test_silent_rounds_prompt_visible_conclusion_and_resume_tools(monkeypatch):
    requests = []
    conclusion = '已获取资料，但尚未确认独立样本数量。接下来核对实验设计。'

    class Client:
        def __init__(self, settings):
            pass

        async def stream(self, messages, tools):
            requests.append(deepcopy(messages))
            turn = len(requests)
            if turn == 3:
                yield StreamEvent(type='token', text='<think>Internal analysis</think>' + conclusion)
            if turn <= 3:
                yield StreamEvent(type='tool_calls', tool_calls=[ToolCall(str(turn), 'list_documents', '{}')])
            else:
                yield StreamEvent(type='token', text='目前资料不足以确定样本数。')

    monkeypatch.setattr(agent, 'LlmClient', Client)
    monkeypatch.setattr(agent, 'get_session_store', lambda: SessionStore())
    monkeypatch.setattr(agent.registry, 'dispatch', AsyncMock(return_value='{"documents": []}'))
    request = ChatRequest(sessionId='progress-test', focusStep='setup',
                          messages=[{'role': 'user', 'content': '帮我检查实验设计'}])
    events = [event async for event in agent.run_agent(request)]
    assert len(requests) == 4
    assert 'Progress update due:' not in requests[1][0]['content']
    assert 'Progress update due:' in requests[2][0]['content']
    assert 'Progress update due:' not in requests[3][0]['content']
    for messages in requests:
        assert sum(m['role'] == 'system' for m in messages) == 1
        assert sum(m['role'] == 'user' for m in messages) == 1
    progress_index = next(i for i, e in enumerate(events) if e['type'] == 'token' and conclusion in e['text'])
    next_tool_index = next(i for i, e in enumerate(events) if e['type'] == 'tool_start' and e['tool']['id'] == '3')
    assert progress_index < next_tool_index
    visible = ''.join(e['text'] for e in events if e['type'] == 'token')
    assert 'Internal analysis' not in visible
    assert events[-1]['type'] == 'done'
    assert conclusion in events[-1]['result']['content']
