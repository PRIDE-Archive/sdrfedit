import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Papa from 'papaparse';
import { readManifest, runQueue, shouldRun, sha256, writeSummary } from './pride-batch-lib.mjs';

function fixture(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'sdrf-batch-test-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  return directory;
}

test('CSV supports BOM, CRLF, quoted commas and embedded newlines', t => {
  const path = resolve(fixture(t), 'projects.csv');
  writeFileSync(path, '\uFEFFaccession,title\r\npxd000062,"A, title\nwith a newline"\r\n');
  const {projects} = readManifest(path);
  assert.equal(projects[0].accession, 'PXD000062');
  assert.equal(projects[0].title, 'A, title\nwith a newline');
});

test('bad and duplicated accessions fail before any annotation', t => {
  const path = resolve(fixture(t), 'projects.csv');
  for (const text of ['accession\n../bad\n', 'accession\nPXD000062\npxd000062\n', 'title\nA\n']) {
    writeFileSync(path, text);
    assert.throws(() => readManifest(path));
  }
});

test('resume skips verified output but reruns missing or corrupted output', t => {
  const directory = fixture(t);
  const content = 'source name\tcomment[data file]\ns1\ta.raw\n';
  const result = {status: 'success', sdrfPath: 'result.tsv', sdrfSha256: sha256(content)};
  assert.equal(shouldRun(result, directory, false), true);
  writeFileSync(resolve(directory, result.sdrfPath), content);
  assert.equal(shouldRun(result, directory, false), false);
  writeFileSync(resolve(directory, result.sdrfPath), 'truncated');
  assert.equal(shouldRun(result, directory, false), true);
  assert.equal(shouldRun({status: 'blocked'}, directory, false), false);
  assert.equal(shouldRun({status: 'blocked'}, directory, true), true);
  assert.equal(shouldRun({status: 'running'}, directory, false), true);
});

test('queue isolates project errors and obeys concurrency', async () => {
  let active = 0;
  let peak = 0;
  const results = [];
  await runQueue(Array.from({length: 5}, (_, i) => ({accession: `PXD${i}`})), 2, async item => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    if (item.accession === 'PXD1') throw new Error('API unavailable');
    return {status: 'success'};
  }, (item, result) => results.push([item.accession, result]));
  assert.equal(peak, 2);
  assert.equal(results.length, 5);
  assert.equal(results.find(([id]) => id === 'PXD1')[1].status, 'error');
  assert.equal(results.filter(([,r]) => r.status === 'success').length, 4);
});

test('summary keeps blocked/waiting separate and escapes spreadsheet formulas', t => {
  const directory = fixture(t);
  const projects = [{accession:'PXD000001', title:'=BAD()'}, {accession:'PXD000002'}, {accession:'PXD000003'}];
  const results = new Map([
    ['PXD000001', {status:'success', sdrfPath:'successful/a.tsv'}],
    ['PXD000002', {status:'waiting', issues:['Missing sample map, see paper']}],
  ]);
  assert.deepEqual(writeSummary(directory, projects, results), {success:1, waiting:1, pending:1});
  const failures = Papa.parse(readFileSync(resolve(directory, 'failures.csv'), 'utf8'), {header:true, skipEmptyLines:true}).data;
  assert.equal(failures.length, 1);
  assert.equal(failures[0].accession, 'PXD000002');
  assert.equal(failures[0].issues, 'Missing sample map, see paper');
  assert.match(readFileSync(resolve(directory, 'summary.csv'), 'utf8'), /'=BAD/);
});

test('success goal replaces failures, counts existing successes and never overshoots', async () => {
  const completed = [];
  const items = Array.from({length: 20}, (_, index) => ({accession: String(index)}));
  await runQueue(items, 4, async item => {
    await new Promise(resolve => setTimeout(resolve, 5));
    return {status: Number(item.accession) % 2 ? 'success' : 'blocked'};
  }, (item, result) => completed.push(result), () => false, 5, 2);
  assert.equal(completed.filter(r => r.status === 'success').length, 3);
  assert.equal(completed.length, 6);
});

test('already achieved goal launches nothing; exhausted queue does not invent successes', async () => {
  let calls = 0;
  const run = async () => { calls++; return {status:'blocked'}; };
  await runQueue([{accession:'a'}], 2, run, () => {}, () => false, 1, 1);
  assert.equal(calls, 0);
  await runQueue([{accession:'a'},{accession:'b'}], 2, run, () => {}, () => false, 5, 0);
  assert.equal(calls, 2);
});
