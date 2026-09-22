/**
 * SDRF Creation Wizard Models
 *
 * Types and interfaces for the wizard state and data structures.
 */

// ============ Template Types ============

/**
 * Template type - now dynamic string for API-driven templates.
 * Legacy values: 'human', 'cell-line', 'vertebrate', 'other'
 * New values from API: 'human', 'cell-lines', 'vertebrates', 'ms-proteomics', etc.
 */
export type WizardTemplate = string;

/**
 * Legacy template type for backward compatibility.
 */
export type LegacyWizardTemplate = 'human' | 'cell-line' | 'vertebrate' | 'other';

/**
 * Template information for display (legacy format).
 */
export interface TemplateInfo {
  id: WizardTemplate;
  name: string;
  description: string;
  icon: string;
  examples: string[];
}

/**
 * Map legacy template IDs to new ones.
 */
export function mapLegacyTemplateId(id: string): string {
  const mapping: Record<string, string> = {
    'cell-line': 'cell-lines',
    'vertebrate': 'vertebrates',
  };
  return mapping[id] || id;
}

/**
 * Default templates for the wizard (fallback when API unavailable).
 */
export const WIZARD_TEMPLATES: TemplateInfo[] = [
  {
    id: 'human',
    name: 'Human Samples',
    description: 'Clinical samples, patient tissues, human-derived materials',
    icon: 'person',
    examples: ['Patient biopsies', 'Blood samples', 'Tumor tissues'],
  },
  {
    id: 'vertebrates',
    name: 'Vertebrates (Non-Human)',
    description: 'Mouse, rat, zebrafish, and other vertebrate samples',
    icon: 'pets',
    examples: ['Mouse liver', 'Rat brain', 'Zebrafish embryo'],
  },
  {
    id: 'invertebrates',
    name: 'Invertebrates',
    description: 'Drosophila, C. elegans, insects, and other invertebrates',
    icon: 'bug_report',
    examples: ['Drosophila', 'C. elegans', 'Insects'],
  },
  {
    id: 'plants',
    name: 'Plants',
    description: 'Arabidopsis, crops, and other plant samples',
    icon: 'eco',
    examples: ['Arabidopsis', 'Rice', 'Wheat'],
  },
  {
    id: 'ms-proteomics',
    name: 'MS Proteomics',
    description: 'Mass spectrometry-based proteomics experiments',
    icon: 'analytics',
    examples: ['DDA', 'DIA', 'PRM', 'SRM'],
  },
  {
    id: 'affinity-proteomics',
    name: 'Affinity-based Proteomics',
    description: 'Protein-level assays (Olink, SomaScan)',
    icon: 'biotech',
    examples: ['Olink', 'SomaScan', 'Protein arrays'],
  },
  {
    id: 'cell-lines',
    name: 'Cell Lines',
    description: 'Cultured cell lines (HeLa, HEK293, etc.) — experiment layer',
    icon: 'science',
    examples: ['HeLa cells', 'HEK293', 'MCF-7', 'A549'],
  },
  {
    id: 'dia-acquisition',
    name: 'DIA Acquisition',
    description: 'Data-independent acquisition specific columns',
    icon: 'assessment',
    examples: ['DIA scan windows'],
  },
  {
    id: 'single-cell',
    name: 'Single Cell',
    description: 'Single-cell proteomics (SCP) experiments',
    icon: 'grain',
    examples: ['SCP'],
  },
  {
    id: 'immunopeptidomics',
    name: 'Immunopeptidomics',
    description: 'MHC-bound peptide identification',
    icon: 'vaccines',
    examples: ['HLA typing'],
  },
  {
    id: 'crosslinking',
    name: 'Crosslinking (XL-MS)',
    description: 'Crosslinking mass spectrometry experiments',
    icon: 'link',
    examples: ['XL-MS'],
  },
];

/**
 * Check if template is a human-like template (requires age/sex fields).
 */
export function isHumanTemplate(templateId: string | null): boolean {
  return templateId === 'human';
}

/**
 * Check if template is a cell line template.
 */
export function isCellLineTemplate(templateId: string | null): boolean {
  return templateId === 'cell-line' || templateId === 'cell-lines';
}

/**
 * Check if template is a vertebrate template.
 */
export function isVertebrateTemplate(templateId: string | null): boolean {
  return templateId === 'vertebrate' || templateId === 'vertebrates';
}

/**
 * Check if template is an invertebrate template.
 */
export function isInvertebrateTemplate(templateId: string | null): boolean {
  return templateId === 'invertebrates';
}

/**
 * Check if template is a plant template.
 */
export function isPlantTemplate(templateId: string | null): boolean {
  return templateId === 'plants';
}

/** Characteristics managed by sample rows / later steps — not free-text on Step2. */
export const WIZARD_SKIPPED_CHARACTERISTICS = new Set([
  'characteristics[biological replicate]',
]);

export type SpecialtyCharacteristicKey =
  | 'organism'
  | 'disease'
  | 'organism part'
  | 'sex'
  | 'age'
  | 'cell line'
  | 'strain/breed'
  | 'developmental stage'
  | 'material type';

/** Lightweight column meta stored on wizard state for Step2/3/generator. */
export interface WizardCharacteristicColumnMeta {
  name: string;
  description: string;
  requirement: 'required' | 'recommended' | 'optional';
  ontologies?: string[];
  allowNotAvailable?: boolean;
  allowNotApplicable?: boolean;
}

export function parseCharacteristicInnerName(columnName: string): string | null {
  const m = /^characteristics\[(.+)\]$/i.exec(columnName.trim());
  return m ? m[1].trim().toLowerCase() : null;
}

export function isCharacteristicsColumn(columnName: string): boolean {
  return /^characteristics\[.+\]$/i.test(columnName.trim());
}

export function isWizardSkippedCharacteristic(columnName: string): boolean {
  return WIZARD_SKIPPED_CHARACTERISTICS.has(columnName.trim().toLowerCase());
}

export function getSpecialtyCharacteristicKey(
  columnName: string
): SpecialtyCharacteristicKey | null {
  const inner = parseCharacteristicInnerName(columnName);
  if (!inner) return null;
  const known: SpecialtyCharacteristicKey[] = [
    'organism',
    'disease',
    'organism part',
    'sex',
    'age',
    'cell line',
    'strain/breed',
    'developmental stage',
    'material type',
  ];
  return (known.find(k => k === inner) as SpecialtyCharacteristicKey) || null;
}

/** Columns suitable for per-sample override on Step3 (organism stays global). */
export function isPerSampleOverrideCharacteristic(columnName: string): boolean {
  const key = getSpecialtyCharacteristicKey(columnName);
  if (key === 'organism' || key === 'material type') return false;
  if (isWizardSkippedCharacteristic(columnName)) return false;
  return isCharacteristicsColumn(columnName);
}

/**
 * Current SDRF-Proteomics specification version written by the wizard.
 * Stored without the leading "v"; generators prefix `v` for comment[sdrf version]
 * (validator expects e.g. v3.0.0).
 */
export const SDRF_SPEC_VERSION = '3.0.0';

/** Format for comment[sdrf version] / template VV fields. */
export function formatSdrfSemver(version: string = SDRF_SPEC_VERSION): string {
  const v = (version || SDRF_SPEC_VERSION).trim();
  return v.startsWith('v') ? v : `v${v}`;
}

/**
 * Default material type for a sample template.
 */
export function getDefaultMaterialType(
  sampleTemplate: string | null,
  experimentTemplates: string[] = []
): string {
  if (experimentTemplates.includes('cell-lines') || isCellLineTemplate(sampleTemplate)) {
    return 'cell line';
  }
  if (isPlantTemplate(sampleTemplate)) return 'organism part';
  return 'tissue';
}

/**
 * A study factor defined on Step 2 (candidates) and assigned per sample on Step 3.
 */
export interface WizardFactor {
  /** Technical comparisons can vary by MS run, even for the same biological sample. */
  scope?: 'sample' | 'run';
  /** Factor name without wrapper, e.g. "disease" or "compound" → factor value[name] */
  name: string;
  /** Omit for independently assigned groups; otherwise derive from this characteristic. */
  sourceCharacteristic?: string;
  /** Evidence explaining why this variable is compared. */
  reasoning?: string;
  /** Whether this factor is included in the generated table */
  enabled: boolean;
  /** Candidate values filled on Step 2; Step 3 picks one per sample */
  values: string[];
}

