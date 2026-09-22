#!/usr/bin/env python3
"""Find public PRIDE projects whose RAW-category file count is below a limit.

The script uses httpx connection pooling when available, with a standard-library
fallback.  It first enumerates public projects, then calls PRIDE's compact
per-project file-category count endpoint.
Successful counts are appended to a JSONL checkpoint, so an interrupted scan
can be resumed without repeating completed requests.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

try:
    import httpx
except ImportError:  # The script remains usable outside the backend venv.
    httpx = None  # type: ignore[assignment]


API_BASE = "https://www.ebi.ac.uk/pride/ws/archive/v3"
USER_AGENT = "PRIDE-raw-file-count-audit/1.0"
_thread_local = threading.local()


def get_json(path: str, *, timeout: float, attempts: int) -> Any:
    """GET JSON with bounded exponential backoff for transient failures."""
    url = f"{API_BASE}{path}"
    last_error: Exception | None = None
    for attempt in range(attempts):
        try:
            if httpx is not None:
                client = getattr(_thread_local, "http_client", None)
                if client is None:
                    client = httpx.Client(
                        headers={"Accept": "application/json", "User-Agent": USER_AGENT},
                        timeout=timeout,
                        limits=httpx.Limits(
                            max_connections=1, max_keepalive_connections=1, keepalive_expiry=60
                        ),
                    )
                    _thread_local.http_client = client
                response = client.get(url)
                response.raise_for_status()
                if not response.content.strip():
                    return []
                return response.json()
            else:
                request = Request(
                    url, headers={"Accept": "application/json", "User-Agent": USER_AGENT}
                )
                with urlopen(request, timeout=timeout) as response:
                    body = response.read()
                    if not body.strip():
                        return []
                    return json.loads(body)
        except HTTPError as error:
            last_error = error
            if error.code < 500 and error.code != 429:
                raise
        except (URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = error
        except Exception as error:
            if httpx is None or not isinstance(error, (httpx.HTTPError, ValueError)):
                raise
            last_error = error
            if isinstance(error, httpx.HTTPStatusError):
                status = error.response.status_code
                if status < 500 and status != 429:
                    raise

        if attempt + 1 < attempts:
            delay = min(20.0, 0.5 * (2**attempt)) + random.random() * 0.25
            time.sleep(delay)

    assert last_error is not None
    raise last_error


def list_projects(
    page_size: int, timeout: float, attempts: int, workers: int, cache_path: Path
) -> list[dict[str, Any]]:
    if cache_path.exists():
        with cache_path.open(encoding="utf-8") as handle:
            cached = json.load(handle)
        if not isinstance(cached, list) or not all(item.get("accession") for item in cached):
            raise RuntimeError(f"Invalid projects cache: {cache_path}")
        print(f"Loaded {len(cached):,} projects from {cache_path}", file=sys.stderr)
        return cached

    expected = int(get_json("/projects/count", timeout=timeout, attempts=attempts))
    search_suffix = (
        f"keyword=&pageSize={page_size}&sortFields=accession&sortDirection=ASC"
    )
    first_batch = get_json(
        f"/search/projects?{search_suffix}&page=0", timeout=timeout, attempts=attempts
    )
    if not isinstance(first_batch, list) or not first_batch:
        raise RuntimeError("The first projects page was empty or malformed")
    effective_page_size = len(first_batch)
    # /projects/count can lag the search index slightly.  Fetch ten pages past
    # its estimate and require an empty tail, so newly indexed projects are not
    # omitted merely because the count endpoint has not caught up yet.
    page_count = math.ceil(expected / effective_page_size) + 10
    pages: dict[int, list[dict[str, Any]]] = {0: first_batch}

    def fetch_page(page: int) -> tuple[int, list[dict[str, Any]]]:
        batch = get_json(
            f"/search/projects?{search_suffix}&page={page}",
            timeout=timeout,
            attempts=attempts,
        )
        if not isinstance(batch, list):
            raise RuntimeError(f"Unexpected projects response on page {page}: {type(batch).__name__}")
        return page, batch

    with ThreadPoolExecutor(max_workers=min(workers, 12)) as executor:
        futures = [executor.submit(fetch_page, page) for page in range(1, page_count)]
        for index, future in enumerate(as_completed(futures), 1):
            page, batch = future.result()
            pages[page] = batch
            if index % 25 == 0 or index == len(futures):
                print(
                    f"Listed pages {index + 1:,}/{page_count:,} "
                    f"({min(expected, (index + 1) * effective_page_size):,}/{expected:,} rows)",
                    file=sys.stderr,
                )
    projects = [project for page in sorted(pages) for project in pages[page]]
    nonempty_pages = [page for page, batch in pages.items() if batch]
    last_nonempty_page = max(nonempty_pages)
    if any(not pages[page] for page in range(last_nonempty_page)):
        raise RuntimeError("Project search pagination contained an empty page before its final page")
    projects = [
        project
        for page in range(last_nonempty_page + 1)
        for project in pages[page]
    ]

    # The endpoint does not advertise a sort parameter.  Detect pagination
    # overlap rather than silently emitting an incomplete audit.
    unique: dict[str, dict[str, Any]] = {}
    for project in projects:
        accession = project.get("accession")
        if accession:
            unique[str(accession)] = project
    if len(unique) != len(projects):
        raise RuntimeError(
            "Project pagination returned duplicates: "
            f"rows={len(projects):,}, unique={len(unique):,}. Run again."
        )
    if len(unique) != expected:
        print(
            "WARNING: /projects/count and the public project search disagree: "
            f"count endpoint={expected:,}, searchable rows={len(unique):,}. "
            "The audit will use every record exposed by the search endpoint.",
            file=sys.stderr,
        )
    compact = [
        {
            key: project.get(key, "")
            for key in (
                "accession",
                "title",
                "submissionType",
                "submissionDate",
                "publicationDate",
            )
        }
        for project in unique.values()
    ]
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    with cache_path.open("w", encoding="utf-8") as handle:
        json.dump(compact, handle, ensure_ascii=False, separators=(",", ":"))
    return compact


def load_checkpoint(path: Path) -> dict[str, dict[str, int]]:
    completed: dict[str, dict[str, int]] = {}
    if not path.exists():
        return completed
    with path.open(encoding="utf-8") as handle:
        for line_number, line in enumerate(handle, 1):
            if not line.strip():
                continue
            try:
                record = json.loads(line)
                completed[str(record["accession"])] = {
                    str(key): int(value) for key, value in record["counts"].items()
                }
            except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
                raise RuntimeError(f"Invalid checkpoint line {line_number}: {error}") from error
    return completed


def get_category_counts(accession: str, timeout: float, attempts: int) -> tuple[str, dict[str, int]]:
    data = get_json(
        f"/files/getCountOfFilesByType/{accession}",
        timeout=timeout,
        attempts=attempts,
    )
    if not isinstance(data, dict):
        raise RuntimeError(f"Unexpected count response for {accession}: {type(data).__name__}")
    return accession, {str(key): int(value) for key, value in data.items()}


def scan_counts(
    accessions: list[str],
    checkpoint_path: Path,
    *,
    workers: int,
    timeout: float,
    attempts: int,
) -> tuple[dict[str, dict[str, int]], dict[str, str]]:
    completed = load_checkpoint(checkpoint_path)
    pending = [accession for accession in accessions if accession not in completed]
    failures: dict[str, str] = {}
    checkpoint_path.parent.mkdir(parents=True, exist_ok=True)

    print(
        f"Counting file categories: {len(completed):,} cached, {len(pending):,} pending",
        file=sys.stderr,
    )
    with checkpoint_path.open("a", encoding="utf-8") as checkpoint, ThreadPoolExecutor(
        max_workers=workers
    ) as executor:
        futures = {
            executor.submit(get_category_counts, accession, timeout, attempts): accession
            for accession in pending
        }
        for index, future in enumerate(as_completed(futures), 1):
            accession = futures[future]
            try:
                returned_accession, counts = future.result()
            except Exception as error:  # Preserve all failures in the report.
                failures[accession] = f"{type(error).__name__}: {error}"
            else:
                completed[returned_accession] = counts
                checkpoint.write(
                    json.dumps(
                        {"accession": returned_accession, "counts": counts},
                        ensure_ascii=False,
                        separators=(",", ":"),
                    )
                    + "\n"
                )
                checkpoint.flush()
            if index % 250 == 0 or index == len(pending):
                print(
                    f"Counted {index:,}/{len(pending):,} pending projects; "
                    f"failures={len(failures):,}",
                    file=sys.stderr,
                )
    return completed, failures


def write_results(
    output_path: Path,
    projects: list[dict[str, Any]],
    counts: dict[str, dict[str, int]],
    failures: dict[str, str],
    minimum: int,
    threshold: int,
) -> int:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    selected = []
    for project in projects:
        accession = str(project["accession"])
        category_counts = counts.get(accession)
        if category_counts is None:
            continue
        raw_count = int(category_counts.get("RAW", 0))
        if minimum <= raw_count < threshold:
            selected.append((raw_count, accession, project, category_counts))
    selected.sort(key=lambda row: (row[0], row[1]))

    fieldnames = [
        "accession",
        "raw_file_count",
        "total_file_count",
        "title",
        "submission_type",
        "submission_date",
        "publication_date",
        "project_url",
    ]
    with output_path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        for raw_count, accession, project, category_counts in selected:
            writer.writerow(
                {
                    "accession": accession,
                    "raw_file_count": raw_count,
                    "total_file_count": sum(category_counts.values()),
                    "title": project.get("title", ""),
                    "submission_type": project.get("submissionType", ""),
                    "submission_date": project.get("submissionDate", ""),
                    "publication_date": project.get("publicationDate", ""),
                    "project_url": f"https://www.ebi.ac.uk/pride/archive/projects/{accession}",
                }
            )

    if failures:
        failure_path = output_path.with_suffix(".failures.csv")
        with failure_path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(["accession", "error"])
            writer.writerows(sorted(failures.items()))
    return len(selected)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="Output CSV path")
    parser.add_argument(
        "--checkpoint",
        type=Path,
        help="JSONL checkpoint path (default: OUTPUT with .checkpoint.jsonl suffix)",
    )
    parser.add_argument(
        "--projects-cache",
        type=Path,
        help="Public project metadata cache (default: OUTPUT with .search-projects.json suffix)",
    )
    parser.add_argument("--threshold", type=int, default=10, help="Select RAW counts below this value")
    parser.add_argument(
        "--min-raw-count",
        type=int,
        default=0,
        help="Select RAW counts at or above this value (use 1 to exclude zero-RAW projects)",
    )
    parser.add_argument("--workers", type=int, default=24, help="Concurrent API requests")
    parser.add_argument("--page-size", type=int, default=100, help="Project-list page size (API maximum: 100)")
    parser.add_argument("--timeout", type=float, default=45.0, help="Per-request timeout in seconds")
    parser.add_argument("--attempts", type=int, default=5, help="Attempts per API request")
    args = parser.parse_args()
    if args.threshold < 1 or args.workers < 1 or args.page_size < 1 or args.attempts < 1:
        parser.error("threshold, workers, page-size, and attempts must all be positive")
    if args.min_raw_count < 0 or args.min_raw_count >= args.threshold:
        parser.error("min-raw-count must be non-negative and lower than threshold")
    return args


def main() -> int:
    args = parse_args()
    checkpoint = args.checkpoint or args.output.with_suffix(".checkpoint.jsonl")
    projects_cache = args.projects_cache or args.output.with_suffix(".search-projects.json")
    projects = list_projects(
        args.page_size, args.timeout, args.attempts, args.workers, projects_cache
    )
    accessions = [str(project["accession"]) for project in projects]
    counts, failures = scan_counts(
        accessions,
        checkpoint,
        workers=args.workers,
        timeout=args.timeout,
        attempts=args.attempts,
    )
    selected_count = write_results(
        args.output, projects, counts, failures, args.min_raw_count, args.threshold
    )
    print(
        f"Wrote {selected_count:,} projects with "
        f"{args.min_raw_count} <= RAW count < {args.threshold} to {args.output}; "
        f"successful={len(counts):,}, failures={len(failures):,}",
        file=sys.stderr,
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
