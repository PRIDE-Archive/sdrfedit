"""SDRF template manifest and column definitions from bigbio/sdrf-templates.

The wizard picks templates as three layers (technology + sample + experiment
extras), so the assistant needs the same manifest the frontend reads to make a
recommendation that the wizard will accept.
"""

from __future__ import annotations

import time

import yaml

from .http import ToolHttpError, get_text

GITHUB_RAW_BASE = "https://raw.githubusercontent.com/bigbio/sdrf-templates/main"
CACHE_TTL_SECONDS = 3600

_manifest_cache: tuple[float, dict] | None = None
_template_cache: dict[str, tuple[float, dict]] = {}


async def _load_manifest() -> dict:
    global _manifest_cache
    now = time.time()
    if _manifest_cache and now - _manifest_cache[0] < CACHE_TTL_SECONDS:
        return _manifest_cache[1]

    text = await get_text(f"{GITHUB_RAW_BASE}/templates.yaml")
    manifest = yaml.safe_load(text) or {}
    _manifest_cache = (now, manifest)
    return manifest


async def _load_template(name: str, version: str) -> dict:
    key = f"{name}@{version}"
    now = time.time()
    cached = _template_cache.get(key)
    if cached and now - cached[0] < CACHE_TTL_SECONDS:
        return cached[1]

    text = await get_text(f"{GITHUB_RAW_BASE}/{name}/{version}/{name}.yaml")
    template = yaml.safe_load(text) or {}
    _template_cache[key] = (now, template)
    return template


async def list_templates(layer: str | None = None) -> dict:
    """List available templates grouped by layer (technology / sample / experiment)."""
    manifest = await _load_manifest()
    entries = manifest.get("templates", {})

    grouped: dict[str, list[dict]] = {}
    for name, meta in entries.items():
        template_layer = meta.get("layer") or "internal"
        if layer and template_layer != layer:
            continue
        grouped.setdefault(template_layer, []).append(
            {
                "name": name,
                "latest": meta.get("latest"),
                "usableAlone": bool(meta.get("usable_alone")),
                "extends": meta.get("extends"),
                "description": (meta.get("description") or "").strip(),
            }
        )

    for items in grouped.values():
        items.sort(key=lambda item: item["name"])

    return {
        "layers": grouped,
        "selectionRules": [
            "Pick exactly one technology template (e.g. ms-proteomics, affinity-proteomics).",
            "Pick zero or one sample template from the catalogue; omit it when no specialized sample template applies.",
            "Add zero or more experiment templates (cell-lines, dia-acquisition, single-cell, ...).",
            "Templates listed under internal (base, sample-metadata) are inherited, never selected.",
        ],
    }


def _parse_extends(value: str | None) -> str | None:
    if not value:
        return None
    return value.split("@", 1)[0].strip() or None


def _ontologies_from_validators(column: dict) -> list[str]:
    """Extract ontology prefixes from a template column's validators block."""
    found: list[str] = []
    for validator in column.get("validators") or []:
        if not isinstance(validator, dict):
            continue
        name = (validator.get("validator_name") or validator.get("validatorName") or "").lower()
        if name != "ontology":
            continue
        params = validator.get("params") or {}
        for prefix in params.get("ontologies") or []:
            text = str(prefix).strip().lower()
            if text and text not in found:
                found.append(text)
    return found


async def get_template_columns(name: str, version: str | None = None, include_inherited: bool = True) -> dict:
    """Resolve a template and its inheritance chain into a flat column list."""
    manifest = await _load_manifest()
    entries = manifest.get("templates", {})
    if name not in entries:
        available = ", ".join(sorted(entries))
        raise ToolHttpError(f"Unknown template '{name}'. Available: {available}")

    chain: list[dict] = []
    current: str | None = name
    current_version = version or entries[name].get("latest")
    seen: set[str] = set()

    while current and current not in seen:
        seen.add(current)
        resolved_version = current_version or entries.get(current, {}).get("latest")
        if not resolved_version:
            break
        template = await _load_template(current, resolved_version)
        chain.append(template)
        if not include_inherited:
            break
        current = _parse_extends(template.get("extends"))
        current_version = None

    columns: dict[str, dict] = {}
    for template in reversed(chain):  # base first so child overrides win
        for column in template.get("columns") or []:
            if not isinstance(column, dict) or not column.get("name"):
                continue
            columns[column["name"]] = {
                "name": column["name"],
                "requirement": column.get("requirement", "optional"),
                "ontologyAccession": column.get("ontology_accession"),
                "ontologies": _ontologies_from_validators(column),
                "description": (column.get("description") or "").strip(),
                "allowNotAvailable": bool(column.get("allow_not_available")),
                "allowNotApplicable": bool(column.get("allow_not_applicable")),
                "fromTemplate": template.get("name"),
            }

    head = chain[0] if chain else {}
    ordered = list(columns.values())
    return {
        "name": name,
        "version": head.get("version"),
        "layer": head.get("layer"),
        "description": (head.get("description") or "").strip(),
        "documentation": (head.get("documentation") or "").strip()[:4000],
        "mutuallyExclusiveWith": head.get("mutually_exclusive_with") or [],
        "inheritanceChain": [t.get("name") for t in chain],
        "requiredColumns": [c["name"] for c in ordered if c["requirement"] == "required"],
        "recommendedColumns": [c["name"] for c in ordered if c["requirement"] == "recommended"],
        "columns": ordered,
    }


async def validate_combination(
    technology: str | None, sample: str | None, experiments: list[str] | None = None
) -> dict:
    """Check a template combination against layers and exclusivity rules."""
    manifest = await _load_manifest()
    entries = manifest.get("templates", {})
    experiments = experiments or []
    errors: list[str] = []
    warnings: list[str] = []

    def layer_of(name: str) -> str | None:
        return entries.get(name, {}).get("layer")

    for name in [n for n in [technology, sample, *experiments] if n]:
        if name not in entries:
            errors.append(f"Unknown template '{name}'.")

    if not technology:
        errors.append("A technology template is required (e.g. ms-proteomics).")
    elif layer_of(technology) != "technology":
        errors.append(f"'{technology}' is a {layer_of(technology) or 'unknown'} template, not technology.")

    if sample and layer_of(sample) not in ("sample", None):
        errors.append(f"'{sample}' is a {layer_of(sample)} template, not sample.")

    if technology in entries and not sample and not experiments:
        if not entries[technology].get("usable_alone"):
            errors.append(f"'{technology}' cannot be used alone; select a sample template.")

    selected = [n for n in [technology, sample, *experiments] if n and n in entries]
    for name in selected:
        meta = entries[name]
        version = meta.get("latest")
        if not version:
            continue
        try:
            template = await _load_template(name, version)
        except ToolHttpError:
            continue
        for exclusive in template.get("mutually_exclusive_with") or []:
            if exclusive in selected:
                errors.append(f"'{name}' cannot be combined with '{exclusive}'.")

    for name in experiments:
        if name in entries and layer_of(name) not in ("experiment", "sample"):
            warnings.append(f"'{name}' has layer '{layer_of(name)}' - unusual as an experiment extra.")

    return {
        "valid": not errors,
        "errors": sorted(set(errors)),
        "warnings": sorted(set(warnings)),
        "selected": {"technology": technology, "sample": sample, "experiments": experiments},
    }
