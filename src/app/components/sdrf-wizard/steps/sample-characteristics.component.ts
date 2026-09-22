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
import { FactorValuesComponent } from './factor-values.component';

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
  imports: [CommonModule, FormsModule, FactorValuesComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="step-container">
      <div class="step-header">
        <h3>Sample Characteristics</h3>
        <p class="step-description">
          Add one or more values for each characteristics column, then define study
          factors and their group labels. A single characteristic value is applied to
          all samples; multiple values become dropdown choices on the next step.
        </p>
      </div>

      @if (loading()) {
        <div class="status">Loading template characteristics…</div>
      } @else if (loadError()) {
        <div class="status error">{{ loadError() }}</div>
      }

      <div class="info-banner">
        <span class="info-icon">i</span>
        <div class="info-content">
          <strong>Multi-value candidates</strong>
          <p>
            Use quick chips or search to build a candidate list. Required columns need at least
            one value to continue.
          </p>
        </div>
      </div>

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

      <wizard-factor-values />

      @if (!wizardState.isStep2Valid()) {
        <div class="validation-message">
          <span class="warning-icon">!</span>
          <div>
            Add at least one candidate for each required characteristic, and define
            supported study factors, or explicitly record why no study factors are being encoded.
          </div>
        </div>
      }
    </div>

    <ng-template #fieldTpl let-col let-required="required">
      <div class="form-section" [attr.data-column]="col.name">
        <label class="form-label">
          {{ columnTitle(col) }}
          @if (required) { <span class="req">*</span> }
          <span class="help-text">{{ col.description || hintFor(col) }}</span>
        </label>

        @if (quickPicks(col).length) {
          <div class="quick-row">
            @for (pick of quickPicks(col); track pick) {
              <button
                type="button"
                class="quick-btn"
                [class.active]="hasChoice(col.name, pick)"
                (click)="toggleQuickPick(col.name, pick)"
              >{{ pick }}</button>
            }
          </div>
        }

        <div class="autocomplete-container">
          <input
            type="text"
            class="form-input"
            [ngModel]="searchQuery(col.name)"
            (ngModelChange)="onSearch(col, $event)"
            (keydown.enter)="addFreeText(col); $event.preventDefault()"
            (focus)="activeColumn.set(col.name)"
            [placeholder]="searchPlaceholder(col)"
          />
          <button type="button" class="add-btn" (click)="addFreeText(col)" title="Add value">+</button>
          @if (activeColumn() === col.name && searchResults().length > 0) {
            <div class="autocomplete-dropdown">
              @for (result of searchResults(); track result.id) {
                <button type="button" class="autocomplete-option" (click)="selectOntology(col.name, result)">
                  <span class="option-label">{{ result.label }}</span>
                  <span class="option-id">{{ result.id }}</span>
                </button>
              }
            </div>
          }
        </div>

        <div class="choice-chips">
          @for (choice of choices(col.name); track choice.value) {
            <span class="selected-chip">
              {{ choice.value }}
              <button
                type="button"
                class="chip-clear"
                (click)="wizardState.removeCharacteristicChoice(col.name, choice.value)"
              >×</button>
            </span>
          } @empty {
            <span class="empty-hint">No candidates yet</span>
          }
        </div>
      </div>
    </ng-template>
  `,
  styles: [`
    .step-container { max-width: 720px; }
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
export class SampleCharacteristicsComponent implements OnInit {
  @Input() aiEnabled = false;

  readonly wizardState = inject(WizardStateService);
  private readonly ols = olsService;
  readonly state = this.wizardState.state;

  readonly loading = signal(false);
  readonly loadError = signal<string | null>(null);
  readonly showRecommended = signal(false);

  readonly activeColumn = signal<string | null>(null);
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

  toggleQuickPick(columnName: string, value: string): void {
    if (this.hasChoice(columnName, value)) {
      this.wizardState.removeCharacteristicChoice(columnName, value);
    } else {
      this.wizardState.addCharacteristicChoice(columnName, value);
    }
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
    this.wizardState.addCharacteristicChoice(col.name, value);
    this.searchMap.update(m => ({ ...m, [col.name]: '' }));
    this.searchResults.set([]);
  }

  selectOntology(columnName: string, term: OntologyTerm): void {
    const key = getSpecialtyCharacteristicKey(columnName);
    const value =
      key === 'organism' ? term.label : term.label.toLowerCase();
    this.wizardState.addCharacteristicChoice(columnName, value, term);
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
      if (this.activeColumn() === col.name) {
        this.searchResults.set(suggestions.slice(0, 12).map(suggestionToTerm));
      }
    } catch {
      this.searchResults.set([]);
    }
  }
}