/**
 * Create a default disease factor (candidates filled later on Step 2).
 */
export function createDefaultDiseaseFactor(diseaseValue?: string): WizardFactor {
  const values = diseaseValue?.trim() ? [diseaseValue.trim()] : [];
  return {
    name: 'disease',
    enabled: true,
    values,
  };
}

/** Normalize legacy factor drafts that used sourceCharacteristic / defaultValue. */
export function normalizeFactor(raw: unknown): WizardFactor {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const name = typeof record['name'] === 'string' ? record['name'].trim() : '';
  const enabled = record['enabled'] === undefined ? true : record['enabled'] !== false;
  const values: string[] = [];
  if (Array.isArray(record['values'])) {
    for (const v of record['values']) {
      if (typeof v === 'string' && v.trim() && !values.some(existing => choiceValuesEqual(existing, v))) values.push(v.trim());
    }
  }
  if (!values.length && typeof record['defaultValue'] === 'string' && record['defaultValue'].trim()) {
    values.push(record['defaultValue'].trim());
  }
  const sourceCharacteristic = typeof record['sourceCharacteristic'] === 'string'
    ? record['sourceCharacteristic'].trim().toLowerCase() : undefined;
  const reasoning = typeof record['reasoning'] === 'string' ? record['reasoning'].trim() : undefined;
  return { name, enabled, values, scope: record['scope'] === 'run' ? 'run' : 'sample', sourceCharacteristic: sourceCharacteristic || undefined, reasoning };

}

// ============ Ontology Term ============

/**
 * An ontology term selected from OLS.
 */
export interface OntologyTerm {
  id: string;
  label: string;
  iri?: string;
  ontologyPrefix?: string;
  ontology?: string;
}

// ============ Sample Entry ============

/**
 * A single sample entry in the wizard.
 */
export interface WizardSampleEntry {
  /** 1-based index */
  index: number;
  /** Source name (unique identifier) */
  sourceName: string;
  /** Biological replicate number */
  biologicalReplicate: number;
  /** Sample-specific organism (when Step2 has multiple organism candidates) */
  organism?: OntologyTerm | string;
  /** Sample-specific disease (if different from default) */
  disease?: OntologyTerm | string;
  /** Sample-specific age */
  age?: string;
  /** Sample-specific sex */
  sex?: 'male' | 'female' | 'not available';
  /** Sample-specific organism part (if different from default) */
  organismPart?: OntologyTerm | string;
  /** Sample-specific cell line */
  cellLine?: string;
  /** Custom characteristics */
  customCharacteristics?: Record<string, string>;
  /** Unified per-sample picks from Step2 choice lists (columnName -> value) */
  characteristicValues?: Record<string, string>;
  /** Per-sample picks for study factors (factor.name -> value) */
  factorValues?: Record<string, string>;
}

/**
 * A candidate value for a characteristics column (Step2 multi-select).
 */
export interface CharacteristicChoice {
  value: string;
  ontologyTerm?: OntologyTerm;
}

export function normalizeChoiceValue(value: string): string {
  return value.trim();
}

