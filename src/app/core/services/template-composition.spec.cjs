const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve, dirname } = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

// Exercise the real service/generator without a browser. Only Angular DI/signals are stubbed.
const root = resolve(__dirname, '../../../..');
const cache = new Map();
let templateService;
let wizardService;
function signal(value) {
  const read = () => value;
  read.set = next => { value = next; };
  read.update = update => { value = update(value); };
  read.asReadonly = () => read;
  return read;
}
function load(file) {
  file = resolve(root, file);
  if (cache.has(file)) return cache.get(file);
  const exports = {};
  cache.set(file, exports);
  const requireModule = id => {
    if (id === '@angular/core') return {
      Injectable: () => target => target, signal, computed: fn => fn, inject: token => token.name === 'WizardStateService' ? wizardService : templateService,
    };
    if (id.startsWith('.')) return load(resolve(dirname(file), `${id}.ts`));
    return require(id);
  };
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
  }).outputText;
  vm.runInNewContext(compiled, { exports, require: requireModule, console, Map, Set, Date, Error, structuredClone, crypto: globalThis.crypto });
  return exports;
}
const { TemplateService } = load('src/app/core/services/template.service.ts');
const { WizardGeneratorService } = load('src/app/core/services/wizard-generator.service.ts');
const { createEmptyWizardState } = load('src/app/core/models/wizard.ts');
const snapshotId = 'a'.repeat(40) + ':1';
const snapshot = { snapshotId, commitSha: 'a'.repeat(40), fetchedAt: '2026-09-24', templates: [
  { name: 'new-platform', version: '2.0.0', layer: 'technology', columns: [], usable_alone: true },
  { name: 'new-sample', version: '1.0.0', layer: 'sample', columns: [] },
] };
function setup() {
  templateService = new TemplateService();
  templateService.install(snapshot);
  return templateService;
}

test('catalogue discovery uses new names/layers and concurrent resolver calls share one snapshot request', async () => {
  const service = setup();
  const calls = [];
  service.request = async (path, payload) => {
    calls.push([path, payload]);
    return { snapshotId, valid: true, errors: [], warnings: [], columns: [], leafTemplates: payload.selectedTemplates,
      resolvedTemplates: payload.selectedTemplates, issues: [], availability: {} };
  };
  assert.equal(service.getTemplateInfoList().length, 2);
  assert.equal(service.getTemplateInfo('new-platform').layer, 'technology');
  const refs = [{ name: 'new-platform', version: '2.0.0' }];
  await Promise.all([service.resolveSelection(refs), service.resolveSelection(refs)]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].snapshotId, snapshotId);
  assert.equal(calls[0][1].selectedTemplates[0].version, '2.0.0');
});

test('every forced page entry revalidates; other steps keep their snapshot', async () => {
  const service = setup(); let count = 0;
  service.request = async () => { count++; return snapshot; };
  await service.fetchTemplates();
  assert.equal(count, 0);
  await service.fetchTemplates(true);
  await service.fetchTemplates(true);
  assert.equal(count, 2);
});

test('failed sync retains complete cache and marks it stale, without handmade templates', async () => {
  const service = setup();
  service.request = async () => { throw new Error('offline'); };
  await service.fetchTemplates(true);
  assert.equal(service.catalog().stale, true);
  assert.equal(service.catalog().snapshotId, snapshotId);
  assert.equal(service.allTemplates().length, 2);
});

test('export uses exact resolved columns, generic fields and pinned leaf versions, not MS defaults', () => {
  setup();
  const state = { ...createEmptyWizardState(), templateSnapshotId: snapshotId,
    leafTemplateRefs: [{ name: 'new-platform', version: '2.0.0' }],
    effectiveColumns: [
      { name: 'source name', requirement: 'required' },
      { name: 'characteristics[future property]', requirement: 'required', default: 'default from YAML' },
      { name: 'assay name', requirement: 'required' },
      { name: 'technology type', requirement: 'required', validators: [{ validatorName: 'values', params: { values: ['novel technology'] } }] },
      { name: 'comment[future platform]', requirement: 'required' },
      { name: 'comment[sdrf template]', requirement: 'optional', cardinality: 'multiple' },
    ], dynamicTemplateValues: { 'comment[future platform]': 'platform X' } };
  const table = new WizardGeneratorService().generate(state);
  assert.equal(table.columns.find(c => c.name === 'technology type').value, 'novel technology');
  assert.equal(table.columns.find(c => c.name === 'comment[future platform]').value, 'platform X');
  assert.equal(table.columns.find(c => c.name === 'characteristics[future property]').value, 'default from YAML');
  assert.equal(table.columns.find(c => c.name === 'comment[sdrf template]').value, 'new-platform v2.0.0');
  assert(!table.columns.some(c => c.name === 'comment[cleavage agent details]'));
  assert(!table.columns.some(c => c.name === 'comment[instrument]'));
  assert.equal(table.metadata.templateSnapshotId, snapshotId);
  assert.equal(table.columns[0].name, 'source name');
  assert.equal(table.columns[1].name, 'characteristics[future property]');
});

test('cannot export unresolved snapshot state', () => {
  setup();
  assert.throws(() => new WizardGeneratorService().generate({ ...createEmptyWizardState(), templateSnapshotId: snapshotId }), /Resolve/);
});

const { WizardStateService } = load('src/app/core/services/wizard-state.service.ts');
test('new wizard starts with no template selection; conflicts cannot replace existing selections', () => {
  const service = setup();
  const wizard = new WizardStateService();
  assert.equal(wizard.getState().selectedTemplates.length, 0);
  assert.equal(wizard.getState().technologyTemplate, null);
  assert.equal(wizard.getState().sampleTemplate, null);
  const next = [{ name: 'new-platform', version: '2.0.0' }, { name: 'new-sample', version: '1.0.0' }];
  service.cachedResolution = () => ({ availability: { 'new-platform': { status: 'available' } } });
  wizard.toggleTemplate('new-platform');
  assert.equal(wizard.getState().selectedTemplates.length, 1);
  assert.equal(wizard.getState().technologyTemplate, 'new-platform');
  service.cachedResolution = () => ({ availability: { 'new-sample': { status: 'conflicting', conflictsWith: [next[0]] } } });
  wizard.toggleTemplate('new-sample');
  assert.equal(wizard.getState().selectedTemplates.length, 1);
  assert.equal(wizard.getState().sampleTemplate, null);
  wizard.toggleTemplate('new-platform');
  assert.equal(wizard.getState().selectedTemplates.length, 0);
  assert.equal(wizard.getState().technologyTemplate, null);
  wizard.reset();
  assert.equal(wizard.getState().selectedTemplates.length, 0);
});

const { buildTemplateHierarchy, templateDisplaySections } = load('src/app/core/utils/template-hierarchy.ts');
function hierarchyFixture() {
  const info = (id, layer, parent = null, version = '1.0.0') => ({
    id, name: id, layer, extends: parent, version, status: version.includes('-') ? 'development' : 'stable',
    description: '', usableAlone: true,
  });
  return [info('internal', null), info('new-tech', 'technology', 'internal@>=1.0.0'),
    info('new-sample', 'sample', 'internal'), info('child-sample', 'sample', 'new-sample@>=1.0.0'),
    info('deep-sample', 'sample', 'child-sample'), info('new-experiment', 'experiment', 'new-tech'),
    info('general-experiment', 'experiment', 'internal'),
    info('future-tech', 'technology', 'internal', '2.0.0-dev'),
    info('future-child', 'experiment', 'future-tech', '2.0.0-dev')];
}

test('hierarchy starts technology-first with only selectable roots; no ID allow-list', () => {
  const hierarchy = buildTemplateHierarchy(hierarchyFixture(), [], false);
  assert.equal(hierarchy.groups.map(g => g.layer).join(','), 'technology,sample,experiment');
  assert.equal(hierarchy.groups.flatMap(g => g.branches.flatMap(b => b.templates.map(t => t.id))).join(','),
    'new-tech,new-sample,general-experiment');
  assert.equal(hierarchy.childCounts.get('new-sample'), 1);
});

test('each selection reveals only its direct children and preserves real layers', () => {
  const tree = buildTemplateHierarchy(hierarchyFixture(), ['new-sample', 'new-tech'], false);
  const sample = tree.groups.find(g => g.layer === 'sample');
  assert.equal(sample.branches.length, 2);
  assert.equal(sample.branches[1].templates[0].id, 'child-sample');
  assert(!sample.branches.flatMap(b => b.templates).some(t => t.id === 'deep-sample'));
  const technology = tree.groups.find(g => g.layer === 'technology');
  assert.equal(technology.branches.length, 1);
  const experiments = tree.groups.find(g => g.layer === 'experiment');
  assert.equal(experiments.branches[1].templates[0].layer, 'experiment');
  assert.equal(experiments.branches[1].parent.id, 'new-tech');
  for (const group of tree.groups) assert(group.branches.every(b => b.templates.every(t => t.layer === group.layer)));
});

test('selected descendants reopen ancestry without requiring redundant parent selections', () => {
  const tree = buildTemplateHierarchy(hierarchyFixture(), ['deep-sample'], false);
  const branches = tree.groups.find(g => g.layer === 'sample').branches;
  assert.equal(branches.length, 3);
  assert.equal(branches[2].path.join(' → '), 'new-sample → child-sample');
  assert.equal(branches[2].templates[0].id, 'deep-sample');
  assert.equal(buildTemplateHierarchy(hierarchyFixture(), [], false).groups.find(g => g.layer === 'sample').branches.length, 1);
});

test('prerelease filtering and host whitelist do not strand selected or allowed children', () => {
  const tree = buildTemplateHierarchy(hierarchyFixture(), ['future-child'], false);
  const tech = tree.groups.find(g => g.layer === 'technology');
  assert(tech.roots.some(t => t.id === 'future-tech'));
  assert(tree.groups.find(g => g.layer === 'experiment').branches.some(b => b.templates.some(t => t.id === 'future-child')));
  const limited = buildTemplateHierarchy(hierarchyFixture(), [], false, ['child-sample']);
  assert.equal(limited.groups[0].roots[0].id, 'child-sample');
});


test('sample presentation puts common leaves first and expandable categories last', () => {
  const sample = (id, parent = 'internal') => ({ id, name: id, layer: 'sample', extends: parent, version: '1.0.0', status: 'stable' });
  const tree = buildTemplateHierarchy([sample('clinical'), sample('human'), sample('metagenomics'),
    sample('invertebrates'), sample('plants'), sample('vertebrates'), sample('new-organism'),
    sample('clinical-child', 'clinical'), sample('environment-child', 'metagenomics')], ['clinical'], false);
  assert.equal(tree.groups[0].roots.map(t => t.id).join(','), 'human,vertebrates,plants,invertebrates,new-organism,clinical,metagenomics');
  assert.equal(tree.groups[0].branches[1].parent.id, 'clinical');
});

test('a layer with no general root still appears when cross-layer children are revealed', () => {
  const fixture = hierarchyFixture().filter(t => t.id !== 'general-experiment');
  const tree = buildTemplateHierarchy(fixture, ['new-tech'], false);
  assert.equal(tree.groups.find(g => g.layer === 'experiment').branches[0].templates[0].id, 'new-experiment');
  assert(!buildTemplateHierarchy(fixture, [], false).groups.some(g => g.layer === 'experiment'));
});


