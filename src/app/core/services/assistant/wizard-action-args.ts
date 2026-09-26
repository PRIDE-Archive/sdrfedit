import type { ProtocolValue } from '../../models/wizard';
import type { ProtocolScope } from '../../utils/protocol-actions';
import { PROTOCOL_COLUMNS } from '../../utils/protocol-fields';
/**
 * Argument coercion for assistant-proposed wizard actions.
 *
 * The backend validates that an operation is allowed; these functions validate
 * that its arguments are actually usable, and fail with a message the user can
 * act on. Kept free of Angular so the rules stay easy to reason about and test.
 */

import { ACTION_CONTRACTS } from './action-contracts.generated';
import { normalizeMassTolerance } from '../../utils/mass-tolerance';

import {
  CharacteristicChoice,
  MODIFICATION_POSITIONS,
  ModificationPosition,
  OntologyTerm,
  WizardCleavageAgent,
  WizardFactor,
  WizardModification,
  normalizeFactor,
} from '../../models/wizard';

export const ACQUISITION_METHODS = ['dda', 'dia', 'prm', 'srm'] as const;
export type AcquisitionMethod = (typeof ACQUISITION_METHODS)[number];

/** Thrown when a proposed action cannot be applied; the message reaches the card. */
export class WizardActionError extends Error {}

export function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  throw new WizardActionError(`Expected a string but got ${JSON.stringify(value)}.`);
}

export function asNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new WizardActionError(`Expected a non-negative safe integer but got ${JSON.stringify(value)}.`);
  }
  return value;
}

export function asBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new WizardActionError(`Expected a boolean but got ${JSON.stringify(value)}.`);
}

/** One file row in assignFilesToRunsByName: [fileName, fractionId, technicalReplicate]. */
export interface NamedFileAssignment {
  fileName: string;
  fractionId: number;
  technicalReplicate: number;
}

/** One run group: { runName, files }. */
export interface NamedRunFileAssignment {
  runName: string;
  files: NamedFileAssignment[];
}

/**
 * Parse assignFilesToRunsByName args[0]:
 * [[runName, [[fileName, fractionId, tech], ...]], ...]
 * Also accepts legacy [[runName, [fileName, ...]], ...] (F/Tech default to 1).
 */
export function asNamedRunFileAssignments(value: unknown): NamedRunFileAssignment[] {
  if (!Array.isArray(value)) {
    throw new WizardActionError('assignFilesToRunsByName expects an array of [runName, files] pairs.');
  }
  const out: NamedRunFileAssignment[] = [];
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== 2) {
      throw new WizardActionError(
        `Each assignment must be [runName, files[]]; got ${JSON.stringify(row)}.`
      );
    }
    const runName = asString(row[0]).trim();
    if (!runName) throw new WizardActionError('Run name must be a non-empty string.');
    const filesRaw = row[1];
    if (!Array.isArray(filesRaw)) {
      throw new WizardActionError(`Files for "${runName}" must be an array.`);
    }
    const files: NamedFileAssignment[] = [];
    for (const entry of filesRaw) {
      if (typeof entry === 'string') {
        const fileName = entry.trim();
        if (!fileName) throw new WizardActionError("File name must not be empty.");
        files.push({ fileName, fractionId: 1, technicalReplicate: 1 });
        continue;
      }
      if (!Array.isArray(entry) || (entry.length < 1 || entry.length > 3)) {
        throw new WizardActionError(
          `Each file entry must be [fileName, fractionId, tech] or a file name string; got ${JSON.stringify(entry)}.`
        );
      }
      const fileName = asString(entry[0]).trim();
      if (!fileName) throw new WizardActionError("File name must not be empty.");
      const fractionId = entry.length > 1 ? asPositiveInteger(entry[1]) : 1;
      const technicalReplicate = entry.length > 2 ? asPositiveInteger(entry[2]) : 1;
      files.push({ fileName, fractionId, technicalReplicate });
    }
    out.push({ runName, files });
  }
  return out;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) throw new WizardActionError('Expected an array of strings.');
  const values = value.map(asString).map(entry => entry.trim());
  if (values.some(entry => !entry)) throw new WizardActionError('List entries must not be empty.');
  return values;
}

