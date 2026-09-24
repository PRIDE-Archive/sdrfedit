"""Resolve articles, discover primary/fallback PDFs, and extract JATS evidence."""

from __future__ import annotations

import hashlib
import re

from ..config import get_settings

from .http import ToolHttpError, get_json
from .scihub import find_pdf_candidate

EPMC_BASE = "https://www.ebi.ac.uk/europepmc/webservices/rest"

SECTION_ALIASES = {
    "abstract": "abstract",
    "introduction": "introduction",
    "background": "introduction",
    "methods": "methods",
    "method": "methods",
    "materials and methods": "methods",
    "material and methods": "methods",
    "experimental procedures": "methods",
    "experimental section": "methods",
    "results": "results",
    "results and discussion": "results",
    "discussion": "discussion",
    "conclusion": "conclusion",
    "conclusions": "conclusion",
}

# Sections that carry SDRF-relevant detail, in priority order.
PRIORITY_SECTIONS = ("methods", "results", "abstract", "introduction", "discussion", "conclusion")
MAX_SECTION_CHARS = 20000

# Sections omitted from narrative extraction; tables and attachment references are kept separately.
SKIP_SECTIONS = {
    "references", "acknowledgements", "acknowledgments", "footnotes",
    "conflicts of interest", "conflict of interest", "competing interests",
    "associated data", "supplementary material", "supporting information",
    "author contributions", "funding", "abbreviations", "data availability",
}


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def _normalize_section(title: str) -> str:
    lowered = _clean(title).lower().rstrip(".")
    lowered = re.sub(r"^[\d.\s]+", "", lowered)
    for alias, canonical in SECTION_ALIASES.items():
        if lowered == alias or lowered.startswith(alias):
            return canonical
    return lowered or "other"


def normalize_doi(value: str | None) -> str:
    return re.sub(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)", "", (value or "").strip(), flags=re.I).lower()


async def lookup_publication(pmid: str | None = None, doi: str | None = None, title: str | None = None,
                             use_fallback: bool = False) -> dict:
    """Resolve identifiers, discovering fallback PDFs only when explicitly requested."""
    doi = normalize_doi(doi)
    pmid = str(pmid or "").strip()
    if pmid and not pmid.isdigit():
        raise ToolHttpError("PMID must contain digits only.")
    queries = []
    if pmid:
        queries.append(f"EXT_ID:{pmid} AND SRC:MED")
    if doi:
        queries.append(f'DOI:"{doi}"')
    if not queries and title:
        queries.append(f'TITLE:"{_clean(title)}"')
    if not queries:
        raise ToolHttpError("Provide a pmid, doi, or title to look up a publication.")
    record = {}
    warnings = []
    for query in queries:
        try:
            payload = await get_json(f"{EPMC_BASE}/search", params={
                "query": query, "format": "json", "resultType": "core", "pageSize": 2,
            })
        except ToolHttpError as error:
            warnings.append(str(error))
            continue
        results = payload.get("resultList", {}).get("result", [])
        if results:
            record = results[0]
            actual_pmid = str(record.get("pmid") or (record.get("id") if record.get("source") == "MED" else "") or "")
            actual_doi = normalize_doi(record.get("doi"))
            if ((pmid and actual_pmid and pmid != actual_pmid)
                    or (doi and actual_doi and doi != actual_doi)):
                return {"found": False, "status": "identifier_conflict", "query": query,
                        "nextStep": "Ask the user to resolve the PMID/DOI conflict before downloading."}
            if not pmid and not doi:
                return {"found": False, "status": "needs_confirmation", "candidates": results,
                        "nextStep": "Confirm the title match and identifiers before downloading."}
            break

    candidates = []
    for entry in (record.get("fullTextUrlList") or {}).get("fullTextUrl", []):
        if entry.get("documentStyle") == "pdf" and entry.get("availabilityCode") in {"OA", "F"} and entry.get("url"):
            candidates.append({"url": entry["url"], "source": "europepmc"})
    resolved_doi = normalize_doi(record.get("doi")) or doi
    fallback_available = bool(resolved_doi and get_settings().scihub_base_url.strip())
    if use_fallback:
        # Existing Europe PMC candidates have already failed; do not retry them.
        candidates = []
        if fallback_available:
            try:
                candidates.append(await find_pdf_candidate(resolved_doi, get_settings().scihub_base_url))
            except ToolHttpError as error:
                warnings.append(f"Sci-Hub: {error}")
        else:
            warnings.append("Sci-Hub fallback unavailable: a DOI and SCIHUB_BASE_URL are required.")
    candidates = list({c["url"]: c for c in candidates if c["url"].startswith(("https://", "http://"))}.values())
    pmcid = record.get("pmcid")
    open_full_text = bool(pmcid) and record.get("isOpenAccess") == "Y" and not use_fallback
    return {
        "found": bool(record or candidates),
        "status": "full_text_available" if open_full_text or candidates else ("abstract_only" if record.get("abstractText") else "unavailable"),
        "pmid": record.get("pmid") or (record.get("id") if record.get("source") == "MED" else pmid),
        "pmcid": pmcid, "doi": resolved_doi, "title": _clean(record.get("title")),
        "journal": ((record.get("journalInfo") or {}).get("journal") or {}).get("title"),
        "year": record.get("pubYear"), "isOpenAccess": record.get("isOpenAccess") == "Y",
        "fullTextAvailable": open_full_text, "abstract": _clean(record.get("abstractText")),
        "pdfUrls": [c["url"] for c in candidates], "pdfCandidates": candidates, "warnings": warnings,
        "url": f"https://doi.org/{resolved_doi}" if resolved_doi else f"https://europepmc.org/article/MED/{pmid}",
        "fallbackAvailable": fallback_available and not use_fallback,
        "fallbackAttempted": use_fallback,
        "nextStep": _next_step(open_full_text and not use_fallback, bool(candidates), fallback_available and not use_fallback),
    }