test('display combines children from every selected sample parent in one refinement grid', () => {
  const sample = (id, parent = null) => ({ id, name: id, layer: 'sample', extends: parent, version: '1.0.0', status: 'stable' });
  const catalog = [sample('clinical'), sample('community'), sample('oncology', 'clinical'),
    sample('gut', 'community'), sample('soil', 'community'), sample('water', 'community')];
  const group = buildTemplateHierarchy(catalog, ['clinical', 'community'], false).groups[0];
  const sections = templateDisplaySections(group);
  assert.equal(sections.length, 2);
  assert.equal(sections[1].templates.map(t => t.id).join(','), 'oncology,gut,soil,water');
  const inherited = templateDisplaySections(buildTemplateHierarchy(catalog, ['clinical', 'soil'], false).groups[0]);
  assert.equal(inherited[1].templates.map(t => t.id).join(','), 'oncology,gut,soil,water');
});

test('experiment display adds technology children to the same grid as general options', () => {
  const group = buildTemplateHierarchy(hierarchyFixture(), ['new-tech'], false).groups.find(g => g.layer === 'experiment');
  const sections = templateDisplaySections(group);
  assert.equal(sections.length, 1);
  assert.equal(sections[0].templates.map(t => t.id).join(','), 'general-experiment,new-experiment');
  assert.equal(sections[0].refinements, false);
});


const { restoreWizardStep, WIZARD_STEPS, sampleCompletionErrors } = load('src/app/core/models/wizard.ts');

test('merged sample page requires definitions and assignments, then opens Runs & Files', () => {
  setup();
  const wizard = new WizardStateService();
  const state = createEmptyWizardState();
  state.effectiveColumns = [{ name: 'characteristics[disease]', requirement: 'required' }];
  state.characteristicColumns = state.effectiveColumns;
  state.factorDecision = 'none'; state.noFactorReason = 'Descriptive sample inventory';
  wizard.hydrate(state);
  wizard.goToStep(1);
  assert.equal(wizard.canProceed(), false);
  wizard.addCharacteristicChoice('characteristics[disease]', 'normal');
  assert.equal(wizard.samples()[0].characteristicValues['characteristics[disease]'], 'normal');
  assert.equal(wizard.canProceed(), true);
  wizard.addCharacteristicChoice('characteristics[disease]', 'disease');
  assert.equal(wizard.samples()[0].characteristicValues['characteristics[disease]'], 'normal');
  wizard.setSampleCharacteristicValue(0, 'characteristics[disease]', '');
  assert.equal(wizard.canProceed(), false);
  wizard.setSampleCharacteristicValue(0, 'characteristics[disease]', 'disease');
  wizard.nextStep();
  assert.equal(WIZARD_STEPS[wizard.currentStep()].id, 'runs-files');
});

test('editing groups on the same page synchronizes assignments and rejects stale values', () => {
  setup();
  const wizard = new WizardStateService();
  wizard.addFactor({ name: 'treatment', enabled: true, values: ['control'] });
  assert.equal(wizard.samples()[0].factorValues.treatment, 'control');
  wizard.addFactorValue(0, 'treated');
  assert.equal(wizard.samples()[0].factorValues.treatment, 'control');
  wizard.setSampleFactorValue(0, 'treatment', 'treated');
  wizard.removeFactorValue(0, 'treated');
  assert.equal(wizard.samples()[0].factorValues.treatment, 'control');
  wizard.removeFactor(0);
  assert.equal(wizard.samples()[0].factorValues.treatment, undefined);
  const state = createEmptyWizardState();
  state.samples[0].biologicalReplicate = 1.5;
  assert.ok(sampleCompletionErrors(state).some(error => error.includes('positive whole number')));
});

test('old drafts map both sample pages to one page without shifting new drafts', () => {
  assert.deepEqual(Array.from({length: 6}, (_, step) => restoreWizardStep(step)), [0, 1, 1, 2, 3, 4]);
  assert.deepEqual(Array.from({length: 5}, (_, step) => restoreWizardStep(step, 2)), [0, 1, 2, 3, 4]);
  assert.equal(WIZARD_STEPS.length, 5);
});

test('attribute drafts apply atomically and preserve unassigned samples and ontology metadata', () => {
  setup(); const wizard = new WizardStateService(); const state = createEmptyWizardState();
  state.characteristicColumns = [{name: 'characteristics[organism]', requirement: 'required'}];
  state.samples.push({...state.samples[0], index: 2, sourceName: 'sample_2'}); state.sampleCount = 2;
  wizard.hydrate(state);
  const human = {value: 'Homo sapiens', ontologyTerm: {id: 'NCBITaxon:9606', label: 'Homo sapiens'}};
  const mouse = {value: 'Mus musculus'};
  wizard.applyCharacteristicDraft('characteristics[organism]', [human, mouse], 'varies', ['Homo sapiens', '']);
  assert.equal(wizard.samples()[1].characteristicValues['characteristics[organism]'], '');
  assert.equal(wizard.getState().characteristicChoices['characteristics[organism]'][0].ontologyTerm.id, 'NCBITaxon:9606');
  const before = JSON.stringify(wizard.getState());
  assert.throws(() => wizard.applyCharacteristicDraft('characteristics[organism]', [human, mouse], 'varies', ['unknown', '']), /defined options/);
  assert.equal(JSON.stringify(wizard.getState()), before);
  wizard.applyCharacteristicDraft('characteristics[organism]', [mouse], 'shared', []);
  assert.ok(wizard.samples().every(sample => sample.characteristicValues['characteristics[organism]'] === 'Mus musculus'));
});

test('custom factors save assignments atomically, rename cleanly, and preserve other factors', () => {
  setup(); const wizard = new WizardStateService(); const state = createEmptyWizardState();
  state.samples.push({...state.samples[0], index: 2, sourceName: 'sample_2'}); state.sampleCount = 2;
  wizard.hydrate(state);
  wizard.applyCustomFactorDraft(-1, {name: 'treatment', enabled: true, values: ['vehicle', 'drug A']}, ['vehicle', 'drug A']);
  wizard.applyCustomFactorDraft(-1, {name: 'time', enabled: true, values: ['0 hour', '6 hour']}, ['0 hour', '6 hour']);
  assert.equal(wizard.samples()[0].factorValues.treatment, 'vehicle');
  assert.equal(wizard.samples()[0].factorValues.time, '0 hour');
  wizard.applyCustomFactorDraft(0, {name: 'compound', enabled: true, values: ['vehicle', 'drug A']}, ['drug A', 'vehicle']);
  assert.equal(wizard.samples()[0].factorValues.compound, 'drug A');
  assert.equal(wizard.samples()[0].factorValues.treatment, undefined);
  assert.equal(wizard.samples()[0].factorValues.time, '0 hour');
});

test('invalid custom factor drafts leave state unchanged', () => {
  setup(); const wizard = new WizardStateService(); wizard.hydrate(createEmptyWizardState());
  wizard.applyCustomFactorDraft(-1, {name: 'treatment', enabled: true, values: ['vehicle']}, ['vehicle']);
  const before = JSON.stringify(wizard.getState());
  for (const [name, values, assignments] of [
    ['time', ['0 hour'], ['']], ['time', ['0 hour'], ['unknown']],
    ['time', ['0 hour'], []], ['treatment', ['vehicle'], ['vehicle']],
    ['invalid[name]', ['x'], ['x']], ['time', [], ['x']],
  ]) {
    assert.throws(() => wizard.applyCustomFactorDraft(-1, {name, enabled: true, values}, assignments));
    assert.equal(JSON.stringify(wizard.getState()), before);
  }
});

test('run-scoped custom factors preserve run assignments on rename and clear them on sample conversion', () => {
  setup(); const wizard = new WizardStateService(); const state = createEmptyWizardState();
  state.factors = [{name: 'strategy', enabled: true, scope: 'run', values: ['DIA', 'DDA']}];
  state.msRuns = [{id: 'run1', name: 'run1', factorValues: {strategy: 'DIA'}}];
  wizard.hydrate(state);
  wizard.applyCustomFactorDraft(0, {name: 'acquisition', enabled: true, scope: 'run', values: ['DIA', 'DDA']}, []);
  assert.equal(wizard.getState().msRuns[0].factorValues.acquisition, 'DIA');
  assert.equal(wizard.getState().msRuns[0].factorValues.strategy, undefined);
  wizard.applyCustomFactorDraft(0, {name: 'acquisition', enabled: true, scope: 'sample', values: ['DIA', 'DDA']}, ['DIA']);
  assert.equal(wizard.getState().msRuns[0].factorValues.acquisition, undefined);
  assert.equal(wizard.samples()[0].factorValues.acquisition, 'DIA');
});

test('attribute autosave preserves explicit unassigned cells with one candidate across sync and linked factors', () => {
  setup(); const wizard = new WizardStateService(); const state = createEmptyWizardState();
  const column = 'characteristics[organism]';
  state.characteristicColumns = [{name: column, requirement: 'required'}];
  state.samples.push({...state.samples[0], index: 2, sourceName: 'sample_2'}); state.sampleCount = 2;
  wizard.hydrate(state);
  wizard.applyCharacteristicDraft(column, [{value: 'Homo sapiens'}], 'explicit', ['Homo sapiens', '']);
  wizard.syncCharacteristicAssignments();
  assert.equal(wizard.samples()[1].characteristicValues[column], '');
  const { resolveFactorValue, materializeSampleFieldsFromChoices, sampleCompletionErrors } = load('src/app/core/models/wizard.ts');
  const factor = {name: 'organism', enabled: true, values: [], sourceCharacteristic: column};
  assert.equal(resolveFactorValue(wizard.getState(), wizard.samples()[1], factor), '');
  const materialized = materializeSampleFieldsFromChoices(wizard.getState());
  assert.equal(materialized.samples[1].characteristicValues[column], '');
  assert.equal(materialized.samples[1].organism, 'not available');
  assert.ok(sampleCompletionErrors(wizard.getState(), false).length > 0);
  wizard.applyCharacteristicDraft(column, [], 'explicit', ['', '']);
  assert.equal(wizard.getState().characteristicChoices[column].length, 0);
  assert.equal(wizard.samples()[0].characteristicValues[column], '');
});

test('separate label-free mapping expands each file only to its assigned sample and preserves repeats', () => {
  setup(); const wizard = new WizardStateService(); const state = createEmptyWizardState();
  state.samples.push({...state.samples[0], index: 2, sourceName: 'sample_2'}); state.sampleCount = 2;
  state.msRuns = [{id:'r', name:'Run 1', labelConfigId:'lf', channels:[{label:'label free sample',role:'sample',sampleIndex:1}]}];
  state.dataFiles = [{fileName:'a.raw',runId:'r'}, {fileName:'b.raw'}, {fileName:'c.raw',fractionId:2,technicalReplicate:2}];
  wizard.hydrate(state);
  wizard.setSeparateRunSamples('r', [1,2]);
  wizard.assignFilesToSeparateSample([1,2], 'r', 2);
  const {buildWizardExpansionRows,validateRunsAndFiles} = load('src/app/core/models/wizard.ts');
  const rows = buildWizardExpansionRows(wizard.getState());
  assert.deepEqual(Array.from(rows,r=>r.sourceName), ['sample_1','sample_2','sample_2']);
  assert.equal(rows[2].fractionId,2); assert.equal(rows[2].technicalReplicate,2);
  assert.equal(validateRunsAndFiles(wizard.getState()),true);
  wizard.setSeparateRunSamples('r',[1]);
  assert.equal(wizard.getState().dataFiles[1].runId,undefined);
  assert.equal(validateRunsAndFiles(wizard.getState()),false);
});

