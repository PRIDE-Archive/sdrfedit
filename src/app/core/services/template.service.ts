/**
 * Template Service
 *
 * Fetches and manages SDRF templates from the API or bundled YAML files.
 * Handles template inheritance resolution.
 */

import { Injectable, signal, computed } from '@angular/core';
import { load as loadYaml } from 'js-yaml';
import {
  TemplateDefinition,
  TemplateColumn,
  TemplateValidator,
  ResolvedTemplate,
  TemplateInfo,
  TemplateManifest,
  TemplateSelection,
  TemplateCombinationResult,
  TemplateLayer,
  RequirementLevel,
  convertYamlToTemplateDefinition,
  parseTemplateRequires,
  parseTemplateExcludes,
  parseExtendsTemplateName,
  getTemplateIcon,
  getTemplateDisplayName,
  getTemplateShortDescription,
  getTemplateSortOrder,
  isDevelopmentTemplate,
} from '../models/template';
import { isWizardSkippedCharacteristic } from '../models/wizard';

/** Parse official SDRF template YAML (js-yaml — custom parser dropped columns). */
function parseYaml(yamlText: string): any {
  return loadYaml(yamlText) ?? {};
}

const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com/bigbio/sdrf-templates/main';
const API_BASE_URL = 'https://www.ebi.ac.uk/pride/services/sdrf-validator';

// Cache TTL in milliseconds (5 minutes)
const CACHE_TTL = 5 * 60 * 1000;

@Injectable({ providedIn: 'root' })
export class TemplateService {
  // State signals
  private readonly _templates = signal<Map<string, TemplateDefinition>>(new Map());
  private readonly _resolvedCache = signal<Map<string, ResolvedTemplate>>(new Map());
  private readonly _isLoading = signal<boolean>(false);
  private readonly _error = signal<string | null>(null);
  private readonly _manifest = signal<TemplateManifest | null>(null);
  private readonly _lastFetchTime = signal<number>(0);

  // Public readonly signals
  readonly templates = this._templates.asReadonly();
  readonly isLoading = this._isLoading.asReadonly();
  readonly error = this._error.asReadonly();

  /**
   * Get all loaded template definitions.
   */
  readonly allTemplates = computed(() => Array.from(this._templates().values()));

  /**
   * Get templates that can be used alone (usableAlone: true).
   */
  readonly usableTemplates = computed(() =>
    this.allTemplates().filter(t => t.usableAlone)
  );

  /**
   * Get sample layer templates.
   */
  readonly sampleTemplates = computed(() =>
    this.allTemplates().filter(t => t.layer === 'sample')
  );

  /**
   * Get technology layer templates.
   */
  readonly technologyTemplates = computed(() =>
    this.allTemplates().filter(t => t.layer === 'technology')
  );

  /**
   * Get experiment layer templates.
   */
  readonly experimentTemplates = computed(() =>
    this.allTemplates().filter(t => t.layer === 'experiment')
  );

