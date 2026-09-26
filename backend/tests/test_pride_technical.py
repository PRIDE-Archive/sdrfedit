"""Agent adapter: real dispatch, scoped discovery, budgets, and cached evidence."""
import asyncio
import json
from unittest.mock import AsyncMock

import httpx
import pytest

from app.llm import agent
from app.llm.client import StreamEvent, ToolCall
from app.llm.prompts import SYSTEM_PROMPT, TECHNICAL_EVIDENCE_RULES
from app.schemas import ChatRequest
from app.session import SessionStore
from app.tools import pride_technical as adapter, registry
from app.tools.technical_metadata import extract_technical_metadata


ACCESSION = 'PXD000070'
BASE = 'https://ftp.pride.ebi.ac.uk/pride/data/archive/2014/04/PXD000070/'


def entry(name, size=100, url=None):
    return {'fileName': name, 'fileSizeBytes': size,
            'publicFileLocations': [{'value': url or BASE + name}]}


@pytest.fixture
def store(monkeypatch):
    value = SessionStore()
    monkeypatch.setattr(adapter, 'get_session_store', lambda: value)
    monkeypatch.setattr(agent, 'get_session_store', lambda: value)
    return value


async def discover(monkeypatch, files, session='s'):
    get = AsyncMock(return_value=files)
    monkeypatch.setattr(adapter, 'get_json', get)
    result = await adapter.discover({'accession': ACCESSION, 'reason': 'missing_technical_parameters'}, session)
    return result, get


def extracted(status='complete', count=1):
    return {'source': BASE + 'mqpar.xml', 'status': status, 'stop_reason': 'time_limit' if status == 'partial' else 'end_of_file',
            'facts': [{'field': f'variable_mod[{i}]', 'value': f'mod {i}', 'raw': f'mod {i}',
                       'source': BASE + 'mqpar.xml', 'scope': 'protocol_1', 'location': f'line:{i}',
                       'evidence_kind': 'structured'} for i in range(count)],
            'warnings': ['Only variable modifications can be reported when converted from PRIDE XML'],
            'metrics': {'source_bytes_read': 100}, 'error': 'bad XML' if status == 'error' else None}


async def test_discovery_ranks_formats_and_reuses_catalogue(store, monkeypatch):
    result, get = await discover(monkeypatch, [entry('result.mzid', 1), entry('result.mztab', 5),
                                             entry('mqpar.xml', 10), entry('input.raw'),
                                             entry('unsafe.mztab', url='https://example.org/unsafe.mztab')])
    assert [f['format'] for f in result['files']] == ['mqpar', 'mztab', 'mzidentml']
    assert result['files'][-1]['fallbackOnly']
    repeated = await adapter.discover({'accession': ACCESSION, 'reason': 'explicit_verification'}, 's')
    assert repeated['cached'] and repeated['files'] == result['files']
    assert get.await_count == 1


@pytest.mark.parametrize('url', [
    'http://127.0.0.1/private.mztab', 'file:///etc/passwd',
    BASE.replace('PXD000070', 'PXD000001') + 'a.mztab',
    BASE + '../a.mztab', BASE + '%2e%2e/a.mztab', BASE + '%252e%252e/a.mztab',
    BASE + 'a.mztab?url=http://localhost', BASE.replace('ftp.pride.ebi.ac.uk', 'ftp.pride.ebi.ac.uk.evil.test') + 'a.mztab',
    BASE.replace('ftp.pride.ebi.ac.uk', 'user@ftp.pride.ebi.ac.uk') + 'a.mztab',
    BASE.replace('ftp.pride.ebi.ac.uk', 'ftp.pride.ebi.ac.uk:8888') + 'a.mztab',
])
def test_untrusted_locations_rejected(url):
    assert adapter._safe_url(url, ACCESSION) is None


def test_official_ftp_location_upgraded_to_https():
    assert adapter._safe_url(BASE.replace('https:', 'ftp:') + 'a.mztab', ACCESSION) == BASE + 'a.mztab'


async def test_discovered_ids_are_session_and_project_bound(store, monkeypatch):
    listing, _ = await discover(monkeypatch, [entry('mqpar.xml')])
    read = AsyncMock(return_value=extracted())
    monkeypatch.setattr(adapter, 'extract_technical_metadata', read)
    file_id = listing['files'][0]['fileId']
    for session, accession in [('other', ACCESSION), ('s', 'PXD000001')]:
        result = await adapter.extract({'accession': accession, 'fileId': file_id}, session)
        assert result['status'] == 'not_discovered'
    assert read.await_count == 0