test('pool conversion is explicit and converting back returns ambiguous files to the pool', () => {
  setup(); const wizard = new WizardStateService(); const state = createEmptyWizardState();
  state.samples.push({...state.samples[0],index:2,sourceName:'sample_2'});state.sampleCount=2;
  state.msRuns=[{id:'r',name:'Run 1',labelConfigId:'lf',channels:[{label:'label free sample',role:'sample',sampleIndex:1}]}];
  state.dataFiles=[{fileName:'a.raw',runId:'r'}];wizard.hydrate(state);
  wizard.setSeparateRunSamples('r',[1,2]);wizard.setPooledRunMapping('r');
  assert.equal(wizard.getState().msRuns[0].channels[0].role,'pooled');
  assert.deepEqual(Array.from(wizard.getState().msRuns[0].channels[0].pooledSampleIndices),[1,2]);
  wizard.setSeparateRunSamples('r',[1,2]);
  assert.equal(wizard.getState().dataFiles[0].runId,undefined);
  assert.equal(wizard.getState().dataFiles[0].sampleIndex,undefined);
});

test('sample grouping names groups, keeps unchanged mappings and releases files from changed groups', () => {
  setup(); const wizard = new WizardStateService(); const state = createEmptyWizardState();
  state.labelConfigId='lf'; state.samples.push({...state.samples[0],index:2,sourceName:'sample_2'});state.sampleCount=2;
  wizard.hydrate(state);
  wizard.configureSampleGroups([{name:'normal',members:[1]},{name:'treated',members:[2]}]);
  assert.deepEqual(Array.from(wizard.getState().msRuns,r=>r.name),['normal','treated']);
  const first=wizard.getState().msRuns[0];
  assert.equal(first.sampleMappingMode,'separate');
  const populated=wizard.getState(); populated.dataFiles=[{fileName:'normal.raw',runId:first.id,sampleIndex:1}];wizard.hydrate(populated);
  wizard.configureSampleGroups([{name:'healthy',members:[1]},{name:'treated',members:[2]}]);
  assert.equal(wizard.getState().msRuns[0].id,first.id);
  assert.equal(wizard.getState().dataFiles[0].runId,first.id);
  wizard.configureSampleGroups([{name:'All samples',members:[1,2]}]);
  assert.equal(wizard.getState().dataFiles[0].runId,undefined);
  assert.equal(wizard.getState().dataFiles[0].sampleIndex,undefined);
  const before=JSON.stringify(wizard.getState());
  assert.throws(()=>wizard.configureSampleGroups([{name:'x',members:[1]},{name:'X',members:[2]}]),/unique/);
  assert.equal(JSON.stringify(wizard.getState()),before);
});

test('multi-factor grouping uses observed combinations including unassigned values and ignores run factors', () => {
  const { groupSamplesByFactors } = load('src/app/core/models/wizard.ts');
  const state = createEmptyWizardState();
  state.factors = [{name:'disease',enabled:true,values:['normal','cancer']},{name:'time',enabled:true,values:['0h','6h']},{name:'acquisition',enabled:true,scope:'run',values:['DIA']}];
  state.samples = [['normal','0h'],['normal','6h'],['cancer','0h'],['normal','0h'],['cancer','']].map(([disease,time],i)=>({...state.samples[0],index:i+1,factorValues:{disease,time}}));
  const groups = groupSamplesByFactors(state,['disease','time','acquisition']);
  assert.equal(groups.length,4);
  assert.deepEqual(Array.from(groups[0].members),[1,4]);
  assert.equal(groups[0].name,'disease: normal · time: 0h');
  assert.equal(groups[3].name,'disease: cancer · time: (unassigned)');
  assert.equal(groupSamplesByFactors(state,['disease']).length,2);
  assert.equal(groupSamplesByFactors(state,[]).length,0);
});

test('adding the second grouping factor replaces two mapping groups with four observed combinations', () => {
  setup(); const wizard = new WizardStateService(); const state = createEmptyWizardState();
  const { groupSamplesByFactors } = load('src/app/core/models/wizard.ts');
  state.labelConfigId='lf';
  state.factors=[{name:'organism',enabled:true,values:['human','mouse']},{name:'organism part',enabled:true,values:['liver','blood','lung','heart']}];
  state.samples=Array.from({length:12},(_,i)=>({...state.samples[0],index:i+1,sourceName:`sample_${i+1}`,factorValues:{organism:i<6?'human':'mouse','organism part':['liver','blood','lung','heart'][Math.floor(i/3)]}}));
  state.sampleCount=12;wizard.hydrate(state);
  wizard.configureSampleGroups(groupSamplesByFactors(wizard.getState(),['organism']));
  assert.equal(wizard.getState().msRuns.length,2);
  wizard.configureSampleGroups(groupSamplesByFactors(wizard.getState(),['organism','organism part']));
  assert.equal(wizard.getState().msRuns.length,4);
  assert.deepEqual(Array.from(wizard.getState().msRuns,r=>r.groupMembers.length),[3,3,3,3]);
});

test('independent LF rows preserve old files and export mixed single samples and pools without cross expansion', () => {
  setup(); const wizard = new WizardStateService(); const state = createEmptyWizardState();
  state.labelConfigId = 'lf';
  state.samples = [1,2,3].map(index => ({...state.samples[0], index, sourceName:`sample_${index}`}));
  state.sampleCount = 3;
  state.msRuns = [{id:'r',name:'Group',labelConfigId:'lf',sampleMappingMode:'separate',sampleIndices:[1,2],channels:[]}];
  state.dataFiles = [{fileName:'a.raw',runId:'r',sampleIndex:1},{fileName:'b.raw',runId:'r',sampleIndex:2},{fileName:'pool.raw',fractionId:2,technicalReplicate:3}];
  wizard.hydrate(state); wizard.ensureLabelFreeRows('r');
  const firstId = wizard.getState().msRuns[0].channels[0].mappingId;
  assert.equal(wizard.getState().dataFiles[0].mappingId,firstId);
  wizard.ensureLabelFreeRows('r');
  assert.equal(wizard.getState().msRuns[0].channels[0].mappingId,firstId);
  wizard.addLabelFreeRow('r');
  wizard.setChannelAssignment('r',2,{role:'pooled',pooledSampleIndices:[2,3],sourceNameOverride:'Reference pool'});
  const poolId = wizard.getState().msRuns[0].channels[2].mappingId;
  wizard.assignFilesToLabelFreeRow([2],'r',poolId);
  const {buildWizardExpansionRows,validateRunsAndFiles} = load('src/app/core/models/wizard.ts');
  const rows=buildWizardExpansionRows(wizard.getState());
  assert.deepEqual(Array.from(rows,r=>r.sourceName),['sample_1','sample_2','Reference pool']);
  assert.equal(rows[2].fractionId,2);assert.equal(rows[2].technicalReplicate,3);
  assert.equal(validateRunsAndFiles(wizard.getState()),true);
  wizard.removeLabelFreeRow('r',firstId);
  assert.equal(wizard.getState().dataFiles[0].runId,undefined);
  assert.equal(wizard.getState().dataFiles[1].runId,'r');
  assert.equal(buildWizardExpansionRows(wizard.getState()).length,2);
  wizard.setChannelAssignment('r',1,{role:'sample',sampleIndex:3});
  assert.equal(wizard.getState().dataFiles[2].runId,undefined);
});

test('LF row file selection rejects incomplete pools and kit changes release incompatible assignments', () => {
  setup(); const wizard = new WizardStateService(); const state = createEmptyWizardState();
  state.labelConfigId='lf';state.msRuns=[{id:'r',name:'Group',labelConfigId:'lf',channels:[{label:'label free sample',role:'sample',sampleIndex:1}]}];
  state.dataFiles=[{fileName:'a.raw',runId:'r'},{fileName:'b.raw'}];wizard.hydrate(state);wizard.ensureLabelFreeRows('r');
  const id=wizard.getState().msRuns[0].channels[0].mappingId;
  assert.equal(wizard.getState().dataFiles[0].mappingId,id);
  wizard.setChannelAssignment('r',0,{role:'pooled',pooledSampleIndices:[1]});
  assert.throws(()=>wizard.assignFilesToLabelFreeRow([1],'r',id),/at least two/);
  wizard.setChannelAssignment('r',0,{role:'sample',sampleIndex:1});
  wizard.assignFilesToLabelFreeRow([0],'r',id);
  wizard.setRunLabelConfig('r','tmt10');
  assert.equal(wizard.getState().dataFiles[0].runId,undefined);
  assert.equal(wizard.getState().msRuns[0].sampleMappingMode,undefined);
  assert.equal(wizard.getState().msRuns[0].channels.length,10);
});

test('file numbering is isolated per LF mapping and shared across files of one TMT plex', () => {
  setup(); const wizard = new WizardStateService(); const state = createEmptyWizardState();
  state.msRuns = [{id:'lf',name:'LF',labelConfigId:'lf',sampleMappingMode:'rows',channels:[{mappingId:'a',label:'label free sample',role:'sample',sampleIndex:1},{mappingId:'b',label:'label free sample',role:'pooled',pooledSampleIndices:[1,2],sourceNameOverride:'pool'}]}, {id:'tmt',name:'TMT',labelConfigId:'tmt10',channels:[]}];
  state.dataFiles = [{fileName:'a.raw',runId:'lf',mappingId:'a',fractionId:1,technicalReplicate:1},{fileName:'b.raw',runId:'lf',mappingId:'b'},{fileName:'c.raw',runId:'lf',mappingId:'b'},{fileName:'x.raw',runId:'tmt'},{fileName:'y.raw',runId:'tmt'}];
  wizard.hydrate(state);
  wizard.setScopedFileMetadata('lf','b','fractions');
  assert.deepEqual(Array.from(wizard.getState().dataFiles.slice(0,3),f=>[f.fractionId,f.technicalReplicate]),[[1,1],[1,1],[2,1]]);
  const before=JSON.stringify(wizard.getState().dataFiles);
  wizard.setScopedFileMetadata('lf',undefined,'repeats');
  assert.equal(JSON.stringify(wizard.getState().dataFiles),before);
  wizard.setScopedFileMetadata('lf','b','repeats');
  assert.deepEqual(Array.from(wizard.getState().dataFiles.slice(0,3),f=>[f.fractionId,f.technicalReplicate]),[[1,1],[1,1],[1,2]]);
  wizard.setScopedFileMetadata('tmt',undefined,'fractions');
  assert.deepEqual(Array.from(wizard.getState().dataFiles.slice(3),f=>[f.fractionId,f.technicalReplicate]),[[1,1],[2,1]]);
  wizard.setScopedFileMetadata('lf','b','none');
  assert.deepEqual(Array.from(wizard.getState().dataFiles.slice(1,3),f=>[f.fractionId,f.technicalReplicate]),[[1,1],[1,1]]);
});

