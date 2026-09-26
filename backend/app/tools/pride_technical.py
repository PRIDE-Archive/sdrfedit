"""Session-bound, budgeted PRIDE adapter for the technical metadata extractor."""
from __future__ import annotations

import asyncio
from copy import deepcopy
import hashlib
import json
import re
from urllib.parse import unquote, urlsplit, urlunsplit

from ..session import get_session_store
from .http import get_json
from .pride import PRIDE_API_BASE
from .technical_metadata import Limits, extract_technical_metadata

REASONS = {'missing_technical_parameters', 'conflicting_evidence',
           'explicit_verification', 'ambiguous_file_mapping'}
MAX_FILES = 3
MAX_CANDIDATES = 200
MAX_CACHE_CHARS = 500_000
MAX_PAGE_CHARS = 20_000
LIMITS = Limits()


def _accession(value: str) -> str:
    value = str(value).strip().upper()
    if not re.fullmatch(r'PXD\d{6,}', value):
        raise ValueError('Provide a PRIDE PXD accession, not a URL or path.')
    return value


def _number(value, default, maximum):
    value = default if value is None else value
    if type(value) is not int or not 0 <= value <= maximum:
        raise ValueError(f'Expected an integer between 0 and {maximum}.')
    return value


def _safe_url(url: str, accession: str) -> str | None:
    """Only exact PRIDE archive host, port and project directory; no redirects."""
    try:
        if not isinstance(url, str) or len(url) > 2048:
            return None
        parts = urlsplit(url)
        if parts.scheme not in {'ftp', 'http', 'https'} or parts.netloc != 'ftp.pride.ebi.ac.uk':
            return None
        if parts.query or parts.fragment:
            return None
        path = unquote(parts.path)
        if '%' in path or '\\' in path or any(ord(c) < 32 for c in path):
            return None
        if any(segment in {'.', '..'} for segment in path.split('/')):
            return None
        if not re.match(rf'^/pride/data/archive/\d{{4}}/\d{{2}}/{accession}/[^/]', path):
            return None
        return urlunsplit(('https', parts.netloc, parts.path, '', ''))
    except (TypeError, ValueError):
        return None


def _format(name: str) -> str | None:
    name = name.lower().removesuffix('.gz')
    if 'mqpar' in name and name.endswith('.xml'):
        return 'mqpar'
    if name.endswith('.mztab') or ('mztab' in name and name.endswith('.txt')):
        return 'mztab'
    if name.endswith(('.mzid', '.mzidentml')):
        return 'mzidentml'
    return None


def _catalogue(files, accession):
    candidates = {}
    for entry in files:
        if not isinstance(entry, dict):
            continue
        name = entry.get('fileName', '')
        if not isinstance(name, str) or len(name) > 512:
            continue
        fmt = _format(name)
        if not fmt:
            continue
        for location in entry.get('publicFileLocations') or []:
            if not isinstance(location, dict):
                continue
            url = _safe_url(location.get('value', ''), accession)
            if not url:
                continue
            file_id = 'tech_' + hashlib.sha256(url.encode()).hexdigest()[:20]
            size = entry.get('fileSizeBytes')
            candidates[file_id] = {
                'fileId': file_id, 'fileName': name, 'format': fmt, 'url': url,
                'reportedSizeBytes': size if type(size) is int and size >= 0 else None,
                'priority': {'mqpar': 1, 'mztab': 2, 'mzidentml': 3}[fmt],
                'fallbackOnly': fmt == 'mzidentml',
                'generatedByRepository': '/generated/' in url,
            }
            break
    ordered = sorted(candidates.values(), key=lambda row: (
        row['priority'], row['reportedSizeBytes'] if row['reportedSizeBytes'] is not None else 2**63,
        row['fileName']))
    return ordered[:MAX_CANDIDATES], len(ordered)


async def discover(args: dict, session_id: str) -> dict:
    accession = _accession(args['accession'])
    if args.get('reason') not in REASONS:
        raise ValueError('Specify a supported technical-evidence reason.')
    offset = _number(args.get('offset'), 0, MAX_CANDIDATES)
    store = get_session_store()
    context = store.technical_context(session_id, accession)
    cached = 'catalogue' in context
    if not cached:
        context = {'catalogue': [], 'candidateCount': 0, 'results': {}, 'discoveryInProgress': True}
        store.save_technical_context(session_id, accession, context)
        try:
            async with asyncio.timeout(15):
                files = await get_json(f'{PRIDE_API_BASE}/projects/{accession}/files/all', timeout=15)
            if not isinstance(files, list):
                raise ValueError('PRIDE returned an unexpected file listing.')
            catalogue, count = _catalogue(files, accession)
            context = {'catalogue': catalogue, 'candidateCount': count, 'results': {}}
        except Exception as error:
            # Optional discovery failing is not a wizard-blocking condition.
            context = {'catalogue': [], 'candidateCount': 0, 'results': {},
                       'failureReason': str(error)[:400] or 'Discovery timed out.'}
        except asyncio.CancelledError:
            store.save_technical_context(session_id, accession, {
                'catalogue': [], 'candidateCount': 0, 'results': {}, 'failureReason': 'Discovery cancelled.'})
            raise
        store.save_technical_context(session_id, accession, context)
    candidates = []
    chars = 0
    for candidate in context['catalogue'][offset:offset + 15]:
        chars += len(json.dumps(candidate, ensure_ascii=False))
        if chars > 16_000:
            break
        candidates.append(candidate)
    return {'ok': True, 'accession': accession, 'cached': cached, 'nonBlocking': True,
            'status': 'in_progress' if context.get('discoveryInProgress') else 'unavailable' if context.get('failureReason') else 'ready' if context['catalogue'] else 'no_supported_files',
            'failureReason': context.get('failureReason'), 'candidateCount': context['candidateCount'],
            'catalogueTruncated': context['candidateCount'] > len(context['catalogue']),
            'files': candidates,
            'nextOffset': offset + len(candidates) if offset + len(candidates) < len(context['catalogue']) else None,
            'remainingFileBudget': max(0, MAX_FILES - len(context['results'])),
            'guidance': 'Pick a relevant analysis/run, not merely the smallest file. Prefer mqpar and mzTab; '
                        'mzIdentML is fallback only. No RAW/mzML or ZIP scanning. Listing size may differ from download size.'}


