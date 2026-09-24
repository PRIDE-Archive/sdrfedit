import type { TemplateColumn, TemplateCombinationResult, TemplateValidator } from './template';

export interface TemplateRef { name: string; version: string; }
export interface RuleSource { template: string; version: string; field: string; path: string; url: string; }
export interface CatalogTemplate {
  name: string;
  version: string;
  layer: string | null;
  description?: string;
  documentation?: string;
  extends?: string | null;
  usable_alone?: boolean;
  mutually_exclusive_with?: string[];
  requires?: Array<{ layer: string }>;
  excludes?: { templates?: string[]; categories?: string[]; columns?: string[] };
  columns: unknown[];
  versions: string[];
  status?: string;
  source: RuleSource;
  _unsupported?: string[];
}
export interface CatalogSnapshot {
  snapshotId: string;
  commitSha: string;
  fetchedAt: string;
  checkedAt?: string;
  stale?: boolean;
  syncError?: string | null;
  templates: CatalogTemplate[];
}
export interface CatalogResolution extends TemplateCombinationResult {
  snapshotId: string;
  columns: TemplateColumn[];
  validators?: TemplateValidator[];
  leafTemplates: TemplateRef[];
  resolvedTemplates: TemplateRef[];
  issues: Array<{ message: string; severity: string; source: RuleSource | null }>;
  availability: Record<string, { status: 'selected' | 'available' | 'conflicting' | 'inherited'; reasons: string[]; conflictsWith?: TemplateRef[] }>;
}