test('numbering arrows change only the chosen column and unnamed pools can receive files', () => {
  setup(); const wizard = new WizardStateService(); const state = createEmptyWizardState();
  state.samples.push({...state.samples[0],index:2,sourceName:'sample_2'});
  state.msRuns=[{id:'r',name:'Group',labelConfigId:'lf',sampleMappingMode:'rows',channels:[{label:'label free sample',mappingId:'pool',role:'pooled',pooledSampleIndices:[1,2]},{label:'label free sample',mappingId:'other',role:'sample',sampleIndex:1}]}];
  state.dataFiles=[{fileName:'a.raw',fractionId:4,technicalReplicate:2},{fileName:'b.raw',fractionId:4,technicalReplicate:2},{fileName:'c.raw',runId:'r',mappingId:'other',fractionId:7,technicalReplicate:3}];
  wizard.hydrate(state);wizard.assignFilesToLabelFreeRow([0,1],'r','pool');
  wizard.numberScopedFiles('r','pool','fractionId','desc');
  assert.deepEqual(Array.from(wizard.getState().dataFiles,f=>[f.fractionId,f.technicalReplicate]),[[2,2],[1,2],[7,3]]);
  wizard.numberScopedFiles('r','pool','technicalReplicate','asc');
  assert.deepEqual(Array.from(wizard.getState().dataFiles,f=>[f.fractionId,f.technicalReplicate]),[[2,1],[1,2],[7,3]]);
  const {validateRunsAndFiles,buildWizardExpansionRows}=load('src/app/core/models/wizard.ts');
  assert.equal(validateRunsAndFiles(wizard.getState()),true);
  assert.equal(buildWizardExpansionRows(wizard.getState())[0].sourceName,'pool_sample_1_sample_2');
});

const { WizardAiBridgeService } = load('src/app/core/services/assistant/wizard-ai-bridge.service.ts');
function assistantFixture() {
  setup();
  templateService.install({ ...snapshot, templates: [...snapshot.templates,
    { name: 'sample-addon', version: '1.0.0', layer: 'sample', columns: [] },
    { name: 'experiment-addon', version: '1.0.0', layer: 'experiment', columns: [] },
  ] });
  wizardService = new WizardStateService();
  // Template resolution is covered above; these tests exercise the assistant adapter.
  wizardService.refreshCharacteristicColumns = async () => {};
  return { wizard: wizardService, bridge: new WizardAiBridgeService() };
}

test('assistant applies multiple sample templates without misclassifying them as experiments', async () => {
  const { wizard, bridge } = assistantFixture();
  const apply = (op, args) => bridge.applyAction({ op, args });
  await apply('setTechnologyTemplate', ['new-platform']);
  await apply('setSampleTemplates', [['new-sample', 'sample-addon']]);
  await apply('setExperimentTemplates', [['experiment-addon']]);
  assert.equal(wizard.getState().selectedTemplates.map(t => t.name).join(','),
    'new-platform,new-sample,sample-addon,experiment-addon');
  assert.equal(bridge.buildSnapshot().sampleMetadataTemplates.join(','), 'sample-addon');
  await assert.rejects(apply('setExperimentTemplates', [['sample-addon']]), /incorrect layer/);
  await apply('setSampleTemplates', [[]]);
  assert.equal(wizard.getState().selectedTemplates.map(t => t.name).join(','), 'new-platform,experiment-addon');
});

test('ordinary assistant turns include manual sample assignments and per-file pooled mappings', () => {
  const { wizard, bridge } = assistantFixture();
  const state = createEmptyWizardState();
  state.samples[0].characteristicValues = { 'characteristics[disease]': 'normal' };
  state.msRuns = [{ id: 'r', name: 'All samples', labelConfigId: 'lf', sampleMappingMode: 'rows',
    channels: [{ label: 'label free sample', mappingId: 'pool', role: 'pooled', pooledSampleIndices: [1] }] }];
  state.dataFiles = [{ fileName: 'a.raw', runId: 'r', mappingId: 'pool', fractionId: 2, technicalReplicate: 3 }];
  wizard.hydrate(state);
  const data = bridge.buildSnapshot();
  assert.equal(data.sampleAssignments[0].characteristicValues['characteristics[disease]'], 'normal');
  assert.equal(data.msRunSummaries[0].sampleMappingMode, 'rows');
  assert.equal(data.msRunSummaries[0].channels[0].pooledSourceNames[0], state.samples[0].sourceName);
  assert.equal(data.msRunSummaries[0].files[0].mappingId, 'pool');
});

test('assistant edits only template-provided protocol fields with the same validation as the wizard', async () => {
  const { wizard, bridge } = assistantFixture();
  const state = createEmptyWizardState();
  state.effectiveColumns = [{ name: 'comment[assay]', requirement: 'required',
    validators: [{ validatorName: 'values', params: { values: ['A', 'B'] } }] }];
  wizard.hydrate(state);
  const apply = (name, value) => bridge.applyAction({ op: 'setTemplateValue', args: [name, value] });
  await apply('comment[assay]', 'A');
  assert.equal(bridge.buildSnapshot().genericProtocolFields[0].value, 'A');
  assert.equal(bridge.buildSnapshot().genericProtocolFields[0].options.join(','), 'A,B');
  await assert.rejects(apply('comment[assay]', 'unknown'), /allowed by the template/);
  await assert.rejects(apply('comment[invented]', 'A'), /No editable protocol field/);
  assert.equal(wizard.getState().dynamicTemplateValues['comment[assay]'], 'A');
});

test('AI attribute edits use explicit UI assignments without assigning the first candidate to everyone', async () => {
  const { wizard, bridge } = assistantFixture();
  wizard.setSampleCount(3);
  const state = wizard.getState();
  state.characteristicColumns = [{ name: 'characteristics[disease]', requirement: 'required' }];
  wizard.hydrate(state);
  const action = { op: 'applyCharacteristicDraft', args: [
    'characteristics[disease]', [{ value: 'normal' }], 'explicit', ['normal', '', ''],
  ] };
  const before = JSON.stringify(wizard.getState());
  assert.match(bridge.previewAction(action), /unassigned/);
  assert.equal(JSON.stringify(wizard.getState()), before, 'preview must not mutate state');
  await bridge.applyAction(action);
  wizard.syncCharacteristicAssignments();
  assert.equal(wizard.getState().samples.map(s => s.characteristicValues['characteristics[disease]']).join('|'), 'normal||');
  await bridge.applyAction({ op: 'applyCharacteristicDraft', args: [
    'characteristics[disease]', [{ value: 'normal' }, { value: 'disease' }], 'explicit', ['normal', 'disease', ''],
  ] });
  assert.equal(wizard.getState().samples.map(s => s.characteristicValues['characteristics[disease]']).join('|'), 'normal|disease|');
  await bridge.applyAction({ op: 'addFactor', args: [{
    name: 'disease', enabled: true, values: [], sourceCharacteristic: 'characteristics[disease]',
  }] });
  const { resolveFactorValue } = load('src/app/core/models/wizard.ts');
  const updated = wizard.getState();
  assert.equal(updated.samples.map(s => resolveFactorValue(updated, s, updated.factors[0])).join('|'), 'normal|disease|');
});

test('AI attribute edits reject invalid drafts atomically and can explicitly assign all samples', async () => {
  const { wizard, bridge } = assistantFixture();
  wizard.setSampleCount(2);
  const state = wizard.getState();
  state.characteristicColumns = [{ name: 'characteristics[disease]', requirement: 'required' }];
  wizard.hydrate(state);
  const args = ['characteristics[disease]', [{ value: 'normal' }], 'explicit', ['normal', 'normal']];
  await bridge.applyAction({ op: 'applyCharacteristicDraft', args });
  for (const bad of [
    ['characteristics[missing]', args[1], 'explicit', args[3]],
    [args[0], args[1], 'shared', args[3]],
    [args[0], args[1], 'explicit', ['normal']],
    [args[0], args[1], 'explicit', ['normal', 'unlisted']],
    [args[0], args[1], 'explicit', [1, 2]],
    [args[0], [{ value: 'normal' }, { value: 'normal' }], 'explicit', args[3]],
  ]) {
    const before = JSON.stringify(wizard.getState());
    await assert.rejects(bridge.applyAction({ op: 'applyCharacteristicDraft', args: bad }));
    assert.equal(JSON.stringify(wizard.getState()), before);
  }
  assert.equal(wizard.getState().samples.map(s => s.characteristicValues[args[0]]).join('|'), 'normal|normal');
});

test('AI snapshot advertises the same editable attributes as the sample page', () => {
  const { wizard, bridge } = assistantFixture();
  const state = wizard.getState();
  state.characteristicColumns = ['organism', 'material type', 'biological replicate'].map(name => ({
    name: 'characteristics[' + name + ']', requirement: 'required',
  }));
  wizard.hydrate(state);
  assert.equal(bridge.buildSnapshot().characteristicColumns.map(c => c.name).join(','), 'characteristics[organism]');
});

test('biological replicate trace failures do not mutate samples and corrected values apply', async () => {
  const { wizard, bridge } = assistantFixture();
  const state = createEmptyWizardState();
  state.sampleCount = 8;
  state.samples = Array.from({length: 8}, (_, i) => ({...state.samples[0], index:i+1,
    sourceName:`sample_${i+1}`, biologicalReplicate:i < 4 ? 1 : 2}));
  wizard.hydrate(state);
  const before = JSON.stringify(wizard.getState());
  const indices = Array.from({length:8}, (_,i)=>i);
  for (const args of [
    [Array(8).fill('pooled')], Array(8).fill(1), [indices], [indices,1], [indices,Array(8).fill(1)],
    [Array(7).fill(1)], [Array(8).fill(1.5)], [Array(8).fill(true)], [Array(8).fill('1')],
    [Array(8).fill(1),1], [Array(8).fill(NaN)], [Array(8).fill(Infinity)],
  ]) {
    const action = {op:'setBiologicalReplicates',args};
    assert.match(bridge.previewAction(action), /Invalid suggestion:.*not sample indices/);
    await assert.rejects(bridge.applyAction(action), /args=\[\[1,1,1,1,1,1,1,1\]\]/);
    assert.equal(JSON.stringify(wizard.getState()), before);
  }
  await bridge.applyAction({op:'setBiologicalReplicates',args:[Array(8).fill(1)]});
  assert.deepEqual(Array.from(wizard.getState().samples, s=>s.biologicalReplicate),Array(8).fill(1));
  assert.deepEqual(Array.from(wizard.getState().samples,s=>s.sourceName),state.samples.map(s=>s.sourceName));
});

