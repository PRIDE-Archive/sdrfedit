import httpx
import pytest
from types import SimpleNamespace

from app.tools import scihub
from app.tools.http import ToolHttpError
from app.tools import http


@pytest.mark.parametrize("html, expected", [
    ('<iframe id="pdf" src="//cdn.example/paper.pdf#view=FitH"></iframe>', 'https://cdn.example/paper.pdf'),
    ('<embed type="application/pdf" src="/download?id=12">', 'https://mirror.example/download?id=12'),
    ('<object data="../paper.pdf"></object>', 'https://mirror.example/paper.pdf'),
    ('<a href="/paper.pdf?download=1">Save</a>', 'https://mirror.example/paper.pdf?download=1'),
    ('<iframe src="/ads"></iframe><a href="/paper.pdf">Save</a>', 'https://mirror.example/paper.pdf'),
])
def test_extract_pdf_links(html, expected):
    assert scihub.pdf_url_from_html(html, "https://mirror.example/10.123/test") == expected


@pytest.mark.parametrize("html", [
    '<html>Just a moment...</html>', '<a href="/">Home</a>',
    '<iframe id="pdf" src="javascript:alert(1)"></iframe>',
    '<object type="application/pdf" data="file:///tmp/paper.pdf"></object>',
])
def test_missing_or_unsupported_links_fail(html):
    with pytest.raises(ToolHttpError, match="No PDF link"):
        scihub.pdf_url_from_html(html, "https://mirror.example/")


def mock_client(monkeypatch, handler):
    client_class = httpx.AsyncClient
    monkeypatch.setattr(scihub.httpx, "AsyncClient", lambda **kwargs: client_class(
        transport=httpx.MockTransport(handler), **kwargs))


async def test_redirect_uses_final_page_for_relative_pdf(monkeypatch):
    seen = []

    def handler(request):
        seen.append(str(request.url))
        if request.url.host == "mirror.example":
            return httpx.Response(302, headers={"location": "https://other.example/article/view"})
        return httpx.Response(200, text='<iframe id="pdf" src="paper.pdf#view=FitH"></iframe>')

    mock_client(monkeypatch, handler)
    result = await scihub.find_pdf_candidate("10.123/test", "https://mirror.example/")
    assert result == {"url": "https://other.example/article/paper.pdf", "source": "scihub"}
    assert seen[0] == "https://mirror.example/10.123/test"


async def test_direct_pdf_is_returned_for_normal_validation(monkeypatch):
    mock_client(monkeypatch, lambda request: httpx.Response(200, headers={"content-type": "application/pdf"}, content=b"%PDF-test"))
    result = await scihub.find_pdf_candidate("10.123/test", "https://mirror.example/")
    assert result["url"] == "https://mirror.example/10.123/test"


async def test_403_is_not_retried(monkeypatch):
    seen = []

    def handler(request):
        seen.append(request)
        return httpx.Response(403, text="Verification required")

    mock_client(monkeypatch, handler)
    with pytest.raises(ToolHttpError, match="HTTP 403"):
        await scihub.find_pdf_candidate("10.123/test", "https://mirror.example/")
    assert len(seen) == 1


async def test_discovery_page_size_is_bounded(monkeypatch):
    mock_client(monkeypatch, lambda request: httpx.Response(200, content=b"x" * (2 * 1024 * 1024 + 1)))
    with pytest.raises(ToolHttpError, match="exceeds 2 MB"):
        await scihub.find_pdf_candidate("10.123/test", "https://mirror.example/")


@pytest.mark.parametrize("trust_env", [False, True])
async def test_discovery_respects_its_own_proxy_setting(monkeypatch, trust_env):
    import os

    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.example:8080")
    monkeypatch.setattr(scihub, "get_settings", lambda: SimpleNamespace(scihub_trust_env=trust_env))
    environment = dict(os.environ)
    client_class = httpx.AsyncClient
    options = []

    def client(**kwargs):
        options.append(kwargs)
        return client_class(transport=httpx.MockTransport(lambda request: httpx.Response(
            200, text='<iframe id="pdf" src="https://cdn.example/paper.pdf"></iframe>')), **kwargs)

    monkeypatch.setattr(scihub.httpx, "AsyncClient", client)
    await scihub.find_pdf_candidate("10.123/test", "https://mirror.example/")
    assert options[0]["trust_env"] is trust_env
    assert dict(os.environ) == environment


async def test_binary_download_proxy_is_per_request_including_redirects(monkeypatch):
    client_class = httpx.AsyncClient
    options = []
    seen = []

    def handler(request):
        seen.append(str(request.url))
        if request.url.host == "mirror.example":
            return httpx.Response(302, headers={"location": "https://cdn.example/paper.pdf"})
        return httpx.Response(200, content=b"%PDF-test", headers={"content-type": "application/pdf"})

    def client(**kwargs):
        options.append(kwargs)
        return client_class(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(http.httpx, "AsyncClient", client)
    assert (await http.get_bytes("https://mirror.example/paper", trust_env=False))[0] == b"%PDF-test"
    await http.get_bytes("https://publisher.example/paper.pdf")
    assert [option["trust_env"] for option in options] == [False, True]
    assert seen == ["https://mirror.example/paper", "https://cdn.example/paper.pdf", "https://publisher.example/paper.pdf"]
