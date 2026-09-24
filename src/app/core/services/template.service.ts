import { selectedTemplateIds } from '../utils/template-selection';
/** One commit-pinned catalogue and one authoritative resolver shared with the assistant. */
import { Injectable, signal, computed } from '@angular/core';
import { assistantUrlCandidates } from './assistant/assistant-api.service';
import {
  TemplateDefinition, TemplateColumn, TemplateInfo, ResolvedTemplate, TemplateSelection,
  TemplateCombinationResult, convertYamlToTemplateDefinition, convertYamlToColumn, convertYamlToValidator, isDevelopmentTemplate,
} from '../models/template';
import type { CatalogSnapshot, CatalogResolution, TemplateRef } from '../models/template-catalog';
import { isWizardSkippedCharacteristic } from '../models/wizard';

@Injectable({ providedIn: 'root' })
export class TemplateService {
  private readonly _catalog = signal<CatalogSnapshot | null>(null);
  private readonly _templates = signal(new Map<string, TemplateDefinition>());
  private readonly _isLoading = signal(false);
  private readonly _error = signal<string | null>(null);
  private readonly _resolutions = signal(new Map<string, CatalogResolution>());
  private readonly pending = new Map<string, Promise<CatalogResolution>>();
  private loading: Promise<void> | null = null;
  private baseUrl = '';
  readonly catalog = this._catalog.asReadonly();
  readonly templates = this._templates.asReadonly();
  readonly isLoading = this._isLoading.asReadonly();
  readonly error = this._error.asReadonly();
  readonly allTemplates = computed(() => [...this._templates().values()]);
  readonly usableTemplates = computed(() => this.allTemplates().filter(t => t.usableAlone));
  readonly sampleTemplates = computed(() => this.allTemplates().filter(t => t.layer === 'sample'));
  readonly technologyTemplates = computed(() => this.allTemplates().filter(t => t.layer === 'technology'));
  readonly experimentTemplates = computed(() => this.allTemplates().filter(t => t.layer === 'experiment'));