@pytest.mark.parametrize('status', ['complete', 'partial', 'error'])
async def test_actual_registry_pages_and_reuses_every_outcome(store, monkeypatch, status):
    listing, _ = await discover(monkeypatch, [entry('mqpar.xml')])
    read = AsyncMock(return_value=extracted(status, 65))
    monkeypatch.setattr(adapter, 'extract_technical_metadata', read)
    args = {'accession': ACCESSION, 'fileId': listing['files'][0]['fileId']}
    facts, offset = [], 0
    while offset is not None:
        payload = await registry.dispatch('extract_pride_technical_metadata', {**args, 'offset': offset}, 's')
        assert len(payload) <= registry.MAX_RESULT_CHARS
        result = json.loads(payload)
        assert result['ok'] and result['nonBlocking'] and result['warnings']
        facts.extend(result['facts'])
        offset = result['nextOffset']
    assert len(facts) == 65 and facts[-1]['scope'] == 'protocol_1'
    assert result['status'] == ('unavailable' if status == 'error' else status)
    assert read.await_count == 1
    assert read.call_args.kwargs['follow_redirects'] is False
    assert read.call_args.kwargs['limits'].timeout_seconds == 15


async def test_three_file_budget_includes_failed_attempts(store, monkeypatch):
    listing, _ = await discover(monkeypatch, [entry(f'{i}.mztab') for i in range(4)])
    read = AsyncMock(return_value=extracted('error'))
    monkeypatch.setattr(adapter, 'extract_technical_metadata', read)
    for i, file in enumerate(listing['files']):
        result = await adapter.extract({'accession': ACCESSION, 'fileId': file['fileId']}, 's')
        assert result['status'] == ('budget_exhausted' if i == 3 else 'unavailable')
    assert read.await_count == 3
    repeated = await adapter.extract({'accession': ACCESSION, 'fileId': listing['files'][0]['fileId']}, 's')
    assert repeated['cached'] and read.await_count == 3


async def test_parallel_request_cannot_duplicate_download(store, monkeypatch):
    listing, _ = await discover(monkeypatch, [entry('mqpar.xml')])
    started, release = asyncio.Event(), asyncio.Event()
    async def read(*args, **kwargs):
        started.set()
        await release.wait()
        return extracted()
    mock = AsyncMock(side_effect=read)
    monkeypatch.setattr(adapter, 'extract_technical_metadata', mock)
    args = {'accession': ACCESSION, 'fileId': listing['files'][0]['fileId']}
    first = asyncio.create_task(adapter.extract(args, 's'))
    await started.wait()
    other = await adapter.extract(args, 's')
    assert other['status'] == 'in_progress'
    release.set()
    assert (await first)['status'] == 'complete'
    assert mock.await_count == 1


async def test_parallel_discovery_cannot_overwrite_active_results(store, monkeypatch):
    started, release = asyncio.Event(), asyncio.Event()
    async def fetch(*args, **kwargs):
        started.set()
        await release.wait()
        return [entry('mqpar.xml')]
    mock = AsyncMock(side_effect=fetch)
    monkeypatch.setattr(adapter, 'get_json', mock)
    args = {'accession': ACCESSION, 'reason': 'explicit_verification'}
    first = asyncio.create_task(adapter.discover(args, 's'))
    await started.wait()
    second = await adapter.discover(args, 's')
    assert second['status'] == 'in_progress'
    release.set()
    assert (await first)['candidateCount'] == 1
    assert mock.await_count == 1


@pytest.mark.parametrize('failure', [False, True])
async def test_no_files_and_discovery_errors_cached_nonblocking(store, monkeypatch, failure):
    get = AsyncMock(side_effect=TimeoutError() if failure else None, return_value=[])
    monkeypatch.setattr(adapter, 'get_json', get)
    for _ in range(2):
        result = await adapter.discover({'accession': ACCESSION, 'reason': 'conflicting_evidence'}, 's')
        assert result['status'] == ('unavailable' if failure else 'no_supported_files')
        assert result['ok'] and result['nonBlocking']
    assert get.await_count == 1


async def test_expiry_prevents_reusing_stale_file_ids(store, monkeypatch):
    listing, _ = await discover(monkeypatch, [entry('mqpar.xml')])
    _, context = store._technical_metadata[('s', ACCESSION)]
    store._technical_metadata[('s', ACCESSION)] = (0, context)
    result = await adapter.extract({'accession': ACCESSION, 'fileId': listing['files'][0]['fileId']}, 's')
    assert result['status'] == 'not_discovered'


async def test_large_evidence_page_is_flagged_not_lost_by_dispatch(store, monkeypatch):
    listing, _ = await discover(monkeypatch, [entry('mqpar.xml')])
    result = extracted()
    result['facts'][0]['raw'] = 'x' * 50_000
    monkeypatch.setattr(adapter, 'extract_technical_metadata', AsyncMock(return_value=result))
    payload = await registry.dispatch('extract_pride_technical_metadata', {
        'accession': ACCESSION, 'fileId': listing['files'][0]['fileId']}, 's')
    page = json.loads(payload)
    assert page['facts'][0]['valueTruncated']
    assert len(payload) < registry.MAX_RESULT_CHARS


