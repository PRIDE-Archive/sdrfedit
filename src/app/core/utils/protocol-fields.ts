import { templateFieldError } from '../models/wizard';
import type { ProtocolChoice, ProtocolField, ProtocolValue, WizardState, WizardModification } from '../models/wizard';
import type { TemplateColumn } from '../models/template';
import { genericTemplateColumns, templateFieldValue } from './template-fields';
import { isValidMassTolerance, normalizeMassTolerance } from './mass-tolerance';

export const PROTOCOL_COLUMNS = {
  instrument: 'comment[instrument]',
  cleavageAgent: 'comment[cleavage agent details]',
  modifications: 'comment[modification parameters]',
  precursorMassTolerance: 'comment[precursor mass tolerance]',
  fragmentMassTolerance: 'comment[fragment mass tolerance]',
} as const;

// Wizard completion policy; the resolved template schema remains unchanged.
const REQUIRED_PROTOCOL_PARAMETERS = new Set<string>([PROTOCOL_COLUMNS.modifications]);
const RECOMMENDED_PROTOCOL_PARAMETERS = new Set<string>([
  PROTOCOL_COLUMNS.precursorMassTolerance,
  PROTOCOL_COLUMNS.fragmentMassTolerance,
]);

function protocolRequirement(column: TemplateColumn): TemplateColumn['requirement'] {
  if (REQUIRED_PROTOCOL_PARAMETERS.has(column.name)) return 'required';
  if (RECOMMENDED_PROTOCOL_PARAMETERS.has(column.name)) return 'recommended';
  return column.requirement;
}

export function protocolColumns(state: WizardState): TemplateColumn[] {
  const generic = new Set(genericTemplateColumns(state).map(c => c.name));
  return (state.effectiveColumns || []).filter(c => generic.has(c.name) || Object.values(PROTOCOL_COLUMNS).some(name => name === c.name))
    .map(column => ({ ...column, requirement: protocolRequirement(column) }));
}

export function legacyProtocolValue(state: WizardState, name: string): ProtocolValue {
  const key = (Object.keys(PROTOCOL_COLUMNS) as Array<keyof typeof PROTOCOL_COLUMNS>).find(key => PROTOCOL_COLUMNS[key] === name);
  if (key) return state[key] ?? '';
  const column = state.effectiveColumns?.find(c => c.name === name);
  return column ? templateFieldValue(state, column) : '';
}

export function protocolField(state: WizardState, name: string): ProtocolField {
  if (state.protocolFields?.[name]) return state.protocolFields[name];
  const value = legacyProtocolValue(state, name);
  const hasValue = Array.isArray(value) ? value.length > 0 : typeof value === 'string' ? !!value.trim() : !!value;
  return { choices: hasValue ? [{ id: 'legacy', value }] : [], allChoiceId: hasValue ? 'legacy' : undefined, assignments: {} };
}

export function protocolChoiceForFile(field: ProtocolField, fileName: string): ProtocolChoice | undefined {
  const id = field.allChoiceId ?? field.assignments[fileName];
  return field.choices.find(c => c.id === id);
}

export function protocolValueForFile(state: WizardState, name: string, fileName: string): ProtocolValue | undefined {
  return protocolChoiceForFile(protocolField(state, name), fileName)?.value;
}

/** Adding a second candidate preserves current assignments but requires explicit mapping for future files. */
export function addProtocolChoice(field: ProtocolField, choice: ProtocolChoice, fileNames: string[]): ProtocolField {
  if (!field.choices.length) return { choices: [choice], allChoiceId: choice.id, assignments: {} };
  const assignments = field.allChoiceId
    ? Object.fromEntries(fileNames.map(name => [name, field.allChoiceId!])) : { ...field.assignments };
  return { choices: [...field.choices, choice], assignments };
}

export function assignProtocolChoice(field: ProtocolField, id: string, fileNames: string[], selected: Set<string>, all = false): ProtocolField {
  if (!field.choices.some(c => c.id === id)) throw new Error('Select an existing value.');
  if (all) return { ...field, allChoiceId: id, assignments: {} };
  const assignments: Record<string, string> = {};
  for (const name of fileNames) {
    const previous = protocolChoiceForFile(field, name)?.id;
    if (selected.has(name)) assignments[name] = id;
    else if (previous && previous !== id) assignments[name] = previous;
  }
  return { choices: field.choices, assignments };
}