export function choiceValuesEqual(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function getCharacteristicChoices(
  state: Pick<WizardState, 'characteristicChoices'>,
  columnName: string
): CharacteristicChoice[] {
  return state.characteristicChoices?.[columnName] || [];
}

export function addCharacteristicChoiceToMap(
  choices: Record<string, CharacteristicChoice[]>,
  columnName: string,
  choice: CharacteristicChoice
): Record<string, CharacteristicChoice[]> {
  const value = normalizeChoiceValue(choice.value);
  if (!value) return choices;
  const list = [...(choices[columnName] || [])];
  if (list.some(c => choiceValuesEqual(c.value, value))) return choices;
  list.push({ ...choice, value });
  return { ...choices, [columnName]: list };
}

export function removeCharacteristicChoiceFromMap(
  choices: Record<string, CharacteristicChoice[]>,
  columnName: string,
  value: string
): Record<string, CharacteristicChoice[]> {
  const list = (choices[columnName] || []).filter(c => !choiceValuesEqual(c.value, value));
  const next = { ...choices };
  if (list.length === 0) delete next[columnName];
  else next[columnName] = list;
  return next;
}

/** Quick-pick suggestions for Step2 chips. */
export function getQuickPickSuggestions(
  columnName: string,
  meta?: Pick<WizardCharacteristicColumnMeta, 'allowNotAvailable' | 'allowNotApplicable'>
): string[] {
  const key = getSpecialtyCharacteristicKey(columnName);
  const picks: string[] = [];
  switch (key) {
    case 'organism':
      picks.push('Homo sapiens', 'Mus musculus', 'not applicable');
      break;
    case 'disease':
      picks.push('normal', 'not available');
      break;
    case 'organism part':
      picks.push('liver', 'blood', 'not available', 'not applicable');
      break;
    case 'sex':
      picks.push('male', 'female', 'not available');
      break;
    case 'cell line':
      picks.push('HeLa', 'HEK293', 'MCF-7', 'A549');
      break;
    case 'age':
      picks.push('not available', 'anonymized');
      break;
    default:
      if (meta?.allowNotAvailable) picks.push('not available');
      if (meta?.allowNotApplicable) picks.push('not applicable');
      break;
  }
  return [...new Set(picks)];
}

/**
 * Whether a column should appear on Step3 override grid.
 * Organism only when multiple choices exist.
 */
export function shouldShowOnSampleValuesStep(
  columnName: string,
  choiceCount: number
): boolean {
  if (isWizardSkippedCharacteristic(columnName)) return false;
  if (!isCharacteristicsColumn(columnName)) return false;
  const key = getSpecialtyCharacteristicKey(columnName);
  if (key === 'material type') return false;
  if (key === 'organism') return choiceCount > 1;
  return choiceCount >= 1;
}

/**
 * Copy characteristicValues onto legacy specialty / custom fields for the generator.
 */
export function materializeSampleFieldsFromChoices(state: WizardState): WizardState {
  const choices = state.characteristicChoices || {};
  const samples = state.samples.map(sample => {
    const values = { ...(sample.characteristicValues || {}) };
    let next: WizardSampleEntry = { ...sample, characteristicValues: values };

    for (const [columnName, list] of Object.entries(choices)) {
      if (list.length === 1) {
        values[columnName] = list[0].value;
      }
    }

    const get = (col: string) => values[col]?.trim() || '';

    const organismVal = get('characteristics[organism]');
    if (organismVal) next = { ...next, organism: organismVal };

    const disease = get('characteristics[disease]');
    if (disease) next = { ...next, disease };

    const age = get('characteristics[age]');
    if (age) next = { ...next, age };

    const sex = get('characteristics[sex]');
    if (sex === 'male' || sex === 'female' || sex === 'not available') {
      next = { ...next, sex };
    }

    const cellLine = get('characteristics[cell line]');
    if (cellLine) next = { ...next, cellLine };

    const part = get('characteristics[organism part]');
    if (part) next = { ...next, organismPart: part };

    const custom = { ...(next.customCharacteristics || {}) };
    for (const [columnName, value] of Object.entries(values)) {
      const key = getSpecialtyCharacteristicKey(columnName);
      if (
        key === 'disease' ||
        key === 'age' ||
        key === 'sex' ||
        key === 'cell line' ||
        key === 'organism part' ||
        key === 'organism' ||
        key === 'material type'
      ) {
        continue;
      }
      if (value?.trim()) custom[columnName] = value;
    }
    next = { ...next, customCharacteristics: custom, characteristicValues: values };
    return next;
  });

  // Sync top-level specialty fields from first choice when single / from first sample
  let organism = state.organism;
  const organismChoices = choices['characteristics[organism]'] || [];
  if (organismChoices.length === 1) {
    organism = organismChoices[0].ontologyTerm || {
      id: organismChoices[0].value,
      label: organismChoices[0].value,
      ontology: 'SDRF',
    };
  }

  const diseaseChoices = choices['characteristics[disease]'] || [];
  let disease: OntologyTerm | string | null = state.disease;
  if (diseaseChoices.length === 1) {
    disease =
      diseaseChoices[0].ontologyTerm || diseaseChoices[0].value;
  } else if (samples[0]?.disease) {
    disease = samples[0].disease;
  }

  const partChoices = choices['characteristics[organism part]'] || [];
  let organismPart: OntologyTerm | string | null = state.organismPart;
  if (partChoices.length === 1) {
    organismPart =
      partChoices[0].ontologyTerm || partChoices[0].value;
  } else if (samples[0]?.organismPart) {
    organismPart = samples[0].organismPart;
  }

  const sexChoices = choices['characteristics[sex]'] || [];
  let defaultSex = state.defaultSex;
  if (sexChoices.length === 1) {
    const v = sexChoices[0].value;
    if (v === 'male' || v === 'female' || v === 'not available') defaultSex = v;
  }

  const ageChoices = choices['characteristics[age]'] || [];
  let defaultAge = state.defaultAge;
  if (ageChoices.length === 1) defaultAge = ageChoices[0].value;

  const cellChoices = choices['characteristics[cell line]'] || [];
  let defaultCellLine = state.defaultCellLine;
  if (cellChoices.length === 1) defaultCellLine = cellChoices[0].value;

  // Refresh dynamicColumnDefaults for single-choice columns
  let dynamicColumnDefaults = [...state.dynamicColumnDefaults];
  for (const [columnName, list] of Object.entries(choices)) {
    if (list.length === 1) {
      dynamicColumnDefaults = upsertDynamicColumnDefault(
        dynamicColumnDefaults,
        columnName,
        list[0].value,
        list[0].ontologyTerm
      );
    }
  }

  return {
    ...state,
    organism,
    disease,
    organismPart,
    defaultSex,
    defaultAge,
    defaultCellLine,
    dynamicColumnDefaults,
    samples,
  };
}

// ============ Label Types ============

/**
 * Common label types for mass spectrometry.
 */
export type LabelType =
  | 'label free sample'
  | 'TMT126' | 'TMT127N' | 'TMT127C' | 'TMT128N' | 'TMT128C' | 'TMT129N' | 'TMT129C' | 'TMT130N' | 'TMT130C' | 'TMT131' | 'TMT131C' | 'TMT132N' | 'TMT132C' | 'TMT133N' | 'TMT133C' | 'TMT134N' | 'TMT134C' | 'TMT135N'
  | 'iTRAQ4plex-114' | 'iTRAQ4plex-115' | 'iTRAQ4plex-116' | 'iTRAQ4plex-117'
  | 'iTRAQ8plex-113' | 'iTRAQ8plex-114' | 'iTRAQ8plex-115' | 'iTRAQ8plex-116' | 'iTRAQ8plex-117' | 'iTRAQ8plex-118' | 'iTRAQ8plex-119' | 'iTRAQ8plex-121'
  | 'SILAC light' | 'SILAC medium' | 'SILAC heavy'
  | 'custom';

/**
 * Label plex configuration.
 */
export interface LabelPlexConfig {
  id: string;
  name: string;
  labels: string[];
}

/**
 * Available label configurations.
 */
export const LABEL_CONFIGS: LabelPlexConfig[] = [
  { id: 'lf', name: 'Label-free (LFQ)', labels: ['label free sample'] },
  { id: 'tmt6', name: 'TMT 6-plex', labels: ['TMT126', 'TMT127N', 'TMT127C', 'TMT128N', 'TMT128C', 'TMT129N'] },
  { id: 'tmt10', name: 'TMT 10-plex', labels: ['TMT126', 'TMT127N', 'TMT127C', 'TMT128N', 'TMT128C', 'TMT129N', 'TMT129C', 'TMT130N', 'TMT130C', 'TMT131'] },
  { id: 'tmt11', name: 'TMT 11-plex', labels: ['TMT126', 'TMT127N', 'TMT127C', 'TMT128N', 'TMT128C', 'TMT129N', 'TMT129C', 'TMT130N', 'TMT130C', 'TMT131', 'TMT131C'] },
  { id: 'tmt16', name: 'TMT 16-plex', labels: ['TMT126', 'TMT127N', 'TMT127C', 'TMT128N', 'TMT128C', 'TMT129N', 'TMT129C', 'TMT130N', 'TMT130C', 'TMT131', 'TMT131C', 'TMT132N', 'TMT132C', 'TMT133N', 'TMT133C', 'TMT134N'] },
  { id: 'tmt18', name: 'TMT 18-plex', labels: ['TMT126', 'TMT127N', 'TMT127C', 'TMT128N', 'TMT128C', 'TMT129N', 'TMT129C', 'TMT130N', 'TMT130C', 'TMT131', 'TMT131C', 'TMT132N', 'TMT132C', 'TMT133N', 'TMT133C', 'TMT134N', 'TMT134C', 'TMT135N'] },
  { id: 'itraq4', name: 'iTRAQ 4-plex', labels: ['iTRAQ4plex-114', 'iTRAQ4plex-115', 'iTRAQ4plex-116', 'iTRAQ4plex-117'] },
  { id: 'itraq8', name: 'iTRAQ 8-plex', labels: ['iTRAQ8plex-113', 'iTRAQ8plex-114', 'iTRAQ8plex-115', 'iTRAQ8plex-116', 'iTRAQ8plex-117', 'iTRAQ8plex-118', 'iTRAQ8plex-119', 'iTRAQ8plex-121'] },
  { id: 'silac', name: 'SILAC', labels: ['SILAC light', 'SILAC medium', 'SILAC heavy'] },
];

// ============ Modification ============

/**
 * Position where a modification can occur.
 */
export type ModificationPosition = 'Anywhere' | 'Any N-term' | 'Protein N-term' | 'Any C-term' | 'Protein C-term';

/**
 * Available positions for modification selection.
 */
export const MODIFICATION_POSITIONS: { value: ModificationPosition; label: string }[] = [
  { value: 'Anywhere', label: 'Anywhere' },
  { value: 'Any N-term', label: 'Any N-term' },
  { value: 'Protein N-term', label: 'Protein N-term' },
  { value: 'Any C-term', label: 'Any C-term' },
  { value: 'Protein C-term', label: 'Protein C-term' },
];

/**
 * Common amino acids for modification target.
 */
export const AMINO_ACIDS = ['A', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'K', 'L', 'M', 'N', 'P', 'Q', 'R', 'S', 'T', 'V', 'W', 'Y'];

/**
 * A protein modification configuration.
 */
export interface WizardModification {
  /** Name of the modification */
  name: string;
  /** Target amino acids (e.g., "C", "M", "S,T,Y") */
  targetAminoAcids: string;
  /** Modification type */
  type: 'fixed' | 'variable';
  /** Position (terminal/anywhere) */
  position: ModificationPosition;
  /** UNIMOD accession */
  unimodAccession?: string;
  /** Mass shift (delta mass) */
  deltaMass?: number;
}

/**
 * Common modifications with their details.
 */
export const COMMON_MODIFICATIONS: WizardModification[] = [
  { name: 'Carbamidomethyl', targetAminoAcids: 'C', type: 'fixed', position: 'Anywhere', unimodAccession: 'UNIMOD:4', deltaMass: 57.021464 },
  { name: 'Oxidation', targetAminoAcids: 'M', type: 'variable', position: 'Anywhere', unimodAccession: 'UNIMOD:35', deltaMass: 15.994915 },
  { name: 'Acetyl', targetAminoAcids: 'N-term', type: 'variable', position: 'Protein N-term', unimodAccession: 'UNIMOD:1', deltaMass: 42.010565 },
  { name: 'Phospho', targetAminoAcids: 'S,T,Y', type: 'variable', position: 'Anywhere', unimodAccession: 'UNIMOD:21', deltaMass: 79.966331 },
  { name: 'Deamidated', targetAminoAcids: 'N,Q', type: 'variable', position: 'Anywhere', unimodAccession: 'UNIMOD:7', deltaMass: 0.984016 },
  { name: 'TMT6plex', targetAminoAcids: 'K', type: 'fixed', position: 'Anywhere', unimodAccession: 'UNIMOD:737', deltaMass: 229.162932 },
  { name: 'TMT6plex', targetAminoAcids: 'N-term', type: 'fixed', position: 'Any N-term', unimodAccession: 'UNIMOD:737', deltaMass: 229.162932 },
  { name: 'TMTpro', targetAminoAcids: 'K', type: 'fixed', position: 'Anywhere', unimodAccession: 'UNIMOD:2016', deltaMass: 304.207146 },
  { name: 'TMTpro', targetAminoAcids: 'N-term', type: 'fixed', position: 'Any N-term', unimodAccession: 'UNIMOD:2016', deltaMass: 304.207146 },
  { name: 'GlyGly', targetAminoAcids: 'K', type: 'variable', position: 'Anywhere', unimodAccession: 'UNIMOD:121', deltaMass: 114.042927 },
];

// ============ Cleavage Agent ============

/**
 * A cleavage agent (enzyme) configuration.
 */
export interface WizardCleavageAgent {
  /** Name of the enzyme */
  name: string;
  /** MS ontology accession */
  msAccession: string;
}

/**
 * Common cleavage agents.
 */
export const COMMON_CLEAVAGE_AGENTS: WizardCleavageAgent[] = [
  { name: 'Trypsin', msAccession: 'MS:1001251' },
  { name: 'Trypsin/P', msAccession: 'MS:1001313' },
  { name: 'Lys-C', msAccession: 'MS:1001309' },
  { name: 'Chymotrypsin', msAccession: 'MS:1001306' },
  { name: 'Asp-N', msAccession: 'MS:1001304' },
  { name: 'Glu-C', msAccession: 'MS:1001917' },
  { name: 'Arg-C', msAccession: 'MS:1001303' },
  { name: 'No cleavage', msAccession: 'MS:1001955' },
];

// ============ MS Run × Channel packing ============

/** Role of a multiplex channel within an MS run. */
export type ChannelRole = 'sample' | 'empty' | 'bridge' | 'carrier' | 'pooled';

/**
 * Assignment of one plex channel inside an MS run.
 */
export interface WizardChannelAssignment {
  /** Channel label (e.g. TMT126) */
  label: string;
  role: ChannelRole;
  /** Bound sample index (1-based) when role=sample */
  sampleIndex?: number;
  /** Mix members when role=pooled */
  pooledSampleIndices?: number[];
  /** Display / SDRF source name for bridge/carrier/pooled */
  sourceNameOverride?: string;
}

/**
 * One MS run (channel packing template), including label-free (1 channel).
 * Each run may use its own plex kit — mixed kits in one experiment are allowed.
 */
export interface WizardMsRun {
  /** Original automatic placeholder contents; only unchanged placeholders may be removed. */
  placeholderSnapshot?: string;
  factorValues?: Record<string, string>;
  id: string;
  name: string;
  /**
   * Label / plex kit for this run (`lf`, `tmt10`, …).
   * When omitted, falls back to wizard `labelConfigId` (default for new runs).
   */
  labelConfigId?: string;
  /** Optional per-run custom labels (overrides kit presets). */
  customLabels?: string[];
  /**
   * Samples involved in this MS run (1-based indices).
   * Channel mapping may only use this subset (single or pooled).
   * When omitted (legacy), derived from existing channel bindings.
   */
  sampleIndices?: number[];
  channels: WizardChannelAssignment[];
}

/**
 * A data file entry — truth source for fraction / tech.
 * Multiplex: bind runId (one file expands to used channels).
 * Label-free: bind sampleIndex.
 */
export interface WizardDataFile {
  fileName: string;
  /** Fraction identifier (defaults to 1) */
  fractionId?: number;
  /** Technical replicate number (defaults to 1) */
  technicalReplicate?: number;
  /** Multiplex: MS run this file belongs to */
  runId?: string;
  /** Label-free: associated sample (1-based) */
  sampleIndex?: number;
  /**
   * @deprecated Prefer run channel map. Kept for paste/TSV compatibility.
   */
  label?: string;
}

/**
 * One expanded SDRF row after file → channel expansion.
 */
export interface WizardExpansionRow {
  /** 1-based row index in the generated table */
  rowIndex: number;
  sourceName: string;
  /** Sample used for characteristics lookup; undefined for empty/bridge without sample */
  sampleIndex?: number;
  label: string;
  fractionId: number;
  technicalReplicate: number;
  fileName: string;
  runId?: string;
  role: ChannelRole;
  biologicalReplicate: number;
}

/** Kit id for a run (falls back to wizard default). */
export function resolveRunLabelConfigId(
  run: Pick<WizardMsRun, 'labelConfigId'>,
  state: Pick<WizardState, 'labelConfigId'>
): string {
  return run.labelConfigId || state.labelConfigId || 'lf';
}

/** Display name for a kit id. */
export function labelConfigDisplayName(configId: string): string {
  return LABEL_CONFIGS.find(c => c.id === configId)?.name || configId;
}

/** Resolve label list for one MS run. */
export function resolveRunLabels(
  run: Pick<WizardMsRun, 'labelConfigId' | 'customLabels'>,
  state: Pick<WizardState, 'labelConfigId' | 'customLabels'>
): string[] {
  if (run.customLabels?.length) return run.customLabels;
  const id = resolveRunLabelConfigId(run, state);
  // Global custom labels only apply when the run uses the default kit slot
  if (!run.labelConfigId && state.customLabels.length > 0) {
    return state.customLabels;
  }
  const config = LABEL_CONFIGS.find(c => c.id === id);
  return config?.labels?.length ? config.labels : ['label free sample'];
}

/** Whether a specific run is label-free. */
export function isRunLabelFree(
  run: Pick<WizardMsRun, 'labelConfigId'>,
  state: Pick<WizardState, 'labelConfigId'>
): boolean {
  return resolveRunLabelConfigId(run, state) === 'lf';
}

/**
 * Whether the experiment is entirely label-free
 * (all runs LF, or no runs and default kit is LF).
 */
export function isLabelFree(
  state: Pick<WizardState, 'labelConfigId' | 'msRuns'>
): boolean {
  const runs = state.msRuns || [];
  if (runs.length === 0) return state.labelConfigId === 'lf';
  return runs.every(r => isRunLabelFree(r, state));
}

/** Unique non-LF kit ids used across runs (for Step 5 mod suggestions). */
export function collectUsedPlexKitIds(
  state: Pick<WizardState, 'labelConfigId' | 'msRuns'>
): string[] {
  const runs = state.msRuns || [];
  const ids =
    runs.length > 0
      ? runs.map(r => resolveRunLabelConfigId(r, state))
      : [state.labelConfigId || 'lf'];
  return [...new Set(ids)].filter(id => id && id !== 'lf');
}

/** Resolve default kit label list (new runs / Auto-pack). */
export function resolveWizardLabels(
  state: Pick<WizardState, 'labelConfigId' | 'customLabels'>
): string[] {
  if (state.customLabels.length > 0) return state.customLabels;
  const config = LABEL_CONFIGS.find(c => c.id === state.labelConfigId);
  return config?.labels?.length ? config.labels : ['label free sample'];
}

/** Ensure every run has an explicit labelConfigId (migrate legacy state). */
export function normalizeMsRunKits(
  runs: WizardMsRun[],
  defaultConfigId: string
): WizardMsRun[] {
  const fallback = defaultConfigId || 'lf';
  return runs.map(r =>
    r.labelConfigId ? r : { ...r, labelConfigId: fallback }
  );
}

/** Channels that produce SDRF rows (skip empty). */
export function getUsedChannels(run: WizardMsRun): WizardChannelAssignment[] {
  return run.channels.filter(c => c.role !== 'empty');
}

export function countUsedChannels(run: WizardMsRun): number {
  return getUsedChannels(run).length;
}

/** Samples involved in a run (explicit list, or derived from channel bindings). */
export function resolveRunSampleIndices(run: WizardMsRun): number[] {
  if (run.sampleIndices) {
    return [...new Set(run.sampleIndices)].sort((a, b) => a - b);
  }
  const set = new Set<number>();
  for (const ch of run.channels || []) {
    if (ch.role === 'sample' && ch.sampleIndex != null) set.add(ch.sampleIndex);
    if (ch.role === 'pooled') {
      for (const i of ch.pooledSampleIndices || []) set.add(i);
    }
  }
  return [...set].sort((a, b) => a - b);
}

/** Drop channel bindings that reference samples outside the allowed set. */
export function pruneChannelsToSamples(
  channels: WizardChannelAssignment[],
  allowedIndices: number[]
): WizardChannelAssignment[] {
  const allowed = new Set(allowedIndices);
  return channels.map(ch => {
    if (ch.role === 'sample') {
      if (ch.sampleIndex != null && allowed.has(ch.sampleIndex)) return ch;
      return { label: ch.label, role: 'empty' as ChannelRole };
    }
    if (ch.role === 'pooled') {
      const kept = (ch.pooledSampleIndices || []).filter(i => allowed.has(i));
      if (kept.length === 0) return { label: ch.label, role: 'empty' as ChannelRole };
      if (kept.length === 1) {
        return { label: ch.label, role: 'sample' as ChannelRole, sampleIndex: kept[0] };
      }
      return { ...ch, pooledSampleIndices: kept };
    }
    return ch;
  });
}

export function plannedFractionCount(
  state: Pick<WizardState, 'hasFractions' | 'fractionCount'>
): number {
  return state.hasFractions ? Math.max(1, state.fractionCount) : 1;
}

export function plannedTechRepCount(
  state: Pick<WizardState, 'technicalReplicates'>
): number {
  return Math.max(1, state.technicalReplicates);
}

/** Soft estimate of SDRF rows if all planner slots are filled. */
export function estimatePlannerSdrfRows(state: WizardState): number {
  const fractions = plannedFractionCount(state);
  const tech = plannedTechRepCount(state);
  const runs = state.msRuns?.length ? state.msRuns : [];
  if (runs.length === 0) return 0;
  return runs.reduce((sum, run) => sum + countUsedChannels(run) * fractions * tech, 0);
}

/** Soft estimate of raw file slots from planner. */
export function estimatePlannerFileSlots(state: WizardState): number {
  const fractions = plannedFractionCount(state);
  const tech = plannedTechRepCount(state);
  const runs = state.msRuns?.length ? state.msRuns : [];
  return Math.max(0, runs.length) * fractions * tech;
}

function newRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/** Empty channel list for a plex kit. */
export function createEmptyChannelsForLabels(labels: string[]): WizardChannelAssignment[] {
  return labels.map(label => ({ label, role: 'empty' as ChannelRole }));
}

/**
 * Pack samples into MS runs by filling channels left-to-right.
 * Excess channels stay empty; opens new runs when plex is full.
 * Label-free uses a single channel ("label free sample") — one sample (or pool) per run.
 */
export function packSamplesIntoRuns(
  samples: WizardSampleEntry[],
  labels: string[],
  existingRunNames?: string[],
  labelConfigId: string = 'lf'
): WizardMsRun[] {
  if (labels.length === 0) {
    return [];
  }

  const runs: WizardMsRun[] = [];
  let sampleIdx = 0;
  let runOrdinal = 1;
  const kitId = labelConfigId || 'lf';

  while (sampleIdx < samples.length || runs.length === 0) {
    const channels: WizardChannelAssignment[] = labels.map(label => {
      if (sampleIdx < samples.length) {
        const sample = samples[sampleIdx++];
        return {
          label,
          role: 'sample' as ChannelRole,
          sampleIndex: sample.index,
        };
      }
      return { label, role: 'empty' as ChannelRole };
    });

    const name =
      existingRunNames?.[runOrdinal - 1] || `Run ${runOrdinal}`;
    const sampleIndices = channels
      .filter(c => c.role === 'sample' && c.sampleIndex != null)
      .map(c => c.sampleIndex as number);
    runs.push({
      id: newRunId(),
      name,
      labelConfigId: kitId,
      sampleIndices,
      channels,
    });
    runOrdinal++;

    if (sampleIdx >= samples.length) break;
  }

  return runs;
}

/**
 * Remap one run to a new kit width, preserving non-empty channel bindings in order.
 */
export function remapSingleRunToLabels(
  run: WizardMsRun,
  labels: string[],
  labelConfigId: string
): WizardMsRun {
  if (labels.length === 0) {
    return { ...run, labelConfigId, channels: [] };
  }

  const kept = run.channels.filter(ch => ch.role !== 'empty');
  const channels: WizardChannelAssignment[] = labels.map((label, i) => {
    if (i < kept.length) {
      return { ...kept[i], label };
    }
    return { label, role: 'empty' as ChannelRole };
  });

  return {
    ...run,
    labelConfigId,
    customLabels: undefined,
    channels,
  };
}

/**
 * Rebuild all runs to the same kit (Auto-pack / apply default kit to all).
 * Preserves sample bindings by channel order across runs.
 */
export function remapRunsToLabels(
  runs: WizardMsRun[],
  labels: string[],
  samples: WizardSampleEntry[],
  labelConfigId: string = 'lf'
): WizardMsRun[] {
  if (labels.length === 0) {
    return [];
  }

  const kitId = labelConfigId || 'lf';
  const boundSampleIndices: number[] = [];
  for (const run of runs) {
    for (const ch of run.channels) {
      if (ch.role === 'sample' && ch.sampleIndex != null) {
        boundSampleIndices.push(ch.sampleIndex);
      }
    }
  }

  if (boundSampleIndices.length === 0 && samples.length > 0) {
    return packSamplesIntoRuns(
      samples,
      labels,
      runs.map(r => r.name),
      kitId
    );
  }

  const orderedSamples = boundSampleIndices
    .map(idx => samples.find(s => s.index === idx))
    .filter((s): s is WizardSampleEntry => !!s);

  const leftover = samples.filter(s => !boundSampleIndices.includes(s.index));
  const packOrder = [...orderedSamples, ...leftover];
  if (packOrder.length === 0) {
    return [
      {
        id: runs[0]?.id || newRunId(),
        name: runs[0]?.name || 'Run 1',
        labelConfigId: kitId,
        channels: createEmptyChannelsForLabels(labels),
      },
    ];
  }

  const remapped = packSamplesIntoRuns(
    packOrder,
    labels,
    runs.map(r => r.name),
    kitId
  );
  return remapped.map((run, i) => ({
    ...run,
    id: runs[i]?.id || run.id,
    name: runs[i]?.name || run.name,
    labelConfigId: kitId,
  }));
}

function resolveChannelSourceName(
  channel: WizardChannelAssignment,
  samples: WizardSampleEntry[]
): string {
  if (channel.sourceNameOverride?.trim()) {
    return channel.sourceNameOverride.trim();
  }
  if (channel.role === 'sample' && channel.sampleIndex != null) {
    return (
      samples.find(s => s.index === channel.sampleIndex)?.sourceName ||
      `sample_${channel.sampleIndex}`
    );
  }
  if (channel.role === 'pooled') {
    const parts = (channel.pooledSampleIndices || [])
      .map(i => samples.find(s => s.index === i)?.sourceName || `sample_${i}`);
    return parts.length ? `pool_${parts.join('_')}` : 'pooled_sample';
  }
  if (channel.role === 'bridge') return 'bridge_channel';
  if (channel.role === 'carrier') return 'carrier_channel';
  return 'empty_channel';
}

function findSample(
  samples: WizardSampleEntry[],
  index?: number
): WizardSampleEntry | undefined {
  if (index == null) return undefined;
  return samples.find(s => s.index === index);
}

/**
 * Build effective file list: use dataFiles when present, else planner slots.
 */
export function resolveEffectiveDataFiles(state: WizardState): WizardDataFile[] {
  if (state.dataFiles.length > 0) {
    return state.dataFiles;
  }
  return buildPlannerFileSlots(state);
}

/**
 * Format a planner raw filename from run + fraction + tech.
 * Examples: Run_1.raw | Run_1_F2.raw | Run_1_r2.raw | Run_1_F2_r2.raw
 */
export function formatPlannerRawFileName(
  runName: string,
  fractionId: number,
  technicalReplicate: number,
  options?: { includeFraction?: boolean; includeTech?: boolean }
): string {
  const base = (runName || 'run').trim().replace(/\s+/g, '_') || 'run';
  const includeFraction = options?.includeFraction ?? fractionId > 1;
  const includeTech = options?.includeTech ?? technicalReplicate > 1;
  let name = base;
  if (includeFraction) name += `_F${fractionId}`;
  if (includeTech) name += `_r${technicalReplicate}`;
  return `${name}.raw`;
}

/** Parse fraction / tech from common raw filename patterns. */
export function parseFractionTechFromName(fileName: string): {
  fractionId: number;
  technicalReplicate: number;
} {
  const base = fileName.replace(/\.[^.]+$/, '');
  // Prefer explicit fraction tags over pH (pH is often the fraction label in RP studies).
  const fractionMatch =
    base.match(/(?:^|[_\-.])(?:fraction|slice)(\d+)/i) ||
    base.match(/(?:^|[_\-.])Fr(\d+)(?:_|\.|$)/i) ||
    base.match(/(?:^|[_\-.])FT(\d+)(?:_|\.|$)/i) ||
    base.match(/_F(\d+)(?:_|\.|$)/) ||
    base.match(/(?:^|[_\-.])f(\d+)(?:_|\.|$)/i) ||
    base.match(/(?:^|[_\-.])pH(\d+)(?:_|\.|$)/i);
  // Prefer tech/replicate tags; bare "repN" is often biological and left as tech=1 by callers.
  const techMatch =
    base.match(/(?:^|[_\-.])(?:tech|technical)[_-]?(\d+)/i) ||
    base.match(/(?:^|[_\-.])(?:r|replicate)(\d+)(?:_|\.|$)/i) ||
    base.match(/_R(\d+)(?:_|\.|$)/);
  return {
    fractionId: fractionMatch ? parseInt(fractionMatch[1], 10) : 1,
    technicalReplicate: techMatch ? parseInt(techMatch[1], 10) : 1,
  };
}

/**
 * Generate empty/placeholder file slots from planner defaults.
 * One file per Run × fraction × tech (not per channel) — including label-free.
 * Filenames are formatted from run name + fraction + tech replicate.
 */
export function buildPlannerFileSlots(state: WizardState): WizardDataFile[] {
  const fractions = plannedFractionCount(state);
  const tech = plannedTechRepCount(state);
  const files: WizardDataFile[] = [];
  const runs = state.msRuns || [];
  const includeFraction = fractions > 1;
  const includeTech = tech > 1;
  const customPattern = (state.fileNamingPattern || '').trim();
  // Use custom pattern only when it references fraction/replicate/run placeholders;
  // otherwise prefer the structured Run_F#_r# naming.
  const useCustom =
    customPattern.length > 0 &&
    /\{(run|sourceName|fraction|replicate|n|label)\}/i.test(customPattern) &&
    customPattern !== '{sourceName}.raw';

  for (const run of runs) {
    const runToken = run.name.replace(/\s+/g, '_');
    for (let f = 1; f <= fractions; f++) {
      for (let r = 1; r <= tech; r++) {
        let fileName: string;
        if (useCustom) {
          fileName = customPattern
            .replace(/\{run\}/gi, runToken)
            .replace(/\{sourceName\}/gi, runToken)
            .replace(/\{fraction\}/gi, String(f))
            .replace(/\{replicate\}/gi, String(r))
            .replace(/\{n\}/gi, String(files.length + 1))
            .replace(/\{label\}/gi, '');
          if (!/\.[A-Za-z0-9]+$/.test(fileName)) {
            fileName += '.raw';
          }
        } else {
          fileName = formatPlannerRawFileName(run.name, f, r, {
            includeFraction,
            includeTech,
          });
        }
        files.push({
          fileName,
          runId: run.id,
          fractionId: f,
          technicalReplicate: r,
        });
      }
    }
  }
  return files;
}

/**
 * Expand files → SDRF rows (each file expands used channels of its MS run).
 * Label-free typically has one channel ("label free sample") per run.
 */
export function buildWizardExpansionRows(state: WizardState): WizardExpansionRow[] {
  const files = resolveEffectiveDataFiles(state);
  const samples = state.samples;
  const rows: WizardExpansionRow[] = [];
  let rowIndex = 1;
  const runs = state.msRuns || [];

  for (const file of files) {
    // Prefer run packing; fall back to legacy LF sampleIndex binding
    if (file.runId || runs.length > 0) {
      const run = runs.find(r => r.id === file.runId);
      if (!run) continue;
      const used = getUsedChannels(run);
      for (const channel of used) {
        const sample = findSample(samples, channel.sampleIndex);
        rows.push({
          rowIndex: rowIndex++,
          sourceName: resolveChannelSourceName(channel, samples),
          sampleIndex: channel.sampleIndex,
          label: channel.label,
          fractionId: file.fractionId ?? 1,
          technicalReplicate: file.technicalReplicate ?? 1,
          fileName: file.fileName,
          runId: run.id,
          role: channel.role,
          biologicalReplicate: sample?.biologicalReplicate ?? 1,
        });
      }
      continue;
    }

    const sample = findSample(samples, file.sampleIndex) || samples[0];
    rows.push({
      rowIndex: rowIndex++,
      sourceName: sample?.sourceName || `sample_${file.sampleIndex || 1}`,
      sampleIndex: sample?.index ?? file.sampleIndex,
      label: 'label free sample',
      fractionId: file.fractionId ?? 1,
      technicalReplicate: file.technicalReplicate ?? 1,
      fileName: file.fileName,
      role: 'sample',
      biologicalReplicate: sample?.biologicalReplicate ?? 1,
    });
  }
  return rows;
}

/**
 * Collapse consecutive equal values into SDRF modifiers (1-based row ranges).
 * Values equal to `defaultValue` (case-insensitive when both strings) are omitted.
 */
export function buildModifiersFromExpansion(
  rows: WizardExpansionRow[],
  getValue: (row: WizardExpansionRow) => string,
  defaultValue?: string
): { value: string; modifiers: { samples: string; value: string }[] } {
  if (rows.length === 0) {
    return { value: defaultValue ?? '', modifiers: [] };
  }

  const values = rows.map(getValue);
  const first = values[0];
  const base = defaultValue !== undefined ? defaultValue : first;
  const modifiers: { samples: string; value: string }[] = [];

  let start = 0;
  while (start < values.length) {
    let end = start;
    while (end + 1 < values.length && values[end + 1] === values[start]) {
      end++;
    }
    const v = values[start];
    const omit =
      defaultValue !== undefined &&
      v.toLowerCase() === defaultValue.toLowerCase();
    if (!omit) {
          const rowStart = rows[start].rowIndex;
      const rowEnd = rows[end].rowIndex;
      modifiers.push({
        samples: rowStart === rowEnd ? String(rowStart) : `${rowStart}-${rowEnd}`,
        value: v,
      });
    }
    start = end + 1;
  }

  // When using defaultValue mode, drop modifiers that match default (already handled).
  // When no defaultValue: keep all segment modifiers (full coverage).
  if (defaultValue === undefined) {
    return { value: first, modifiers };
  }

  // Only keep overrides vs default
  const overrideMods = modifiers.filter(
    m => m.value.toLowerCase() !== defaultValue.toLowerCase()
  );
  return { value: defaultValue, modifiers: overrideMods };
}

/** Validate a complete group/file plan without mutating the input state. */
export function runPlaceholderSnapshot(run: WizardMsRun): string {
  return JSON.stringify([run.name, run.labelConfigId, run.customLabels ?? [],
    run.sampleIndices ?? [], run.channels, run.factorValues ?? {}]);
}

export function applyRunsFilesPlan(state: WizardState, input: unknown): WizardState {
  const obj = (v: unknown): Record<string, any> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected a plan object.');
    return v as Record<string, any>;
  };
  const str = (v: unknown): string => {
    if (typeof v !== 'string' || !v.trim()) throw new Error('Expected a non-empty name.');
    return v.trim();
  };
  const integer = (v: unknown): number => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error('Fraction and technical replicate must be positive integers.');
    return v;
  };
  const plan = obj(input);
  if (!Array.isArray(plan['groups']) || !plan['groups'].length) throw new Error('Plan needs groups.');
  const runs = state.msRuns.map(r => ({ ...r }));
  const files = state.dataFiles.map(f => ({ ...f }));
  const names = new Set<string>();
  const assigned = new Set<string>();
  for (const raw of plan['groups']) {
    const group = obj(raw);
    const name = str(group['name']);
    if (names.has(name)) throw new Error(`Duplicate group: ${name}`);
    names.add(name);
    const matches = runs.filter(r => r.name === name);
    if (matches.length > 1) throw new Error(`Ambiguous group: ${name}`);
    const kit = LABEL_CONFIGS.find(k => k.id === group['labelConfigId']);
    if (!kit) throw new Error(`Unknown label kit for ${name}.`);
    if (!Array.isArray(group['channels']) || !group['channels'].length) throw new Error(`No channels for ${name}.`);
    const channels = createEmptyChannelsForLabels(kit.labels);
    const labels = new Set<string>();
    for (const rawChannel of group['channels']) {
      const ch = obj(rawChannel);
      const label = str(ch['label']);
      const target = channels.find(c => c.label === label);
      if (!target || labels.has(label)) throw new Error(`Invalid or duplicate channel: ${label}`);
      labels.add(label);
      const source = str(ch['sourceName']);
      const samples = state.samples.filter(s => s.sourceName === source);
      if (samples.length !== 1) throw new Error(`Expected exactly one sample named ${source}.`);
      Object.assign(target, { role: 'sample', sampleIndex: samples[0].index });
    }
    const factorValues: Record<string, string> = {};
    const proposedFactors = obj(group['factorValues'] ?? {});
    for (const key of Object.keys(proposedFactors)) {
      if (!state.factors.some(f => f.enabled && f.scope === 'run' && f.name === key)) throw new Error(`Unknown technical factor: ${key}`);
    }
    for (const factor of state.factors.filter(f => f.enabled && f.scope === 'run')) {
      const value = proposedFactors[factor.name] ?? (factor.values.length === 1 ? factor.values[0] : '');
      if (!factor.values.includes(value)) throw new Error(`Choose a valid ${factor.name} for ${name}.`);
      factorValues[factor.name] = value;
    }
    const run: WizardMsRun = {
      id: matches[0]?.id ?? newRunId(), name, labelConfigId: kit.id, channels, factorValues,
      sampleIndices: channels.flatMap(c => c.sampleIndex == null ? [] : [c.sampleIndex]),
    };
    if (!Array.isArray(group['files']) || !group['files'].length) throw new Error(`No files for ${name}.`);
    for (const rawFile of group['files']) {
      const file = obj(rawFile);
      const fileName = str(file['fileName']);
      if (assigned.has(fileName)) throw new Error(`File assigned twice: ${fileName}`);
      assigned.add(fileName);
      const matches = files.filter(f => f.fileName.trim() === fileName);
      if (matches.length !== 1) throw new Error(`Expected exactly one file in the pool named ${fileName}. Import exact file names first.`);
      Object.assign(matches[0], { runId: run.id, fractionId: integer(file['fractionId']), technicalReplicate: integer(file['technicalReplicate']) });
    }
    // Updating shared channels/factors affects every file in this group: require explicit coverage.
    if (files.some(f => f.runId === run.id && !group['files'].some((f2: any) => f2.fileName === f.fileName.trim()))) {
      throw new Error(`Include every existing file in group ${name} before changing its mapping.`);
    }
    const index = runs.findIndex(r => r.id === run.id);
    if (index < 0) runs.push(run); else runs[index] = run;
  }
  const mappedSamples = new Set(runs.filter(run => names.has(run.name)).flatMap(resolveRunSampleIndices));
  const retainedRuns = runs.filter(run => {
    if (!run.placeholderSnapshot || run.placeholderSnapshot !== runPlaceholderSnapshot(run)) return true;
    if (names.has(run.name) || state.dataFiles.some(file => file.runId === run.id)
      || files.some(file => file.runId === run.id)) return true;
    // A partial plan must not discard a placeholder for a sample it did not cover.
    return !resolveRunSampleIndices(run).every(index => mappedSamples.has(index));
  });
  return { ...state, msRuns: retainedRuns, dataFiles: files };
}

