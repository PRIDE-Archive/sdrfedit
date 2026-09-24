# Dynamic template catalogue

Implemented 2026-09-24. The runtime source is [bigbio/sdrf-templates](https://github.com/bigbio/sdrf-templates), including `templates.yaml`, `sdrf-template.schema.json`, and every manifest-listed version's YAML. The old relationship fixture is historical test data, not runtime configuration.

## Synchronization and snapshots

Every entry to wizard Step 1 calls `POST /api/template-catalog/revalidate`. The backend discovers the `main` commit (GitHub REST conditional request, with public Git smart-HTTP discovery as a fallback). All subsequent file requests use that exact SHA. A complete catalogue is validated before the latest pointer is atomically published. Concurrent requests share one sync task per process.

Snapshots are cached in `backend/data/template_catalog/`, keyed by commit SHA and parser version. Restarting the backend can reuse disk snapshots. Subsequent steps, restored drafts, template previews, assistant template tools and Review preflight use the selected `snapshotId`. Returning to Step 1 checks for updates and reports added, removed and changed definitions before revalidating the selection.

A failed refresh retains only a previously complete snapshot and clearly labels it stale. A failed initial load shows an error and Retry; there is no handwritten fallback catalogue. `TEMPLATE_GITHUB_TOKEN` is optional and only used for GitHub REST commit discovery. No LLM credentials are needed for catalogue APIs.

## Selection contract

- Cards are discovered from the manifest. Navigation starts with Technology, then Sample, followed by Experiment. Initially only top-level selectable nodes are shown; selecting a node reveals its direct children, recursively, based on `extends`. Internal (`layer: null`) ancestors are skipped as navigation nodes and are never offered as cards.
- Technology-specific Experiment descendants appear in the Experiment section only after their technology is selected (or a descendant is already selected); inheritance never moves cards into another layer. They join the same Experiment grid as general options such as Cell Lines; each card retains its inheritance metadata. General Experiment roots remain independently discoverable. No parent-child ID map is maintained.
- Sample remains optional. Selecting parents does not force selecting a child. A selected descendant keeps its ancestry path open even if its explicit parent selection is removed or the draft is restored; nothing is silently deselected or hidden. Child-count hints make additional options discoverable and name the destination layer for cross-layer descendants. Within Sample, common leaf templates appear first; expandable categories are placed last, immediately above one shared More sample templates grid containing the union of all revealed descendants from every selected/inherited parent. This ordering is presentation-only and does not affect template eligibility. Host whitelists and prerelease filters cannot strand eligible/selected descendants.
- `selectedTemplates: [{name, version}]` and `templateSnapshotId` are authoritative. Legacy technology/sample/experiment fields are compatibility projections; old drafts migrate without a fixed organism list. Create New SDRF always starts a blank form and chat; historical drafts restore only when explicitly opened from chat history.
- `extends` resolves exact versions and supported semver ranges with joint dependency constraints. Missing dependencies, incompatible versions and cycles are rejected.
- `mutually_exclusive_with` is read from individual YAML, including inherited rules. A declaration on either side is sufficient. No template ID has an extra mutual-exclusion branch.
- `requires` checks the declared layer dependencies; `usable_alone: false` is respected. Missing dependencies can be selected provisionally, but Next remains disabled.
- The generic SDRF technology policy requires one technology hierarchy. Its source is distinct from YAML metadata: [specification template combination rules](https://sdrf.quantms.org/specification.html#_template_combination_rules).
- Stable/development display follows version/status, never substrings in template names.
- Mutually exclusive cards appear unavailable without showing conflict text or a details prompt by default. Only clicking or keyboard-activating an unavailable card lists the selected templates causing the conflict (including inherited technology conflicts) and explains that the user must deselect those templates first; it never replaces existing selections. Unavailable selection controls use aria-disabled so they remain focusable for the explanation. Source and column-preview actions remain available. Selected parents already inherited by children produce a warning; only leaf declarations are exported.

The schema has no organism/clinical/environment display subgroups. Sample roots and their progressively revealed descendants are displayed within the sample group. LC-MS and GC-MS do not receive an extra name-based exclusion: when the repository does not encode a rule, the application does not infer it from prose.

## Column composition and output

`excludes.templates`, `excludes.categories` and `excludes.columns` remove column contributions from other selected hierarchies, preserving the excluding template's own hierarchy. They do not make templates mutually exclusive. Columns retain source provenance; requirement strength and all inherited validators are merged, and an explicit prohibition on reserved values cannot be weakened.

Resolved columns drive Step 2, generic protocol fields, and the final generated column set. Existing instrument/enzyme/run controls act as value adapters only. New technical columns receive generic inputs, enum choices/defaults come from the definitions, and absent technical columns are not emitted. Exported leaf template versions come from the resolved snapshot rather than a later `latest` request. Table metadata retains the snapshot ID. The independent SDRF specification-version constant is not inferred from a template version.

## Validation and compatibility boundary

Schema checking and rule execution are separate. Unknown selection fields, layers, validator names or parameters produce a compatibility diagnostic; they are not silently accepted as understood. A new template or changed rule using supported semantics works without adding a template ID. An entirely new rule language still requires an application update.

`POST /api/template-catalog/validate-table` is a **snapshot preflight**, not a replacement for a complete SDRF validator. It uses the same resolved selection and checks required columns, explicit cardinality, required cell values, reserved-value flags, integer/float types, value lists, patterns and semantic versions, plus basic supported table rules. Deferred ontology, specialized value and cross-column validators are listed in an explicit warning. Review and automated annotation show these limits rather than claiming full specification validation. The editor's existing full-validation facilities remain available separately; external services may use their own template versions.

## API

- `GET /api/template-catalog/status` — catalogue capability probe, independent of LLM health.
- `POST /api/template-catalog/revalidate` — fresh commit check; complete catalogue plus freshness state.
- `GET /api/template-catalog/snapshots/{snapshotId}` — restore a pinned snapshot.
- `POST /api/template-catalog/resolve` — `{snapshotId, selectedTemplates, preview?, availability?}`; effective columns, dependency lock, leaf refs, rule-source issues and per-card availability.
- `POST /api/template-catalog/validate-table` — same selection plus `tsv`; pinned preflight and explicit deferred checks.

## Tests

Run `npm run test:wizard` and `cd backend && .venv/bin/python -m pytest -q`.

Synthetic templates with unfamiliar names cover discovery, canonical/legacy state migration, inherited one-way conflicts, dependency ranges, technology ancestry, all three exclusions, strict merge flags, unsupported semantics, pinned fetches, failed publication, stale cache, restart recovery, concurrent synchronization, enum fields, and generator output with no MS-only leakage. A live browser smoke check additionally verifies official cards, Human/Vertebrates blocking, Clinical compatibility and inherited Columns preview.
