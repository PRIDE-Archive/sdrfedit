"""Tool schemas and dispatch for the agent loop.

Each entry is an OpenAI-style function declaration plus an async handler. The
handler receives the parsed arguments and the current session id, and returns a
JSON-serialisable result that is fed back to the model.
"""

from __future__ import annotations

import json
import hashlib
from collections.abc import Awaitable, Callable
from typing import Any

from ..parsing.base import ParsedDocument, PdfParseError
from ..parsing.factory import get_pdf_parser
from ..session import get_session_store
from . import celllines, literature, ontology, pride, spec_search, templates
from .http import ToolHttpError, get_bytes
from .publication_cache import cached_download

Handler = Callable[[dict[str, Any], str], Awaitable[Any]]

MAX_RESULT_CHARS = 24000
MAX_DOCUMENT_CHARS = 12000
MAX_SUMMARY_CHARS = 240


# --------------------------------------------------------------------- handlers


async def _get_metadata(args: dict, _session: str) -> Any:
    return await pride.fetch_project(args["accession"])


async def _get_raw_files(args: dict, _session: str) -> Any:
    return await pride.fetch_raw_files(args["accession"], int(args.get("limit", 400)))


async def _find_publication(args: dict, _session: str) -> Any:
    result = await literature.lookup_publication(
        pmid=args.get("pmid"), doi=args.get("doi"), title=args.get("title")
    )
    # Discovery returns identifiers and acquisition routes, not article content
    # or the upstream search response. Keep license/version for PDF acquisition.
    fields = ("found", "status", "pmid", "pmcid", "doi", "title", "url", "fullTextAvailable")
    compact = {key: result[key] for key in fields if result.get(key) is not None and result.get(key) != ""}
    if result.get("pdfCandidates"):
        compact["pdfCandidates"] = result["pdfCandidates"]
    elif result.get("pdfUrls"):
        compact["pdfCandidates"] = [{"url": url} for url in result["pdfUrls"]]
    if result.get("candidates"):
        compact["candidates"] = [
            {key: value for key, value in {
                "pmid": candidate.get("pmid") or (candidate.get("id") if candidate.get("source") == "MED" else None),
                "pmcid": candidate.get("pmcid"), "doi": candidate.get("doi"),
                "title": candidate.get("title"), "year": candidate.get("pubYear"),
            }.items() if value}
            for candidate in result["candidates"]
        ]
    if result.get("warnings"):
        compact["warnings"] = result["warnings"]
    if result.get("nextStep"):
        compact["nextStep"] = result["nextStep"].replace("pdfUrls", "pdfCandidates")
    return compact


def _document_result(stored, cached=False) -> dict:
    return {"ok": True, "status": "ready", "documentId": stored.document_id,
            "cached": cached, "parser": stored.document.parser,
            "fileName": stored.file_name, "url": stored.origin,
            "pmcid": stored.metadata.get("pmcid"), "title": stored.metadata.get("title"),
            "createdAt": stored.created_at,
            "charCount": stored.document.char_count,
            "availableSections": list(stored.document.sections), "metadata": stored.metadata,
            "nextStep": "Call read_document with this documentId (methods/results/tables)."}


async def _get_full_text(args: dict, session_id: str) -> Any:
    pmcid = args["pmcid"].strip().upper()
    if pmcid.isdigit():
        pmcid = "PMC" + pmcid
    store = get_session_store()
    for stored in store.list_for_session(session_id):
        if stored.metadata.get("pmcid") == pmcid:
            return _document_result(stored, True)
    try:
        result = await literature.fetch_full_text(pmcid)
    except ToolHttpError as error:
        return {"ok": False, "status": "download_failed", "error": str(error),
                "nextStep": "Try each open pdfUrls candidate with parse_pdf_url before offering upload."}
    sections = result.pop("allSections")
    document = ParsedDocument(markdown="\n\n".join(f"## {k}\n{v}" for k, v in sections.items()),
                              sections=sections, parser="europepmc-jats")
    stored = store.add_document(session_id, f"{pmcid}.xml", document, origin=result["url"],
        metadata={"pmcid": pmcid, "title": result["title"], "source": "europepmc", "format": "xml", "rawPath": result["rawPath"],
                  "sha256": result["sha256"], "identifiers": result["identifiers"],
                  "license": result["license"], "supplementaryFiles": result["supplementaryFiles"]})
    return _document_result(stored)