/** File identity is shared by all channels and distinct across acquisitions. */
export function assayNameForFile(fileName: string): string { return fileName.trim(); }

/** Validate Step 4 packing (label-free and multiplex both use MS runs). */
export function validateMsRuns(state: WizardState): boolean {
  const runs = state.msRuns || [];
  if (runs.length === 0) return false;
  const hasDefaultKit = !!state.labelConfigId || state.customLabels.length > 0;
  const hasRunKit = runs.some(r => !!r.labelConfigId || (r.customLabels?.length ?? 0) > 0);
  if (!hasDefaultKit && !hasRunKit) return false;

  for (const run of runs) {
    if (state.dataFiles.some(f => !!f.runId) && !state.dataFiles.some(f => f.runId === run.id)) continue;
    const used = getUsedChannels(run);
    if (used.length === 0) return false;
    for (const ch of used) {
      if (ch.role === 'sample' && (ch.sampleIndex == null || !state.samples.some(s => s.index === ch.sampleIndex))) {
        return false;
      }
      if (ch.role === 'pooled' && !(ch.pooledSampleIndices?.length)) {
        // Allow pooled with override name only
        if (!ch.sourceNameOverride?.trim()) return false;
      }
    }
  }
  return true;
}

/** Combined Runs & Files step: packing + every file assigned to a run. */
export function validateRunsAndFiles(state: WizardState): boolean {
  if (!validateMsRuns(state)) return false;
  if (!state.dataFiles.length) return false;
  const ids = new Set(state.msRuns.map(r => r.id));
  const names = state.dataFiles.map(f => f.fileName.trim());
  return new Set(names).size === names.length && state.dataFiles.every(f =>
    !!f.runId && ids.has(f.runId) && !!f.fileName.trim() &&
    Number.isInteger(f.fractionId ?? 1) && (f.fractionId ?? 1) >= 1 &&
    Number.isInteger(f.technicalReplicate ?? 1) && (f.technicalReplicate ?? 1) >= 1);
}

