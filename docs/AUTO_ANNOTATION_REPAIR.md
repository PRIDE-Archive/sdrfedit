# Automatic repair of failed recommendation cards

Automatic annotation now has a bounded repair path for supported action-application failures. It keeps the original step recommendations, requests one replacement for the failing card, and replays the transaction. It does not regenerate the whole step.

## Transaction and repair flow

1. Generate the step's cards and completion report once.
2. Save a checkpoint and execute cards in dependency order.
3. On failure, restore an independent copy of the checkpoint. Record the exact failing card, attempted cards rolled back, and cards not executed.
4. If the failure is repairable and the original report has no evidence blockers, send the original action, structured error, allowed values, parameter contract, and preserved batch to the same assistant session. The current snapshot is explicitly described as the state before the batch.
5. Require exactly one replacement with the same operation and wizard step. Preserve target sample/column/factor identifiers. For label-enumeration errors, only the invalid kit/channel fields may change; all other arguments must remain identical (object-key order is ignored).
6. Mark the old card superseded and retain it in history. Replace its position in the preserved batch, then replay from the checkpoint and rerun normal step checks.
7. Continue only after the replay and normal checks succeed.

Limits: two repair requests per replacement chain and six per automatic run. Repeated failing arguments, changed wizard state, missing/blocked reports, extra cards, out-of-scope changes, or request failures stop automatic repair. Stop cancels a pending repair promptly; late responses are never applied. A failed or cancelled mutation replay restores the original checkpoint.

## Supported failures and boundaries

- Recognized argument errors from the bridge can request repair.
- Label-kit errors include the live `LABEL_CONFIGS` IDs. Run-plan errors additionally include allowed labels by kit and exact editable argument paths.
- Selected missing-run/file-reference errors can request repair against the current state and preserved batch.
- Evidence/candidate/ontology blockers, unsupported templates, arbitrary runtime/network errors, and successful batches with unresolved evidence remain blocked.
- Final SDRF validation errors are still reported as blockers. This first implementation does not automatically trace final table cells back to earlier steps or modify scientific values to pass validation.
- Unknown aliases are not silently coerced. AI proposes a correction; the usual bridge/state validators still decide whether it can be applied.

## UI and audit

Only the actual failing card is marked failed. Other cards show rolled-back or not-executed state. Superseded and rejected repair cards remain visible but cannot be applied through their action button. The new card links to its original card. Repair attempt/status/message and replacement IDs are persisted in card history and exported in the agent trace; detailed structured feedback is retained in the repair message.

## Regression coverage

- `src/app/core/utils/auto-annotation.spec.ts`: replacement/replay, checkpoint preservation, limits, duplicate/cyclic corrections, scope, cancellation, state changes, missing evidence and request failures.
- `src/app/core/services/template-composition.spec.cjs`: PXD001574 historical card batch through the real bridge/state services; Angular DI/signals are substituted, AI responses are deterministic test replacements.
- `tests/fixtures/auto-repair-pxd001574.json`: reduced historical state and original operation arguments, including invalid kit and channel names.
- `reports/auto-card-repair-2026-09-25/`: isolated browser replay artifacts. The historical first batch is injected to guarantee the old failure is exercised; subsequent repair requests use the actual running backend/AI. PXD002281's historical evidence blocker is replayed separately to check that it does not trigger repair.
