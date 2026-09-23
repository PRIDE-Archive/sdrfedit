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
import { WIZARD_TEMPLATES, WizardTemplate } from '../../../core/models/wizard';
import { TemplateInfo, isDevelopmentTemplate, getTemplateEmoji, getTemplateShortDescription, getTemplateSortOrder } from '../../../core/models/template';
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
          Choose templates by layer: <strong>technology</strong> (required),
          <strong>sample</strong> (optional), and optional <strong>experiment</strong> add-ons.
          The default is MS proteomics with generic sample metadata. Use <strong>Columns</strong> on a card to see required fields.
        </p>
      </div>

      <div class="info-banner" (click)="toggleTemplateInfo()">
        <span class="info-icon">i</span>
        <div class="info-content">
          <strong>SDRF Template System</strong>
          <p>
            Templates follow the official layered architecture.
            @if (showTemplateInfo()) {
              <a class="info-link" href="https://sdrf.quantms.org/specification.html" target="_blank" rel="noopener">View specification</a>
            }
          </p>
        </div>
        <span class="expand-icon">{{ showTemplateInfo() ? '−' : '+' }}</span>
      </div>

      @if (showTemplateInfo()) {
        <div class="template-layers-info">
          <div class="layer-info">
            <span class="layer-badge layer-technology">Technology</span>
            <span class="layer-desc">Required — ms-proteomics, affinity-proteomics, …</span>
          </div>
          <div class="layer-info">
            <span class="layer-badge layer-sample">Sample</span>
            <span class="layer-desc">Optional organism / study context — human, vertebrates, …</span>
          </div>
          <div class="layer-info">
            <span class="layer-badge layer-experiment">Experiment</span>
            <span class="layer-desc">Optional add-ons — cell-lines, DIA, crosslinking, …</span>
          </div>
        </div>
      }

      <label class="dev-toggle">
        <input type="checkbox" [ngModel]="showDevTemplates()" (ngModelChange)="showDevTemplates.set($event)" />
        Show development templates (metabolomics, …)
      </label>

      <!-- Technology -->
      <div class="template-section">
        <h4 class="section-title">
          <span class="layer-badge layer-technology">Technology</span>
          Technology template <span class="required">*</span>
        </h4>
        <div class="template-grid">
          @for (template of visibleTechnologyTemplates(); track template.id) {
            <div
              class="template-card"
              [class.selected]="wizardState.technologyTemplate() === template.id"
              (click)="selectTechnologyTemplate(template.id)"
              (keydown.enter)="selectTechnologyTemplate(template.id)"
              tabindex="0"
              role="button"
            >
              <div class="template-icon">{{ getIcon(template.id) }}</div>
              <div class="template-info">
                <div class="template-header"><h4>{{ template.name }}</h4></div>
                <p>{{ template.description }}</p>
              </div>
              <div class="card-actions">
                @if (wizardState.technologyTemplate() === template.id) {
                  <div class="selected-badge">&#10003;</div>
                }
                <button
                  type="button"
                  class="view-cols-btn"
                  (click)="openColumnsPreview(template.id, $event)"
                >Columns</button>
              </div>
            </div>
          }
        </div>
      </div>

      <!-- Sample -->
      <div class="template-section">
        <h4 class="section-title">
          <span class="layer-badge layer-sample">Sample</span>
          Sample template
          <span class="optional-hint">(optional)</span>
        </h4>
        <p class="step-description">
          Leave unselected if no specialized sample template applies.
          Click a selected template again to deselect it.
        </p>
        <div class="template-grid">
          @for (template of visibleSampleTemplates(); track template.id) {
            <div
              class="template-card"
              [class.selected]="wizardState.sampleTemplate() === template.id"
              [attr.aria-pressed]="wizardState.sampleTemplate() === template.id"
              (click)="selectSampleTemplate(template.id)"
              (keydown.enter)="selectSampleTemplate(template.id)"
              tabindex="0"
              role="button"
            >
              <div class="template-icon">{{ getIcon(template.id) }}</div>
              <div class="template-info">
                <div class="template-header"><h4>{{ template.name }}</h4></div>
                <p>{{ template.description }}</p>
              </div>
              <div class="card-actions">
                @if (wizardState.sampleTemplate() === template.id) {
                  <div class="selected-badge">&#10003;</div>
                }
                <button
                  type="button"
                  class="view-cols-btn"
                  (click)="openColumnsPreview(template.id, $event)"
                >Columns</button>
              </div>
            </div>
          }
        </div>
        @if (wizardState.sampleTemplate()) {
          <button type="button" class="clear-btn" (click)="clearSampleTemplate()">Clear sample template</button>
        }
      </div>

      <!-- Experiment (multi) -->
      <div class="template-section">
        <h4 class="section-title">
          <span class="layer-badge layer-experiment">Experiment</span>
          Experiment templates
          <span class="optional-hint">(optional, multi-select)</span>
        </h4>
        <div class="template-grid">
          @for (template of visibleExperimentTemplates(); track template.id) {
            <div
              class="template-card"
              [class.selected]="isExperimentSelected(template.id)"
              (click)="toggleExperiment(template.id)"
              (keydown.enter)="toggleExperiment(template.id)"
              tabindex="0"
              role="button"
            >
              <div class="template-icon">{{ getIcon(template.id) }}</div>
              <div class="template-info">
                <div class="template-header"><h4>{{ template.name }}</h4></div>
                <p>{{ template.description }}</p>
              </div>
              <div class="card-actions">
                @if (isExperimentSelected(template.id)) {
                  <div class="selected-badge">&#10003;</div>
                }
                <button
                  type="button"
                  class="view-cols-btn"
                  (click)="openColumnsPreview(template.id, $event)"
                >Columns</button>
              </div>
            </div>
          }
        </div>
      </div>

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
    .step-description { margin: 0; color: #6b7280; font-size: 14px; }
    .required { color: #ef4444; }
    .optional-hint { font-size: 12px; font-weight: 400; color: #9ca3af; margin-left: 6px; }
    .dev-toggle { display: flex; align-items: center; gap: 8px; font-size: 13px; color: #4b5563; margin-bottom: 16px; }
    .template-section { margin-bottom: 24px; }
    .section-title { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; font-size: 14px; font-weight: 600; color: #374151; flex-wrap: wrap; }
    .template-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
    .template-card { position: relative; display: flex; align-items: flex-start; gap: 12px; padding: 14px; border: 2px solid #e5e7eb; border-radius: 12px; background: white; cursor: pointer; text-align: left; }
    .template-card:hover { border-color: #d1d5db; background: #f9fafb; }
    .template-card.selected { border-color: #3b82f6; background: #eff6ff; }
    .template-icon { width: 40px; height: 40px; border-radius: 10px; background: #f3f4f6; display: flex; align-items: center; justify-content: center; font-size: 20px; flex-shrink: 0; }
    .template-info { flex: 1; min-width: 0; padding-right: 4px; }
    .template-header h4 { margin: 0 0 4px; font-size: 14px; font-weight: 600; color: #1f2937; }
    .template-info p { margin: 0; font-size: 12px; color: #6b7280; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .card-actions {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
      flex-shrink: 0;
      align-self: stretch;
    }
    .view-cols-btn {
      margin-top: auto;
      border: 1px solid #dbeafe;
      background: #eff6ff;
      color: #1d4ed8;
      font-size: 11px;
      font-weight: 600;
      padding: 5px 10px;
      border-radius: 999px;
      cursor: pointer;
      white-space: nowrap;
    }
    .view-cols-btn:hover { background: #dbeafe; border-color: #93c5fd; }
    .selected-badge { width: 22px; height: 22px; border-radius: 50%; background: #3b82f6; color: white; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: bold; }
    .clear-btn { margin-top: 8px; border: none; background: transparent; color: #2563eb; font-size: 13px; cursor: pointer; padding: 0; }
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
    .info-banner { display: flex; gap: 12px; padding: 14px 16px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px; margin-bottom: 16px; cursor: pointer; }
    .info-icon { width: 22px; height: 22px; border-radius: 50%; background: #3b82f6; color: white; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; flex-shrink: 0; }
    .info-content strong { display: block; font-size: 14px; color: #1e40af; margin-bottom: 4px; }
    .info-content p { margin: 0; font-size: 13px; color: #4b5563; }
    .info-link { color: #2563eb; margin-left: 8px; }
    .expand-icon { font-size: 18px; color: #6b7280; font-weight: bold; }
    .template-layers-info { display: flex; flex-direction: column; gap: 8px; padding: 14px 16px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; margin-bottom: 16px; }
    .layer-info { display: flex; align-items: center; gap: 10px; }
    .layer-desc { font-size: 13px; color: #6b7280; }
    .layer-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
    .layer-sample { background: #dbeafe; color: #1e40af; }
    .layer-technology { background: #dcfce7; color: #166534; }
    .layer-experiment { background: #fef3c7; color: #92400e; }
    @media (max-width: 600px) { .template-grid { grid-template-columns: 1fr; } }
  `],
})
export class ExperimentSetupComponent implements OnInit {
  /** Optional whitelist; when empty/undefined, show all selectable templates from manifest */
  @Input() availableTemplates: string[] | null = null;
  @Input() aiEnabled = false;

  readonly wizardState = inject(WizardStateService);
  readonly templateService = inject(TemplateService);
  readonly staticTemplates = WIZARD_TEMPLATES;
  readonly state = this.wizardState.state;
  readonly showTemplateInfo = signal(false);
  readonly showDevTemplates = signal(false);
  readonly previewTemplateId = signal<string | null>(null);
  readonly isLoading = this.templateService.isLoading;

  readonly combination = this.wizardState.step1Combination;

  ngOnInit(): void {
    void this.templateService.fetchTemplates();
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

  readonly allSelectable = computed((): Array<TemplateInfo & { examples?: string[] }> => {
    const filter = this.availableTemplates?.length ? this.availableTemplates : undefined;
    const dynamic = this.templateService.getTemplateInfoList(filter);

    if (dynamic.length > 0) {
      return dynamic.map(t => ({
        ...t,
        examples: this.getTemplateExamples(t.id),
      }));
    }

    // Fallback static list with correct layers
    return this.staticTemplates
      .filter(t => !filter || filter.includes(t.id))
      .map(t => ({
        id: t.id,
        name: t.name,
        description: getTemplateShortDescription(t.id) || t.description,
        layer: this.getStaticTemplateLayer(t.id),
        usableAlone: t.id === 'ms-proteomics' || t.id === 'affinity-proteomics',
        extends: null,
        examples: t.examples,
        version: '1.1.0',
        status: 'stable' as const,
        requires: t.id === 'cell-lines'
          ? [{ layer: 'technology' as const }, { layer: 'sample' as const }]
          : undefined,
      }))
      .sort((a, b) => getTemplateSortOrder(a.id) - getTemplateSortOrder(b.id));
  });

  private filterVisible(layer: 'sample' | 'technology' | 'experiment') {
    return computed(() => {
      const showDev = this.showDevTemplates();
      return this.allSelectable()
        .filter(t => t.layer === layer)
        .filter(t => showDev || !isDevelopmentTemplate(t));
    });
  }

  readonly visibleTechnologyTemplates = this.filterVisible('technology');
  readonly visibleSampleTemplates = this.filterVisible('sample');
  readonly visibleExperimentTemplates = this.filterVisible('experiment');

  private getStaticTemplateLayer(templateId: string): 'sample' | 'technology' | 'experiment' {
    const layerMap: Record<string, 'sample' | 'technology' | 'experiment'> = {
      human: 'sample',
      vertebrates: 'sample',
      invertebrates: 'sample',
      plants: 'sample',
      'ms-proteomics': 'technology',
      'affinity-proteomics': 'technology',
      'cell-lines': 'experiment',
      'dia-acquisition': 'experiment',
      'single-cell': 'experiment',
      immunopeptidomics: 'experiment',
      crosslinking: 'experiment',
    };
    return layerMap[templateId] || 'sample';
  }

  private getTemplateExamples(templateId: string): string[] {
    const exampleMap: Record<string, string[]> = {
      human: ['Patient biopsies', 'Blood samples'],
      'cell-lines': ['HeLa', 'HEK293'],
      vertebrates: ['Mouse liver', 'Rat brain'],
      invertebrates: ['Drosophila', 'C. elegans'],
      plants: ['Arabidopsis', 'Rice'],
      'ms-proteomics': ['DDA', 'DIA'],
      'affinity-proteomics': ['Olink', 'SomaScan'],
      'dia-acquisition': ['DIA scan windows'],
      'single-cell': ['SCP'],
    };
    return exampleMap[templateId] || [];
  }

  selectSampleTemplate(template: WizardTemplate): void {
    this.wizardState.setSampleTemplate(
      this.wizardState.sampleTemplate() === template ? null : template
    );
  }

  clearSampleTemplate(): void {
    this.wizardState.setSampleTemplate(null);
  }

  selectTechnologyTemplate(template: WizardTemplate): void {
    this.wizardState.setTechnologyTemplate(template);
  }

  toggleExperiment(templateId: string): void {
    this.wizardState.toggleExperimentTemplate(templateId);
  }

  isExperimentSelected(templateId: string): boolean {
    return (this.wizardState.experimentTemplates() || []).includes(templateId);
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

  getIcon(templateId: WizardTemplate): string {
    return getTemplateEmoji(templateId);
  }
}
