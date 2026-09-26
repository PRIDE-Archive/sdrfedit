import { Component, Input, inject, computed, signal, OnDestroy, ElementRef, viewChild, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { WizardStateService } from '../../../core/services/wizard-state.service';
import { getCharacteristicChoices, isWizardSkippedCharacteristic, resolveFactorValue } from '../../../core/models/wizard';

@Component({
  selector: 'wizard-factor-values', standalone: true, imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (!embedded) { <h3>Which attributes are your study factors?</h3><p class="help-text">Select study variables or add a custom factor.</p> }
    <div class="factor-sources">
      @for (source of visibleSources(); track source) {
        <label class="source-row"><input type="checkbox" [checked]="isSourceSelected(source)" (change)="toggleSource(source, $any($event.target).checked)" />
          <strong>{{ sourceTitle(source) }}</strong><span class="source-values">{{ sourceValues(source).join(' · ') || 'No values yet' }}</span>
        </label>
      }
    </div>
    @if (otherSourceCount()) { <button type="button" class="text-button" (click)="showOtherSources.set(!showOtherSources())">{{ showOtherSources() ? 'Hide other attributes' : 'Show other attributes (' + otherSourceCount() + ')' }}</button> }
    @for (entry of independentFactors(); track entry.index) {
      <div class="custom-row"><label><input type="checkbox" [checked]="entry.factor.enabled" (change)="wizardState.toggleFactor(entry.index, $any($event.target).checked)" /> {{ entry.factor.name }}</label>
        <span class="source-values">{{ entry.factor.values.join(' · ') }}</span>
        <button type="button" class="editor-button" (click)="editFactor(entry.index)">Edit</button><button type="button" class="remove" [attr.aria-label]="'Remove ' + entry.factor.name" (click)="removeFactor(entry.index)">×</button>
      </div>
    }
    @if (editing()) {
      <div class="custom-editor">
        <label class="field-label">Factor name<input class="form-input" [ngModel]="draftName()" (ngModelChange)="draftName.set($event); error.set('')" placeholder="e.g. treatment" /></label>
        @if (matchingSource()) { <p class="help-text">A sample attribute already has this name. <button type="button" class="text-button" (click)="useMatchingSource()">Use its values</button></p> }
        <details><summary>Assignment level</summary><select class="form-input" aria-label="Assignment level" [ngModel]="draftScope()" (ngModelChange)="draftScope.set($event)"><option value="sample">Biological samples</option><option value="run">MS runs — assign in Runs &amp; Files</option></select></details>
        <label class="field-label" for="custom-factor-value">Factor values</label>
        <div class="add-row"><input id="custom-factor-value" class="form-input" [ngModel]="newValue()" (ngModelChange)="newValue.set($event)" (keydown.enter)="addValue(); $event.preventDefault()" placeholder="e.g. vehicle or drug A" /><button type="button" class="editor-button" [disabled]="!newValue().trim()" (click)="addValue()">Add value</button></div>
        @for (value of draftValues(); track value) {
          <div class="custom-row"><div class="value-label">{{ value }}@if (draftScope() === 'sample') { <small>{{ countAssignments(value) }} samples assigned</small> }</div>
            @if (draftScope() === 'sample') { <button type="button" class="editor-button" (click)="openSamplePicker(value)">Select samples</button> }
            <button type="button" class="remove" [attr.aria-label]="'Remove ' + value" (click)="removeValue(value)">×</button>
          </div>
        }
        <div class="editor-footer"><span class="help-text grow">{{ draftScope() === 'sample' ? assignedCount() + ' / ' + state().samples.length + ' samples assigned.' : 'Assign run values in Runs & Files.' }}</span><button type="button" class="editor-button" (click)="cancelEdit()">Cancel</button><button type="button" class="editor-button primary" (click)="saveFactor()">Save</button></div>
      </div>
    } @else { <button type="button" class="text-button add-custom" (click)="editFactor()">＋ Add custom factor</button> }
    <label class="none-option"><input type="checkbox" [checked]="state().factorDecision === 'none'" (change)="setNone($any($event.target).checked)" /> No study factors for this experiment</label>
    @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
    <dialog #samplePicker class="sample-picker" aria-labelledby="factor-picker-title" (cancel)="closeSamplePicker()" (close)="stopDrag()">
      <div class="picker-heading"><div><h3 id="factor-picker-title">Select samples</h3><span>{{ assignmentValue() }}</span>

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

  `,
  styles: [`
    :host { display: block; color: #334155; }
    .source-row, .custom-row { display: flex; align-items: center; gap: 12px; padding: 14px 0; border-bottom: 1px solid #dce4ef; flex-wrap: wrap; font-size: 13px; }
    .source-row strong { width: 130px; font-weight: 500; overflow-wrap: anywhere; }
    .source-row:has(input:checked) { background: #f4f7fb; }
    .source-values { flex: 1; color: #64748b; min-width: 120px; overflow-wrap: anywhere; }
    input[type=checkbox] { accent-color: #2563eb; }
    .custom-editor { padding: 16px; background: #f4f7fb; border-radius: 10px; margin-top: 12px; }
    .field-label { display: block; font-size: 12px; margin: 12px 0 6px; }
    .field-label .form-input { margin-top: 6px; }
    .form-input { width: 100%; min-width: 0; box-sizing: border-box; border: 1px solid #cbd5e1; padding: 9px 10px; border-radius: 6px; font: inherit; background: #fff; }
    .add-row { display: flex; gap: 8px; }
    .editor-button { border: 1px solid #d7e1ef; border-radius: 6px; padding: 8px 12px; font-size: 12px; background: #fff; color: #334155; cursor: pointer; }
    .editor-button.primary { background: #2563eb; color: #fff; border-color: #2563eb; }
    .editor-button:disabled { opacity: .5; }
    .editor-button[aria-pressed=true] { border-color: #2563eb; background: #eff6ff; color: #2563eb; }
    .text-button, .remove { border: 0; background: transparent; cursor: pointer; color: #2563eb; padding: 6px 0; }
    .remove { color: #64748b; padding: 8px; }
    .add-custom { margin-top: 12px; }
    .value-label, .grow { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .value-label small { display: block; color: #64748b; margin-top: 4px; }
    .help-text { font-size: 12px; color: #64748b; }
    .editor-footer, .mode-buttons { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .editor-footer { margin-top: 12px; justify-content: flex-end; }
    .none-option { display: flex; align-items: center; gap: 8px; font-size: 13px; margin-top: 16px; }
    .error { color: #b91c1c; font-size: 12px; }
    details { margin: 12px 0; font-size: 12px; color: #64748b; }
    .sample-tile-grid { height: 300px; overflow-y: auto; overscroll-behavior: contain; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; align-content: start; padding: 8px; border: 1px solid #dce4ef; border-radius: 8px; }
    .sample-tile { text-align: left; overflow-wrap: anywhere; }
    .sample-tile small { display: block; margin-top: 4px; font-size: 11px; color: #64748b; }
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

    @media(max-width: 600px) { .sample-tile-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  `],
})
export class FactorValuesComponent implements OnDestroy {
  @Input() embedded = false;
  readonly wizardState = inject(WizardStateService);
  readonly state = this.wizardState.state;
  readonly characteristicSources = computed(() => Array.from(new Set([
    ...this.state().characteristicColumns.map(c => c.name), ...Object.keys(this.state().characteristicChoices),
    ...this.state().factors.flatMap(f => f.sourceCharacteristic ? [f.sourceCharacteristic] : []),
  ])).filter(name => name.startsWith('characteristics[') && !isWizardSkippedCharacteristic(name)));
  readonly showOtherSources = signal(false);
  readonly assignedSources = computed(() => this.characteristicSources().filter(source => {
    const values = this.sourceValues(source);
    return this.state().samples.some(sample => {
      const value = resolveFactorValue(this.state(), sample, { name: this.sourceTitle(source), enabled: true, values: [], sourceCharacteristic: source });
      return !!value && values.some(candidate => candidate.toLowerCase() === value.toLowerCase());
    });
  }));
  readonly defaultSources = computed(() => this.characteristicSources().filter(source => this.assignedSources().includes(source) || this.isSourceSelected(source)));
  readonly otherSourceCount = computed(() => this.characteristicSources().length - this.defaultSources().length);
  readonly visibleSources = computed(() => this.showOtherSources() ? [...this.defaultSources(), ...this.characteristicSources().filter(source => !this.defaultSources().includes(source))] : this.defaultSources());
  readonly independentFactors = computed(() => this.state().factors.map((factor, index) => ({ factor, index })).filter(e => !e.factor.sourceCharacteristic));
  readonly editing = signal(false);
  readonly draftName = signal('');
  readonly draftScope = signal<'sample' | 'run'>('sample');
  readonly draftValues = signal<string[]>([]);
  readonly newValue = signal('');
  readonly draftAssignments = signal<string[]>([]);
  readonly assignmentSelection = signal<Set<number>>(new Set());
  readonly assignedCount = computed(() => this.draftAssignments().filter(Boolean).length);
  readonly error = signal('');
  readonly matchingSource = computed(() => this.characteristicSources().find(s => this.sourceTitle(s).toLowerCase() === this.draftName().trim().toLowerCase()));
  private editingIndex = -1;
  private snapshot = '';
  private factorSnapshot = '';
  sourceTitle(source: string): string { return source.replace(/^characteristics\[/, '').replace(/\]$/, ''); }
  sourceValues(source: string): string[] { return getCharacteristicChoices(this.state(), source).map(c => c.value); }
  isSourceSelected(source: string): boolean { return this.state().factors.some(f => f.enabled && f.sourceCharacteristic === source); }
  toggleSource(source: string, enabled: boolean): void {
    const index = this.state().factors.findIndex(f => f.sourceCharacteristic === source);
    const name = this.sourceTitle(source);
    if (enabled && this.state().factors.some((f, i) => i !== index && f.name.toLowerCase() === name.toLowerCase())) { this.error.set('A factor with this name already exists. Edit or remove it first.'); return; }
    if (index >= 0) this.wizardState.toggleFactor(index, enabled);
    else if (enabled) this.wizardState.addFactor({ name, enabled: true, values: [], scope: 'sample', sourceCharacteristic: source });
    this.error.set('');
  }
  useMatchingSource(): void { const source = this.matchingSource(); if (!source) return; this.toggleSource(source, true); if (!this.error()) this.cancelEdit(); }
  setNone(none: boolean): void { this.cancelEdit(); this.wizardState.setFactorDecision(none ? 'none' : 'pending', none ? 'User confirmed no study factors for this experiment.' : ''); }
  editFactor(index = -1): void {
    const factor = this.state().factors[index]; this.editingIndex = index;
    this.snapshot = JSON.stringify(this.state().samples.map(s => [s.index, s.sourceName]));
    this.factorSnapshot = JSON.stringify(this.state().factors);
    this.draftName.set(factor?.name || ''); this.draftValues.set([...(factor?.values || [])]); this.draftScope.set(factor?.scope || 'sample');
    this.draftAssignments.set(this.state().samples.map(s => factor && factor.scope !== 'run' ? resolveFactorValue(this.state(), s, factor) : ''));
    this.newValue.set(''); this.error.set(''); this.editing.set(true);
  }
  cancelEdit(): void { this.closeSamplePicker(); this.editing.set(false); this.error.set(''); }
  removeFactor(index: number): void { this.cancelEdit(); this.wizardState.removeFactor(index); }
  hasDraftChoice(value: string): boolean { return this.draftValues().includes(value); }
  addValue(): void { const value = this.newValue().trim(); if (!value) return; if (this.draftValues().some(v => v.toLowerCase() === value.toLowerCase())) { this.error.set('This value already exists.'); return; } this.draftValues.update(v => [...v, value]); this.newValue.set(''); this.error.set(''); }
  removeValue(value: string): void { this.draftValues.update(v => v.filter(x => x !== value)); this.draftAssignments.update(v => v.map(x => x === value ? '' : x)); }
  saveFactor(): void {
    if (this.snapshot !== JSON.stringify(this.state().samples.map(s => [s.index, s.sourceName])) || this.factorSnapshot !== JSON.stringify(this.state().factors)) { this.error.set('Samples or factors changed. Reopen this editor before saving.'); return; }
    if (this.matchingSource() && this.editingIndex < 0) { this.error.set('An attribute already has this name. Use its values above, or choose a different factor name.'); return; }
    try {
      this.wizardState.applyCustomFactorDraft(this.editingIndex, { name: this.draftName(), enabled: true, scope: this.draftScope(), values: this.draftValues() }, this.draftAssignments());
      this.cancelEdit();
    } catch (error) { this.error.set(error instanceof Error ? error.message : 'Could not save factor.'); }
  }
  readonly assignmentValue = signal('');
  readonly hasLockedSamples = computed(() => this.draftAssignments().some(value => !!value && value !== this.assignmentValue()));
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
    this.closeSamplePicker();
  }
}