// ============ Wizard State ============

/**
 * Dynamic column default value.
 */
export interface DynamicColumnDefault {
  /** Column name */
  columnName: string;
  /** Default value (applies to all samples unless overridden) */
  value: string;
  /** Ontology term if selected from autocomplete */
  ontologyTerm?: OntologyTerm;
}

export function upsertDynamicColumnDefault(
  defaults: DynamicColumnDefault[],
  columnName: string,
  value: string,
  ontologyTerm?: OntologyTerm
): DynamicColumnDefault[] {
  const next = [...defaults];
  const idx = next.findIndex(d => d.columnName === columnName);
  const entry: DynamicColumnDefault = { columnName, value, ontologyTerm };
  if (idx >= 0) next[idx] = entry;
  else next.push(entry);
  return next;
}

/**
 * Complete wizard state.
 */
export interface WizardState {
  // Step 1: Experiment Setup
  /** @deprecated Prefer sampleTemplate; kept in sync for compatibility */
  template: WizardTemplate | null;
  sampleTemplate: WizardTemplate | null;
  technologyTemplate: WizardTemplate | null;
  experimentTemplates: string[];
  sampleCount: number;
  experimentDescription: string;

  // Step 2: Sample Characteristics (shared defaults)
  organism: OntologyTerm | null;
  disease: OntologyTerm | string | null;  // string for "normal" / reserved values
  organismPart: OntologyTerm | string | null;

