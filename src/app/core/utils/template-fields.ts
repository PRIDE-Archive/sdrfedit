import type { TemplateColumn } from '../models/template';
import type { WizardState } from '../models/wizard';

// These are value adapters for existing controls, not template eligibility rules.
const ADAPTED_COLUMNS = new Set([
  'source name', 'assay name', 'comment[data file]', 'comment[technical replicate]',
  'comment[fraction identifier]', 'comment[label]', 'comment[proteomics data acquisition method]',
  'comment[instrument]', 'comment[cleavage agent details]', 'comment[modification parameters]',
  'comment[precursor mass tolerance]', 'comment[fragment mass tolerance]',
  'comment[sdrf version]', 'comment[sdrf template]',
]);

export function genericTemplateColumns(state: WizardState): TemplateColumn[] {
  return (state.effectiveColumns || []).filter(c => !c.name.startsWith('characteristics[') && !ADAPTED_COLUMNS.has(c.name));
}

export function templateOptions(column: TemplateColumn): string[] {
  const rules = (column.validators || []).filter(v => v.validatorName === 'values' && Array.isArray(v.params.values));
  if (!rules.length) return [];
  return rules[0].params.values!.map(String).filter(value => rules.every(rule =>
    rule.params.values!.some(candidate => rule.params['case_sensitive']
      ? String(candidate) === value : String(candidate).toLowerCase() === value.toLowerCase())));
}

export function templateFieldValue(state: WizardState, column: TemplateColumn): string {
  const explicit = state.dynamicTemplateValues?.[column.name];
  if (explicit !== undefined) return explicit;
  if (column.default !== undefined) return String(column.default);
  const options = templateOptions(column);
  return options.length === 1 ? options[0] : '';
}
