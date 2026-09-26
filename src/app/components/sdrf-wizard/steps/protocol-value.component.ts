import { templateFieldError } from '../../../core/models/wizard';
import { PROTOCOL_COLUMNS } from '../../../core/utils/protocol-fields';
import type { ProtocolValue, WizardState } from '../../../core/models/wizard';
import { genericTemplateColumns, templateFieldValue, templateOptions } from '../../../core/utils/template-fields';
/**
 * Local candidate editor for an instrument/protocol field.
 *
 * Selections commit immediately; text values commit on Enter or blur.
 */


import {
  Component,
  Input,
  Output,
  EventEmitter,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { WizardStateService } from '../../../core/services/wizard-state.service';
import {
  OntologyTerm,
  WizardModification,
  WizardCleavageAgent,
  ModificationPosition,
  COMMON_MODIFICATIONS,
  COMMON_CLEAVAGE_AGENTS,
  MODIFICATION_POSITIONS,
  AMINO_ACIDS,
  collectUsedPlexKitIds,
  labelConfigDisplayName,
} from '../../../core/models/wizard';
import { olsService } from '../../../core/services/ols.service';
import { unimodService, UnimodEntry } from '../../../core/services/unimod.service';

@Component({
  selector: 'wizard-protocol-value',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="step-container">
      @if (searchError()) { <p class="help-text" role="alert">{{ searchError() }}</p> }
      @if (hasColumn('comment[instrument]')) {
      <section class="question-region" aria-labelledby="instrument-question">
        <header class="question-header">
          <span class="question-number" aria-hidden="true">1</span>
          <div class="question-heading">
            <h3 id="instrument-question">Which instrument was used?</h3>
            <p class="step-description">Select the instrument used for analysis.</p>
          </div>
        </header>
        <div class="question-body">
        <label class="form-label">
          Instrument
          @if (requiredColumn('comment[instrument]')) { <span class="required">*</span> }

        </label>

        <div class="autocomplete-container">
          <input
            type="text"
            class="form-input"
            [ngModel]="instrumentSearch()"
            (ngModelChange)="searchInstrument($event)"
            (keydown.enter)="commitOnEnter($event, 'instrument')"
            (focus)="showInstrumentResults.set(true)"
            placeholder="Search for instrument..."
          />
          @if (showInstrumentResults() && instrumentResults().length > 0) {
            <div class="autocomplete-dropdown">
              @for (result of instrumentResults(); track result.id) {
                <button
                  class="autocomplete-option"
                  (click)="selectInstrument(result)"
                >
                  <span class="option-label">{{ result.label }}</span>
                  <span class="option-id">{{ result.id }}</span>
                </button>
              }
            </div>
          }
        </div>

        @if (state().instrument) {
          <div class="selected-value">
            <span class="selected-label">{{ state().instrument!.label }}</span>
            <span class="selected-id">{{ state().instrument!.id }}</span>
            <button class="btn-clear" (click)="clearInstrument()">&times;</button>
          </div>
        }

        <div class="quick-select">
          <span class="quick-label">Common:</span>
          <button class="quick-btn" (click)="selectQuickInstrument('Q Exactive', 'MS:1001911')">Q Exactive</button>
          <button class="quick-btn" (click)="selectQuickInstrument('Orbitrap Fusion', 'MS:1002416')">Orbitrap Fusion</button>
          <button class="quick-btn" (click)="selectQuickInstrument('Orbitrap Exploris 480', 'MS:1003028')">Exploris 480</button>
          <button class="quick-btn" (click)="selectQuickInstrument('timsTOF Pro', 'MS:1003005')">timsTOF Pro</button>
        </div>
        </div>
      </section>
      }
      @if (hasColumn('comment[cleavage agent details]')) {
      <section class="question-region" aria-labelledby="cleavage-question">
        <header class="question-header">
          <span class="question-number" aria-hidden="true">2</span>
          <div class="question-heading">
            <h3 id="cleavage-question">Which cleavage agent was used?</h3>
            <p class="step-description">Specify the enzyme used for protein digestion.</p>
          </div>
        </header>
        <div class="question-body">
        <label class="form-label">
          Cleavage Agent / Enzyme
          @if (requiredColumn('comment[cleavage agent details]')) { <span class="required">*</span> }

        </label>

        <div class="enzyme-grid">
          @for (enzyme of cleavageAgents; track enzyme.msAccession) {
            <button
              class="enzyme-card"
              [class.selected]="state().cleavageAgent?.msAccession === enzyme.msAccession"
              (click)="selectCleavageAgent(enzyme)"
            >
              <div class="enzyme-name">{{ enzyme.name }}</div>
              <div class="enzyme-id">{{ enzyme.msAccession }}</div>
            </button>
          }
        </div>

        @if (state().cleavageAgent) {
          <div class="selected-value">
            <span class="selected-label">{{ state().cleavageAgent!.name }}</span>
            <span class="selected-id">{{ state().cleavageAgent!.msAccession }}</span>
          </div>
        }
        </div>
      </section>
      }
      @if (hasColumn('comment[precursor mass tolerance]') || hasColumn('comment[fragment mass tolerance]')) {
      <section class="question-region" aria-labelledby="tolerances-question">
        <header class="question-header">
          <span class="question-number" aria-hidden="true">3</span>
          <div class="question-heading">
            <h3 id="tolerances-question">What MS tolerances were used?</h3>
            <p class="step-description">Specify the precursor and fragment mass tolerances used for database searching.</p>
          </div>
        </header>
        <div class="question-body">
        <label class="form-label" for="protocol-tolerance">Database search mass tolerance</label>
        <input id="protocol-tolerance" class="form-input" type="text" placeholder="e.g. 10 ppm or 0.02 Da"
          [ngModel]="value" (ngModelChange)="setDraft($event, false)"
          (keydown.enter)="commitOnEnter($event, 'text')" (blur)="commitText()" />
        <p class="help-text">Enter a positive number with ppm, Da, or mmu, or not available if unknown.</p>
        </div>
      </section>
      }
      @if (hasColumn('comment[modification parameters]')) {
      <section class="question-region" aria-labelledby="modifications-question">
        <header class="question-header">
          <span class="question-number" aria-hidden="true">4</span>
          <div class="question-heading">
            <h3 id="modifications-question">Which post-translational modifications were considered?</h3>
            <p class="step-description">Search UNIMOD or select common modifications, then specify their targets and types.</p>
          </div>
        </header>
        <div class="question-body">
      @if (plexSuggestionLabel()) {
        <div class="plex-suggest">
          <div class="plex-suggest-text">
            Runs &amp; Files used <strong>{{ plexSuggestionLabel() }}</strong>.
            Add matching fixed mods on K and Any N-term?
          </div>
          <button type="button" class="btn-suggest" (click)="addSuggestedPlexModifications()">
            Add suggested mods
          </button>
        </div>
      }

        <!-- UNIMOD Search -->
        <div class="mod-search-section">
          <h4>Search UNIMOD</h4>
          <div class="autocomplete-container">
            <input
              type="text"
              class="form-input"
              [ngModel]="modSearch()"
              (ngModelChange)="searchModification($event)"
              (keydown.enter)="commitOnEnter($event, 'modification')"
              (focus)="showModResults.set(true)"
              placeholder="Search by name or accession (e.g., Oxidation, UNIMOD:35)..."
            />
            @if (showModResults() && modResults().length > 0) {
              <div class="autocomplete-dropdown mod-dropdown">
                @for (result of modResults(); track result.accession) {
                  <button
                    class="autocomplete-option mod-option"
                    (click)="selectUnimodEntry(result)"
                  >
                    <div class="mod-option-main">
                      <span class="option-label">{{ result.name }}</span>
                      <span class="option-id">{{ result.accession }}</span>
                    </div>
                    <div class="mod-option-details">
                      <span class="mod-mass">{{ result.deltaMonoMass >= 0 ? '+' : '' }}{{ result.deltaMonoMass.toFixed(4) }} Da</span>
                      <span class="mod-sites">{{ result.sites.join(', ') }}</span>
                    </div>
                  </button>
                }
              </div>
            }
          </div>
        </div>

        <!-- Quick Add Common Modifications -->
        <div class="mod-section">
          <h4>Common Modifications</h4>
          <p class="mod-description">Click to add with default settings</p>

          <div class="mod-subsection">
            <span class="mod-subsection-label">Fixed:</span>
            <div class="mod-grid">
              @for (mod of fixedMods; track mod.name + mod.targetAminoAcids) {
                <button
                  class="mod-btn"
                  [class.selected]="isModSelected(mod)"
                  (click)="toggleModification(mod)"
                >
                  {{ mod.name }} ({{ mod.targetAminoAcids }})
                </button>
              }
            </div>
          </div>

          <div class="mod-subsection">
            <span class="mod-subsection-label">Variable:</span>
            <div class="mod-grid">
              @for (mod of variableMods; track mod.name + mod.targetAminoAcids) {
                <button
                  class="mod-btn"
                  [class.selected]="isModSelected(mod)"
                  (click)="toggleModification(mod)"
                >
                  {{ mod.name }} ({{ mod.targetAminoAcids }})
                </button>
              }
            </div>
          </div>
        </div>

        <!-- Selected Modifications - Editable Table -->
        @if (state().modifications.length > 0) {
          <div class="selected-mods-table">
            <h4>Selected Modifications ({{ state().modifications.length }})</h4>
            <table class="mods-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Accession</th>
                  <th>Target</th>
                  <th>Position</th>
                  <th>Type</th>
                  <th class="col-actions"></th>
                </tr>
              </thead>
              <tbody>
                @for (mod of state().modifications; track $index; let i = $index) {
                  <tr>
                    <td class="mod-name-cell">{{ mod.name }}</td>
                    <td class="mod-accession-cell">
                      <a
                        [href]="'https://www.unimod.org/modifications_view.php?editid1=' + getUnimodId(mod.unimodAccession)"
                        target="_blank"
                        class="unimod-link"
                      >{{ mod.unimodAccession || '-' }}</a>
                    </td>
                    <td>
                      <select
                        class="cell-select"
                        [ngModel]="mod.targetAminoAcids"
                        (ngModelChange)="updateModification(i, 'targetAminoAcids', $event)"
                      >
                        <option value="N-term">N-term</option>
                        <option value="C-term">C-term</option>
                        @for (aa of aminoAcids; track aa) {
                          <option [value]="aa">{{ aa }}</option>
                        }
                        @for (combo of getTargetCombos(mod); track combo) {
                          <option [value]="combo">{{ combo }}</option>
                        }
                      </select>
                    </td>
                    <td>
                      <select
                        class="cell-select"
                        [ngModel]="mod.position"
                        (ngModelChange)="updateModification(i, 'position', $event)"
                      >
                        @for (pos of positions; track pos.value) {
                          <option [value]="pos.value">{{ pos.label }}</option>
                        }
                      </select>
                    </td>
                    <td>
                      <select
                        class="cell-select type-select"
                        [ngModel]="mod.type"
                        (ngModelChange)="updateModification(i, 'type', $event)"
                        [class.fixed]="mod.type === 'fixed'"
                        [class.variable]="mod.type === 'variable'"
                      >
                        <option value="fixed">Fixed</option>
                        <option value="variable">Variable</option>
                      </select>
                    </td>
                    <td class="col-actions">
                      <button class="remove-btn" (click)="removeModification(i)">&times;</button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }

        @if (state().modifications.length === 0) {
          <div class="mod-hint">
            No modifications selected. Consider adding Carbamidomethyl (C, fixed) for typical bottom-up workflows.
            <button type="button" class="hint-btn" (click)="addSuggestedCarbamidomethyl()">
              Add Carbamidomethyl
            </button>
          </div>
        }

        </div>
      </section>
      }
      @if (technologyColumn(); as column) {
      <section class="question-region" aria-labelledby="technology-question">
        <header class="question-header">
          <span class="question-number" aria-hidden="true">5</span>
          <div class="question-heading">
            <h3 id="technology-question">What technology was used?</h3>
            <p class="step-description">Specify the technology type required by the selected templates.</p>
          </div>
        </header>
        <div class="question-body">
          <ng-container *ngTemplateOutlet="templateField; context: { $implicit: column }"></ng-container>
        </div>
      </section>
      }
      @if (additionalColumns().length) {
      <section class="question-region" aria-labelledby="additional-question">
        <header class="question-header">
          <span class="question-number" aria-hidden="true">6</span>
          <div class="question-heading">
            <h3 id="additional-question">Are there additional protocol attributes?</h3>
            <p class="step-description">Complete any other protocol fields provided by your selected templates.</p>
          </div>
        </header>
        <div class="question-body">
          @for (column of additionalColumns(); track column.name) {
            <ng-container *ngTemplateOutlet="templateField; context: { $implicit: column }"></ng-container>
          } @empty {
            <p class="step-description">Your selected templates have no additional protocol attributes.</p>
          }
        </div>
      </section>

      }
      <ng-template #templateField let-column>
        <div class="form-section">
          <label class="form-label" [attr.for]="'template-' + column.name">
            {{ column.name }}
            @if (column.requirement === 'required') { <span class="required">*</span> }
          </label>
          <p class="help-text">{{ column.description }}</p>
          @if (options(column).length) {
            <select class="form-input" [id]="'template-' + column.name" [ngModel]="fieldValue(state(), column)"
              (ngModelChange)="setDraft($event)">
              <option value="">Select a value</option>
              @for (value of options(column); track value) { <option [value]="value">{{ value }}</option> }
              @if (column.allowNotAvailable) { <option value="not available">not available</option> }
              @if (column.allowNotApplicable) { <option value="not applicable">not applicable</option> }
            </select>
          } @else {
            <input class="form-input" [id]="'template-' + column.name" type="text"
              [ngModel]="fieldValue(state(), column)" (ngModelChange)="setDraft($event, false)"
              (keydown.enter)="commitOnEnter($event, 'text')" (blur)="commitText()" />
          }
          @if (fieldError(column, fieldValue(state(), column)); as message) { <p class="help-text">{{ message }}</p> }
          @for (rule of column.validators || []; track $index) {
            @if (rule.params.description) { <p class="help-text">{{ rule.params.description }}</p> }
          }
        </div>
      </ng-template>
    </div>
  `,
  styleUrls: ['./question-regions.css'],
  styles: [`
    .question-region { border: 0; box-shadow: none; margin: 0; overflow: visible; }
    .question-header { display: none; }
    .question-body { padding: 0; }

    .selected-mods-table {
      overflow-x: auto;
    }

    .step-container {
      width: 100%;
      min-width: 0;
    }

    .step-description {
      margin: 0;
      color: #6b7280;
      font-size: 14px;
    }

    .plex-suggest {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 16px;
      padding: 12px 14px;
      border-radius: 10px;
      border: 1px solid #bae6fd;
      background: #f0f9ff;
    }
    .plex-suggest-text { font-size: 13px; color: #0c4a6e; line-height: 1.4; }
    .btn-suggest {
      border: 1px solid #0284c7;
      background: #0ea5e9;
      color: #fff;
      border-radius: 8px;
      padding: 7px 12px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }

    .form-section {
      margin-bottom: 32px;
    }

    .form-label {
      display: block;
      font-size: 14px;
      font-weight: 500;
      color: #374151;
      margin-bottom: 12px;
    }

    .required {
      color: #ef4444;
      margin-left: 4px;
    }

    .help-text {
      display: block;
      font-size: 12px;
      font-weight: normal;
      color: #6b7280;
      margin-top: 4px;
    }

    .form-input {
      width: 100%;
      box-sizing: border-box;
      padding: 10px 12px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      font-size: 14px;
      transition: border-color 0.15s, box-shadow 0.15s;
    }

    .form-input:focus {
      outline: none;
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
    }

    .autocomplete-container {
      position: relative;
    }

    .autocomplete-dropdown {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      background: white;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.15);
      max-height: 200px;
      overflow-y: auto;
      z-index: 100;
      margin-top: 4px;
    }

    .autocomplete-option {
      display: flex;
      justify-content: space-between;
      align-items: center;
      width: 100%;
      padding: 10px 12px;
      border: none;
      background: none;
      text-align: left;
      cursor: pointer;
      transition: background 0.15s;
    }

    .autocomplete-option:hover {
      background: #f3f4f6;
    }

    .option-label {
      font-size: 14px;
      color: #1f2937;
    }

    .option-id {
      font-size: 12px;
      color: #6b7280;
    }

    .selected-value {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      padding: 8px 12px;
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      border-radius: 6px;
    }

    .selected-label {
      font-size: 14px;
      font-weight: 500;
      color: #1e40af;
    }

    .selected-id {
      font-size: 12px;
      color: #3b82f6;
    }

    .btn-clear {
      margin-left: auto;
      background: none;
      border: none;
      font-size: 18px;
      color: #6b7280;
      cursor: pointer;
      padding: 0 4px;
    }

    .btn-clear:hover {
      color: #ef4444;
    }

    .quick-select {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 12px;
      flex-wrap: wrap;
    }

    .quick-label {
      font-size: 12px;
      color: #6b7280;
    }

    .quick-btn {
      padding: 6px 12px;
      background: #f3f4f6;
      border: 1px solid #e5e7eb;
      border-radius: 4px;
      font-size: 12px;
      color: #374151;
      cursor: pointer;
      transition: all 0.15s;
    }

    .quick-btn:hover {
      background: #e5e7eb;
      border-color: #d1d5db;
    }

    .enzyme-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 8px;
    }

    .enzyme-card {
      padding: 12px;
      background: white;
      border: 2px solid #e5e7eb;
      border-radius: 8px;
      cursor: pointer;
      text-align: left;
      transition: all 0.15s;
    }

    .enzyme-card:hover {
      border-color: #d1d5db;
      background: #f9fafb;
    }

    .enzyme-card.selected {
      border-color: #3b82f6;
      background: #eff6ff;
    }

    .enzyme-name {
      font-size: 13px;
      font-weight: 600;
      color: #1f2937;
    }

    .enzyme-id {
      font-size: 11px;
      color: #6b7280;
      margin-top: 2px;
    }

    /* Modification Search */
    .mod-search-section {
      margin-bottom: 16px;
      padding: 16px;
      background: #eff6ff;
      border-radius: 8px;
      border: 1px solid #bfdbfe;
    }

    .mod-search-section h4 {
      margin: 0 0 12px 0;
      font-size: 13px;
      font-weight: 600;
      color: #1e40af;
    }

    .mod-dropdown {
      max-height: 280px;
    }

    .mod-option {
      flex-direction: column;
      align-items: flex-start !important;
      padding: 10px 12px;
    }

    .mod-option-main {
      display: flex;
      justify-content: space-between;
      width: 100%;
      align-items: center;
    }

    .mod-option-details {
      display: flex;
      gap: 12px;
      margin-top: 4px;
      font-size: 11px;
    }

    .mod-mass {
      color: #059669;
      font-weight: 500;
    }

    .mod-sites {
      color: #6b7280;
    }

    .mod-section {
      margin-top: 16px;
      padding: 16px;
      background: #f9fafb;
      border-radius: 8px;
    }

    .mod-section h4 {
      margin: 0 0 4px 0;
      font-size: 13px;
      font-weight: 600;
      color: #374151;
    }

    .mod-description {
      margin: 0 0 12px 0;
      font-size: 12px;
      color: #6b7280;
    }

    .mod-subsection {
      margin-bottom: 12px;
    }

    .mod-subsection:last-child {
      margin-bottom: 0;
    }

    .mod-subsection-label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      color: #6b7280;
      text-transform: uppercase;
      margin-bottom: 8px;
    }

    .mod-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .mod-btn {
      padding: 8px 12px;
      background: white;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      font-size: 12px;
      color: #374151;
      cursor: pointer;
      transition: all 0.15s;
    }

    .mod-btn:hover {
      background: #f3f4f6;
      border-color: #9ca3af;
    }

    .mod-btn.selected {
      background: #dbeafe;
      border-color: #3b82f6;
      color: #1e40af;
    }

    /* Selected Modifications Table */
    .selected-mods-table {
      margin-top: 20px;
    }

    .selected-mods-table h4 {
      margin: 0 0 12px 0;
      font-size: 14px;
      font-weight: 600;
      color: #374151;
    }

    .mods-table {
      width: 100%;
      border-collapse: collapse;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      overflow: hidden;
    }

    .mods-table th,
    .mods-table td {
      padding: 10px 12px;
      border-bottom: 1px solid #e5e7eb;
      text-align: left;
      font-size: 13px;
    }

    .mods-table th {
      background: #f9fafb;
      font-weight: 600;
      color: #6b7280;
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.05em;
    }

    .mods-table tbody tr:hover {
      background: #f9fafb;
    }

    .mod-name-cell {
      font-weight: 500;
      color: #1f2937;
    }

    .mod-accession-cell {
      font-family: monospace;
      font-size: 12px;
    }

    .unimod-link {
      color: #3b82f6;
      text-decoration: none;
    }

    .unimod-link:hover {
      text-decoration: underline;
    }

    .cell-select {
      padding: 6px 8px;
      border: 1px solid #d1d5db;
      border-radius: 4px;
      font-size: 12px;
      background: white;
      cursor: pointer;
      min-width: 80px;
    }

    .cell-select:focus {
      outline: none;
      border-color: #3b82f6;
    }

    .type-select.fixed {
      background: #fef3c7;
      border-color: #fcd34d;
    }

    .type-select.variable {
      background: #dbeafe;
      border-color: #93c5fd;
    }

    .col-actions {
      width: 40px;
      text-align: center;
    }

    .remove-btn {
      background: none;
      border: none;
      font-size: 18px;
      color: #9ca3af;
      cursor: pointer;
      padding: 4px;
    }

    .remove-btn:hover {
      color: #ef4444;
    }

    .validation-message {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      background: #fef3c7;
      border: 1px solid #fcd34d;
      border-radius: 8px;
      font-size: 13px;
      color: #92400e;
      margin-top: 24px;
    }

    .mod-hint {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
      margin-top: 12px;
      margin-bottom: 8px;
      padding: 12px 14px;
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      border-radius: 8px;
      font-size: 13px;
      color: #1e40af;
    }

    .hint-btn {
      border: 1px solid #93c5fd;
      background: white;
      color: #1d4ed8;
      border-radius: 6px;
      padding: 6px 10px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
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
      font-size: 12px;
      font-weight: bold;
    }

    @media (max-width: 600px) {
      .enzyme-grid {
        grid-template-columns: repeat(2, 1fr);
      }
    }
  `],
})
export class ProtocolValueComponent {
  readonly wizardState = inject(WizardStateService);
  private readonly ols = olsService;
  private readonly unimod = unimodService;

  @Input({ required: true }) columnName = '';
  @Input() value: ProtocolValue = '';
  @Output() valueChange = new EventEmitter<ProtocolValue>();
  @Output() valueCommit = new EventEmitter<void>();
  readonly searchError = signal('');
  private textDirty = false;
  state(): WizardState {
    const state = this.wizardState.state();
    const key = (Object.keys(PROTOCOL_COLUMNS) as Array<keyof typeof PROTOCOL_COLUMNS>).find(key => PROTOCOL_COLUMNS[key] === this.columnName);
    return key ? { ...state, [key]: this.value || (key === 'modifications' ? [] : null) } as WizardState
      : { ...state, dynamicTemplateValues: { ...state.dynamicTemplateValues, [this.columnName]: String(this.value) } };
  }
  setDraft(value: ProtocolValue, commit = true): void {
    this.value = value;
    this.textDirty = !commit;
    this.valueChange.emit(value);
    if (commit) this.valueCommit.emit();
  }
  commitOnEnter(event: Event, kind: 'instrument' | 'modification' | 'text'): void {
    if ((event as KeyboardEvent).isComposing) return;
    event.preventDefault();
    if (kind === 'instrument') void this.confirmInstrument();
    else if (kind === 'modification') void this.confirmModification();
    else this.commitText();
  }
  commitText(): void {
    if (!this.textDirty) return;
    this.textDirty = false;
    this.valueCommit.emit();
  }
  async confirmInstrument(): Promise<void> {
    const query = this.instrumentSearch().trim();
    if (!query) return;
    await this.searchInstrument(query);
    if (this.instrumentSearch() !== query) return;
    const results = this.instrumentResults();
    const term = results.find(result => result.label.toLowerCase() === query.toLowerCase() || result.id.toLowerCase() === query.toLowerCase()) ?? results[0];
    if (term) this.selectInstrument(term);
    else this.searchError.set('No matching instrument found. Try another name or select a common instrument.');
  }
  async confirmModification(): Promise<void> {
    const query = this.modSearch().trim();
    if (!query) return;
    await this.searchModification(query);
    if (this.modSearch() !== query) return;
    const results = this.modResults();
    const entry = results.find(result => result.name.toLowerCase() === query.toLowerCase() || result.accession.toLowerCase() === query.toLowerCase()) ?? results[0];
    if (entry) this.selectUnimodEntry(entry);
    else this.searchError.set('No matching modification found. Try another name or UNIMOD accession.');
  }
  addModification(mod: WizardModification): void { this.setDraft([...this.state().modifications, mod]); }
  setModifications(mods: WizardModification[]): void { this.setDraft(mods); }

  readonly genericColumns = computed(() => genericTemplateColumns(this.state()));
  readonly technologyColumn = computed(() => this.genericColumns().find(column => column.name === 'technology type' && this.columnName === column.name));
  readonly additionalColumns = computed(() => this.genericColumns().filter(column => column.name !== 'technology type' && this.columnName === column.name));
  readonly options = templateOptions;
  readonly fieldValue = templateFieldValue;
  readonly fieldError = templateFieldError;
  hasColumn(name: string): boolean { return this.columnName === name; }
  requiredColumn(name: string): boolean { return !!this.state().effectiveColumns?.some(c => c.name === name && c.requirement === 'required'); }

  readonly plexSuggestionLabel = computed(() => {
    const kits = collectUsedPlexKitIds(this.state()).filter(id => ['tmt6', 'tmt10', 'tmt11', 'tmt16', 'tmt18', 'itraq4', 'itraq8'].includes(id));
    if (kits.length === 0) return null;
    const labels = kits.map(id => {
      if (id.startsWith('tmt16') || id.startsWith('tmt18') || id === 'tmt11' || id === 'tmt10') {
        return 'TMTpro';
      }
      if (id.startsWith('tmt')) return 'TMT6plex';
      if (id.startsWith('itraq4')) return 'iTRAQ4plex';
      if (id.startsWith('itraq')) return 'iTRAQ8plex';
      return labelConfigDisplayName(id);
    });
    return [...new Set(labels)].join(' + ');
  });

  readonly cleavageAgents = COMMON_CLEAVAGE_AGENTS;
  readonly positions = MODIFICATION_POSITIONS;
  readonly aminoAcids = AMINO_ACIDS;

  readonly fixedMods = COMMON_MODIFICATIONS.filter(m => m.type === 'fixed');
  readonly variableMods = COMMON_MODIFICATIONS.filter(m => m.type === 'variable');

  // Instrument search
  readonly instrumentSearch = signal('');
  readonly instrumentResults = signal<OntologyTerm[]>([]);
  readonly showInstrumentResults = signal(false);

  // Modification search
  readonly modSearch = signal('');
  readonly modResults = signal<UnimodEntry[]>([]);
  readonly showModResults = signal(false);

  async searchInstrument(query: string): Promise<void> {
    this.searchError.set('');
    this.instrumentSearch.set(query);
    if (query.length < 2) {
      this.instrumentResults.set([]);
      return;
    }

    try {
      const results = await this.ols.searchInstrument(query);
      if (this.instrumentSearch() !== query) return;
      this.instrumentResults.set(results.map(r => ({
        id: r.id,
        label: r.label,
        ontology: r.ontologyPrefix?.toUpperCase() || 'MS',
      })));
      this.showInstrumentResults.set(true);
    } catch {
      this.instrumentResults.set([]);
    }
  }

  selectInstrument(term: OntologyTerm): void {
    this.setDraft(term);
    this.instrumentSearch.set('');
    this.instrumentResults.set([]);
    this.showInstrumentResults.set(false);
  }

  selectQuickInstrument(label: string, id: string): void {
    this.selectInstrument({ id, label, ontology: 'MS' });
  }

  clearInstrument(): void {
    this.setDraft('');
  }

  selectCleavageAgent(agent: WizardCleavageAgent): void {
    this.setDraft(agent);
  }

  // === Modification Search ===

  async searchModification(query: string): Promise<void> {
    this.searchError.set('');
    this.modSearch.set(query);
    if (query.length < 2) {
      this.modResults.set([]);
      return;
    }

    try {
      const results = await this.unimod.searchModifications(query, 10);
      if (this.modSearch() !== query) return;
      this.modResults.set(results);
      this.showModResults.set(true);
    } catch {
      this.modResults.set([]);
    }
  }

  selectUnimodEntry(entry: UnimodEntry): void {
    // Create a modification from the UNIMOD entry with default settings
    const defaultSite = entry.sites[0] || 'Anywhere';
    const defaultPosition = this.inferPosition(entry);

    const mod: WizardModification = {
      name: entry.name,
      targetAminoAcids: defaultSite === 'N-term' || defaultSite === 'C-term' ? defaultSite : defaultSite,
      type: 'variable',
      position: defaultPosition,
      unimodAccession: entry.accession,
      deltaMass: entry.deltaMonoMass,
    };

    this.addModification(mod);
    this.modSearch.set('');
    this.modResults.set([]);
    this.showModResults.set(false);
  }

  addSuggestedCarbamidomethyl(): void {
    const carbamidomethyl = COMMON_MODIFICATIONS.find(
      m => m.name === 'Carbamidomethyl' && m.targetAminoAcids === 'C'
    );
    if (carbamidomethyl && !this.isModSelected(carbamidomethyl)) {
      this.addModification({ ...carbamidomethyl });
    }
  }

  addSuggestedPlexModifications(): void {
    const state = this.state();
    const kitIds = collectUsedPlexKitIds(state);
    const suggested: WizardModification[] = [];
    const seenFamilies = new Set<string>();

    for (const id of kitIds) {
      if (['tmt32', 'tmt34', 'tmt35'].includes(id)) continue; // Channel-specific isotope modifications require evidence.
      let family = '';
      let mods: WizardModification[] = [];
      if (id.startsWith('tmt16') || id.startsWith('tmt18') || id === 'tmt11' || id === 'tmt10') {
        family = 'TMTpro';
        mods = [
          {
            name: 'TMTpro',
            targetAminoAcids: 'K',
            type: 'fixed',
            position: 'Anywhere',
            unimodAccession: 'UNIMOD:2016',
            deltaMass: 304.207146,
          },
          {
            name: 'TMTpro',
            targetAminoAcids: 'N-term',
            type: 'fixed',
            position: 'Any N-term',
            unimodAccession: 'UNIMOD:2016',
            deltaMass: 304.207146,
          },
        ];
      } else if (id.startsWith('tmt')) {
        family = 'TMT6plex';
        mods = [
          {
            name: 'TMT6plex',
            targetAminoAcids: 'K',
            type: 'fixed',
            position: 'Anywhere',
            unimodAccession: 'UNIMOD:737',
            deltaMass: 229.162932,
          },
          {
            name: 'TMT6plex',
            targetAminoAcids: 'N-term',
            type: 'fixed',
            position: 'Any N-term',
            unimodAccession: 'UNIMOD:737',
            deltaMass: 229.162932,
          },
        ];
      } else if (id.startsWith('itraq4')) {
        family = 'iTRAQ4plex';
        mods = [
          {
            name: 'iTRAQ4plex',
            targetAminoAcids: 'K',
            type: 'fixed',
            position: 'Anywhere',
            unimodAccession: 'UNIMOD:214',
            deltaMass: 144.102063,
          },
          {
            name: 'iTRAQ4plex',
            targetAminoAcids: 'N-term',
            type: 'fixed',
            position: 'Any N-term',
            unimodAccession: 'UNIMOD:214',
            deltaMass: 144.102063,
          },
        ];
      } else if (id.startsWith('itraq')) {
        family = 'iTRAQ8plex';
        mods = [
          {
            name: 'iTRAQ8plex',
            targetAminoAcids: 'K',
            type: 'fixed',
            position: 'Anywhere',
            unimodAccession: 'UNIMOD:730',
            deltaMass: 304.20536,
          },
          {
            name: 'iTRAQ8plex',
            targetAminoAcids: 'N-term',
            type: 'fixed',
            position: 'Any N-term',
            unimodAccession: 'UNIMOD:730',
            deltaMass: 304.20536,
          },
        ];
      }
      if (!family || seenFamilies.has(family)) continue;
      seenFamilies.add(family);
      suggested.push(...mods);
    }

    const existing = this.state().modifications;
    this.setDraft([...existing, ...suggested.filter(mod => !existing.some(e => e.name === mod.name && e.targetAminoAcids === mod.targetAminoAcids && e.position === mod.position))]);
  }

  private inferPosition(entry: UnimodEntry): ModificationPosition {
    const positions = entry.positions || [];
    if (positions.includes('Protein N-term')) return 'Protein N-term';
    if (positions.includes('Any N-term')) return 'Any N-term';
    if (positions.includes('Protein C-term')) return 'Protein C-term';
    if (positions.includes('Any C-term')) return 'Any C-term';
    return 'Anywhere';
  }

  isModSelected(mod: WizardModification): boolean {
    return this.state().modifications.some(
      m => m.name === mod.name && m.targetAminoAcids === mod.targetAminoAcids
    );
  }

  toggleModification(mod: WizardModification): void {
    if (this.isModSelected(mod)) {
      const index = this.state().modifications.findIndex(
        m => m.name === mod.name && m.targetAminoAcids === mod.targetAminoAcids
      );
      if (index >= 0) {
        this.removeModification(index);
      }
    } else {
      this.addModification(mod);
    }
  }

  updateModification(index: number, field: keyof WizardModification, value: any): void {
    const mods = [...this.state().modifications];
    if (index >= 0 && index < mods.length) {
      mods[index] = { ...mods[index], [field]: value };
      this.setDraft(mods);
    }
  }

  removeModification(index: number): void {
    this.setDraft(this.state().modifications.filter((_, i) => i !== index));
  }

  getUnimodId(accession: string | undefined): string {
    if (!accession) return '';
    return accession.replace('UNIMOD:', '');
  }

  getTargetCombos(mod: WizardModification): string[] {
    // Return common multi-target combinations based on the modification
    const combos: string[] = [];
    if (mod.name === 'Phospho') combos.push('S,T,Y');
    if (mod.name === 'Deamidated') combos.push('N,Q');
    if (mod.name === 'Oxidation') combos.push('M,W');
    if (mod.targetAminoAcids && mod.targetAminoAcids.includes(',')) {
      combos.push(mod.targetAminoAcids);
    }
    return [...new Set(combos)];
  }
}