def _cache_result(result):
    """Bound stored evidence; report omitted evidence instead of inventing defaults."""
    result = deepcopy(result)
    facts = result.pop('facts', [])
    warnings = result.get('warnings') or []
    result['warnings'] = [str(warning)[:500] for warning in warnings[:12]]
    result['warningsTruncated'] = len(warnings) > 12 or any(len(str(w)) > 500 for w in warnings)
    kept, chars = [], len(json.dumps(result, ensure_ascii=False))
    for fact in facts:
        size = len(json.dumps(fact, ensure_ascii=False))
        if chars + size > MAX_CACHE_CHARS:
            result['status'], result['stop_reason'] = 'partial', 'evidence_storage_limit'
            break
        kept.append(fact)
        chars += size
    result['facts'] = kept
    result['storedFactsTruncated'] = len(kept) != len(facts)
    return result


def _fact_preview(fact):
    preview = {key: str(fact.get(key, ''))[:1000]
               for key in ('field', 'source', 'location', 'scope', 'evidence_kind')}
    preview.update(valueTruncated=True, rawPreview=str(fact.get('raw'))[:1500])
    return preview


def _page(result, candidate, accession, offset, cached):
    facts = result.get('facts') or []
    page = {'ok': True, 'nonBlocking': True, 'accession': accession, **candidate,
            'cached': cached, 'status': 'unavailable' if result['status'] == 'error' else result['status'],
            'stopReason': result.get('stop_reason'), 'failureReason': str(result['error'])[:1000] if result.get('error') else None,
            'coverage': result.get('coverage'), 'missingFieldsMean': 'unknown',
            'warnings': result.get('warnings', []), 'warningsTruncated': result.get('warningsTruncated', False),
            'storedFactsTruncated': result.get('storedFactsTruncated', False),
            'metrics': result.get('metrics'), 'limits': result.get('limits'),
            'totalStoredFacts': len(facts), 'offset': offset, 'facts': [], 'nextOffset': None,
            'guidance': 'Read remaining pages before deciding modification lists or file scope. '
                        'partial/unavailable is not itself a reason to stop the wizard or ask confirmation. '
                        'Source warnings, analysis scope and ontology verification still apply. '
                        'A truncated value cannot support a definitive annotation.'}
    if offset > len(facts):
        page['guidance'] = f'Offset exceeds available facts. Restart at offset 0 (total {len(facts)}).'
        return page
    for index in range(offset, min(len(facts), offset + 20)):
        fact = deepcopy(facts[index])
        if len(json.dumps(fact, ensure_ascii=False)) > 10_000:
            fact = _fact_preview(fact)
        page['facts'].append(fact)
        page['nextOffset'] = index + 1 if index + 1 < len(facts) else None
        if len(json.dumps(page, ensure_ascii=False)) > MAX_PAGE_CHARS:
            if len(page['facts']) == 1:
                page['facts'][0] = _fact_preview(facts[index])
                break
            page['facts'].pop()
            page['nextOffset'] = index
            break
    return page


async def extract(args: dict, session_id: str) -> dict:
    accession = _accession(args['accession'])
    offset = _number(args.get('offset'), 0, LIMITS.max_facts)
    store = get_session_store()
    context = store.technical_context(session_id, accession)
    candidate = next((f for f in context.get('catalogue', []) if f['fileId'] == args['fileId']), None)
    if candidate is None:
        return {'ok': True, 'nonBlocking': True, 'accession': accession, 'status': 'not_discovered',
                'guidance': 'Call list_pride_technical_files in this session and use an exact returned fileId.'}
    results = context['results']
    file_id = candidate['fileId']
    cached = file_id in results
    if not cached:
        if len(results) >= MAX_FILES:
            return {'ok': True, 'nonBlocking': True, 'accession': accession, 'status': 'budget_exhausted',
                    'guidance': 'Three distinct files already attempted for this project/session. Reuse cached evidence; do not retry downloads.'}
        # Reservation occurs before awaiting: overlapping requests cannot duplicate
        # this download or exceed the session's distinct-file budget.
        results[file_id] = {'status': 'in_progress', 'facts': [], 'stop_reason': 'another_request_reading'}
        store.save_technical_context(session_id, accession, context)
        try:
            result = await extract_technical_metadata(candidate['url'], format_name=candidate['format'],
                                                      limits=LIMITS, follow_redirects=False)
        except Exception as error:
            result = {'status': 'error', 'stop_reason': 'extraction_failed', 'facts': [], 'error': str(error)[:400]}
        except asyncio.CancelledError:
            results[file_id] = {'status': 'partial', 'stop_reason': 'cancelled', 'facts': []}
            raise
        results[file_id] = _cache_result(result)
        store.save_technical_context(session_id, accession, context)
    return _page(results[file_id], candidate, accession, offset, cached)