export function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new WizardActionError(`Expected an array of numbers but got ${JSON.stringify(value)}.`);
  }
  return value.map(asNumber);
}

export function asAcquisitionMethod(value: unknown): AcquisitionMethod {
  const method = asString(value).toLowerCase();
  if (!ACQUISITION_METHODS.includes(method as AcquisitionMethod)) {
    throw new WizardActionError(`Unknown acquisition method "${method}". Expected dda, dia, prm, or srm.`);
  }
  return method as AcquisitionMethod;
}

export function asOntologyTerm(value: unknown): OntologyTerm {
  const record = asRecord(value, 'ontology term');
  const id = typeof record['id'] === 'string' ? record['id'].trim() : '';
  const label = typeof record['label'] === 'string' ? record['label'].trim() : '';
  if (!id || !label) {
    throw new WizardActionError('An ontology term needs both an "id" and a "label".');
  }
  for (const key of ['iri', 'ontology', 'ontologyPrefix']) {
    if (record[key] !== undefined) asString(record[key]);
  }
  return {
    id,
    label,
    iri: typeof record['iri'] === 'string' ? record['iri'] : undefined,
    ontology: typeof record['ontology'] === 'string' ? record['ontology'] : undefined,
    ontologyPrefix: typeof record['ontologyPrefix'] === 'string' ? record['ontologyPrefix'] : undefined,
  };
}

/** Omitted terms allow free text; a malformed supplied term must not disappear. */
export function optionalOntologyTerm(value: unknown): OntologyTerm | undefined {
  if (value == null) return undefined;
  return asOntologyTerm(value);
}

export function asCleavageAgent(value: unknown): WizardCleavageAgent {
  const record = asRecord(value, 'cleavage agent');
  for (const key of ['msAccession', 'accession']) {
    if (record[key] !== undefined) asString(record[key]);
  }
  const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
  const accession =
    typeof record['msAccession'] === 'string'
      ? record['msAccession'].trim()
      : typeof record['accession'] === 'string'
        ? record['accession'].trim()
        : '';
  if (!name || !accession) {
    throw new WizardActionError('A cleavage agent needs a "name" and an "msAccession" (e.g. MS:1001251).');
  }
  return { name, msAccession: accession };
}

export function asModifications(value: unknown): WizardModification[] {
  if (!Array.isArray(value)) {
    throw new WizardActionError('Modifications must be an array.');
  }
  return value.map(asModification);
}

export function asModification(value: unknown): WizardModification {
  const record = asRecord(value, 'modification');
  const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
  if (!name) throw new WizardActionError('A modification needs a "name".');

  const type = record['type'] === undefined ? 'variable' : asString(record['type']).toLowerCase();
  if (type !== 'fixed' && type !== 'variable') {
    throw new WizardActionError(`Modification "${name}" has type "${type}"; expected fixed or variable.`);
  }

  const rawPosition = record['position'] === undefined ? 'Anywhere' : asString(record['position']);
  const position = MODIFICATION_POSITIONS.find(
    candidate => candidate.value.toLowerCase() === rawPosition.toLowerCase()
  )?.value;
  if (!position) {
    throw new WizardActionError(
      `Modification "${name}" has position "${rawPosition}". Expected one of: ` +
        MODIFICATION_POSITIONS.map(candidate => candidate.value).join(', ')
    );
  }

  const target = asString(record['targetAminoAcids'] ?? record['target'] ?? '').trim();
  if (!target) throw new WizardActionError('A modification needs a non-empty targetAminoAcids supported by evidence.');
  const accession = record['unimodAccession'] ?? record['accession'];
  const deltaMass = record['deltaMass'];
  if (deltaMass != null && (typeof deltaMass !== 'number' || !Number.isFinite(deltaMass))) {
    throw new WizardActionError('deltaMass must be a finite number.');
  }
  for (const key of ['targetAminoAcids', 'target', 'unimodAccession', 'accession']) {
    if (record[key] !== undefined) asString(record[key]);
  }

  return {
    name,
    targetAminoAcids: target,
    type: type as WizardModification['type'],
    position: position as ModificationPosition,
    unimodAccession: typeof accession === 'string' && accession.trim() ? accession.trim() : undefined,
    deltaMass: typeof deltaMass === 'number' ? deltaMass : undefined,
  };
}