test('automatic Runs & Files applies import before dependent plan and preserves download URLs', async () => {
  const { wizard, bridge } = assistantFixture();
  const { runAutoAnnotation } = load('src/app/core/utils/auto-annotation.ts');
  const state = createEmptyWizardState();
  state.msRuns = []; state.dataFiles = []; state.labelConfigId = 'lf';
  state.samples[0].sourceName = 'sample_1';
  state.templateSnapshotId = snapshotId;
  state.leafTemplateRefs = [{name:'new-platform',version:'2.0.0'}];
  state.effectiveColumns = [{name:'source name'},{name:'assay name'},{name:'comment[data file]'}];
  wizard.hydrate(state);
  const names = Array.from({length:6},(_,i)=>`run${i+1}.raw`);
  const urls = Object.fromEntries(names.map(name=>[name,`ftp://ftp.pride.ebi.ac.uk/pride/data/archive/2020/01/PXD000070/${name}`]));
  const plan = {groups:['DT','DDNL'].map((name,i)=>({name,labelConfigId:'lf',
    channels:[{label:'label free sample',sourceName:'sample_1'}],
    files:names.slice(i*3,i*3+3).map((fileName,j)=>({fileName,fractionId:1,technicalReplicate:j+1}))}))};
  const make = (op,args) => ({id:op,status:'pending',action:{op,args,step:'runs-files'}});
  const cards = [make('applyRunsFilesPlan',[plan]),make('replaceWithUnassignedFileNames',[names,urls])];
  const applied = [], visited = [];
  const outcome = await runAutoAnnotation({
    snapshot:()=>structuredClone(wizard.getState()),restore:s=>wizard.hydrate(s),
    fingerprint:()=>JSON.stringify(wizard.getState()),navigate:s=>visited.push(s),
    request:async step=>({cards:step===2?cards:[make('setAcquisitionMethod',['dda'])],report:{status:'ready',issues:[]}}),
    apply:async c=>{await bridge.applyAction(c.action);applied.push(c.action.op);},
    record:()=>{},errors:step=>step===2&&!wizard.isRunsFilesValid()?['Invalid mapping']:[],
    validate:async()=>({issues:[]}),progress:()=>{},
  }, new AbortController().signal,2);
  assert.equal(outcome.status,'complete',JSON.stringify(outcome));
  assert.deepEqual(applied.slice(0,2),['replaceWithUnassignedFileNames','applyRunsFilesPlan']);
  assert.deepEqual(visited,[2,3,4]);
  assert.equal(wizard.getState().dataFiles.length,6);
  const table = new WizardGeneratorService().generate(wizard.getState());
  assert.equal(table.columns.find(c=>c.name==='assay name').value,names[0]);
  assert.equal(table.columns.find(c=>c.name==='comment[data file]').value,urls[names[0]]);
  // Re-importing names must not discard stored locations or assigned mappings.
  wizard.replaceWithUnassignedFileNames(names);
  assert.equal(wizard.getState().dataFiles[0].downloadUrl,urls[names[0]]);
  wizard.updateDataFile(0,{fileName:'renamed.raw'});
  assert.equal(wizard.getState().dataFiles[0].downloadUrl,undefined);
});

test('entering Runs & Files finishes initialization before automatic request fingerprint', async () => {
  const { wizard, bridge } = assistantFixture();
  const { runAutoAnnotation } = load('src/app/core/utils/auto-annotation.ts');
  const state = createEmptyWizardState();
  state.labelConfigId = 'lf'; state.msRuns = []; state.dataFiles = [];
  wizard.hydrate(state);
  const cards = [{id:'import',action:{op:'replaceWithUnassignedFileNames',args:[['a.raw']]}},
    {id:'plan',action:{op:'applyRunsFilesPlan',args:[{groups:[{name:'DT',labelConfigId:'lf',
      channels:[{label:'label free sample',sourceName:state.samples[0].sourceName}],
      files:[{fileName:'a.raw',fractionId:1,technicalReplicate:1}]}]}]}}];
  const outcome = await runAutoAnnotation({
    snapshot:()=>structuredClone(wizard.getState()), restore:s=>wizard.hydrate(s),
    fingerprint:()=>JSON.stringify(wizard.getState()), navigate:step=>{if(step===2)wizard.ensureMsRunsForFilesStep();},
    request:async step=>{
      if(step===2){
        // Angular mounts the page and runs its effect after the request starts.
        wizard.ensureMsRunsForFilesStep();
        for(const run of wizard.getState().msRuns) wizard.ensureLabelFreeRows(run.id);
      }
      return {cards:step===2?cards:[{id:'method',action:{op:'setAcquisitionMethod',args:['dda']}}],report:{status:'ready',issues:[]}};
    },
    apply:c=>bridge.applyAction(c.action), record:()=>{},errors:()=>[],
    validate:async()=>({issues:[]}),progress:()=>{},
  },new AbortController().signal,2);
  assert.equal(outcome.status,'complete',JSON.stringify(outcome));
  wizard.ensureMsRunsForFilesStep();
  for(const run of wizard.getState().msRuns) wizard.ensureLabelFreeRows(run.id);
  const once = JSON.stringify(wizard.getState());
  wizard.ensureMsRunsForFilesStep();
  assert.equal(JSON.stringify(wizard.getState()),once);
  assert.equal(wizard.getState().dataFiles[0].fileName,'a.raw');
});

// One fixture set exercises both languages and covers every advertised action.
const actionArgFixtures = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/wizard-action-args.json'), 'utf8'));
const strictArgs = load('src/app/core/services/assistant/wizard-action-args.ts');
for (const fixture of actionArgFixtures) {
  test(`shared action contract: ${fixture.name}`, () => {
    const parse = () => strictArgs.validateActionArgs(fixture.op, fixture.args, fixture.sampleCount);
    if (!fixture.valid) assert.throws(parse);
    else assert.deepEqual(JSON.parse(JSON.stringify(parse())), fixture.expected || fixture.args);
  });
}

test('action contracts generated for frontend remain synchronized with backend', () => {
  const frontend = load('src/app/core/services/assistant/action-contracts.generated.ts').ACTION_CONTRACTS;
  const backend = JSON.parse(readFileSync(resolve(root, 'backend/app/llm/action_contracts.json'), 'utf8'));
  assert.deepEqual(JSON.parse(JSON.stringify(frontend)), backend);
});

test('bad indices and counts fail in both preview and apply without state mutation', async () => {
  const {wizard, bridge} = assistantFixture();
  wizard.setSampleCount(3);
  wizard.ensureSamplesInitialized();
  wizard.setFactors([{name:'treatment', enabled:true, scope:'sample', values:['control','treated']}]);
  const before = JSON.stringify(wizard.getState());
  const actions = [
    {op:'setSampleFactorValue',args:[null,'treatment','treated']},
    {op:'setSampleFactorValue',args:[99,'treatment','treated']},
    {op:'setTechnicalReplicates',args:[2.9]},
    {op:'setFractionCount',args:[null]},
    {op:'setSourceNames',args:[['same','same','same']]},
    {op:'autoGenerateSourceNames',args:['constant']},
    {op:'setAcquisitionMethod',args:['dda','dia']},
  ];
  for (const action of actions) {
    assert.match(bridge.previewAction(action), /^Invalid suggestion:/);
    await assert.rejects(bridge.applyAction(action));
    assert.equal(JSON.stringify(wizard.getState()), before);
  }
  assert.throws(() => wizard.setSampleFactorValue(99,'treatment','control'), /out of range/);
  assert.equal(JSON.stringify(wizard.getState()), before);
});

test('factor assignment blanks preserve positions and can clear a selected value', async () => {
  const {wizard, bridge} = assistantFixture();
  wizard.setSampleCount(3);
  wizard.ensureSamplesInitialized();
  wizard.setFactors([{name:'treatment',enabled:true,scope:'sample',values:['control','treated']}]);
  wizard.setFactorColumnValues('treatment',['control','control','control']);
  await bridge.applyAction({op:'setFactorColumnValues',args:['treatment',['control','','treated']]});
  assert.deepEqual(Array.from(wizard.getState().samples,s=>s.factorValues.treatment),['control',undefined,'treated']);
  const before=JSON.stringify(wizard.getState());
  await assert.rejects(bridge.applyAction({op:'setFactorColumnValues',args:['treatment',['control','','treated','control']]}));
  assert.equal(JSON.stringify(wizard.getState()),before);
});

test('flat source names are normalized without dropping samples', async () => {
  const {wizard,bridge}=assistantFixture();
  wizard.setSampleCount(3);
  await bridge.applyAction({op:'setSourceNames',args:['a','b','c']});
  assert.deepEqual(Array.from(wizard.getState().samples,s=>s.sourceName),['a','b','c']);
});

test('unknown modification mass is not fabricated as zero', () => {
  assert.equal(strictArgs.asModification({name:'x',targetAminoAcids:'M',deltaMass:null}).deltaMass,undefined);
  assert.equal(strictArgs.asModification({name:'x',targetAminoAcids:'M',deltaMass:0}).deltaMass,0);
});

test('PXD001574 historical batch repairs each invalid kit card and replays real mutations', async () => {
  const fixture = JSON.parse(readFileSync(resolve(root, 'tests/fixtures/auto-repair-pxd001574.json'), 'utf8'));
  const { wizard, bridge } = assistantFixture();
  wizard.hydrate({ ...createEmptyWizardState(), ...fixture.state });
  const { runAutoAnnotation, repairScopeError } = load('src/app/core/utils/auto-annotation.ts');
  const { describeActionFailure, buildActionRepairPrompt } = load('src/app/core/services/assistant/wizard-action-repair.ts');
  const cards = fixture.actions.map((action, i) => ({ id: `historical-${i}`, status: 'pending', action }));
  const events = [], requested = [];
  const outcome = await runAutoAnnotation({
    snapshot: () => structuredClone(wizard.getState()), restore: state => wizard.hydrate(state),
    fingerprint: () => JSON.stringify(wizard.getState()), navigate: () => {},
    request: async step => { requested.push(step); return { cards: step === 2 ? cards : [{ id:'protocol', action:{op:'setAcquisitionMethod',args:['dda']} }], report:{status:'ready',issues:[]} }; },
    apply: card => bridge.applyAction(card.action), describeFailure: describeActionFailure,
    repair: async request => {
      assert.equal(request.failure.code, 'INVALID_ENUM');
      assert.ok(request.failure.allowedValues.includes('itraq4'));
      assert.match(buildActionRepairPrompt(request), /exactly ONE/);
      const replacement = structuredClone(request.card);
      replacement.id += '-fixed';
      if (replacement.action.op === 'setLabelConfig') replacement.action.args = ['itraq4'];
      else {
        replacement.action.args[0].groups.forEach(group => {
          group.labelConfigId = 'itraq4';
          group.channels.forEach(channel => { channel.label = channel.label.replace(/^iTRAQ(\d+)$/, 'iTRAQ4plex-$1'); });
        });
        const unsafe = structuredClone(replacement);
        unsafe.action.args[0].groups[0].files[0].fileName = 'invented.raw';
        assert.match(repairScopeError(request.card, unsafe, request.failure), /outside/);
      }
      assert.equal(repairScopeError(request.card, replacement, request.failure), null);
      return { cards: [replacement], report: {status:'ready',issues:[]} };
    },
    repairEvent: event => { if (event.status === 'accepted') events.push(event.request.card.action.op); },
    record:()=>{}, errors:()=>[], validate:async()=>({issues:[]}), progress:()=>{},
  }, new AbortController().signal, 2);
  assert.equal(outcome.status,'complete',JSON.stringify(outcome));
  assert.deepEqual(events,['setLabelConfig','applyRunsFilesPlan']);
  assert.deepEqual(requested,[2,3]);
  assert.equal(wizard.getState().dataFiles.length,15);
  assert.ok(wizard.getState().msRuns.filter(r=>r.name!=='Run 1').every(r=>r.labelConfigId==='itraq4'));
  assert.equal(cards[0].action.args[0],'itraq4plex'); // historical card remains immutable
});

