"""Regression coverage for repository classifications and raw-file discovery."""
import asyncio

import pytest

from app.tools import pride


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
