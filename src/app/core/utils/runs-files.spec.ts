import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createEmptyWizardState, createDefaultSample, applyRunsFilesPlan, buildWizardExpansionRows, validateRunsAndFiles, assayNameForFile, packSamplesIntoRuns, runPlaceholderSnapshot } from '../models/wizard.ts';
function fixture() {
  const state = createEmptyWizardState();
  state.msRuns = [];
  state.samples = [{ ...createDefaultSample(1), sourceName: 'shared' }];
  state.factors = [{ name: 'strategy', enabled: true, scope: 'run', values: ['DT', 'DDNL'] }];
  state.dataFiles = ['dt.raw', 'ddnl.raw'].map(fileName => ({ fileName }));
  const plan = { groups: ['DT', 'DDNL'].map((name, i) => ({ name, labelConfigId: 'lf',
    channels: [{ label: 'label free sample', sourceName: 'shared' }], factorValues: { strategy: name },
    files: [{ fileName: state.dataFiles[i].fileName, fractionId: 1, technicalReplicate: 1 }],
  })) };
  return { state, plan };
}
it('creates two technical groups referencing one biological sample, with distinct file assays', () => {
  const { state, plan } = fixture();
  const next = applyRunsFilesPlan(state, plan);
  assert.equal(next.samples.length, 1);
  assert.equal(next.msRuns.length, 2);
  assert.equal(validateRunsAndFiles(next), true);
  const rows = buildWizardExpansionRows(next);
  assert.deepEqual(rows.map(r => r.sourceName), ['shared', 'shared']);
  assert.equal(new Set(rows.map(r => assayNameForFile(r.fileName))).size, 2);
  assert.deepEqual(next.msRuns.map(r => r.factorValues.strategy), ['DT', 'DDNL']);
});
it('rejects missing files atomically and keeps stable identities when reapplied', () => {
  const { state, plan } = fixture();
  const before = JSON.stringify(state);
  plan.groups[1].files[0].fileName = 'missing.raw';
  assert.throws(() => applyRunsFilesPlan(state, plan), /exactly one file/);
  assert.equal(JSON.stringify(state), before);
  plan.groups[1].files[0].fileName = 'ddnl.raw';
  const next = applyRunsFilesPlan(state, plan);
  assert.deepEqual(applyRunsFilesPlan(next, plan), next);
});
it('rejects duplicate file assignment, invalid factor, sample and noninteger replicates', () => {
  for (const edit of [
    p => p.groups[1].files[0].fileName = 'dt.raw',
    p => p.groups[1].factorValues.strategy = 'unknown',
    p => p.groups[1].channels[0].sourceName = 'missing',
    p => p.groups[1].files[0].technicalReplicate = 1.5,
  ]) {
    const { state, plan } = fixture(); edit(plan);
    assert.throws(() => applyRunsFilesPlan(state, plan));
    assert.equal(state.msRuns.length, 0);
  }
});
it('does not silently attach orphan files to the first group', () => {
  const { state, plan } = fixture(); const next = applyRunsFilesPlan(state, plan);
  next.dataFiles[1].runId = 'missing';
  assert.equal(validateRunsAndFiles(next), false);
  assert.equal(buildWizardExpansionRows(next).length, 1);
});
it('requires coverage of existing files when changing a shared mapping', () => {
  const { state, plan } = fixture(); const next = applyRunsFilesPlan(state, plan);
  next.dataFiles.push({ fileName: 'extra.raw', runId: next.msRuns[0].id });
  assert.throws(() => applyRunsFilesPlan(next, plan), /every existing file/);
});

it('TMT channels share one assay while independent files remain distinct', () => {
  const { state } = fixture(); state.factors = [];
  state.samples.push({ ...createDefaultSample(2), sourceName: 'second' });
  const next = applyRunsFilesPlan(state, { groups: [{ name: 'plex', labelConfigId: 'tmt6',
    channels: [{label: 'TMT126', sourceName: 'shared'}, {label: 'TMT127N', sourceName: 'second'}],
    files: state.dataFiles.map(f => ({...f, fractionId: 1, technicalReplicate: 1})),
  }] });
  const rows = buildWizardExpansionRows(next);
  assert.deepEqual(rows.map(r => assayNameForFile(r.fileName)), ['dt.raw', 'dt.raw', 'ddnl.raw', 'ddnl.raw']);
});