export function asFactors(value: unknown): WizardFactor[] {
  if (!Array.isArray(value)) {
    throw new WizardActionError('Factors must be an array.');
  }
  return value.map(asFactor);
}

export function asFactor(value: unknown): WizardFactor {
  const record = asRecord(value, 'factor');
  const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
  if (!name) throw new WizardActionError('A factor needs a "name".');

  if (record['enabled'] !== undefined && typeof record['enabled'] !== 'boolean') {
    throw new WizardActionError('Factor enabled must be boolean.');
  }
  for (const key of ['sourceCharacteristic', 'reasoning', 'defaultValue']) {
    if (record[key] !== undefined) asString(record[key]);
  }
  const values = record['values'] === undefined ? [] : [...new Set(asStringArray(record['values']))];
  // Legacy drafts used defaultValue instead of a values list.
  if (!values.length && typeof record['defaultValue'] === 'string' && record['defaultValue'].trim()) {
    values.push(record['defaultValue'].trim());
  }

  if (record['scope'] !== undefined && record['scope'] !== 'sample' && record['scope'] !== 'run') {
    throw new WizardActionError('Factor scope must be sample or run.');
  }
  return normalizeFactor({ ...record, name, values });
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WizardActionError(`Expected an object for the ${what} but got ${JSON.stringify(value)}.`);
  }
  return value as Record<string, unknown>;
}


export function asCharacteristicDraft(args: unknown[]): {
  column: string; choices: CharacteristicChoice[]; assignments: string[];
} {
  if (args.length !== 4 || typeof args[0] !== 'string' || args[2] !== 'explicit'
      || !Array.isArray(args[1]) || !Array.isArray(args[3])) {
    throw new WizardActionError('Expected [column, choices, "explicit", assignments].');
  }
  const choices = args[1].map(value => {
    const choice = asRecord(value, 'characteristic choice');
    if (typeof choice['value'] !== 'string' || !choice['value'].trim()) {
      throw new WizardActionError('Every choice needs a non-empty value.');
    }
    return { value: choice['value'].trim(), ontologyTerm: optionalOntologyTerm(choice['ontologyTerm']) };
  });
  if (args[3].some(value => typeof value !== 'string')) {
    throw new WizardActionError('Assignments must be strings; use an empty string for an unassigned sample.');
  }
  return { column: args[0], choices, assignments: args[3].map(value => value.trim()) };
}

/** Replicate values, in current sample order; never sample indices. */
export function biologicalReplicateContract(sampleCount: number): string {
  return `setBiologicalReplicates expects exactly one argument: an array of ${sampleCount} positive integer replicate values in current sample order. These are values, not sample indices; there is no second argument. To set all samples to 1, use args=${JSON.stringify([Array(sampleCount).fill(1)])}. This action does not accept "pooled".`;
}

export function asBiologicalReplicates(args: unknown[], sampleCount: number): number[] {
  const values = args[0];
  if (args.length !== 1 || !Array.isArray(values) || values.length !== sampleCount ||
      values.some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)) {
    throw new WizardActionError(biologicalReplicateContract(sampleCount));
  }
  return [...values];
}

/** Optional repository locations accompanying a filename import. */
export function asFileUrls(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WizardActionError('File locations must be an object mapping exact file names to full download URLs.');
  }
  const result: Record<string, string> = Object.create(null);
  for (const [name, url] of Object.entries(value)) {
    if (!name.trim()) throw new WizardActionError('File name must not be empty.');
    if (typeof url !== 'string' || !/^(https?|ftp):\/\/[^\s/]+\//i.test(url)) {
      throw new WizardActionError(`Invalid repository download URL for ${name}. Use the URL returned by PRIDE; do not invent a path.`);
    }
    result[name] = url;
  }
  return result;
}

