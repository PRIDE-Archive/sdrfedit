"""Discover a PDF on the configured Sci-Hub mirror after primary sources fail."""
from urllib.parse import quote, urldefrag, urljoin, urlsplit

import httpx
from bs4 import BeautifulSoup

from ..config import get_settings
from .http import ToolHttpError, RetryableHttpError, USER_AGENT, retry_request


def pdf_url_from_html(html: str, page_url: str) -> str:
    soup = BeautifulSoup(html, "html.parser")
    for node in soup.select('iframe[src], embed[src], object[data], a[href]'):
        value = node.get("src") or node.get("data") or node.get("href") or ""
        url = urldefrag(urljoin(page_url, value.strip()))[0]
        parts = urlsplit(url)
        if parts.scheme not in {"http", "https"} or not parts.hostname:
            continue
        # Do not mistake unrelated frames or navigation links for the article.
        if (parts.path.lower().endswith(".pdf") or node.get("id") == "pdf"
                or node.get("type") == "application/pdf"):
            return url
    raise ToolHttpError("No PDF link found (the mirror may require browser verification or lack this paper).")


@retry_request
async def find_pdf_candidate(doi: str, base_url: str) -> dict:
    base_url = base_url.strip()
    parts = urlsplit(base_url)
    if parts.scheme not in {"http", "https"} or not parts.hostname or parts.query or parts.fragment:
        raise ToolHttpError("SCIHUB_BASE_URL must be an HTTP(S) base URL without query or fragment.")
    url = base_url.rstrip("/") + "/" + quote(doi, safe="/")
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True,
                                trust_env=get_settings().scihub_trust_env) as client:
        async with client.stream("GET", url, headers={"User-Agent": USER_AGENT}) as response:
            if response.status_code == 429 or response.status_code >= 500:
                raise RetryableHttpError(f"HTTP {response.status_code} from Sci-Hub.")
            if response.status_code >= 400:
                raise ToolHttpError(f"HTTP {response.status_code} from Sci-Hub; try upload if the mirror is unavailable.")
            if "application/pdf" in response.headers.get("content-type", "").lower():
                # The normal PDF acquisition path validates the signature and size.
                pdf_url = str(response.url)
            else:
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) > 2 * 1024 * 1024:
                        raise ToolHttpError("Sci-Hub discovery page exceeds 2 MB.")
                pdf_url = pdf_url_from_html(body.decode("utf-8", errors="replace"), str(response.url))
    return {"url": pdf_url, "source": "scihub"}
