"""Full PRIDE evidence survives request boundaries without repeated HTTP calls."""
import asyncio
from copy import deepcopy
import json
from unittest.mock import AsyncMock

import pytest

from app.llm import agent
from app.llm.client import StreamEvent, ToolCall
from app.schemas import ChatRequest
from app.session import SessionStore
from app.tools import pride, registry


@pytest.fixture
def store(monkeypatch):
    store = SessionStore()
    monkeypatch.setattr(registry, 'get_session_store', lambda: store)
    monkeypatch.setattr(agent, 'get_session_store', lambda: store)
    return store


async def test_full_metadata_replayed_on_next_request(store, monkeypatch):
    payload = {
        'accession': 'PXD000070', 'title': 'Full evidence',
        'description': 'description ' * 3000 + 'DESCRIPTION_TAIL',
        'sampleProcessingProtocol': 'sample protocol ' * 1000 + 'SAMPLE_TAIL',
        'dataProcessingProtocol': 'analysis ' * 1000 + 'ANALYSIS_TAIL',
        'sampleAttributes': [f'sample: S{i}' for i in range(85)],
        'softwares': ['Software 1'],
        'identifiedPtms': [f'MOD:{i}' for i in range(12)],
        'references': [{'pubmedId': str(i), 'doi': f'10.test/{i}'} for i in range(8)],
    }
    fetch = AsyncMock(return_value=payload)
    monkeypatch.setattr(pride, 'fetch_project', fetch)
    requests = []

    class Client:
        def __init__(self, settings):
            pass

        async def stream(self, messages, tools):
            requests.append(deepcopy(messages))
            if len(requests) == 1:
                yield StreamEvent(type='tool_calls', tool_calls=[
                    ToolCall('pride-call', 'get_pride_metadata', '{"accession":"pxd000070"}')])
            else:
                yield StreamEvent(type='token', text='Ready.')

    monkeypatch.setattr(agent, 'LlmClient', Client)
    for _ in range(2):
        request = ChatRequest(sessionId='same-session', accession='PXD000070',
                              focusStep='samples', messages=[{'role': 'user', 'content': 'Continue'}])
        _events = [event async for event in agent.run_agent(request)]
    assert len(requests) == 3
    original = next(m['content'] for m in requests[1] if m['role'] == 'tool')
    assert json.loads(original) == payload
    replay = requests[2][0]['content'].split(
        'Use these full results directly; do not call get_pride_metadata again for these accessions.\n', 1)[1]
    restored, _ = json.JSONDecoder().raw_decode(replay)
    assert restored == [payload]
    assert fetch.await_count == 1
    assert store.get_evidence('same-session') == []
    repeated = json.loads(await registry.dispatch('get_pride_metadata',
                          {'accession': ' PXD000070 '}, 'same-session'))
    assert repeated == payload
    assert fetch.await_count == 1


@pytest.mark.parametrize('kind,tool,fetch_name', [
    ('pride_metadata', 'get_pride_metadata', 'fetch_project'),
    ('pride_raw_files', 'get_pride_raw_files', 'fetch_raw_files'),
])
async def test_cache_isolation_and_concurrent_deduplication(store, monkeypatch, kind, tool, fetch_name):
    async def fetch(accession):
        await asyncio.sleep(0)
        return {'accession': accession, 'sampleAttributes': ['original']}

    mocked = AsyncMock(side_effect=fetch)
    monkeypatch.setattr(pride, fetch_name, mocked)
    read = getattr(store, kind)
    results = await asyncio.gather(*[
        registry.dispatch(tool, {'accession': 'PXD000070'}, 'a') for _ in range(3)])
    assert len(set(results)) == 1
    assert mocked.await_count == 1
    await registry.dispatch(tool, {'accession': 'PXD000071'}, 'a')
    await registry.dispatch(tool, {'accession': 'PXD000070'}, 'b')
    assert mocked.await_count == 3
    assert len(read('a')) == 2
    assert len(read('b')) == 1
    assert read('other') == []
    records = read('a', 'PXD000070')
    assert len(records) == 1
    records[0]['sampleAttributes'].append('mutation')
    assert read('a', 'PXD000070')[0]['sampleAttributes'] == ['original']