test('card repair classifier leaves evidence and infrastructure failures blocked', () => {
  const { describeActionFailure } = load('src/app/core/services/assistant/wizard-action-repair.ts');
  const card = { action:{op:'setLabelConfig',args:['itraq4plex']} };
  for (const error of [new Error('Network unavailable'), new strictArgs.WizardActionError('No candidate values exist yet.'),
    new strictArgs.WizardActionError('Unknown template or incorrect layer: missing')]) {
    assert.equal(describeActionFailure(card,error).repairable,false);
  }
  assert.equal(describeActionFailure(card,new strictArgs.WizardActionError('Expected a string.')).repairable,true);
});

const protocol = load('src/app/core/utils/protocol-fields.ts');
const { getValueForSample } = load('src/app/core/models/sdrf-column.ts');
function protocolFixture() {
  setup();
  const wizard = new WizardStateService(), state = createEmptyWizardState();
  state.effectiveColumns = [
    { name: 'comment[instrument]', requirement: 'required' },
    { name: 'comment[precursor mass tolerance]', requirement: 'recommended' },
    { name: 'comment[fragment mass tolerance]', requirement: 'recommended' },
    { name: 'comment[modification parameters]', requirement: 'recommended', cardinality: 'multiple' },
    { name: 'technology type', requirement: 'required', validators: [{ validatorName: 'values', params: { values: ['mass spectrometry', 'other technology'] } }] },
  ];
  state.precursorMassTolerance = '10 ppm';
  state.fragmentMassTolerance = '0.02 Da';
  state.modifications = [{name:'Carbamidomethyl',unimodAccession:'UNIMOD:4',targetAminoAcids:'C',type:'fixed',position:'Anywhere'}];
  state.dynamicTemplateValues = { 'technology type': 'mass spectrometry' };
  state.dataFiles = ['a.raw', 'b.raw', 'c.raw'].map(fileName => ({ fileName, sampleIndex: 1, runId: state.msRuns[0].id }));
  wizard.hydrate(state);
  return wizard;
}
const instrumentA = { id: 'a', value: { id: 'MS:1001911', label: 'Q Exactive' } };
const instrumentB = { id: 'b', value: { id: 'MS:1002416', label: 'Orbitrap Fusion' } };
const rawNames = ['a.raw', 'b.raw', 'c.raw'];

test('protocol: first value applies to all, second candidate preserves existing file assignments', () => {
  const wizard = protocolFixture(), name = protocol.PROTOCOL_COLUMNS.instrument;
  let field = protocol.addProtocolChoice(protocol.protocolField(wizard.getState(), name), instrumentA, rawNames);
  assert.equal(protocol.protocolChoiceForFile(field, 'future.raw').id, 'a');
  field = protocol.addProtocolChoice(field, instrumentB, rawNames);
  assert.deepEqual(rawNames.map(file => protocol.protocolChoiceForFile(field, file).id), ['a', 'a', 'a']);
  assert.equal(protocol.protocolChoiceForFile(field, 'future.raw'), undefined);
  field = protocol.assignProtocolChoice(field, 'b', rawNames, new Set(['b.raw', 'c.raw']));
  wizard.setProtocolField(name, field);
  assert.equal(wizard.isStep5Valid(), true);
  assert.deepEqual(rawNames.map(file => protocol.protocolValueForFile(wizard.getState(), name, file).label), ['Q Exactive', 'Orbitrap Fusion', 'Orbitrap Fusion']);
  wizard.setDataFiles([...wizard.getState().dataFiles].reverse());
  assert.equal(protocol.protocolValueForFile(wizard.getState(), name, 'a.raw').label, 'Q Exactive');
});

test('protocol: removal and deselection leave explicit gaps; All fixes gaps and covers new files', () => {
  const wizard = protocolFixture(), name = protocol.PROTOCOL_COLUMNS.instrument;
  let field = protocol.addProtocolChoice({ choices: [], assignments: {} }, instrumentA, rawNames);
  field = protocol.addProtocolChoice(field, instrumentB, rawNames);
  field = protocol.assignProtocolChoice(field, 'b', rawNames, new Set(['b.raw']));
  field = protocol.removeProtocolChoice(field, 'b');
  wizard.setProtocolField(name, field);
  assert.equal(wizard.isStep5Valid(), false);
  assert.match(protocol.protocolFieldError(wizard.getState(), wizard.getState().effectiveColumns[0]), /1 raw files/);
  assert.equal(protocol.protocolValueForFile(wizard.getState(), name, 'b.raw'), undefined);
  field = protocol.assignProtocolChoice(field, 'a', rawNames, new Set(), true);
  wizard.setProtocolField(name, field);
  wizard.setDataFiles([...wizard.getState().dataFiles, {fileName:'new.raw', sampleIndex:1}]);
  assert.equal(wizard.isStep5Valid(), true);
  field = protocol.assignProtocolChoice(field, 'a', [...rawNames, 'new.raw'], new Set(['a.raw']));
  wizard.setProtocolField(name, field);
  assert.equal(wizard.isStep5Valid(), false);
});

test('protocol: legacy drafts, hydration and explicit global setters stay compatible', () => {
  const wizard = protocolFixture(), name = protocol.PROTOCOL_COLUMNS.instrument;
  wizard.setInstrument(instrumentA.value);
  assert.equal(protocol.protocolValueForFile(wizard.getState(), name, 'b.raw').label, 'Q Exactive');
  wizard.setProtocolField(name, { choices:[instrumentA,instrumentB], assignments:{'a.raw':'a','b.raw':'b','c.raw':'b'} });
  const restored = new WizardStateService(); restored.hydrate(JSON.parse(JSON.stringify(wizard.getState())));
  assert.equal(protocol.protocolValueForFile(restored.getState(), name, 'c.raw').label, 'Orbitrap Fusion');
  restored.setInstrument(instrumentA.value);
  assert.equal(restored.getState().protocolFields[name], undefined);
  assert.equal(protocol.protocolValueForFile(restored.getState(), name, 'c.raw').label, 'Q Exactive');
});

test('protocol: recommended tolerances allow omission but reject invalid or partial assignments', () => {
  const wizard = protocolFixture();
  wizard.setInstrument(instrumentA.value);
  assert.equal(wizard.isStep5Valid(), true);
  wizard.setProtocolField(protocol.PROTOCOL_COLUMNS.precursorMassTolerance, { choices:[{id:'x',value:'10 ppm'}], assignments:{'a.raw':'x'} });
  assert.equal(wizard.isStep5Valid(), false);
  wizard.setProtocolField(protocol.PROTOCOL_COLUMNS.precursorMassTolerance, { choices:[{id:'x',value:'10'}], allChoiceId:'x', assignments:{} });
  assert.equal(wizard.isStep5Valid(), false);
  wizard.setProtocolField(protocol.PROTOCOL_COLUMNS.precursorMassTolerance, { choices:[], assignments:{} });
  assert.equal(wizard.isStep5Valid(), true);
});

test('protocol: generated SDRF resolves raw-file values after schema adaptation, including generic fields', () => {
  const wizard = protocolFixture();
  wizard.setProtocolField(protocol.PROTOCOL_COLUMNS.instrument, { choices:[instrumentA,instrumentB], assignments:{'a.raw':'a','b.raw':'b','c.raw':'b'} });
  wizard.setProtocolField(protocol.PROTOCOL_COLUMNS.precursorMassTolerance, { choices:[{id:'x',value:'10ppm'},{id:'y',value:'0.02da'}], assignments:{'a.raw':'x','b.raw':'y','c.raw':'x'} });
  wizard.setProtocolField('technology type', { choices:[{id:'x',value:'mass spectrometry'},{id:'y',value:'other technology'}], assignments:{'a.raw':'x','b.raw':'y','c.raw':'x'} });
  const state = {...wizard.getState(), templateSnapshotId:snapshotId, leafTemplateRefs:[{name:'new-platform',version:'2.0.0'}]};
  const table = new WizardGeneratorService().generate(state);
  const values = name => [1,2,3].map(row => getValueForSample(table.columns.find(c => c.name === name), row));
  assert.deepEqual(values(protocol.PROTOCOL_COLUMNS.instrument), ['NT=Q Exactive;AC=MS:1001911','NT=Orbitrap Fusion;AC=MS:1002416','NT=Orbitrap Fusion;AC=MS:1002416']);
  assert.deepEqual(values(protocol.PROTOCOL_COLUMNS.precursorMassTolerance), ['10 ppm','0.02 Da','10 ppm']);
  assert.deepEqual(values('technology type'), ['mass spectrometry','other technology','mass spectrometry']);
});

test('protocol: modification sets expand to repeated columns without leaking modifications between files', () => {
  const wizard = protocolFixture(), name = protocol.PROTOCOL_COLUMNS.modifications;
  const carb = {name:'Carbamidomethyl',unimodAccession:'UNIMOD:4',targetAminoAcids:'C',type:'fixed',position:'Anywhere'};
  const ox = {name:'Oxidation',unimodAccession:'UNIMOD:35',targetAminoAcids:'M',type:'variable',position:'Anywhere'};
  wizard.setProtocolField(name, { choices:[{id:'x',value:[carb,ox]},{id:'y',value:[ox]}], assignments:{'a.raw':'x','b.raw':'y','c.raw':'y'} });
  const table = new WizardGeneratorService().generate(wizard.getState());
  const columns = table.columns.filter(c => c.name === name);
  assert.equal(columns.length, 2);
  assert.match(getValueForSample(columns[0],1), /Carbamidomethyl/);
  assert.match(getValueForSample(columns[1],1), /Oxidation/);
  assert.match(getValueForSample(columns[0],2), /Oxidation/);
  assert.equal(getValueForSample(columns[1],2), 'not applicable');
  assert.equal(getValueForSample(columns[1],3), 'not applicable');
});

test('protocol: every multiplex channel row inherits its raw file assignment', () => {
  const wizard = protocolFixture(), name = protocol.PROTOCOL_COLUMNS.instrument;
  const state = wizard.getState();
  state.labelConfigId = 'tmt6';
  state.samples = [{...state.samples[0],index:1,sourceName:'s1'},{...state.samples[0],index:2,sourceName:'s2'}];
  state.msRuns = [{id:'r1',name:'run1',labelConfigId:'tmt6',channels:[{label:'TMT126',sampleIndex:1,role:'sample'},{label:'TMT127',sampleIndex:2,role:'sample'}]}];
  state.dataFiles = [{fileName:'a.raw',runId:'r1'},{fileName:'b.raw',runId:'r1'}];
  state.protocolFields = {[name]:{choices:[instrumentA,instrumentB],assignments:{'a.raw':'a','b.raw':'b'}}};
  const table = new WizardGeneratorService().generate(state);
  const column = table.columns.find(c => c.name === name);
  assert.deepEqual([1,2,3,4].map(row => getValueForSample(column,row)), ['NT=Q Exactive;AC=MS:1001911','NT=Q Exactive;AC=MS:1001911','NT=Orbitrap Fusion;AC=MS:1002416','NT=Orbitrap Fusion;AC=MS:1002416']);
});

