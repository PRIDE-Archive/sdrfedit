#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const {values} = parseArgs({options: {
  output: {type: 'string', default: resolve(root, 'reports/pride-raw-eq5-annotation')},
  watch: {type: 'boolean', default: false},
}});
const output = resolve(values.output);
const names = {success:'成功', blocked:'阻塞', waiting:'等待补充资料', error:'报错', timeout:'超时', interrupted:'中断', running:'运行中', pending:'未开始'};

function show() {
  const summary = JSON.parse(readFileSync(resolve(output, 'summary.json'), 'utf8'));
  const counts = summary.counts;
  const finished = summary.total - (counts.pending || 0) - (counts.running || 0);
  const lockPath = resolve(output, 'batch.lock');
  let processStatus = '没有活动进程锁';
  if (existsSync(lockPath)) {
    const {pid} = JSON.parse(readFileSync(lockPath, 'utf8'));
    try { process.kill(pid, 0); processStatus = `运行中（PID ${pid}）`; }
    catch (error) { processStatus = error.code === 'ESRCH' ? `已退出（旧 PID ${pid}）` : `无法确认（PID ${pid}，${error.code}）`; }
  }
  if (values.watch && process.stdout.isTTY) process.stdout.write('\x1b[2J\x1b[H');
  console.log(`PRIDE 批量注释进度    ${new Date().toLocaleString()}`);
  console.log(`进程：${processStatus}`);
  console.log(`已结束尝试：${finished}/${summary.total}（${(100 * finished / summary.total).toFixed(1)}%，包含失败）`);
  console.log(Object.entries(names).map(([key, name]) => `${name} ${counts[key] || 0}`).join('  |  '));
  const goalPath = resolve(output, 'goal.json');
  if (existsSync(goalPath)) {
    const goal = JSON.parse(readFileSync(goalPath, 'utf8'));
    if (goal.targetSuccess) console.log(`成功目标：${counts.success || 0}/${goal.targetSuccess}（失败不计入目标）`);
  }
  console.log(`进度更新时间：${summary.updatedAt}（${Math.max(0, Math.round((Date.now() - Date.parse(summary.updatedAt)) / 1000))} 秒前）`);
  console.log('\n当前项目：');
  const active = summary.projects.filter(p => p.status === 'running');
  for (const project of active) console.log(`  ${project.accession}  ${project.stage}`);
  if (!active.length) console.log('  无');
  console.log('\n最近需要处理的项目：');
  const failures = summary.projects.filter(p => !['success','running','pending'].includes(p.status))
    .sort((a,b) => (b.attempt_dir || '').split('/').at(-1).localeCompare((a.attempt_dir || '').split('/').at(-1))).slice(0, 5);
  for (const project of failures) console.log(`  ${project.accession} [${names[project.status] || project.status}] ${project.issues}`);
  if (!failures.length) console.log('  无');
  console.log(`\n结果目录：${output}`);
  if (values.watch) console.log('每 10 秒刷新；Ctrl+C 只关闭此监控，不会停止批量注释。');
}

do {
  try { show(); }
  catch (error) { console.error(`读取进度失败：${error.message}`); if (!values.watch) process.exitCode = 1; }
  if (values.watch) await delay(10_000);
} while (values.watch);
