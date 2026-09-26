"""Bounded technical evidence extraction, also usable as a standalone CLI.

No SDRF values are written. Facts retain their source field and analysis scope;
missing fields mean unknown. ``metadata_complete`` does not validate result rows.
"""
from __future__ import annotations

import asyncio
from dataclasses import asdict, dataclass
from pathlib import Path
import re
import math
import time
from urllib.parse import urlsplit
import zlib

import httpx
from lxml import etree


@dataclass(frozen=True)
class Limits:
    timeout_seconds: float = 15
    max_download_bytes: int = 8 * 1024 * 1024
    max_decoded_bytes: int = 32 * 1024 * 1024
    max_facts: int = 2000
    max_line_bytes: int = 256 * 1024

    def __post_init__(self):
        if any(not math.isfinite(value) or value <= 0 for value in asdict(self).values()):
            raise ValueError('All limits must be positive')


class StopReading(Exception):
    def __init__(self, reason: str):
        self.reason = reason


def _local(tag: str) -> str:
    return tag.rsplit('}', 1)[-1] if isinstance(tag, str) else ''


def _cv(value: str):
    if value.startswith('[') and value.endswith(']'):
        parts = value[1:-1].split(',', 3)
        if len(parts) == 4:
            return dict(zip(('cv', 'accession', 'name', 'value'), (p.strip() for p in parts)))
    return value


class Evidence:
    def __init__(self, source: str, limits: Limits):
        self.source, self.limits = source, limits
        self.facts: list[dict] = []
        self.warnings: list[str] = []

    def add(self, field, value, location, scope='file', kind='structured', raw=None):
        if len(self.facts) >= self.limits.max_facts:
            raise StopReading('fact_limit')
        self.facts.append({'field': field, 'value': value, 'scope': scope,
                           'evidence_kind': kind, 'source': self.source,
                           'location': location, 'raw': value if raw is None else raw})


class MzTabParser:
    def __init__(self, evidence: Evidence):
        self.e = evidence
        self.buffer = b''
        self.line = 0
        self.version_seen = False

    def feed(self, data: bytes):
        self.buffer += data
        while b'\n' in self.buffer:
            row, self.buffer = self.buffer.split(b'\n', 1)
            self.row(row)
        if len(self.buffer) > self.e.limits.max_line_bytes:
            raise StopReading('line_limit')

    def row(self, data: bytes):
        self.line += 1
        if len(data) > self.e.limits.max_line_bytes:
            raise StopReading('line_limit')
        text = data.decode('utf-8-sig').rstrip('\r')
        if not text.strip():
            return
        columns = text.split('\t', 2)
        if columns[0] in {'PRH', 'PEH', 'PSH', 'SMH', 'SFH', 'SEH'}:
            if not self.version_seen:
                raise ValueError('Missing mzTab-version metadata')
            raise StopReading('metadata_complete')
        if columns[0] == 'COM':
            self.e.add('source_comment', text[4:], f'line:{self.line}', kind='text')
            self.e.warnings.append(text[4:])
            return
        if len(columns) != 3 or columns[0] != 'MTD':
            raise ValueError(f'Unexpected mzTab record at line {self.line}')
        _, key, raw = columns
        if key == 'mzTab-version':
            self.version_seen = True
        # Exclude contact details; retain technical metadata and relationships.
        if not re.match(r'^(mzTab-|title$|description$|fixed_mod\[|variable_mod\[|'
                        r'instrument\[|software\[|ms_run\[|assay\[|study_variable\[|'
                        r'sample_processing\[|sample\[)', key):
            return
        base = re.match(r'([^\[]+\[\d+\])', key)
        self.e.add(key, _cv(raw), f'line:{self.line}',
                   scope=base[1] if base else 'file',
                   kind='text' if key in {'description', 'title'} else 'structured', raw=raw)

    def finish(self):
        if self.buffer:
            self.row(self.buffer)
        if not self.version_seen:
            raise ValueError('Missing mzTab-version metadata')
        # A header-only or truncated export is useful evidence but not complete.
        raise StopReading('eof_before_results')


