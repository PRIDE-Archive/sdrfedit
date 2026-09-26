import type { ProtocolField, ProtocolValue, WizardState } from '../models/wizard';
import { protocolColumns, protocolField, protocolChoiceForFile, protocolValueError, protocolValueLabel } from './protocol-fields';

export type ProtocolScope = 'all' | string[];

/** Ignore object key order when matching an existing candidate. */
export function protocolValueKey(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(protocolValueKey).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => JSON.stringify(key) + ':' + protocolValueKey(v)).join(',') + '}';
  return JSON.stringify(value);
}

/** Validate a whole change before mutating anything. A file scope preserves every other file. */
export function planProtocolValue(state: WizardState, name: string, value: ProtocolValue, scope: ProtocolScope, legacy = false): { field: ProtocolField; preview: string } {
  const column = protocolColumns(state).find(c => c.name === name);
  if (!column) throw new Error(`No editable protocol field named ${name} in the selected templates.`);
  const field = protocolField(state, name);
  const empty = value === '' || (Array.isArray(value) && !value.length);
  if (empty && (scope !== 'all' || column.requirement === 'required')) throw new Error(`${name}: a required value cannot be cleared; optional fields can only be cleared for all files.`);
  if (!empty) {
    const error = protocolValueError(column, value);
    if (error) throw new Error(`${name}: ${error}`);
  }
  const files = [...new Set(state.dataFiles.map(file => file.fileName))];
  if (scope !== 'all') {
    const missing = scope.filter(file => !files.includes(file));
    if (missing.length) throw new Error(`Unknown raw file(s): ${missing.join(', ')}. Use exact names from the current snapshot.`);
    if (!scope.length) throw new Error('Select at least one raw file or explicitly use all.');
  }
  // Old global cards must never erase a manually configured field or a preceding scoped card.
  if (legacy && state.protocolFields?.[name]) {
    const shared = field.choices.find(choice => choice.id === field.allChoiceId);
    if ((empty && !field.choices.length) || (shared && protocolValueKey(shared.value) === protocolValueKey(value))) {
      return { field, preview: `${name}: unchanged; existing candidates and file assignments are preserved.` };
    }
    throw new Error(`${name}: existing candidates or file assignments are protected. Use setProtocolValue with an explicit file list or "all"; do not replace this field with a legacy global card.`);
  }
  const targets = scope === 'all' ? files : scope;
  const before = new Map<string, number>();
  for (const file of targets) {
    const old = protocolChoiceForFile(field, file)?.value;
    const label = old === undefined ? 'Unassigned' : protocolValueLabel(old);
    before.set(label, (before.get(label) || 0) + 1);
  }
  const scopeLabel = scope === 'all' ? `ALL ${files.length} raw files (including future files)` : `${targets.length} raw files: ${targets.join(', ')}`;
  const preview = `${name}\nApply to ${scopeLabel}\n${[...before].map(([label, count]) => `${label} (${count} files)`).join('; ') || 'No files yet'} → ${empty ? 'Clear field' : protocolValueLabel(value)}${scope === 'all' ? '\nReplaces this field’s assignments for all files.' : '\nOther files and other fields are preserved.'}`;
  if (empty) return { field: { choices: [], assignments: {} }, preview };
  const existing = field.choices.find(choice => protocolValueKey(choice.value) === protocolValueKey(value));
  const id = existing?.id ?? crypto.randomUUID();
  const choices = existing ? field.choices : [...field.choices, { id, value: structuredClone(value) }];
  if (scope === 'all') return { field: { choices, allChoiceId: id, assignments: {} }, preview };
  const selected = new Set(scope);
  const assignments = Object.fromEntries(files.flatMap(file => {
    const assigned = selected.has(file) ? id : protocolChoiceForFile(field, file)?.id;
    return assigned ? [[file, assigned]] : [];
  }));
  return { field: { choices, assignments }, preview };
}
