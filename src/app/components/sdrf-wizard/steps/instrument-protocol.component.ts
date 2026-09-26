import { Component, Input, ElementRef, viewChild, inject, signal, computed, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { WizardStateService } from '../../../core/services/wizard-state.service';
import type { ProtocolChoice, ProtocolValue } from '../../../core/models/wizard';
import type { TemplateColumn } from '../../../core/models/template';
import { ProtocolValueComponent } from './protocol-value.component';
import { PROTOCOL_COLUMNS, protocolColumns, protocolField, protocolChoiceForFile, protocolValueLabel, protocolValueError,
  protocolFieldError, addProtocolChoice, assignProtocolChoice, removeProtocolChoice } from '../../../core/utils/protocol-fields';

@Component({
  selector: 'wizard-instrument-protocol',
  standalone: true,
  imports: [CommonModule, FormsModule, ProtocolValueComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="question-region" aria-labelledby="protocol-question">
      <header class="question-header">
        <span class="question-number" aria-hidden="true">1</span>
        <div class="question-heading">
          <h3 id="protocol-question">What instrument and parameters were used?</h3>
          <p class="step-description">Add the values present in your study, then select raw files and assign their values. The first value applies to all files. Use All to apply a value to every file.</p>
        </div>
        <span class="question-badge">Required</span>
      </header>
      <div class="question-body">
        <p class="section-status" aria-live="polite">{{ completionSummary() }}</p>
        @for (group of groups; track group.key) {
          @if (columnsFor(group.key).length) {
            <section class="column-section">
              @if (group.key === 'required') {
                <h4 class="section-title"><span class="badge required">Required</span><span class="count">{{ columnsFor(group.key).length }}</span></h4>
              } @else {
                <button type="button" class="section-toggle" [attr.aria-expanded]="expandedGroups().has(group.key)" (click)="toggleGroup(group.key)">
                  <span class="badge" [class.recommended]="group.key === 'recommended'" [class.optional]="group.key === 'optional'">{{ group.label }}</span>
                  <span class="count">{{ columnsFor(group.key).length }}</span><span class="chevron">{{ expandedGroups().has(group.key) ? '−' : '+' }}</span>
                </button>
              }
              @if (group.key === 'required' || expandedGroups().has(group.key)) {
                @for (column of columnsFor(group.key); track column.name) {
                  <section class="attribute-row" [attr.data-column]="column.name">
                    <button type="button" class="attribute-summary" [attr.aria-expanded]="editingColumn() === column.name" (click)="openEditor(column.name)">
                      <strong>{{ title(column) }} @if (column.requirement === 'required') { <span class="req">*</span> }</strong>
                      <span class="attribute-value">{{ summaryValues(column.name) }}<small [class.incomplete]="!!fieldError(column)">{{ assignmentSummary(column.name) }}</small></span>
                      <span class="edit-label">{{ editingColumn() === column.name ? 'Close' : field(column.name).choices.length ? 'Edit' : 'Set value' }}</span>
                    </button>
                    @if (editingColumn() === column.name) {
                      <div class="attribute-editor">
                        <p class="help-text">{{ column.description || 'Add the values used in your study and assign each value to raw files.' }}</p>
                        @if (column.name === modificationColumn) {
                          <p class="help-text">Each value is a complete modification set. Add all modifications used together to the same set.</p>
                        }
                        @for (choice of field(column.name).choices; track choice.id) {
                          <div class="assignment-value-row">
                            <div class="assignment-value-label"><strong>{{ valueLabel(choice.value) }}</strong>
                              @if (ontologyId(choice.value)) { <span class="ontology-id">{{ ontologyId(choice.value) }}</span> }
                              <small>{{ countAssignments(column.name, choice.id) }} raw files assigned</small>
                            </div>
                            <div class="value-actions">
                              <button type="button" class="editor-button" (click)="assignAll(column.name, choice.id)">All</button>
                              <button type="button" class="editor-button" (click)="openFilePicker(column.name, choice)">Select files</button>
                              <button type="button" class="editor-button remove" [attr.aria-label]="'Remove ' + valueLabel(choice.value)" (click)="removeValue(column.name, choice.id)">×</button>
                            </div>
                          </div>
                        }
                        @if (valueEditorOpen()) {
                          <div class="candidate-editor">
                            <h4>{{ column.name === modificationColumn ? 'Add a modification set' : 'Add a value' }}</h4>
                            <wizard-protocol-value [columnName]="column.name" [value]="draftValue()" (valueChange)="updateDraft($event)" (valueCommit)="saveValue(column)" />
                            @if (draftError()) { <p class="error" role="alert">{{ draftError() }}</p> }
                            @if (column.name === modificationColumn && activeSetId()) {
                              <p class="help-text" role="status">Changes saved automatically to this modification set.</p>
                              <button type="button" class="editor-button" (click)="addValue(column.name)">+ Add another modification set</button>
                            }
                          </div>
                        } @else {
                          <button type="button" class="editor-button add-value" (click)="addValue(column.name)">+ {{ column.name === modificationColumn ? 'Add modification set' : 'Add value' }}</button>
                        }
                        <div class="editor-footer"><span class="help-text" aria-live="polite">{{ assignmentSummary(column.name) }}. Assignments saved automatically.</span></div>
                        @if (fieldError(column)) { <p class="error" role="status">{{ fieldError(column) }}</p> }
                      </div>
                    }
                  </section>
                }
              }
            </section>
          }
        }
        @if (!wizardState.isStep5Valid()) {
          <p class="validation-message" role="status">Complete required values and assign every raw file for each field you use.</p>
        }
      </div>
    </section>

    <dialog #filePicker class="file-picker" aria-labelledby="file-picker-title" (cancel)="closeFilePicker()">
      <div class="picker-heading"><div><h3 id="file-picker-title">Select raw files</h3><p>{{ pickerValueLabel() }}</p></div>
        <button type="button" class="editor-button" aria-label="Close file selection" (click)="closeFilePicker()">×</button>
      </div>
      <div class="picker-controls">
        <label class="visually-hidden" for="protocol-file-search">Search raw files</label>
        <input id="protocol-file-search" class="form-input" type="search" placeholder="Search raw file names…" [ngModel]="fileSearch()" (ngModelChange)="fileSearch.set($event)" />
        <div class="mode-buttons">
          <button type="button" class="editor-button" (click)="selectFiles('all')">{{ fileSearch() ? 'Select matches' : 'Select all' }}</button>
          <button type="button" class="editor-button" (click)="selectFiles('missing')">Unassigned</button>
          <button type="button" class="editor-button" (click)="selectFiles('none')">Clear</button>
          <span class="selection-count" aria-live="polite">{{ selectedFiles().size }} selected</span>
        </div>
        <p class="help-text">Selecting a file replaces its current value for this field only.</p>
      </div>
      <div class="file-tile-grid" role="group" aria-label="Raw files">
        @for (fileName of filteredFiles(); track fileName) {
          <button type="button" class="editor-button file-tile" [attr.aria-pressed]="selectedFiles().has(fileName)" (click)="toggleFile(fileName)">
            <span>{{ fileName }}</span><small>{{ selectedFiles().has(fileName) ? '✓ Selected' : fileAssignmentLabel(fileName) }}</small>
          </button>
        } @empty { <p class="help-text">No matching raw files.</p> }
      </div>
      <div class="picker-actions editor-footer"><button type="button" class="editor-button" (click)="closeFilePicker()">Cancel</button><button type="button" class="editor-button primary" (click)="applyFileSelection()">Apply selection ({{ selectedFiles().size }})</button></div>
    </dialog>
  `,
  styleUrls: ['./question-regions.css', './protocol-fields.css'],
})
export class InstrumentProtocolComponent {
  @Input() aiEnabled = false;
  readonly wizardState = inject(WizardStateService);
  readonly state = this.wizardState.state;
  readonly columns = computed(() => protocolColumns(this.state()));
  readonly groups = [{ key: 'required', label: 'Required' }, { key: 'recommended', label: 'Recommended' }, { key: 'optional', label: 'Optional' }];
  readonly expandedGroups = signal(new Set<string>());
  readonly editingColumn = signal('');
  readonly valueEditorOpen = signal(false);
  readonly draftValue = signal<ProtocolValue>('');
  readonly draftError = signal('');
  readonly activeSetId = signal('');
  readonly modificationColumn = PROTOCOL_COLUMNS.modifications;
  readonly valueLabel = protocolValueLabel;
  readonly fileNames = computed(() => [...new Set(this.state().dataFiles.map(file => file.fileName))]);
  readonly completionSummary = computed(() => {
    const required = this.columnsFor('required');
    return `${required.filter(c => !this.fieldError(c)).length} / ${required.length} required attributes filled`;
  });
  readonly pickerColumn = signal('');
  readonly pickerChoiceId = signal('');
  readonly fileSearch = signal('');
  readonly selectedFiles = signal(new Set<string>());
  readonly filteredFiles = computed(() => this.fileNames().filter(name => name.toLowerCase().includes(this.fileSearch().trim().toLowerCase())));
  readonly pickerValueLabel = computed(() => {
    const choice = this.field(this.pickerColumn()).choices.find(c => c.id === this.pickerChoiceId());
    return choice ? this.valueLabel(choice.value) : '';
  });
  private readonly filePicker = viewChild<ElementRef<HTMLDialogElement>>('filePicker');
  columnsFor(requirement: string): TemplateColumn[] { return this.columns().filter(c => c.requirement === requirement); }
  title(column: TemplateColumn): string {
    const label = column.name.match(/^comment\[(.+)\]$/)?.[1] ?? column.name;
    return label.charAt(0).toUpperCase() + label.slice(1);
  }
  field(name: string) { return protocolField(this.state(), name); }
  fieldError(column: TemplateColumn): string { return protocolFieldError(this.state(), column); }
  summaryValues(name: string): string { return this.field(name).choices.map(c => this.valueLabel(c.value)).join(' · ') || 'Not set'; }
  ontologyId(value: ProtocolValue): string { return typeof value === 'object' && !Array.isArray(value) ? ('id' in value ? value.id : value.msAccession) : ''; }
  assignmentSummary(name: string): string {
    const field = this.field(name), files = this.fileNames();
    if (!field.choices.length) return 'No values added';
    const assigned = files.map(file => protocolChoiceForFile(field, file)?.id);
    if (assigned.length && assigned.every(id => !!id && id === assigned[0])) return `Same for all ${files.length} raw files`;
    if (!files.length && field.allChoiceId) return 'Applies to all raw files';
    return `${assigned.filter(Boolean).length} / ${files.length} raw files assigned`;
  }
  countAssignments(name: string, id: string): number { return this.fileNames().filter(file => protocolChoiceForFile(this.field(name), file)?.id === id).length; }
  toggleGroup(key: string): void { this.expandedGroups.update(groups => { const next = new Set(groups); next.has(key) ? next.delete(key) : next.add(key); return next; }); }
  openEditor(name: string): void {
    this.closeValueEditor();
    this.editingColumn.set(this.editingColumn() === name ? '' : name);
    if (this.editingColumn() && !this.field(name).choices.length) this.addValue(name);
  }
  addValue(name: string): void {
    this.activeSetId.set('');
    this.draftValue.set(name === this.modificationColumn ? [] : ''); this.draftError.set(''); this.valueEditorOpen.set(true);
  }
  updateDraft(value: ProtocolValue): void { this.draftValue.set(value); this.draftError.set(''); }
  closeValueEditor(): void { this.valueEditorOpen.set(false); this.activeSetId.set(''); this.draftError.set(''); }
  saveValue(column: TemplateColumn): void {
    const value = this.draftValue(), isSet = column.name === this.modificationColumn;
    const field = this.field(column.name), activeId = isSet ? this.activeSetId() : '';
    // Removing the last modification removes the saved set as well.
    if (isSet && Array.isArray(value) && !value.length && activeId) {
      this.wizardState.setProtocolField(column.name, removeProtocolChoice(field, activeId));
      this.activeSetId.set('');
      return;
    }
    const error = protocolValueError(column, value);
    if (error) { this.draftError.set(error); return; }
    if (field.choices.some(c => c.id !== activeId && JSON.stringify(c.value) === JSON.stringify(value))) {
      this.draftError.set('This value is already in the list. Select files for the existing value.'); return;
    }
    const id = activeId || crypto.randomUUID();
    this.wizardState.setProtocolField(column.name, activeId
      ? { ...field, choices: field.choices.map(choice => choice.id === activeId ? { ...choice, value: structuredClone(value) } : choice) }
      : addProtocolChoice(field, { id, value: structuredClone(value) }, this.fileNames()));
    if (isSet) this.activeSetId.set(id);
    else this.closeValueEditor();
  }
  removeValue(name: string, id: string): void {
    this.wizardState.setProtocolField(name, removeProtocolChoice(this.field(name), id));
    if (this.activeSetId() === id) { this.activeSetId.set(''); this.closeValueEditor(); }
  }
  assignAll(name: string, id: string): void {
    this.wizardState.setProtocolField(name, assignProtocolChoice(this.field(name), id, this.fileNames(), new Set(), true));
  }
  openFilePicker(name: string, choice: ProtocolChoice): void {
    this.pickerColumn.set(name); this.pickerChoiceId.set(choice.id); this.fileSearch.set('');
    this.selectedFiles.set(new Set(this.fileNames().filter(file => protocolChoiceForFile(this.field(name), file)?.id === choice.id)));
    this.filePicker()?.nativeElement.showModal();
  }
  closeFilePicker(): void { this.filePicker()?.nativeElement.close(); }
  toggleFile(name: string): void { this.selectedFiles.update(files => { const next = new Set(files); next.has(name) ? next.delete(name) : next.add(name); return next; }); }
  selectFiles(mode: 'all' | 'missing' | 'none'): void {
    if (mode === 'none') { this.selectedFiles.set(new Set()); return; }
    const next = new Set(this.selectedFiles());
    for (const name of this.filteredFiles()) if (mode === 'all' || !protocolChoiceForFile(this.field(this.pickerColumn()), name)) next.add(name);
    this.selectedFiles.set(next);
  }
  fileAssignmentLabel(name: string): string {
    const choice = protocolChoiceForFile(this.field(this.pickerColumn()), name);
    return choice ? `Current: ${this.valueLabel(choice.value)}` : 'Unassigned';
  }
  applyFileSelection(): void {
    const name = this.pickerColumn();
    this.wizardState.setProtocolField(name, assignProtocolChoice(this.field(name), this.pickerChoiceId(), this.fileNames(), this.selectedFiles()));
    this.closeFilePicker();
  }
}
