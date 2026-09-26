import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actionHistoryFeedback } from './action-history.ts';
import type { WizardActionCard, WizardSnapshot } from '../../models/assistant.ts';
const snapshot = { sampleCount: 3, biologicalReplicates: [1, 1, 1] } as WizardSnapshot;
const card = { action: { op: 'setBiologicalReplicates', args: [[1, 1, 1]], label: 'Replicates' }, status: 'applied' } as WizardActionCard;
test('only successfully applied values matching the complete snapshot are compacted', () => {
  assert.equal(actionHistoryFeedback(card, snapshot).argsFrom, 'current wizard state');
  for (const status of ['pending', 'failed', 'dismissed'] as const) {
    assert.deepEqual(actionHistoryFeedback({ ...card, status }, snapshot).args, card.action.args);
  }
  assert.deepEqual(actionHistoryFeedback({ ...card, executionState: 'rolled-back' }, snapshot).args, card.action.args);
  assert.deepEqual(actionHistoryFeedback(card, { ...snapshot, biologicalReplicates: [1, 2, 3] }).args, card.action.args);
});
test('truncated lists and complex actions retain original arguments', () => {
  const values = Array(17).fill(1);
  const long = { ...card, action: { ...card.action, args: [values] } };
  assert.deepEqual(actionHistoryFeedback(long, { ...snapshot, biologicalReplicates: values }).args, [values]);
  const complex = { ...card, action: { ...card.action, op: 'applyRunsFilesPlan' } };
  assert.deepEqual(actionHistoryFeedback(complex, snapshot).args, card.action.args);
});
