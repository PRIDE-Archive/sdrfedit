import { validateSampleListEdit, previewRegexRename } from '../../../core/utils/sample-list-edit';
import { resolveFactorValue } from '../../../core/models/wizard';
/**
 * Samples & Groups Component (Step 2)
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

import { SampleCharacteristicsComponent } from './sample-characteristics.component';
import { FactorValuesComponent } from './factor-values.component';
import { sampleCompletionErrors } from '../../../core/models/wizard';

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
  imports: [CommonModule, FormsModule, SampleCharacteristicsComponent, FactorValuesComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="step-container">
      <section class="question-region" aria-labelledby="sample-names-question">
        <header class="question-header">
          <span class="question-number" aria-hidden="true">1</span>
          <div class="question-heading">
            <h3 id="sample-names-question">What are your sample names and biological replicates?</h3>
            <p class="step-description">Review sample names and biological replicate numbers below. Use Batch rename and Set replicates to update selected samples; sample count is set in Experiment Setup.</p>
          </div>
          <span class="question-badge">Required</span>
        </header>
        <div class="question-body">
          <div class="naming-toolbar">
            <div><strong>{{ wizardState.samples().length }} samples</strong><p class="naming-muted">{{ namingSelection().size ? namingSelection().size + ' selected' : 'All samples' }}</p></div>
            <div class="naming-actions">
              @if (canUndoRename()) { <button type="button" class="naming-button" (click)="undoRename()">Undo rename</button> }
              <button type="button" class="naming-button" [attr.aria-expanded]="namingEditor() === 'names'" (click)="openNamingEditor('names')">Batch rename</button>
              <button type="button" class="naming-button" [attr.aria-expanded]="namingEditor() === 'replicates'" (click)="openNamingEditor('replicates')">Set replicates</button>
            </div>
          </div>
          @if (namingEditor()) {
            <section class="naming-panel" aria-label="Batch edit samples">
              <div class="naming-toolbar"><strong>{{ namingEditor() === 'names' ? 'Batch rename' : 'Set biological replicates' }}</strong><button type="button" class="naming-button" aria-label="Close batch editor" (click)="namingEditor.set(null)">×</button></div>
              <div class="naming-actions naming-modes">
                <button type="button" class="naming-button" [attr.aria-pressed]="namingMode() === 'generate'" (click)="namingMode.set('generate')">{{ namingEditor() === 'names' ? 'Find & replace' : 'Use a rule' }}</button>
                <button type="button" class="naming-button" [attr.aria-pressed]="namingMode() === 'paste'" (click)="namingMode.set('paste')">Paste a list</button>
              </div>
              @if (namingMode() === 'paste') {
                <label class="naming-label">Values in sample order<textarea class="naming-input" rows="4" [ngModel]="namingPaste()" (ngModelChange)="namingPaste.set($event)" placeholder="One value per line, or separate with commas"></textarea></label>
              } @else if (namingEditor() === 'names') {
                <div class="regex-fields">
                  <label class="naming-label">Find · regular expression<input class="naming-input" [ngModel]="renamePattern()" (ngModelChange)="renamePattern.set($event)" spellcheck="false" /></label>
                  <label class="naming-label">Replace with<input class="naming-input" [ngModel]="renameReplacement()" (ngModelChange)="renameReplacement.set($event)" spellcheck="false" /></label>
                </div>
                <label class="naming-label"><input type="checkbox" [ngModel]="renameIgnoreCase()" (ngModelChange)="renameIgnoreCase.set($event)" /> Ignore case</label>
                <p class="naming-muted">$1, $2… reuse captured groups. Unmatched names stay unchanged.</p>
                <details><summary>Examples</summary><div class="naming-actions"><button type="button" class="naming-button" (click)="renamePattern.set('^sample_'); renameReplacement.set('patient_')">Replace prefix</button><button type="button" class="naming-button" (click)="renamePattern.set('$'); renameReplacement.set('_baseline')">Append suffix</button></div></details>
              } @else {
                <label class="naming-label">Numbering rule<select class="naming-input" [ngModel]="namingRule()" (ngModelChange)="namingRule.set($event)"><option value="sequential">Sequential: 1, 2, 3, 4…</option><option value="paired">Repeat each number twice: 1, 1, 2, 2…</option><option value="same">Same number for all selected samples</option></select></label>
                @if (namingRule() === 'same') { <label class="naming-label">Replicate number<input class="naming-input" type="number" min="1" [ngModel]="namingReplicate()" (ngModelChange)="namingReplicate.set(+$event)" /></label> }
              }
              @if (namingEditor() === 'names') {
                <table class="sample-table rename-preview" aria-label="Rename preview"><thead><tr><th>Current name</th><th>New name</th></tr></thead><tbody>@for (index of namingTargets().slice(0, 4); track index; let i = $index) { <tr><td>{{ state().samples[index].sourceName }}</td><td>{{ namingValues()[i] || '—' }}</td></tr> }</tbody></table>
                <p class="naming-muted" aria-live="polite">{{ renameChangedCount() }} names will change · previewing first {{ namingTargets().slice(0, 4).length }}</p>
              } @else {
                <div class="naming-preview">Preview: {{ namingValues().slice(0, 6).join(', ') }}{{ namingValues().length > 6 ? '…' : '' }}</div>
              }
              @if (namingError()) { <p class="naming-error" role="alert">{{ namingError() }}</p> }
              <div class="naming-toolbar naming-panel-footer"><p class="naming-muted">{{ namingSelection().size ? 'Only selected rows will change.' : 'All sample rows will change.' }}</p><div class="naming-actions"><button type="button" class="naming-button" (click)="namingEditor.set(null)">Cancel</button><button type="button" class="naming-button naming-primary" [disabled]="!!namingError()" (click)="applyNamingChanges()">Apply to {{ namingTargets().length }} samples</button></div></div>
            </section>
          }
          <div class="table-container naming-table-container">
            <table class="sample-table naming-table" aria-label="Sample names and biological replicates">
              <thead><tr><th class="naming-check"><input type="checkbox" aria-label="Select all samples for batch editing" [checked]="namingSelection().size === wizardState.samples().length" [indeterminate]="namingSelection().size > 0 && namingSelection().size < wizardState.samples().length" (change)="selectNamingSamples($any($event.target).checked)" /></th><th class="naming-index">#</th><th>Sample name</th><th class="naming-replicate">Bio. replicate</th></tr></thead>
              <tbody>@for (sample of namingRows(); track sample.index; let row = $index) {
                <tr [class.row-selected]="namingSelection().has(namingCurrentPage() * 6 + row)">
                  <td><input type="checkbox" [attr.aria-label]="'Select ' + sample.sourceName" [checked]="namingSelection().has(namingCurrentPage() * 6 + row)" (change)="toggleNamingSample(namingCurrentPage() * 6 + row)" /></td><td>{{ namingCurrentPage() * 6 + row + 1 }}</td>
                  <td>{{ sample.sourceName }}</td>
                  <td>{{ sample.biologicalReplicate }}</td>
                </tr>
              }</tbody>
            </table>
          </div>
          <div class="naming-toolbar naming-pagination"><div class="naming-actions"><span class="naming-muted">{{ namingCurrentPage() * 6 + 1 }}–{{ namingCurrentPage() * 6 + namingRows().length }} of {{ wizardState.samples().length }}</span><button type="button" class="naming-button" aria-label="Previous samples" [disabled]="namingCurrentPage() === 0" (click)="namingPage.set(namingCurrentPage() - 1)">←</button><button type="button" class="naming-button" aria-label="Next samples" [disabled]="(namingCurrentPage() + 1) * 6 >= wizardState.samples().length" (click)="namingPage.set(namingCurrentPage() + 1)">→</button></div></div>
          <p class="naming-muted" role="status">{{ namingStatus() }}</p>

        </div>
      </section>

      <section class="question-region" aria-labelledby="sample-attributes-question">
        <header class="question-header">
          <span class="question-number" aria-hidden="true">2</span>
          <div class="question-heading">
            <h3 id="sample-attributes-question">What describes your samples?</h3>
            <p class="step-description">Add the values present in your study, then select samples and assign their values. Use All to assign one value to every sample.</p>
          </div>
          <span class="question-badge">Required</span>
        </header>
        <div class="question-body">
          <div #attributesEditor tabindex="-1" class="attributes-editor">
            <p class="section-status">{{ attributeSummary() }}</p>
            <wizard-sample-characteristics [aiEnabled]="aiEnabled" [embedded]="true" />
          </div>
        </div>
      </section>

      <section class="question-region" aria-labelledby="sample-groups-question">
        <header class="question-header">
          <span class="question-number" aria-hidden="true">3</span>
          <div class="question-heading">
            <h3 id="sample-groups-question">Which attributes are your study factors?</h3>
            <p class="step-description">Select the variables you study. Reuse sample attributes or add a custom factor.</p>
          </div>
          <span class="question-badge">Required</span>
        </header>
        <div class="question-body">
          <wizard-factor-values [embedded]="true" />
        </div>
      </section>

      <section class="question-region" aria-labelledby="sample-table-question">
        <header class="question-header">
          <span class="question-number" aria-hidden="true">4</span>
          <div class="question-heading">
            <h3 id="sample-table-question">Review sample metadata</h3>
            <p class="step-description">Review sample names, biological replicates, attributes, and factor values. Complete any missing metadata before continuing.</p>
          </div>
          <span class="question-badge">Required</span>
        </header>
        <div class="question-body">
      @if (batchColumns().length > 0) {
        <details class="sample-editor">
          <summary>Batch fill sample values <span>Assign one value to several samples</span></summary>
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
        </details>
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

      <p class="step-description table-help">Names and replicates come from the sample list above. Assign attributes and groups below.</p>
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
                  <span>{{ sample.sourceName }}</span>
                </td>
                <td class="col-biorep"><span>{{ sample.biologicalReplicate }}</span></td>
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

      <div class="completion-status" role="status" aria-live="polite">
        <strong>{{ completedSamples() }} / {{ wizardState.samples().length }} samples complete</strong>
        @if (completionErrors().length) {
          <ul>@for (error of completionErrors().slice(0, 4); track $index) { <li>{{ error }}</li> }</ul>
          @if (completionErrors().length > 4) { <p>And {{ completionErrors().length - 4 }} more items to complete.</p> }
        } @else { <p>Ready to link your samples to raw files.</p> }
      </div>

        </div>
      </section>

    </div>
  `,
  styleUrls: ['./question-regions.css'],
  styles: [`
    :host { display: block; width: 100%; min-width: 0; }
    .step-container { width: 100%; min-width: 0; }
    .naming-toolbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
    .naming-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .naming-muted { margin: 0; font-size: 12px; color: #64748b; }
    .naming-button { padding: 8px 12px; border: 1px solid #dce4ef; border-radius: 7px; background: #fff; color: #334155; font: inherit; font-size: 12px; cursor: pointer; }
    .naming-button[aria-pressed="true"], .naming-button[aria-expanded="true"] { color: #2563eb; border-color: #2563eb; background: #eff6ff; }
    .naming-button.naming-primary { background: #2563eb; border-color: #2563eb; color: #fff; }
    .naming-button:disabled { opacity: .45; cursor: not-allowed; }
    .naming-panel { background: #f4f7fb; border: 1px solid #dce4ef; border-radius: 10px; padding: 18px; margin-bottom: 16px; }
    .naming-modes { margin-bottom: 16px; }
    .regex-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
    .rename-preview { table-layout: fixed; margin: 14px 0; }
    .rename-preview td { white-space: normal; overflow-wrap: anywhere; }
    @media (max-width: 600px) { .regex-fields { grid-template-columns: 1fr; } }
    .naming-fields { display: grid; grid-template-columns: 2fr 1fr 1fr; gap: 12px; }
    .naming-label { display: block; font-size: 12px; color: #64748b; }
    .naming-input { box-sizing: border-box; width: 100%; min-width: 0; border: 1px solid #dce4ef; border-radius: 6px; background: #fff; color: #243247; padding: 8px; margin-top: 5px; font: inherit; font-size: 14px; }
    textarea.naming-input { resize: vertical; }
    .naming-preview { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 12px 0; color: #64748b; font-size: 12px; }
    .naming-preview-value { padding: 3px 7px; background: #fff; border-radius: 5px; color: #334155; overflow-wrap: anywhere; max-width: 100%; }
    .naming-error { color: #b42318; font-size: 12px; margin: 0 0 12px; }
    .naming-panel-footer { margin-bottom: 0; }
    .naming-delete { color: #b42318; }
    .naming-delete-column { width: 44px; }
    .naming-remove { width: 28px; height: 28px; border: 0; border-radius: 6px; background: transparent; color: #64748b; font-size: 20px; cursor: pointer; }
    .naming-remove:hover:not(:disabled) { background: #fef2f2; color: #b42318; }
    .naming-remove:disabled { opacity: .35; cursor: not-allowed; }
    .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .naming-pagination { margin-top: 16px; justify-content: flex-end; }
    .naming-table { table-layout: fixed; }
    .naming-table th, .naming-table td { white-space: normal; }
    .naming-check { width: 32px; } .naming-index { width: 36px; } .naming-replicate { width: 125px; }
    .naming-table .cell-input { border-color: transparent; background: transparent; }
    .naming-table .cell-input:hover, .naming-table .cell-input:focus { border-color: #cbd5e1; background: #fff; }
    @media (max-width: 600px) { .naming-fields { grid-template-columns: 1fr 1fr; } .naming-fields > :first-child { grid-column: 1 / -1; } .naming-replicate { width: 96px; } .naming-input { font-size: 16px; } }
    .section-status { margin: 0 0 14px; color: #64748b; font-size: 12px; }
    .attributes-editor:focus-visible { outline: 2px solid #2563eb; outline-offset: 4px; }
    .sample-editor { border: 1px solid #e2e8f0; border-radius: 10px; padding: 12px; margin-bottom: 16px; background: #f8fafc; }
    .sample-editor summary { cursor: pointer; color: #334155; font-weight: 600; font-size: 13px; }
    .sample-editor summary span { display: block; margin-top: 4px; color: #64748b; font-size: 12px; font-weight: 400; }
    .sample-editor[open] summary { margin-bottom: 16px; }
    .table-help { margin-bottom: 10px !important; }
    .column-edit { display: block; border: 0; background: none; color: #2563eb; cursor: pointer; padding: 4px 0; font-size: 11px; }
    .completion-status { background: #f8fafc; border-radius: 8px; padding: 12px 16px; color: #334155; font-size: 13px; margin-top: 16px; }
    .completion-status p { margin: 6px 0 0; }
    .completion-status ul { padding-left: 20px; margin-bottom: 0; }

    .step-header { margin-bottom: 16px; }
    .step-header h3 { margin: 0 0 6px; font-size: 18px; font-weight: 600; color: #111827; }
    .step-description { margin: 0; color: #64748b; font-size: 13px; line-height: 1.7; }

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
  readonly namingEditor = signal<'names' | 'replicates' | null>(null);
  readonly namingMode = signal<'generate' | 'paste'>('generate');
  readonly namingSelection = signal<Set<number>>(new Set());
  readonly namingPage = signal(0);
  readonly renameUndo = signal<{ names: string[]; after: string } | null>(null);
  readonly canUndoRename = computed(() => !!this.renameUndo() && this.renameUndo()!.after === JSON.stringify(this.state().samples.map(sample => [sample.index, sample.sourceName])));
  undoRename(): void {
    if (!this.canUndoRename()) return;
    this.renameUndo()!.names.forEach((sourceName, index) => this.wizardState.updateSample(index, { sourceName }));
    this.renameUndo.set(null); this.namingStatus.set('Rename undone.');
  }
  readonly renamePattern = signal('^sample_(\\d+)$');
  readonly renameReplacement = signal('patient_$1');
  readonly renameIgnoreCase = signal(false);
  readonly renamePreview = computed(() => {
    try { return { values: previewRegexRename(this.namingTargets().map(i => this.state().samples[i].sourceName), this.renamePattern(), this.renameReplacement(), this.renameIgnoreCase()), error: '' }; }
    catch (error) { return { values: [] as string[], error: error instanceof Error ? error.message : 'Invalid regular expression.' }; }
  });
  readonly renameChangedCount = computed(() => this.namingTargets().filter((index, i) => this.namingValues()[i] !== undefined && this.state().samples[index].sourceName !== this.namingValues()[i]).length);
  readonly namingPrefix = signal('sample_');
  readonly namingStart = signal(1);
  readonly namingDigits = signal(1);
  readonly namingPaste = signal('');
  readonly namingRule = signal('sequential');
  readonly namingReplicate = signal(1);
  readonly namingStatus = signal('Select rows to limit batch changes · Sample count is set in Experiment Setup');
  readonly namingCurrentPage = computed(() => Math.min(this.namingPage(), Math.max(0, Math.ceil(this.state().samples.length / 6) - 1)));
  readonly namingRows = computed(() => this.state().samples.slice(this.namingCurrentPage() * 6, this.namingCurrentPage() * 6 + 6));
  readonly namingTargets = computed(() => this.state().samples.map((_, i) => i).filter(i => !this.namingSelection().size || this.namingSelection().has(i)));
  readonly namingValues = computed((): (string | number)[] => {
    if (this.namingMode() === 'paste') return parseDelimitedTokens(this.namingPaste()).map(value => this.namingEditor() === 'names' ? value : Number(value));
    if (this.namingEditor() === 'names') return this.renamePreview().values;
    return this.namingTargets().map((_, i) => this.namingRule() === 'paired' ? Math.floor(i / 2) + 1 : this.namingRule() === 'same' ? this.namingReplicate() : i + 1);
  });
  readonly namingError = computed(() => {
    if (this.namingEditor() === 'names' && this.namingMode() === 'generate' && this.renamePreview().error) return this.renamePreview().error;
    if (this.namingEditor() === 'names' && !this.renameChangedCount()) return 'No names will change. Adjust the rule or select different samples.';
    return validateSampleListEdit(this.state().samples, this.namingTargets(), this.namingValues(), this.namingEditor() === 'names' ? 'sourceName' : 'biologicalReplicate');
  });

  openNamingEditor(editor: 'names' | 'replicates'): void {
    this.namingEditor.set(this.namingEditor() === editor ? null : editor);
    this.namingMode.set('generate');
    this.namingPaste.set('');
  }
  selectNamingSamples(all: boolean): void { this.namingSelection.set(new Set(all ? this.state().samples.map((_, i) => i) : [])); }
  toggleNamingSample(index: number): void {
    this.namingSelection.update(selection => { const next = new Set(selection); next.has(index) ? next.delete(index) : next.add(index); return next; });
  }
  applyNamingChanges(): void {
    if (!this.namingEditor() || this.namingError()) return;
    const targets = this.namingTargets(), values = this.namingValues();
    const field = this.namingEditor() === 'names' ? 'sourceName' : 'biologicalReplicate';
    const oldNames = this.state().samples.map(sample => sample.sourceName);
    targets.forEach((index, i) => this.wizardState.updateSample(index, { [field]: values[i] }));
    if (field === 'sourceName') this.renameUndo.set({ names: oldNames, after: JSON.stringify(this.state().samples.map(sample => [sample.index, sample.sourceName])) });
    this.namingStatus.set(`Updated ${targets.length} samples.`);
    this.namingEditor.set(null);
  }


  readonly namePattern = signal('sample_{n}');
  readonly customNamesText = signal('');
  readonly customBioRepText = signal('');
  readonly completionErrors = computed(() => sampleCompletionErrors(this.state()));
  readonly completedSamples = computed(() => this.state().samples.filter(sample =>
    sampleCompletionErrors({ ...this.state(), samples: [sample] }, false).length === 0).length);
  readonly attributeSummary = computed(() => {
    const columns = this.state().characteristicColumns.filter(c => c.requirement === 'required'
      && c.name !== 'characteristics[biological replicate]' && c.name !== 'characteristics[material type]');
    const filled = columns.filter(c => this.choiceCount(c.name) > 0).length;
    return `${filled} / ${columns.length} required attributes filled`;
  });
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
      (c.requirement === 'required' && c.name !== 'characteristics[biological replicate]' && c.name !== 'characteristics[material type]') ||
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
    if (this.state().samples.length <= 1 || index < 0 || index >= this.state().samples.length) return;
    const name = this.state().samples[index].sourceName;
    this.wizardState.removeSample(index);
    this.namingEditor.set(null);
    this.namingPage.set(this.namingCurrentPage());
    this.namingStatus.set(`Deleted ${name}.`);
    this.namingSelection.update(selection => new Set([...selection].filter(i => i !== index).map(i => i > index ? i - 1 : i)));
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
