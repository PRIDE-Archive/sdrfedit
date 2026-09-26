"""Regression coverage for repository classifications and raw-file discovery."""
import asyncio
import json

import pytest

from app.tools import pride, registry


def test_complete_project_metadata_reaches_model_beyond_output_budget(monkeypatch):
    description = 'Project description. ' * 600 + 'DESCRIPTION_TAIL'
    sample_protocol = 'Sample preparation. ' * 600 + 'ENZYME_TAIL'
    data_protocol = 'Data processing. ' * 600 + 'SOFTWARE_TAIL'
    attributes = [{'key': {'name': 'sample'}, 'value': {'name': f'S{i}'}}
                  for i in range(85)]

    async def fake_get_json(url, **kwargs):
        assert url.endswith('/projects/PXD000070')
        return {
            'title': 'Complete project',
            'projectDescription': f'<p>{description}</p>',
            'sampleProcessingProtocol': sample_protocol,
            'dataProcessingProtocol': data_protocol,
            'sampleAttributes': [attributes[:45], *attributes[45:]],
            'references': [{'referenceLine': 'Paper', 'pubmedID': 123, 'doi': '10.example/paper'}],
        }

    monkeypatch.setattr(pride, 'get_json', fake_get_json)
    raw = asyncio.run(registry.dispatch('get_pride_metadata', {'accession': 'PXD000070'}, 'test'))
    assert len(raw) > registry.MAX_RESULT_CHARS
    result = json.loads(raw)
    assert result['description'] == description
    assert result['sampleProcessingProtocol'] == sample_protocol
    assert result['dataProcessingProtocol'] == data_protocol
    assert result['sampleAttributes'] == [f'sample: S{i}' for i in range(85)]
    assert result['references'] == [{'citation': 'Paper', 'pubmedId': '123', 'doi': '10.example/paper'}]
    assert result['accession'] == 'PXD000070'
    assert 'error' not in result


def test_project_metadata_empty_fields_stay_empty(monkeypatch):
    async def fake_get_json(url, **kwargs):
        return {}

    monkeypatch.setattr(pride, 'get_json', fake_get_json)
    result = asyncio.run(pride.fetch_project('PXD000070'))
    for field in ('description', 'sampleProcessingProtocol', 'dataProcessingProtocol'):
        assert result[field] == ''
    assert result['sampleAttributes'] == []


def test_metadata_budget_exception_does_not_remove_other_tool_limits(monkeypatch):
    async def oversized_result(args, session_id):
        return {'rawFileNames': ['x' * registry.MAX_RESULT_CHARS]}

    monkeypatch.setitem(registry._BY_NAME['search_ontology'], 'handler', oversized_result)
    result = json.loads(asyncio.run(registry.dispatch(
        'search_ontology', {}, 'test')))
    assert result['ok'] is False
    assert result['truncated'] is True
    assert result['originalChars'] > registry.MAX_RESULT_CHARS


@pytest.mark.parametrize('name,category,expected', [
    ('WT_1.dat', 'SEARCH', False),
    ('run.raw', 'RESULT', False),
    ('run.baf', 'OTHER', False),
    ('run.mzML', 'PEAK', False),
    ('run.mzML', 'RAW', True),
    ('WT_1.baf', ' raw ', True),
    ('unknown.vendor', 'RAW', True),
    ('WT_1.dat', None, False),
    ('run.pkl', '', False),
    ('run.mzML', None, False),
    ('run.wiff.scan', None, False),
    ('analysis.tdf_bin', None, False),
    ('WT_1.BAF', None, True),
    ('run.wiff2', '', True),
    ('run.d.tar.gz', None, True),
    ('run.raw.zip', None, True),
])
def test_raw_classification(name, category, expected):
    assert pride._is_raw(name, category) is expected


def test_pxd003149_raw_files(monkeypatch):
    raw = ['20150929_SH_I1.raw', '20150929_SH_I2.raw', '20150929_SH_I3.raw',
           'WT_1.baf', 'WT_2.baf']
    search = ['WT_1.dat', 'WT_2.dat', 'ycf54minus_1.dat',
              'ycf54minus_2.dat', 'ycf54minus_3.dat']
    entries = [{'fileName': n, 'fileCategory': {'value': 'RAW'}} for n in raw]
    entries += [{'fileName': n, 'fileCategory': {'value': 'SEARCH'}} for n in search]
    entries += [{'fileName': f'peak{i}.mgf', 'fileCategory': 'PEAK'} for i in range(10)]
    entries += [{'fileName': f'result{i}.xml.gz', 'fileCategory': 'RESULT'} for i in range(5)]
    entries += [{'fileName': f'other{i}.txt', 'fileCategory': 'OTHER'} for i in range(6)]

    async def fake_get_json(url, **kwargs):
        assert url.endswith('/projects/PXD003149/files/all')
        return entries

    monkeypatch.setattr(pride, 'get_json', fake_get_json)
    result = asyncio.run(pride.fetch_raw_files('PXD003149'))
    assert result['rawFileNames'] == raw
    assert result['rawFileCount'] == 5
    assert result['totalFileCount'] == 31
    assert result['truncated'] is False


def test_raw_file_locations_preserved_without_fabrication(monkeypatch):
    async def fake_get_json(url, **kwargs):
        return [
            {'fileName': 'a.raw', 'fileCategory': 'RAW', 'publicFileLocations': [
                {'value': 'ftp://ftp.pride.ebi.ac.uk/pride/data/archive/2020/01/PXD000070/a.raw'}]},
            {'fileName': 'b.raw', 'fileCategory': 'RAW'},
            {'fileName': 'c.raw', 'fileCategory': 'RAW', 'publicFileLocations': [{'value': 'https://example.org/c.raw'}]},
        ]
    monkeypatch.setattr(pride, 'get_json', fake_get_json)
    result = asyncio.run(pride.fetch_raw_files('PXD000070'))
    assert result['fileUrls'] == {
        'a.raw': 'ftp://ftp.pride.ebi.ac.uk/pride/data/archive/2020/01/PXD000070/a.raw',
        'c.raw': 'https://example.org/c.raw',
    }
    assert result['rawFileNames'] == ['a.raw', 'b.raw', 'c.raw']
    assert result['truncated'] is False