async def _search_specification(args: dict, _session: str) -> Any:
    return await spec_search.search_specification(args["query"], int(args.get("k", 5)))


async def _search_ontology(args: dict, _session: str) -> Any:
    return await ontology.search_terms(
        args["query"],
        column=args["column"],
        ontologies=args.get("ontologies"),
        limit=int(args.get("limit", 8)),
    )


async def _verify_ontology_term(args: dict, _session: str) -> Any:
    return await ontology.verify_term(args["accession"], args.get("expectedLabel"))


async def _search_cell_line(args: dict, _session: str) -> Any:
    return await celllines.search_cell_line(args["query"], int(args.get("limit", 8)))


async def _verify_cellosaurus(args: dict, _session: str) -> Any:
    return await celllines.verify_cellosaurus_accession(
        args["accession"], args.get("expectedLabel")
    )


async def _list_templates(args: dict, _session: str) -> Any:
    return await templates.list_templates(args.get("layer"))


async def _get_template_columns(args: dict, _session: str) -> Any:
    return await templates.get_template_columns(args["name"], args.get("version"))


async def _validate_templates(args: dict, _session: str) -> Any:
    return await templates.validate_combination(
        args.get("technology"), args.get("sample"), args.get("experiments") or []
    )


async def _parse_pdf_url(args: dict, session_id: str) -> Any:
    url = args["url"]
    doi = literature.normalize_doi(args.get("doi"))
    store = get_session_store()
    for stored in store.list_for_session(session_id):
        if stored.origin == url or (doi and stored.metadata.get("doi") == doi
                                    and stored.metadata.get("version") == args.get("version")):
            return _document_result(stored, True)
    try:
        data, path = await cached_download(url, "pdf")
    except ToolHttpError as error:
        return {"ok": False, "status": "download_failed", "error": str(error),
                "nextStep": "Try the next open PDF candidate; offer upload if all fail."}
    try:
        document = await get_pdf_parser().parse_bytes(data, "paper.pdf")
        if not document.markdown.strip():
            raise PdfParseError("PDF parser returned empty text.")
    except (PdfParseError, ToolHttpError) as error:
        return {"ok": False, "status": "parse_failed", "error": str(error), "rawPath": path,
                "nextStep": "The PDF is cached. Retry parsing after fixing the parser or try another candidate."}
    stored = store.add_document(session_id, "paper.pdf", document, origin=url,
        metadata={"source": url, "format": "pdf", "rawPath": path,
                  "sha256": hashlib.sha256(data).hexdigest(), "doi": doi or None,
                  "pmid": args.get("pmid"), "license": args.get("license"), "version": args.get("version")})
    return _document_result(stored)


async def _check_pdf_reachable(args: dict, _session: str) -> Any:
    try:
        data, _ = await cached_download(args["url"], "pdf")
    except ToolHttpError as error:
        return {"reachable": False, "isPdf": False, "error": str(error)}
    return {"reachable": True, "isPdf": True, "bytes": len(data), "contentType": "application/pdf"}


async def _list_documents(_args: dict, session_id: str) -> Any:
    stored = get_session_store().list_for_session(session_id)
    return {
        "documents": [
            {
                "documentId": d.document_id,
                "fileName": d.file_name,
                **({"title": d.metadata["title"]} if d.metadata.get("title") else {}),
                "availableSections": list(d.document.sections) or ["body"],
            }
            for d in stored
        ]
    }