function withPlaceholder() {
  const { state, plan } = fixture();
  const run = packSamplesIntoRuns(state.samples, ['label free sample'])[0];
  run.placeholderSnapshot = runPlaceholderSnapshot(run);
  state.msRuns = [run];
  return { state, plan, run };
}
it('replaces an unchanged automatic placeholder once its sample is covered', () => {
  const { state, plan } = withPlaceholder();
  const next = applyRunsFilesPlan(state, plan);
  assert.deepEqual(next.msRuns.map(r => r.name), ['DT', 'DDNL']);
  assert.equal(buildWizardExpansionRows(next).length, 2);
  assert.deepEqual(applyRunsFilesPlan(next, plan), next);
  assert.equal(state.msRuns.length, 1);
});
it('preserves manual, edited, and file-bearing groups', () => {
  for (const edit of [
    run => delete run.placeholderSnapshot,
    run => run.name = 'My group',
    run => run.factorValues = { strategy: 'DT' },
    run => run.channels[0].sourceNameOverride = 'custom',
  ]) {
    const { state, plan, run } = withPlaceholder();
    edit(run);
    assert.ok(applyRunsFilesPlan(state, plan).msRuns.some(r => r.id === run.id));
  }
  const { state, plan, run } = withPlaceholder();
  state.dataFiles.push({ fileName: 'keep.raw', runId: run.id });
  assert.ok(applyRunsFilesPlan(state, plan).msRuns.some(r => r.id === run.id));
});
it('preserves placeholders for samples not covered by the plan', () => {
  const { state, plan, run } = withPlaceholder();
  state.samples.push({ ...createDefaultSample(2), sourceName: 'unmapped' });
  run.channels[0].sampleIndex = 2;
  run.sampleIndices = [2];
  run.placeholderSnapshot = runPlaceholderSnapshot(run);
  assert.ok(applyRunsFilesPlan(state, plan).msRuns.some(r => r.id === run.id));
});
it('failed plans never clean up placeholders', () => {
  const { state, plan } = withPlaceholder();
  const before = JSON.stringify(state);
  plan.groups[1].files[0].fileName = 'missing.raw';
  assert.throws(() => applyRunsFilesPlan(state, plan));
  assert.equal(JSON.stringify(state), before);
});


import { parseFileNameList } from './file-name-list.ts';
it('parses pasted file names with mixed whitespace, commas and semicolons', () => {
  assert.deepEqual(parseFileNameList('a.raw b.raw,c.raw;d.raw\te.raw\r\nf.raw，g.raw；h.raw'),
    ['a.raw', 'b.raw', 'c.raw', 'd.raw', 'e.raw', 'f.raw', 'g.raw', 'h.raw']);
  assert.deepEqual(parseFileNameList(' , ; \t\n'), []);
  assert.deepEqual(parseFileNameList('a.raw,,; a.raw\nb.raw'), ['a.raw', 'b.raw']);
});
it('preserves separators within double-quoted file names', () => {
  assert.deepEqual(parseFileNameList('"sample 1.raw", "sample,2.raw";"sample;3.raw"'),
    ['sample 1.raw', 'sample,2.raw', 'sample;3.raw']);
});

it('AI plans map label-free files to independent samples and a pool within one group', () => {
  const { state } = fixture(); state.factors = [];
  state.samples.push({ ...createDefaultSample(2), sourceName: 'second' });
  state.dataFiles.push({ fileName: 'pool.raw' });
  const group = { name: 'All samples', labelConfigId: 'lf', sampleMappingMode: 'rows',
    channels: [
      { label: 'label free sample', mappingId: 'a', sourceName: 'shared' },
      { label: 'label free sample', mappingId: 'b', sourceName: 'second' },
      { label: 'label free sample', mappingId: 'pool', pooledSourceNames: ['shared', 'second'] },
    ],
    files: state.dataFiles.map((f, i) => ({ ...f, mappingId: ['a', 'b', 'pool'][i], fractionId: 1, technicalReplicate: 1 })),
  };
  const next = applyRunsFilesPlan(state, { groups: [group] });
  assert.equal(validateRunsAndFiles(next), true);
  const rows = buildWizardExpansionRows(next);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].sourceName, 'shared');
  assert.equal(rows[1].sourceName, 'second');
  assert.match(rows[2].sourceName, /shared/);
  assert.match(rows[2].sourceName, /second/);
  assert.deepEqual(applyRunsFilesPlan(next, { groups: [group] }), next);
  for (const mutate of [
    g => g.files[0].mappingId = 'missing',
    g => g.channels[1].mappingId = 'a',
    g => g.channels[2].pooledSourceNames = ['shared', 'shared'],
    g => g.labelConfigId = 'tmt6',
  ]) {
    const invalid = structuredClone(group); mutate(invalid);
    const before = JSON.stringify(next);
    assert.throws(() => applyRunsFilesPlan(next, { groups: [invalid] }));
    assert.equal(JSON.stringify(next), before);
  }
});

it('AI shared-channel plans support pooled multiplex channels and clear stale file mapping', () => {
  const { state } = fixture(); state.factors = [];
  state.samples.push({ ...createDefaultSample(2), sourceName: 'second' });
  state.dataFiles[0].mappingId = 'old-row';
  state.dataFiles[0].sampleIndex = 1;
  const next = applyRunsFilesPlan(state, { groups: [{
    name: 'plex', labelConfigId: 'tmt6',
    channels: [{ label: 'TMT126', pooledSourceNames: ['shared', 'second'] }],
    files: state.dataFiles.map(f => ({ fileName: f.fileName, fractionId: 1, technicalReplicate: 1 })),
  }] });
  assert.equal(validateRunsAndFiles(next), true);
  assert.equal(next.dataFiles[0].mappingId, undefined);
  assert.equal(next.dataFiles[0].sampleIndex, undefined);
  assert.deepEqual(next.msRuns[0].sampleIndices, [1, 2]);
  assert.equal(buildWizardExpansionRows(next).length, 2);
});