  /** Resolved characteristics from selected sample + experiment templates */
  characteristicColumns: WizardCharacteristicColumnMeta[];

  /** Step2 multi-value candidate lists per characteristics column */
  characteristicChoices: Record<string, CharacteristicChoice[]>;

  // Step 2: Human-specific
  defaultSex: 'male' | 'female' | 'not available' | null;
  defaultAge: string;

  // Step 2: Cell line-specific
  defaultCellLine: string;

  // Step 2: Vertebrate-specific
  strainBreed: string;
  developmentalStage: string;

  // Step 2: Dynamic column defaults from template
  dynamicColumnDefaults: DynamicColumnDefault[];

  // Step 3: Sample-specific values
  samples: WizardSampleEntry[];

  // Step 4: Technical Configuration
  /** Default kit for new runs / Auto-pack. Each run may override via msRuns[].labelConfigId. */
  labelConfigId: string;
  customLabels: string[];
  /** MS runs with per-run channel packing (and optional per-run kit). */
  msRuns: WizardMsRun[];
  /** Planner: whether fractionation slots should be generated */
  hasFractions: boolean;
  /** Planner: expected fraction count for empty file slots */
  fractionCount: number;
  /** Planner: expected tech replicate count for empty file slots */
  technicalReplicates: number;
  acquisitionMethod: 'dda' | 'dia' | 'prm' | 'srm';

