import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
// Optional smoke test: install Playwright in your test environment (not the app).
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
let baseUrl = process.env.SDRF_TEST_URL?.replace(/\/$/, '');
const screenshotDir = process.env.SDRF_SCREENSHOT_DIR || '/tmp';

const browser = await chromium.launch({headless:true, executablePath:process.env.PLAYWRIGHT_EXECUTABLE_PATH, args:['--no-sandbox']});
let server;
if (!baseUrl) {
  const root = resolve(process.env.SDRF_BUILD_DIR || '/tmp/sdrfedit-auto-build/browser');
  server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!file.startsWith(root + sep)) throw new Error('Invalid asset path');
      const content = await readFile(file);
      const types = {'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png'};
      response.writeHead(200, {'Content-Type':types[extname(file)] || 'application/octet-stream'});
      response.end(content);
    } catch {
      response.writeHead(404);
      response.end('Build asset not found');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}
async function waitFor(predicate) {
  const deadline = Date.now() + 20000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the mock request');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const errors = [];
const requests = [];
let scenario = 'manual';
let releaseRequest;
let releaseValidation;
const context = await browser.newContext({ viewport: {width: 1500, height: 1000} });
const page = await context.newPage();
page.on('pageerror', error => errors.push(String(error)));
const action = (step, op, args) => ({step, op, args, label:op, reasoning:'Browser test evidence', confidence:'high', citations:[]});
function actions(step) {
  switch(step) {
    case 'setup': return [action(step,'setTechnologyTemplate',['ms-proteomics']), action(step,'setSampleTemplate',['human']), action(step,'setSampleCount',[1]), action(step,'setExperimentDescription',['One human sample measured by label-free DDA.'])];
    case 'characteristics': return [
      action(step,'addCharacteristicChoice',['characteristics[organism]','Homo sapiens',{id:'NCBITaxon:9606',label:'Homo sapiens',ontology:'ncbitaxon'}]),
      action(step,'addCharacteristicChoice',['characteristics[disease]','normal',{id:'PATO:0000461',label:'normal',ontology:'pato'}]),
      action(step,'addCharacteristicChoice',['characteristics[organism part]','liver',{id:'UBERON:0002107',label:'liver',ontology:'uberon'}]),
      action(step,'setNoStudyFactors',['Single-sample characterization without comparisons.'])];
    case 'samples': return [action(step,'setSourceNames',[['sample_1']]), action(step,'setBiologicalReplicates',[[1]])];
    case 'runs-files': return [
      action(step,'applyRunsFilesPlan',[{groups:[{name:'run_1',labelConfigId:'lf',channels:[{label:'label free sample',sourceName:'sample_1'}],files:[{fileName:'sample_1.raw',fractionId:1,technicalReplicate:1}]}]}]),
      action(step,'replaceWithUnassignedFileNames',[['sample_1.raw']]),
      action(step,'setLabelConfig',['lf']), action(step,'setAcquisitionMethod',['DDA'])];
    case 'protocol': return [action(step,'setInstrument',[{id:'MS:1001911',label:'Q Exactive',ontology:'ms'}]), action(step,'setCleavageAgent',[{name:'Trypsin',msAccession:'MS:1001251'}])];
    default: return [];
  }
}
await page.route('**/*', async route => {
  const url = route.request().url();
  if (url.endsWith('/api/health')) return route.fulfill({json:{status:'ok',llmConfigured:true,embeddingsConfigured:false,mineruConfigured:false,specIndexReady:true,specChunkCount:20,retrieval:'lexical'}});
  if (url.includes('sdrf-validator')) {
    if (url.includes('/validate') && scenario === 'validation-fail') return route.fulfill({status:503,body:'Validator unavailable in test'});
    if (url.includes('/validate') && scenario === 'validation-stop') await new Promise(resolve => { releaseValidation = resolve; });
    if (url.includes('/validate')) return route.fulfill({json:{valid:true,errors:[],warnings:[],error_count:0,warning_count:0,templates_used:['human','ms-proteomics'],sdrf_pipelines_version:'test'}});
    if (url.endsWith('/templates')) return route.fulfill({json:{templates:[{name:'human',description:'Human'},{name:'ms-proteomics',description:'MS'}],legacy_mappings:{}}});
    return route.fulfill({json:{status:'healthy',sdrf_pipelines_version:'test',ontology_validation_available:false}});
  }
  if (url.endsWith('/api/chat')) {
    const request = route.request().postDataJSON();
    requests.push(request);
    if (scenario === 'stop') await new Promise(resolve => { releaseRequest = resolve; });
    const batch = request.executionMode === 'auto' ? actions(request.focusStep) : [action('setup','setSampleCount',[3])];
    const result = {content:'Evidence checked.',actions:batch,citations:[],toolCalls:[],nextStep:null,
      automation:request.executionMode === 'auto' ? {status:scenario === 'blocked' ? 'blocked' : 'ready',issues:scenario === 'blocked' ? ['Sample mapping is ambiguous'] : []} : null};
    const frames = [{type:'actions',actions:batch},{type:'done',result}];
    return route.fulfill({contentType:'text/event-stream',body:frames.map(e=>`data: ${JSON.stringify(e)}\n\n`).join('')}).catch(()=>{});
  }
  if (!url.startsWith(baseUrl)) return route.fulfill({status:503,body:'External network mocked by browser test'});
  return route.continue();
});

const state = () => page.evaluate(() => {
  const sessions = JSON.parse(localStorage.getItem('sdrf_assistant_chats_v1') || '[]');
  return sessions.sort((a,b)=>b.updatedAt-a.updatedAt)[0];
});
try {
  await page.goto(baseUrl);
  await page.getByRole('button', {name:/Create New SDRF/}).click();
  await page.getByRole('button', {name:'Auto annotate', exact:true}).waitFor();
  await page.locator('wizard-ai-panel textarea').fill('Suggest a sample count.');
  await page.getByRole('button', {name:'Send', exact:true}).click();
  await page.getByRole('button', {name:'Apply',exact:true}).waitFor();
  assert.equal(requests[0].executionMode, undefined);
  const beforeManual = (await state()).wizardState;
  assert.notEqual(beforeManual.sampleCount, 3);
  assert.equal(Object.values((await state()).cards)[0].status, 'pending');
  await page.getByRole('button', {name:'Apply',exact:true}).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('sdrf_assistant_chats_v1'))[0].wizardState.sampleCount === 3);
  console.log('PASS manual suggestions remain pending until Apply');

  const beforeAuto = structuredClone((await state()).wizardState);
  scenario = 'auto';
  await page.locator('wizard-ai-panel textarea').fill('Annotate one human liver sample measured by label-free DDA.');
  await page.getByRole('button',{name:'Auto annotate',exact:true}).click();
  await page.getByRole('button',{name:'Download SDRF',exact:true}).waitFor({timeout:20000});
  assert.deepEqual(requests.filter(r=>r.executionMode==='auto').map(r=>r.focusStep), ['setup','characteristics','samples','runs-files','protocol']);
  const session = await state();
  assert.equal(session.currentStep, 5);
  assert.equal(session.wizardState.dataFiles[0].fileName, 'sample_1.raw');
  assert.ok(Object.values(session.cards).filter(c=>c.automationRunId).every(c=>c.status==='applied' && c.autoApplied));
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button',{name:'Download SDRF',exact:true}).click();
  const download = await downloadEvent;
  assert.equal(download.suggestedFilename(),'auto-annotated.sdrf.tsv');
  console.log('PASS full automatic run, reversed file dependencies, recorded cards, validation and download');
  await page.getByRole('button',{name:'Undo auto annotation',exact:true}).click();
  const undone = await state();
  assert.deepEqual(undone.wizardState,beforeAuto);
  assert.ok(Object.values(undone.cards).filter(c=>c.automationRunId).every(c=>c.status==='dismissed'));
  console.log('PASS Undo restores the original wizard and dismisses automatic cards');

  scenario = 'stop';
  await page.locator('wizard-ai-panel textarea').fill('Annotate this experiment.');
  await page.getByRole('button',{name:'Auto annotate',exact:true}).click();
  await page.getByRole('button',{name:'Stop auto annotation',exact:true}).waitFor();
  await waitFor(() => !!releaseRequest);
  assert.equal(await page.locator('.wizard-content').getAttribute('inert'), '');
  await page.getByRole('button',{name:'Stop auto annotation',exact:true}).click();
  releaseRequest();
  await page.getByRole('button',{name:'Auto annotate',exact:true}).waitFor();
  assert.deepEqual((await state()).wizardState,beforeAuto);
  assert.equal(await page.locator('.wizard-content').getAttribute('inert'), null);
  console.log('PASS Stop ignores a late response and restores manual editing');
  scenario = 'blocked';
  await page.getByRole('button',{name:'Auto annotate',exact:true}).click();
  await page.locator('.auto-annotation').getByText('Sample mapping is ambiguous',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Auto annotate',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Download SDRF',exact:true}).count(),0);
  console.log('PASS insufficient evidence stays blocked despite valid setup defaults');
  await page.getByRole('button',{name:'Undo auto annotation',exact:true}).click();

  scenario = 'validation-fail';
  await page.getByRole('button',{name:'Auto annotate',exact:true}).click();
  await page.getByRole('button',{name:'Download draft',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Download SDRF',exact:true}).count(),0);
  console.log('PASS unavailable validator produces a draft, never a success');
  await page.getByRole('button',{name:'Undo auto annotation',exact:true}).click();

  scenario = 'validation-stop';
  await page.getByRole('button',{name:'Auto annotate',exact:true}).click();
  await waitFor(() => !!releaseValidation);
  await page.getByRole('button',{name:'Stop auto annotation',exact:true}).click();
  await page.getByRole('button',{name:'Auto annotate',exact:true}).waitFor({timeout:2000});
  releaseValidation();
  assert.equal(await page.getByRole('button',{name:'Download SDRF',exact:true}).count(),0);
  console.log('PASS Stop during final validation releases the UI immediately');

  const countBeforeReload = requests.length;
  await page.reload();
  await page.getByRole('button', {name:/Create New SDRF/}).click();
  await page.getByRole('button',{name:'Auto annotate',exact:true}).waitFor();
  assert.equal(requests.length,countBeforeReload);
  console.log('PASS reloading never starts or resumes automation');
  assert.deepEqual(errors, []);
  await page.screenshot({path:`${screenshotDir}/sdrf-auto-browser.png`,fullPage:true});
} catch (error) {
  console.error('REQUESTS',requests.map(r=>({mode:r.executionMode,step:r.focusStep})));
  console.error('PAGE',await page.locator('body').innerText());
  console.error('ERRORS',errors);
  await page.screenshot({path:`${screenshotDir}/sdrf-auto-browser-failed.png`,fullPage:true});
  throw error;
} finally {
  await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
}