  /**
   * Fetch all templates from the manifest and load their definitions.
   */
  async fetchTemplates(): Promise<void> {
    // Check cache
    const now = Date.now();
    if (now - this._lastFetchTime() < CACHE_TTL && this._templates().size > 0) {
      return;
    }

    this._isLoading.set(true);
    this._error.set(null);

    try {
      // First, try to fetch the manifest
      const manifest = await this.fetchManifest();
      this._manifest.set(manifest);

      // Load all templates
      const templates = new Map<string, TemplateDefinition>();
      const templateNames = Object.keys(manifest.templates);

      // Fetch templates in parallel with a concurrency limit
      const batchSize = 5;
      for (let i = 0; i < templateNames.length; i += batchSize) {
        const batch = templateNames.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map(name => this.fetchTemplateDefinition(name, manifest.templates[name].latest))
        );

        for (let j = 0; j < results.length; j++) {
          const result = results[j];
          const name = batch[j];
          if (result.status === 'fulfilled' && result.value) {
            // Individual YAML files often omit layer/requires; merge from manifest
            templates.set(name, this.mergeManifestMetadata(result.value, manifest.templates[name]));
          } else if (result.status === 'rejected') {
            console.warn(`Failed to fetch template ${name}:`, result.reason);
          }
        }
      }

      if (templates.size === 0) {
        // Manifest ok but definitions failed (network/CORS) — use fallbacks
        await this.loadFallbackTemplates();
      } else {
        this._templates.set(templates);
      }
      this._lastFetchTime.set(now);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this._error.set(errorMessage);
      console.error('Failed to fetch templates:', error);

      // Fall back to default templates if we have none
      if (this._templates().size === 0) {
        await this.loadFallbackTemplates();
      }
    } finally {
      this._isLoading.set(false);
    }
  }

  /**
   * Enrich a fetched template definition with layer/requires from the manifest.
   * Per-template YAML often omits these fields (they live in templates.yaml).
   */
  private mergeManifestMetadata(
    definition: TemplateDefinition,
    entry?: TemplateManifest['templates'][string]
  ): TemplateDefinition {
    if (!entry) return definition;
    return {
      ...definition,
      layer: definition.layer ?? entry.layer ?? null,
      usableAlone: definition.usableAlone || entry.usableAlone,
      requires: definition.requires ?? entry.requires,
      excludes: definition.excludes ?? entry.excludes,
      status: definition.status ?? entry.status,
      version: definition.version || entry.latest,
      description: definition.description || entry.description || '',
    };
  }

  /**
   * Fetch the templates manifest.
   */
  private async fetchManifest(): Promise<TemplateManifest> {
    const response = await fetch(`${GITHUB_RAW_BASE}/templates.yaml`);
    if (!response.ok) {
      throw new Error(`Failed to fetch manifest: ${response.status}`);
    }

    const yamlText = await response.text();
    const parsed = parseYaml(yamlText);

    return {
      schemaVersion: parsed.schema_version || '1.0',
      generatedAt: parsed.generated_at || new Date().toISOString(),
      templates: this.convertManifestTemplates(parsed.templates || {}),
    };
  }

  /**
   * Convert manifest templates from YAML format.
   */
  private convertManifestTemplates(templates: any): TemplateManifest['templates'] {
    const result: TemplateManifest['templates'] = {};
    for (const [name, data] of Object.entries(templates as Record<string, any>)) {
      const latest = data.latest || '1.0.0';
      result[name] = {
        latest,
        versions: data.versions || [latest],
        extends: data.extends || null,
        usableAlone: data.usable_alone ?? false,
        layer: data.layer || null,
        requires: parseTemplateRequires(data.requires),
        excludes: parseTemplateExcludes(data.excludes),
        status: data.status || (String(latest).includes('dev') ? 'development' : 'stable'),
        description: data.description || '',
      };
    }
    return result;
  }

  /**
   * Fetch a specific template definition.
   */
  private async fetchTemplateDefinition(name: string, version: string): Promise<TemplateDefinition | null> {
    try {
      const url = `${GITHUB_RAW_BASE}/${name}/${version}/${name}.yaml`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const yamlText = await response.text();
      const parsed = parseYaml(yamlText);
      return convertYamlToTemplateDefinition(parsed);
    } catch (error) {
      console.warn(`Failed to fetch template ${name}@${version}:`, error);
      return null;
    }
  }

  /**
   * Load fallback templates when fetch fails.
   */
  private async loadFallbackTemplates(): Promise<void> {
    const fallbackTemplates: TemplateDefinition[] = [
      {
        name: 'human',
        description: 'Human Samples',
        version: '1.1.0',
        extends: null,
        usableAlone: false,
        layer: 'sample',
        columns: this.getBaseColumns(),
      },
      {
        name: 'vertebrates',
        description: 'Vertebrates (Non-Human)',
        version: '1.1.0',
        extends: null,
        usableAlone: false,
        layer: 'sample',
        columns: this.getBaseColumns(),
      },
      {
        name: 'invertebrates',
        description: 'Invertebrates',
        version: '1.1.0',
        extends: null,
        usableAlone: false,
        layer: 'sample',
        columns: this.getBaseColumns(),
      },
      {
        name: 'plants',
        description: 'Plants',
        version: '1.1.0',
        extends: null,
        usableAlone: false,
        layer: 'sample',
        columns: this.getBaseColumns(),
      },
      {
        name: 'ms-proteomics',
        description: 'MS Proteomics',
        version: '1.1.0',
        extends: null,
        usableAlone: true,
        layer: 'technology',
        columns: this.getMsProteomicsColumns(),
      },
      {
        name: 'affinity-proteomics',
        description: 'Affinity-based Proteomics',
        version: '1.0.0',
        extends: null,
        usableAlone: true,
        layer: 'technology',
        columns: this.getBaseColumns(),
      },
      {
        name: 'cell-lines',
        description: 'Cell Lines',
        version: '1.1.0',
        extends: null,
        usableAlone: false,
        layer: 'experiment',
        requires: [{ layer: 'technology' }, { layer: 'sample' }],
        columns: this.getBaseColumns(),
      },
      {
        name: 'dia-acquisition',
        description: 'DIA Acquisition',
        version: '1.1.0',
        extends: 'ms-proteomics',
        usableAlone: false,
        layer: 'experiment',
        columns: [],
      },
      {
        name: 'single-cell',
        description: 'Single Cell',
        version: '1.0.0',
        extends: 'ms-proteomics',
        usableAlone: false,
        layer: 'experiment',
        columns: [],
      },
      {
        name: 'immunopeptidomics',
        description: 'Immunopeptidomics',
        version: '1.0.0',
        extends: 'ms-proteomics',
        usableAlone: false,
        layer: 'experiment',
        columns: [],
      },
      {
        name: 'crosslinking',
        description: 'Crosslinking (XL-MS)',
        version: '1.0.0',
        extends: 'ms-proteomics',
        usableAlone: false,
        layer: 'experiment',
        columns: [],
      },
    ];

    const templates = new Map<string, TemplateDefinition>();
    for (const template of fallbackTemplates) {
      templates.set(template.name, template);
    }
    this._templates.set(templates);
  }

  /**
   * Get base columns for fallback templates.
   */
  private getBaseColumns(): TemplateColumn[] {
    return [
      { name: 'source name', description: 'Unique sample identifier', requirement: 'required' },
      { name: 'characteristics[organism]', description: 'Species', requirement: 'required', validators: [{ validatorName: 'ontology', params: { ontologies: ['ncbitaxon'] } }] },
      { name: 'characteristics[organism part]', description: 'Anatomical part', requirement: 'required', validators: [{ validatorName: 'ontology', params: { ontologies: ['uberon', 'bto'] } }] },
      { name: 'characteristics[disease]', description: 'Disease state', requirement: 'required', validators: [{ validatorName: 'ontology', params: { ontologies: ['mondo', 'efo', 'doid'] } }] },
      { name: 'characteristics[biological replicate]', description: 'Biological replicate number', requirement: 'required' },
    ];
  }

  /**
   * Get MS proteomics columns for fallback templates.
   */
  private getMsProteomicsColumns(): TemplateColumn[] {
    return [
      ...this.getBaseColumns(),
      { name: 'assay name', description: 'Unique assay identifier', requirement: 'required' },
      { name: 'technology type', description: 'Technology used', requirement: 'required' },
      { name: 'comment[instrument]', description: 'Instrument used', requirement: 'required', validators: [{ validatorName: 'ontology', params: { ontologies: ['ms'] } }] },
      { name: 'comment[label]', description: 'Labeling strategy', requirement: 'required' },
      { name: 'comment[fraction identifier]', description: 'Fraction number', requirement: 'required' },
      { name: 'comment[cleavage agent details]', description: 'Enzyme used', requirement: 'required' },
      { name: 'comment[modification parameters]', description: 'PTMs searched', requirement: 'recommended', cardinality: 'multiple' },
      { name: 'comment[proteomics data acquisition method]', description: 'Acquisition method', requirement: 'required' },
      { name: 'comment[data file]', description: 'Data file name', requirement: 'required' },
    ];
  }

  /**
   * Get a resolved template with inheritance applied.
   */
  async getResolvedTemplate(name: string): Promise<ResolvedTemplate> {
    // Check cache
    const cached = this._resolvedCache().get(name);
    if (cached) return cached;

    // Ensure templates are loaded
    if (this._templates().size === 0) {
      await this.fetchTemplates();
    }

    const template = this._templates().get(name);
    if (!template) {
      throw new Error(`Template not found: ${name}`);
    }

    const resolved = await this.resolveInheritance(template);

    // Cache the result
    this._resolvedCache.update(cache => {
      const newCache = new Map(cache);
      newCache.set(name, resolved);
      return newCache;
    });

    return resolved;
  }

  /**
   * Resolve template inheritance recursively.
   */
  private async resolveInheritance(template: TemplateDefinition): Promise<ResolvedTemplate> {
    const parentChain: string[] = [];
    let resolvedColumns: TemplateColumn[] = [...template.columns];
    let resolvedValidators: TemplateValidator[] = [...(template.validators || [])];

    // Walk up the inheritance chain
    let currentTemplate = template;
    while (currentTemplate.extends) {
      const parentName = parseExtendsTemplateName(currentTemplate.extends);
      if (!parentName) break;
      parentChain.unshift(parentName);

      const parent = this._templates().get(parentName);
      if (!parent) {
        console.warn(`Parent template not found: ${parentName}`);
        break;
      }

      // Merge parent columns with child columns
      resolvedColumns = this.mergeColumns(parent.columns, resolvedColumns);

      // Merge validators
      resolvedValidators = [...(parent.validators || []), ...resolvedValidators];

      currentTemplate = parent;
    }

    return {
      ...template,
      resolvedColumns,
      parentChain,
      resolvedValidators,
    };
  }

  /**
   * Characteristics columns for wizard Step2 from sample + experiment templates.
   * Technology templates are intentionally excluded.
   */
  async getWizardCharacteristicColumns(selection: {
    sampleTemplate: string | null;
    experimentTemplates: string[];
  }): Promise<{
    required: TemplateColumn[];
    recommended: TemplateColumn[];
    all: TemplateColumn[];
  }> {
    if (this._templates().size === 0) {
      await this.fetchTemplates();
    }

    const ids = [
      selection.sampleTemplate,
      ...(selection.experimentTemplates || []),
    ].filter((id): id is string => !!id);

    let merged: TemplateColumn[] = [];
    for (const id of ids) {
      try {
        const resolved = await this.getResolvedTemplate(id);
        merged = this.mergeColumns(merged, resolved.resolvedColumns || []);
      } catch (e) {
        console.warn(`Could not resolve template columns for ${id}:`, e);
      }
    }

    const characteristics = merged.filter(
      c =>
        typeof c.name === 'string' &&
        c.name.toLowerCase().startsWith('characteristics[') &&
        !isWizardSkippedCharacteristic(c.name)
    );

    // Minimal fallback when resolve yields nothing (offline / no sample)
    if (characteristics.length === 0) {
      const fallback: TemplateColumn[] = [
        {
          name: 'characteristics[organism]',
          description: 'Species',
          requirement: 'required',
          validators: [{ validatorName: 'ontology', params: { ontologies: ['ncbitaxon'] } }],
        },
        {
          name: 'characteristics[disease]',
          description: 'Disease state',
          requirement: 'required',
          validators: [{ validatorName: 'ontology', params: { ontologies: ['mondo', 'efo', 'doid'] } }],
        },
        {
          name: 'characteristics[organism part]',
          description: 'Anatomical part',
          requirement: 'required',
          validators: [{ validatorName: 'ontology', params: { ontologies: ['uberon', 'bto'] } }],
        },
      ];
      return {
        required: fallback,
        recommended: [],
        all: fallback,
      };
    }

    const required = characteristics.filter(c => (c.requirement || 'optional') === 'required');
    const recommended = characteristics.filter(c => c.requirement === 'recommended');
    return { required, recommended, all: [...required, ...recommended] };
  }

  /**
   * Merge parent and child columns, ensuring child can't be less strict.
   */
  private mergeColumns(parentColumns: TemplateColumn[], childColumns: TemplateColumn[]): TemplateColumn[] {
    const merged = new Map<string, TemplateColumn>();

    // Add parent columns first
    for (const col of parentColumns) {
      merged.set(col.name, { ...col });
    }

    // Override/add child columns
    for (const col of childColumns) {
      const parent = merged.get(col.name);
      if (parent) {
        // Merge - child can only make things stricter
        merged.set(col.name, this.mergeColumn(parent, col));
      } else {
        // New column from child
        merged.set(col.name, { ...col });
      }
    }

    return Array.from(merged.values());
  }

  /**
   * Merge a single column, ensuring child can't be less strict than parent.
   */
  private mergeColumn(parent: TemplateColumn, child: TemplateColumn): TemplateColumn {
    const requirementOrder: RequirementLevel[] = ['required', 'recommended', 'optional'];
    const parentReqIndex = requirementOrder.indexOf(parent.requirement);
    const childReqIndex = requirementOrder.indexOf(child.requirement);

    // Child can't demote requirement level
    const requirement = childReqIndex <= parentReqIndex ? child.requirement : parent.requirement;

    // Merge validators (child validators added to parent)
    const validators = [
      ...(parent.validators || []),
      ...(child.validators || []).filter(
        cv => !(parent.validators || []).some(pv => pv.validatorName === cv.validatorName)
      ),
    ];

    return {
      ...parent,
      ...child,
      requirement,
      // Child can only make these false if parent is true
      allowNotApplicable: parent.allowNotApplicable === false ? false : child.allowNotApplicable,
      allowNotAvailable: parent.allowNotAvailable === false ? false : child.allowNotAvailable,
      validators: validators.length > 0 ? validators : undefined,
    };
  }

  /**
   * Resolve effective layer from definition, manifest, or known wizard defaults.
   */
  private resolveLayer(
    name: string,
    definitionLayer?: TemplateLayer | null,
    entryLayer?: TemplateLayer | null
  ): TemplateLayer | null {
    return definitionLayer ?? entryLayer ?? this.getKnownTemplateLayer(name);
  }

  /**
   * Hardcoded layers for common wizard templates when remote data is unavailable.
   */
  private getKnownTemplateLayer(name: string): TemplateLayer | null {
    const known: Record<string, TemplateLayer> = {
      human: 'sample',
      vertebrates: 'sample',
      invertebrates: 'sample',
      plants: 'sample',
      'clinical-metadata': 'sample',
      'oncology-metadata': 'sample',
      metaproteomics: 'sample',
      'human-gut': 'sample',
      soil: 'sample',
      water: 'sample',
      'ms-proteomics': 'technology',
      'affinity-proteomics': 'technology',
      'ms-metabolomics': 'technology',
      'cell-lines': 'experiment',
      'dia-acquisition': 'experiment',
      'single-cell': 'experiment',
      immunopeptidomics: 'experiment',
      crosslinking: 'experiment',
      'lc-ms-metabolomics': 'experiment',
      'gc-ms-metabolomics': 'experiment',
    };
    return known[name] ?? null;
  }

  /**
   * Get template info list for UI display.
   * By default excludes internal templates (layer null).
   */
  getTemplateInfoList(filterIds?: string[], options?: { includeInternal?: boolean }): TemplateInfo[] {
    const manifest = this._manifest();
    const templates = this.allTemplates();
    const filtered = templates.filter(t => {
      const entry = manifest?.templates[t.name];
      const layer = this.resolveLayer(t.name, t.layer, entry?.layer);
      if (!options?.includeInternal && layer == null) return false;
      if (filterIds && !filterIds.includes(t.name)) return false;
      return true;
    });

    return filtered
      .map(t => {
        const entry = manifest?.templates[t.name];
        return {
          id: t.name,
          name: getTemplateDisplayName(t.name),
          description:
            getTemplateShortDescription(t.name) ||
            t.description ||
            entry?.description ||
            '',
          layer: this.resolveLayer(t.name, t.layer, entry?.layer),
          usableAlone: t.usableAlone || entry?.usableAlone || false,
          extends: t.extends,
          requires: t.requires ?? entry?.requires,
          excludes: t.excludes ?? entry?.excludes,
          icon: getTemplateIcon(t.name),
          status: t.status ?? entry?.status,
          version: t.version || entry?.latest,
        };
      })
      .sort((a, b) => getTemplateSortOrder(a.id) - getTemplateSortOrder(b.id));
  }

  /**
   * Get template info for a specific template.
   * Falls back to manifest entry or known layer map when the YAML definition
   * is missing (UI may still show static cards in that case).
   */
  getTemplateInfo(name: string): TemplateInfo | null {
    const template = this._templates().get(name);
    const entry = this._manifest()?.templates[name];
    const layer = this.resolveLayer(name, template?.layer, entry?.layer);

    if (!template && !entry && !layer) return null;

    return {
      id: name,
      name: getTemplateDisplayName(name),
      description:
        getTemplateShortDescription(name) ||
        template?.description ||
        entry?.description ||
        '',
      layer,
      usableAlone: template?.usableAlone || entry?.usableAlone || false,
      extends: template?.extends ?? entry?.extends ?? null,
      requires: template?.requires ?? entry?.requires,
      excludes: template?.excludes ?? entry?.excludes,
      icon: getTemplateIcon(name),
      status: template?.status ?? entry?.status,
      version: template?.version || entry?.latest,
    };
  }

  /**
   * Get latest version string for a template from manifest/definition.
   */
  getTemplateVersion(name: string): string {
    const entry = this._manifest()?.templates[name];
    if (entry?.latest) return entry.latest;
    return this._templates().get(name)?.version || '1.0.0';
  }

  /**
   * Validate a layered template selection against manifest rules.
   */
  validateTemplateCombination(selection: TemplateSelection): TemplateCombinationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const { technologyTemplate, sampleTemplate, experimentTemplates } = selection;

    if (!technologyTemplate) {
      errors.push('Select a technology template (e.g. ms-proteomics).');
    } else {
      const tech = this.getTemplateInfo(technologyTemplate);
      if (!tech || tech.layer !== 'technology') {
        errors.push(`"${technologyTemplate}" is not a technology template.`);
      }
    }

    if (sampleTemplate) {
      const sample = this.getTemplateInfo(sampleTemplate);
      if (!sample || sample.layer !== 'sample') {
        errors.push(`"${sampleTemplate}" is not a sample template.`);
      }
    }

    const selectedIds = [
      technologyTemplate,
      sampleTemplate,
      ...experimentTemplates,
    ].filter((id): id is string => !!id);

    for (const expId of experimentTemplates) {
      const exp = this.getTemplateInfo(expId);
      if (!exp) {
        errors.push(`Unknown experiment template: ${expId}`);
        continue;
      }
      if (exp.layer !== 'experiment') {
        errors.push(`"${expId}" is not an experiment template.`);
        continue;
      }

      for (const req of exp.requires || []) {
        if (req.layer === 'technology' && !technologyTemplate) {
          errors.push(`${expId} requires a technology template.`);
        }
        if (req.layer === 'sample' && !sampleTemplate) {
          errors.push(`${expId} requires a sample template.`);
        }
        if (req.template && !selectedIds.includes(req.template)) {
          errors.push(`${expId} requires template "${req.template}".`);
        }
      }

      for (const excluded of exp.excludes?.templates || []) {
        if (selectedIds.includes(excluded)) {
          errors.push(`${expId} cannot be combined with "${excluded}".`);
        }
      }
    }

    // Check excludes on sample/technology against selected experiments
    for (const id of [technologyTemplate, sampleTemplate]) {
      if (!id) continue;
      const info = this.getTemplateInfo(id);
      for (const excluded of info?.excludes?.templates || []) {
        if (selectedIds.includes(excluded)) {
          errors.push(`${id} cannot be combined with "${excluded}".`);
        }
      }
    }

    if (technologyTemplate && !sampleTemplate && experimentTemplates.length === 0) {
      const tech = this.getTemplateInfo(technologyTemplate);
      if (tech && !tech.usableAlone) {
        errors.push(`"${technologyTemplate}" cannot be used alone; select a sample template.`);
      }
    }

    return {
      valid: errors.length === 0,
      errors: [...new Set(errors)],
      warnings: [...new Set(warnings)],
    };
  }

  /**
   * Leaf template ids to write into comment[sdrf template] columns.
   */
  getLeafTemplateIds(selection: TemplateSelection): string[] {
    const leaves: string[] = [];
    if (selection.sampleTemplate) leaves.push(selection.sampleTemplate);
    if (selection.technologyTemplate) leaves.push(selection.technologyTemplate);
    for (const exp of selection.experimentTemplates) {
      if (exp && !leaves.includes(exp)) leaves.push(exp);
    }
    return leaves;
  }

  /**
   * Whether a template should be hidden behind the development toggle.
   */
  isDevTemplate(id: string): boolean {
    const info = this.getTemplateInfo(id);
    if (!info) return false;
    return isDevelopmentTemplate(info);
  }

  /**
   * Get templates that are compatible for combination.
   * Sample templates can be combined with technology templates.
   */
  getCompatibleTemplates(selectedTemplate: string): TemplateInfo[] {
    const template = this._templates().get(selectedTemplate);
    if (!template) return [];

    const allInfo = this.getTemplateInfoList();
    const mutuallyExclusive = template.mutuallyExclusiveWith || [];

    return allInfo.filter(t => {
      if (t.id === selectedTemplate) return false;
      if (mutuallyExclusive.includes(t.id)) return false;

      if (template.layer === 'sample' && t.layer === 'technology') return true;
      if (template.layer === 'technology' && t.layer === 'sample') return true;
      if (template.layer === 'experiment' && (t.layer === 'sample' || t.layer === 'technology')) return true;
      if ((template.layer === 'sample' || template.layer === 'technology') && t.layer === 'experiment') return true;

      return false;
    });
  }

  /**
   * Clear the cache.
   */
  clearCache(): void {
    this._resolvedCache.set(new Map());
    this._lastFetchTime.set(0);
  }
}
