import type { TemplateRef } from './template-catalog';
/**
 * Template Model
 *
 * Interfaces for SDRF template definitions loaded from YAML or API.
 * Templates define required columns, validators, and inheritance relationships.
 */

/**
 * Validator types supported by templates.
 */
export type ValidatorName = 'ontology' | 'pattern' | 'values' | 'single_cardinality_validator';

/**
 * Error levels for validation.
 */
export type ErrorLevel = 'error' | 'warning';

/**
 * Requirement levels for columns.
 */
export type RequirementLevel = 'required' | 'recommended' | 'optional';

/**
 * Template layers - determines how templates can be combined.
 */
export type TemplateLayer = string;

/**
 * Column cardinality.
 */
export type ColumnCardinality = 'single' | 'multiple';

/**
 * A requirement constraint from templates.yaml (requires:).
 */
export interface TemplateRequirement {
  /** Required layer (e.g. "sample", "technology") */
  layer?: TemplateLayer;
  /** Required specific template name */
  template?: string;
}

/**
 * Exclusion constraints from templates.yaml (excludes:).
 */
export interface TemplateExclusions {
  /** Templates whose column contributions are excluded during composition */
  templates?: string[];
  categories?: string[];
  columns?: string[];
}

/**
 * Selection used for combination validation.
 */
export interface TemplateSelection {
  selectedTemplates?: TemplateRef[];
  snapshotId?: string;
  technologyTemplate: string | null;
  sampleTemplate: string | null;
  sampleMetadataTemplates?: string[];
  experimentTemplates: string[];
}

/**
 * Result of combination validation.
 */
export interface TemplateCombinationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Parameters for a template validator.
 */
export interface TemplateValidatorParams {
  [key: string]: any;
  /** Ontologies to validate against (for ontology validator) */
  ontologies?: string[];
  /** Regex pattern for validation (for pattern validator) */
  pattern?: string;
  /** Allowed values (for values validator) */
  values?: string[];
  /** Error level for validation failures */
  errorLevel?: ErrorLevel;
  /** Description of the validation rule */
  description?: string;
  /** Example valid values */
  examples?: string[];
  /** Whether pattern matching is case sensitive */
  caseSensitive?: boolean;
  /** Minimum columns required (for min_columns validator) */
  minColumns?: number;
  /** Column names for combination validators */
  columnName?: string[];
  /** Column names for warnings in combination validators */
  columnNameWarning?: string[];
}

/**
 * A validator definition for a column or template.
 */
export interface TemplateValidator {
  /** Name of the validator */
  validatorName: ValidatorName | string;
  /** Validator parameters */
  params: TemplateValidatorParams;
}

/**
 * A column definition within a template.
 */
export interface TemplateColumn {
  default?: string;
  provenance?: Array<{ template: string; version: string; url: string }>;
  /** Column name (e.g., "characteristics[organism]") */
  name: string;
  /** Description of the column */
  description: string;
  /** Whether the column is required, recommended, or optional */
  requirement: RequirementLevel;
  /** Whether "not applicable" is an allowed value */
  allowNotApplicable?: boolean;
  /** Whether "not available" is an allowed value */
  allowNotAvailable?: boolean;
  /** Whether "anonymized" is an allowed value */
  allowAnonymized?: boolean;
  /** Whether "pooled" is an allowed value */
  allowPooled?: boolean;
  /** Column cardinality - single or multiple columns with same name */
  cardinality?: ColumnCardinality;
  /** Column data type */
  type?: 'string' | 'integer' | 'float';
  /** Validators for this column */
  validators?: TemplateValidator[];
}

/**
 * A template definition as loaded from YAML or API.
 */
export interface TemplateDefinition {
  /** Template name (e.g., "human", "ms-proteomics") */
  name: string;
  /** Description of the template */
  description: string;
  /** Template version (semver) */
  version: string;
  /** Parent template name (for inheritance) */
  extends: string | null;
  /** Whether this template can be used alone */
  usableAlone: boolean;
  /** Template layer (technology, sample, experiment) */
  layer: TemplateLayer | null;
  /** Layer/template requirements for combination */
  requires?: TemplateRequirement[];
  /** Templates that cannot be combined with this one */
  excludes?: TemplateExclusions;
  /** Templates that are mutually exclusive with this one */
  mutuallyExclusiveWith?: string[];
  /** Template-level validators */
  validators?: TemplateValidator[];
  /** Column definitions */
  columns: TemplateColumn[];
  /** Template status */
  status?: 'stable' | 'development';
}

/**
 * A resolved template with inheritance applied.
 */
export interface ResolvedTemplate extends TemplateDefinition {
  /** Columns after inheritance resolution */
  resolvedColumns: TemplateColumn[];
  /** Parent chain for debugging (e.g., ["base", "ms-proteomics"]) */
  parentChain: string[];
  /** Combined template-level validators from all parents */
  resolvedValidators: TemplateValidator[];
}

/**
 * Template manifest entry from templates.yaml.
 */
