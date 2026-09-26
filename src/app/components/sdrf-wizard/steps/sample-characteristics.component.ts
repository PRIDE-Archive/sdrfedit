/**
 * Sample Characteristics Component (Step 2)
 *
 * Multi-value candidate lists per characteristics column (quick picks + search).
 */

import {
  Component,
  Input,
  inject,
  signal,
  computed,
  OnInit,
  OnDestroy,
  ElementRef,
  viewChild,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { WizardStateService } from '../../../core/services/wizard-state.service';
import {
  OntologyTerm,
  WizardCharacteristicColumnMeta,
  CharacteristicChoice,
  getSpecialtyCharacteristicKey,
  getQuickPickSuggestions,
  parseCharacteristicInnerName,
  isWizardSkippedCharacteristic,
} from '../../../core/models/wizard';
import { olsService } from '../../../core/services/ols.service';
import { OntologySuggestion } from '../../../core/models/ontology';

function suggestionToTerm(s: OntologySuggestion): OntologyTerm {
  return {
    id: s.id,
    label: s.label,
    iri: s.iri,
    ontologyPrefix: s.ontologyPrefix,
    ontology: s.ontologyPrefix,
  };
}

@Component({
  selector: 'wizard-sample-characteristics',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="step-container">
      @if (!embedded) {
      <div class="step-header">
        <h3>Sample attributes</h3>
        <p class="step-description">
          Choose whether samples share a value or differ. Changes take effect when you apply them.
        </p>
      </div>
      }

      @if (loading()) {
        <div class="status">Loading template characteristics…</div>
      } @else if (loadError()) {
        <div class="status error">{{ loadError() }}</div>
      }

      <section class="column-section">
        <h4 class="section-title">
          <span class="badge required">Required</span>
          <span class="count">{{ requiredColumns().length }}</span>
        </h4>
        @for (col of requiredColumns(); track col.name) {
          <ng-container *ngTemplateOutlet="fieldTpl; context: { $implicit: col, required: true }" />
        }
      </section>

      <section class="column-section">
        <button type="button" class="section-toggle" (click)="showRecommended.set(!showRecommended())">
          <span class="badge recommended">Recommended</span>
          <span class="count">{{ recommendedColumns().length }}</span>
          <span class="chevron">{{ showRecommended() ? '−' : '+' }}</span>
        </button>
        @if (showRecommended()) {
          @if (recommendedColumns().length === 0) {
            <div class="empty">No recommended characteristics for this selection.</div>
          } @else {
            @for (col of recommendedColumns(); track col.name) {
              <ng-container *ngTemplateOutlet="fieldTpl; context: { $implicit: col, required: false }" />
            }
          }
        }
      </section>

      @if (optionalColumns().length) {
        <section class="column-section">
          <button type="button" class="section-toggle" (click)="showOptional.set(!showOptional())"
            [attr.aria-expanded]="showOptional()">
            <span class="badge optional">Optional</span>
            <span class="count">{{ optionalColumns().length }}</span>
            <span class="chevron">{{ showOptional() ? '−' : '+' }}</span>
          </button>
          @if (showOptional()) {
            <p class="step-description">Fill the fields relevant to your study. Empty optional fields are omitted.</p>
            @for (col of optionalColumns(); track col.name) {
              <ng-container *ngTemplateOutlet="fieldTpl; context: { $implicit: col, required: false }" />
            }
          }
        </section>
      }

    </div>

    <dialog #samplePicker class="sample-picker" aria-labelledby="sample-picker-title" (cancel)="closeSamplePicker()" (close)="stopDrag()">
      <div class="picker-heading"><div><h3 id="sample-picker-title">Select samples</h3><span>{{ assignmentValue() }}</span>
        @if (selectedOntologyId()) { <span class="ontology-id">{{ selectedOntologyId() }}</span> }
      </div><button type="button" class="editor-button" aria-label="Close sample selection" (click)="closeSamplePicker()">×</button></div>
      <div class="picker-controls">
        <div class="mode-buttons"><button type="button" class="editor-button" (click)="selectAssignmentSamples('all')">All available</button><button type="button" class="editor-button" (click)="selectAssignmentSamples('missing')">Unassigned</button><button type="button" class="editor-button" (click)="selectAssignmentSamples('none')">Clear</button><span class="selection-count" aria-live="polite">{{ assignmentSelection().size }} selected</span></div>
        <p class="help-text">Click or drag to select.</p>
      </div>
      <div #sampleGrid class="sample-tile-grid" role="group" aria-label="Select samples">
        @for (sample of state().samples; track sample.index; let i = $index) {
          <button type="button" class="editor-button sample-tile" [attr.data-sample-index]="i" [attr.aria-disabled]="isAssignmentLocked(i)" [attr.aria-pressed]="assignmentSelection().has(i)" (pointerdown)="startDrag($event, i)" (click)="clickSample($event, i)"><span>{{ sample.sourceName }}</span><small>{{ isAssignmentLocked(i) ? 'Locked · ' + draftAssignments()[i] : assignmentSelection().has(i) ? '✓ Selected' : 'Unselected' }}</small></button>
        }
      </div>
      @if (hasLockedSamples()) { <p class="help-text picker-note">Locked samples belong to another value.</p> }
      <div class="editor-footer picker-actions"><button type="button" class="editor-button" (click)="closeSamplePicker()">Cancel</button><button type="button" class="editor-button primary" (click)="applyAssignmentBatch()">Apply selection ({{ assignmentSelection().size }})</button></div>
    </dialog>

    <ng-template #fieldTpl let-col let-required="required">
      <section class="attribute-row" [attr.data-column]="col.name">
        <button type="button" class="attribute-summary" [attr.aria-expanded]="editingColumn() === col.name" (click)="openEditor(col.name)">
          <strong>{{ columnTitle(col) }} @if (required) { <span class="req">*</span> }</strong>
          <span class="attribute-value">{{ summaryValues(col.name) }}<small>{{ assignmentSummary(col.name) }}</small></span>
          <span class="edit-label">{{ editingColumn() === col.name ? 'Close' : choices(col.name).length ? 'Edit' : 'Set value' }}</span>
        </button>
        @if (editingColumn() === col.name) {
          <div class="attribute-editor">
            <div class="attribute-editor-scroll" role="region" [attr.aria-label]="columnTitle(col) + ' settings'" tabindex="0">
            <p class="help-text">{{ col.description || hintFor(col) }}</p>
            @if (draftChoices().length) {
              <div class="assignment-value-list">
                @for (choice of draftChoices(); track choice.value) {
                  <div class="assignment-value-row">
                    <div class="assignment-value-label"><strong>{{ choice.value }}</strong>
                      @if (choice.ontologyTerm?.id) { <span class="ontology-id">{{ choice.ontologyTerm?.id }}</span> }
                      <small>{{ countAssignments(choice.value) }} samples assigned</small>
                    </div>
                    <div class="value-actions">
                    <button type="button" class="editor-button" [attr.title]="'Assign ' + choice.value + ' to all samples'" (click)="assignAllSamples(choice.value)">All</button>
                    <button type="button" class="editor-button" (click)="openSamplePicker(choice.value)">Select samples</button>
                    <button type="button" class="editor-button remove" [attr.aria-label]="'Remove ' + choice.value" (click)="removeDraftChoice(choice.value)">×</button>
                    </div>
                  </div>
                }
              </div>
            }
            @if (valueEditorOpen()) {
              <div class="candidate-editor">
                <h4>Add a value</h4>
            <label class="form-label" [attr.for]="'attribute-search-' + col.name">{{ columnTitle(col) }}</label>
            <div class="autocomplete-container">
              <input type="text" class="form-input" [id]="'attribute-search-' + col.name" [ngModel]="searchQuery(col.name)" (ngModelChange)="onSearch(col, $event)" (keydown.enter)="confirmSearch(col, $event)" (focus)="activeColumn.set(col.name)" [placeholder]="searchPlaceholder(col)" />
              @if (activeColumn() === col.name && searchResults().length > 0) {
                <div class="autocomplete-dropdown">
                  @for (result of searchResults(); track result.id) {
                    <button type="button" class="autocomplete-option" (click)="selectOntology(col.name, result)"><span class="option-label">{{ result.label }}</span><span class="option-id">{{ result.id }}</span></button>
                  }
                </div>
              }
            </div>
            <div class="quick-row">@for (pick of quickPicks(col); track pick) { @if (!hasDraftChoice(pick)) { <button type="button" class="quick-btn" (click)="addDraftChoice(pick)">{{ pick }}</button> } }</div>
              </div>
            } @else {
              <button type="button" class="editor-button add-value" (click)="openValueEditor()">+ Add value</button>
            }
            @if (saveError()) { <p class="status error" role="alert">{{ saveError() }}</p> }
            </div>
            <div class="editor-footer attribute-editor-actions"><span class="impact-message" aria-live="polite">{{ draftImpact() }}</span>@if (!saveError()) { <span class="help-text">Changes saved automatically</span> }</div>
          </div>
        }
      </section>
    </ng-template>
  `,
  styles: [`
    .candidate-editor { background: #fff; border: 1px solid #dce4ef; border-radius: 8px; padding: 16px; margin-top: 16px; }
    .candidate-editor h4 { margin: 0 0 16px; font-size: 13px; color: #334155; }
    .candidate-editor .autocomplete-dropdown { right: 0; }
    .candidate-editor .quick-row { margin-bottom: 0; }
    .add-value { margin-top: 16px; }
    .value-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .editor-button.remove { color: #b91c1c; }

    .assignment-value-row { display: flex; align-items: center; gap: 12px; padding: 14px 0; border-bottom: 1px solid #dce4ef; flex-wrap: wrap; }
    .assignment-value-label { flex: 1; min-width: 140px; overflow-wrap: anywhere; font-size: 13px; }
    .assignment-value-label small { display: block; color: #64748b; margin-top: 4px; }
    .ontology-id { display: inline-block; font-size: 11px; color: #64748b; background: #edf2f8; border: 1px solid #dce4ef; border-radius: 4px; padding: 2px 6px; margin-left: 6px; }
    .sample-picker { width: min(680px, calc(100vw - 24px)); max-height: calc(100dvh - 32px); padding: 0; border: 1px solid #dce4ef; border-radius: 12px; color: #334155; background: #fff; box-shadow: 0 16px 60px #0f172a40; }
    .sample-picker[open] { display: flex; flex-direction: column; }
    .sample-picker::backdrop { background: #0f172a66; }
    .picker-heading { display: flex; justify-content: space-between; align-items: center; padding: 18px 20px; border-bottom: 1px solid #dce4ef; flex-shrink: 0; }
    .picker-heading h3 { margin: 0 0 8px; font-size: 16px; }
    .picker-controls { padding: 12px 20px 0; flex-shrink: 0; }
    .sample-picker .sample-tile-grid { margin: 8px 20px; flex: 0 1 300px; min-height: 80px; user-select: none; }
    .sample-tile[aria-disabled="true"] { background: #f1f5f9; color: #64748b; cursor: not-allowed; }
    .selection-count { margin-left: auto; font-size: 12px; color: #64748b; white-space: nowrap; }
    .picker-note { margin: 4px 20px; }
    .picker-actions { padding: 12px 20px; border-top: 1px solid #dce4ef; flex-shrink: 0; }
    :host { display: block; min-width: 0; }
    .step-container { width: 100%; }
    .attribute-row { border-bottom: 1px solid #e2e8f0; }
    .attribute-summary { width: 100%; display: flex; align-items: center; gap: 12px; padding: 16px 0; border: 0; background: #fff; color: #334155; text-align: left; cursor: pointer; font: inherit; }
    .attribute-summary strong { width: 140px; flex-shrink: 0; font-size: 13px; }
    .attribute-value { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 12px; }
    .attribute-value small { display: block; margin-top: 3px; color: #64748b; font-size: 12px; }
    .edit-label { color: #2563eb; font-size: 12px; }
    .attribute-editor { box-sizing: border-box; max-height: min(620px, 75dvh); display: flex; flex-direction: column; overflow: hidden; margin-bottom: 16px; background: #f8fafc; border: 1px solid #dce4ef; border-radius: 10px; }
    .attribute-editor-scroll { flex: 0 1 auto; min-height: 0; overflow-y: auto; padding: 18px; scrollbar-gutter: stable; overscroll-behavior-y: auto; }
    .attribute-editor-actions { align-items: center; flex-shrink: 0; margin-top: 0 !important; padding: 12px 18px; background: #f8fafc; }

    .mode-buttons { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
    .editor-button { padding: 8px 12px; border: 1px solid #dce4ef; border-radius: 7px; background: #fff; color: #334155; font: inherit; font-size: 12px; cursor: pointer; }
    .editor-button[aria-pressed="true"] { color: #2563eb; border-color: #2563eb; background: #eff6ff; }
    .editor-button.primary { background: #2563eb; color: #fff; }
    .editor-button:disabled { opacity: .45; cursor: not-allowed; }
    .editor-footer { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
    .assignment-workspace { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 20px; margin-top: 16px; }
    .assignment-values { border-right: 1px solid #dce4ef; padding-right: 16px; }
    .value-choice { display: block; width: 100%; text-align: left; margin: 8px 0; overflow-wrap: anywhere; }
    .value-choice small, .sample-tile small { display: block; color: #64748b; font-size: 11px; margin-top: 4px; }
    .sample-tile-grid { box-sizing: border-box; height: 300px; overflow-y: auto; overscroll-behavior-y: contain; scrollbar-gutter: stable; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-content: start; grid-auto-rows: max-content; gap: 8px; margin: 12px 0; padding: 8px; border: 1px solid #dce4ef; border-radius: 8px; background: #fff; }
    .sample-tile { text-align: left; overflow-wrap: anywhere; }
    .assignment-workspace summary { font-size: 12px; color: #64748b; cursor: pointer; margin: 8px 0; }
    @media (max-width: 650px) { .assignment-workspace { grid-template-columns: 1fr; } .assignment-values { border-right: 0; padding-right: 0; } .sample-tile-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    .assignment-batch { margin-top: 16px; padding: 14px; background: #fff; border: 1px solid #dce4ef; border-radius: 8px; }
    .assignment-batch strong { font-size: 13px; }
    .batch-controls { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
    .batch-controls .form-input { flex: 1; min-width: 140px; }
    .assignment-sample { padding: 10px; border: 1px solid transparent; border-radius: 8px; }
    .assignment-selected { border-color: #93c5fd; background: #eff6ff; }
    .sample-selection { display: flex; align-items: center; gap: 8px; color: #475569; font-size: 12px; overflow-wrap: anywhere; }
    .assignment-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
    .assignment-grid select { width: 100%; margin-top: 4px; }
    .attribute-editor-actions .impact-message { flex: 1; margin: 0; }
    .impact-message { font-size: 12px; color: #64748b; margin: 12px 0; }
    .attribute-editor .quick-row { margin-top: 8px; }
    .attribute-editor .choice-chips { margin: 12px 0; }
    .attribute-editor .form-input { min-width: 0; }
    @media (max-width: 600px) { .attribute-summary { flex-wrap: wrap; } .attribute-summary strong { flex: 1; } .attribute-value { order: 3; flex-basis: 100%; } .assignment-grid { grid-template-columns: 1fr; } }

    .step-header { margin-bottom: 16px; }
    .step-header h3 { margin: 0 0 6px; font-size: 18px; font-weight: 600; color: #111827; }
    .step-description { margin: 0; font-size: 14px; color: #6b7280; }
    .status { padding: 12px 14px; font-size: 13px; color: #64748b; }
    .status.error { color: #b91c1c; }
    .info-banner {
      display: flex; gap: 10px; padding: 12px 14px; margin-bottom: 16px;
      background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 10px;
    }
    .info-icon {
      width: 20px; height: 20px; border-radius: 50%; background: #3b82f6; color: #fff;
      display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0;
    }
    .info-content strong { display: block; font-size: 13px; color: #1e40af; margin-bottom: 2px; }
    .info-content p { margin: 0; font-size: 12px; color: #4b5563; }
    .column-section { margin-bottom: 18px; }
    .section-title, .section-toggle {
      display: flex; align-items: center; gap: 8px; margin: 0 0 10px;
      font-size: 13px; font-weight: 600; color: #374151;
    }
    .section-toggle {
      width: 100%; border: 1px solid #e5e7eb; background: #f9fafb; border-radius: 8px;
      padding: 10px 12px; cursor: pointer; text-align: left;
    }
    .chevron { margin-left: auto; color: #9ca3af; }
    .badge {
      display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 10px;
      text-transform: uppercase; letter-spacing: 0.04em;
    }
    .badge.required { background: #fee2e2; color: #991b1b; }
    .badge.recommended { background: #ffedd5; color: #9a3412; }
    .badge.optional { background: #e0e7ff; color: #3730a3; }
    .count { color: #9ca3af; font-weight: 500; }
    .form-section { margin-bottom: 14px; padding: 12px; border: 1px solid #f3f4f6; border-radius: 10px; background: #fff; }
    .form-label { display: block; font-size: 13px; font-weight: 600; color: #111827; margin-bottom: 6px; }
    .help-text { display: block; font-size: 12px; font-weight: 400; color: #6b7280; margin-top: 2px; }
    .req { color: #ef4444; }
    .autocomplete-container { position: relative; display: flex; gap: 8px; }
    .form-input {
      flex: 1; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px;
      font-size: 14px; box-sizing: border-box;
    }
    .add-btn {
      width: 40px; border: 1px solid #d1d5db; border-radius: 8px; background: #f9fafb;
      font-size: 18px; cursor: pointer; color: #374151;
    }
    .autocomplete-dropdown {
      position: absolute; z-index: 20; left: 0; right: 48px; top: 100%;
      background: #fff; border: 1px solid #e5e7eb; border-radius: 8px;
      max-height: 220px; overflow: auto; box-shadow: 0 8px 20px rgba(15,23,42,0.08);
    }
    .autocomplete-option {
      width: 100%; display: flex; justify-content: space-between; gap: 8px;
      padding: 8px 10px; border: none; background: transparent; cursor: pointer; text-align: left;
    }
    .autocomplete-option:hover { background: #f3f4f6; }
    .option-label { font-size: 13px; color: #111827; }
    .option-id { font-size: 11px; color: #9ca3af; }
    .choice-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; min-height: 28px; align-items: center; }
    .selected-chip {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 10px; border-radius: 999px; background: #eff6ff; color: #1d4ed8; font-size: 12px;
    }
    .chip-clear { border: none; background: transparent; cursor: pointer; color: #64748b; font-size: 14px; }
    .empty-hint { font-size: 12px; color: #94a3b8; }
    .quick-row { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
    .quick-btn {
      border: 1px solid #e5e7eb; background: #f9fafb; border-radius: 999px;
      padding: 4px 10px; font-size: 12px; cursor: pointer;
    }
    .quick-btn.active { background: #dbeafe; border-color: #93c5fd; color: #1d4ed8; }
    .empty { font-size: 13px; color: #94a3b8; padding: 8px 4px; }
    .validation-message {
      display: flex; gap: 8px; align-items: flex-start; padding: 12px 14px;
      background: #fef3c7; border: 1px solid #fcd34d; border-radius: 8px; color: #92400e; font-size: 13px;
    }
    .warning-icon {
      width: 18px; height: 18px; border-radius: 50%; background: #f59e0b; color: #fff;
      display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; flex-shrink: 0;
    }
  `],
})
export class SampleCharacteristicsComponent implements OnInit, OnDestroy {
  @Input() embedded = false;

  @Input() aiEnabled = false;

  readonly wizardState = inject(WizardStateService);
  private readonly ols = olsService;
  readonly state = this.wizardState.state;

  readonly editingColumn = signal<string | null>(null);
  readonly valueEditorOpen = signal(false);
  readonly draftChoices = signal<CharacteristicChoice[]>([]);
  readonly draftAssignments = signal<string[]>([]);
  readonly assignmentSelection = signal<Set<number>>(new Set());
  readonly assignmentValue = signal('');
  readonly hasLockedSamples = computed(() => this.draftAssignments().some(value => !!value && value !== this.assignmentValue()));
  readonly selectedOntologyId = computed(() => this.draftChoices().find(c => c.value === this.assignmentValue())?.ontologyTerm?.id);
  private readonly samplePicker = viewChild<ElementRef<HTMLDialogElement>>('samplePicker');
  private readonly sampleGrid = viewChild<ElementRef<HTMLElement>>('sampleGrid');
  private drag: { start: number; select: boolean; base: Set<number>; x: number; y: number } | null = null;
  private dragFrame = 0;
  private suppressClick = false;
  countAssignments(value: string): number { return this.draftAssignments().filter(v => v === value).length; }
  isAssignmentLocked(index: number): boolean { const value = this.draftAssignments()[index]; return !!value && value !== this.assignmentValue(); }
  openSamplePicker(value: string): void {
    this.assignmentValue.set(value);
    this.assignmentSelection.set(new Set(this.draftAssignments().flatMap((v, i) => v === value ? [i] : [])));
    this.samplePicker()?.nativeElement.showModal();
    const grid = this.sampleGrid()?.nativeElement; if (grid) grid.scrollTop = 0;
  }
  closeSamplePicker(): void { this.stopDrag(); this.samplePicker()?.nativeElement.close(); }
  selectAssignmentSamples(mode: 'all' | 'missing' | 'none'): void {
    const next = mode === 'missing' ? new Set(this.assignmentSelection()) : new Set<number>();
    this.draftAssignments().forEach((v, i) => { if ((mode === 'all' && !this.isAssignmentLocked(i)) || (mode === 'missing' && !v)) next.add(i); });
    this.assignmentSelection.set(next);
  }
  clickSample(event: MouseEvent, index: number): void {
    if (this.isAssignmentLocked(index) || (event.detail > 0 && this.suppressClick)) return;
    this.assignmentSelection.update(selection => { const next = new Set(selection); next.has(index) ? next.delete(index) : next.add(index); return next; });
  }
  startDrag(event: PointerEvent, index: number): void {
    this.suppressClick = false;
    if (event.button !== 0 || event.pointerType === 'touch' || this.isAssignmentLocked(index)) return;
    event.preventDefault(); (event.currentTarget as HTMLElement).focus(); this.suppressClick = true;
    this.drag = { start: index, select: !this.assignmentSelection().has(index), base: new Set(this.assignmentSelection()), x: event.clientX, y: event.clientY };
    this.paintDrag(index);
    document.addEventListener('pointermove', this.moveDrag);
    document.addEventListener('pointerup', this.stopDrag);
    document.addEventListener('pointercancel', this.stopDrag);
    window.addEventListener('blur', this.stopDrag);
    this.dragFrame = requestAnimationFrame(this.scrollDrag);
  }
  private paintDrag(index: number): void {
    const drag = this.drag; if (!drag) return;
    const next = new Set(drag.base);
    for (let i = Math.min(drag.start, index); i <= Math.max(drag.start, index); i++) {
      if (!this.isAssignmentLocked(i)) { if (drag.select) next.add(i); else next.delete(i); }
    }
    this.assignmentSelection.set(next);
  }
  private readonly moveDrag = (event: PointerEvent): void => {
    if (!this.drag) return;
    this.drag.x = event.clientX; this.drag.y = event.clientY;
    this.hitDrag(event.clientX, event.clientY);
  };
  private hitDrag(x: number, y: number): void {
    const grid = this.sampleGrid()?.nativeElement;
    const tile = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-sample-index]');
    if (tile && grid?.contains(tile)) this.paintDrag(Number(tile.dataset['sampleIndex']));
  }
  private readonly scrollDrag = (): void => {
    const drag = this.drag, grid = this.sampleGrid()?.nativeElement; if (!drag || !grid) return;
    const rect = grid.getBoundingClientRect();
    if (drag.x >= rect.left && drag.x <= rect.right) {
      const speed = drag.y > rect.bottom - 32 ? 10 : drag.y < rect.top + 32 ? -10 : 0;
      if (speed) { grid.scrollTop += speed; this.hitDrag(drag.x, Math.max(rect.top + 8, Math.min(rect.bottom - 8, drag.y))); }
    }
    this.dragFrame = requestAnimationFrame(this.scrollDrag);
  };
  readonly stopDrag = (): void => {
    this.drag = null; cancelAnimationFrame(this.dragFrame);
    document.removeEventListener('pointermove', this.moveDrag);
    document.removeEventListener('pointerup', this.stopDrag);
    document.removeEventListener('pointercancel', this.stopDrag);
    window.removeEventListener('blur', this.stopDrag);
  };
  ngOnDestroy(): void { this.stopDrag(); }
  applyAssignmentBatch(): void {
    const value = this.assignmentValue(), selected = this.assignmentSelection();
    if (!this.hasDraftChoice(value)) return;
    this.draftAssignments.update(values => values.map((old, i) => old && old !== value ? old : selected.has(i) ? value : ''));
    this.applyDraft();
    this.closeSamplePicker();
  }
  readonly saveError = signal('');
  private editingSamples: string[] = [];
  readonly singleValueAssignedToAll = computed(() => this.draftChoices().length === 1 && this.draftAssignments().length === this.state().samples.length && this.draftAssignments().every(value => value === this.draftChoices()[0].value));
  readonly draftImpact = computed(() => `${this.draftAssignments().filter(Boolean).length} / ${this.state().samples.length} samples assigned.`);
  summaryValues(name: string): string { return this.choices(name).map(choice => choice.value).join(' · ') || 'Not set'; }
  assignmentSummary(name: string): string {
    const choices = this.choices(name);
    if (!choices.length) return 'No values added';
    const assignments = this.state().samples.map(sample => sample.characteristicValues?.[name] ?? (choices.length === 1 ? choices[0].value : ''));
    if (assignments.length && choices.some(choice => choice.value === assignments[0]) && assignments.every(value => value === assignments[0])) return `Same for all ${assignments.length} samples`;
    return `${this.state().samples.filter(sample => choices.some(choice => choice.value === sample.characteristicValues?.[name])).length} / ${this.state().samples.length} samples assigned`;
  }
  openEditor(name: string): void {
    if (this.editingColumn() === name) { this.closeEditor(); return; }
    this.editingColumn.set(name);
    this.closeSamplePicker(); this.assignmentSelection.set(new Set()); this.assignmentValue.set('');
    this.draftChoices.set(this.choices(name).map(choice => ({ ...choice })));
    this.draftAssignments.set(this.state().samples.map(sample => sample.characteristicValues?.[name] ?? (this.choices(name).length === 1 ? this.choices(name)[0].value : '')));
    this.valueEditorOpen.set(this.draftChoices().length === 0);
    this.editingSamples = this.state().samples.map(sample => sample.sourceName);
    this.saveError.set(''); this.searchResults.set([]); this.searchMap.set({});
  }
  closeEditor(): void { this.closeSamplePicker(); this.editingColumn.set(null); this.activeColumn.set(null); this.searchResults.set([]); }
  openValueEditor(): void {
    this.searchMap.set({}); this.searchResults.set([]); this.activeColumn.set(null);
    this.valueEditorOpen.set(true);
  }
  async confirmSearch(col: WizardCharacteristicColumnMeta, event: Event): Promise<void> {
    if ((event as KeyboardEvent).isComposing) return;
    event.preventDefault();
    const query = this.searchQuery(col.name).trim();
    if (!query) return;
    this.activeColumn.set(col.name);
    await this.runOntologySearch(col, query);
    if (this.editingColumn() !== col.name || this.searchQuery(col.name).trim() !== query || !this.valueEditorOpen()) return;
    const results = this.searchResults();
    const term = results.find(result => result.label.toLowerCase() === query.toLowerCase() || result.id.toLowerCase() === query.toLowerCase()) ?? results[0];
    if (term) this.selectOntology(col.name, term);
    else this.addFreeText(col);
  }
  hasDraftChoice(value: string): boolean { return this.draftChoices().some(choice => choice.value.toLowerCase() === value.toLowerCase()); }
  addDraftChoice(value: string, ontologyTerm?: OntologyTerm): void {
    if (!ontologyTerm && this.editingColumn() === 'characteristics[organism]') {
      const id = ({ 'Homo sapiens': 'NCBITaxon:9606', 'Mus musculus': 'NCBITaxon:10090' } as Record<string, string>)[value];
      if (id) ontologyTerm = { id, label: value, ontologyPrefix: 'NCBITaxon' };
    }
    if (!this.hasDraftChoice(value)) { this.draftChoices.update(choices => [...choices, { value, ontologyTerm }]); this.applyDraft(); }
    if (!this.saveError()) {
      this.valueEditorOpen.set(false); this.activeColumn.set(null); this.searchResults.set([]); this.searchMap.set({});
    }
  }
  assignAllSamples(value: string): void {
    if (!this.hasDraftChoice(value)) return;
    this.draftAssignments.update(assignments => assignments.map(() => value));
    this.applyDraft();
  }
  removeDraftChoice(value: string): void {
    this.draftChoices.update(choices => choices.filter(choice => choice.value !== value));
    this.draftAssignments.update(values => values.map(v => v === value ? '' : v));
    this.applyDraft();
    if (!this.draftChoices().length) this.openValueEditor();
  }
  setDraftAssignment(index: number, value: string): void { this.draftAssignments.update(values => values.map((v, i) => i === index ? value : v)); }
  applyDraft(): void {
    if (this.editingSamples.join('\t') !== this.state().samples.map(sample => sample.sourceName).join('\t')) { this.saveError.set('The sample list changed. Close and reopen this attribute before applying.'); return; }
    try {
      this.wizardState.applyCharacteristicDraft(this.editingColumn()!, this.draftChoices(), 'explicit', this.draftAssignments());
      this.saveError.set('');
    } catch (error) { this.saveError.set(error instanceof Error ? error.message : 'Could not apply attribute.'); }
  }

  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly showRecommended = signal(false);

  readonly activeColumn = signal<string | null>(null);
  readonly showOptional = signal(false);
  readonly optionalColumns = computed(() =>
    (this.state().characteristicColumns || []).filter(c =>
      c.requirement === 'optional' && !isWizardSkippedCharacteristic(c.name)
        && getSpecialtyCharacteristicKey(c.name) !== 'material type')
  );
  readonly searchResults = signal<OntologyTerm[]>([]);
  private readonly searchMap = signal<Record<string, string>>({});

  readonly requiredColumns = computed(() =>
    (this.state().characteristicColumns || []).filter(
      c => c.requirement === 'required' && !isWizardSkippedCharacteristic(c.name)
        && getSpecialtyCharacteristicKey(c.name) !== 'material type'
    )
  );
  readonly recommendedColumns = computed(() =>
    (this.state().characteristicColumns || []).filter(
      c => c.requirement === 'recommended' && !isWizardSkippedCharacteristic(c.name)
        && getSpecialtyCharacteristicKey(c.name) !== 'material type'
    )
  );

  ngOnInit(): void {
    this.wizardState.ensureDefaultFactors();
    void this.loadColumns();
  }

  private async loadColumns(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      await this.wizardState.refreshCharacteristicColumns();
    } catch (e: any) {
      this.loadError.set(e?.message || 'Failed to load characteristics');
    } finally {
      this.loading.set(false);
    }
  }

  columnTitle(col: WizardCharacteristicColumnMeta): string {
    const inner = parseCharacteristicInnerName(col.name);
    if (!inner) return col.name;
    return inner.charAt(0).toUpperCase() + inner.slice(1);
  }

  hintFor(col: WizardCharacteristicColumnMeta): string {
    return `Add one or more values for ${col.name}`;
  }

  choices(columnName: string): CharacteristicChoice[] {
    return this.state().characteristicChoices?.[columnName] || [];
  }

  hasChoice(columnName: string, value: string): boolean {
    return this.choices(columnName).some(
      c => c.value.trim().toLowerCase() === value.trim().toLowerCase()
    );
  }

  quickPicks(col: WizardCharacteristicColumnMeta): string[] {
    return getQuickPickSuggestions(col.name, col);
  }

  searchQuery(columnName: string): string {
    return this.searchMap()[columnName] || '';
  }

  searchPlaceholder(col: WizardCharacteristicColumnMeta): string {
    if (col.ontologies?.length) {
      return `Search ${(col.ontologies || []).join(', ')} or type a value…`;
    }
    return 'Type a value and press Enter or +';
  }

  onSearch(col: WizardCharacteristicColumnMeta, query: string): void {
    this.searchMap.update(m => ({ ...m, [col.name]: query }));
    this.activeColumn.set(col.name);
    void this.runOntologySearch(col, query);
  }

  addFreeText(col: WizardCharacteristicColumnMeta): void {
    const q = (this.searchMap()[col.name] || '').trim();
    if (!q) return;
    const key = getSpecialtyCharacteristicKey(col.name);
    const value =
      key === 'organism' ? q : q.toLowerCase() === q ? q : (key === 'disease' || key === 'organism part' ? q.toLowerCase() : q);
    this.addDraftChoice(value);
    this.searchMap.update(m => ({ ...m, [col.name]: '' }));
    this.searchResults.set([]);
  }

  selectOntology(columnName: string, term: OntologyTerm): void {
    const key = getSpecialtyCharacteristicKey(columnName);
    const value =
      key === 'organism' ? term.label : term.label.toLowerCase();
    this.addDraftChoice(value, term);
    this.searchMap.update(m => ({ ...m, [columnName]: '' }));
    this.searchResults.set([]);
    this.activeColumn.set(null);
  }

  private async runOntologySearch(
    col: WizardCharacteristicColumnMeta,
    query: string
  ): Promise<void> {
    const q = query.trim();
    if (q.length < 2) {
      this.searchResults.set([]);
      return;
    }
    const key = getSpecialtyCharacteristicKey(col.name);
    try {
      let suggestions: OntologySuggestion[] = [];
      if (key === 'organism') {
        suggestions = await this.ols.searchOrganism(q);
      } else if (key === 'disease') {
        suggestions = await this.ols.searchDisease(q);
      } else if (key === 'organism part') {
        suggestions = await this.ols.searchTissue(q);
      } else if (col.ontologies?.length) {
        const response = await this.ols.search({
          query: q,
          ontology: col.ontologies,
          rows: 12,
        });
        suggestions = response.suggestions;
      }
      if (this.activeColumn() === col.name && this.searchQuery(col.name).trim() === q) {
        this.searchResults.set(suggestions.slice(0, 12).map(suggestionToTerm));
      }
    } catch {
      this.searchResults.set([]);
    }
  }
}
