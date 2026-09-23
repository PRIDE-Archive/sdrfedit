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
    settings = Settings(_env_file=None, publication_cache_dir=str(tmp_path), scihub_base_url="https://mirror.example/")
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


def test_normal_lookup_does_not_contact_fallback(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    request = AsyncMock(return_value={"resultList": {"result": []}})
    fallback = AsyncMock()
    monkeypatch.setattr(literature, "get_json", request)
    monkeypatch.setattr(literature, "find_pdf_candidate", fallback)
    result = asyncio.run(literature.lookup_publication(doi="10.123/test"))
    assert not result["pdfUrls"]
    assert result["fallbackAvailable"]
    assert "useFallback=true" in result["nextStep"]
    assert request.await_count == 1
    fallback.assert_not_awaited()


def test_scihub_fallback_works_without_epmc_record(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    monkeypatch.setattr(literature, "get_json", AsyncMock(return_value={"resultList": {"result": []}}))
    fallback = AsyncMock(return_value={"url": "https://mirror.example/paper.pdf", "source": "scihub"})
    monkeypatch.setattr(literature, "find_pdf_candidate", fallback)
    result = asyncio.run(registry._find_publication({"doi": "https://doi.org/10.123/TEST", "useFallback": True}, "a"))
    assert result["pdfCandidates"] == [{"url": "https://mirror.example/paper.pdf", "source": "scihub"}]
    assert result["found"]
    assert result["fallbackAttempted"]
    assert not result["fallbackAvailable"]
    assert "parse_pdf_url" in result["nextStep"]
    fallback.assert_awaited_once_with("10.123/test", "https://mirror.example/")


def test_fallback_does_not_repeat_primary_sources(monkeypatch, tmp_path):
    configure(monkeypatch, tmp_path)
    monkeypatch.setattr(literature, "get_json", AsyncMock(return_value={"resultList": {"result": [{
        "doi": "10.123/test", "pmcid": "PMC123", "isOpenAccess": "Y",
        "fullTextUrlList": {"fullTextUrl": [{"documentStyle": "pdf", "availabilityCode": "OA", "url": "https://primary/paper.pdf"}]},
    }]}}))
    monkeypatch.setattr(literature, "find_pdf_candidate", AsyncMock(side_effect=http.ToolHttpError("HTTP 403")))
    result = asyncio.run(literature.lookup_publication(doi="10.123/test", use_fallback=True))
    assert result["pdfUrls"] == []
    assert "403" in result["warnings"][0]
    assert "upload" in result["nextStep"]
    assert "get_publication_full_text" not in result["nextStep"]
    assert "useFallback=true" not in result["nextStep"]


@pytest.mark.parametrize("disabled", [True, False])
def test_fallback_requires_config_and_doi(monkeypatch, tmp_path, disabled):
    settings = configure(monkeypatch, tmp_path)
    if disabled:
        settings.scihub_base_url = ""
    monkeypatch.setattr(literature, "get_json", AsyncMock(return_value={"resultList": {"result": []}}))
    fallback = AsyncMock()
    monkeypatch.setattr(literature, "find_pdf_candidate", fallback)
    result = asyncio.run(literature.lookup_publication(doi="10.123/test" if disabled else None,
                                                      pmid=None if disabled else "123", use_fallback=True))
    assert not result["fallbackAvailable"]
    assert "upload" in result["nextStep"]
    fallback.assert_not_awaited()


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


@pytest.mark.parametrize("trust_env", [False, True])
async def test_discovered_scihub_pdf_keeps_proxy_policy_through_download(monkeypatch, tmp_path, trust_env):
    settings = configure(monkeypatch, tmp_path)
    settings.scihub_trust_env = trust_env
    monkeypatch.setattr(registry, "get_settings", lambda: settings)
    store = SessionStore()
    monkeypatch.setattr(registry, "get_session_store", lambda: store)
    url = "https://separate-cdn.example/paper.pdf"
    monkeypatch.setattr(literature, "lookup_publication", AsyncMock(return_value={
        "pdfCandidates": [{"url": url, "source": "scihub"}], "doi": "10.123/test",
    }))
    download = AsyncMock(return_value=(b"%PDF-example", "application/pdf"))
    monkeypatch.setattr(publication_cache, "get_bytes", download)
    monkeypatch.setattr(registry, "get_pdf_parser", lambda: SimpleNamespace(
        parse_bytes=AsyncMock(return_value=ParsedDocument("paper", {"methods": "paper"}))))
    await registry._find_publication({"doi": "10.123/test", "useFallback": True}, "session-a")

    # No proxy/source parameter needs to survive the model round trip.
    result = await registry._parse_pdf_url({"url": url, "doi": "10.123/test"}, "session-a")
    assert result["status"] == "ready"
    assert download.call_args.kwargs["trust_env"] is trust_env
    assert registry._pdf_trust_env("session-b", url) is True

    # Checking an uncached PDF has the same routing as parsing it.
    for file in tmp_path.glob("*.raw"):
        file.unlink()
    assert (await registry._check_pdf_reachable({"url": url}, "session-a"))["isPdf"]
    assert download.call_args.kwargs["trust_env"] is trust_env
    await registry._check_pdf_reachable({"url": "https://publisher.example/primary.pdf"}, "session-a")
    assert download.call_args.kwargs["trust_env"] is True


def test_pdf_source_provenance_is_bounded_and_expires(monkeypatch):
    from app import session

    clock = [1000.0]
    monkeypatch.setattr(session.time, "time", lambda: clock[0])
    monkeypatch.setattr(session, "get_settings", lambda: SimpleNamespace(session_ttl_seconds=60))
    store = SessionStore()
    for i in range(65):
        store.remember_pdf_source("a", f"https://cdn.example/{i}.pdf", "scihub")
        clock[0] += 0.1
    assert store.pdf_source("a", "https://cdn.example/0.pdf") is None
    assert store.pdf_source("a", "https://cdn.example/64.pdf") == "scihub"
    assert store.pdf_source("b", "https://cdn.example/64.pdf") is None
    clock[0] += 61
    assert store.pdf_source("a", "https://cdn.example/64.pdf") is None
    assert not store._pdf_sources
