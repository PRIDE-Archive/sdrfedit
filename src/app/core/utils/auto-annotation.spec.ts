import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { autoAnnotationStartStep, runAutoAnnotation, orderAutoCards, type AutoAnnotationPorts, type AutoTurn } from './auto-annotation.ts';
import type { WizardActionCard } from '../models/assistant.ts';

function card(op = 'setSampleCount', value: unknown = 2): WizardActionCard {
  return { id: `${op}-${JSON.stringify(value)}`, status: 'pending', preview: 'before → after',
    action: { step: 'setup', op, args: [value], label: op, confidence: 'high', reasoning: '', citations: [] } };
}
const ready = (cards: WizardActionCard[] = [card('noop')]): AutoTurn => ({ cards, report: { status: 'ready', issues: [] } });

function harness() {
  let state = { value: 0 };
  const controller = new AbortController();
  const requests: { step: number; value: number }[] = [];
  const applied: WizardActionCard[] = [];
  const records: { applied: boolean; error?: string }[] = [];
  const navigation: number[] = [];
  let validations = 0;
  const ports: AutoAnnotationPorts<typeof state> = {
    snapshot: () => structuredClone(state),
    restore: snapshot => { state = snapshot; },
    fingerprint: () => JSON.stringify(state),
    navigate: step => { navigation.push(step); },
    request: async (step) => { requests.push({ step, value: state.value }); return ready(); },
    apply: async action => { if (action.action.op === 'noop') return; applied.push(action); state.value = Number(action.action.args[0]); },
    record: (_, applied, error) => { records.push({ applied, error }); },
    errors: () => [],
    validate: async () => { validations++; return { issues: [] }; },
    progress: () => {},
  };
  return { ports, controller, requests, applied, records, navigation,
    state: () => state, validations: () => validations,
    run: () => runAutoAnnotation(ports, controller.signal) };
}

