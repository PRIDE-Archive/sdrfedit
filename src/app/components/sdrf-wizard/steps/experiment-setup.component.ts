/**
 * Experiment Setup Component (Step 1)
 *
 * Layered template selection: technology + sample + experiment(s).
 */

import {
  Component,
  Input,
  inject,
  computed,
  signal,
  OnInit,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { WizardStateService } from '../../../core/services/wizard-state.service';
import { TemplateService } from '../../../core/services/template.service';
import { WizardTemplate } from '../../../core/models/wizard';
import { buildTemplateHierarchy, templateDisplaySections } from '../../../core/utils/template-hierarchy';
import { TemplateColumnsPreviewComponent } from '../template-columns-preview.component';

@Component({
  selector: 'wizard-experiment-setup',
  standalone: true,
  imports: [CommonModule, FormsModule, TemplateColumnsPreviewComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="step-container">
      <div class="step-header">
        <h3>What type of experiment is this?</h3>
        <p class="step-description">
          Choose a <strong>technology</strong>, then add your <strong>sample</strong> templates. Select a template to reveal more specific options.
        </p>
      </div>

      <button type="button" class="info-banner" (click)="toggleTemplateInfo()" [attr.aria-expanded]="showTemplateInfo()">
        <span class="info-icon">i</span>
        <span class="info-content"><strong>How templates work</strong><span>Start broad, then refine. Compatibility is checked automatically.</span></span>
        <span class="expand-icon" aria-hidden="true">{{ showTemplateInfo() ? '−' : '+' }}</span>
      </button>

      @if (showTemplateInfo()) {
        <div class="template-layers-info">
          <div class="layer-info">
            <span class="layer-badge layer-technology">Technology</span>
            <span class="layer-desc">Required — select a technology to reveal its specialized templates</span>
          </div>
          <div class="layer-info">
            <span class="layer-badge layer-sample">Sample</span>
            <span class="layer-desc">Sample metadata — compatibility follows the template rules</span>
          </div>
          <div class="layer-info">
            <span class="layer-badge layer-experiment">Experiment</span>
            <span class="layer-desc">Optional add-ons — cell-lines, DIA, crosslinking, …</span>
          </div>
        </div>
      }

      <label class="dev-toggle">
        <input type="checkbox" [ngModel]="showDevTemplates()" (ngModelChange)="showDevTemplates.set($event)" />
        Show prerelease templates
      </label>

      @if (isLoading()) {
        <p class="step-description" role="status">Checking the official template repository…</p>
      }
      @if (templateService.error()) {
        <div class="validation-message" role="alert">{{ templateService.error() }}
          <button type="button" (click)="reload()">Retry</button>
        </div>
      }
      @if (templateService.catalog(); as catalog) {
        <div class="catalog-status" [class.stale]="catalog.stale" [title]="'Repository snapshot ' + catalog.commitSha + ' · ' + catalog.fetchedAt">
          <span class="status-dot"></span>{{ catalog.stale ? 'Using saved templates' : 'Official SDRF templates' }}
          <span class="snapshot-id">{{ catalog.commitSha.slice(0, 8) }}</span>
        </div>
        @if (catalog.syncError) { <p class="hint-message">{{ catalog.syncError }}</p> }
      }
      @if (wizardState.templateUpdateNotice()) {
        <p class="hint-message" role="status">{{ wizardState.templateUpdateNotice() }}</p>
      }
      @for (group of templateGroups(); track group.layer) {
        <section class="template-section" [attr.data-layer]="group.layer">
          <div class="section-heading">
            <div><h4>{{ group.layer | titlecase }} <span class="section-count">{{ visibleTemplateCount(group.layer) }}</span></h4>
              <p>{{ layerDescription(group.layer) }}</p></div>
            <span class="requirement-pill">{{ group.layer === 'technology' ? 'Required' : 'Optional' }}</span>
          </div>
          @for (branch of group.sections; track branch.key) {
            <div class="template-branch" [class.child-branch]="branch.refinements" [attr.data-section]="branch.key">
              @if (branch.refinements) {
                <div class="branch-heading">
                  <h5>More sample templates</h5>
                  <p>{{ branch.templates.length }} options from your selected sample categories</p>
                </div>
              }
          <div class="template-grid">
            @for (template of branch.templates; track template.id) {
              <div class="template-card" [attr.data-layer]="template.layer" [class.selected]="isSelected(template.id)"
                [class.unavailable]="!isSelected(template.id) && isBlocked(template.id)" (click)="selectCard(template.id, $event)">
                <div class="card-heading">
                  <span class="template-icon" aria-hidden="true">{{ getIcon(template.id) }}</span>
                  <div class="template-info">
                    <button type="button" class="template-select" [attr.aria-pressed]="isSelected(template.id)"
                      [disabled]="isLoading()"
                      [attr.aria-disabled]="!isSelected(template.id) && isBlocked(template.id)"
                      [attr.aria-describedby]="selectionAttempt() === template.id && isBlocked(template.id) ? 'conflict-' + template.id : null"
                      (click)="requestSelection(template.id)">{{ displayName(template.id) }}</button>
                    <span class="template-version">v{{ template.version }}
                      @if (branch.refinements) { <span class="node-layer">{{ template.layer | titlecase }}</span> }
                    </span>
                  </div>
                  <span class="selection-indicator" aria-hidden="true">{{ isSelected(template.id) ? '✓' : '' }}</span>
                </div>
                <p class="template-description" [title]="template.description">{{ template.description }}</p>
                @if (childCount(template.id)) {
                  <p class="child-hint">{{ childCount(template.id) }} more specific {{ childCount(template.id) === 1 ? 'template' : 'templates' }}
                    <span>{{ childHint(template.id) }}</span>
                  </p>
                }
                @if (selectionAttempt() === template.id && isBlocked(template.id)) {
                  <p class="conflict-feedback" [id]="'conflict-' + template.id" role="alert">{{ conflictMessage(template.id) }}</p>
                }
                @if (isInherited(template.id) && reasons(template.id).length) {
                  <details class="template-reasons" (click)="$event.stopPropagation()">
                    <summary>{{ reasonLabel(template.id) }}</summary>
                    @for (reason of reasons(template.id); track reason) { <p>{{ reason }}</p> }
                  </details>
                }
                <div class="card-footer">
                  <span class="inheritance" [title]="template.extends ? 'Inherits: ' + template.extends : 'Base template'">
                    <span aria-hidden="true">↳</span> {{ template.extends ? displayName(template.extends.split('@')[0]) : 'Base template' }}
                  </span>
                  <div class="card-actions">
                    @if (sourceUrl(template.id); as url) {
                      <a class="icon-button" [href]="url" target="_blank" rel="noopener" [attr.aria-label]="'View source YAML for ' + displayName(template.id)" title="View source YAML">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 8 4 12l4 4m8-8 4 4-4 4M14 5l-4 14"/></svg>
                      </a>
                    }
                    <button type="button" class="icon-button" [attr.aria-label]="'Preview columns for ' + displayName(template.id)" title="Preview columns" (click)="openColumnsPreview(template.id, $event)">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 9v11m6-11v11"/></svg>
                    </button>
                  </div>
                </div>

              </div>
            }
          </div>
            </div>
          }
        </section>
      }
      @if (unavailableSelections().length) {
        <div class="validation-message">Templates no longer in the catalogue:
          @for (name of unavailableSelections(); track name) {
            <button type="button" (click)="wizardState.toggleTemplate(name)">Remove {{ name }}</button>
          }
        </div>
      }

      <!-- Sample Count -->
      <div class="form-section">
        <label class="form-label">
          How many samples do you have?
          <span class="help-text">Biological samples (not including fractions or technical replicates)</span>
        </label>
        <div class="sample-count-input">
          <button type="button" class="count-btn" (click)="decrementSamples()" [disabled]="wizardState.sampleCount() <= 1">-</button>
          <input
            type="number"
            [ngModel]="wizardState.sampleCount()"
            (ngModelChange)="setSampleCount($event)"
            min="1"
            max="1000"
            class="count-input"
          />
          <button type="button" class="count-btn" (click)="incrementSamples()" [disabled]="wizardState.sampleCount() >= 1000">+</button>
        </div>
      </div>

      @if (aiEnabled) {
        <div class="form-section">
          <label class="form-label">
            Describe your experiment
            <span class="optional-badge">Optional - helps AI suggestions</span>
          </label>
          <textarea
            class="form-textarea"
            [ngModel]="state().experimentDescription"
            (ngModelChange)="setDescription($event)"
            placeholder="E.g., Comparing protein expression between healthy and cancer tissues..."
            rows="3"
          ></textarea>
        </div>
      }

      @if (combination().warnings.length > 0) {
        <div class="hint-message">
          @for (w of combination().warnings; track w) {
            <div>{{ w }}</div>
          }
        </div>
      }

      @if (!wizardState.isStep1Valid()) {
        <div class="validation-message">
          <span class="warning-icon">!</span>
          <div>
            @if (combination().errors.length > 0) {
              @for (err of combination().errors; track err) {
                <div>{{ err }}</div>
              }
            } @else {
              Please select a technology template and enter a valid sample count.
            }
          </div>
        </div>
      }

      <wizard-template-columns-preview
        [templateId]="previewTemplateId()"
        (close)="closeColumnsPreview()"
      />
    </div>
  `,
  styles: [`
    .step-container { max-width: 760px; }
    .step-header { margin-bottom: 20px; }
    .step-header h3 { margin: 0 0 8px; font-size: 18px; font-weight: 600; color: #1f2937; }
    .step-description { margin: 0; color: #64748b; font-size: 13px; line-height: 1.7; }
    .required { color: #ef4444; }
    .optional-hint { font-size: 12px; font-weight: 400; color: #9ca3af; margin-left: 6px; }
    .dev-toggle { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #4b5563; margin-bottom: 16px; }
    .template-section { --accent: #2563eb; --tint: #eff6ff; --edge: #bfdbfe; margin: 24px 0; }
    .template-section[data-layer="technology"] { --accent: #087f72; --tint: #effaf7; --edge: #a3dfd1; }
    .template-section[data-layer="experiment"] { --accent: #7c3aed; --tint: #f6f2ff; --edge: #d8c8fa; }
    .template-card[data-layer="sample"] { --accent: #2563eb; --tint: #eff6ff; --edge: #bfdbfe; }
    .template-card[data-layer="technology"] { --accent: #087f72; --tint: #effaf7; --edge: #a3dfd1; }
    .template-card[data-layer="experiment"] { --accent: #7c3aed; --tint: #f6f2ff; --edge: #d8c8fa; }
    .child-branch { margin-top: 16px; padding: 14px 0 0 14px; border-left: 2px solid var(--edge); }
    .branch-heading { margin-bottom: 12px; }
    .branch-heading h5 { margin: 0; color: #334155; font-size: 13px; font-weight: 600; overflow-wrap: anywhere; }
    .branch-heading h5 > span { color: var(--accent); margin-right: 5px; }
    .branch-heading p { margin: 4px 0 0; font-size: 11px; color: #64748b; line-height: 1.5; }
    .node-layer { padding-left: 6px; margin-left: 4px; border-left: 1px solid var(--edge); color: var(--accent); }
    .child-hint { margin: 0 0 10px; color: var(--accent); font-size: 10px; line-height: 1.6; display: flex; flex-wrap: wrap; gap: 2px 8px; justify-content: space-between; }
    .section-heading { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 12px; padding-left: 12px; border-left: 3px solid var(--accent); }
    .section-heading h4 { margin: 0; color: #172b44; font-size: 15px; font-weight: 650; }
    .section-heading p { margin: 4px 0 0; font-size: 12px; color: #64748b; line-height: 1.5; }
    .section-count { color: #64748b; font-size: 11px; font-weight: 500; margin-left: 5px; }
    .requirement-pill { padding: 4px 9px; border-radius: 20px; color: var(--accent); background: var(--tint); font-size: 10px; font-weight: 600; }
    .template-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .template-card { min-width: 0; padding: 15px; border: 1px solid #dde5ef; border-radius: 14px; background: #fff; cursor: pointer; display: flex; flex-direction: column; transition: border-color .15s, box-shadow .15s, background .15s; }
    .template-card:hover { border-color: var(--edge); box-shadow: 0 4px 14px #0f172a08; }
    .template-card.selected { border-color: var(--accent); background: var(--tint); box-shadow: 0 0 0 1px var(--accent); }
    .template-card.unavailable { background: #f8fafc; cursor: not-allowed; }
    .template-select[aria-disabled="true"] { color: #64748b; cursor: not-allowed; }
    .conflict-feedback { margin: 0 0 10px; padding: 9px; border: 1px solid #f59e0b; background: #fffbeb; border-radius: 8px; color: #78350f; font-size: 12px; line-height: 1.5; }
    .template-card.unavailable .card-heading { opacity: .6; }
    .card-heading { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
    .template-icon { width: 38px; height: 38px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; background: var(--tint); border: 1px solid var(--edge); border-radius: 11px; font-size: 21px; }
    .template-info { min-width: 0; flex: 1; }
    .template-select { display: block; border: 0; background: transparent; color: #1e293b; font-family: inherit; font-size: 13px; font-weight: 650; text-align: left; cursor: pointer; padding: 0; line-height: 1.5; }
    .template-select:disabled { cursor: default; }
    .template-version { display: block; color: #64748b; font-size: 10px; margin-top: 1px; }
    .selection-indicator { width: 17px; height: 17px; border: 1px solid #cbd5e1; border-radius: 50%; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 11px; }
    .selected .selection-indicator { background: var(--accent); color: #fff; border-color: var(--accent); }
    .template-description { color: #526277; font-size: 12px; line-height: 1.6; margin: 0 0 12px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; min-height: 38px; }
    .card-footer { display: flex; align-items: center; gap: 8px; margin-top: auto; padding-top: 9px; border-top: 1px solid #e2e8f0; }
    .inheritance { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; color: #64748b; }
    .inheritance > span { color: var(--accent); margin-right: 4px; }
    .card-actions { display: flex; gap: 4px; }
    .icon-button { box-sizing: border-box; width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid transparent; border-radius: 8px; background: transparent; color: #64748b; cursor: pointer; text-decoration: none; }
    .icon-button svg { width: 17px; height: 17px; }
    .icon-button:hover { color: var(--accent); background: #fff; border-color: var(--edge); }
    button:focus-visible, a:focus-visible, summary:focus-visible { outline: 2px solid #2563eb; outline-offset: 3px; }
    .template-reasons { margin: 0 0 9px; color: #8a5a18; background: #fffbeb; border-radius: 6px; padding: 6px 8px; font-size: 10px; line-height: 1.5; }
    .template-reasons summary { cursor: pointer; }
    .template-reasons p { margin: 6px 0 0; overflow-wrap: anywhere; }
    .catalog-status { display: flex; align-items: center; gap: 6px; color: #64748b; font-size: 10px; margin: 12px 0; }
    .status-dot { width: 6px; height: 6px; border-radius: 50%; background: #10b981; }
    .stale .status-dot { background: #d97706; }
    .snapshot-id { margin-left: auto; font-family: monospace; color: #64748b; }
    .form-section { margin-bottom: 20px; }
    .form-label { display: block; font-size: 14px; font-weight: 500; color: #374151; margin-bottom: 8px; }
    .help-text { display: block; font-size: 12px; font-weight: normal; color: #6b7280; margin-top: 4px; }
    .optional-badge { display: inline-block; font-size: 11px; font-weight: normal; color: #8b5cf6; background: #f3e8ff; padding: 2px 8px; border-radius: 4px; margin-left: 8px; }
    .sample-count-input { display: flex; align-items: center; width: fit-content; }
    .count-btn { width: 40px; height: 40px; border: 1px solid #d1d5db; background: white; font-size: 20px; color: #374151; cursor: pointer; }
    .count-btn:first-child { border-radius: 8px 0 0 8px; }
    .count-btn:last-child { border-radius: 0 8px 8px 0; }
    .count-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .count-input { width: 80px; height: 40px; border: 1px solid #d1d5db; border-left: none; border-right: none; text-align: center; font-size: 16px; font-weight: 500; }
    .form-textarea { width: 100%; padding: 12px; border: 1px solid #d1d5db; border-radius: 8px; font-size: 14px; resize: vertical; font-family: inherit; }
    .validation-message, .hint-message { display: flex; align-items: flex-start; gap: 8px; padding: 12px 16px; border-radius: 8px; font-size: 13px; margin-bottom: 8px; }
    .validation-message { background: #fef3c7; border: 1px solid #fcd34d; color: #92400e; }
    .hint-message { background: #eff6ff; border: 1px solid #bfdbfe; color: #1e40af; }
    .warning-icon { width: 20px; height: 20px; border-radius: 50%; background: #f59e0b; color: white; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold; flex-shrink: 0; }
    .info-banner { width: 100%; box-sizing: border-box; text-align: left; font-family: inherit; align-items: center; display: flex; gap: 12px; padding: 14px 16px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; margin-bottom: 16px; cursor: pointer; }
    .info-icon { width: 22px; height: 22px; border-radius: 50%; background: #3b82f6; color: white; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; flex-shrink: 0; }
    .info-content strong { display: block; font-size: 14px; color: #1e40af; margin-bottom: 4px; }
    .info-content { flex: 1; } .info-content > span { font-size: 12px; color: #526277; }
    .info-link { color: #2563eb; margin-left: 8px; }
    .expand-icon { font-size: 18px; color: #6b7280; font-weight: bold; }
    .template-layers-info { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 16px; }
    .layer-info { display: flex; align-items: center; gap: 10px; }
    .layer-desc { font-size: 13px; color: #6b7280; }
    .layer-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
    .layer-sample { background: #dbeafe; color: #1e40af; }
    .layer-technology { background: #dcfce7; color: #166534; }
    .layer-experiment { background: #fef3c7; color: #92400e; }
    @media (max-width: 600px) { .template-grid { grid-template-columns: 1fr; } .icon-button { width: 40px; height: 40px; } .template-card { padding: 14px; } }
    @media (prefers-reduced-motion: reduce) { .template-card { transition: none; } }
  `],
})
export class ExperimentSetupComponent implements OnInit {
  /** Optional whitelist; when empty/undefined, show all selectable templates from manifest */
  @Input() availableTemplates: string[] | null = null;
  @Input() aiEnabled = false;

  readonly wizardState = inject(WizardStateService);
  readonly templateService = inject(TemplateService);

  readonly state = this.wizardState.state;
  readonly showTemplateInfo = signal(false);
  readonly showDevTemplates = signal(false);
  readonly previewTemplateId = signal<string | null>(null);
  readonly selectionAttempt = signal<string | null>(null);
  readonly isLoading = this.templateService.isLoading;

  readonly combination = this.wizardState.step1Combination;

  ngOnInit(): void {
    this.reload();
  }

  toggleTemplateInfo(): void {
    this.showTemplateInfo.update(v => !v);
  }

  openColumnsPreview(templateId: string, event: Event): void {
    event.stopPropagation();
    event.preventDefault();
    this.previewTemplateId.set(templateId);
  }

  closeColumnsPreview(): void {
    this.previewTemplateId.set(null);
  }

  reload(): void { void this.wizardState.enterTemplateSelection(); }

  readonly hierarchy = computed(() => buildTemplateHierarchy(
    this.templateService.getTemplateInfoList(undefined, { includeInternal: true }),
    (this.state().selectedTemplates || []).map(ref => ref.name), this.showDevTemplates(), this.availableTemplates,
  ));
  readonly templateGroups = computed(() => this.hierarchy().groups.map(group => ({ ...group, sections: templateDisplaySections(group) })));
  childCount(name: string): number { return this.hierarchy().childCounts.get(name) || 0; }
  visibleTemplateCount(layer: string): number {
    return this.templateGroups().find(group => group.layer === layer)?.branches.reduce((count, branch) => count + branch.templates.length, 0) || 0;
  }
  childHint(name: string): string {
    const ownLayer = this.templateService.getTemplateInfo(name)?.layer;
    const otherLayers = (this.hierarchy().childLayers.get(name) || []).filter(layer => layer !== ownLayer).map(layer => this.displayName(layer));
    if (otherLayers.length) return this.branchExpanded(name) ? `Shown in ${otherLayers.join(' / ')} ↓` : `Select to explore ${otherLayers.join(' / ')} →`;
    return this.branchExpanded(name) ? 'Shown below ↓' : 'Select to explore →';
  }
  branchExpanded(name: string): boolean {
    return this.templateGroups().some(group => group.branches.some(branch => branch.parent?.id === name));
  }
  branchTitle(path: string[]): string { return path.map(id => this.displayName(id)).join(' → '); }
  isInherited(name: string): boolean {
    return this.templateService.cachedResolution(this.wizardState.templateSelection())?.availability[name]?.status === 'inherited';
  }
  readonly unavailableSelections = computed(() => (this.state().selectedTemplates || [])
    .filter(ref => !this.templateService.templates().has(ref.name)).map(ref => ref.name));
  selectCard(name: string, event: MouseEvent): void {
    if ((event.target as HTMLElement).closest('button, a, details') || this.isLoading()) return;
    this.requestSelection(name);
  }
  requestSelection(name: string): void {
    if (this.isLoading()) return;
    if (!this.isSelected(name) && this.isBlocked(name)) {
      this.selectionAttempt.set(name);
      return;
    }
    this.selectionAttempt.set(null);
    this.wizardState.toggleTemplate(name);
  }
  conflictMessage(name: string): string {
    const option = this.templateService.cachedResolution(this.wizardState.templateSelection())?.availability[name];
    const names = option?.conflictsWith?.map(ref => this.displayName(ref.name)) || [];
    if (names.length) return `${this.displayName(name)} conflicts with ${names.join(', ')}. Deselect ${names.join(', ')} before selecting this template.`;
    return option?.reasons.join(' ') || 'Checking template compatibility…';
  }
  isSelected(name: string): boolean { return !!this.state().selectedTemplates?.some(ref => ref.name === name); }
  isBlocked(name: string): boolean {
    if (this.templateService.isLoading()) return true;
    const result = this.templateService.cachedResolution(this.wizardState.templateSelection());
    const status = result?.availability[name]?.status;
    return !status || !['selected', 'available', 'inherited'].includes(status);
  }
  sourceUrl(name: string): string | undefined { return this.templateService.catalog()?.templates.find(t => t.name === name)?.source.url; }
  reasons(name: string): string[] {
    return this.templateService.cachedResolution(this.wizardState.templateSelection())?.availability[name]?.reasons || [];
  }

  setSampleCount(count: number): void {
    this.wizardState.setSampleCount(count);
  }

  incrementSamples(): void {
    this.wizardState.setSampleCount(this.wizardState.sampleCount() + 1);
  }

  decrementSamples(): void {
    this.wizardState.setSampleCount(this.wizardState.sampleCount() - 1);
  }

  setDescription(description: string): void {
    this.wizardState.setExperimentDescription(description);
  }

  // Presentation only: new templates receive a layer icon without affecting discovery or rules.
  getIcon(templateId: WizardTemplate): string {
    const icons: Record<string, string> = {
      'ms-proteomics': '📊', 'affinity-proteomics': '🧲', 'ms-metabolomics': '⚗️',
      human: '🧑', vertebrates: '🐁', invertebrates: '🦋', plants: '🌱',
      'clinical-metadata': '🩺', 'oncology-metadata': '🎗️', metaproteomics: '🦠',
      'human-gut': '🧬', soil: '🪴', water: '💧', 'cell-lines': '🧫',
      'dia-acquisition': '📈', 'single-cell': '🔬', crosslinking: '🔗', immunopeptidomics: '🛡️',
      'lc-ms-metabolomics': '🧪', 'gc-ms-metabolomics': '♨️', olink: '🧲', somascan: '🧬',
    };
    const layer = this.templateService.getTemplateInfo(templateId)?.layer;
    return icons[templateId] || ({ technology: '⚙️', sample: '🧬', experiment: '🔬' }[layer || ''] || '📋');
  }

  displayName(id: string): string {
    const words: Record<string, string> = { ms: 'MS', dia: 'DIA', lc: 'LC', gc: 'GC', sdrf: 'SDRF' };
    return id.split('-').map(word => words[word] || word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
  }

  layerDescription(layer: string): string {
    return ({ technology: 'Choose your platform. Matching experiment templates appear in the Experiment section.', sample: 'Choose a sample category, then refine it if needed. You can skip this section.',
      experiment: 'Choose general add-ons or specialized templates for your selected technology.' } as Record<string, string>)[layer] || 'Choose compatible templates for this layer.';
  }

  reasonLabel(name: string): string {
    const option = this.templateService.cachedResolution(this.wizardState.templateSelection())?.availability[name];
    if (option?.status === 'inherited') return 'Included through inheritance';
    return option?.status === 'conflicting' ? 'Unavailable · view details' : 'Requires additional selection';
  }
}