  // Step 5: Instrument & Protocol
  instrument: OntologyTerm | null;
  cleavageAgent: WizardCleavageAgent | null;
  modifications: WizardModification[];
  precursorMassTolerance: string;
  fragmentMassTolerance: string;

  // Step 6: Data Files
  fileNamingPattern: string;
  dataFiles: WizardDataFile[];

  // Factors (declared on Sample Values; emitted as factor value[…] columns)
  factors: WizardFactor[];
  factorDecision: 'pending' | 'none';
  noFactorReason: string;
}

/**
 * Resolve the sample-layer template id from wizard state.
 */
export function getSampleTemplateId(state: Pick<WizardState, 'sampleTemplate' | 'template'>): string | null {
  return state.sampleTemplate ?? state.template;
}

/**
 * Whether the wizard selection includes the cell-lines experiment template.
 */
export function hasCellLinesExperiment(
  state: Pick<WizardState, 'experimentTemplates' | 'sampleTemplate' | 'template'>
): boolean {
  if (state.experimentTemplates?.includes('cell-lines')) return true;
  return isCellLineTemplate(getSampleTemplateId(state));
}

/**
 * Creates a default sample entry.
 */
export function createDefaultSample(index: number): WizardSampleEntry {
  return {
    index,
    sourceName: `sample_${index}`,
    biologicalReplicate: 1,
    factorValues: {},
  };
}

