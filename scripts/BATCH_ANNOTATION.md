# PRIDE CSV batch annotation

This runner uses the running editor's **real Auto annotate workflow**, including its
action validation, wizard state, SDRF generator and pinned-template preflight. It
does not invent a second annotation pipeline or mock model responses.

## Run

Start the editor and backend first. Install Playwright in a separate tools directory
if it is not installed locally, and install its Chromium browser. Point
`PLAYWRIGHT_MODULE` at that installation's `playwright/index.mjs`; optionally set
`PLAYWRIGHT_EXECUTABLE_PATH` to an existing Chromium executable.

```bash
node scripts/batch-annotate-pride.mjs \
  --input reports/pride_projects_raw_eq5_2026-09-22.csv \
  --output reports/pride-raw-eq5-annotation \
  --concurrency 2
```

The CSV needs an `accession` column containing unique PXD IDs. Other columns are
saved as input provenance. In particular, RAW count is **not** treated as biological
sample count. The normal annotation workflow retrieves current project evidence.
Each project starts with an isolated browser context and backend session.

Use `--dry-run` to inspect the queue, `--limit 5` for a pilot, and
`--project-timeout-minutes 30` to bound each attempt. `--help` lists all options.

Use `--target-success 50` without `--limit` to continue through failures until 50
successful SDRFs are saved. Existing successful outputs with matching hashes count
toward this target. Workers reserve remaining success slots to avoid overshooting.
If the input is exhausted before reaching the goal, the final log records
`goalReached: false`; blocked projects are never counted as success.

Rerun the same command to resume: terminal projects are skipped, while interrupted
projects restart in a **new attempt directory**. `--retry-failed` retries blocked,
waiting, timeout and error results as well. Previous attempt files remain intact.
Successful outputs are verified by SHA-256 before skipping them. An output directory
is bound to the exact input CSV hash; use a different directory for a changed CSV.
SIGINT/SIGTERM stops scheduling work and checkpoints active projects.

## Outputs

Monitor the current batch (read-only; Ctrl+C stops only this monitor):

```bash
node scripts/batch-annotation-status.mjs --watch
```

Omit `--watch` for one snapshot, or pass `--output /path/to/batch` for another batch.
The finished-attempt count includes unsuccessful attempts; successful output is
counted separately. The monitor reports whether the process lock's PID is alive.

- `successful/PXDxxxxxx.sdrf.tsv`: downloaded output from completed editor runs.
- `summary.csv` / `summary.json`: all projects and current statuses; refreshed during execution.
- `failures.csv`: blocked, waiting, error, timeout and interrupted projects, with stages/reasons.
- `events.jsonl`: append-only batch progress, including the runner PID.
- `projects/PXDxxxxxx/result.json`: latest project outcome.
- `projects/PXDxxxxxx/attempts/<timestamp>/`: input row, full trace, API requests and
  responses, browser storage checkpoint, chat sessions, wizard state, and failure screenshot/text.
  If a failed run generated an exportable draft, it is stored here as `.draft.sdrf.tsv`.

`success` means the editor completed and passed its **pinned-template preflight**.
It does not mean a complete ontology validation or scientific review was performed.
Warnings are preserved. The exported `comment[sdrf version]` currently comes from
the editor's `SDRF_SPEC_VERSION` configuration; this runner does not verify that
the configured version is an official specification release.

The batch uses the backend's configured LLM and external retrieval services.
Keep the frontend/backend running. The batch never submits files to PRIDE or
publishes them. A failed project does not stop subsequent projects. Infrastructure
failure before starting (e.g. unavailable backend or browser) aborts the invocation
without marking all projects failed.

## Tests

```bash
node --test scripts/pride-batch-lib.test.mjs
```

With Playwright configured, also run the isolated browser fixture test. It checks
downloads, blocked-project reporting, subsequent-project execution and resume
without using the model or real PRIDE projects:

```bash
node --test scripts/pride-batch-lib.test.mjs scripts/batch-annotate-pride.browser-test.mjs
```
