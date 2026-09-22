import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from app.config import Settings
from app.session import SessionStore
from app.tools import literature, registry, publication_cache, http
from app.parsing.base import ParsedDocument, PdfParseError

XML = b'''<article xmlns:xlink="http://www.w3.org/1999/xlink"><front><article-meta>
<article-id pub-id-type="doi">10.123/test</article-id><title-group><article-title>Example</article-title></title-group>
</article-meta></front><body><sec><title>Methods</title><p>Three biological replicates.</p>
<table-wrap id="t1"><table><tr><th>Sample</th><th>Group</th></tr><tr><td>S1</td><td>Control</td></tr></table></table-wrap>
</sec><sec><title>Results</title><p>Protein results.</p></sec></body>
<back><supplementary-material xlink:href="samples.xlsx"><label>Sample mappings</label></supplementary-material></back></article>'''


def configure(monkeypatch, tmp_path):
    settings = Settings(_env_file=None, publication_cache_dir=str(tmp_path), unpaywall_email="")
    monkeypatch.setattr(publication_cache, "get_settings", lambda: settings)
    monkeypatch.setattr(literature, "get_settings", lambda: settings)
    return settings


def test_pmid_falls_back_to_normalized_doi(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    request = AsyncMock(side_effect=[{"resultList": {"result": []}}, {"resultList": {"result": [
        {"source": "MED", "id": "123", "doi": "10.123/test", "pmcid": "PMC123", "isOpenAccess": "Y"}
    ]}}])
    monkeypatch.setattr(literature, "get_json", request)
    result = asyncio.run(literature.lookup_publication("123", "https://doi.org/10.123/TEST"))
    assert result["fullTextAvailable"]
    assert result["pmid"] == "123"
    assert request.call_args_list[0].kwargs["params"]["query"] == "EXT_ID:123 AND SRC:MED"
    assert request.call_args_list[1].kwargs["params"]["query"] == 'DOI:"10.123/test"'


def test_conflicting_identifiers_do_not_download(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    monkeypatch.setattr(literature, "get_json", AsyncMock(return_value={"resultList": {"result": [
        {"pmid": "123", "doi": "10.123/other"}
    ]}}))
    result = asyncio.run(literature.lookup_publication("123", "10.123/test"))
    assert result["status"] == "identifier_conflict"
    assert not result["found"]


def test_unpaywall_works_without_epmc_record(monkeypatch, tmp_path):
    settings = configure(monkeypatch, tmp_path)
    settings.unpaywall_email = "maintainer@example.org"
    monkeypatch.setattr(literature, "get_json", AsyncMock(side_effect=[
        {"resultList": {"result": []}},
        {"best_oa_location": {"url_for_landing_page": "https://publisher/paper"},
         "oa_locations": [{"url_for_pdf": "https://repository/paper.pdf", "license": "cc-by"}]},
    ]))
    result = asyncio.run(literature.lookup_publication(doi="10.123/test"))
    assert result["pdfUrls"] == ["https://repository/paper.pdf"]
    assert result["pdfCandidates"][0]["license"] == "cc-by"


def test_xml_creates_complete_reusable_session_document(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    download = AsyncMock(return_value=(XML, "application/xml"))
    monkeypatch.setattr(publication_cache, "get_bytes", download)
    store = SessionStore()
    monkeypatch.setattr(registry, "get_session_store", lambda: store)
    first = asyncio.run(registry._get_full_text({"pmcid": "PMC123", "sections": ["methods"]}, "a"))
    second = asyncio.run(registry._get_full_text({"pmcid": "123"}, "a"))
    assert first["documentId"] == second["documentId"]
    read = asyncio.run(registry._read_document({"documentId": first["documentId"], "sections": ["results", "tables"]}, "a"))
    assert "Protein results" in str(read)
    assert "S1 | Control" in str(read)
    assert first["metadata"]["supplementaryFiles"][0]["href"] == "samples.xlsx"
    assert first["metadata"]["identifiers"]["doi"] == "10.123/test"
    other = asyncio.run(registry._get_full_text({"pmcid": "PMC123"}, "b"))
    assert other["documentId"] != first["documentId"]
    assert download.await_count == 1
    assert not asyncio.run(registry._read_document({"documentId": first["documentId"]}, "b"))["ok"]


def test_pdf_html_rejected_even_with_pdf_content_type(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    monkeypatch.setattr(publication_cache, "get_bytes", AsyncMock(return_value=(b"<html>Login</html>", "application/pdf")))
    result = asyncio.run(registry._check_pdf_reachable({"url": "https://publisher/paper"}, "a"))
    assert not result["isPdf"]
    assert not list(tmp_path.glob("*.raw"))


def test_pdf_parse_failure_retains_download_for_retry(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    download = AsyncMock(return_value=(b"%PDF-example", "application/pdf"))
    monkeypatch.setattr(publication_cache, "get_bytes", download)
    parser = SimpleNamespace(parse_bytes=AsyncMock(side_effect=[PdfParseError("busy"), ParsedDocument("paper", {"methods": "paper"})]))
    monkeypatch.setattr(registry, "get_pdf_parser", lambda: parser)
    store = SessionStore()
    monkeypatch.setattr(registry, "get_session_store", lambda: store)
    args = {"url": "https://repository/paper.pdf"}
    assert asyncio.run(registry._parse_pdf_url(args, "a"))["status"] == "parse_failed"
    assert asyncio.run(registry._parse_pdf_url(args, "a"))["status"] == "ready"
    assert download.await_count == 1


def test_invalid_xml_is_not_cached(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    monkeypatch.setattr(publication_cache, "get_bytes", AsyncMock(return_value=(b"<html>login</html>", "text/html")))
    with pytest.raises(http.ToolHttpError):
        asyncio.run(publication_cache.cached_download("https://example.org/xml", "xml"))
    assert not list(tmp_path.glob("*.raw"))


def test_transient_errors_retry_but_permanent_errors_do_not(monkeypatch):
    import httpx
    monkeypatch.setattr(http.asyncio, "sleep", AsyncMock())
    transient = AsyncMock(side_effect=[httpx.ReadTimeout("timeout"), http.RetryableHttpError("503"), b"ok"])
    assert asyncio.run(http.retry_request(transient)()) == b"ok"
    assert transient.await_count == 3
    permanent = AsyncMock(side_effect=http.ToolHttpError("404"))
    with pytest.raises(http.ToolHttpError):
        asyncio.run(http.retry_request(permanent)())
    assert permanent.await_count == 1


def test_cache_expires_and_enforces_size_limit(monkeypatch, tmp_path):
    import os
    import time
    settings = configure(monkeypatch, tmp_path)
    settings.publication_cache_max_mb = 1
    settings.publication_cache_ttl_seconds = 60
    old = tmp_path / "old.raw"
    old.write_bytes(b"old")
    os.utime(old, (time.time() - 120, time.time() - 120))
    download = AsyncMock(return_value=(b"%PDF-" + b"a" * 600000, "application/pdf"))
    monkeypatch.setattr(publication_cache, "get_bytes", download)
    asyncio.run(publication_cache.cached_download("https://repository/one.pdf", "pdf"))
    assert not old.exists()
    asyncio.run(publication_cache.cached_download("https://repository/two.pdf", "pdf"))
    assert sum(p.stat().st_size for p in tmp_path.glob("*.raw")) <= 1024 * 1024
    assert len(list(tmp_path.glob("*.raw"))) == 1