class XmlParser:
    """Pull parsing clears unneeded sequence/result nodes as they are consumed."""
    KEEP = {'SearchModification', 'Enzyme', 'ParentTolerance', 'FragmentTolerance',
            'AnalysisSoftware', 'SearchDatabase', 'SpectraData', 'SpectrumIdentification',
            'AdditionalSearchParams', 'Threshold'}
    MQ_FIELDS = {'fixedModifications', 'variableModifications', 'enzymes',
                 'maxMissedCleavages', 'firstSearchTol', 'mainSearchTol',
                 'searchTolInPpm', 'msmsTol', 'msmsTolInPpm', 'filePaths',
                 'paramGroupIndices', 'fastaFiles', 'maxQuantVersion', 'version',
                 'labelMods', 'isobaricLabels', 'lcmsRunType', 'msInstrument', 'msmsParams', 'type'}

    def __init__(self, evidence: Evidence, format_name: str):
        self.e, self.format = evidence, format_name
        self.parser = etree.XMLPullParser(events=('start', 'end'), resolve_entities=False,
                                         load_dtd=False, no_network=True, huge_tree=False)
        self.stack: list[tuple[str, str]] = []
        self.child_counts: list[dict[str, int]] = [{}]
        self.root_seen = False
        self.kept = None
        self.guard = b''
        self.inputs_seen = False
        self.protocols_seen = False

    def feed(self, data: bytes):
        # Reject DTDs/entities, including token boundaries and UTF-16/32 input.
        scan = self.guard + data.replace(b'\x00', b'')
        if re.search(br'<!\s*(DOCTYPE|ENTITY)', scan, re.I):
            raise ValueError('DTD/entity declarations are not supported')
        self.guard = scan[-32:]
        self.parser.feed(data)
        for event, node in self.parser.read_events():
            tag = _local(node.tag)
            if event == 'start':
                if not self.root_seen:
                    expected = 'MzIdentML' if self.format == 'mzidentml' else 'MaxQuantParams'
                    if tag != expected:
                        raise ValueError(f'Expected XML root {expected}, got {tag}')
                    self.root_seen = True
                siblings = self.child_counts[-1]
                siblings[tag] = siblings.get(tag, 0) + 1
                label = tag + (f'[@id="{node.get("id")}"]' if node.get('id') else f'[{siblings[tag]}]')
                self.child_counts.append({})
                self.stack.append((tag, label))
                if self.format == 'mzidentml' and tag == 'SpectrumIdentificationProtocol':
                    self.e.add('protocol', dict(node.attrib), '/' + '/'.join(x[1] for x in self.stack), label)
                if self.format == 'mzidentml' and tag == 'AnalysisData':
                    if not (self.inputs_seen and self.protocols_seen):
                        raise ValueError('AnalysisData encountered before protocols/inputs')
                    raise StopReading('metadata_complete')
                keep = self.KEEP if self.format == 'mzidentml' else self.MQ_FIELDS
                if tag in keep and self.kept is None:
                    self.kept = node
            else:
                if node is self.kept:
                    self.emit(node)
                    self.kept = None
                if tag == 'Inputs':
                    self.inputs_seen = True
                if tag == 'AnalysisProtocolCollection':
                    self.protocols_seen = True
                if self.kept is None:
                    node.clear()
                    while node.getprevious() is not None:
                        del node.getparent()[0]
                self.stack.pop()
                self.child_counts.pop()

    def emit(self, node):
        tag = _local(node.tag)
        location = '/' + '/'.join(label for _, label in self.stack)
        ancestors = [label for name, label in self.stack if name in
                     {'SpectrumIdentificationProtocol', 'ProteinDetectionProtocol', 'parameterGroup', 'msmsParams'}]
        scope = '/'.join(ancestors) or 'file'
        if self.format == 'mqpar':
            leaves = [(el.text or '').strip() for el in node.iter() if _local(el.tag) and len(el) == 0]
            # Keep lists as lists, including explicitly empty modification lists.
            value = leaves if tag in {'fixedModifications', 'variableModifications', 'enzymes',
                                     'filePaths', 'paramGroupIndices', 'labelMods'} else {
                'attributes': dict(node.attrib),
                'entries': [{'field': _local(el.tag), 'value': (el.text or '').strip()}
                                     for el in node.iter() if _local(el.tag) and len(el) == 0]}
            if not len(node) and not (node.text or '').strip() and isinstance(value, list):
                value = []
        else:
            value = {'attributes': dict(node.attrib),
                     'parameters': [{'element': _local(el.tag), 'parent_element': _local(el.getparent().tag), **dict(el.attrib)}
                                    for el in node.iter() if _local(el.tag) in
                                    {'cvParam', 'userParam', 'InputSpectra', 'SearchDatabaseRef'}]}
            # Preserve positional specificity instead of collapsing all CVs into mod names.
            if tag == 'SearchModification':
                value['specificity'] = [dict(el.attrib) for el in node.iter()
                                        if _local(el.tag) == 'SpecificityRules']
        self.e.add(tag, value, location, scope)
        if tag == 'msmsParams' and not any('MS/MS presets' in warning for warning in self.e.warnings):
            self.e.warnings.append('MaxQuant MS/MS presets are reported separately; presence does not prove a preset was used for every input file.')
        if tag == 'SearchModification':
            accessions = {p.get('accession') for p in value['parameters'] if p['parent_element'] == tag}
            for fact in self.e.facts[:-1]:
                if fact['field'] != tag or fact['scope'] != scope:
                    continue
                old = fact['value']
                shared = accessions & {p.get('accession') for p in old['parameters'] if p['parent_element'] == tag}
                old_fixed, new_fixed = old['attributes'].get('fixedMod'), value['attributes'].get('fixedMod')
                if shared and old_fixed in {'true', 'false', '0', '1'} and new_fixed in {'true', 'false', '0', '1'} and (old_fixed in {'true', '1'}) != (new_fixed in {'true', '1'}):
                    self.e.warnings.append(f'{scope}: {sorted(shared)} occurs as both fixed and variable; inspect sites and protocol before annotating.')

    def finish(self):
        self.parser.close()
        if not self.root_seen:
            raise ValueError('Empty XML document')
        if self.format == 'mzidentml':
            raise StopReading('eof_before_results')


