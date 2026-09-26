# Wizard action argument contracts

`backend/app/llm/action_contracts.json` is the source for each operation's positional
parameter kinds, minimum/maximum arity, permitted shape normalization and concrete
JSON example. The backend whitelist, contract catalogue, and shared example tests
cover the same 37 operations.

After editing the contract, regenerate the frontend catalogue:

```bash
node scripts/generate-action-contracts.mjs
node scripts/generate-action-contracts.mjs --check
```

The backend loads this catalogue in `action_args.py`. The prompt renderer uses its
examples for the active step. The frontend imports the generated TypeScript
catalogue in `wizard-action-args.ts`; both preview and apply call `validateActionArgs`.
Python and TypeScript still implement their own primitive/object validators; the
shared `tests/fixtures/wizard-action-args.json` runs in both languages to detect drift.

## Compatibility and strictness

- List-valued single-argument operations accept unambiguous flat string/object
  lists and normalize them to one nested argument. Object-valued operations accept
  one extra singleton object wrapper. Never truncate extra arguments or flatten
  arbitrary nesting. Biological replicate values retain their explicit existing
  nested-list contract and recovery diagnostics.
- Source names must be non-empty and unique; generated multi-sample names require
  `{n}`. Counts and indices are safe integers, not booleans, null, numeric strings,
  arrays or fractional numbers.
- Position-sensitive assignment arrays retain blanks. Their original length must
  match sample count; an empty factor assignment can clear the corresponding cell.
- Factor booleans/candidates and modification/ontology fields are checked without
  coercing invalid types. An unspecified/null modification delta mass remains
  absent, never fabricated as zero. The existing omitted modification type/position
  defaults are retained for compatibility; they are not evidence of an experiment.
- Optional ontology terms may be absent/null; malformed supplied objects throw.
- Legacy file-assignment tuples check exact lengths and explicit numeric values.
  Omitted legacy fraction/technical-replicate fields still default to 1.
- Envelope/args errors return per-action rejections; valid sibling actions survive.

## State and evidence checks

The common parser checks shape and sample count/index constraints. Existing setup,
ontology, factor, template and run/file checks still apply. Plan shape validation
is shared by preview/apply, while run/file existence is checked at application time:
this preserves a batch that imports files before applying a dependent run plan.
A valid structure does not establish scientific correctness or ontology provenance.

## Fourth-page protocol cards

New cards use `setProtocolValue [columnName, value, scope]`. `scope` is either
`"all"` (current and future raw files) or a non-empty list of unique, exact raw
file names. The value is an instrument term, enzyme object, complete modification
array, tolerance string or template-specific text, depending on the column.

Preview and apply use the same plan validation. Unknown columns/files, invalid
values and clearing required fields fail before mutation. File-scoped changes
preserve other file assignments; explicit All displays every affected value and
retains reusable candidates. Empty strings clear optional fields only with All.
Every modification needs a non-empty evidence-supported `targetAminoAcids` (or
legacy `target`). Missing modification sites cannot pass as empty strings.

`WizardSnapshot.protocolFields` exposes full structured candidates, shared choice
IDs and raw-file assignments. `protocolColumns` uses current wizard requirements;
`protocolIssues` includes column-specific errors and unassigned filenames. The
legacy scalar summaries are only compatibility hints, not complete metadata.

Legacy global cards can initialize a field and can replay an identical shared
value, but cannot overwrite an existing explicit configuration. They instruct the
assistant to use `setProtocolValue` instead. Automatic card repair cannot change
the target column or expand/change the file scope.

## Validation

```bash
(cd backend && .venv/bin/python -m pytest tests -q)
npm run test:wizard
npx tsc --noEmit -p tsconfig.app.json
node scripts/generate-action-contracts.mjs --check
```

Regression tests cover malformed envelopes, all action examples, argument loss,
null/fractional indices, duplicate names, optional term corruption, positional
blanks, legacy tuples and mutation-free rejection. The import-before-plan regression
verifies valid dependent operations remain usable.
