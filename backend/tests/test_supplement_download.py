from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.session import SessionStore
from app.tools import publication_cache, registry


@pytest.mark.parametrize('body,content_type,reason', [
    (b'<!doctype html><html>Checking your browser before accessing PMC</html>',
     'text/html', 'browser_verification_required'),
    (b'\xef\xbb\xbf<!-- gateway --> <html><script src="recaptcha/enterprise.js"></script></html>',
     'application/octet-stream', 'browser_verification_required'),
    (b'<html>Not found</html>', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
     'html_response'),
    (b'Please log in', 'text/html; charset=utf-8', 'html_response'),
])
async def test_html_download_is_classified_and_never_cached(tmp_path, monkeypatch, body, content_type, reason):
    monkeypatch.setattr(publication_cache, 'cache_root', lambda: tmp_path)
    monkeypatch.setattr(publication_cache, 'get_settings', lambda: SimpleNamespace(
        publication_cache_ttl_seconds=3600, publication_cache_max_mb=10, max_upload_mb=10))
    monkeypatch.setattr(publication_cache, 'get_bytes', AsyncMock(return_value=(body, content_type)))
    with pytest.raises(publication_cache.SupplementDownloadError) as caught:
        await publication_cache.cached_download('https://example.org/supp.docx', 'supplement')
    assert caught.value.reason == reason
    assert not list(tmp_path.iterdir())


async def test_valid_attachment_is_cached(tmp_path, monkeypatch):
    monkeypatch.setattr(publication_cache, 'cache_root', lambda: tmp_path)
    monkeypatch.setattr(publication_cache, 'get_settings', lambda: SimpleNamespace(
        publication_cache_ttl_seconds=3600, publication_cache_max_mb=10, max_upload_mb=10))
    body = b'sample\tgroup\nS1\tcontrol'
    download = AsyncMock(return_value=(body, 'text/tab-separated-values'))
    monkeypatch.setattr(publication_cache, 'get_bytes', download)
    first = await publication_cache.cached_download('https://example.org/table.tsv', 'supplement')
    second = await publication_cache.cached_download('https://example.org/table.tsv', 'supplement')
    assert first == second
    assert first[0] == body
    download.assert_awaited_once()


async def test_verification_failure_returns_recovery_without_parsing(monkeypatch):
    store = SessionStore()
    monkeypatch.setattr(registry, 'get_session_store', lambda: store)
    monkeypatch.setattr(registry, 'cached_download', AsyncMock(side_effect=
        publication_cache.SupplementDownloadError('browser_verification_required', 'Browser verification required.')))
    parse = AsyncMock()
    monkeypatch.setattr(registry.supplements, 'parse_attachment', parse)
    url = 'https://pmc.ncbi.nlm.nih.gov/supp.docx'
    store.remember_pdf_source('s', url, 'supplement', {
        'pmcid': 'PMC123', 'evidenceKind': 'supplement',
        'supplementCandidate': {'url': url, 'fileName': 'supp.docx', 'source': 'pmc'}})
    result = await registry._get_supplement({'url': url}, 's')
    assert result['status'] == 'download_failed'
    assert result['reason'] == 'browser_verification_required'
    assert result['source'] == 'pmc'
    assert result['url'] == url
    assert 'Do not retry' in result['nextStep']
    assert 'publisher' in result['nextStep']
    assert 'upload' in result['nextStep']
    parse.assert_not_awaited()
    assert not store.list_for_session('s')