describe('opt-in automatic annotation orchestration', () => {
  it('waits for the user after any reply without cards, without requesting again or advancing', async () => {
    for (const turn of [
      { cards: [] }, ready([]),
      { cards: [], report: { status: 'blocked' as const, issues: ['Which organism?'], notes: ['Need user evidence.'] } },
    ]) {
      const h = harness();
      const request = h.ports.request;
      const notes: string[] = [];
      h.ports.notes = (_, items) => notes.push(...items);
      h.ports.request = async (step) => { await request(step); return turn; };
      const result = await h.run();
      assert.equal(result.status, 'waiting');
      assert.deepEqual(result.issues, turn.report?.issues || []);
      assert.deepEqual(notes, turn.report?.notes || []);
      assert.equal(h.requests.length, 1);
      assert.equal(h.applied.length, 0);
      assert.equal(h.records.length, 0);
      assert.equal(h.validations(), 0);
      assert.deepEqual(h.navigation, [0]);
    }
  });

  it('keeps completed steps when waiting and continues only on an explicit new run', async () => {
    const h = harness();
    const request = h.ports.request;
    h.ports.request = async (step) => {
      await request(step);
      return step === 1 ? { cards: [] } : ready([card()]);
    };
    assert.equal((await h.run()).status, 'waiting');
    assert.equal(h.state().value, 2);
    assert.deepEqual(h.requests.map(r => r.step), [0, 1]);
    h.ports.request = request;
    const start = autoAnnotationStartStep(h.navigation.at(-1)!, h.ports.errors);
    assert.equal((await runAutoAnnotation(h.ports, h.controller.signal, start)).status, 'complete');
    assert.deepEqual(h.requests.map(r => r.step), [0, 1, 1, 2, 3, 4]);
  });

  it('continues after manually completing a paused step, including setup', async () => {
    for (const pausedStep of [0, 1, 3, 4]) {
      const h = harness();
      const request = h.ports.request;
      h.ports.request = async (step) => {
        await request(step);
        return step === pausedStep ? { cards: [] } : ready();
      };
      assert.equal((await h.run()).status, 'waiting');
      // A successful manual application completes the paused step. Merely
      // browsing back to setup must not reset the automation cursor.
      await h.ports.apply(card());
      h.ports.request = request;
      const start = autoAnnotationStartStep(0, h.ports.errors,
        { step: pausedStep, manuallyCompleted: true });
      assert.equal(start, pausedStep + 1);
      h.requests.length = 0;
      assert.equal((await runAutoAnnotation(h.ports, h.controller.signal, start)).status, 'complete');
      assert.deepEqual(h.requests.map(r => r.step),
        Array.from({ length: 4 - pausedStep }, (_, i) => pausedStep + i + 1));
      assert.equal(h.validations(), 1);
    }
  });

  it('retains the paused step until manual completion and rechecks requirements before advancing', () => {
    assert.equal(autoAnnotationStartStep(0, () => [], { step: 3, manuallyCompleted: false }), 3);
    assert.equal(autoAnnotationStartStep(0, step => step === 3 ? ['Unassigned file'] : [],
      { step: 3, manuallyCompleted: true }), 3);
    assert.equal(autoAnnotationStartStep(0, step => step === 1 ? ['Missing organism'] : [],
      { step: 3, manuallyCompleted: true }), 1);
  });

  it('does not request cards after Stop or overwrite edits made during a text-only reply', async () => {
    for (const stop of [true, false]) {
      const h = harness();
      const request = h.ports.request;
      h.ports.request = async (step) => {
        await request(step);
        if (stop) h.controller.abort(); else h.state().value = 99;
        return { cards: [] };
      };
      assert.equal((await h.run()).status, stop ? 'stopped' : 'blocked');
      assert.equal(h.requests.length, 1);
      assert.equal(h.applied.length, 0);
    }
  });

  it('advances from Sample Values to Runs & Files once, retaining non-blocking notes', async () => {
    const h = harness();
    const request = h.ports.request;
    const notes: { step: number; notes: string[] }[] = [];
    h.ports.notes = (step, items) => { if (items.length) notes.push({ step, notes: items }); };
    h.ports.request = async (step) => {
      await request(step);
      return step === 2 ? {
        cards: [card()], report: { status: 'ready', issues: [], notes: [
          'Every characteristic has a single candidate and already matches sample_1; no patch needed.',
          'Acquisition strategy is run-scoped and will be assigned on Runs & Files.',
        ] },
      } : ready();
    };
    const start = autoAnnotationStartStep(2, h.ports.errors);
    assert.equal((await runAutoAnnotation(h.ports, h.controller.signal, start)).status, 'complete');
    assert.deepEqual(h.requests.map(r => r.step), [2, 3, 4]);
    assert.deepEqual(h.navigation, [2, 3, 4, 5]);
    assert.equal(notes[0].step, 2);
    assert.equal(notes[0].notes.length, 2);
  });

  it('still blocks real sample validation failures alongside informational notes', async () => {
    const h = harness();
    const request = h.ports.request;
    h.ports.request = async (step) => {
      await request(step);
      return { cards: [card()], report: { status: 'ready', issues: [], notes: ['Run factors belong to step 4.'] } };
    };
    h.ports.errors = () => ['sample_1: assign treatment.'];
    const result = await runAutoAnnotation(h.ports, h.controller.signal, 2);
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.issues, ['sample_1: assign treatment.']);
    assert.deepEqual(h.navigation, [2]);
    assert.equal(h.requests.length, 1);
  });

  it('restarts a stopped request on its current step rather than replaying setup', async () => {
    const h = harness();
    const request = h.ports.request;
    h.ports.request = async (step) => {
      const turn = await request(step);
      if (step === 3) h.controller.abort();
      return turn;
    };
    assert.equal((await runAutoAnnotation(h.ports, h.controller.signal, 2)).status, 'stopped');
    assert.equal(h.navigation.at(-1), 3);
    h.ports.request = request;
    const resumed = new AbortController();
    const start = autoAnnotationStartStep(h.navigation.at(-1)!, h.ports.errors);
    assert.equal((await runAutoAnnotation(h.ports, resumed.signal, start)).status, 'complete');
    assert.deepEqual(h.requests.map(r => r.step), [2, 3, 3, 4]);
    assert.equal(h.navigation.includes(0), false);
  });

  it('checks earlier requirements before resuming and allows direct final revalidation', async () => {
    assert.equal(autoAnnotationStartStep(3, step => step === 1 ? ['Missing required characteristic'] : []), 1);
    assert.equal(autoAnnotationStartStep(3, () => []), 3);
    const h = harness();
    assert.equal((await runAutoAnnotation(h.ports, h.controller.signal, autoAnnotationStartStep(5, () => []))).status, 'complete');
    assert.equal(h.requests.length, 0);
    assert.equal(h.validations(), 1);
  });

  it('walks all five steps and validates before entering review', async () => {
    const h = harness();
    assert.equal((await h.run()).status, 'complete');
    assert.deepEqual(h.requests.map(r => r.step), [0, 1, 2, 3, 4]);
    assert.deepEqual(h.navigation, [0, 1, 2, 3, 4, 5]);
    assert.equal(h.validations(), 1);
  });

  it('waits for the complete assistant turn before applying anything', async () => {
    const h = harness();
    let resolve!: (turn: AutoTurn) => void;
    const request = h.ports.request;
    h.ports.request = (step) => step === 0
      ? new Promise(r => { resolve = r; }) : request(step);
    const run = h.run();
    assert.equal(h.applied.length, 0);
    resolve(ready([card()]));
    assert.equal((await run).status, 'complete');
    assert.equal(h.applied.length, 1);
  });

  it('orders file import before plan and assignment without mutating input', () => {
    const cards = [card('assignFilesToRunsByName'), card('applyRunsFilesPlan'), card('replaceWithUnassignedFileNames'), card('setLabelConfig')];
    assert.deepEqual(orderAutoCards(cards).map(c => c.action.op), ['setLabelConfig', 'replaceWithUnassignedFileNames', 'applyRunsFilesPlan', 'assignFilesToRunsByName']);
    assert.equal(cards[0].action.op, 'assignFilesToRunsByName');
  });

  it('rolls back a failed batch, preserves earlier steps, and never retries', async () => {
    const h = harness();
    const request = h.ports.request;
    h.ports.request = async step => {
      await request(step);
      return ready(step === 0 ? [card('setSampleCount', 2)]
        : [card('setSampleCount', 4), card('fail', 3)]);
    };
    const apply = h.ports.apply;
    h.ports.apply = async c => { await apply(c); if (c.action.op === 'fail') throw new Error('Unknown raw file'); };
    const result = await h.run();
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.issues, ['Unknown raw file']);
    assert.deepEqual(h.requests.map(r => r.step), [0, 1]);
    assert.equal(h.records[0].applied, true);
    assert.equal(h.records[1].applied, false);
    assert.match(h.records[1].error!, /rolled back/);
    assert.equal(h.state().value, 2);
    assert.equal(h.validations(), 0);
  });

  it('does not apply duplicate actions within a turn', async () => {
    const h = harness();
    h.ports.request = async step => step ? ready() : ready([card(), card()]);
    assert.equal((await h.run()).status, 'complete');
    assert.equal(h.applied.length, 1);
  });

  it('only requests again after the user explicitly resumes a blocked run', async () => {
    const h = harness();
    const request = h.ports.request;
    h.ports.request = async step => {
      await request(step);
      return { cards: [card()], report: { status: 'blocked', issues: ['Confirm sample count: 4 or 5?'] } };
    };
    assert.equal((await h.run()).status, 'blocked');
    assert.equal(h.requests.length, 1);
    assert.equal(h.state().value, 2);
    await h.ports.apply(card('setSampleCount', 4));
    h.ports.request = request;
    const start = autoAnnotationStartStep(0, h.ports.errors, { step: 0, manuallyCompleted: true });
    assert.equal((await runAutoAnnotation(h.ports, h.controller.signal, start)).status, 'complete');
    assert.deepEqual(h.requests.map(r => r.step), [0, 1, 2, 3, 4]);
    assert.equal(h.state().value, 4);
  });

  it('never applies a late response after Stop', async () => {
    const h = harness();
    h.ports.request = async () => { h.controller.abort(); return ready([card()]); };
    assert.equal((await h.run()).status, 'stopped');
    assert.equal(h.applied.length, 0);
    assert.equal(h.validations(), 0);
  });

  it('rolls back an in-flight action when Stop arrives and keeps prior batches', async () => {
    const h = harness();
    h.ports.request = async step => ready([card('setSampleCount', step + 1)]);
    const apply = h.ports.apply;
    h.ports.apply = async c => { await apply(c); if (c.action.args[0] === 2) h.controller.abort(); };
    assert.equal((await h.run()).status, 'stopped');
    assert.equal(h.state().value, 1);
    assert.equal(h.records.at(-1)!.applied, false);
  });

  it('does not overwrite edits made while a request was pending', async () => {
    const h = harness();
    h.ports.request = async () => { h.state().value = 99; return ready([card()]); };
    const result = await h.run();
    assert.equal(result.status, 'blocked');
    assert.match(result.issues[0], /changed/);
    assert.equal(h.state().value, 99);
    assert.equal(h.applied.length, 0);
  });

  it('does not treat a legacy backend response or a failed stream as approval', async () => {
    for (const fail of [false, true]) {
      const h = harness();
      h.ports.request = async () => {
        if (fail) throw new Error('Stream interrupted');
        return { cards: [card()] };
      };
      assert.equal((await h.run()).status, 'blocked');
      assert.equal(h.applied.length, 0);
    }
  });

  it('stops after one blocked report even when cards apply and existing defaults validate', async () => {
    const h = harness();
    const request = h.ports.request;
    h.ports.request = async (step) => {
      await request(step);
      return { cards: [card()], report: { status: 'blocked', issues: ['Ambiguous sample mapping'] } };
    };
    const result = await h.run();
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.issues, ['Ambiguous sample mapping']);
    assert.equal(h.requests.length, 1);
    assert.equal(h.validations(), 0);
  });

  it('stops after one validation failure even when applying cards changed state', async () => {
    const h = harness();
    let count = 0;
    h.ports.request = async () => ready([card('setSampleCount', ++count)]);
    h.ports.errors = () => ['Missing required value'];
    assert.equal((await h.run()).status, 'blocked');
    assert.equal(count, 1);
  });

  it('reports final validation errors without revisiting a step or retrying validation', async () => {
    const h = harness();
    let count = 0;
    h.ports.validate = async () => { count++; return { issues: ['Invalid instrument accession'] }; };
    const result = await h.run();
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.issues, ['Invalid instrument accession']);
    assert.deepEqual(h.requests.map(r => r.step), [0, 1, 2, 3, 4]);
    assert.deepEqual(h.navigation, [0, 1, 2, 3, 4]);
    assert.equal(count, 1);
    // After a manual correction, explicitly revalidate without requesting cards.
    h.ports.validate = async () => { count++; return { issues: [] }; };
    assert.equal((await runAutoAnnotation(h.ports, h.controller.signal, 5)).status, 'complete');
    assert.equal(h.requests.length, 5);
    assert.equal(count, 2);
  });

  it('stops when final validation is unavailable', async () => {
    const h = harness();
    let count = 0;
    h.ports.validate = async () => { count++; throw new Error('Validation unavailable'); };
    const result = await h.run();
    assert.equal(result.status, 'blocked');
    assert.deepEqual(result.issues, ['Validation unavailable']);
    assert.equal(count, 1);
    assert.equal(h.navigation.includes(5), false);
  });

  it('does not publish success after cancellation during validation', async () => {
    const h = harness();
    h.ports.validate = async () => { h.controller.abort(); return { issues: [] }; };
    assert.equal((await h.run()).status, 'stopped');
    assert.equal(h.navigation.includes(5), false);
  });

  it('releases a run immediately when validation is still waiting after Stop', { timeout: 1000 }, async () => {
    const h = harness();
    h.ports.validate = () => {
      queueMicrotask(() => h.controller.abort());
      return new Promise(() => {});
    };
    assert.equal((await h.run()).status, 'stopped');
  });
});
