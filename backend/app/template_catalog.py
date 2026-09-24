"""Commit-pinned template catalogue. No template IDs are special-cased here."""
from __future__ import annotations

import asyncio
from copy import deepcopy
from datetime import datetime, timezone
from functools import lru_cache
import hashlib
import json
import re
import uuid
from pathlib import Path
from typing import Any

import httpx
import yaml
from jsonschema import Draft202012Validator
from semantic_version import SimpleSpec, Version

from .config import BACKEND_ROOT, get_settings

REPOSITORY = "bigbio/sdrf-templates"
PARSER_VERSION = "1"
IDENTIFIER = re.compile(r"^[a-z][a-z0-9-]*$")
SHA = re.compile(r"^[0-9a-f]{40}$")
LAYERS = {"technology", "sample", "experiment", None}
TOP_FIELDS = {"name", "version", "description", "documentation", "contributors", "extends", "layer",
              "usable_alone", "mutually_exclusive_with", "requires", "excludes", "columns", "validators", "status"}
COLUMN_FIELDS = {"name", "ontology_accession", "description", "requirement", "type", "cardinality", "default",
                 "allow_not_applicable", "allow_not_available", "allow_anonymized", "allow_pooled", "error_level", "validators"}
VALIDATORS = {"single_cardinality_validator", "values", "ontology", "pattern", "number_with_unit", "mz_value",
              "mz_range_interval", "date", "accession", "identifier", "semver", "structured_kv",
              "trailing_whitespace_validator", "column_name_validator", "column_order", "empty_cells",
              "combination_of_columns_no_duplicate_validator", "min_columns"}
PARAMS = {"values", "ontologies", "parent_accession", "recommend_nt_ac", "parent_term", "pattern", "case_sensitive",
          "units", "min", "max", "allow_negative", "format", "precision", "prefix", "suffix", "charset", "special_values",
          "allow_prerelease", "separator", "fields", "error_level", "description", "examples", "column_name",
          "column_name_warning", "min_columns"}


class CatalogError(ValueError):
    pass


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def parent_ref(value: str | None) -> tuple[str, str] | None:
    if not value:
        return None
    name, _, constraint = value.partition("@")
    if not IDENTIFIER.fullmatch(name):
        raise CatalogError(f"Invalid parent name: {name}")
    try:
        SimpleSpec(constraint or "*")
    except ValueError as exc:
        raise CatalogError(f"Unsupported version constraint: {value}") from exc
    return name, constraint or "*"


def unique(items: list[Any]) -> list[Any]:
    result, seen = [], set()
    for item in items:
        key = json.dumps(item, sort_keys=True)
        if key not in seen:
            seen.add(key)
            result.append(item)
    return result


def merge_column(parent: dict, child: dict) -> dict:
    result = {**deepcopy(parent), **deepcopy(child)}
    levels = {"optional": 0, "recommended": 1, "required": 2}
    result["requirement"] = max([parent.get("requirement", "optional"), child.get("requirement", "optional")], key=levels.get)
    result["validators"] = unique(parent.get("validators", []) + child.get("validators", []))
    for key in ("allow_not_available", "allow_not_applicable", "allow_anonymized", "allow_pooled"):
        if parent.get(key) is False:
            result[key] = False
    return result