/** Position-sensitive assignments retain blanks for explicit clearing. */
export function asAssignments(value: unknown): string[] {
  if (!Array.isArray(value)) throw new WizardActionError('Expected one string per sample.');
  return value.map(asString).map(item => item.trim());
}

export function asPositiveInteger(value: unknown): number {
  const result = asNumber(value);
  if (result < 1) throw new WizardActionError('Expected a positive integer.');
  return result;
}


/** Shape-only checks shared by preview and apply. References are checked at apply time. */
export function asRunsFilesPlan(value: unknown): void {
  const plan = asRecord(value, 'plan');
  if (!Array.isArray(plan['groups']) || !plan['groups'].length) throw new WizardActionError('Plan needs groups.');
  for (const raw of plan['groups']) {
    const group = asRecord(raw, 'group');
    requiredName(group['name']); requiredName(group['labelConfigId']);
    if (group['sampleMappingMode'] !== undefined && group['sampleMappingMode'] !== 'rows') throw new WizardActionError('sampleMappingMode must be rows when provided.');
    if (!Array.isArray(group['channels']) || !group['channels'].length || !Array.isArray(group['files']) || !group['files'].length) throw new WizardActionError('Groups need channels and files.');
    for (const rawChannel of group['channels']) {
      const channel = asRecord(rawChannel, 'channel');
      requiredName(channel['label']);
      if (group['sampleMappingMode'] === 'rows') requiredName(channel['mappingId']);
      if (channel['pooledSourceNames'] !== undefined) {
        const sources = asStringArray(channel['pooledSourceNames']);
        if (channel['sourceName'] !== undefined || sources.length < 2 || new Set(sources).size !== sources.length) throw new WizardActionError('Use distinct pooled sources or a single sourceName.');
      } else requiredName(channel['sourceName']);
    }
    for (const rawFile of group['files']) {
      const file = asRecord(rawFile, 'file');
      requiredName(file['fileName']); asPositiveInteger(file['fractionId']); asPositiveInteger(file['technicalReplicate']);
      if (group['sampleMappingMode'] === 'rows') requiredName(file['mappingId']);
    }
    if (group['factorValues'] !== undefined) {
      for (const [key, value] of Object.entries(asRecord(group['factorValues'], 'factor values'))) { requiredName(key); asString(value); }
    }
  }
}

function requiredName(value: unknown): string {
  const result = asString(value).trim();
  if (!result) throw new WizardActionError('Expected a non-empty string.');
  return result;
}

export function asProtocolValue(name: string, value: unknown): ProtocolValue {
  if (name === PROTOCOL_COLUMNS.instrument) {
    const term = asOntologyTerm(value);
    if (!/^MS:\d{7}$/.test(term.id)) throw new WizardActionError('Instrument accession must be MS: followed by 7 digits.');
    return term;
  }
  if (name === PROTOCOL_COLUMNS.cleavageAgent) return asCleavageAgent(value);
  if (name === PROTOCOL_COLUMNS.modifications) return asModifications(value);
  if (name === PROTOCOL_COLUMNS.precursorMassTolerance || name === PROTOCOL_COLUMNS.fragmentMassTolerance) return normalizeMassTolerance(value);
  return asString(value).trim();
}

export function asProtocolScope(value: unknown): ProtocolScope {
  if (value === 'all') return value;
  const files = asStringArray(value);
  if (!files.length || new Set(files).size !== files.length) throw new WizardActionError('Protocol scope must be "all" or a non-empty list of unique raw file names.');
  return files;
}