async def _read_document(args: dict, session_id: str) -> Any:
    stored = get_session_store().get(args["documentId"])
    if not stored:
        return {
            "ok": False, "status": "document_not_found",
            "error": "Unknown documentId. Use the returned documentId, not a filename or publication accession.",
            "availableDocuments": (await _list_documents({}, session_id))["documents"],
            "nextStep": "Match the intended paper against availableDocuments and retry read_document with its exact documentId. "
                        "If no matching document exists, call list_documents to refresh; then reacquire a public paper "
                        "using get_publication_full_text or the publication PDF workflow. Ask for re-upload only "
                        "when the missing document was user-provided and cannot otherwise be recovered. Do not guess an ID.",
        }
    if stored.session_id != session_id:
        return {"ok": False, "error": "That document belongs to a different session."}

    wanted = args.get("sections")
    limit = args.get("maxChars", MAX_DOCUMENT_CHARS)
    offset = args.get("offset", 0)
    if type(limit) is not int or limit <= 0:
        return {"ok": False, "error": "maxChars must be a positive integer."}
    if type(offset) is not int or offset < 0:
        return {"ok": False, "error": "offset must be a non-negative integer."}
    limit = min(limit, MAX_DOCUMENT_CHARS)
    sections = stored.document.sections or {"body": stored.document.markdown}
    if wanted is not None and (not isinstance(wanted, list) or not wanted or
                               any(not isinstance(name, str) or not name.strip() for name in wanted)):
        return {"ok": False, "error": "sections must be a non-empty array of chapter names."}
    names = list(dict.fromkeys(name.strip().lower() for name in wanted)) if wanted else list(sections)
    missing = [name for name in names if name not in sections]
    selected = [name for name in names if name in sections]
    if not selected:
        return {"ok": False, "error": "Requested sections were not found.",
                "missingSections": missing, "availableSections": list(sections)}
    if offset and len(names) != 1:
        return {"ok": False, "error": "Use offset with exactly one section. Follow a nextReads entry."}
    if offset > len(sections[selected[0]]):
        return {"ok": False, "error": "offset exceeds the section length.",
                "totalChars": len(sections[selected[0]])}

    def page(budget: int) -> dict:
        output, info, next_reads = {}, {}, []
        for name in selected:
            text = sections[name]
            chunk = text[offset:offset + budget]
            end = offset + len(chunk)
            budget -= len(chunk)
            if chunk or offset == len(text):
                output[name] = chunk
            info[name] = {"offset": offset, "returnedChars": len(chunk), "totalChars": len(text),
                          "truncated": end < len(text)}
            if end < len(text):
                next_reads.append({"documentId": stored.document_id, "sections": [name],
                                   "offset": end, "maxChars": limit})
        return {"ok": True, "documentId": stored.document_id, "fileName": stored.file_name,
                "availableSections": list(sections), "sections": output, "sectionInfo": info,
                "missingSections": missing, "truncated": bool(next_reads), "nextReads": next_reads}

    result = page(limit)
    # Escaped characters and metadata count towards the serialized tool budget.
    # Rebuild a smaller page so continuation offsets always match returned text.
    while len(json.dumps(result, ensure_ascii=False)) > MAX_RESULT_CHARS and limit > 1:
        limit = max(1, limit // 2)
        result = page(limit)
    return result


# -------------------------------------------------------------------- summaries
#
# Every tool result is shown to the user as a collapsible row, so each tool needs
# a one-line gist that is readable without expanding the raw JSON.


def _join(items: list[Any], limit: int = 3) -> str:
    if not items:
        return ""
    head = ", ".join(str(item) for item in items[:limit] if item)
    return f"{head}, …" if len(items) > limit else head


def _summarize_metadata(result: dict) -> str:
    parts: list[str] = [result.get("accession") or "PRIDE project"]
    if result.get("organisms"):
        parts.append(_join(result["organisms"], 2))
    if result.get("instruments"):
        parts.append(_join(result["instruments"], 2))
    if result.get("references"):
        parts.append(f"{len(result['references'])} reference(s)")
    return " · ".join(part for part in parts if part)


def _summarize_raw_files(result: dict) -> str:
    names = result.get("rawFileNames") or []
    count = result.get("rawFileCount", len(names))
    listed = _join(names, 2)
    return f"{count} raw files" + (f": {listed}" if listed else "")


def _summarize_publication(result: dict) -> str:
    if not result.get("found"):
        return {"identifier_conflict": "PMID/DOI conflict — verification required",
                "needs_confirmation": "Title match needs confirmation"}.get(result.get("status"), "No downloadable publication found")
    parts = [result.get("title") or "Untitled"]
    if result.get("journal"):
        parts.append(str(result["journal"]))
    parts.append("open full text" if result.get("fullTextAvailable") else "no open full text")
    pdfs = result.get("pdfCandidates") or result.get("pdfUrls") or []
    if pdfs:
        parts.append(f"{len(pdfs)} PDF link(s)")
    return " · ".join(parts)


def _summarize_full_text(result: dict) -> str:
    if result.get("ok") is False:
        return result.get("error") or "Full-text download failed"
    return f"{result.get('pmcid') or 'Article'} · {_join(result.get('availableSections') or [], 4)} · {result.get('charCount', 0):,} chars"


def _summarize_spec(result: dict) -> str:
    passages = result.get("passages") or []
    if not passages:
        return result.get("note") or "No matching passage"
    return f"{len(passages)} passages: " + _join([p.get("section") or "?" for p in passages], 3)


def _summarize_ontology(result: dict) -> str:
    if result.get("ok") is False:
        return result.get("error") or result.get("hint") or f"No match for '{result.get('query')}'"
    if result.get("reserved"):
        return result.get("note") or "Reserved SDRF value"
    terms = result.get("terms") or []
    if not terms:
        return f"No match for '{result.get('query')}'"
    return f"{len(terms)} hits: " + _join([f"{t.get('label')} ({t.get('id')})" for t in terms], 3)


def _summarize_verify(result: dict) -> str:
    accession = result.get("accession")
    if not result.get("valid"):
        return f"{accession} invalid: {result.get('reason') or 'not found in OLS'}"
    label = (result.get("term") or {}).get("label")
    if result.get("labelMatches") is False:
        return f"{accession} is '{label}' - {result.get('reason') or 'label mismatch'}"
    return f"{accession} = {label}"


def _summarize_cell_line(result: dict) -> str:
    matches = result.get("matches") or []
    if not matches:
        return f"No cell-line match for '{result.get('query')}'"
    top = matches[0]
    accession = top.get("cellosaurusAccession") or "no CVCL"
    return (
        f"{len(matches)} hit(s): {top.get('cellLine')} ({accession})"
        + (f" · {result.get('retrieval')}" if result.get("retrieval") else "")
    )


def _summarize_cellosaurus_verify(result: dict) -> str:
    accession = result.get("accession")
    if not result.get("valid"):
        return f"{accession} invalid: {result.get('reason') or 'not in cell-line DB'}"
    term = result.get("term") or {}
    name = term.get("cellosaurusName") or term.get("cellLine")
    if result.get("labelMatches") is False:
        return f"{accession} is '{name}' - {result.get('reason') or 'label mismatch'}"
    return f"{accession} = {name}"


def _summarize_templates(result: dict) -> str:
    layers = result.get("layers") or {}
    return " · ".join(f"{layer}: {len(items)}" for layer, items in layers.items()) or "No templates"


def _summarize_template_columns(result: dict) -> str:
    required = result.get("requiredColumns") or []
    columns = result.get("columns") or []
    return (
        f"{result.get('name')} ({result.get('layer') or 'unknown layer'}) · "
        f"{len(required)} required of {len(columns)} columns"
    )


def _summarize_validation(result: dict) -> str:
    if result.get("valid"):
        warnings = result.get("warnings") or []
        return "Combination is valid" + (f" · {len(warnings)} warning(s)" if warnings else "")
    return "Invalid: " + _join(result.get("errors") or ["unknown reason"], 2)


def _summarize_pdf_check(result: dict) -> str:
    if not result.get("reachable"):
        return f"Not reachable: {result.get('error') or 'unknown error'}"
    kilobytes = int(result.get("bytes") or 0) // 1024
    kind = "PDF" if result.get("isPdf") else (result.get("contentType") or "unknown type")
    return f"Reachable · {kind} · {kilobytes:,} KB"


def _summarize_parse(result: dict) -> str:
    if not result.get("ok"):
        return f"Parse failed: {result.get('error') or 'unknown error'}"
    return (
        f"Parsed with {result.get('parser')} · {int(result.get('charCount') or 0):,} chars · "
        f"{_join(result.get('availableSections') or [], 4)}"
    )


def _summarize_documents(result: dict) -> str:
    documents = result.get("documents") or []
    if not documents:
        return "No documents uploaded in this session"
    names = [d.get("fileName") or d.get("documentId") for d in documents]
    return f"{len(documents)} document(s): " + _join(names, 3)


def _summarize_read_document(result: dict) -> str:
    if not result.get("ok"):
        return f"Could not read: {result.get('error') or 'unknown error'}"
    sections = result.get("sections") or {}
    chars = sum(len(text or "") for text in sections.values())
    suffix = " · more available" if result.get("truncated") else ""
    if result.get("missingSections"):
        suffix += " · missing: " + _join(result["missingSections"], 4)
    return f"{result.get('fileName')} · {_join(list(sections), 4)} · {chars:,} chars{suffix}"


# ---------------------------------------------------------------------- schemas

TOOLS: list[dict[str, Any]] = [
    {
        "declaration": {
            "name": "get_pride_metadata",
            "description": (
                "Fetch only PRIDE Archive project metadata and publication references for a "
                "ProteomeXchange accession. Does not fetch raw files. Always the first step "
                "when the user gives a PXD identifier."
            ),
            "parameters": {
                "type": "object",
                "properties": {"accession": {"type": "string", "description": "e.g. PXD012345"}},
                "required": ["accession"],
            },
        },
        "handler": _get_metadata,
        "status": "Fetching PRIDE metadata",
        "title": "PRIDE metadata",
        "summarize": _summarize_metadata,
    },
    {
        "declaration": {
            "name": "get_pride_raw_files",
            "description": "Fetch only the raw/acquisition file names for a ProteomeXchange accession.",
            "parameters": {
                "type": "object",
                "properties": {
                    "accession": {"type": "string"},
                    "limit": {"type": "integer", "description": "Max file names to return (default 400)."},
                },
                "required": ["accession"],
            },
        },
        "handler": _get_raw_files,
        "status": "Listing raw files",
        "title": "PRIDE raw files",
        "summarize": _summarize_raw_files,
    },
    {
        "declaration": {
            "name": "find_publication",
            "description": (
                "Resolve a paper by PMID, DOI, or title through Europe PMC. Reports whether "
                "open full text exists and which PDF URLs are available."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "pmid": {"type": "string"},
                    "doi": {"type": "string"},
                    "title": {"type": "string"},
                },
            },
        },
        "handler": _find_publication,
        "status": "Looking up the publication",
        "title": "Publication lookup",
        "summarize": _summarize_publication,
    },
    {
        "declaration": {
            "name": "get_publication_full_text",
            "description": "Download Europe PMC JATS XML and store the complete article as a session document. Returns documentId for read_document. Prefer this when fullTextAvailable is true.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pmcid": {"type": "string", "description": "e.g. PMC1234567"},
                    "sections": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Legacy option; the full article is stored. Use read_document to select sections.",
                    },
                },
                "required": ["pmcid"],
            },
        },
        "handler": _get_full_text,
        "status": "Reading the paper",
        "title": "Paper full text",
        "summarize": _summarize_full_text,
    },
    {
        "declaration": {
            "name": "check_pdf_url",
            "description": "Check whether a candidate PDF URL is downloadable before parsing it.",
            "parameters": {
                "type": "object",
                "properties": {"url": {"type": "string"}},
                "required": ["url"],
            },
        },
        "handler": _check_pdf_reachable,
        "status": "Checking the PDF link",
        "title": "PDF link check",
        "summarize": _summarize_pdf_check,
    },
    {
        "declaration": {
            "name": "parse_pdf_url",
            "description": (
                "Download and validate an open PDF candidate, cache the original, and parse it "
                "with MinerU into a session document. Use after XML is unavailable or fails. "
                "Try alternate candidates on failure before asking for upload. "
                "Pass PMID/DOI and license/version from discovery when available."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string"},
                    "doi": {"type": "string"}, "pmid": {"type": "string"},
                    "license": {"type": "string"}, "version": {"type": "string"},
                },
                "required": ["url"],
            },
        },
        "handler": _parse_pdf_url,
        "status": "Parsing the PDF with MinerU",
        "title": "PDF parse (MinerU)",
        "summarize": _summarize_parse,
    },
    {
        "declaration": {
            "name": "list_documents",
            "description": "List available session documents with documentId, fileName, optional title, and availableSections. Includes uploads, pasted text, and retrieved articles. Use to discover documents; if documentId and sections are already known, call read_document directly.",
            "parameters": {"type": "object", "properties": {}},
        },
        "handler": _list_documents,
        "status": "Checking available documents",
        "title": "Available documents",
        "summarize": _summarize_documents,
    },
    {
        "declaration": {
            "name": "read_document",
            "description": (
                "Read sections of a parsed document. Prefer sections ['methods','results'] for "
                "SDRF annotation evidence. Prefer one section per call. maxChars is a shared character "
                "budget (default and maximum 12000), not a token count. Check missingSections and "
                "sectionInfo; when truncated, use nextReads arguments to continue without skipping text."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "documentId": {"type": "string", "description": "Exact opaque ID returned by list_documents, get_publication_full_text, or parse_pdf_url (e.g. doc_...). Never use fileName, PMCID, DOI, or a guessed ID. On failure refresh the session document list."},
                    "sections": {"type": "array", "items": {"type": "string"}},
                    "maxChars": {"type": "integer", "minimum": 1, "maximum": MAX_DOCUMENT_CHARS},
                    "offset": {"type": "integer", "minimum": 0, "description": "Character offset within exactly one requested section; use nextReads to continue."},
                },
                "required": ["documentId"],
            },
        },
        "handler": _read_document,
        "status": "Reading the paper",
        "title": "Document sections",
        "summarize": _summarize_read_document,
    },
    {
        "declaration": {
            "name": "search_specification",
            "description": (
                "Search the SDRF-Proteomics specification knowledge base. Use this for any "
                "question about format rules, column names, reserved words, or cell value syntax, "
                "and to double-check a rule before proposing a value."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "k": {"type": "integer", "description": "Number of passages (default 5)."},
                },
                "required": ["query"],
            },
        },
        "handler": _search_specification,
        "status": "Searching the SDRF specification",
        "title": "SDRF specification",
        "summarize": _summarize_spec,
    },
    {
        "declaration": {
            "name": "search_ontology",
            "description": (
                "Search EBI OLS for ontology terms for an SDRF column. Required before proposing "
                "any ontology-backed characteristic (required or recommended), e.g. organism, "
                "disease, culture medium. Pass column + a short query (not a full recipe). "
                "For cell lines / Cellosaurus accessions (CVCL_…), use search_cell_line instead."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Short candidate value, e.g. 'RPMI 1640' or 'Homo sapiens'.",
                    },
                    "column": {
                        "type": "string",
                        "description": "SDRF column, e.g. 'characteristics[culture medium]' — selects ontologies.",
                    },
                    "ontologies": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Optional override; normally omit and let column mapping choose.",
                    },
                    "limit": {"type": "integer"},
                },
                "required": ["query", "column"],
            },
        },
        "handler": _search_ontology,
        "status": "Verifying ontology terms",
        "title": "Ontology search",
        "summarize": _summarize_ontology,
    },
    {
        "declaration": {
            "name": "verify_ontology_term",
            "description": (
                "Confirm an OLS CURIE (e.g. UNIMOD:4, MS:1000031) exists and matches a label. "
                "Do NOT use for Cellosaurus CVCL_… ids — use verify_cellosaurus_accession."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "accession": {"type": "string", "description": "e.g. UNIMOD:4"},
                    "expectedLabel": {"type": "string"},
                },
                "required": ["accession"],
            },
        },
        "handler": _verify_ontology_term,
        "status": "Verifying an accession",
        "title": "Accession check",
        "summarize": _summarize_verify,
    },
    {
        "declaration": {
            "name": "search_cell_line",
            "description": (
                "Search the local Cellosaurus / cell-line knowledge base (curated TSV + vector "
                "index). Use this for characteristics[cell line] and characteristics[cellosaurus "
                "accession]. Returns official name, CVCL_ accession, disease, organism part, "
                "sex, age, and synonyms."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Cell-line name, synonym, or CVCL_ accession.",
                    },
                    "limit": {"type": "integer"},
                },
                "required": ["query"],
            },
        },
        "handler": _search_cell_line,
        "status": "Searching cell-line DB",
        "title": "Cell-line search",
        "summarize": _summarize_cell_line,
    },
    {
        "declaration": {
            "name": "verify_cellosaurus_accession",
            "description": (
                "Confirm a Cellosaurus accession (CVCL_…) exists in the local cell-line database "
                "and optionally matches an expected cell-line name."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "accession": {"type": "string", "description": "e.g. CVCL_0030"},
                    "expectedLabel": {"type": "string"},
                },
                "required": ["accession"],
            },
        },
        "handler": _verify_cellosaurus,
        "status": "Verifying Cellosaurus id",
        "title": "Cellosaurus check",
        "summarize": _summarize_cellosaurus_verify,
    },
    {
        "declaration": {
            "name": "list_sdrf_templates",
            "description": "List SDRF templates by layer, with the wizard's selection rules.",
            "parameters": {
                "type": "object",
                "properties": {
                    "layer": {"type": "string", "enum": ["technology", "sample", "experiment"]},
                },
            },
        },
        "handler": _list_templates,
        "status": "Listing SDRF templates",
        "title": "SDRF templates",
        "summarize": _summarize_templates,
    },
    {
        "declaration": {
            "name": "get_template_columns",
            "description": "Resolve a template's inherited column list with requirement levels.",
            "parameters": {
                "type": "object",
                "properties": {"name": {"type": "string"}, "version": {"type": "string"}},
                "required": ["name"],
            },
        },
        "handler": _get_template_columns,
        "status": "Reading template columns",
        "title": "Template columns",
        "summarize": _summarize_template_columns,
    },
    {
        "declaration": {
            "name": "validate_template_combination",
            "description": "Validate a technology + sample + experiment template combination.",
            "parameters": {
                "type": "object",
                "properties": {
                    "technology": {"type": "string"},
                    "sample": {"type": "string"},
                    "experiments": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
        "handler": _validate_templates,
        "status": "Validating template selection",
        "title": "Template validation",
        "summarize": _summarize_validation,
    },
]

_BY_NAME = {tool["declaration"]["name"]: tool for tool in TOOLS}


def openai_tool_specs() -> list[dict]:
    return [{"type": "function", "function": tool["declaration"]} for tool in TOOLS]


def status_for(name: str) -> str:
    tool = _BY_NAME.get(name)
    return tool["status"] if tool else f"Running {name}"


def title_for(name: str) -> str:
    """Short display name for the tool row in the panel."""
    tool = _BY_NAME.get(name)
    return tool.get("title") or name if tool else name


def describe(name: str, result: Any) -> tuple[str, bool]:
    """One-line gist of a tool result plus whether it needs the user's attention."""
    if not isinstance(result, dict):
        return _truncate_summary(str(result)), True

    error = result.get("error")
    if error:
        return _truncate_summary(f"Failed: {str(error).splitlines()[0]}"), False

    summarize = (_BY_NAME.get(name) or {}).get("summarize")
    if not summarize:
        return _truncate_summary(json.dumps(result, ensure_ascii=False, default=str)), True

    try:
        summary = summarize(result)
    except Exception:  # noqa: BLE001 - a broken summary must not kill the turn
        summary = ""
    return _truncate_summary(summary or "Completed"), _result_ok(result)


def _result_ok(result: dict) -> bool:
    """False for outcomes the user should look at: not found, invalid, unparsable."""
    return not any(result.get(key) is False for key in ("ok", "reachable", "valid", "found"))


def _truncate_summary(text: str) -> str:
    collapsed = " ".join((text or "").split())
    return collapsed if len(collapsed) <= MAX_SUMMARY_CHARS else f"{collapsed[:MAX_SUMMARY_CHARS]}…"


async def dispatch(name: str, raw_arguments: str | dict, session_id: str) -> str:
    """Execute a tool and return a JSON string for the model."""
    tool = _BY_NAME.get(name)
    if not tool:
        return json.dumps({"error": f"Unknown tool '{name}'."})

    if isinstance(raw_arguments, str):
        try:
            args = json.loads(raw_arguments or "{}")
        except json.JSONDecodeError as error:
            return json.dumps({"error": f"Arguments were not valid JSON: {error}"})
    else:
        args = raw_arguments or {}

    try:
        result = await tool["handler"](args, session_id)
    except KeyError as error:
        result = {"error": f"Missing required argument: {error}"}
    except (ToolHttpError, PdfParseError) as error:
        result = {"error": str(error)}
    except Exception as error:  # noqa: BLE001 - a failing tool must not kill the turn
        result = {"error": f"{type(error).__name__}: {error}"}

    payload = json.dumps(result, ensure_ascii=False, default=str)
    if len(payload) > MAX_RESULT_CHARS:
        payload = json.dumps({"ok": False, "error": "Tool result exceeds the output limit. Request fewer sections/items or a smaller maxChars.",
                              "truncated": True, "originalChars": len(payload)}, ensure_ascii=False)
    return payload