class CatalogSnapshot:
    def __init__(self, payload: dict):
        self.payload = payload
        self.manifest = payload["manifest"]["templates"]
        self.definitions = payload["definitions"]
        self.snapshot_id = payload["snapshotId"]

    def doc(self, name: str, version: str) -> dict:
        try:
            return self.definitions[f"{name}@{version}"]
        except KeyError as exc:
            raise CatalogError(f"Missing template {name}@{version}") from exc

    def lock(self, selected: list[dict]) -> dict[str, str]:
        """Backtracking solver includes exact root versions and every parent range."""
        constraints: dict[str, list[str]] = {}
        for ref in selected:
            name = ref["name"]
            if name not in self.manifest:
                raise CatalogError(f"Unknown template: {name}")
            version = ref.get("version") or self.manifest[name]["latest"]
            constraints.setdefault(name, []).append(f"=={version}")

        def solve(chosen: dict[str, str], needed: dict[str, list[str]]) -> dict | None:
            for name, version in chosen.items():
                if not all(SimpleSpec(c).match(Version(version)) for c in needed[name]):
                    return None
            pending = [name for name in needed if name not in chosen]
            if not pending:
                return chosen
            name = pending[0]
            if name not in self.manifest:
                return None
            versions = sorted(self.manifest[name]["versions"], key=Version, reverse=True)
            # Stable dependencies preferred; explicit prerelease constraints still work.
            versions.sort(key=lambda v: bool(Version(v).prerelease))
            for version in versions:
                if not all(SimpleSpec(c).match(Version(version)) for c in needed[name]):
                    continue
                extra = deepcopy(needed)
                parent = parent_ref(self.doc(name, version).get("extends"))
                if parent:
                    extra.setdefault(parent[0], []).append(parent[1])
                result = solve({**chosen, name: version}, extra)
                if result is not None:
                    return result
            return None

        result = solve({}, constraints)
        if result is None:
            raise CatalogError("Selected templates have incompatible or missing dependency versions.")
        for name in result:
            self.chain(name, result)
        return result

    def chain(self, name: str, lock: dict[str, str]) -> list[str]:
        chain = []
        while name:
            if name in chain:
                raise CatalogError(f"Cyclic inheritance: {' → '.join(chain + [name])}")
            chain.append(name)
            ref = parent_ref(self.doc(name, lock[name]).get("extends"))
            name = ref[0] if ref else ""
        return chain

    def source(self, name: str, version: str, field: str) -> dict:
        path = f"{name}/{version}/{name}.yaml"
        return {"template": name, "version": version, "field": field, "path": path,
                "url": f"https://github.com/{REPOSITORY}/blob/{self.payload['commitSha']}/{path}"}

    def resolve(self, selected: list[dict], *, availability: bool = True, preview: bool = False) -> dict:
        selected = unique(selected)
        errors, warnings, issues = [], [], []
        def issue(message: str, name: str | None = None, field: str = "", warning: bool = False):
            (warnings if warning else errors).append(message)
            issues.append({"message": message, "severity": "warning" if warning else "error",
                           "source": self.source(name, lock[name], field) if name else None})
        try:
            lock = self.lock(selected)
        except (CatalogError, ValueError) as exc:
            return {"snapshotId": self.snapshot_id, "valid": False, "errors": [str(exc)], "warnings": [], "issues": [], "columns": [],
                    "leafTemplates": [], "resolvedTemplates": [], "availability": {}}
        names = list(dict.fromkeys(ref["name"] for ref in selected))
        chains = {name: self.chain(name, lock) for name in names}
        docs = {name: self.doc(name, version) for name, version in lock.items()}
        if not preview:
            if not names:
                issue("Select a technology template.")
            if not any(doc.get("layer") == "technology" for doc in docs.values()):
                issue("A technology layer is required (SDRF layer policy).")
            technologies = [name for name, doc in docs.items() if doc.get("layer") == "technology"]
            independent_technologies = [name for name in technologies if not any(
                name in self.chain(other, lock)[1:] for other in technologies if other != name)]
            if len(independent_technologies) > 1:
                issue("Choose one technology (SDRF layer policy).")
            for name in names:
                if docs[name].get("layer") is None:
                    issue(f"{name} is an internal template; select a derived template.", name, "layer")
            if len(names) == 1 and docs[names[0]].get("usable_alone", True) is False:
                issue(f"{names[0]} cannot be used alone.", names[0], "usable_alone")
        for name, doc in docs.items():
            for message in doc.get("_unsupported", []):
                issue(f"{name}: {message}", name, "schema")
            if preview:
                continue
            for excluded in doc.get("mutually_exclusive_with", []):
                if excluded in docs:
                    issue(f"{name} cannot be combined with {excluded} (including inherited templates).", name, "mutually_exclusive_with")
            for req in doc.get("requires", []):
                if "layer" not in req: continue  # Already reported by capability diagnostics.
                if not any(d.get("layer") == req["layer"] for d in docs.values()):
                    issue(f"{name} requires the {req['layer']} layer.", name, "requires")
        leaves = [name for name in names if not any(name in chain[1:] for other, chain in chains.items() if other != name)]
        for name in names:
            if name not in leaves:
                issue(f"{name} is already inherited; only leaf templates will be declared.", name, "extends", warning=True)

        # Exclusions apply to other selected roots, preserving the excluding hierarchy.
        contributions = []
        for root in leaves:
            merged: dict[str, dict] = {}
            for name in reversed(chains[root]):
                for column in docs[name].get("columns", []):
                    key = column["name"]
                    value = merge_column(merged[key]["column"], column) if key in merged else deepcopy(column)
                    merged[key] = {"column": value, "origin": name, "root": root}
            contributions.extend(merged.values())
        exclusions = [(root, name, docs[name].get("excludes", {})) for root in leaves for name in chains[root]]
        effective: dict[str, dict] = {}
        for part in contributions:
            column, origin, root = part["column"], part["origin"], part["root"]
            blocked = False
            for other_root, owner, rules in exclusions:
                if root == other_root or origin in self.chain(owner, lock):
                    continue
                if (origin in rules.get("templates", []) or column["name"] in rules.get("columns", [])
                        or any(column["name"].startswith(f"{cat}[") for cat in rules.get("categories", []))):
                    blocked = True
                    break
            if blocked:
                continue
            key = column["name"]
            provenance = self.source(origin, lock[origin], "columns")
            if key in effective:
                previous = effective[key]
                effective[key] = merge_column(previous, column)
                effective[key]["provenance"] = unique(previous["provenance"] + [provenance])
            else:
                effective[key] = {**column, "requirement": column.get("requirement", "optional"), "provenance": [provenance]}
        result = {"snapshotId": self.snapshot_id, "valid": not errors, "errors": unique(errors), "warnings": unique(warnings),
                  "issues": issues, "columns": list(effective.values()),
                  "leafTemplates": [{"name": name, "version": lock[name]} for name in leaves],
                  "resolvedTemplates": [{"name": name, "version": version} for name, version in lock.items()],
                  "validators": unique([v for doc in docs.values() for v in doc.get("validators", [])]),
                  "availability": {}}
        if availability:
            for name, entry in self.manifest.items():
                if self.doc(name, entry["latest"]).get("layer") is None:
                    continue
                if name in names:
                    result["availability"][name] = {"status": "selected", "reasons": []}
                    continue
                if name in docs:
                    result["availability"][name] = {"status": "inherited", "reasons": ["Already included through inheritance."]}
                    continue
                target = {"name": name, "version": entry["latest"]}
                candidate = self.resolve(selected + [target], availability=False)
                def hard_errors(resolution):
                    # Dependencies may be completed after this click; incompatible roots cannot coexist.
                    return [msg for msg in resolution["errors"] if "requires the " not in msg
                            and "required (SDRF" not in msg and "cannot be used alone" not in msg]
                blocked = hard_errors(candidate)
                state = {"status": "conflicting" if blocked else "available", "reasons": candidate["errors"]}
                if blocked:
                    # Identify selected roots that cause the conflict; never propose removing them.
                    own_errors = set(hard_errors(self.resolve([target], availability=False)))
                    conflicts_with = [ref for ref in selected if any(
                        message not in own_errors
                        for message in hard_errors(self.resolve([ref, target], availability=False)))]
                    state["conflictsWith"] = conflicts_with
                result["availability"][name] = state
        return result

    def public(self) -> dict:
        templates = []
        for name, entry in self.manifest.items():
            doc = deepcopy(self.doc(name, entry["latest"]))
            doc["source"] = self.source(name, entry["latest"], "")
            doc["versions"] = entry["versions"]
            templates.append(doc)
        return {key: self.payload[key] for key in ("snapshotId", "commitSha", "fetchedAt", "schemaHash", "parserVersion")} | {
            "repository": REPOSITORY, "templates": templates,
            "policy": {"requiredLayer": "technology", "technologyCardinality": 1,
                       "source": "https://sdrf.quantms.org/specification.html#_template_combination_rules"}}


