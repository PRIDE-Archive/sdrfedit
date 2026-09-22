import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { appendThinking, finishThinking, recordThinking } from './assistant-thinking.ts';

test('reasoning chunks accumulate separately from status and remain after completion', () => {
  let timeline = recordThinking([], 'Thinking…', 1000);
  timeline = appendThinking(timeline, 'Check the ');
  timeline = appendThinking(timeline, 'metadata.');
  timeline = recordThinking(timeline, 'Preparing tools', 1100);
  timeline = finishThinking(timeline, 1200);
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].reasoning, 'Check the metadata.');
  assert.equal(JSON.parse(JSON.stringify(timeline))[0].reasoning, 'Check the metadata.');
});

test('progress updates keep one thinking phase and its original start time', () => {
  const initial = recordThinking([], 'Waiting', 1000);
  const updated = recordThinking(initial, 'Thinking…', 1200);
  assert.equal(updated.length, 1);
  assert.deepEqual(updated[0], { ...initial[0], content: 'Thinking…' });
  assert.equal(initial[0].content, 'Waiting');
});

test('completed thinking stays in order between response rounds and survives serialization', () => {
  const first = finishThinking(recordThinking([], 'Thinking…', 1000), 2500);
  const next = recordThinking([...first, { kind: 'text', id: 'answer', content: 'Checking results.' }], 'Thinking…', 3000);
  const finished = finishThinking(next, 4500);
  assert.deepEqual(finished.map(item => item.kind), ['thinking', 'text', 'thinking']);
  assert.equal(finished[0].finishedAt, 2500);
  assert.equal(finished[2].finishedAt, 4500);
  assert.deepEqual(JSON.parse(JSON.stringify(finished)), finished);
  assert.deepEqual(finishThinking(finished, 5000), finished);
});

test('stopping before a response completes closes the active thinking phase', () => {
  const stopped = finishThinking(recordThinking([], 'Thinking…', 1000), 1100);
  assert.equal(stopped[0].finishedAt, 1100);
  assert.equal(stopped.length, 1);
});