test('protocol: renaming a raw file preserves each field assignment', () => {
  const wizard = protocolFixture(), name = protocol.PROTOCOL_COLUMNS.instrument;
  wizard.setProtocolField(name, {choices:[instrumentA,instrumentB],assignments:{'a.raw':'a','b.raw':'b','c.raw':'b'}});
  wizard.updateDataFile(1, {fileName:'renamed.raw'});
  assert.equal(protocol.protocolValueForFile(wizard.getState(), name, 'renamed.raw').label, 'Orbitrap Fusion');
  assert.equal(wizard.getState().protocolFields[name].assignments['b.raw'], undefined);
  assert.equal(wizard.isStep5Valid(), true);
});


test('protocol: tolerances are recommended while modifications remain required', () => {
  const wizard = protocolFixture();
  wizard.setInstrument(instrumentA.value);
  const state = wizard.getState();
  for (const name of [protocol.PROTOCOL_COLUMNS.precursorMassTolerance, protocol.PROTOCOL_COLUMNS.fragmentMassTolerance, protocol.PROTOCOL_COLUMNS.modifications]) {
    const required = name === protocol.PROTOCOL_COLUMNS.modifications;
    assert.equal(protocol.protocolColumns(state).find(column => column.name === name).requirement, required ? 'required' : 'recommended');
    assert.equal(state.effectiveColumns.find(column => column.name === name).requirement, 'recommended');
    wizard.hydrate(state);
    wizard.setProtocolField(name, {choices:[],assignments:{}});
    assert.equal(wizard.isStep5Valid(), !required, name);
    assert.equal(protocol.protocolFieldError(wizard.getState(), state.effectiveColumns.find(column => column.name === name)), required ? 'This field is required.' : '');
  }
});

function protocolAssistantFixture() {
  const state = protocolFixture().getState();
  const {wizard, bridge} = assistantFixture();
  wizard.hydrate(state);
  return {wizard, bridge};
}

test('protocol cards: snapshot includes all candidates, file mappings, live requirements and precise issues', () => {
  const {wizard,bridge} = protocolAssistantFixture(), name = protocol.PROTOCOL_COLUMNS.instrument;
  wizard.setProtocolField(name, {choices:[instrumentA,instrumentB],assignments:{'a.raw':'a','b.raw':'b'}});
  const snapshot = bridge.buildSnapshot();
  assert.equal(snapshot.protocolFields[name].choices.length,2);
  assert.equal(snapshot.protocolFields[name].assignments['b.raw'],'b');
  assert.match(snapshot.protocolIssues.join('\n'),/comment\[instrument\].*c.raw/);
  assert.equal(snapshot.protocolColumns.find(c=>c.name===protocol.PROTOCOL_COLUMNS.modifications).requirement,'required');
  assert.equal(snapshot.protocolColumns.find(c=>c.name===protocol.PROTOCOL_COLUMNS.fragmentMassTolerance).requirement,'recommended');
  snapshot.protocolFields[name].assignments['a.raw']='b';
  assert.equal(wizard.getState().protocolFields[name].assignments['a.raw'],'a');
});

test('protocol cards: legacy preview and apply reject silent replacement of manual assignments', async () => {
  const {wizard,bridge} = protocolAssistantFixture(), name = protocol.PROTOCOL_COLUMNS.instrument;
  wizard.setProtocolField(name,{choices:[instrumentA,instrumentB],assignments:{'a.raw':'a','b.raw':'b','c.raw':'b'}});
  const before=JSON.stringify(wizard.getState()), action={op:'setInstrument',args:[instrumentA.value]};
  assert.match(bridge.previewAction(action),/Invalid suggestion:.*protected/);
  await assert.rejects(bridge.applyAction(action),/setProtocolValue/);
  assert.equal(JSON.stringify(wizard.getState()),before);
});

test('protocol cards: two scoped instruments compose without assigning untouched files or losing candidates', async () => {
  const {wizard,bridge} = protocolAssistantFixture(), name=protocol.PROTOCOL_COLUMNS.instrument;
  await bridge.applyAction({op:'setProtocolValue',args:[name,instrumentA.value,['a.raw']]});
  assert.equal(protocol.protocolValueForFile(wizard.getState(),name,'b.raw'),undefined);
  assert.equal(wizard.isStep5Valid(),false);
  const action={op:'setProtocolValue',args:[name,instrumentB.value,['b.raw','c.raw']]};
  assert.match(bridge.previewAction(action),/b.raw, c.raw/);
  assert.match(bridge.previewAction(action),/Other files and other fields are preserved/);
  const beforeTolerance=wizard.getState().precursorMassTolerance;
  await bridge.applyAction(action);
  assert.equal(wizard.getState().protocolFields[name].choices.length,2);
  assert.equal(wizard.isStep5Valid(),true);
  assert.equal(wizard.getState().precursorMassTolerance,beforeTolerance);
  const column=new WizardGeneratorService().generate(wizard.getState()).columns.find(c=>c.name===name);
  assert.deepEqual([1,2,3].map(row=>getValueForSample(column,row)),['NT=Q Exactive;AC=MS:1001911','NT=Orbitrap Fusion;AC=MS:1002416','NT=Orbitrap Fusion;AC=MS:1002416']);
  await bridge.applyAction(action);
  assert.equal(wizard.getState().protocolFields[name].choices.length,2);
});

test('protocol cards: explicit All previews every prior value and preserves reusable candidates', async () => {
  const {wizard,bridge}=protocolAssistantFixture(), name=protocol.PROTOCOL_COLUMNS.instrument;
  wizard.setProtocolField(name,{choices:[instrumentA,instrumentB],assignments:{'a.raw':'a','b.raw':'b','c.raw':'b'}});
  const action={op:'setProtocolValue',args:[name,instrumentA.value,'all']};
  const preview=bridge.previewAction(action);
  assert.match(preview,/ALL 3 raw files/); assert.match(preview,/Orbitrap Fusion \(2 files\)/);
  await bridge.applyAction(action);
  assert.equal(wizard.getState().protocolFields[name].choices.length,2);
  assert.equal(protocol.protocolValueForFile(wizard.getState(),name,'future.raw').label,'Q Exactive');
  assert.deepEqual(rawNames.map(file=>protocol.protocolValueForFile(wizard.getState(),name,file).label),['Q Exactive','Q Exactive','Q Exactive']);
});

test('protocol cards: stale file names, unsupported fields and malformed modifications fail atomically', async () => {
  const {wizard,bridge}=protocolAssistantFixture();
  const before=JSON.stringify(wizard.getState());
  for(const action of [
    {op:'setProtocolValue',args:[protocol.PROTOCOL_COLUMNS.instrument,instrumentA.value,['missing.raw']]},
    {op:'setProtocolValue',args:['comment[unknown]','value','all']},
    {op:'setProtocolValue',args:[protocol.PROTOCOL_COLUMNS.modifications,[{name:'Oxidation',type:'variable',unimodAccession:'UNIMOD:35'}],'all']},
    {op:'setModifications',args:[[{name:'Oxidation',type:'variable',unimodAccession:'UNIMOD:35'}]]},
    {op:'setProtocolValue',args:['technology type','not-an-option','all']},
    {op:'setProtocolValue',args:[protocol.PROTOCOL_COLUMNS.modifications,[],'all']},
  ]) {
    assert.match(bridge.previewAction(action),/^Invalid suggestion:/);
    await assert.rejects(bridge.applyAction(action));
    assert.equal(JSON.stringify(wizard.getState()),before);
  }
});

test('protocol cards: tolerance scope preserves untouched values, optional clearing is explicit and global', async () => {
  const {wizard,bridge}=protocolAssistantFixture(), name=protocol.PROTOCOL_COLUMNS.precursorMassTolerance;
  wizard.setInstrument(instrumentA.value);
  await bridge.applyAction({op:'setProtocolValue',args:[name,'20ppm',['b.raw']]});
  assert.equal(protocol.protocolOutputValue(wizard.getState(),name,'a.raw'),'10 ppm');
  assert.equal(protocol.protocolOutputValue(wizard.getState(),name,'b.raw'),'20 ppm');
  const before=JSON.stringify(wizard.getState());
  await assert.rejects(bridge.applyAction({op:'setPrecursorMassTolerance',args:['10 ppm']}),/protected/);
  await assert.rejects(bridge.applyAction({op:'setProtocolValue',args:[name,'',['b.raw']]}),/cleared/);
  assert.equal(JSON.stringify(wizard.getState()),before);
  await bridge.applyAction({op:'setProtocolValue',args:[name,'','all']});
  assert.equal(wizard.isStep5Valid(),true);
  assert.equal(new WizardGeneratorService().generate(wizard.getState()).columns.some(c=>c.name===name),false);
});

test('protocol cards: initial legacy cards work and replay safely but cannot overwrite a preceding card', async () => {
  const {wizard,bridge}=protocolAssistantFixture(), name=protocol.PROTOCOL_COLUMNS.instrument;
  const original={op:'setInstrument',args:[instrumentA.value]};
  await bridge.applyAction(original);
  const before=JSON.stringify(wizard.getState());
  await bridge.applyAction(original);
  assert.equal(JSON.stringify(wizard.getState()),before);
  await assert.rejects(bridge.applyAction({op:'setInstrument',args:[instrumentB.value]}),/protected/);
  assert.equal(protocol.protocolValueForFile(wizard.getState(),name,'b.raw').label,'Q Exactive');
});

test('protocol cards: separate modification sets export correctly and generic file values survive', async () => {
  const {wizard,bridge}=protocolAssistantFixture(), name=protocol.PROTOCOL_COLUMNS.modifications;
  const carb=wizard.getState().modifications[0];
  const ox={name:'Oxidation',targetAminoAcids:'M',type:'variable',position:'Anywhere',unimodAccession:'UNIMOD:35'};
  await bridge.applyAction({op:'setProtocolValue',args:[name,[carb,ox],['a.raw']]});
  await bridge.applyAction({op:'setProtocolValue',args:[name,[ox],['b.raw','c.raw']]});
  await bridge.applyAction({op:'setProtocolValue',args:['technology type','other technology',['c.raw']]});
  const table=new WizardGeneratorService().generate(wizard.getState());
  const mods=table.columns.filter(c=>c.name===name);
  assert.equal(mods.length,2);
  assert.match(getValueForSample(mods[0],1),/Carbamidomethyl/);
  assert.match(getValueForSample(mods[0],2),/Oxidation/);
  assert.equal(getValueForSample(mods[1],2),'not applicable');
  const snapshot=bridge.buildSnapshot();
  assert.equal(snapshot.protocolFields['technology type'].choices.length,2);
});

test('protocol cards: automatic repair cannot broaden or change file scope', () => {
  const {repairScopeError}=load('src/app/core/utils/auto-annotation.ts');
  const original={id:'first',action:{step:'protocol',op:'setProtocolValue',args:[protocol.PROTOCOL_COLUMNS.instrument,instrumentA.value,['a.raw']]}};
  for(const scope of ['all',['b.raw']]) {
    const replacement={id:'second',action:{...original.action,args:[protocol.PROTOCOL_COLUMNS.instrument,instrumentA.value,scope]}};
    assert.match(repairScopeError(original,replacement),/scope/);
  }
});

