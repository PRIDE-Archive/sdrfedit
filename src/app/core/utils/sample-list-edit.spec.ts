import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateSampleListEdit } from './sample-list-edit.ts';
const samples = [{sourceName: 'sample_1', biologicalReplicate: 1}, {sourceName: 'sample_2', biologicalReplicate: 2}];
test('batch renaming validates the resulting list, allowing swaps but not collisions with unselected rows', () => {
  assert.equal(validateSampleListEdit(samples, [0, 1], ['sample_2', 'sample_1'], 'sourceName'), '');
  assert.match(validateSampleListEdit(samples, [0], ['sample_2'], 'sourceName'), /unique/);
  assert.equal(validateSampleListEdit(samples, [1], ['treated_01'], 'sourceName'), '');
  assert.equal(samples[1].sourceName, 'sample_2');
});
test('paste length and stale targets are validated before mutation', () => {
  assert.match(validateSampleListEdit(samples, [0, 1], ['control'], 'sourceName'), /Expected 2/);
  assert.match(validateSampleListEdit(samples, [2], ['control'], 'sourceName'), /changed/);
  assert.match(validateSampleListEdit(samples, [0], ['   '], 'sourceName'), /non-empty/);
});
test('biological replicates must be positive integers', () => {
  for (const value of [0, -1, 1.5, NaN, Infinity]) assert.match(validateSampleListEdit(samples, [1], [value], 'biologicalReplicate'), /positive whole/);
  assert.equal(validateSampleListEdit(samples, [0, 1], [1, 1], 'biologicalReplicate'), '');
});

import { parseSampleRowSelection } from './sample-list-edit.ts';
test('sample ranges select exact rows and deduplicate overlaps', () => {
  assert.deepEqual(parseSampleRowSelection('1-3, 3, 5–6', 22), [0, 1, 2, 4, 5]);
  assert.deepEqual(parseSampleRowSelection('22', 22), [21]);
  for (const value of ['', '0', '23', '3-1', '1.5', '1-9999999999', 'a']) {
    assert.throws(() => parseSampleRowSelection(value, 22));
  }
});

import { previewRegexRename } from './sample-list-edit.ts';
test('regex rename supports captures, suffixes and unmatched names', () => {
  assert.deepEqual(previewRegexRename(['sample_1', 'sample_22', 'control'], '^sample_(\\d+)$', 'patient_$1'), ['patient_1', 'patient_22', 'control']);
  assert.deepEqual(previewRegexRename(['sample_1'], '$', '_baseline'), ['sample_1_baseline']);
  assert.deepEqual(previewRegexRename(['SAMPLE_1'], '^sample_', 'patient_', true), ['patient_1']);
  assert.throws(() => previewRegexRename(['sample_1'], '[', 'x'));
  assert.throws(() => previewRegexRename(['sample_1'], '', 'x'));
  const proposed = previewRegexRename(samples.map(s => s.sourceName), '^.*$', 'same');
  assert.match(validateSampleListEdit(samples, [0, 1], proposed, 'sourceName'), /unique/);
});
