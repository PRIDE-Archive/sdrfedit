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
      Injectable: () => target => target, signal, computed: fn => fn, inject: () => templateService,
    };
    if (id.startsWith('.')) return load(resolve(dirname(file), `${id}.ts`));
    return require(id);
  };
  const compiled = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true },
  }).outputText;
  vm.runInNewContext(compiled, { exports, require: requireModule, console, Map, Set, Date, crypto: globalThis.crypto });
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
