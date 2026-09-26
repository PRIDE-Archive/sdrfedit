import importlib.util
from pathlib import Path
import sys

import pytest

scripts = Path(__file__).resolve().parents[1] / 'scripts'
sys.path.insert(0, str(scripts))
spec = importlib.util.spec_from_file_location('raw_scan', scripts/'find_pride_raw_extension_projects.py')
scan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan)


def records(names):
    return [{'fileName': name, 'fileCategory': {'value': 'OTHER'}} for name in names]


def test_only_raw_suffix_counts_regardless_of_category():
    assert scan.raw_names(records(['a.raw','B.RAW','a.raw.zip','a.raw.gz','raw.mzML','a.wiff','a.raw.txt','a.raw'])) == {'a.raw','B.RAW'}


@pytest.mark.parametrize('count', [5,6,7])
def test_candidates_require_complete_list_verification(count):
    names = [f'{i}.raw' for i in range(count)]
    calls = []
    def fetch(path):
        calls.append(path)
        if path.endswith('/all'): return records(names+['search.txt','archive.zip'])
        return records(names) if path.endswith('page=0') else []
    result=scan.scan_project('PXD000001',fetch)
    assert result['status']=='matched'
    assert result['raw_file_count']==count
    assert result['total_file_count']==count+2
    assert calls[-1].endswith('/all')


def test_large_projects_stop_after_eighth_raw_file():
    result=scan.scan_project('PXD000001', lambda _:records([f'{i}.raw' for i in range(8)]))
    assert result['status']=='excluded'
    assert result['raw_file_count_lower_bound']==8


def test_short_pages_are_not_treated_as_end_of_listing():
    names=[f'{i}.raw' for i in range(6)]
    def fetch(path):
        if path.endswith('/all'): return records(names)
        page=int(path.rsplit('=',1)[1]);return records(names[page*2:(page+1)*2])
    assert scan.scan_project('PXD000001',fetch)['raw_file_count']==6


def test_filter_disagreement_is_a_failure_not_a_match():
    def fetch(path):
        if path.endswith('/all'):return records([f'{i}.raw' for i in range(8)])
        return records([f'{i}.raw' for i in range(5)]) if path.endswith('page=0') else []
    with pytest.raises(ValueError,match='disagree'):scan.scan_project('PXD000001',fetch)


def test_repeated_page_is_not_silently_accepted():
    with pytest.raises(ValueError,match='repeated'):scan.scan_project('PXD000001',lambda _:records(['a.raw']))
