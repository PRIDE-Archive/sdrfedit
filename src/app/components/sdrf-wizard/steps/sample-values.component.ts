import { resolveFactorValue } from '../../../core/models/wizard';
/**
 * Sample Values Component (Step 3)
 *
 * Single-candidate columns auto-fill; multi-candidate columns use dropdowns.
 * Top cards: sample naming + biological replicates.
 * Batch tools: round-robin, fill groups, set selected rows, paste mapping.
 */

import {
  Component,
  Input,
  inject,
  signal,
  computed,
  OnInit,
  HostListener,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { WizardStateService } from '../../../core/services/wizard-state.service';
import {
  WizardSampleEntry,
  WizardCharacteristicColumnMeta,
  WizardFactor,
  CharacteristicChoice,
  parseCharacteristicInnerName,
  shouldShowOnSampleValuesStep,
  createDefaultSample,
  normalizeFactor,
} from '../../../core/models/wizard';

type BioRepMode = 'sequential' | 'paired' | 'allOnes';

interface BatchColumnOption {
  key: string;
  label: string;
  kind: 'characteristic' | 'factor';
  values: string[];
}

const FACTOR_BATCH_PREFIX = 'factor:';

function isFactorBatchKey(key: string): boolean {
  return key.startsWith(FACTOR_BATCH_PREFIX);
}

function factorNameFromBatchKey(key: string): string {
  return key.slice(FACTOR_BATCH_PREFIX.length);
}

/** Split on commas, semicolons, tabs, and any whitespace (spaces / newlines). */
function parseDelimitedTokens(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map(t => t.trim())
    .filter(Boolean);
}

function parseBioRepNumbers(text: string): number[] {
  return parseDelimitedTokens(text)
    .map(t => Number(t))
    .filter(n => Number.isFinite(n) && n >= 1)
    .map(n => Math.floor(n));
}

@Component({
  selector: 'wizard-sample-values',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="step-container">
      <div class="step-header">
        <h3>Sample-Specific Values</h3>
        <p class="step-description">
          Set sample names and biological replicates, then assign multi-choice
          characteristics and study factor values for each sample.
        </p>
      </div>

      <section class="setup-panel">
        <div class="setup-row">
          <div class="setup-row-head">
            <h5>Sample names</h5>
            <span class="setup-hint">Separate with spaces, commas, or new lines</span>
          </div>
          <div class="quick-chips">
            <button type="button" class="chip-btn" (click)="applyNamePreset('sample_{n}')">sample_1, sample_2…</button>
            <button type="button" class="chip-btn" (click)="applyNamePreset('Sample{n}')">Sample1, Sample2…</button>
            <div class="pattern-inline">
              <input
                type="text"
                class="field-input pattern-mini"
                [ngModel]="namePattern()"
                (ngModelChange)="namePattern.set($event)"
                [placeholder]="'custom_' + '{' + 'n' + '}'"
                title="Use {n} for the sample number"
              />
              <button type="button" class="chip-btn" (click)="applyNamePreset(namePattern())">Apply pattern</button>
            </div>
          </div>
          <div class="setup-row-body">
            <textarea
              class="setup-textarea"
              rows="1"
              [ngModel]="customNamesText()"
              (ngModelChange)="customNamesText.set($event)"
              placeholder="sample_1 sample_2 sample_3  or  control, treated, control_rep2"
            ></textarea>
            <button
              type="button"
              class="card-btn primary compact"
              (click)="applyCustomNames()"
              [disabled]="parsedNames().length === 0"
            >
              Apply names
              @if (parsedNames().length > 0) {
                <span class="btn-meta">({{ parsedNames().length }})</span>
              }
            </button>
          </div>
        </div>

        <div class="setup-row">
          <div class="setup-row-head">
            <h5>Biological replicates</h5>
            <span class="setup-hint">Numbers only — spaces / commas / new lines</span>
          </div>
          <div class="quick-chips">
            <button type="button" class="chip-btn" (click)="applyBioRepPreset('sequential')">1, 2, 3…</button>
            <button type="button" class="chip-btn" (click)="applyBioRepPreset('paired')">1, 1, 2, 2…</button>
            <button type="button" class="chip-btn" (click)="applyBioRepPreset('allOnes')">1, 1, 1, 1…</button>
            <button type="button" class="chip-btn ghost" (click)="copyFirstToAll('biologicalReplicate')">Copy first → all</button>
          </div>
          <div class="setup-row-body">
            <textarea
              class="setup-textarea"
              rows="1"
              [ngModel]="customBioRepText()"
              (ngModelChange)="customBioRepText.set($event)"
              placeholder="1 1 2 2 3 3  or  1,2,1,2"
            ></textarea>
            <button
              type="button"
              class="card-btn primary compact"
              (click)="applyCustomBioReps()"
              [disabled]="parsedBioReps().length === 0"
            >
              Apply numbers
              @if (parsedBioReps().length > 0) {
                <span class="btn-meta">({{ parsedBioReps().length }})</span>
              }
            </button>
          </div>
        </div>
      </section>

      @if (batchColumns().length > 0) {
        <section class="batch-panel">
          <div class="batch-title-row">
            <h4>Match values to samples</h4>
            <p class="batch-lead">Pick a column, pick a value, then check which sample names should get that value.</p>
          </div>

          <div class="batch-tri">
            <div class="tri-col">
              <div class="tri-label">1. Column</div>
              <ul class="tri-list" role="listbox" aria-label="Columns with multiple values">
                @for (col of batchColumns(); track col.key) {
                  <li>
                    <button
                      type="button"
                      class="tri-item"
                      [class.active]="batchColumn() === col.key"
                      (click)="onBatchColumnChange(col.key)"
                      role="option"
                      [attr.aria-selected]="batchColumn() === col.key"
                    >
                      <span class="tri-item-name">{{ col.label }}</span>
                      <span class="tri-item-count">{{ col.values.length }}</span>
                    </button>
                  </li>
                }
              </ul>
            </div>

            <div class="tri-col">
              <div class="tri-label">2. Values</div>
              @if (!batchColumn()) {
                <p class="tri-empty">Pick a column on the left.</p>
              } @else if (batchChoiceValues().length === 0) {
                <p class="tri-empty">No values for this column.</p>
              } @else {
                <ul class="tri-list" role="listbox" aria-label="Candidate values">
                  @for (value of batchChoiceValues(); track value) {
                    <li>
                      <button
                        type="button"
                        class="tri-item value"
                        [class.active]="batchValue() === value"
                        (click)="selectBatchValue(value)"
                        role="option"
                        [attr.aria-selected]="batchValue() === value"
                      >
                        {{ value }}
                      </button>
                    </li>
                  }
                </ul>
              }
            </div>

            <div class="tri-col match">
              <div class="tri-label">3. Assign to samples</div>
              @if (!batchColumn()) {
                <p class="tri-empty">Select a column first.</p>
              } @else if (!batchValue()) {
                <p class="tri-empty">Pick a value in the middle.</p>
              } @else {
                <div class="match-value-bar">
                  <span class="match-value-tag">{{ batchValue() }}</span>
                  <span class="match-value-hint">→ choose sample names (click or drag)</span>
                </div>
                <div class="match-toolbar">
                  <button type="button" class="link-btn" (click)="selectAllSamples()">Select all</button>
                  <button type="button" class="link-btn" (click)="clearSampleSelection()">Clear</button>
                  <button type="button" class="link-btn" (click)="selectSamplesMissingValue()">Unassigned only</button>
                </div>
                <ul
                  class="sample-pick-list"
                  aria-label="Sample names"
                  [class.dragging]="sampleDragActive()"
                >
                  @for (sample of wizardState.samples(); track sample.index; let i = $index) {
                    <li>
                      <div
                        class="sample-pick"
                        [class.checked]="selectedIndices().has(i)"
                        (mousedown)="onSampleDragStart(i, $event)"
                        (mouseenter)="onSampleDragEnter(i)"
                      >
                        <input
                          type="checkbox"
                          tabindex="-1"
                          [checked]="selectedIndices().has(i)"
                          (click)="$event.preventDefault()"
                        />
                        <span class="sample-pick-name">{{ sample.sourceName || ('sample_' + sample.index) }}</span>
                        <span
                          class="sample-pick-current"
                          [class.same]="batchSampleValue(sample) === batchValue()"
                          [class.empty]="!batchSampleValue(sample)"
                        >
                          {{ batchSampleValue(sample) || '—' }}
                        </span>
                      </div>
                    </li>
                  }
                </ul>
                <button
                  type="button"
                  class="card-btn primary compact"
                  (click)="setSelected()"
                  [disabled]="selectedIndices().size === 0"
                >
                  {{ assignSamplesLabel() }}
                </button>
              }
            </div>
          </div>
        </section>
      }

      <div class="table-bar">
        <div class="summary inline">
          <div class="summary-item">
            <span class="summary-label">Samples:</span>
            <span class="summary-value">{{ wizardState.sampleCount() }}</span>
          </div>
          <div class="summary-item">
            <span class="summary-label">Unique bio. reps:</span>
            <span class="summary-value">{{ uniqueBioReplicates() }}</span>
          </div>
        </div>
        <button type="button" class="add-btn" (click)="addSample()">+ Add sample</button>
      </div>

      <div class="table-container">
        <table class="sample-table">
          <thead>
            <tr>
              <th class="col-check">
                <input
                  type="checkbox"
                  [checked]="allSelected()"
                  (change)="toggleSelectAll($event)"
                  title="Select all"
                />
              </th>
              <th class="col-index">#</th>
              <th class="col-name">Source Name <span class="required">*</span></th>
              <th class="col-biorep">Bio. Rep.</th>
              @for (col of displayColumns(); track col.name) {
                <th class="col-override" [title]="col.name">
                  {{ columnHeader(col) }}
                  @if (choiceCount(col.name) > 1) {
                    <span class="multi-tag">{{ choiceCount(col.name) }}</span>
                  }
                </th>
              }
              @for (factor of enabledFactors(); track factor.name) {
                <th class="col-override" [title]="'factor value[' + factor.name + ']'">
                  {{ factor.name }}
                  <span class="multi-tag factor">F</span>
                </th>
              }
              <th class="col-actions"></th>
            </tr>
          </thead>
          <tbody>
            @for (sample of wizardState.samples(); track sample.index; let i = $index) {
              <tr [class.row-selected]="selectedIndices().has(i)">
                <td class="col-check">
                  <input
                    type="checkbox"
                    [checked]="selectedIndices().has(i)"
                    (change)="toggleRow(i, $event)"
                  />
                </td>
                <td class="col-index">{{ sample.index }}</td>
                <td class="col-name">
                  <input
                    type="text"
                    class="cell-input"
                    [ngModel]="sample.sourceName"
                    (ngModelChange)="updateSample(i, 'sourceName', $event)"
                    placeholder="Enter name..."
                  />
                </td>
                <td class="col-biorep">
                  <input
                    type="number"
                    class="cell-input"
                    [ngModel]="sample.biologicalReplicate"
                    (ngModelChange)="updateSample(i, 'biologicalReplicate', +$event)"
                    min="1"
                  />
                </td>
                @for (col of displayColumns(); track col.name) {
                  <td class="col-override">
                    @if (choiceCount(col.name) <= 1) {
                      <span class="readonly-value">{{ sampleValue(sample, col.name) || '—' }}</span>
                    } @else {
                      <select
                        class="cell-select"
                        [ngModel]="sampleValue(sample, col.name)"
                        (ngModelChange)="setValue(i, col.name, $event)"
                        (focus)="onBatchColumnChange(col.name)"
                      >
                        <option value="">Select…</option>
                        @for (c of choices(col.name); track c.value) {
                          <option [value]="c.value">{{ c.value }}</option>
                        }
                      </select>
                    }
                  </td>
                }
                @for (factor of enabledFactors(); track factor.name) {
                  <td class="col-override">
                    @if (factor.sourceCharacteristic || factor.values.length <= 1) {
                      <span class="readonly-value">{{ factorSampleValue(sample, factor.name) || '—' }}</span>
                    } @else {
                      <select
                        class="cell-select"
                        [ngModel]="factorSampleValue(sample, factor.name)"
                        (ngModelChange)="setFactorValue(i, factor.name, $event)"
                        (focus)="onBatchColumnChange(FACTOR_BATCH_PREFIX + factor.name)"
                      >
                        <option value="">Select…</option>
                        @for (value of factor.values; track value) {
                          <option [value]="value">{{ value }}</option>
                        }
                      </select>
                    }
                  </td>
                }
                <td class="col-actions">
                  <button
                    type="button"
                    class="remove-btn"
                    (click)="removeSample(i)"
                    [disabled]="wizardState.samples().length <= 1"
                    title="Remove sample"
                  >&times;</button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      </div>

      @if (!wizardState.isStep3Valid()) {
        <div class="validation-message">
          <span class="warning-icon">!</span>
          All samples need a source name; multi-candidate required columns and
          study factor values must be set for every sample.
        </div>
      }
    </div>
  `,
  styles: [`
    .step-container { max-width: 1100px; }
    .step-header { margin-bottom: 16px; }
    .step-header h3 { margin: 0 0 6px; font-size: 18px; font-weight: 600; color: #111827; }
    .step-description { margin: 0; font-size: 14px; color: #6b7280; }

    .setup-panel {
      margin-bottom: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .setup-row {
      padding: 10px 12px;
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
    }
    .setup-row-head {
      display: flex;
      align-items: baseline;
      gap: 10px;
      margin-bottom: 6px;
      flex-wrap: wrap;
    }
    .setup-row-head h5 {
      margin: 0;
      font-size: 13px;
      font-weight: 650;
      color: #0f172a;
    }
    .setup-hint {
      font-size: 11px;
      color: #94a3b8;
    }
    .setup-row-body {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 10px;
      align-items: center;
    }
    @media (max-width: 640px) {
      .setup-row-body { grid-template-columns: 1fr; }
    }
    .setup-textarea {
      width: 100%;
      height: 36px;
      min-height: 36px;
      max-height: 36px;
      padding: 0 10px;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      font-size: 13px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      line-height: 34px;
      box-sizing: border-box;
      resize: none;
      overflow-x: auto;
      overflow-y: hidden;
      white-space: nowrap;
      background: #f8fafc;
    }
    .card-btn.compact {
      height: 36px;
      min-width: 140px;
      padding: 0 14px;
      font-size: 12px;
      width: auto;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      white-space: nowrap;
    }
    .btn-meta {
      font-weight: 500;
      opacity: 0.85;
    }
    .pattern-inline {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      margin-left: 2px;
    }
    .pattern-mini {
      width: 120px;
      padding: 4px 8px;
      font-size: 11px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .quick-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 6px;
    }
    .chip-btn {
      border: 1px solid #e2e8f0;
      background: #f8fafc;
      border-radius: 999px;
      padding: 4px 10px;
      font-size: 11px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #334155;
      cursor: pointer;
    }
    .chip-btn:hover { background: #e2e8f0; }
    .chip-btn.ghost {
      font-family: inherit;
      color: #0369a1;
      background: transparent;
      border-color: transparent;
    }
    .batch-card {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 14px;
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    .card-top {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .card-num {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: #0ea5e9;
      color: #fff;
      font-size: 12px;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .setup-card h5, .batch-card h5 {
      margin: 0;
      font-size: 13px;
      font-weight: 650;
      color: #0f172a;
    }
    .card-desc {
      margin: 0;
      font-size: 12px;
      line-height: 1.4;
      color: #64748b;
      flex: 1;
    }
    .card-desc code, .paste-help code {
      font-size: 11px;
      background: #e2e8f0;
      padding: 1px 5px;
      border-radius: 4px;
    }
    .field-label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      color: #64748b;
    }
    .field-input {
      width: 100%;
      padding: 8px 10px;
      border: 1px solid #cbd5e1;
      border-radius: 8px;
      font-size: 13px;
      box-sizing: border-box;
    }
    .card-example {
      margin: 0;
      padding: 6px 8px;
      border-radius: 6px;
      background: #f1f5f9;
      color: #334155;
      font-size: 11px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      line-height: 1.35;
      word-break: break-word;
    }
    .card-btn {
      width: 100%;
      border: 1px solid #cbd5e1;
      background: #f8fafc;
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 13px;
      font-weight: 600;
      color: #0f172a;
      cursor: pointer;
    }
    .setup-card .card-btn.primary,
    .batch-card .card-btn.primary { margin-top: auto; }
    .card-btn:hover:not(:disabled) { background: #e2e8f0; }
    .card-btn.primary {
      background: #0ea5e9;
      border-color: #0284c7;
      color: #fff;
    }
    .card-btn.primary:hover:not(:disabled) { background: #0284c7; }
    .card-btn.ghost {
      background: transparent;
      border-color: transparent;
      color: #0369a1;
      font-weight: 500;
      padding-top: 4px;
      padding-bottom: 4px;
    }
    .card-btn.ghost:hover:not(:disabled) { background: #e0f2fe; }
    .card-btn:disabled { opacity: 0.45; cursor: not-allowed; }

    .batch-panel {
      margin-bottom: 16px;
      padding: 12px 14px;
      border: 1px solid #dbeafe;
      border-radius: 12px;
      background: linear-gradient(180deg, #f8fbff 0%, #f1f5f9 100%);
    }
    .batch-title-row { margin-bottom: 10px; }
    .batch-title-row h4 {
      margin: 0 0 2px;
      font-size: 14px;
      font-weight: 650;
      color: #0f172a;
    }
    .batch-lead {
      margin: 0;
      font-size: 12px;
      line-height: 1.4;
      color: #64748b;
    }
    .batch-tri {
      display: grid;
      grid-template-columns: minmax(140px, 0.9fr) minmax(120px, 0.85fr) minmax(200px, 1.4fr);
      gap: 10px;
      align-items: stretch;
    }
    @media (max-width: 900px) {
      .batch-tri { grid-template-columns: 1fr; }
    }
    .tri-col {
      background: #fff;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 10px;
      min-height: 160px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .tri-label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #64748b;
    }
    .tri-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
      overflow: auto;
      max-height: 220px;
    }
    .tri-item {
      width: 100%;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      text-align: left;
      border: 1px solid transparent;
      background: #f8fafc;
      border-radius: 8px;
      padding: 8px 10px;
      font-size: 13px;
      color: #0f172a;
      cursor: pointer;
    }
    .tri-item.value { justify-content: flex-start; }
    .tri-item:hover { background: #f1f5f9; }
    .tri-item.active {
      background: #e0f2fe;
      border-color: #7dd3fc;
      color: #0369a1;
      font-weight: 600;
    }
    .tri-item-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tri-item-count {
      flex-shrink: 0;
      min-width: 20px;
      height: 20px;
      padding: 0 6px;
      border-radius: 999px;
      background: #e2e8f0;
      color: #475569;
      font-size: 11px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .tri-item.active .tri-item-count {
      background: #bae6fd;
      color: #0369a1;
    }
    .tri-empty {
      margin: 0;
      font-size: 12px;
      color: #94a3b8;
      padding: 8px 2px;
    }
    .match-value-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .match-value-tag {
      padding: 3px 10px;
      border-radius: 999px;
      background: #e0f2fe;
      color: #0369a1;
      font-size: 12px;
      font-weight: 650;
    }
    .match-value-hint {
      font-size: 11px;
      color: #94a3b8;
    }
    .match-toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .link-btn {
      border: none;
      background: transparent;
      color: #0369a1;
      font-size: 11px;
      font-weight: 600;
      padding: 0;
      cursor: pointer;
    }
    .link-btn:hover { text-decoration: underline; }
    .sample-pick-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
      overflow: auto;
      max-height: 200px;
      flex: 1;
      user-select: none;
    }
    .sample-pick-list.dragging {
      cursor: grabbing;
    }
    .sample-pick {
      display: grid;
      grid-template-columns: auto 1fr auto;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 8px;
      background: #f8fafc;
      border: 1px solid transparent;
      cursor: pointer;
      font-size: 12px;
    }
    .sample-pick input {
      pointer-events: none;
    }
    .sample-pick:hover { background: #f1f5f9; }
    .sample-pick.checked {
      background: #f0f9ff;
      border-color: #bae6fd;
    }
    .sample-pick-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #0f172a;
      font-weight: 500;
    }
    .sample-pick-current {
      font-size: 11px;
      color: #94a3b8;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      max-width: 72px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .sample-pick-current.same { color: #0369a1; font-weight: 600; }
    .sample-pick-current.empty { color: #cbd5e1; }
    .tri-col.match .card-btn.compact {
      margin-top: auto;
      width: 100%;
      min-width: 0;
    }

    .table-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 10px;
    }
    .summary.inline {
      display: flex;
      gap: 16px;
      margin: 0;
      font-size: 13px;
      color: #4b5563;
    }
    .summary-value { font-weight: 600; color: #111827; margin-left: 4px; }
    .add-btn {
      border: 1px solid #bfdbfe;
      background: #eff6ff;
      color: #1d4ed8;
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 13px;
      cursor: pointer;
    }

    .table-container { overflow: auto; border: 1px solid #e5e7eb; border-radius: 10px; }
    .sample-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { padding: 8px 10px; border-bottom: 1px solid #f3f4f6; text-align: left; white-space: nowrap; }
    th { background: #f9fafb; font-weight: 600; color: #374151; }
    .row-selected { background: #eff6ff; }
    .col-check { width: 32px; }
    .col-index { width: 36px; color: #9ca3af; }
    .col-name { min-width: 140px; }
    .col-biorep { width: 80px; }
    .col-override { min-width: 110px; max-width: 180px; }
    .cell-input, .cell-select {
      width: 100%; padding: 6px 8px; border: 1px solid #e5e7eb; border-radius: 6px; font-size: 13px; box-sizing: border-box;
    }
    .readonly-value { font-size: 13px; color: #4b5563; }
    .multi-tag {
      display: inline-block; margin-left: 4px; padding: 0 5px; border-radius: 999px;
      background: #dbeafe; color: #1d4ed8; font-size: 10px; font-weight: 600;
    }
    .multi-tag.factor { background: #fef3c7; color: #92400e; }
    .required { color: #ef4444; }
    .remove-btn {
      border: none; background: transparent; color: #9ca3af; font-size: 18px; cursor: pointer;
    }
    .remove-btn:disabled { opacity: 0.3; cursor: not-allowed; }
    .validation-message {
      display: flex; gap: 8px; align-items: center; margin-top: 14px; padding: 12px 14px;
      background: #fef3c7; border: 1px solid #fcd34d; border-radius: 8px; color: #92400e; font-size: 13px;
    }
    .warning-icon {
      width: 18px; height: 18px; border-radius: 50%; background: #f59e0b; color: #fff;
      display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700;
    }
  `],
})
export class SampleValuesComponent implements OnInit {
  @Input() aiEnabled = false;

  readonly FACTOR_BATCH_PREFIX = FACTOR_BATCH_PREFIX;

  readonly wizardState = inject(WizardStateService);
  readonly state = this.wizardState.state;
  readonly namePattern = signal('sample_{n}');
  readonly customNamesText = signal('');
  readonly customBioRepText = signal('');
  readonly batchColumn = signal('');
  readonly batchValue = signal('');
  readonly groupSize = signal(2);
  readonly pasteText = signal('');
  readonly selectedIndices = signal<Set<number>>(new Set());
  readonly sampleDragActive = signal(false);
  private sampleDragAnchor = 0;
  private sampleDragMode: 'add' | 'remove' = 'add';
  private sampleDragBase = new Set<number>();

  readonly parsedNames = computed(() => parseDelimitedTokens(this.customNamesText()));
  readonly parsedBioReps = computed(() => parseBioRepNumbers(this.customBioRepText()));

  readonly displayColumns = computed(() => {
    const choices = this.state().characteristicChoices || {};
    const columns = [...(this.state().characteristicColumns || [])];
    for (const factor of this.state().factors.filter(f => f.enabled && f.sourceCharacteristic)) {
      if (!columns.some(c => c.name === factor.sourceCharacteristic)) {
        columns.push({ name: factor.sourceCharacteristic!, description: 'Linked study factor source', requirement: 'optional' });
      }
    }
    return columns.filter(c =>
      shouldShowOnSampleValuesStep(c.name, (choices[c.name] || []).length) ||
      this.state().factors.some(f => f.enabled && f.sourceCharacteristic === c.name && (choices[c.name] || []).length > 1)
    );
  });

  readonly enabledFactors = computed((): WizardFactor[] =>
    (this.state().factors || []).map(normalizeFactor).filter(f => f.enabled && f.scope !== 'run' && f.name.trim())
  );

  readonly batchColumns = computed((): BatchColumnOption[] => {
    const cols: BatchColumnOption[] = this.displayColumns()
      .filter(c => this.choiceCount(c.name) >= 2)
      .map(c => ({
        key: c.name,
        label: this.columnHeader(c),
        kind: 'characteristic' as const,
        values: this.choices(c.name).map(choice => choice.value),
      }));
    for (const factor of this.enabledFactors()) {
      if (factor.sourceCharacteristic || factor.values.length < 2) continue;
      cols.push({
        key: FACTOR_BATCH_PREFIX + factor.name,
        label: `factor: ${factor.name}`,
        kind: 'factor',
        values: [...factor.values],
      });
    }
    return cols;
  });

  readonly batchChoiceValues = computed(() => {
    const key = this.batchColumn();
    return this.batchColumns().find(c => c.key === key)?.values || [];
  });

  ngOnInit(): void {
    this.wizardState.ensureSamplesInitialized();
    this.wizardState.ensureDefaultFactors();
    if (!(this.state().characteristicColumns || []).length) {
      void this.wizardState.refreshCharacteristicColumns();
    }
    this.wizardState.syncCharacteristicAssignments();
    this.wizardState.syncFactorAssignments();
    const multi = this.batchColumns();
    if (multi.length && !this.batchColumn()) {
      this.onBatchColumnChange(multi[0].key);
    }
  }

  choiceCount(columnName: string): number {
    return (this.state().characteristicChoices?.[columnName] || []).length;
  }

  choices(columnName: string): CharacteristicChoice[] {
    return this.state().characteristicChoices?.[columnName] || [];
  }

  columnHeader(col: WizardCharacteristicColumnMeta): string {
    return parseCharacteristicInnerName(col.name) || col.name;
  }

  sampleValue(sample: WizardSampleEntry, columnName: string): string {
    return sample.characteristicValues?.[columnName] || '';
  }

  factorSampleValue(sample: WizardSampleEntry, factorName: string): string {
    const factor = this.enabledFactors().find(f => f.name === factorName);
    return factor ? resolveFactorValue(this.state(), sample, factor) : '';
  }

  batchSampleValue(sample: WizardSampleEntry): string {
    const key = this.batchColumn();
    if (!key) return '';
    if (isFactorBatchKey(key)) return this.factorSampleValue(sample, factorNameFromBatchKey(key));
    return this.sampleValue(sample, key);
  }

  setValue(sampleIndex: number, columnName: string, value: string): void {
    this.wizardState.setSampleCharacteristicValue(sampleIndex, columnName, value);
  }

  setFactorValue(sampleIndex: number, factorName: string, value: string): void {
    this.wizardState.setSampleFactorValue(sampleIndex, factorName, value);
  }

  updateSample(index: number, field: keyof WizardSampleEntry, value: any): void {
    this.wizardState.updateSample(index, { [field]: value });
  }

  autoGenerateNames(): void {
    this.wizardState.autoGenerateSourceNames(this.namePattern());
  }

  /** Fill textarea + apply names from a {n} pattern for the current sample count. */
  applyNamePreset(pattern: string): void {
    const pat = (pattern || '').trim() || 'sample_{n}';
    this.namePattern.set(pat);
    const n = Math.max(1, this.wizardState.sampleCount());
    const names = Array.from({ length: n }, (_, i) =>
      pat.replace(/\{n\}/gi, String(i + 1))
    );
    this.customNamesText.set(names.join(' '));
    this.wizardState.autoGenerateSourceNames(pat);
  }

  applyCustomNames(): void {
    const names = this.parsedNames();
    if (names.length === 0) return;

    const samples = [...this.wizardState.samples()];
    while (samples.length < names.length) {
      samples.push(createDefaultSample(samples.length + 1));
    }
    const next = samples.map((s, i) =>
      i < names.length ? { ...s, sourceName: names[i], index: i + 1 } : { ...s, index: i + 1 }
    );
    this.wizardState.setSamples(next);
    this.wizardState.syncCharacteristicAssignments();
    this.wizardState.syncFactorAssignments();
  }

  applyCustomBioReps(): void {
    const nums = this.parsedBioReps();
    if (nums.length === 0) return;
    this.wizardState.setSamples(
      this.wizardState.samples().map((s, i) =>
        i < nums.length ? { ...s, biologicalReplicate: nums[i] } : s
      )
    );
  }

  applyBioRepPreset(mode: BioRepMode): void {
    if (mode === 'sequential') this.assignSequentialReplicates();
    else if (mode === 'paired') this.assignPairedReplicates();
    else this.assignAllOnesReplicates();
    const n = this.wizardState.samples().length;
    const values =
      mode === 'sequential'
        ? Array.from({ length: n }, (_, i) => i + 1)
        : mode === 'paired'
          ? Array.from({ length: n }, (_, i) => Math.floor(i / 2) + 1)
          : Array.from({ length: n }, () => 1);
    this.customBioRepText.set(values.join(' '));
  }

  copyFirstToAll(field: keyof WizardSampleEntry): void {
    this.wizardState.copyToAllSamples(field);
  }

  addSample(): void {
    this.wizardState.addSample();
    this.wizardState.syncCharacteristicAssignments();
  }

  removeSample(index: number): void {
    this.wizardState.removeSample(index);
    this.selectedIndices.update(set => {
      const next = new Set<number>();
      for (const i of set) {
        if (i < index) next.add(i);
        else if (i > index) next.add(i - 1);
      }
      return next;
    });
  }

  uniqueBioReplicates(): number {
    return new Set(this.wizardState.samples().map(s => s.biologicalReplicate)).size;
  }

  assignSequentialReplicates(): void {
    this.wizardState.setSamples(
      this.wizardState.samples().map((s, i) => ({ ...s, biologicalReplicate: i + 1 }))
    );
  }

  assignPairedReplicates(): void {
    this.wizardState.setSamples(
      this.wizardState.samples().map((s, i) => ({
        ...s,
        biologicalReplicate: Math.floor(i / 2) + 1,
      }))
    );
  }

  assignAllOnesReplicates(): void {
    this.wizardState.setSamples(
      this.wizardState.samples().map(s => ({ ...s, biologicalReplicate: 1 }))
    );
  }

  allSelected(): boolean {
    const n = this.wizardState.samples().length;
    return n > 0 && this.selectedIndices().size === n;
  }

  toggleSelectAll(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    if (!checked) {
      this.selectedIndices.set(new Set());
      return;
    }
    this.selectedIndices.set(
      new Set(this.wizardState.samples().map((_, i) => i))
    );
  }

  toggleRow(index: number, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.selectedIndices.update(set => {
      const next = new Set(set);
      if (checked) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  @HostListener('document:mouseup')
  onDocumentMouseUp(): void {
    this.endSampleDrag();
  }

  @HostListener('document:mouseleave')
  onDocumentMouseLeave(): void {
    this.endSampleDrag();
  }

  onSampleDragStart(index: number, event: MouseEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    this.sampleDragActive.set(true);
    this.sampleDragAnchor = index;
    this.sampleDragBase = new Set(this.selectedIndices());
    this.sampleDragMode = this.selectedIndices().has(index) ? 'remove' : 'add';
    this.applySampleDragRange(index);
  }

  onSampleDragEnter(index: number): void {
    if (!this.sampleDragActive()) return;
    this.applySampleDragRange(index);
  }

  private applySampleDragRange(toIndex: number): void {
    const lo = Math.min(this.sampleDragAnchor, toIndex);
    const hi = Math.max(this.sampleDragAnchor, toIndex);
    const next = new Set(this.sampleDragBase);
    for (let i = lo; i <= hi; i++) {
      if (this.sampleDragMode === 'add') next.add(i);
      else next.delete(i);
    }
    this.selectedIndices.set(next);
  }

  private endSampleDrag(): void {
    if (!this.sampleDragActive()) return;
    this.sampleDragActive.set(false);
  }

  onBatchColumnChange(columnName: string): void {
    this.batchColumn.set(columnName);
    const first = this.batchChoiceValues()[0] || '';
    this.selectBatchValue(first);
  }

  selectBatchValue(value: string): void {
    this.batchValue.set(value);
    this.syncSelectionToCurrentValue();
  }

  /** Pre-check samples that already have the selected value. */
  syncSelectionToCurrentValue(): void {
    const col = this.batchColumn();
    const value = this.batchValue();
    if (!col || !value) {
      this.selectedIndices.set(new Set());
      return;
    }
    const next = new Set<number>();
    this.wizardState.samples().forEach((sample, i) => {
      if (this.batchSampleValue(sample) === value) next.add(i);
    });
    this.selectedIndices.set(next);
  }

  selectAllSamples(): void {
    this.selectedIndices.set(
      new Set(this.wizardState.samples().map((_, i) => i))
    );
  }

  clearSampleSelection(): void {
    this.selectedIndices.set(new Set());
  }

  selectSamplesMissingValue(): void {
    const col = this.batchColumn();
    if (!col) return;
    const next = new Set<number>();
    this.wizardState.samples().forEach((sample, i) => {
      if (!this.batchSampleValue(sample)) next.add(i);
    });
    this.selectedIndices.set(next);
  }

  assignSamplesLabel(): string {
    const value = this.batchValue();
    const n = this.selectedIndices().size;
    if (!value) return 'Pick a value first';
    if (n === 0) return 'Select sample names above';
    return n === 1
      ? `Assign "${value}" to 1 sample`
      : `Assign "${value}" to ${n} samples`;
  }

  alternateExample(): string {
    const vals = this.batchChoiceValues();
    if (vals.length === 0) return '—';
    const n = Math.min(this.wizardState.samples().length || 4, 4);
    return Array.from({ length: n }, (_, i) => vals[i % vals.length]).join(' → ') +
      (this.wizardState.samples().length > 4 ? ' → …' : '');
  }

  groupExample(): string {
    const vals = this.batchChoiceValues();
    if (vals.length === 0) return '—';
    const g = Math.max(1, this.groupSize());
    const n = Math.min(this.wizardState.samples().length || g * 2, g * 2);
    const parts = Array.from({ length: n }, (_, i) => vals[Math.floor(i / g) % vals.length]);
    return parts.join(' → ') + (this.wizardState.samples().length > n ? ' → …' : '');
  }

  pastePlaceholder(): string {
    const vals = this.batchChoiceValues();
    const a = vals[0] || 'value_a';
    const b = vals[1] || 'value_b';
    return `${a}\n${b}\n${a}\n\n# or:\nsample_1\t${a}\nsample_2\t${b}`;
  }

  applyCheckedLabel(): string {
    return this.assignSamplesLabel();
  }

  roundRobin(): void {
    const col = this.batchColumn();
    if (!col || isFactorBatchKey(col)) return;
    this.wizardState.applyRoundRobin(col);
  }

  fillGroups(): void {
    const col = this.batchColumn();
    if (!col || isFactorBatchKey(col)) return;
    this.wizardState.applyFillGroups(col, this.groupSize());
  }

  setSelected(): void {
    const col = this.batchColumn();
    const value = this.batchValue();
    if (!col || !value) return;
    const indices = [...this.selectedIndices()];
    if (isFactorBatchKey(col)) {
      const name = factorNameFromBatchKey(col);
      for (const i of indices) this.wizardState.setSampleFactorValue(i, name, value);
      return;
    }
    this.wizardState.applyToSelectedRows(col, value, indices);
  }

  applyPaste(): void {
    const col = this.batchColumn();
    if (!col || isFactorBatchKey(col)) return;
    this.wizardState.applyPasteMapping(col, this.pasteText());
    this.pasteText.set('');
  }
}
