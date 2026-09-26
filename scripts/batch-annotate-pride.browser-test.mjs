/** Isolated fixture test for batch bookkeeping/downloads; never uses a real LLM. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<wizard-experiment-setup><div class="catalog-status">Official SDRF templates</div></wizard-experiment-setup>
<button id="new">Create New SDRF</button>
<wizard-ai-panel hidden>
<button id="entry">Auto annotate a PXD dataset</button>
<input id="auto-pxd-id"><button id="start">Confirm and start</button>
<div class="auto-annotation">Auto annotation · idle<p role="status">Idle</p></div>
<button id="trace" title="Download agent trace (JSON)">Trace</button>
<button id="download" hidden>Download SDRF</button>
</wizard-ai-panel>
<script>
let accession, status;
const byId = id => document.getElementById(id);
byId('new').onclick = () => document.querySelector('wizard-ai-panel').hidden = false;
byId('start').onclick = () => {
  accession = byId('auto-pxd-id').value;
  status = accession.endsWith('2') ? 'blocked' : 'complete';
  const progress = status === 'complete' ? 'SDRF generated and template validation passed.' : 'Missing sample mapping';
  document.querySelector('.auto-annotation').innerHTML = 'Auto annotation · ' + status + '<p role="status">' + progress + '</p>';
  localStorage.setItem('sdrf_assistant_chats_v1', JSON.stringify([{updatedAt:Date.now(),currentStep:4,wizardState:{projectAccession:accession}}]));
  byId('download').hidden = status !== 'complete';
};
function download(name, content) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content])); a.download = name; a.click();
}
byId('trace').onclick = () => download('trace.json', JSON.stringify({automation:{status,issues:status === 'blocked' ? ['Missing sample mapping'] : [],warnings:[]}}));
byId('download').onclick = () => download(accession + '.sdrf.tsv', 'source name\\tcomment[data file]\\ns1\\tfile.raw\\n');
</script></body></html>`;

test('real browser runner saves success, records blockage, continues and resumes', {skip: !process.env.PLAYWRIGHT_MODULE, timeout: 90_000}, async t => {
  const directory = mkdtempSync(resolve(tmpdir(), 'sdrf-batch-browser-'));
  t.after(() => rmSync(directory, {recursive:true, force:true}));
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url === '/api/health' ? 'application/json' : 'text/html');
    response.end(request.url === '/api/health' ? JSON.stringify({llmConfigured:true}) : html);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const input = resolve(directory, 'input.csv');
  const output = resolve(directory, 'output');
  writeFileSync(input, 'accession\nPXD900001\nPXD900002\nPXD900003\n');
  const run = extra => new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, ['scripts/batch-annotate-pride.mjs', '--input', input, '--output', output,
      '--base-url', url, '--backend-url', url, '--concurrency', '2', ...extra], {env: process.env});
    let log = '';
    child.stdout.on('data', data => { log += data; });
    child.stderr.on('data', data => { log += data; });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolveRun(log) : reject(new Error(log)));
  });
  await run([]);
  let summary = JSON.parse(readFileSync(resolve(output, 'summary.json')));
  assert.deepEqual(summary.counts, {success:2, blocked:1});
  assert.match(readFileSync(resolve(output, 'successful/PXD900001.sdrf.tsv'), 'utf8'), /s1\tfile.raw/);
  assert.match(readFileSync(resolve(output, 'failures.csv'), 'utf8'), /PXD900002,blocked/);
  const priorAttempt = summary.projects[0].attempt_dir;
  assert.match(await run([]), /"selected":0/);
  assert.match(await run(['--retry-failed']), /"selected":1/);
  summary = JSON.parse(readFileSync(resolve(output, 'summary.json')));
  assert.equal(summary.projects[0].attempt_dir, priorAttempt);
  assert.deepEqual(summary.counts, {success:2, blocked:1});
});
