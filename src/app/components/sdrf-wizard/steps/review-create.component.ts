import { protocolField, protocolChoiceForFile, protocolValueLabel } from '../../../core/utils/protocol-fields';
import { TemplateService } from '../../../core/services/template.service';
/**
 * Review & Create Component (Step 8)
 *
 * Preview generated SDRF and create the table.
 */

import {
  Component,
  Input,
  Output,
  EventEmitter,
  inject,
  computed,
  signal,
  effect,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';

import { WizardStateService } from '../../../core/services/wizard-state.service';
import { WizardGeneratorService } from '../../../core/services/wizard-generator.service';
import { SdrfExportService } from '../../../core/services/sdrf-export.service';
import {
  PyodideValidatorService,
  ValidationError,
} from '../../../core/services/pyodide-validator.service';
import { SdrfTable, getTableDataMatrix } from '../../../core/models/sdrf-table';
import {
  WIZARD_TEMPLATES,
  LABEL_CONFIGS,
  SDRF_SPEC_VERSION,
  formatSdrfSemver,
  getSampleTemplateId,
  resolveRunLabelConfigId,
  labelConfigDisplayName,
} from '../../../core/models/wizard';

@Component({
  selector: 'wizard-review-create',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="step-container">
      <div class="step-header">
        <h3>Review Your SDRF</h3>
        <p class="step-description">
          Preview the generated SDRF table before creating it.
        </p>
      </div>

      <!-- Summary Cards -->
      <div class="summary-grid">
        <div class="summary-card">
          <div class="summary-icon">{{ templateIcon() }}</div>
          <div class="summary-content">
            <span class="summary-label">Templates</span>
            <span class="summary-value">{{ templateName() }}</span>
          </div>
        </div>

        <div class="summary-card">
          <div class="summary-icon">#</div>
          <div class="summary-content">
            <span class="summary-label">Samples</span>
            <span class="summary-value">{{ state().sampleCount }}</span>
          </div>
        </div>

        <div class="summary-card">
          <div class="summary-icon">C</div>
          <div class="summary-content">
            <span class="summary-label">Columns</span>
            <span class="summary-value">{{ previewTable()?.columns?.length || 0 }}</span>
          </div>
        </div>

        <div class="summary-card">
          <div class="summary-icon">R</div>
          <div class="summary-content">
            <span class="summary-label">Rows</span>
            <span class="summary-value">{{ previewTable()?.sampleCount || 0 }}</span>
          </div>
        </div>
      </div>

      <!-- Configuration Summary -->
      <div class="config-summary">
        <h4>Configuration Summary</h4>
        <div class="config-grid">
          <div class="config-item">
            <span class="config-label">Sample template:</span>
            <span class="config-value">{{ sampleTemplateLabel() }}</span>
          </div>
          <div class="config-item">
            <span class="config-label">Technology:</span>
            <span class="config-value">{{ technologyTemplateLabel() }}</span>
          </div>
          <div class="config-item">
            <span class="config-label">Experiments:</span>
            <span class="config-value">{{ experimentTemplateLabel() }}</span>
          </div>
          <div class="config-item">
            <span class="config-label">SDRF version:</span>
            <span class="config-value">{{ sdrfVersion }}</span>
          </div>
          <div class="config-item">
            <span class="config-label">Factors:</span>
            <span class="config-value">{{ factorSummary() }}</span>
          </div>
          <div class="config-item">
            <span class="config-label">Organism:</span>
            <span class="config-value">{{ state().organism?.label || 'Not set' }}</span>
          </div>
          <div class="config-item">
            <span class="config-label">Disease:</span>
            <span class="config-value">{{ getDiseaseLabel() }}</span>
          </div>
          <div class="config-item">
            <span class="config-label">Organism Part:</span>
            <span class="config-value">{{ getOrganismPartLabel() }}</span>
          </div>
          <div class="config-item">
            <span class="config-label">Label kits:</span>
            <span class="config-value">{{ labelConfigName() }}</span>
          </div>
          <div class="config-item">
            <span class="config-label">MS Runs:</span>
            <span class="config-value">{{ state().msRuns.length }}</span>
          </div>
          <div class="config-item">
            <span class="config-label">Planner fractions:</span>
            <span class="config-value">{{ state().hasFractions ? state().fractionCount : '1' }}</span>
          </div>
          <div class="config-item">
            <span class="config-label">Planner tech reps:</span>
            <span class="config-value">{{ state().technicalReplicates }}</span>
          </div>
          <div class="config-item">
            <span class="config-label">Data files:</span>
            <span class="config-value">{{ state().dataFiles.length }}</span>
          </div>
          <div class="config-item">
            <span class="config-label">Instrument:</span>
            <span class="config-value">{{ protocolSummary('comment[instrument]') }}</span>
          </div>
          <div class="config-item">
            <span class="config-label">Enzyme:</span>
            <span class="config-value">{{ protocolSummary('comment[cleavage agent details]') }}</span>
          </div>
          <div class="config-item">
            <span class="config-label">Precursor mass tolerance:</span>
            <span class="config-value">{{ protocolSummary('comment[precursor mass tolerance]') }}</span>
          </div>
          <div class="config-item">
            <span class="config-label">Fragment mass tolerance:</span>
            <span class="config-value">{{ protocolSummary('comment[fragment mass tolerance]') }}</span>
          </div>
        </div>
      </div>

      <!-- Table Preview -->
      <div class="preview-section">
        <h4>Table Preview</h4>
        <div class="table-preview-container">
          @if (previewTable(); as table) {
            <table class="preview-table">
              <thead>
                <tr>
                  @for (col of table.columns; track col.columnPosition) {
                    <th>{{ col.name }}</th>
                  }
                </tr>
              </thead>
              <tbody>
                @for (row of previewRows(); track $index) {
                  <tr>
                    @for (cell of row; track $index) {
                      <td>{{ cell }}</td>
                    }
                  </tr>
                }
                @if (previewTable()!.sampleCount > 5) {
                  <tr class="more-rows">
                    <td [attr.colspan]="table.columns.length">
                      ... and {{ previewTable()!.sampleCount - 5 }} more rows
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <div class="no-preview">
              Complete all required steps to preview the SDRF.
            </div>
          }
        </div>
      </div>

      <!-- Snapshot validation summary -->
      <p class="spec-note">Checks use the selected repository snapshot. Ontology and specialized validator checks requiring additional validation are listed below.</p>
      @if (needsEditorFollowUp()) {
        <div class="hint-message">
          Selected experiment/sample templates may require additional columns
          (e.g. DIA scan windows, clinical fields). After create, fill them in the editor.
        </div>
      }

      <div class="spec-validation" [class.has-errors]="errorCount() > 0" [class.has-warnings]="warningCount() > 0 && errorCount() === 0" [class.ok]="validationDone() && errorCount() === 0 && warningCount() === 0">
        <div class="spec-validation-header">
          <strong>Template snapshot preflight</strong>
          @if (validationRunning()) {
            <span class="spec-status">Running…</span>
          } @else if (validationFailed()) {
            <span class="spec-status">Unavailable (you can still create)</span>
          } @else if (validationDone()) {
            <span class="spec-status">
              {{ errorCount() }} error(s), {{ warningCount() }} warning(s)
            </span>
          }
          <button type="button" class="retry-btn" (click)="runValidation()" [disabled]="validationRunning() || !previewTable()">
            Re-validate
          </button>
        </div>
        @if (validationFailed()) {
          <p class="spec-note">{{ validationErrorMessage() }}</p>
        }
        @if (validationDone() && displayedIssues().length > 0) {
          <ul class="issue-list">
            @for (issue of displayedIssues(); track $index) {
              <li [class.error]="issue.level === 'error'" [class.warning]="issue.level === 'warning'">
                <span class="issue-level">{{ issue.level }}</span>
                {{ issue.message }}
                @if (issue.column) {
                  <span class="issue-meta">({{ issue.column }})</span>
                }
              </li>
            }
          </ul>
          @if (truncatedIssues()) {
            <p class="spec-note">Showing first {{ displayedIssues().length }} issues.</p>
          }
        }
        @if (validationDone() && errorCount() > 0) {
          <p class="spec-note warn">
            Errors were found. You can still create the table and fix them in the editor.
          </p>
        }
      </div>

      <!-- Wizard field completion status -->
      <div class="validation-status" [class.valid]="wizardState.isAllValid()" [class.invalid]="!wizardState.isAllValid()">
        @if (wizardState.isAllValid()) {
          <span class="status-icon">&#10003;</span>
          <span>All required fields are complete. Ready to create SDRF!</span>
        } @else {
          <span class="status-icon">!</span>
          <span>Please complete all required steps before creating.</span>
        }
      </div>
    </div>
  `,
  styles: [`
    .step-container {
      max-width: 800px;
    }

    .step-header {
      margin-bottom: 24px;
    }

    .step-header h3 {
      margin: 0 0 8px 0;
      font-size: 18px;
      font-weight: 600;
      color: #1f2937;
    }

    .step-description {
      margin: 0;
      color: #6b7280;
      font-size: 14px;
    }

    .summary-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
      margin-bottom: 24px;
    }

    .summary-card {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px;
      background: #f9fafb;
      border-radius: 10px;
      border: 1px solid #e5e7eb;
    }

    .summary-icon {
      width: 40px;
      height: 40px;
      border-radius: 8px;
      background: #3b82f6;
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 18px;
      font-weight: 600;
      flex-shrink: 0;
    }

    .summary-content {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }

    .summary-label {
      font-size: 12px;
      color: #6b7280;
    }

    .summary-value {
      font-size: 14px;
      font-weight: 600;
      color: #1f2937;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .config-summary {
      margin-bottom: 24px;
      padding: 20px;
      background: #f9fafb;
      border-radius: 10px;
      border: 1px solid #e5e7eb;
    }

    .config-summary h4 {
      margin: 0 0 16px 0;
      font-size: 14px;
      font-weight: 600;
      color: #374151;
    }

    .config-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
    }

    .config-item {
      display: flex;
      gap: 8px;
    }

    .config-label {
      font-size: 13px;
      color: #6b7280;
      min-width: 120px;
    }

    .config-value {
      font-size: 13px;
      color: #1f2937;
      font-weight: 500;
    }

    .preview-section {
      margin-bottom: 24px;
    }

    .preview-section h4 {
      margin: 0 0 12px 0;
      font-size: 14px;
      font-weight: 600;
      color: #374151;
    }

    .table-preview-container {
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      overflow: auto;
    }

    .preview-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }

    .preview-table th,
    .preview-table td {
      padding: 10px 12px;
      border-bottom: 1px solid #e5e7eb;
      text-align: left;
      white-space: nowrap;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .preview-table th {
      background: #f3f4f6;
      font-weight: 600;
      color: #374151;
      position: sticky;
      top: 0;
    }

    .preview-table tbody tr:hover {
      background: #f9fafb;
    }

    .preview-table .more-rows td {
      text-align: center;
      color: #6b7280;
      font-style: italic;
      background: #f9fafb;
    }

    .no-preview {
      padding: 40px;
      text-align: center;
      color: #6b7280;
    }

    .hint-message {
      margin-bottom: 16px;
      padding: 12px 14px;
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      border-radius: 8px;
      font-size: 13px;
      color: #1e40af;
    }

    .spec-validation {
      margin-bottom: 16px;
      padding: 14px 16px;
      border-radius: 10px;
      border: 1px solid #e5e7eb;
      background: #f9fafb;
    }

    .spec-validation.ok {
      background: #ecfdf5;
      border-color: #a7f3d0;
    }

    .spec-validation.has-warnings {
      background: #fffbeb;
      border-color: #fde68a;
    }

    .spec-validation.has-errors {
      background: #fef2f2;
      border-color: #fecaca;
    }

    .spec-validation-header {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    .spec-status {
      font-size: 13px;
      color: #4b5563;
    }

    .retry-btn {
      margin-left: auto;
      border: 1px solid #d1d5db;
      background: white;
      border-radius: 6px;
      padding: 4px 10px;
      font-size: 12px;
      cursor: pointer;
    }

    .retry-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .issue-list {
      margin: 10px 0 0;
      padding-left: 18px;
      font-size: 12px;
      color: #374151;
    }

    .issue-list .error {
      color: #991b1b;
    }

    .issue-list .warning {
      color: #92400e;
    }

    .issue-level {
      font-weight: 700;
      text-transform: uppercase;
      margin-right: 6px;
      font-size: 10px;
    }

    .issue-meta {
      color: #6b7280;
    }

    .spec-note {
      margin: 8px 0 0;
      font-size: 12px;
      color: #6b7280;
    }

    .spec-note.warn {
      color: #991b1b;
    }

    .validation-status {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 16px 20px;
      border-radius: 10px;
      font-size: 14px;
    }

    .validation-status.valid {
      background: #d1fae5;
      color: #065f46;
    }

    .validation-status.invalid {
      background: #fef3c7;
      color: #92400e;
    }

    .status-icon {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: bold;
    }

    .validation-status.valid .status-icon {
      background: #10b981;
      color: white;
    }

    .validation-status.invalid .status-icon {
      background: #f59e0b;
      color: white;
    }

    @media (max-width: 600px) {
      .summary-grid {
        grid-template-columns: repeat(2, 1fr);
      }

      .config-grid {
        grid-template-columns: 1fr;
      }
    }
  `],
})
export class ReviewCreateComponent {
  @Input() aiEnabled = false;
  @Output() createTable = new EventEmitter<SdrfTable>();

  readonly wizardState = inject(WizardStateService);
  private readonly generator = inject(WizardGeneratorService);
  private readonly exporter = new SdrfExportService();
  private readonly validator = inject(PyodideValidatorService);

  readonly state = this.wizardState.state;
  protocolSummary(name: string): string {
    const field = protocolField(this.state(), name);
    const counts = new Map<string, number>();
    for (const file of this.state().dataFiles) {
      const choice = protocolChoiceForFile(field, file.fileName);
      if (choice) counts.set(choice.id, (counts.get(choice.id) || 0) + 1);
    }
    return field.choices.filter(choice => counts.has(choice.id)).map(choice =>
      protocolValueLabel(choice.value) + (counts.size > 1 ? ` (${counts.get(choice.id)} files)` : '')).join(' · ') || 'Not provided';
  }

  readonly sdrfVersion = formatSdrfSemver(SDRF_SPEC_VERSION);

  readonly validationRunning = signal(false);
  readonly validationDone = signal(false);
  readonly validationFailed = signal(false);
  readonly validationErrorMessage = signal('');
  readonly validationIssues = signal<ValidationError[]>([]);

  private lastValidatedKey = '';
  private validationRequest = 0;

  private readonly templateService = inject(TemplateService);

  readonly previewTable = computed(() => {
    try {
      return this.generator.generate(this.state());
    } catch {
      return null;
    }
  });

  readonly previewRows = computed(() => {
    const table = this.previewTable();
    if (!table) return [];
    const matrix = getTableDataMatrix(table);
    return matrix.slice(0, 5);
  });

  readonly errorCount = computed(() =>
    this.validationIssues().filter(i => i.level === 'error').length
  );

  readonly warningCount = computed(() =>
    this.validationIssues().filter(i => i.level === 'warning').length
  );

  readonly displayedIssues = computed(() => this.validationIssues().slice(0, 8));

  readonly truncatedIssues = computed(() => this.validationIssues().length > 8);

  private layerLabel(layer: string): string {
    return (this.state().selectedTemplates || []).filter(ref => this.templateService.getTemplateInfo(ref.name)?.layer === layer)
      .map(ref => `${ref.name} v${ref.version}`).join(' + ') || 'None';
  }
  readonly sampleTemplateLabel = computed(() => this.layerLabel('sample'));
  readonly technologyTemplateLabel = computed(() => this.layerLabel('technology'));
  readonly experimentTemplateLabel = computed(() => this.layerLabel('experiment'));
  readonly needsEditorFollowUp = computed(() => false);
  readonly templateName = computed(() => (this.state().leafTemplateRefs || []).map(ref => `${ref.name} v${ref.version}`).join(' + '));
  readonly templateIcon = computed(() => '📋');

  readonly labelConfigName = computed(() => {
    const s = this.state();
    const runs = s.msRuns || [];
    if (runs.length === 0) {
      return LABEL_CONFIGS.find(c => c.id === s.labelConfigId)?.name || 'Unknown';
    }
    const names = runs.map(r => {
      const id = resolveRunLabelConfigId(r, s);
      return labelConfigDisplayName(id);
    });
    return [...new Set(names)].join(' · ');
  });

  readonly factorSummary = computed(() => {
    const factors = this.state().factors.filter(f => f.enabled && f.name.trim());
    if (this.state().factorDecision === 'none') return `None (explicit): ${this.state().noFactorReason}`;
    if (factors.length === 0) return 'Not yet confirmed';
    return factors.map(f => `factor value[${f.name}] (${f.scope === 'run' ? 'MS run' : 'sample'})`).join(', ');
  });

  constructor() {
    effect(() => {
      const table = this.previewTable();
      if (!table || !this.wizardState.isAllValid()) return;
      const key = JSON.stringify([table.metadata?.templateSnapshotId, table.columns, table.sampleCount]);
      if (key !== this.lastValidatedKey) {
        this.lastValidatedKey = key;
        void this.runValidation();
      }
    });
  }

  async runValidation(): Promise<void> {
    const table = this.previewTable();
    if (!table) return;
    const request = ++this.validationRequest;
    const key = JSON.stringify([table.metadata?.templateSnapshotId, table.columns, table.sampleCount]);
    const isCurrent = () => request === this.validationRequest && key === JSON.stringify([this.previewTable()?.metadata?.templateSnapshotId, this.previewTable()?.columns, this.previewTable()?.sampleCount]);

    this.validationRunning.set(true);
    this.validationDone.set(false);
    this.validationIssues.set([]);
    this.validationFailed.set(false);
    this.validationErrorMessage.set('');

    try {
      const tsv = this.exporter.exportToTsv(table);
      const snapshotId = this.state().templateSnapshotId;
      if (!snapshotId) throw new Error('Template snapshot is missing. Return to template selection.');
      const errors = await this.templateService.validateTable(snapshotId, this.state().selectedTemplates || [], tsv);

      if (!isCurrent()) return;
      this.validationIssues.set(errors);
      this.validationDone.set(true);
    } catch (err) {
      if (!isCurrent()) return;
      this.validationFailed.set(true);
      this.validationDone.set(false);
      this.validationIssues.set([]);
      this.validationErrorMessage.set(
        err instanceof Error ? err.message : 'Validation service unavailable'
      );
    } finally {
      if (request === this.validationRequest) this.validationRunning.set(false);
    }
  }

  getDiseaseLabel(): string {
    const disease = this.state().disease;
    if (!disease) return 'Not set';
    if (typeof disease === 'string') return disease;
    return disease.label;
  }

  getOrganismPartLabel(): string {
    const part = this.state().organismPart;
    if (!part) return 'Not set';
    if (typeof part === 'string') return part;
    return part.label;
  }

  onCreate(): void {
    const table = this.previewTable();
    if (table) {
      this.createTable.emit(table);
    }
  }
}