def _next_step(open_full_text: bool, has_pdf: bool, fallback_available: bool) -> str:
    fallback = (
        "If these sources are unavailable or fail, call find_publication with the resolved DOI "
        "and useFallback=true to try Sci-Hub before offering upload. "
        if fallback_available else
        "If acquisition fails, offer upload; do not repeat fallback discovery. "
    )
    if open_full_text:
        return ("Call get_publication_full_text first: it stores XML as a session document. "
                "Then read_document using its documentId. If XML fails, try each pdfUrls with "
                "parse_pdf_url. " + fallback)
    if has_pdf:
        return ("Call parse_pdf_url for the pdfUrls candidates in order until one succeeds, "
                "passing the resolved DOI, then read_document. check_pdf_url is optional. " + fallback)
    if fallback_available:
        return ("Call list_documents and reuse the matching paper if present. Otherwise call "
                "find_publication with the resolved DOI and useFallback=true to try Sci-Hub.")
    return ("Call list_documents and reuse the matching paper if present. Otherwise ask the user to "
            "upload the paper and stop before proposing templates. If they continue without upload, "
            "use PRIDE metadata and label any abstract as abstract-only evidence.")


async def fetch_full_text(pmcid: str, sections: list[str] | None = None) -> dict:
    """Fetch and clean the Europe PMC JATS full text for a PMC article."""
    normalized = pmcid.strip().upper()
    if normalized.isdigit():
        normalized = f"PMC{normalized}"
    if not re.fullmatch(r"PMC[0-9]+", normalized):
        raise ToolHttpError("Invalid PMCID.")

    from .publication_cache import cached_download

    try:
        raw, raw_path = await cached_download(f"{EPMC_BASE}/{normalized}/fullTextXML", "xml")
    except ToolHttpError as error:
        raise ToolHttpError(
            f"Could not retrieve Europe PMC full text for {normalized} ({error}). "
            "Try the publication PDF candidates before offering upload."
        ) from error

    parsed = parse_jats(raw)
    wanted = [s.lower() for s in sections] if sections else None
    selected = {
        name: text for name, text in parsed["sections"].items() if not wanted or name in wanted
    }
    if not selected:
        selected = parsed["sections"]

    return {
        "rawPath": raw_path,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "identifiers": parsed["identifiers"],
        "license": parsed["license"],
        "allSections": parsed["sections"],
        "tables": parsed["tables"],
        "supplementaryFiles": parsed["supplementaryFiles"],
        "pmcid": normalized,
        "title": parsed["title"],
        "sections": {name: text[:MAX_SECTION_CHARS] for name, text in selected.items()},
        "availableSections": list(parsed["sections"].keys()),
        "url": f"https://europepmc.org/article/PMC/{normalized}",
    }


def parse_jats(xml: str | bytes) -> dict:
    """Convert JATS XML into `{title, sections: {name: text}}`."""
    from bs4 import BeautifulSoup

    soup = BeautifulSoup(xml, "lxml-xml")

    if soup.find("article") is None or soup.find("body") is None:
        raise ToolHttpError("Response is not full-text JATS XML.")
    tables = [{"id": t.get("id"), "text": _clean(t.get_text(" ")),
               "rows": [[_clean(c.get_text(" ")) for c in row.find_all(["th", "td"])]
                        for row in t.find_all("tr")]} for t in soup.find_all("table-wrap")]
    supplements = []
    for item in soup.find_all("supplementary-material"):
        for link in [item, *item.find_all(["media", "ext-link"])]:
            href = link.get("xlink:href") or link.get("href")
            if href:
                supplements.append({"href": href, "label": _clean(item.get_text(" ")),
                                    "downloaded": False})

    for tag in soup.find_all(["xref", "table-wrap", "fig", "graphic", "ref-list", "back"]):
        tag.decompose()

    title_tag = soup.find("article-title")
    title = _clean(title_tag.get_text(" ") if title_tag else "")

    sections: dict[str, list[str]] = {}

    abstract = soup.find("abstract")
    if abstract:
        sections.setdefault("abstract", []).append(_clean(abstract.get_text(" ")))

    body = soup.find("body")
    if body:
        top_sections = body.find_all("sec", recursive=False) or body.find_all("sec")
        for section in top_sections:
            title_node = section.find("title")
            name = _normalize_section(title_node.get_text(" ") if title_node else "other")
            if name in SKIP_SECTIONS:
                continue
            text = _clean(section.get_text(" "))
            if text:
                sections.setdefault(name, []).append(text)
        if not top_sections:
            sections.setdefault("body", []).append(_clean(body.get_text(" ")))

    merged = {name: "\n\n".join(parts) for name, parts in sections.items() if any(parts)}
    ordered = {name: merged[name] for name in PRIORITY_SECTIONS if name in merged}
    ordered.update({name: text for name, text in merged.items() if name not in ordered})
    if tables:
        ordered["tables"] = "\n\n".join(t["text"] + "\n" + "\n".join(" | ".join(row) for row in t["rows"]) for t in tables)
    if not any(text.strip() for name, text in ordered.items() if name != "abstract"):
        raise ToolHttpError("JATS response has no usable full-text body.")
    if supplements:
        ordered["supplementary references"] = "\n".join(f"{x['label']}: {x['href']}" for x in supplements)
    identifiers = {t.get("pub-id-type"): _clean(t.get_text()) for t in soup.find_all("article-id")}
    license_tag = soup.find("license")
    return {"title": title, "sections": ordered, "tables": tables, "supplementaryFiles": supplements,
            "identifiers": identifiers, "license": _clean(license_tag.get_text(" ")) if license_tag else None}
