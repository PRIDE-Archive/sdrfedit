"""PRIDE Archive lookups for project metadata and raw/acquisition files.

The two concerns deliberately have separate functions so the assistant can
inspect project-level metadata without also downloading and returning a large
file listing. The frontend also fetches raw file names directly in
``src/app/core/services/pride-archive.service.ts``.
"""

from __future__ import annotations

import re
from typing import Any

from .http import ToolHttpError, get_json

PRIDE_API_BASE = "https://www.ebi.ac.uk/pride/ws/archive/v3"
PROJECT_URL = "https://www.ebi.ac.uk/pride/archive/projects/{accession}"

RAW_EXTENSIONS = (
    ".raw", ".wiff", ".wiff2", ".d", ".baf", ".lcd", ".qgd",
)
RAW_COMPRESSION_SUFFIXES = (".tar.gz", ".tar", ".zip", ".gz")
ACCESSION_RE = re.compile(r"\b(PXD|PRD|MSV|IPX)\d{4,}\b", re.IGNORECASE)


def normalize_accession(value: str) -> str:
    """Extract and upper-case a ProteomeXchange accession from free text."""
    match = ACCESSION_RE.search(value or "")
    if not match:
        raise ToolHttpError(f"'{value}' does not contain a ProteomeXchange accession (e.g. PXD012345).")
    return match.group(0).upper()


def _cv_names(items: Any) -> list[str]:
    if not isinstance(items, list):
        return []
    names: list[str] = []
    for item in items:
        if isinstance(item, dict):
            name = item.get("name") or item.get("value")
            accession = item.get("accession")
            if name:
                names.append(f"{name} ({accession})" if accession else str(name))
        elif item:
            names.append(str(item))
    return names


def _strip_html(text: str | None) -> str:
    if not text:
        return ""
    cleaned = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", cleaned).strip()


async def fetch_project(accession: str) -> dict:
    """Project metadata for SDRF annotation, without text or attribute truncation."""
    accession = normalize_accession(accession)
    payload = await get_json(f"{PRIDE_API_BASE}/projects/{accession}")

    references = []
    for reference in payload.get("references") or []:
        if not isinstance(reference, dict):
            continue
        references.append(
            {
                "citation": reference.get("referenceLine", ""),
                "pubmedId": str(reference["pubmedID"]) if reference.get("pubmedID") else None,
                "doi": reference.get("doi"),
            }
        )

    sample_attributes: list[str] = []
    for group in payload.get("sampleAttributes") or []:
        for item in group if isinstance(group, list) else [group]:
            if isinstance(item, dict):
                key = _strip_html(str(item.get("key", {}).get("name") if isinstance(item.get("key"), dict) else item.get("key")))
                value = _strip_html(str(item.get("value", {}).get("name") if isinstance(item.get("value"), dict) else item.get("value")))
                if key or value:
                    sample_attributes.append(f"{key}: {value}".strip(": "))

    return {
        "accession": accession,
        "title": payload.get("title", ""),
        "description": _strip_html(payload.get("projectDescription")),
        "sampleProcessingProtocol": _strip_html(payload.get("sampleProcessingProtocol")),
        "dataProcessingProtocol": _strip_html(payload.get("dataProcessingProtocol")),
        "organisms": _cv_names(payload.get("organisms")),
        "organismParts": _cv_names(payload.get("organismParts")),
        "diseases": _cv_names(payload.get("diseases")),
        "instruments": _cv_names(payload.get("instruments")),
        "experimentTypes": _cv_names(payload.get("experimentTypes")),
        "quantificationMethods": _cv_names(payload.get("quantificationMethods")),
        "softwares": _cv_names(payload.get("softwares")),
        "identifiedPtms": _cv_names(payload.get("identifiedPTMStrings")),
        "keywords": payload.get("keywords") or [],
        "doi": payload.get("doi"),
        "publicationDate": payload.get("publicationDate"),
        "submissionType": payload.get("submissionType"),
        "references": references,
        "sampleAttributes": sample_attributes,
        "url": PROJECT_URL.format(accession=accession),
    }


def _is_raw(name: str, category: str | None) -> bool:
    # An explicit repository classification takes precedence over the filename.
    # In particular, Mascot .dat files are SEARCH outputs, not acquisitions.
    normalized_category = (category or "").strip().upper()
    if normalized_category:
        return normalized_category == "RAW"
    # With no classification, only infer unambiguous instrument formats.
    # Open formats can also be processed peak lists; sidecars are not runs.
    lowered = name.lower()
    for suffix in RAW_COMPRESSION_SUFFIXES:
        if lowered.endswith(suffix):
            lowered = lowered[:-len(suffix)]
            break
    return any(lowered.endswith(ext) for ext in RAW_EXTENSIONS)


async def fetch_raw_files(accession: str) -> dict:
    """Raw / acquisition file names for a project."""
    accession = normalize_accession(accession)
    payload = await get_json(f"{PRIDE_API_BASE}/projects/{accession}/files/all", timeout=60.0)

    entries = payload if isinstance(payload, list) else payload.get("_embedded", {}).get("files", payload.get("files", []))
    raw_names: list[str] = []
    file_urls: dict[str, str] = {}
    all_count = 0

    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        all_count += 1
        name = entry.get("fileName") or entry.get("name") or ""
        if name and _is_raw(name, entry.get("fileCategory", {}).get("value") if isinstance(entry.get("fileCategory"), dict) else entry.get("fileCategory")):
            raw_names.append(name)
            for location in entry.get("publicFileLocations") or []:
                url = location.get("value", "") if isinstance(location, dict) else location
                if isinstance(url, str) and url.startswith(("ftp://", "https://", "http://")):
                    file_urls.setdefault(name, url)
                    break

    raw_names = sorted(dict.fromkeys(raw_names))
    return {
        "accession": accession,
        "rawFileCount": len(raw_names),
        "totalFileCount": all_count,
        "rawFileNames": raw_names,
        "fileUrls": {name: file_urls[name] for name in raw_names if name in file_urls},
        "truncated": False,
    }
