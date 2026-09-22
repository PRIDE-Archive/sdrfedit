/**
 * Argument coercion for assistant-proposed wizard actions.
 *
 * The backend validates that an operation is allowed; these functions validate
 * that its arguments are actually usable, and fail with a message the user can
 * act on. Kept free of Angular so the rules stay easy to reason about and test.
 */

import {
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
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new WizardActionError(`Expected a string but got ${JSON.stringify(value)}.`);
}

export function asNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    throw new WizardActionError(`Expected a number but got ${JSON.stringify(value)}.`);
  }
  return Math.trunc(parsed);
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
    if (!Array.isArray(row) || row.length < 2) {
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
        if (fileName) files.push({ fileName, fractionId: 1, technicalReplicate: 1 });
        continue;
      }
      if (!Array.isArray(entry) || entry.length < 1) {
        throw new WizardActionError(
          `Each file entry must be [fileName, fractionId, tech] or a file name string; got ${JSON.stringify(entry)}.`
        );
      }
      const fileName = asString(entry[0]).trim();
      if (!fileName) continue;
      const fractionId = entry.length > 1 ? Math.max(1, asNumber(entry[1])) : 1;
      const technicalReplicate = entry.length > 2 ? Math.max(1, asNumber(entry[2])) : 1;
      files.push({ fileName, fractionId, technicalReplicate });
    }
    out.push({ runName, files });
  }
  return out;
}

export function asStringArray(value: unknown): string[] {
  // Models sometimes emit a bare string for multi-value ops (e.g. setExperimentTemplates).
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (!Array.isArray(value)) {
    throw new WizardActionError(`Expected an array but got ${JSON.stringify(value)}.`);
  }
  return value.map(asString).map(entry => entry.trim()).filter(Boolean);
}

export function asNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new WizardActionError(`Expected an array of indices but got ${JSON.stringify(value)}.`);
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
  return {
    id,
    label,
    iri: typeof record['iri'] === 'string' ? record['iri'] : undefined,
    ontology: typeof record['ontology'] === 'string' ? record['ontology'] : undefined,
    ontologyPrefix: typeof record['ontologyPrefix'] === 'string' ? record['ontologyPrefix'] : undefined,
  };
}

/** A candidate value without a verified term is still usable as free text. */
export function optionalOntologyTerm(value: unknown): OntologyTerm | undefined {
  if (value == null) return undefined;
  try {
    return asOntologyTerm(value);
  } catch {
    return undefined;
  }
}

export function asCleavageAgent(value: unknown): WizardCleavageAgent {
  const record = asRecord(value, 'cleavage agent');
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

  const type = String(record['type'] ?? 'variable').toLowerCase();
  if (type !== 'fixed' && type !== 'variable') {
    throw new WizardActionError(`Modification "${name}" has type "${type}"; expected fixed or variable.`);
  }

  const rawPosition = String(record['position'] ?? 'Anywhere');
  const position = MODIFICATION_POSITIONS.find(
    candidate => candidate.value.toLowerCase() === rawPosition.toLowerCase()
  )?.value;
  if (!position) {
    throw new WizardActionError(
      `Modification "${name}" has position "${rawPosition}". Expected one of: ` +
        MODIFICATION_POSITIONS.map(candidate => candidate.value).join(', ')
    );
  }

  const accession = record['unimodAccession'] ?? record['accession'];
  const deltaMass = Number(record['deltaMass']);

  return {
    name,
    targetAminoAcids: String(record['targetAminoAcids'] ?? record['target'] ?? '').trim(),
    type: type as WizardModification['type'],
    position: position as ModificationPosition,
    unimodAccession: typeof accession === 'string' && accession.trim() ? accession.trim() : undefined,
    deltaMass: Number.isFinite(deltaMass) ? deltaMass : undefined,
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

  const values: string[] = [];
  if (Array.isArray(record['values'])) {
    for (const item of record['values']) {
      if (typeof item === 'string' && item.trim() && !values.includes(item.trim())) {
        values.push(item.trim());
      }
    }
  }
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