export function validateActionArgs(op: string, raw: unknown, sampleCount?: number): unknown[] {
  const contract = ACTION_CONTRACTS[op];
  if (!contract) throw new WizardActionError(`Unsupported operation "${op}".`);
  if (!Array.isArray(raw)) throw new WizardActionError('Action args must be an array.');
  let args: unknown[] = [...raw];
  if (contract.normalize === 'stringList' && (!args.length || args.every(item => typeof item === 'string'))) args = [args];
  else if (contract.normalize === 'objectList' && args.length && args.every(item => item !== null && typeof item === 'object' && !Array.isArray(item))) args = [args];
  else if (contract.normalize === 'object' && args.length === 1 && Array.isArray(args[0]) && args[0].length === 1 && args[0][0] !== null && typeof args[0][0] === 'object' && !Array.isArray(args[0][0])) args = [args[0][0]];
  if (op === 'replaceWithUnassignedFileNames' && args.length && args.every(item => typeof item === 'string')) args = [args];
  if (op === 'setBiologicalReplicates') asBiologicalReplicates(args, sampleCount ?? (Array.isArray(args[0]) ? args[0].length : 0));
  if (args.length < contract.minArgs || args.length > contract.parameters.length) {
    throw new WizardActionError(`${op}: expected ${contract.minArgs}..${contract.parameters.length} arguments; example ${JSON.stringify(contract.example)}.`);
  }
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    switch (contract.parameters[i]) {
      case 'name': requiredName(value); break;
      case 'text': asString(value); break;
      case 'nullableName': if (value !== null) requiredName(value); break;
      case 'names': asStringArray(value); break;
      case 'assignments': asAssignments(value); break;
      case 'index': asNumber(value); break;
      case 'positiveInteger': asPositiveInteger(value); break;
      case 'sampleCount': if (asPositiveInteger(value) > 10000) throw new WizardActionError('Sample count must be between 1 and 10000.'); break;
      case 'indices': asNumberArray(value); break;
      case 'replicates': asBiologicalReplicates(args, sampleCount ?? (Array.isArray(value) ? value.length : 0)); break;
      case 'boolean': asBoolean(value); break;
      case 'acquisition': asAcquisitionMethod(value); break;
      case 'term': if (op === 'setInstrument') asProtocolValue(PROTOCOL_COLUMNS.instrument, value); else asOntologyTerm(value); break;
      case 'optionalTerm': optionalOntologyTerm(value); break;
      case 'enzyme': asCleavageAgent(value); break;
      case 'factor': asFactor(value); break;
      case 'factors': asFactors(value); break;
      case 'modifications': asModifications(value); break;
      case 'plan': asRunsFilesPlan(value); break;
      case 'fileUrls': asFileUrls(value); break;
      case 'namedAssignments': asNamedRunFileAssignments(value); break;
      case 'tolerance': normalizeMassTolerance(value); break;
      case 'protocolValue': asProtocolValue(asString(args[0]), value); break;
      case 'protocolScope': asProtocolScope(value); break;
      case 'explicit': if (value !== 'explicit') throw new WizardActionError('Expected explicit assignment mode.'); break;
      case 'choices': asCharacteristicDraft(args); break;
      default: throw new WizardActionError('Unknown parameter contract.');
    }
  }
  if (op === 'setSourceNames') {
    const names = asStringArray(args[0]);
    if (new Set(names).size !== names.length) throw new WizardActionError('Source names must be unique.');
  }
  const position = ({setSourceNames: 0, setBiologicalReplicates: 0, setFactorColumnValues: 1, applyCharacteristicDraft: 3} as Record<string, number>)[op];
  if (position !== undefined && sampleCount !== undefined && (args[position] as unknown[]).length !== sampleCount) {
    throw new WizardActionError(`${op}: expected exactly ${sampleCount} values in current sample order.`);
  }
  if (['setSampleCharacteristicValue', 'setSampleFactorValue'].includes(op) && sampleCount !== undefined && asNumber(args[0]) >= sampleCount) throw new WizardActionError('Sample index is out of range.');
  if (op === 'autoGenerateSourceNames' && (sampleCount === undefined || sampleCount > 1) && !asString(args[0]).includes('{n}')) throw new WizardActionError('Name pattern must contain {n} to produce unique source names.');
  return args;
}
