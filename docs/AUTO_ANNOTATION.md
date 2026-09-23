# Automatic SDRF annotation

The wizard assistant provides an explicit **Auto annotate** button. Ordinary chat
continues to create pending suggestion cards, and Apply / Apply all keep their
existing behavior. Automatic execution is never enabled by opening a wizard,
loading chat history, uploading a document, or receiving a suggestion.

## Use

1. Open Create New SDRF and the assistant. The assistant backend must be available.
2. Enter a PXD accession, `/sdrf-annotate PXD…`, or an experiment description.
   A ready uploaded PDF or the current conversation can also supply the context.
3. Click **Auto annotate**. The assistant works through setup, characteristics,
   samples, runs/files, and protocol. New cards are applied automatically; existing
   pending cards are not replayed. Editing, manual Apply, and chat switching are
   temporarily unavailable while this run owns the wizard.
4. On success, **Download SDRF** exports the generated table. The wizard remains
   available on Review & Create, so the existing Create SDRF workflow still works.

**Stop auto annotation** aborts the active assistant request. Completed batches
remain in the wizard; an interrupted mutation batch is rolled back. An in-flight
mutation must settle before editing is unlocked. Final validation can be stopped
without waiting for its remote response.

**Undo auto annotation** restores the state and step from before the latest run,
and dismisses that run's cards. Undo is available only while the wizard data still
matches the run's result, so it cannot discard subsequent manual edits. Changing
chats clears the transient undo point. Reloading never resumes automation.

## Completion and incomplete drafts

Each assistant turn must finish normally and return an automatic completion
report. Missing reports, interrupted streams, unresolved evidence, invalid
actions, and validation errors cannot produce a successful completion.

Each step allows one initial attempt and at most two repair attempts. Repeated
attempts that make no progress stop early. Final SDRF validation may send the
assistant back to an earlier step, at most twice. Missing evidence stays visible
as unresolved items; it is not replaced by fabricated sample/file mappings.

Final validation uses the same selected-template validator API and
`skipOntology: true` setting as the existing Review & Create page. Passing this
check does not establish scientific correctness or perform a fresh ontology
lookup. Validation warnings remain visible. If final validation fails or is
unavailable (including a 60-second timeout), the generated file is offered as
**Download draft**, not as a validated SDRF. If execution stopped before a table
could be generated, the partial wizard state remains saved in chat history.

Cards keep their before/after previews, reasons, and citations and show
**Auto-applied** on success. Rolled-back batches show the application error.
The outcome and unresolved items are also recorded in the conversation.

## Implementation

- `WizardAutoAnnotationService` owns opt-in run state, checkpoints, generation,
  template validation, stopping, downloads, and undo.
- `core/utils/auto-annotation.ts` is the dependency-injected orchestration engine.
  It serializes actions, respects template/file/factor dependencies, deduplicates
  repeated actions, rolls back failed batches, and bounds repair loops.
- `WizardAiPanelComponent` reuses the existing streaming transport and timeline.
  Automatic cards are registered from the final `done` event, not partial SSE
  events. Manual turns continue to use the existing action events.
- `executionMode: "auto"` is separate from `mode: "chat" | "step"`. The backend
  defaults to `executionMode: "manual"`. The automatic proposal tool additionally
  requires `automation: {status: "ready" | "blocked", issues: string[]}`; the
  original manual tool schema and evidence/step gates are preserved.
- Automatic snapshots include per-sample characteristic and factor assignments
  so repairs can preserve correctly filled values. Manual snapshots retain their
  previous shape.

Deploy the frontend and backend together for this feature. An older backend can
still handle manual chat, but automatic runs stop when a completion report is
missing.

## Checks

```sh
npm run test:wizard
npm run build -- --output-path /tmp/sdrfedit-auto-build
cd backend
.venv/bin/python -m pytest -q
```

Tests cover manual/automatic backend contract separation, invalid reports,
retained step gates, batch order and rollback, duplicate operations, cancellation
and late responses, stale snapshots, bounded repairs, and final validation.

An optional browser smoke test exercises the built Angular UI with mocked
assistant, template-discovery, and validator responses. It uses Playwright from
the test environment; the application does not acquire a Playwright dependency.
After building to `/tmp/sdrfedit-auto-build`, run:

```sh
node scripts/smoke-auto-annotation.mjs
```

The script starts and closes its own local static server. `SDRF_BUILD_DIR`
overrides the build's `browser` directory, or `SDRF_TEST_URL` can point to an
already running local preview. If Playwright is installed outside this
repository, set `PLAYWRIGHT_MODULE` to its `index.mjs` path.
`PLAYWRIGHT_EXECUTABLE_PATH` can select an existing Chromium executable.
`SDRF_SCREENSHOT_DIR` overrides the default `/tmp` screenshot directory.
The test covers manual Apply, the full automatic workflow and download, undo,
stopping late responses and final validation, missing evidence, unavailable
validation, and reload behavior. These mocked tests do not measure real LLM
annotation quality or live external-service availability.
