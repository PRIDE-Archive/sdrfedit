import { Injectable, computed, inject, signal } from '@angular/core';
import type { WizardActionCard } from '../../models/assistant';
import {
  WizardState, WIZARD_STEPS, factorDefinitionErrors, getSampleTemplateId,
  getSpecialtyCharacteristicKey, isWizardSkippedCharacteristic,
  resolveFactorValue, factorCandidates, resolveRunFactorValue,
} from '../../models/wizard';
import { runAutoAnnotation, waitForAutoTask, type AutoTurn, type AutoValidation } from '../../utils/auto-annotation';
import { WizardStateService } from '../wizard-state.service';
import { WizardGeneratorService } from '../wizard-generator.service';
import { SdrfExportService } from '../sdrf-export.service';
import { PyodideValidatorService } from '../pyodide-validator.service';
import { WizardAiBridgeService } from './wizard-ai-bridge.service';

interface Checkpoint { state: WizardState; step: number }
export interface AutoAnnotationCallbacks {
  request(step: number, feedback: string[], runId: string): Promise<AutoTurn>;
  record(cards: WizardActionCard[], applied: boolean, error?: string): void;
  abort(): void;
}

/** Explicitly started, transient automation. Loading a chat never resumes it. */
@Injectable({ providedIn: 'root' })
export class WizardAutoAnnotationService {
  private readonly wizard = inject(WizardStateService);
  private readonly bridge = inject(WizardAiBridgeService);
  private readonly generator = inject(WizardGeneratorService);
  private readonly validator = inject(PyodideValidatorService);
  private readonly exporter = new SdrfExportService();
  readonly active = signal(false);
  readonly stopping = signal(false);
  readonly status = signal<'idle' | 'running' | 'complete' | 'blocked' | 'stopped'>('idle');
  readonly progress = signal('');
  readonly issues = signal<string[]>([]);
  readonly warnings = signal<string[]>([]);
  private readonly result = signal<{ tsv: string; fingerprint: string } | null>(null);
  private readonly undoPoint = signal<{ checkpoint: Checkpoint; fingerprint: string; runId: string } | null>(null);
  readonly canUndo = computed(() => !this.active() && !!this.undoPoint()
    && this.undoPoint()!.fingerprint === this.stateFingerprint());
  readonly downloadable = computed(() => !this.active() && !!this.result()
    && this.result()!.fingerprint === this.stateFingerprint());
  readonly resultChanged = computed(() => this.status() === 'complete' && !!this.result()
    && this.result()!.fingerprint !== this.stateFingerprint());
  private controller: AbortController | null = null;
  private abortRequest: (() => void) | null = null;

  private fingerprint(): string {
    return JSON.stringify([this.wizard.getState(), this.wizard.currentStep()]);
  }

  private stateFingerprint(): string {
    return JSON.stringify(this.wizard.getState());
  }

  private checkpoint(): Checkpoint {
    return { state: structuredClone(this.wizard.getState()), step: this.wizard.currentStep() };
  }