export interface TemplateManifestEntry {
  /** Latest version */
  latest: string;
  /** Available versions */
  versions: string[];
  /** Parent template name */
  extends: string | null;
  /** Whether usable alone */
  usableAlone: boolean;
  /** Template layer */
  layer: TemplateLayer | null;
  /** Combination requirements */
  requires?: TemplateRequirement[];
  /** Exclusion constraints */
  excludes?: TemplateExclusions;
  /** Template status */
  status: 'stable' | 'development';
  /** Description */
  description: string;
}

/**
 * Template manifest structure from templates.yaml.
 */
export interface TemplateManifest {
  schemaVersion: string;
  generatedAt: string;
  templates: Record<string, TemplateManifestEntry>;
}

/**
 * API response for templates endpoint.
 */
export interface ApiTemplatesResponse {
  templates: string[];
  version?: string;
}

/**
 * Template info for UI display.
 */
export interface TemplateInfo {
  /** Template ID/name */
  id: string;
  /** Display name */
  name: string;
  /** Description */
  description: string;
  /** Template layer */
  layer: TemplateLayer | null;
  /** Whether usable alone */
  usableAlone: boolean;
  /** Parent template */
  extends: string | null;
  /** Combination requirements */
  requires?: TemplateRequirement[];
  /** Exclusion constraints */
  excludes?: TemplateExclusions;
  /** Icon for UI (derived from template name) */
  icon?: string;
  /** Status */
  status?: 'stable' | 'development';
  /** Latest version from manifest when available */
  version?: string;
}

/**
 * Parse requires array from YAML.
 */
export function parseTemplateRequires(raw: unknown): TemplateRequirement[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((item: any) => ({
    layer: item?.layer || undefined,
    template: item?.template || undefined,
  }));
}

/**
 * Parse excludes object from YAML.
 */
export function parseTemplateExcludes(raw: unknown): TemplateExclusions | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const value = raw as any;
  return { templates: value.templates, categories: value.categories, columns: value.columns };
}

/**
 * Whether a template is considered development / unstable for UI folding.
 */
export function isDevelopmentTemplate(info: Pick<TemplateInfo, 'id' | 'status' | 'version'>): boolean {
  if (info.status === 'development') return true;
  const version = info.version || '';
  return /-/.test(version);
}

/**
 * Parse parent template id from extends field.
 * Official YAML uses forms like "sample-metadata@>=1.0.0" or plain "ms-proteomics".
 */
export function parseExtendsTemplateName(extendsValue: string | null | undefined): string | null {
  if (!extendsValue) return null;
  const trimmed = extendsValue.trim();
  if (!trimmed) return null;
  const at = trimmed.indexOf('@');
  return at >= 0 ? trimmed.slice(0, at) : trimmed;
}

/**
 * Convert snake_case YAML keys to camelCase.
 */
export function convertYamlToTemplateDefinition(yaml: any): TemplateDefinition {
  return {
    name: yaml.name,
    description: yaml.description,
    version: yaml.version,
    extends: yaml.extends || null,
    usableAlone: yaml.usable_alone ?? true,
    layer: yaml.layer || null,
    requires: parseTemplateRequires(yaml.requires),
    excludes: parseTemplateExcludes(yaml.excludes),
    mutuallyExclusiveWith: yaml.mutually_exclusive_with,
    status: yaml.status,
    validators: Array.isArray(yaml.validators)
      ? yaml.validators.map((v: any) => convertYamlToValidator(v))
      : undefined,
    columns: Array.isArray(yaml.columns)
      ? yaml.columns.map((c: any) => convertYamlToColumn(c))
      : [],
  };
}

/**
 * Convert YAML column to TemplateColumn.
 */
export function convertYamlToColumn(yaml: any): TemplateColumn {
  return {
    name: yaml.name,
    description: yaml.description || '',
    requirement: yaml.requirement || 'optional',
    default: yaml.default,
    provenance: yaml.provenance,
    allowNotApplicable: yaml.allow_not_applicable,
    allowNotAvailable: yaml.allow_not_available,
    allowAnonymized: yaml.allow_anonymized,
    allowPooled: yaml.allow_pooled,
    cardinality: yaml.cardinality,
    type: yaml.type,
    validators: Array.isArray(yaml.validators)
      ? yaml.validators.map((v: any) => convertYamlToValidator(v))
      : undefined,
  };
}

/**
 * Convert YAML validator to TemplateValidator.
 */
export function convertYamlToValidator(yaml: any): TemplateValidator {
  return {
    validatorName: yaml.validator_name,
    params: {
      ...yaml.params,
      ontologies: yaml.params?.ontologies,
      errorLevel: yaml.error_level ?? yaml.params?.error_level,
      description: yaml.description ?? yaml.params?.description,
    },
  };
}

/** Presentation fallbacks; catalogue metadata supplies descriptions and ordering. */
export function getTemplateIcon(_templateId: string): string { return 'category'; }
export function getTemplateEmoji(_templateId: string): string { return '📋'; }
export function getTemplateShortDescription(_templateId: string): string { return ''; }
export function getTemplateSortOrder(_templateId: string): number { return 0; }
export function getTemplateDisplayName(templateId: string): string {
  return templateId.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}