@pytest.mark.parametrize('kind,tool,fetch_name', [
    ('pride_metadata', 'get_pride_metadata', 'fetch_project'),
    ('pride_raw_files', 'get_pride_raw_files', 'fetch_raw_files'),
])
async def test_failures_are_retryable_and_expired_results_are_refetched(store, monkeypatch, kind, tool, fetch_name):
    fetch = AsyncMock(side_effect=[RuntimeError('temporary'), {'accession': 'PXD000070'},
                                  {'accession': 'PXD000070', 'title': 'updated'}])
    monkeypatch.setattr(pride, fetch_name, fetch)
    read = getattr(store, kind)
    args = {'accession': 'PXD000070'}
    assert 'error' in json.loads(await registry.dispatch(tool, args, 'a'))
    assert read('a') == []
    assert json.loads(await registry.dispatch(tool, args, 'a')) == args
    getattr(store, '_' + kind)[('a', 'PXD000070')] = (0, args)
    assert read('a') == []
    result = json.loads(await registry.dispatch(tool, args, 'a'))
    assert result['title'] == 'updated'
    assert fetch.await_count == 3


async def test_complete_raw_catalogue_replayed_and_urls_attached_next_turn(store, monkeypatch):
    names = [f'run_{i:04d}.raw' for i in range(850)]
    urls = {name: f'ftp://ftp.pride.ebi.ac.uk/pride/data/archive/2026/01/PXD000070/{name}'
            for name in names}
    upstream = AsyncMock(return_value=[
        {'fileName': name, 'fileCategory': {'value': 'RAW'},
         'publicFileLocations': [{'value': urls[name]}]} for name in names
    ] + [{'fileName': 'search.dat', 'fileCategory': 'SEARCH'}])
    monkeypatch.setattr(pride, 'get_json', upstream)
    requests = []

    class Client:
        def __init__(self, settings):
            pass

        async def stream(self, messages, tools):
            requests.append(deepcopy(messages))
            if len(requests) == 1:
                yield StreamEvent(type='tool_calls', tool_calls=[
                    ToolCall('raw', 'get_pride_raw_files', '{"accession":"pxd000070"}')])
            elif len(requests) == 3:
                yield StreamEvent(type='tool_calls', tool_calls=[ToolCall('apply', agent.PROPOSE_TOOL_NAME,
                    json.dumps({'actions': [{'op': 'replaceWithUnassignedFileNames',
                                            'argsJson': json.dumps([[names[-1]]])}]}))])
            else:
                yield StreamEvent(type='token', text='Ready.')

    monkeypatch.setattr(agent, 'LlmClient', Client)
    request = ChatRequest(sessionId='raw-session', accession='PXD000070', focusStep='runs-files',
                          messages=[{'role': 'user', 'content': 'Continue'}])
    _first = [event async for event in agent.run_agent(request)]
    second = [event async for event in agent.run_agent(request)]
    original = next(m['content'] for m in requests[1] if m['role'] == 'tool')
    assert len(original) > registry.MAX_RESULT_CHARS
    expected = {'accession': 'PXD000070', 'rawFileCount': 850, 'totalFileCount': 851,
                'rawFileNames': names, 'fileUrls': urls, 'truncated': False}
    assert json.loads(original) == expected
    replay = requests[2][0]['content'].split(
        'Use these full results directly; do not call get_pride_raw_files again for these accessions.\n', 1)[1]
    restored, _ = json.JSONDecoder().raw_decode(replay)
    assert restored == [expected]
    assert store.get_evidence('raw-session') == []
    action = second[-1]['result']['actions'][0]
    assert action['args'] == [[names[-1]], {names[-1]: urls[names[-1]]}]
    # Legacy callers supplying limit must not poison the complete cache.
    repeated = await registry.dispatch('get_pride_raw_files',
                                      {'accession': 'PXD000070', 'limit': 2}, 'raw-session')
    assert json.loads(repeated) == expected
    assert upstream.await_count == 1
    declaration = registry._BY_NAME['get_pride_raw_files']['declaration']
    assert 'limit' not in declaration['parameters']['properties']