  async start(callbacks: AutoAnnotationCallbacks): Promise<void> {
    if (this.active()) return;
    const checkpoint = this.checkpoint();
    const runId = globalThis.crypto?.randomUUID?.() || `auto_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const controller = new AbortController();
    this.controller = controller;
    this.abortRequest = callbacks.abort;
    this.active.set(true);
    this.stopping.set(false);
    this.status.set('running');
    this.issues.set([]);
    this.warnings.set([]);
    this.result.set(null);
    this.undoPoint.set(null);
    const outcome = await runAutoAnnotation({
      snapshot: () => this.checkpoint(),
      restore: point => this.wizard.hydrate(point.state, point.step),
      fingerprint: () => this.fingerprint(),
      navigate: step => {
        // Preserve the normal next-step initialization (samples, factors, runs).
        if (step === this.wizard.currentStep() + 1) this.wizard.nextStep();
        else this.wizard.goToStep(step);
      },
      request: (step, feedback) => callbacks.request(step, feedback, runId),
      apply: card => {
        this.result.set(null);
        if (card.action.step !== WIZARD_STEPS[this.wizard.currentStep()].id) {
          throw new Error(`Action ${card.action.op} targets a different wizard step.`);
        }
        return this.bridge.applyAction(card.action, controller.signal);
      },
      record: callbacks.record,
      errors: step => this.stepErrors(step),
      validate: () => this.validate(controller.signal),
      progress: text => this.progress.set(text),
    }, controller.signal);
    this.status.set(outcome.status);
    this.issues.set(outcome.issues);
    this.progress.set(outcome.status === 'complete' ? 'SDRF generated and template validation passed.'
      : outcome.status === 'stopped' ? 'Stopped. Completed steps are kept.'
      : 'Draft saved. Automatic annotation could not finish.');
    if (outcome.status === 'stopped') this.result.set(null);
    this.undoPoint.set({ checkpoint, fingerprint: this.stateFingerprint(), runId });
    this.controller = null;
    this.abortRequest = null;
    this.active.set(false);
    this.stopping.set(false);
  }

  stop(): void {
    if (!this.active()) return;
    this.stopping.set(true);
    this.progress.set('Stopping…');
    this.controller?.abort();
    this.abortRequest?.();
  }

  /** Clear only transient UI when a different chat is loaded. */
  clear(): void {
    if (this.active()) return;
    this.status.set('idle');
    this.result.set(null);
    this.undoPoint.set(null);
    this.issues.set([]);
    this.warnings.set([]);
  }

  undo(): string | null {
    if (!this.canUndo()) return null;
    const point = this.undoPoint()!;
    this.wizard.hydrate(point.checkpoint.state, point.checkpoint.step);
    this.clear();
    return point.runId;
  }

  download(): void {
    if (!this.downloadable()) return;
    const url = URL.createObjectURL(new Blob([this.result()!.tsv], { type: 'text/tab-separated-values;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = this.status() === 'complete' ? 'auto-annotated.sdrf.tsv' : 'auto-annotation-draft.sdrf.tsv';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  private stepErrors(step: number): string[] {
    const state = this.wizard.getState();
    const errors: string[] = [];
    if (step === 0 && !this.wizard.isStep1Valid()) {
      errors.push('Select a compatible technology/sample/experiment template combination and a positive biological sample count.');
    }
    if (step === 1) {
      const required = state.characteristicColumns.filter(c => c.requirement === 'required'
        && !isWizardSkippedCharacteristic(c.name) && getSpecialtyCharacteristicKey(c.name) !== 'material type');
      const names = required.length ? required.map(c => c.name)
        : ['characteristics[organism]', 'characteristics[disease]', 'characteristics[organism part]'];
      for (const name of names) {
        if (!state.characteristicChoices[name]?.length) errors.push(`Add an evidence-supported value for ${name}.`);
      }
      errors.push(...factorDefinitionErrors(state));
      if (!this.wizard.isFactorsDefined()) errors.push('Define study factors and candidates, or explicitly explain why the study has no factors.');
    }
    if (step === 2) {
      if (!state.samples.length) errors.push('No biological samples are defined.');
      for (const sample of state.samples) {
        if (!sample.sourceName.trim()) errors.push(`Sample ${sample.index}: missing source name.`);
        for (const column of state.characteristicColumns) {
          if (column.requirement === 'required' && !isWizardSkippedCharacteristic(column.name)
            && getSpecialtyCharacteristicKey(column.name) !== 'material type'
            && (state.characteristicChoices[column.name]?.length ?? 0) >= 2
            && !sample.characteristicValues?.[column.name]?.trim()) {
            errors.push(`${sample.sourceName}: assign ${column.name}.`);
          }
        }
        for (const factor of state.factors.filter(f => f.enabled && f.scope !== 'run')) {
          if (!resolveFactorValue(state, sample, factor)) errors.push(`${sample.sourceName}: assign factor ${factor.name}.`);
        }
      }
      if (!this.wizard.isStep3Valid() && !errors.length) errors.push('Correct sample characteristic and factor assignments to match their candidate values.');
    }
    if (step === 3 && !this.wizard.isRunsFilesValid()) {
      if (!state.dataFiles.length) errors.push('Import the actual raw file names.');
      for (const file of state.dataFiles) {
        if (!file.runId || !state.msRuns.some(r => r.id === file.runId)) errors.push(`${file.fileName}: assign to an existing MS run.`);
      }
      for (const run of state.msRuns) {
        for (const factor of state.factors.filter(f => f.enabled && f.scope === 'run')) {
          if (!factorCandidates(state, factor).includes(resolveRunFactorValue(run, factor))) errors.push(`${run.name}: assign factor ${factor.name}.`);
        }
      }
      errors.push('Check unique file names, valid fraction/technical replicate numbers, label kits and evidence-supported run/channel/sample mappings.');
    }
    if (step === 4 && !this.wizard.isStep5Valid()) {
      if (!state.instrument) errors.push('Provide a verified instrument ontology term.');
      if (!state.cleavageAgent) errors.push('Provide a verified cleavage agent.');
      errors.push('Mass tolerances must use supported units or permitted missing values.');
    }
    return errors;
  }

  private async validate(signal: AbortSignal): Promise<AutoValidation> {
    // Regeneration can fail; never retain an earlier, now stale artifact.
    this.result.set(null);
    for (let step = 0; step < 5; step++) {
      const issues = this.stepErrors(step);
      if (issues.length) return { issues, repairStep: step };
    }
    const state = this.wizard.getState();
    const table = this.generator.generate(state);
    const tsv = this.exporter.exportToTsv(table);
    this.result.set({ tsv, fingerprint: this.stateFingerprint() });
    const templates = [...new Set([getSampleTemplateId(state), state.technologyTemplate, ...state.experimentTemplates]
      .filter((name): name is string => !!name))];
    try {
      const issues = await waitForAutoTask(this.validator.validate(tsv, templates.length ? templates : ['ms-proteomics'], {
        skipOntology: true, mode: 'api', allowApiFallback: false,
      }), AbortSignal.any([signal, AbortSignal.timeout(60_000)]));
      if (signal.aborted) return { issues: ['Stopped'] };
      this.warnings.set(issues.filter(issue => issue.level === 'warning').map(issue => issue.message));
      const errors = issues.filter(issue => issue.level === 'error');
      return {
        issues: errors.map(issue => `${issue.column || 'SDRF'}${issue.row >= 0 ? ` row ${issue.row + 1}` : ''}: ${issue.message}`),
        repairStep: errors.length ? Math.min(...errors.map(issue => repairStepForColumn(issue.column))) : undefined,
      };
    } catch (error) {
      return { issues: [`Final validation unavailable: ${error instanceof Error ? error.message : String(error)}. The generated file is an unvalidated draft.`] };
    }
  }
}

function repairStepForColumn(column: string | null): number {
  const name = (column || '').toLowerCase();
  if (name.startsWith('characteristics[') || name.startsWith('factor value[')) return 1;
  if (name === 'source name' || name.includes('biological replicate')) return 2;
  if (['instrument', 'cleavage', 'modification', 'tolerance'].some(part => name.includes(part))) return 4;
  return 3;
}