def detect_format(source: str, format_name: str | None = None) -> str:
    if format_name:
        if format_name not in {'mztab', 'mzidentml', 'mqpar'}:
            raise ValueError('Supported formats: mztab, mzidentml, mqpar')
        return format_name
    name = urlsplit(source).path.lower()
    if name.endswith('.gz'):
        name = name[:-3]
    if name.endswith('.mztab'):
        return 'mztab'
    if name.endswith(('.mzid', '.mzidentml')):
        return 'mzidentml'
    if name.endswith('mqpar.xml'):
        return 'mqpar'
    raise ValueError('Cannot infer format; use --format mztab|mzidentml|mqpar')


async def extract_technical_metadata(source: str, *, format_name: str | None = None,
                                     limits: Limits | None = None,
                                     transport: httpx.AsyncBaseTransport | None = None,
                                     follow_redirects: bool = True) -> dict:
    """Read an explicit local path or HTTP(S) URL; caller controls file selection.

    The CLI accepts operator-selected paths/URLs. The agent uses pride_technical's
    session-bound PRIDE file IDs and disables redirects, never arbitrary URLs.
    """
    limits = limits or Limits()
    format_name = detect_format(source, format_name)
    e = Evidence(source, limits)
    parser = MzTabParser(e) if format_name == 'mztab' else XmlParser(e, format_name)
    started = time.monotonic()
    downloaded = decoded = 0
    total_size = None
    compressed = urlsplit(source).path.lower().endswith('.gz')
    decompressor = zlib.decompressobj(16 + zlib.MAX_WBITS) if compressed else None
    status, reason = 'complete', 'end_of_file'
    error = None

    def consume(chunk):
        nonlocal downloaded, decoded
        downloaded += len(chunk)
        if downloaded > limits.max_download_bytes:
            raise StopReading('download_limit')
        pending = chunk
        while pending:
            if time.monotonic() - started >= limits.timeout_seconds:
                raise StopReading('time_limit')
            remaining = limits.max_decoded_bytes - decoded
            if remaining <= 0:
                raise StopReading('decoded_limit')
            data = decompressor.decompress(pending, min(16384, remaining)) if decompressor else pending[:remaining]
            decoded += len(data)
            parser.feed(data)
            if decompressor:
                pending = decompressor.unconsumed_tail
                if decompressor.unused_data:
                    # Never silently discard concatenated gzip members or junk.
                    raise ValueError('Multiple gzip members/trailing compressed data are unsupported')
            else:
                pending = pending[len(data):]

    try:
        async with asyncio.timeout(limits.timeout_seconds):
            if urlsplit(source).scheme in {'http', 'https'}:
                async with httpx.AsyncClient(timeout=limits.timeout_seconds, follow_redirects=follow_redirects,
                                             transport=transport) as client:
                    async with client.stream('GET', source, headers={
                            'Accept-Encoding': 'identity', 'User-Agent': 'sdrfedit-metadata-probe/0.1'}) as response:
                        response.raise_for_status()
                        if response.headers.get('content-encoding', 'identity') != 'identity':
                            raise ValueError('Unexpected HTTP content encoding; wire byte limit cannot be guaranteed')
                        length = response.headers.get('content-length', '')
                        total_size = int(length) if length.isdigit() else None
                        async for chunk in response.aiter_raw(chunk_size=16384):
                            consume(chunk)
            else:
                if urlsplit(source).scheme:
                    raise ValueError('Only local paths and HTTP(S) URLs are supported')
                path = Path(source)
                total_size = path.stat().st_size
                with path.open('rb') as handle:
                    while chunk := handle.read(16384):
                        consume(chunk)
                        await asyncio.sleep(0)
            if decompressor and not decompressor.eof:
                raise ValueError('Truncated gzip stream')
            parser.finish()
    except StopReading as stop:
        reason = stop.reason
        status = 'complete' if reason == 'metadata_complete' else 'partial'
    except (TimeoutError, httpx.TimeoutException):
        status, reason = 'partial', 'time_limit'
    except (OSError, ValueError, UnicodeError, zlib.error, etree.XMLSyntaxError, httpx.HTTPError) as exc:
        status, reason, error = 'error', 'read_or_parse_error', str(exc)
    return {'source': source, 'format': format_name, 'status': status, 'stop_reason': reason,
            'coverage': 'technical metadata only; result rows and complete document validity not checked',
            'missing_fields_mean': 'unknown', 'facts': e.facts, 'warnings': e.warnings,
            'error': error, 'metrics': {'elapsed_seconds': round(time.monotonic() - started, 4),
                                      'source_bytes_read': downloaded, 'decoded_bytes': decoded,
                                      'source_size_bytes': total_size}, 'limits': asdict(limits)}
