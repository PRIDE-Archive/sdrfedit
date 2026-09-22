/**
 * Study factors section (embedded in Sample Characteristics / Step 2).
 *
 * Define factor value[…] columns and their candidate values. Per-sample picks
 * happen on Step 3.
 */

import {
  Component,
  inject,
  computed,
  OnInit,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { WizardStateService } from '../../../core/services/wizard-state.service';
import { WizardFactor, factorCandidates, factorDefinitionErrors } from '../../../core/models/wizard';

@Component({
  selector: 'wizard-factor-values',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="factors-panel">
      <div class="step-header">
        <h3>Study factors (grouping)</h3>
        <p class="step-description">
          Select the variables this study actually compares. Disease is not selected automatically. Declare them as
          <code>factor value[...]</code> columns and add every candidate value.
          On the next step you will assign one value to each sample.
        </p>
      </div>

      <div class="info-banner">
        <span class="info-icon">i</span>
        <div class="info-content">
          <strong>Why factors?</strong>
          <p>
            Factors are how SDRF records study groups (control vs treated, disease
            vs normal, …). Add all group labels here — you can define more than one
            factor.
          </p>
        </div>
      </div>

      <div class="info-banner">
        <div>
          <label><input type="checkbox" [ngModel]="wizardState.getState().factorDecision === 'none'"
            (ngModelChange)="wizardState.setFactorDecision($event ? 'none' : 'pending', wizardState.getState().noFactorReason)" />
            Explicitly continue without study factors</label>
          @if (wizardState.getState().factorDecision === 'none') {
            <p>This disables existing factors. Record the reason; technical comparison metadata should still be preserved.</p>
            <input class="form-input" aria-label="Reason for no study factors"
              [ngModel]="wizardState.getState().noFactorReason"
              (ngModelChange)="wizardState.setFactorDecision('none', $event)"
              placeholder="Why no factor is being encoded in this SDRF" />
          } @else if (!wizardState.factors().length) {
            <p>Study comparison not yet confirmed. Add evidence-supported factors or explicitly record why none are needed.</p>
          }
        </div>
      </div>
      <div class="factors-list">
        @for (factor of wizardState.factors(); track $index; let i = $index) {
          <div class="factor-card" [class.disabled]="!factor.enabled">
            <div class="factor-top">
              <label class="enable-toggle" title="Include this factor">
                <input
                  type="checkbox"
                  [ngModel]="factor.enabled"
                  (ngModelChange)="wizardState.toggleFactor(i, $event)"
                />
              </label>

              <div class="name-field">
                <label>Factor name</label>
                <div class="name-input-row">
                  <span class="prefix">factor value[</span>
                  <input
                    type="text"
                    class="form-input"
                    [ngModel]="factor.name"
                    (ngModelChange)="onNameChange(i, $event)"
                    placeholder="compound"
                  />
                  <span class="suffix">]</span>
                </div>
              </div>

              <button
                type="button"
                class="btn-remove"
                (click)="wizardState.removeFactor(i)"

                title="Remove factor"
              >
                &times;
              </button>
            </div>

            <div class="values-block">
              <label>Assignment level</label>
              <select class="form-input" [ngModel]="factor.scope || 'sample'"
                (ngModelChange)="wizardState.updateFactor(i, { scope: $event, sourceCharacteristic: undefined })">
                <option value="sample">Biological sample — assign on Step 3</option>
                <option value="run">MS run / technical comparison — assign on Step 4</option>
              </select>
              @if (factor.scope === 'run') {
                <p>Use for studied technical differences such as acquisition strategy. All files in one run share its value; use separate runs for different strategies without duplicating biological samples. Verify the SDRF term used for the factor name.</p>
              }
              @if (factor.scope !== 'run') {
              <label>Value source</label>
              <select class="form-input" [ngModel]="factor.sourceCharacteristic || ''"
                (ngModelChange)="wizardState.updateFactor(i, { sourceCharacteristic: $event })">
                <option value="">Independent study groups</option>
                @for (source of characteristicSources(); track source) {
                  <option [value]="source">{{ source }}</option>
                }
              </select>
              @if (factor.sourceCharacteristic) {
                <p>Derived from each sample’s linked characteristic. Edit its candidates above and sample values on Step 3.</p>
                <p>{{ candidates(factor).join(', ') || 'No source values yet' }}</p>
              }
              }
              <label>Comparison evidence / rationale</label>
              <input class="form-input" type="text" [ngModel]="factor.reasoning || ''"
                (ngModelChange)="wizardState.updateFactor(i, { reasoning: $event })"
                placeholder="What does the study compare, and where is it described?" />
              @if (candidates(factor).length === 1) {
                <p class="validation-message">Only one candidate value: check whether this variable distinguishes the study groups.</p>
              }
              @if (!factor.sourceCharacteristic) {

              <label>Candidate values</label>
              <div class="choice-chips">
                @for (value of factor.values; track value) {
                  <span class="selected-chip">
                    {{ value }}
                    <button
                      type="button"
                      class="chip-clear"
                      (click)="wizardState.removeFactorValue(i, value)"
                      title="Remove"
                    >
                      ×
                    </button>
                  </span>
                } @empty {
                  <span class="empty-hint">No candidates yet — add every group label</span>
                }
              </div>
              <div class="add-row">
                <input
                  type="text"
                  class="form-input"
                  [ngModel]="draftValues()[i] || ''"
                  (ngModelChange)="setDraft(i, $event)"
                  (keydown.enter)="commitDraft(i); $event.preventDefault()"
                  placeholder="e.g. none, EGF, Nocodazole"
                />
                <button
                  type="button"
                  class="btn-add-value"
                  (click)="commitDraft(i)"
                  [disabled]="!(draftValues()[i] || '').trim()"
                >
                  Add
                </button>
              </div>
              }
            </div>
          </div>
        }
      </div>

      <button type="button" class="btn-add-factor" (click)="addCustomFactor()">
        + Add factor
      </button>

      @for (error of definitionErrors(); track $index) {
        <p class="validation-message">{{ error }}</p>
      }
      @if (!wizardState.isFactorsDefined()) {
        <div class="validation-message">
          <span class="warning-icon">!</span>
          Define at least one supported factor, or explicitly choose no study factors and record a reason.
        </div>
      }
    </div>
  `,
  styles: [`
    .factors-panel {
      margin-top: 28px;
      padding-top: 22px;
      border-top: 1px solid #e5e7eb;
    }

    .step-header { margin-bottom: 16px; }
    .step-header h3 {
      margin: 0 0 8px;
      font-size: 16px;
      font-weight: 600;
      color: #1f2937;
    }
    .step-description {
      margin: 0;
      color: #6b7280;
      font-size: 14px;
    }
    .step-description code {
      background: #f3f4f6;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 12px;
    }

    .info-banner {
      display: flex;
      gap: 12px;
      padding: 14px 16px;
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      border-radius: 10px;
      margin-bottom: 16px;
    }
    .info-icon {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: #3b82f6;
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 700;
      flex-shrink: 0;
    }
    .info-content strong { font-size: 13px; color: #1e40af; }
    .info-content p { margin: 4px 0 0; font-size: 13px; color: #1e3a8a; }

    .factors-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
      margin-bottom: 12px;
    }

    .factor-card {
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      background: white;
      padding: 14px 16px;
    }
    .factor-card.disabled { opacity: 0.55; background: #f9fafb; }

    .factor-top {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 12px;
    }
    .enable-toggle { padding-top: 26px; }
    .name-field { flex: 1; display: flex; flex-direction: column; gap: 6px; }
    .name-field label, .values-block label {
      font-size: 12px;
      font-weight: 600;
      color: #6b7280;
    }
    .name-input-row {
      display: flex;
      align-items: center;
      gap: 4px;
    }
    .prefix, .suffix {
      font-size: 12px;
      color: #9ca3af;
      font-family: ui-monospace, monospace;
      white-space: nowrap;
    }
    .form-input {
      width: 100%;
      padding: 8px 10px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      font-size: 14px;
      box-sizing: border-box;
    }
    .form-input:focus {
      outline: none;
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.15);
    }

    .btn-remove {
      margin-top: 22px;
      width: 32px;
      height: 32px;
      border: none;
      border-radius: 8px;
      background: #fee2e2;
      color: #b91c1c;
      font-size: 18px;
      cursor: pointer;
    }
    .btn-remove:disabled { opacity: 0.4; cursor: not-allowed; }

    .values-block { display: flex; flex-direction: column; gap: 8px; }
    .choice-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-height: 28px;
      align-items: center;
    }
    .selected-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 8px;
      border-radius: 999px;
      background: #dbeafe;
      color: #1e40af;
      font-size: 12px;
      font-weight: 600;
    }
    .chip-clear {
      border: none;
      background: transparent;
      cursor: pointer;
      color: #64748b;
      font-size: 14px;
      line-height: 1;
      padding: 0;
    }
    .empty-hint { font-size: 12px; color: #94a3b8; }

    .add-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
    }
    .btn-add-value {
      border: 1px solid #bfdbfe;
      background: #eff6ff;
      color: #1d4ed8;
      border-radius: 8px;
      padding: 0 14px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    .btn-add-value:disabled { opacity: 0.45; cursor: not-allowed; }

    .btn-add-factor {
      border: 1px dashed #93c5fd;
      background: #eff6ff;
      color: #1d4ed8;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      width: 100%;
    }
    .btn-add-factor:hover { background: #dbeafe; }

    .validation-message {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 14px;
      padding: 12px 14px;
      background: #fef3c7;
      color: #92400e;
      border-radius: 8px;
      font-size: 13px;
    }
    .warning-icon {
      width: 20px;
      height: 20px;
      border-radius: 50%;
      background: #f59e0b;
      color: white;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 12px;
    }
  `],
})
export class FactorValuesComponent implements OnInit {
  readonly wizardState = inject(WizardStateService);
  readonly characteristicSources = computed(() => Array.from(new Set([
    ...this.wizardState.getState().characteristicColumns.map(c => c.name),
    ...Object.keys(this.wizardState.getState().characteristicChoices),
    ...this.wizardState.factors().flatMap(f => f.sourceCharacteristic ? [f.sourceCharacteristic] : []),
  ])).filter(name => name.startsWith('characteristics[')));
  readonly definitionErrors = computed(() => factorDefinitionErrors(this.wizardState.getState()));
  candidates(factor: WizardFactor): string[] { return factorCandidates(this.wizardState.getState(), factor); }
  readonly draftValues = signal<Record<number, string>>({});

  ngOnInit(): void {
    this.wizardState.ensureDefaultFactors();
  }

  setDraft(index: number, value: string): void {
    this.draftValues.update(map => ({ ...map, [index]: value }));
  }

  commitDraft(index: number): void {
    const value = (this.draftValues()[index] || '').trim();
    if (!value) return;
    this.wizardState.addFactorValue(index, value);
    this.draftValues.update(map => ({ ...map, [index]: '' }));
  }

  onNameChange(index: number, name: string): void {
    this.wizardState.updateFactor(index, { name });
  }

  addCustomFactor(): void {
    this.wizardState.addFactor({
      name: '',
      enabled: true,
      values: [],
    } as WizardFactor);
  }
}