export function removeProtocolChoice(field: ProtocolField, id: string): ProtocolField {
  return { choices: field.choices.filter(c => c.id !== id),
    allChoiceId: field.allChoiceId === id ? undefined : field.allChoiceId,
    assignments: Object.fromEntries(Object.entries(field.assignments).filter(([, value]) => value !== id)) };
}

export function protocolValueLabel(value: ProtocolValue): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(m => `${m.name} (${m.targetAminoAcids}, ${m.type}${m.position && m.position !== 'Anywhere' ? ', ' + m.position : ''})`).join(' · ');
  return 'label' in value ? value.label : value.name;
}

export function protocolValueError(column: TemplateColumn, value: ProtocolValue | undefined): string {
  if (value === undefined || value === '' || (Array.isArray(value) && !value.length)) return 'Add a value.';
  if (column.name === PROTOCOL_COLUMNS.instrument) return !Array.isArray(value) && typeof value === 'object' && 'label' in value && value.label.trim() && /^MS:\d{7}$/.test(value.id) ? '' : 'Select an instrument with a valid MS accession (MS: followed by 7 digits).';
  if (column.name === PROTOCOL_COLUMNS.cleavageAgent) return !Array.isArray(value) && typeof value === 'object' && 'msAccession' in value ? '' : 'Select a cleavage agent.';
  if (column.name === PROTOCOL_COLUMNS.modifications) return Array.isArray(value) && value.every(m => m.name.trim() && m.targetAminoAcids.trim() && ['fixed', 'variable'].includes(m.type)) ? '' : 'Complete each modification.';
  if (column.name === PROTOCOL_COLUMNS.precursorMassTolerance || column.name === PROTOCOL_COLUMNS.fragmentMassTolerance) return isValidMassTolerance(value) ? '' : 'Enter a positive number with ppm, Da, or mmu, or not available.';
  return typeof value === 'string' ? templateFieldError(column, value) : 'Enter a text value.';
}

export function protocolFieldError(state: WizardState, column: TemplateColumn): string {
  const field = protocolField(state, column.name);
  if (!field.choices.length) return protocolRequirement(column) === 'required' ? 'This field is required.' : '';
  if (field.choices.some(c => protocolValueError(column, c.value))) return 'Correct invalid values.';
  const missing = state.dataFiles.filter(f => !protocolChoiceForFile(field, f.fileName)).length;
  if (!missing) return '';
  // Unknown non-required cells export as not available; respect the template's permission.
  if (protocolRequirement(column) !== 'required' && !templateFieldError(column, 'not available')) return '';
  return `${missing} raw files still need a value.`;
}

export function serializeProtocolValue(value: ProtocolValue | undefined, modificationIndex = 0): string {
  if (value === undefined) return 'not available';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const mod: WizardModification | undefined = value[modificationIndex];
    if (!mod) return 'not applicable';
    return [`NT=${mod.name}`, ...(mod.unimodAccession ? [`AC=${mod.unimodAccession}`] : []), `MT=${mod.type}`, `TA=${mod.targetAminoAcids}`, ...(mod.position ? [`PP=${mod.position}`] : [])].join(';');
  }
  if ('label' in value) return value.id ? `NT=${value.label};AC=${value.id}` : value.label;
  return `NT=${value.name};AC=${value.msAccession}`;
}

export function protocolOutputValue(state: WizardState, name: string, fileName: string, index = 0): string {
  const value = protocolValueForFile(state, name, fileName);
  if (typeof value === 'string' && (name === PROTOCOL_COLUMNS.precursorMassTolerance || name === PROTOCOL_COLUMNS.fragmentMassTolerance)) return normalizeMassTolerance(value);
  return serializeProtocolValue(value, index);
}

/** Actionable completion feedback shared by the UI state snapshot and automatic annotation. */
export function protocolCompletionErrors(state: WizardState): string[] {
  return protocolColumns(state).flatMap(column => {
    const error = protocolFieldError(state, column);
    if (!error) return [];
    const field = protocolField(state, column.name);
    const missing = state.dataFiles.filter(file => !protocolChoiceForFile(field, file.fileName)).map(file => file.fileName);
    const invalid = field.choices.map(choice => protocolValueError(column, choice.value)).filter(Boolean);
    return [`${column.name}: ${invalid.length ? [...new Set(invalid)].join(' ') : error}${missing.length ? ` Unassigned raw files: ${missing.join(', ')}.` : ''}`];
  });
}