def test_page_always_advances_with_large_warning_envelope():
    result = extracted(count=2)
    result['warnings'] = ['x' * 500] * 12
    result['error'] = 'x' * 2000
    result['facts'][0]['raw'] = 'x' * 9000
    candidate = {'fileName': 'x' * 500, 'url': 'https://ftp.pride.ebi.ac.uk/' + 'x' * 1900}
    page = adapter._page(result, candidate, ACCESSION, 0, True)
    assert page['facts']
    assert page['nextOffset'] is None or page['nextOffset'] > 0
    assert len(json.dumps(page)) < registry.MAX_RESULT_CHARS


def test_extracted_ontology_ids_do_not_bypass_verification():
    ids, labels = set(), set()
    agent._record_verified_terms('extract_pride_technical_metadata', {
        'facts': [{'field': 'instrument[1]-name', 'value': {'accession': 'MS:1001742', 'name': 'LTQ Orbitrap Velos'}}]}, ids, labels)
    assert not ids and not labels


async def test_redirects_cannot_escape_pride_host():
    requests = []
    def respond(request):
        requests.append(str(request.url))
        return httpx.Response(302, headers={'location': 'http://127.0.0.1/secrets'})
    result = await extract_technical_metadata(BASE + 'x.mztab', follow_redirects=False,
                                              transport=httpx.MockTransport(respond))
    assert result['status'] == 'error'
    assert requests == [BASE + 'x.mztab']


@pytest.mark.parametrize('mode,status', [('manual', 'complete'), ('auto', 'complete'), ('auto', 'partial'), ('auto', 'error')])
async def test_tools_complete_real_agent_stream_without_blocking(store, monkeypatch, mode, status):
    monkeypatch.setattr(adapter, 'get_json', AsyncMock(return_value=[entry('mqpar.xml')]))
    monkeypatch.setattr(adapter, 'extract_technical_metadata', AsyncMock(return_value=extracted(status)))
    class Client:
        def __init__(self, settings):
            self.turn = 0

        async def stream(self, messages, tools):
            self.turn += 1
            specs = {t['function']['name']: t for t in tools}
            assert 'list_pride_technical_files' in specs and 'extract_pride_technical_metadata' in specs
            assert TECHNICAL_EVIDENCE_RULES in messages[0]['content']
            if self.turn == 1:
                name, args = 'list_pride_technical_files', {'accession': ACCESSION, 'reason': 'explicit_verification'}
            elif self.turn == 2:
                listing = json.loads(messages[-1]['content'])
                name, args = 'extract_pride_technical_metadata', {'accession': ACCESSION, 'fileId': listing['files'][0]['fileId']}
            elif self.turn == 3:
                evidence = json.loads(messages[-1]['content'])
                assert evidence['nonBlocking']
                # The tolerance comes from user evidence; a partial/failed optional
                # read must not invalidate already-supported protocol actions.
                name, args = 'propose_wizard_actions', {
                    'actions': [{'op': 'setPrecursorMassTolerance', 'argsJson': '["10 ppm"]', 'label': 'User-reported search tolerance'}],
                    'automation': {'status': 'ready', 'issues': [], 'notes': ['Optional file evidence checked.']}}
            else:
                yield StreamEvent(type='token', text='Protocol evidence checked.')
                return
            yield StreamEvent(type='tool_calls', tool_calls=[ToolCall(str(self.turn), name, json.dumps(args))])
    monkeypatch.setattr(agent, 'LlmClient', Client)
    request = ChatRequest(sessionId='s', accession=ACCESSION, focusStep='protocol', executionMode=mode,
                          messages=[{'role': 'user', 'content': 'My methods say 10 ppm; verify available technical files.'}])
    events = [event async for event in agent.run_agent(request)]
    assert events[-1]['type'] == 'done'
    final = events[-1]['result']
    assert final['actions'][0]['op'] == 'setPrecursorMassTolerance'
    if mode == 'auto':
        assert final['automation']['status'] == 'ready'
    assert any(c['source'] == 'pride' and c['url'] == BASE + 'mqpar.xml' for c in final['citations'])
    assert any('fileId=tech_' in note.text for note in store.get_evidence('s'))


def test_call_policy_is_in_shared_system_prompt():
    assert TECHNICAL_EVIDENCE_RULES in SYSTEM_PROMPT
    assert 'SKIP file discovery/download' in TECHNICAL_EVIDENCE_RULES
    assert 'biological replicates' in TECHNICAL_EVIDENCE_RULES
    assert 'ontology' in TECHNICAL_EVIDENCE_RULES
