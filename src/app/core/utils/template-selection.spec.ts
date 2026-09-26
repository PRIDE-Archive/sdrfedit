import { templateFieldError } from '../models/wizard.ts';
import assert from 'node:assert/strict';
import { it } from 'node:test';
import { selectedTemplateIds } from './template-selection.ts';
import { templateOptions, genericTemplateColumns, templateFieldValue } from './template-fields.ts';

it('migrates arbitrary legacy selections without classifying names', () => {
  assert.deepEqual(selectedTemplateIds({ technologyTemplate: 'new-tech', sampleTemplate: 'unknown',
    sampleMetadataTemplates: ['unknown', 'other'], experimentTemplates: ['new-experiment'] }),
  ['new-tech', 'unknown', 'other', 'new-experiment']);
});
it('canonical empty selection overrides legacy fields', () => {
  assert.deepEqual(selectedTemplateIds({ selectedTemplates: [], technologyTemplate: 'old', sampleTemplate: 'old', experimentTemplates: [] }), []);
});
it('generic enum controls intersect inherited value constraints and preserve explicit values', () => {
  const column = { name: 'technology type', requirement: 'required', validators: [
    { validatorName: 'values', params: { values: ['first', 'second'] } },
    { validatorName: 'values', params: { values: ['second'] } },
  ] };
  assert.deepEqual(templateOptions(column), ['second']);
  assert.equal(templateFieldValue({}, column), 'second');
  assert.equal(templateFieldValue({ dynamicTemplateValues: { 'technology type': '' } }, column), '');
  assert(templateFieldError(column, 'first'));
  assert.equal(templateFieldError(column, 'second'), '');
});
it('unknown technical columns receive controls and reserved flags remain strict', () => {
  const column = { name: 'comment[future platform]', requirement: 'required', allowNotAvailable: false };
  assert.equal(genericTemplateColumns({ effectiveColumns: [column] })[0], column);
  assert(templateFieldError(column, 'not available'));
  assert.equal(templateFieldError({ ...column, allowNotAvailable: true }, 'not available'), '');
});

it('enumerated reserved values work without a flag; explicit prohibition and other constraints still win', () => {
  const column = { name:'characteristics[pooled sample]',requirement:'optional',validators:[
    {validatorName:'values',params:{values:['not pooled','pooled'],errorLevel:'warning'}},
  ] };
  assert.equal(templateFieldError(column,'pooled'),'');
  assert.ok(templateFieldError({...column,allowPooled:false},'pooled'));
  assert.ok(templateFieldError({...column,type:'integer'},'pooled'));
  assert.ok(templateFieldError({...column,validators:[{validatorName:'pattern',params:{pattern:'.*'}}]},'pooled'));
  assert.ok(templateFieldError({...column,validators:[{validatorName:'values',params:{values:['POOLED'],case_sensitive:true}}]},'pooled'));
});