test('validation: invalid sample counts preserve state and block setup until corrected', () => {
  const {wizard}=assistantFixture(); const before=wizard.getState();
  for(const count of [0,2.5,NaN,Infinity,10001]) {
    wizard.setSampleCount(count); assert.equal(wizard.getState(),before);
    assert.ok(wizard.sampleCountError()); assert.equal(wizard.isStep1Valid(),false);
  }
  wizard.setSampleCount(1001); assert.equal(wizard.getState().samples.length,1001);
  assert.equal(wizard.sampleCountError(),'');
  wizard.setSampleCount(2.5); wizard.reset(); assert.equal(wizard.sampleCountError(),'');
});

test('validation: characteristic template constraints and old card operations reject invalid edits atomically', async()=>{
  const {wizard,bridge}=assistantFixture();
  const column={name:'characteristics[sex]',requirement:'required',validators:[{validatorName:'values',params:{values:['male','female']}}]};
  wizard._state.update(s=>({...s,effectiveColumns:[column],characteristicColumns:[column],factorDecision:'none',noFactorReason:'descriptive study'}));
  const before=JSON.stringify(wizard.getState());
  for(const action of [
    {op:'applyCharacteristicDraft',args:[column.name,[{value:'invalid'}],'explicit',wizard.getState().samples.map(()=> 'invalid')]},
    {op:'addCharacteristicChoice',args:['characteristics[typo]','example']},
    {op:'addCharacteristicChoice',args:[column.name,'invalid']},
    {op:'setSampleCharacteristicValue',args:[0,column.name,'male']},
  ]) { await assert.rejects(()=>bridge.applyAction(action)); assert.equal(JSON.stringify(wizard.getState()),before); }
  await bridge.applyAction({op:'addCharacteristicChoice',args:[column.name,'male']});
  await bridge.applyAction({op:'setSampleCharacteristicValue',args:[0,column.name,'male']});
  wizard._state.update(s=>({...s,characteristicChoices:{[column.name]:[{value:'invalid'}]}}));
  assert.equal(wizard.isStep3Valid(),false);
});

test('validation: removing a pooled member invalidates packing; two surviving distinct members remain valid',()=>{
  const {wizard}=assistantFixture(); wizard.setSampleCount(2); const run=wizard.getState().msRuns[0];
  wizard._state.update(s=>({...s,labelConfigId:'lf',msRuns:[{...run,labelConfigId:'lf',channels:[{label:'label free sample',role:'pooled',pooledSampleIndices:[1,2]}]}],dataFiles:[{fileName:'pool.raw',runId:run.id}]}));
  const {validateRunsAndFiles}=load('src/app/core/models/wizard.ts');
  assert.equal(validateRunsAndFiles(wizard.getState()),true);
  wizard.setSampleCount(1); assert.equal(validateRunsAndFiles(wizard.getState()),false);
  wizard.setSampleCount(2); assert.equal(validateRunsAndFiles(wizard.getState()),true);
  wizard._state.update(s=>({...s,msRuns:s.msRuns.map(r=>({...r,channels:[{label:'label free sample',role:'pooled',pooledSampleIndices:[1,1]}]}))}));
  assert.equal(validateRunsAndFiles(wizard.getState()),false);
});

test('validation: malformed instrument accession fails both old and scoped cards without mutation',async()=>{
 const {wizard,bridge}=protocolAssistantFixture(); const before=JSON.stringify(wizard.getState());
 for(const id of ['not-an-accession','MS:1','NCBITaxon:9606']) {
   for(const action of [{op:'setInstrument',args:[{id,label:'Q Exactive'}]},{op:'setProtocolValue',args:['comment[instrument]',{id,label:'Q Exactive'},'all']}]) await assert.rejects(()=>bridge.applyAction(action),/accession/i);
 }
 assert.equal(JSON.stringify(wizard.getState()),before);
 await bridge.applyAction({op:'setProtocolValue',args:['comment[instrument]',{id:'MS:1001911',label:'Q Exactive'},'all']});
});

test('validation: review discards stale success and failure while retaining the latest result',async()=>{
  // Execute the component's actual effect and request methods with deferred service responses.
  const source=readFileSync(resolve(root,'src/app/components/sdrf-wizard/steps/review-create.component.ts'),'utf8');
  const methods=source.slice(source.indexOf('  constructor() {'),source.indexOf('  getDiseaseLabel(): string'));
  let refresh;
  const context={effect:fn=>{refresh=fn;}};
  vm.createContext(context);
  vm.runInContext(ts.transpileModule('class ReviewAudit {'+methods+'};globalThis.ReviewAudit=ReviewAudit;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
  const review=new context.ReviewAudit();
  let current={metadata:{templateSnapshotId:'s'},columns:['A'],sampleCount:1}; const requests=[];
  Object.assign(review,{lastValidatedKey:'',validationRequest:0,previewTable:()=>current,wizardState:{isAllValid:()=>true},state:()=>({templateSnapshotId:'s',selectedTemplates:[]}),exporter:{exportToTsv:t=>JSON.stringify(t.columns)},templateService:{validateTable:()=>new Promise((resolve,reject)=>requests.push({resolve,reject}))},validationRunning:signal(false),validationDone:signal(false),validationFailed:signal(false),validationErrorMessage:signal(''),validationIssues:signal([])});
  refresh(); current={...current,columns:['B']}; refresh();
  assert.equal(requests.length,2);
  requests[1].resolve([{message:'B'}]); await new Promise(resolve=>setImmediate(resolve));
  requests[0].reject(new Error('old request failed')); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(review.validationIssues()[0].message,'B'); assert.equal(review.validationFailed(),false);
  current={...current,columns:['C']};refresh();current={...current,columns:['D']};refresh();
  requests[2].resolve([{message:'C'}]);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(review.validationDone(),false); assert.equal(review.validationRunning(),true);
  requests[3].resolve([]);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(review.validationDone(),true);assert.equal(review.validationIssues().length,0);
});

test('partial protocol fields permit only template-approved unknown cells and export them without copying another file value',()=>{
 const wizard=protocolFixture();
 const name='comment[collision energy]';
 const column={name,requirement:'optional',allowNotAvailable:true};
 wizard._state.update(s=>({...s,effectiveColumns:[...s.effectiveColumns,column]}));
 wizard.setProtocolField(name,{choices:[{id:'ce',value:'30 NCE'}],assignments:{'a.raw':'ce'}});
 assert.equal(protocol.protocolFieldError(wizard.getState(),column),'');
 assert.match(protocol.protocolFieldError(wizard.getState(),{...column,requirement:'required'}),/2 raw files/);
 assert.match(protocol.protocolFieldError(wizard.getState(),{...column,allowNotAvailable:false}),/2 raw files/);
 assert.equal(protocol.protocolFieldError(wizard.getState(),{...column,requirement:'recommended'}),'');
 assert.equal(protocol.protocolOutputValue(wizard.getState(),name,'a.raw'),'30 NCE');
 assert.equal(protocol.protocolOutputValue(wizard.getState(),name,'b.raw'),'not available');
 const state={...wizard.getState(),templateSnapshotId:snapshotId,leafTemplateRefs:[{name:'new-platform',version:'2.0.0'}]};
 const table=new WizardGeneratorService().generate(state);
 const generated=table.columns.find(c=>c.name===name);
 assert.deepEqual([1,2,3].map(i=>getValueForSample(generated,i)),['30 NCE','not available','not available']);
});

test('replacement factor batch uses latest full definition before per-sample assignments',async()=>{
 const {wizard,bridge}=assistantFixture();wizard.setSampleCount(2);
 const old={id:'old',action:{step:'samples',op:'setFactors',args:[[{name:'treatment',enabled:true,scope:'sample',sourceCharacteristic:'characteristics[treatment]',values:[]}]]}};
 const replacement={id:'new',action:{step:'samples',op:'setFactors',args:[[{name:'treatment',enabled:true,scope:'sample',values:['control','treated']}]]}};
 const assignments={id:'values',action:{step:'samples',op:'setFactorColumnValues',args:['treatment',['control','treated']]}};
 await assert.rejects(()=>bridge.applyAction(old.action),/candidate values/);
 const {orderAutoCards}=load('src/app/core/utils/auto-annotation.ts');
 for(const card of orderAutoCards([old,assignments,replacement]))await bridge.applyAction(card.action);
 assert.equal(wizard.getState().factors[0].sourceCharacteristic,undefined);
 assert.deepEqual(Array.from(wizard.getState().samples,s=>s.factorValues.treatment),['control','treated']);
});

test('new label kits apply through AI cards and export every channel with its sample', async () => {
  const { LABEL_CONFIGS } = load('src/app/core/models/wizard.ts');
  for (const id of ['dimethyl2plex','dimethyl2plex08','dimethyl3plex','dimethyl5plex','mtraq3plex','icat2plex','icpl4plex','15n2plex','13c2plex','18o2plex','tmt32','tmt34','tmt35','itraq4']) {
    const { wizard, bridge } = assistantFixture();
    const config = LABEL_CONFIGS.find(c => c.id === id);
    assert.equal(new Set(config.labels).size, config.labels.length);
    const state = wizard.getState();
    state.templateSnapshotId = snapshotId;
    state.leafTemplateRefs = [{name:'new-platform',version:'2.0.0'}];
    state.sampleCount = config.labels.length;
    state.samples = config.labels.map((_, i) => ({...state.samples[0], index:i+1, sourceName:`sample_${i+1}`}));
    state.msRuns = [];
    state.dataFiles = [{fileName:'multiplex.raw'}];
    state.factors = [];
    state.effectiveColumns = [{name:'source name',requirement:'required'}, {name:'comment[label]',requirement:'required'}, {name:'comment[data file]',requirement:'required'}];
    wizard.hydrate(state);
    const advertised = bridge.buildSnapshot().availableLabelConfigs.find(c => c.id === id);
    assert.equal(JSON.stringify(advertised.labels), JSON.stringify(config.labels));
    await bridge.applyAction({op:'setLabelConfig',args:[id]});
    await bridge.applyAction({op:'applyRunsFilesPlan',args:[{groups:[{name:'plex',labelConfigId:id,
      channels:config.labels.map((label,i)=>({label,sourceName:`sample_${i+1}`})),
      files:[{fileName:'multiplex.raw',fractionId:1,technicalReplicate:1}]}]}]});
    const table = new WizardGeneratorService().generate(wizard.getState());
    const labelColumn = table.columns.find(c=>c.name==='comment[label]');
    const sourceColumn = table.columns.find(c=>c.name==='source name');
    config.labels.forEach((label,i)=>{
      assert.equal(getValueForSample(labelColumn,i+1),label.replace(/^iTRAQ4plex-/, 'ITRAQ'));
      assert.equal(getValueForSample(sourceColumn,i+1),`sample_${i+1}`);
    });
    const before = JSON.stringify(wizard.getState());
    await assert.rejects(bridge.applyAction({op:'applyRunsFilesPlan',args:[{groups:[{name:'plex',labelConfigId:id,
      channels:[{label:'invented channel',sourceName:'sample_1'}], files:[{fileName:'multiplex.raw',fractionId:1,technicalReplicate:1}]}]}]}));
    assert.equal(JSON.stringify(wizard.getState()),before);
  }
});
