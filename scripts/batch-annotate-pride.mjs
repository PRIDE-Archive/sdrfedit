#!/usr/bin/env node
/** Batch driver for the real editor: no mocked requests and no second SDRF generator. */
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve, relative } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { readManifest, atomicWrite, saveJson, readJson, sha256, shouldRun, writeSummary, runQueue } from './pride-batch-lib.mjs';

const {values: args} = parseArgs({options: {
  input: {type: 'string'}, output: {type: 'string'},
  'base-url': {type: 'string', default: 'http://127.0.0.1:4200'},
  'backend-url': {type: 'string', default: 'http://127.0.0.1:8000'},
  concurrency: {type: 'string', default: '2'},
  'project-timeout-minutes': {type: 'string', default: '30'},
  limit: {type: 'string'}, 'retry-failed': {type: 'boolean', default: false},
  'target-success': {type: 'string'},
  'dry-run': {type: 'boolean', default: false}, help: {type: 'boolean', default: false},
}});
if (args.help || !args.input || !args.output) {
  console.log(`Usage: node scripts/batch-annotate-pride.mjs --input projects.csv --output reports/batch
  --concurrency 2                 Independent browser contexts (1–8)
  --project-timeout-minutes 30    Record timeout and continue to next project
  --limit 5                      Process at most 5 pending projects this invocation
  --target-success 50            Stop after 50 verified successful outputs, including previous successes
  --retry-failed                 Retry unsuccessful projects in new attempt directories
  --dry-run                      Inspect queue without calling the model
  --base-url URL                 Running editor URL (default localhost:4200)
  --backend-url URL              Running assistant URL (default localhost:8000)
Resume: rerun the same command. Completed attempts are skipped; interrupted jobs restart.
Optional env: PLAYWRIGHT_MODULE, PLAYWRIGHT_EXECUTABLE_PATH.`);
  process.exit(args.help ? 0 : 2);
}
function positiveNumber(value, name, max = Infinity) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`${name} must be an integer between 1 and ${max}.`);
  return n;
}
const concurrency = positiveNumber(args.concurrency, 'concurrency', 8);
const timeoutMs = positiveNumber(args['project-timeout-minutes'], 'project-timeout-minutes') * 60_000;
const limit = args.limit ? positiveNumber(args.limit, 'limit') : Infinity;
const targetSuccess = args['target-success'] ? positiveNumber(args['target-success'], 'target-success') : Infinity;
const output = resolve(args.output);
const input = resolve(args.input);
const {projects, sha256: manifestSha} = readManifest(input);
if (!projects.length) throw new Error('CSV contains no projects.');
const previousManifest = readJson(resolve(output, 'manifest.json'));
if (previousManifest && previousManifest.sha256 !== manifestSha) throw new Error('Output directory belongs to a different CSV. Use a new output directory.');
const results = new Map(projects.map(p => [p.accession, readJson(resolve(output, 'projects', p.accession, 'result.json'))]).filter(([,r]) => r));
const queue = projects.filter(p => shouldRun(results.get(p.accession), output, args['retry-failed'])).slice(0, limit);
const initialSuccess = projects.filter(p => results.get(p.accession)?.status === 'success' && !shouldRun(results.get(p.accession), output, false)).length;
console.log(JSON.stringify({event: 'queue', total: projects.length, selected: queue.length, concurrency, output, targetSuccess: Number.isFinite(targetSuccess) ? targetSuccess : null, initialSuccess}));
if (args['dry-run']) process.exit(0);
mkdirSync(output, {recursive: true});
const lockPath = resolve(output, 'batch.lock');
const previousLock = readJson(lockPath);
if (previousLock) {
  let alive = previousLock.host !== hostname();
  if (!alive) {
    try { process.kill(previousLock.pid, 0); alive = true; } catch (e) { if (e.code !== 'ESRCH') alive = true; }
  }
  if (alive) throw new Error(`Batch already locked by ${previousLock.host} PID ${previousLock.pid}.`);
  unlinkSync(lockPath);
}
writeFileSync(lockPath, JSON.stringify({pid: process.pid, host: hostname()}), {flag: 'wx'});
let browser;
let stopping = false;
const activePages = new Set();
function log(event) {
  const line = JSON.stringify({at: new Date().toISOString(), ...event});
  appendFileSync(resolve(output, 'events.jsonl'), line + '\n');
  console.log(line);
}
async function stop() {
  if (stopping) return;
  stopping = true;
  log({event: 'stopping', reason: 'Signal received; saving active project checkpoints.'});
  for (const page of activePages) {
    page.getByRole('button', {name: 'Stop auto annotation', exact: true}).click({timeout: 3000}).catch(() => {});
  }
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

async function snapshot(page, directory) {
  const storage = await page.context().storageState();
  saveJson(resolve(directory, 'browser-state.json'), storage);
  const entries = storage.origins.flatMap(origin => origin.localStorage);
  const raw = entries.find(e => e.name === 'sdrf_assistant_chats_v1')?.value;
  const sessions = raw ? JSON.parse(raw) : [];
  saveJson(resolve(directory, 'sessions.json'), sessions);
  const session = sessions.sort((a,b) => b.updatedAt - a.updatedAt)[0];
  if (session?.wizardState) saveJson(resolve(directory, 'wizard-state.json'), session.wizardState);
  return session;
}

async function download(page, button, path) {
  const pending = page.waitForEvent('download', {timeout: 20_000});
  await button.click();
  const file = await pending;
  await file.saveAs(path);
  if (await file.failure()) throw new Error(await file.failure());
}

async function annotate(project) {
  const started = Date.now();
  const attempt = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = resolve(output, 'projects', project.accession, 'attempts', attempt);
  mkdirSync(directory, {recursive: true});
  saveJson(resolve(directory, 'input.json'), project);
  const result = {accession: project.accession, status: 'running', stage: 'initializing',
    startedAt: new Date(started).toISOString(), attemptDir: relative(output, directory),
    issues: [], warnings: [], validationScope: 'Editor pinned-template preflight; not full ontology or scientific review'};
  results.set(project.accession, result);
  saveJson(resolve(output, 'projects', project.accession, 'result.json'), result);
  writeSummary(output, projects, results);
  log({event: 'start', accession: project.accession, attemptDir: result.attemptDir});
  let context;
  let page;
  let lastSnapshot = 0;
  const captures = new Set();
  let apiSequence = 0;
  try {
    context = await browser.newContext({acceptDownloads: true, viewport: {width: 1500, height: 1000}});
    await context.addInitScript(backend => {
      localStorage.setItem('sdrf_assistant_url', backend);
      globalThis.__SDRF_ASSISTANT_URL__ = backend;
    }, args['backend-url']);
    page = await context.newPage();
    activePages.add(page);
    page.setDefaultTimeout(30_000);
    page.on('pageerror', error => appendFileSync(resolve(directory, 'browser-errors.log'), String(error) + '\n'));
    page.on('response', response => {
      const url = new URL(response.url());
      if (!['/api/chat', '/api/template-catalog/validate-table'].includes(url.pathname)) return;
      const sequence = ++apiSequence;
      const request = response.request().postDataJSON();
      saveJson(resolve(directory, `api-${sequence}-request.json`), request);
      const task = (async () => {
        try {
          atomicWrite(resolve(directory, `api-${sequence}-response.txt`), await response.text());
        } catch (e) {
          saveJson(resolve(directory, `api-${sequence}-error.json`), {status: response.status(), error: String(e)});
        }
      })();
      captures.add(task);
      task.finally(() => captures.delete(task));
    });
    await page.goto(args['base-url'], {waitUntil: 'domcontentloaded', timeout: 60_000});
    await page.getByRole('button', {name: /Create New SDRF/}).click();
    const panel = page.locator('wizard-ai-panel');
    await panel.waitFor();
    // Opening the wizard refreshes its catalogue asynchronously and mutates state.
    // Starting a model turn before this settles trips the concurrent-edit guard.
    await page.locator('wizard-experiment-setup .catalog-status').waitFor({timeout: 120_000});
    await page.getByText('Checking the official template repository…', {exact: true}).waitFor({state: 'hidden', timeout: 120_000});
    await page.waitForLoadState('networkidle', {timeout: 120_000});
    await panel.getByRole('button', {name: /Auto annotate a PXD dataset/}).click();
    await panel.locator('#auto-pxd-id').fill(project.accession);
    await panel.getByRole('button', {name: 'Confirm and start', exact: true}).click();
    result.stage = 'annotation';
    const region = panel.locator('.auto-annotation');
    while (true) {
      const text = await region.innerText();
      const status = text.match(/Auto annotation\s*·\s*(running|complete|blocked|stopped|waiting)/)?.[1];
      const progress = await region.locator('[role="status"]').textContent().catch(() => '');
      result.stage = progress?.trim() || result.stage;
      if (Date.now() - lastSnapshot >= 30_000) {
        const session = await snapshot(page, directory);
        result.step = session?.currentStep;
        saveJson(resolve(output, 'projects', project.accession, 'result.json'), result);
        writeSummary(output, projects, results);
        log({event: 'progress', accession: project.accession, stage: result.stage});
        lastSnapshot = Date.now();
      }
      if (status && status !== 'running') {
        result.status = status === 'complete' ? 'success' : status === 'stopped' ? 'interrupted' : status;
        break;
      }
      if (stopping || Date.now() - started >= timeoutMs) {
        result.status = stopping ? 'interrupted' : 'timeout';
        result.issues.push(stopping ? 'Batch interrupted by signal.' : `Project exceeded ${args['project-timeout-minutes']} minutes.`);
        await panel.getByRole('button', {name: 'Stop auto annotation', exact: true}).click({timeout: 5000}).catch(() => {});
        await delay(1000);
        break;
      }
      await delay(2000);
    }
    const tracePath = resolve(directory, 'trace.json');
    await download(page, panel.locator('button[title="Download agent trace (JSON)"]'), tracePath);
    const trace = readJson(tracePath);
    result.issues.push(...(trace.automation?.issues || []));
    result.warnings.push(...(trace.automation?.warnings || []));
    result.notes = trace.automation?.notes || [];
    const session = await snapshot(page, directory);
    result.step = session?.currentStep;
    if (result.status === 'success') {
      if (trace.automation?.status !== 'complete' || result.issues.length) throw new Error('Completion state and trace disagree.');
      if (session?.wizardState?.projectAccession !== project.accession) throw new Error('Output project accession does not match input.');
      const destination = resolve(directory, `${project.accession}.sdrf.tsv`);
      await download(page, panel.getByRole('button', {name: 'Download SDRF', exact: true}), destination);
      const tsv = readFileSync(destination);
      if (!tsv.length || !tsv.toString().includes('source name\t')) throw new Error('Downloaded SDRF is empty or missing its header.');
      result.sdrfSha256 = sha256(tsv);
      result.sdrfPath = `successful/${project.accession}.sdrf.tsv`;
      atomicWrite(resolve(output, result.sdrfPath), tsv);
    } else {
      const draft = panel.getByRole('button', {name: 'Download draft', exact: true});
      if (await draft.count() && await draft.isEnabled()) {
        await download(page, draft, resolve(directory, `${project.accession}.draft.sdrf.tsv`));
      }
      if (!result.issues.length) result.issues.push(result.stage || 'Annotation requires manual input. See trace.json.');
    }
  } catch (error) {
    result.status = stopping ? 'interrupted' : 'error';
    result.issues.push(String(error.message || error));
  } finally {
    if (page) {
      await snapshot(page, directory).catch(error => {result.warnings.push(`Checkpoint: ${error.message}`);});
      if (result.status !== 'success') {
        await page.screenshot({path: resolve(directory, 'failure.png'), fullPage: true, timeout: 10_000}).catch(() => {});
        atomicWrite(resolve(directory, 'page.txt'), await page.locator('body').innerText({timeout: 5000}).catch(() => 'Page unavailable'));
      }
      activePages.delete(page);
    }
    await context?.close().catch(() => {});
    await Promise.allSettled([...captures]);
  }
  result.finishedAt = new Date().toISOString();
  result.durationSeconds = Math.round((Date.now() - started) / 1000);
  saveJson(resolve(directory, 'result.json'), result);
  return result;
}

try {
  mkdirSync(resolve(output, 'successful'), {recursive: true});
  saveJson(resolve(output, 'manifest.json'), {input, sha256: manifestSha, total: projects.length, projects});
  saveJson(resolve(output, 'goal.json'), {targetSuccess: Number.isFinite(targetSuccess) ? targetSuccess : null, initialSuccess, countIncludesFailures: false});
  writeSummary(output, projects, results);
  const healthResponse = await fetch(`${args['backend-url']}/api/health`, {signal: AbortSignal.timeout(15_000)});
  if (!healthResponse.ok) throw new Error(`Backend health HTTP ${healthResponse.status}`);
  const health = await healthResponse.json();
  if (!health.llmConfigured) throw new Error('Backend has no LLM configured.');
  saveJson(resolve(output, 'health.json'), health);
  const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
  browser = await chromium.launch({headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH});
  log({event: 'batch_start', pid: process.pid, selected: queue.length, concurrency});
  await runQueue(queue, concurrency, annotate, async (project, result) => {
    results.set(project.accession, result);
    saveJson(resolve(output, 'projects', project.accession, 'result.json'), result);
    const counts = writeSummary(output, projects, results);
    log({event: 'finished', accession: project.accession, status: result.status, stage: result.stage, counts});
  }, () => stopping, targetSuccess, initialSuccess);
  const counts = writeSummary(output, projects, results);
  const verifiedSuccess = projects.filter(p => results.get(p.accession)?.status === 'success' && !shouldRun(results.get(p.accession), output, false)).length;
  log({event: 'batch_finished', counts, interrupted: stopping,
    targetSuccess: Number.isFinite(targetSuccess) ? targetSuccess : null,
    goalReached: Number.isFinite(targetSuccess) ? verifiedSuccess >= targetSuccess : null});
  process.exitCode = stopping ? 130 : 0;
} finally {
  await browser?.close();
  unlinkSync(lockPath);
}
