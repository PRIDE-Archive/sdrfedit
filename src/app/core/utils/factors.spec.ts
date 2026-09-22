import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createEmptyWizardState, createDefaultSample, normalizeFactor, factorCandidates,
  resolveFactorValue, factorDefinitionErrors, factorAssignmentsValid, factorDecisionValid, resolveRunFactorValue, runFactorAssignmentsValid } from '../models/wizard.ts';
import { equivalentFactorValue } from './factor-values.ts';

describe('study factors', () => {
  it('does not select disease for a new study', () => {
    assert.deepEqual(createEmptyWizardState().factors, []);
  });
  it('links drug treatment while retaining shared disease as background', () => {
    const state = createEmptyWizardState();
    state.characteristicChoices = {
      'characteristics[disease]': [{value: 'breast carcinoma'}],
      'characteristics[compound]': [{value: 'untreated'}, {value: 'drug A'}],
    };
    const factor = normalizeFactor({name: 'compound', sourceCharacteristic: 'characteristics[compound]', reasoning: 'Methods compares treatments'});
    state.factors = [factor];
    state.samples = [createDefaultSample(1), createDefaultSample(2)];
    state.samples[0].characteristicValues = {'characteristics[compound]': 'untreated'};
    state.samples[1].characteristicValues = {'characteristics[compound]': 'drug A'};
    state.samples[0].factorValues = {compound: 'wrong stored override'};
    assert.deepEqual(factorCandidates(state, factor), ['untreated', 'drug A']);
    assert.equal(resolveFactorValue(state, state.samples[0], factor), 'untreated');
    assert.equal(factorAssignmentsValid(state), true);
    state.samples[1].characteristicValues = {};
    assert.equal(factorAssignmentsValid(state), false);
    assert.equal(resolveFactorValue(state, state.samples[1], factor), '');
  });
  it('keeps disease comparisons, time courses and multiple dimensions available', () => {
    const state = createEmptyWizardState();
    state.factors = [normalizeFactor({name:'disease', values:['normal', 'breast carcinoma']}),
      normalizeFactor({name:'time', values:['0 hour', '24 hour']})];
    assert.deepEqual(factorDefinitionErrors(state), []);
    state.samples = [createDefaultSample(1)];
    state.samples[0].factorValues = {disease:'normal', time:'24 hour'};
    assert.equal(factorAssignmentsValid(state), true);
    state.samples[0].factorValues.time = '48 hour';
    assert.equal(factorAssignmentsValid(state), false);
  });
  it('rejects duplicate names and missing or invalid linked sources', () => {
    const state = createEmptyWizardState();
    state.factors = [normalizeFactor({name:'Disease', values:['normal']}), normalizeFactor({name:'disease', values:['normal']})];
    assert.ok(factorDefinitionErrors(state).some(e => e.includes('Duplicate')));
    state.factors = [normalizeFactor({name:'time', sourceCharacteristic:'comment[time]'})];
    assert.ok(factorDefinitionErrors(state).length);
  });
  it('preserves legacy independent groups and never selects the first of multiple groups for a missing sample', () => {
    const factor = normalizeFactor({name:'Disease', values:['normal', 'breast carcinoma']});
    const state = createEmptyWizardState();
    assert.equal(factor.sourceCharacteristic, undefined);
    assert.equal(factor.name, 'Disease');
    assert.equal(resolveFactorValue(state, createDefaultSample(1), factor), '');
    assert.equal(normalizeFactor({name:'disease', defaultValue:'normal'}).values[0], 'normal');
  });
  it('compares SDRF labels and accessions without hiding swapped rows', () => {
    assert.equal(equivalentFactorValue('normal', 'breast carcinoma'), false);
    assert.equal(equivalentFactorValue('normal', 'NT=normal;AC=PATO:0000461'), true);
    assert.equal(equivalentFactorValue('NT=normal;AC=PATO:0000461', 'NT=healthy;AC=PATO:0000461'), true);
    assert.equal(equivalentFactorValue('NT=normal;AC=X:1', 'NT=normal;AC=X:2'), false);
  });
});

describe('technical comparisons and explicit no-factor decisions', () => {
  it('keeps unresolved and explicitly factor-free designs distinct', () => {
    const state = createEmptyWizardState();
    assert.equal(factorDecisionValid(state), false);
    state.factorDecision = 'none';
    assert.equal(factorDecisionValid(state), false);
    state.noFactorReason = 'Descriptive inventory; no factor encoded.';
    assert.equal(factorDecisionValid(state), true);
    state.factors = [normalizeFactor({name:'disease', values:['normal']})];
    assert.equal(factorDecisionValid(state), false);
  });
  it('assigns DT and DDNL to two runs of one biological sample', () => {
    const state = createEmptyWizardState();
    state.samples = [createDefaultSample(1)];
    const factor = normalizeFactor({name:'strategy', scope:'run', values:['DT','DDNL']});
    state.factors = [factor];
    state.msRuns = ['DT','DDNL'].map((value, i) => ({id:`r${i}`,name:`run${i}`,factorValues:{strategy:value},channels:[{label:'label free sample',sampleIndex:1,role:'sample'}]}));
    assert.equal(factorAssignmentsValid(state), true);
    assert.equal(runFactorAssignmentsValid(state), true);
    assert.equal(resolveRunFactorValue(state.msRuns[0], factor), 'DT');
    assert.equal(resolveRunFactorValue(state.msRuns[1], factor), 'DDNL');
    state.msRuns[1].factorValues = {};
    assert.equal(runFactorAssignmentsValid(state), false);
    assert.equal(resolveRunFactorValue(state.msRuns[1], factor), '');
    state.msRuns[1].factorValues = {strategy:'CID'};
    assert.equal(runFactorAssignmentsValid(state), false);
    factor.sourceCharacteristic = 'characteristics[disease]';
    assert.ok(factorDefinitionErrors(state).length);
  });
});