def check_capabilities(doc: dict) -> list[str]:
    errors = []
    for field in set(doc) - TOP_FIELDS:
        errors.append(f"Unsupported template field: {field}")
    if doc.get("layer") not in LAYERS:
        errors.append(f"Unsupported layer: {doc.get('layer')}")
    for req in doc.get("requires", []):
        if set(req) != {"layer"} or req["layer"] not in LAYERS - {None}:
            errors.append("Unsupported requires rule")
    for field in set(doc.get("excludes", {})) - {"templates", "categories", "columns"}:
        errors.append(f"Unsupported excludes rule: {field}")
    for col in doc.get("columns", []):
        for field in set(col) - COLUMN_FIELDS:
            errors.append(f"Unsupported column field: {field}")
    validators = doc.get("validators", []) + [v for col in doc.get("columns", []) for v in col.get("validators", [])]
    for validator in validators:
        if validator.get("validator_name") not in VALIDATORS:
            errors.append(f"Unsupported validator: {validator.get('validator_name')}")
        for field in set(validator.get("params", {})) - PARAMS:
            errors.append(f"Unsupported validator parameter: {field}")
    return unique(errors)


class TemplateCatalog:
    def __init__(self, directory: Path | None = None):
        self.directory = directory or BACKEND_ROOT / "data/template_catalog"
        self.latest: CatalogSnapshot | None = None
        self.snapshots: dict[str, CatalogSnapshot] = {}
        self._task: asyncio.Task | None = None
        self._etag: str | None = None

    async def _json(self, url: str) -> dict:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            response = await client.get(url, headers={"User-Agent": "sdrfedit-template-catalog/1"})
            response.raise_for_status()
            return response.json()

    async def _head(self) -> str:
        async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
            headers = {"User-Agent": "sdrfedit-template-catalog/1"}
            token = get_settings().template_github_token
            if token:
                headers["Authorization"] = f"Bearer {token}"
            if self._etag and self.latest:
                headers["If-None-Match"] = self._etag
            try:
                response = await client.get(f"https://api.github.com/repos/{REPOSITORY}/commits/main", headers=headers)
                if response.status_code == 304 and self.latest:
                    return self.latest.payload["commitSha"]
                response.raise_for_status()
                sha = response.json()["sha"]
                self._head_etag = (sha, response.headers.get("etag"))
                return sha
            except httpx.HTTPError:
                # Public Git smart-HTTP discovery does not require the REST API quota.
                refs = await client.get(f"https://github.com/{REPOSITORY}.git/info/refs?service=git-upload-pack")
                refs.raise_for_status()
                match = re.search(r"([0-9a-f]{40}) refs/heads/main(?:\x00|\n)", refs.text)
                if not match:
                    raise CatalogError("Cannot discover the repository main commit")
                return match.group(1)

    async def _text(self, sha: str, path: str) -> str:
        async with httpx.AsyncClient(timeout=45, follow_redirects=True) as client:
            response = await client.get(f"https://raw.githubusercontent.com/{REPOSITORY}/{sha}/{path}")
            response.raise_for_status()
            return response.text

    async def build(self, sha: str) -> CatalogSnapshot:
        if not SHA.fullmatch(sha):
            raise CatalogError("Invalid repository commit SHA")
        manifest_text, schema_text = await asyncio.gather(self._text(sha, "templates.yaml"), self._text(sha, "sdrf-template.schema.json"))
        manifest, schema = yaml.safe_load(manifest_text), json.loads(schema_text)
        if not isinstance(manifest, dict) or manifest.get("schema_version") != "1.0" or not isinstance(manifest.get("templates"), dict):
            raise CatalogError("Unsupported manifest schema")
        # No remote schema references: schema is versioned with this snapshot.
        def check_refs(value):
            if isinstance(value, dict):
                if "$ref" in value and not value["$ref"].startswith("#/"):
                    raise CatalogError("Remote schema references are unsupported")
                for child in value.values(): check_refs(child)
            elif isinstance(value, list):
                for child in value: check_refs(child)
        check_refs(schema)
        Draft202012Validator.check_schema(schema)
        validator = Draft202012Validator(schema)
        definitions = {}
        semaphore = asyncio.Semaphore(5)
        async def read(name, version):
            if not IDENTIFIER.fullmatch(name):
                raise CatalogError(f"Invalid template name: {name}")
            Version(version)
            async with semaphore:
                doc = yaml.safe_load(await self._text(sha, f"{name}/{version}/{name}.yaml"))
            if not isinstance(doc, dict) or doc.get("name") != name or doc.get("version") != version:
                raise CatalogError(f"Identity mismatch: {name}@{version}")
            # Manifest metadata only supplies omitted fields for its latest version.
            entry = manifest["templates"][name]
            if version == entry["latest"]:
                for field in ("layer", "extends", "usable_alone", "requires", "excludes"):
                    if field not in doc and field in entry: doc[field] = deepcopy(entry[field])
            problems = [f"Schema: {'/'.join(map(str, e.path))}: {e.message}" for e in validator.iter_errors(doc)]
            if problems:
                raise CatalogError(f"Invalid {name}@{version}: {problems[0]}")
            doc["_unsupported"] = check_capabilities(doc)
            parent_ref(doc.get("extends"))
            definitions[f"{name}@{version}"] = doc
        tasks = []
        for name, entry in manifest["templates"].items():
            versions = entry.get("versions", [])
            if not versions or entry.get("latest") not in versions:
                raise CatalogError(f"Incomplete version catalogue: {name}")
            tasks.extend(read(name, version) for version in versions)
        await asyncio.gather(*tasks)
        snapshot = CatalogSnapshot({"snapshotId": f"{sha}:{PARSER_VERSION}", "commitSha": sha,
            "fetchedAt": now(), "parserVersion": PARSER_VERSION, "schemaHash": hashlib.sha256(schema_text.encode()).hexdigest(),
            "manifest": manifest, "schema": schema, "definitions": definitions})
        for name, entry in snapshot.manifest.items():
            for version in entry["versions"]:
                snapshot.lock([{"name": name, "version": version}])
        return snapshot

    def _atomic_write(self, target: Path, content: str):
        self.directory.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f"{target.name}.{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_text(content, encoding="utf-8")
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)

    def _save(self, snapshot: CatalogSnapshot):
        self.directory.mkdir(parents=True, exist_ok=True)
        target = self.directory / f"{snapshot.payload['commitSha']}-{PARSER_VERSION}.json"
        self._atomic_write(target, json.dumps(snapshot.payload))
        self._atomic_write(self.directory / "latest", snapshot.snapshot_id)

    async def get(self, snapshot_id: str | None = None) -> CatalogSnapshot:
        if snapshot_id is None:
            if self.latest: return self.latest
            pointer = self.directory / "latest"
            if pointer.exists(): snapshot_id = pointer.read_text().strip()
            else:
                result = await self.revalidate()
                return self.snapshots[result["snapshotId"]]
        if snapshot_id in self.snapshots: return self.snapshots[snapshot_id]
        sha, _, parser = snapshot_id.partition(":")
        if not SHA.fullmatch(sha) or parser != PARSER_VERSION:
            raise CatalogError("Unsupported snapshot ID")
        path = self.directory / f"{sha}-{parser}.json"
        if path.exists():
            snapshot = CatalogSnapshot(json.loads(path.read_text()))
        else:
            snapshot = await self.build(sha)
            # Preserve the latest pointer when restoring an old draft.
            self.directory.mkdir(parents=True, exist_ok=True)
            self._atomic_write(path, json.dumps(snapshot.payload))
        self.snapshots[snapshot_id] = snapshot
        return snapshot

    async def _refresh(self) -> dict:
        try:
            sha = await self._head()
            snapshot_id = f"{sha}:{PARSER_VERSION}"
            if self.latest and self.latest.snapshot_id == snapshot_id:
                snapshot = self.latest
            else:
                snapshot = await self.get(snapshot_id)
                self._save(snapshot)
                self.latest = snapshot
            self.snapshots[snapshot_id] = snapshot
            head_etag = getattr(self, "_head_etag", None)
            if head_etag and head_etag[0] == sha: self._etag = head_etag[1]
            return snapshot.public() | {"checkedAt": now(), "stale": False, "syncError": None}
        except Exception as exc:
            if self.latest is None and (self.directory / "latest").exists():
                self.latest = await self.get((self.directory / "latest").read_text().strip())
            if self.latest:
                return self.latest.public() | {"checkedAt": now(), "stale": True, "syncError": str(exc)}
            raise CatalogError(f"Cannot load a complete official catalogue: {exc}") from exc

    async def revalidate(self) -> dict:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._refresh())
        return await asyncio.shield(self._task)


@lru_cache
def get_catalog() -> TemplateCatalog:
    return TemplateCatalog()