/**
 * Creates an empty wizard state.
 */
export function createEmptyWizardState(): WizardState {
  return {
    // Step 1
    template: 'human',
    sampleTemplate: 'human',
    technologyTemplate: 'ms-proteomics',
    experimentTemplates: [],
    sampleCount: 1,
    experimentDescription: '',

    // Step 2 (shared)
    organism: null,
    disease: null,
    organismPart: null,
    characteristicColumns: [],
    characteristicChoices: {},

    // Step 2 (human)
    defaultSex: null,
    defaultAge: '',

    // Step 2 (cell line)
    defaultCellLine: '',

    // Step 2 (vertebrate)
    strainBreed: '',
    developmentalStage: '',

    // Step 2 (dynamic)
    dynamicColumnDefaults: [],

    // Step 3 - Initialize with one sample to match sampleCount
    samples: [createDefaultSample(1)],

    // Step 4 — label-free default with one packed run
    labelConfigId: 'lf',
    customLabels: [],
    msRuns: packSamplesIntoRuns(
      [createDefaultSample(1)],
      ['label free sample'],
      undefined,
      'lf'
    ),
    hasFractions: false,
    fractionCount: 1,
    technicalReplicates: 1,
    acquisitionMethod: 'dda',

    // Step 5
    instrument: null,
    cleavageAgent: null,
    modifications: [],
    precursorMassTolerance: '',
    fragmentMassTolerance: '',

    // Step 6
    fileNamingPattern: '{sourceName}.raw',
    dataFiles: [],

    // Factors
    factors: [],
    factorDecision: 'pending',
    noFactorReason: '',
  };
}

// ============ Step Configuration ============

/**
 * Wizard step configuration.
 */
export interface WizardStepConfig {
  id: string;
  title: string;
  description: string;
  isRequired: boolean;
}

/**
 * Wizard steps configuration.
 */
export const WIZARD_STEPS: WizardStepConfig[] = [
  { id: 'setup', title: 'Experiment Setup', description: 'Select sample and technology templates', isRequired: true },
  { id: 'characteristics', title: 'Sample Characteristics', description: 'Define organism, disease, and tissue', isRequired: true },
  {
    id: 'samples',
    title: 'Sample Values',
    description: 'Names, replicates, per-sample values, and study factors',
    isRequired: true,
  },
  {
    id: 'runs-files',
    title: 'Runs & Files',
    description: 'MS runs, channel packing, and raw file mapping',
    isRequired: true,
  },
  { id: 'protocol', title: 'Instrument & Protocol', description: 'Instrument, enzyme, and modifications', isRequired: true },
  { id: 'review', title: 'Review & Create', description: 'Preview and generate SDRF', isRequired: true },
];
/** Linked factors use the same sample choices as the characteristic; never stored overrides. */
export function factorCandidates(state: WizardState, factor: WizardFactor): string[] {
  return factor.sourceCharacteristic
    ? (state.characteristicChoices[factor.sourceCharacteristic] || []).map(choice => choice.value)
    : factor.values;
}

export function resolveFactorValue(state: WizardState, sample: WizardSampleEntry, factor: WizardFactor): string {
  const candidates = factorCandidates(state, factor);
  if (factor.sourceCharacteristic) {
    return candidates.length === 1 ? candidates[0]
      : sample.characteristicValues?.[factor.sourceCharacteristic]?.trim() || '';
  }
  return sample.factorValues?.[factor.name]?.trim() || (candidates.length === 1 ? candidates[0] : '');
}

export function factorDefinitionErrors(state: WizardState): string[] {
  const errors: string[] = [];
  const names = new Set<string>();
  for (const factor of state.factors.filter(f => f.enabled)) {
    const name = factor.name.trim().toLowerCase();
    if (!name || /[\[\]\t\r\n]/.test(name)) errors.push('Enter a valid factor name without brackets.');
    if (names.has(name)) errors.push(`Duplicate factor: ${name}.`);
    names.add(name);
    if (factor.scope === 'run' && factor.sourceCharacteristic) errors.push(`Run factor ${name} cannot link a sample characteristic.`);
    if (factor.sourceCharacteristic && !/^characteristics\[[^\[\]]+\]$/.test(factor.sourceCharacteristic)) {
      errors.push(`Invalid source characteristic for ${name}.`);
    }
    if (!factorCandidates(state, factor).length) errors.push(`Add candidate values for ${name || 'the factor'}${factor.sourceCharacteristic ? ' in its linked characteristic' : ''}.`);
  }
  return errors;
}

export function factorAssignmentsValid(state: WizardState): boolean {
  return factorDefinitionErrors(state).length === 0 && state.samples.every(sample =>
    state.factors.filter(f => f.enabled && f.scope !== 'run').every(factor => {
      const value = resolveFactorValue(state, sample, factor);
      return !!value && factorCandidates(state, factor).some(candidate => choiceValuesEqual(candidate, value));
    })
  );
}

export function resolveRunFactorValue(run: WizardMsRun | undefined, factor: WizardFactor): string {
  return run?.factorValues?.[factor.name]?.trim() || (factor.values.length === 1 ? factor.values[0] : '');
}

export function runFactorAssignmentsValid(state: WizardState): boolean {
  const factors = state.factors.filter(f => f.enabled && f.scope === 'run');
  if (factors.length && !state.msRuns.length) return false;
  return state.msRuns.filter(run => !state.dataFiles.some(f => !!f.runId) || state.dataFiles.some(f => f.runId === run.id)).every(run => factors.every(factor => {
    const value = resolveRunFactorValue(run, factor);
    return !!value && factor.values.some(candidate => choiceValuesEqual(candidate, value));
  }));
}

export function factorDecisionValid(state: WizardState): boolean {
  const enabled = state.factors.filter(f => f.enabled);
  return state.factorDecision === 'none'
    ? enabled.length === 0 && !!state.noFactorReason.trim()
    : enabled.length > 0 && factorDefinitionErrors(state).length === 0;
}