  private async request(path: string, body?: unknown): Promise<any> {
    const candidates = this.baseUrl ? [this.baseUrl] : assistantUrlCandidates();
    let error: unknown = new Error('No template catalogue backend is configured.');
    for (const base of candidates) {
      try {
        // Probe the route independently of LLM health/configuration.
        if (!this.baseUrl) {
          const probe = await fetch(`${base}/api/template-catalog/status`, { signal: AbortSignal.timeout(2500) });
          if (!probe.ok || (await probe.json()).service !== 'template-catalog') continue;
          this.baseUrl = base;
        }
        const response = await fetch(`${base}/api/template-catalog${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(120000),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.detail || `Template catalogue: HTTP ${response.status}`);
        }
        return await response.json();
      } catch (e) {
        error = e;
        if (this.baseUrl) break; // Never silently resolve against another server/snapshot.
      }
    }
    throw error;
  }

  /** force=true on every entry to Step 1; other steps retain their pinned snapshot. */
  async fetchTemplates(force = false): Promise<void> {
    if (this.loading) return this.loading;
    if (!force && this._catalog()) return;
    this._isLoading.set(true);
    this._error.set(null);
    this.loading = (async () => {
      try {
        this.install(await this.request('/revalidate', {}));
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        this._error.set(message);
        const old = this._catalog();
        if (old) this._catalog.set({ ...old, stale: true, syncError: message });
      } finally {
        this._isLoading.set(false);
        this.loading = null;
      }
    })();
    return this.loading;
  }

  private install(catalog: CatalogSnapshot): void {
    if (!catalog?.snapshotId || !Array.isArray(catalog.templates)) throw new Error('Invalid template catalogue response.');
    const definitions = new Map(catalog.templates.map(t => [t.name, convertYamlToTemplateDefinition(t)]));
    this._resolutions.set(new Map());
    this._templates.set(definitions);
    this._catalog.set(catalog);
  }

  async restoreSnapshot(snapshotId: string): Promise<void> {
    if (this._catalog()?.snapshotId === snapshotId) return;
    this.install(await this.request(`/snapshots/${encodeURIComponent(snapshotId)}`));
  }

  selectionRefs(selection: TemplateSelection): TemplateRef[] {
    if (selection.selectedTemplates !== undefined) return selection.selectedTemplates;
    return selectedTemplateIds(selection).map(name => ({ name, version: this.getTemplateVersion(name) }));
  }

  private key(refs: TemplateRef[], snapshotId = this._catalog()?.snapshotId, preview = false): string {
    return JSON.stringify([snapshotId, preview, [...refs].sort((a, b) => a.name.localeCompare(b.name))]);
  }

  async resolveSelection(refs: TemplateRef[], preview = false, snapshotId = this._catalog()?.snapshotId): Promise<CatalogResolution> {
    if (!snapshotId) throw new Error('Load the official template catalogue first.');
    const key = this.key(refs, snapshotId, preview);
    const cached = this._resolutions().get(key);
    if (cached) return cached;
    const pending = this.pending.get(key);
    if (pending) return pending;
    const request = this.request('/resolve', { snapshotId, selectedTemplates: refs, preview, availability: !preview })
      .then(raw => {
        const result: CatalogResolution = { ...raw, columns: (raw.columns || []).map(convertYamlToColumn), validators: (raw.validators || []).map(convertYamlToValidator) };
        this._resolutions.update(cache => new Map(cache).set(key, result));
        return result;
      }).finally(() => this.pending.delete(key));
    this.pending.set(key, request);
    return request;
  }

  cachedResolution(selection: TemplateSelection): CatalogResolution | undefined {
    return this._resolutions().get(this.key(this.selectionRefs(selection), selection.snapshotId || this._catalog()?.snapshotId));
  }

  validateTemplateCombination(selection: TemplateSelection): TemplateCombinationResult {
    if (!this._catalog()) return { valid: false, errors: [this._error() || 'Loading the official template catalogue…'], warnings: [] };
    const cached = this.cachedResolution(selection);
    if (cached) return cached;
    const snapshot = selection.snapshotId || this._catalog()!.snapshotId;
    const refs = this.selectionRefs(selection);
    // Defer writes until after signal evaluation. All consumers share the request/cache.
    void this.resolveSelection(refs, false, snapshot).catch(e => {
      const key = this.key(refs, snapshot);
      this._resolutions.update(cache => new Map(cache).set(key, {
        snapshotId: snapshot, valid: false, errors: [e.message || 'Could not validate template selection.'], warnings: [],
        issues: [], columns: [], leafTemplates: [], resolvedTemplates: [], availability: {},
      }));
    });
    return { valid: false, errors: ['Checking template dependencies and compatibility…'], warnings: [] };
  }

  async validateTable(snapshotId: string, selectedTemplates: TemplateRef[], tsv: string): Promise<import('./pyodide-validator.service').ValidationError[]> {
    const result = await this.request('/validate-table', { snapshotId, selectedTemplates, tsv });
    return result.issues;
  }

  async getResolvedTemplate(name: string): Promise<ResolvedTemplate> {
    await this.fetchTemplates();
    const definition = this._templates().get(name);
    if (!definition) throw new Error(`Template not found: ${name}`);
    const result = await this.resolveSelection([{ name, version: definition.version }], true);
    if (!result.valid) throw new Error(result.errors.join(' '));
    return { ...definition, resolvedColumns: result.columns,
      parentChain: result.resolvedTemplates.map(t => t.name).filter(n => n !== name).reverse(), resolvedValidators: result.validators || [] };
  }

  async getWizardCharacteristicColumns(selection: TemplateSelection): Promise<{ required: TemplateColumn[]; recommended: TemplateColumn[]; all: TemplateColumn[] }> {
    await this.fetchTemplates();
    const result = await this.resolveSelection(this.selectionRefs(selection), false, selection.snapshotId || this._catalog()?.snapshotId);
    if (!result.valid) throw new Error(result.errors.join(' '));
    const all = result.columns.filter(c => c.name.startsWith('characteristics[') && !isWizardSkippedCharacteristic(c.name));
    return { all, required: all.filter(c => c.requirement === 'required'), recommended: all.filter(c => c.requirement === 'recommended') };
  }

  getTemplateInfoList(filterIds?: string[], options?: { includeInternal?: boolean }): TemplateInfo[] {
    return this.allTemplates().filter(t => (options?.includeInternal || t.layer != null) && (!filterIds || filterIds.includes(t.name)))
      .map(t => this.getTemplateInfo(t.name)!).sort((a, b) => a.name.localeCompare(b.name));
  }
  getTemplateInfo(name: string): TemplateInfo | null {
    const t = this._templates().get(name);
    if (!t) return null;
    return { id: name, name: name.replace(/-/g, ' '), description: t.description,
      layer: t.layer, usableAlone: t.usableAlone, extends: t.extends, requires: t.requires, excludes: t.excludes,
      version: t.version, status: isDevelopmentTemplate({ id: name, version: t.version, status: t.status }) ? 'development' : 'stable' };
  }
  getTemplateVersion(name: string): string { return this._templates().get(name)?.version || ''; }
  getLeafTemplateIds(selection: TemplateSelection): string[] { return this.cachedResolution(selection)?.leafTemplates.map(t => t.name) || []; }
  isDevTemplate(id: string): boolean { const info = this.getTemplateInfo(id); return !!info && isDevelopmentTemplate(info); }
  clearCache(): void { this._resolutions.set(new Map()); this._error.set(null); }
}
