import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Papa from 'papaparse';

export function readManifest(path) {
  const source = readFileSync(path, 'utf8');
  const parsed = Papa.parse(source.replace(/^\uFEFF/, ''), {delimiter: ',', header: true, skipEmptyLines: 'greedy'});
  if (parsed.errors.length) throw new Error(`Invalid CSV: ${parsed.errors.map(e => e.message).join('; ')}`);
  if (!parsed.meta.fields.includes('accession')) throw new Error('CSV requires an accession column.');
  const seen = new Set();
  const projects = parsed.data.map((row, index) => {
    const accession = row.accession.trim().toUpperCase();
    if (!/^PXD\d{6,}$/.test(accession)) throw new Error(`Invalid accession at CSV record ${index + 2}: ${accession}`);
    if (seen.has(accession)) throw new Error(`Duplicate accession: ${accession}`);
    seen.add(accession);
    return {...row, accession};
  });
  return {projects, sha256: createHash('sha256').update(source).digest('hex')};
}

export function atomicWrite(path, data) {
  mkdirSync(dirname(path), {recursive: true});
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, data);
  renameSync(temporary, path);
}

export function saveJson(path, data) {
  atomicWrite(path, JSON.stringify(data, null, 2) + '\n');
}

export function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

export function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function shouldRun(result, output, retryFailed) {
  if (!result || result.status === 'running' || result.status === 'interrupted') return true;
  if (result.status === 'success') {
    const path = result.sdrfPath && resolve(output, result.sdrfPath);
    return !path || !existsSync(path) || sha256(readFileSync(path)) !== result.sdrfSha256;
  }
  return retryFailed;
}

export function summarize(projects, results) {
  const rows = projects.map(project => {
    const result = results.get(project.accession);
    return {
      accession: project.accession, status: result?.status || 'pending',
      stage: result?.stage || '', duration_seconds: result?.durationSeconds ?? '',
      sdrf_path: result?.sdrfPath || '',
      issues: (result?.issues || []).join(' | '),
      warnings: (result?.warnings || []).join(' | '),
      attempt_dir: result?.attemptDir || '', title: project.title || '',
    };
  });
  const counts = {};
  for (const row of rows) counts[row.status] = (counts[row.status] || 0) + 1;
  return {rows, counts};
}

export function writeSummary(output, projects, results) {
  const {rows, counts} = summarize(projects, results);
  const failures = rows.filter(row => !['pending', 'running', 'success'].includes(row.status));
  const csv = data => Papa.unparse({fields: Object.keys(rows[0] || {accession: '', status: ''}), data}, {escapeFormulae: true}) + '\n';
  atomicWrite(resolve(output, 'summary.csv'), csv(rows));
  atomicWrite(resolve(output, 'failures.csv'), csv(failures));
  saveJson(resolve(output, 'summary.json'), {updatedAt: new Date().toISOString(), total: projects.length, counts, projects: rows});
  return counts;
}

/** The queue never lets an individual project's failure stop subsequent projects. */
export async function runQueue(items, concurrency, run, onResult, stopped = () => false, targetSuccess = Infinity, initialSuccess = 0) {
  let cursor = 0;
  let successes = initialSuccess;
  let active = 0;
  async function worker() {
    while (!stopped() && cursor < items.length) {
      if (successes >= targetSuccess) return;
      // Reserve at most the remaining successful slots. Near the goal, wait
      // for in-flight attempts before launching replacements for failures.
      if (successes + active >= targetSuccess) {
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }
      const item = items[cursor++];
      active++;
      let result;
      try { result = await run(item); }
      catch (error) { result = {accession: item.accession, status: 'error', issues: [String(error.message || error)]}; }
      await onResult(item, result);
      if (result.status === 'success') successes++;
      active--;
    }
  }
  await Promise.all(Array.from({length: concurrency}, worker));
}
