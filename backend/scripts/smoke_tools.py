"""Exercise every network-facing tool once and report what works.

    python scripts/smoke_tools.py

Needs network access but no API keys (the LLM itself is not called).
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.tools import registry  # noqa: E402

CHECKS: list[tuple[str, dict]] = [
    ("get_pride_metadata", {"accession": "PXD000001"}),
    ("get_pride_raw_files", {"accession": "PXD000001", "limit": 5}),
    ("find_publication", {"pmid": "24657495"}),
    ("get_publication_full_text", {"pmcid": "PMC4047622", "sections": ["methods"]}),
    ("search_specification", {"query": "reserved words", "k": 2}),
    ("search_ontology", {"query": "HeLa", "column": "characteristics[cell line]", "limit": 3}),
    ("search_cell_line", {"query": "HeLa", "limit": 3}),
    ("verify_cellosaurus_accession", {"accession": "CVCL_0030", "expectedLabel": "HeLa"}),
    ("verify_ontology_term", {"accession": "UNIMOD:4", "expectedLabel": "Carbamidomethyl"}),
    ("list_sdrf_templates", {"layer": "sample"}),
    ("get_template_columns", {"name": "human"}),
    ("validate_template_combination", {"technology": "ms-proteomics", "sample": "human", "experiments": []}),
]


async def main() -> int:
    failures = 0
    for name, args in CHECKS:
        raw = await registry.dispatch(name, args, "smoke-session")
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            payload = {"error": "non-JSON response"}

        error = payload.get("error") if isinstance(payload, dict) else None
        if error:
            failures += 1
            print(f"FAIL {name}: {error}")
        else:
            summary = json.dumps(payload, ensure_ascii=False)[:120]
            print(f"ok   {name}: {summary}")

    print()
    print(f"{len(CHECKS) - failures}/{len(CHECKS)} tools reachable.")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
