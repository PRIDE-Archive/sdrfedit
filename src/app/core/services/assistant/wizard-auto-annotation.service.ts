import { protocolCompletionErrors } from '../../utils/protocol-fields';
import { Injectable, computed, inject, signal } from '@angular/core';
import type { WizardActionCard } from '../../models/assistant';
import {
  WizardState, WIZARD_STEPS, factorDefinitionErrors, getSampleTemplateId,
  getSpecialtyCharacteristicKey, isWizardSkippedCharacteristic,
  resolveFactorValue, factorCandidates, resolveRunFactorValue,
} from '../../models/wizard';
import { autoAnnotationStartStep, runAutoAnnotation, waitForAutoTask, type AutoTurn, type AutoValidation,
  type AutoRepairRequest, type AutoRepairEvent, type AutoBatchFailure } from '../../utils/auto-annotation';
import { WizardStateService } from '../wizard-state.service';
import { WizardGeneratorService } from '../wizard-generator.service';
import { SdrfExportService } from '../sdrf-export.service';
import { TemplateService } from '../template.service';
import { WizardAiBridgeService } from './wizard-ai-bridge.service';
import { describeActionFailure } from './wizard-action-repair';

interface Checkpoint { state: WizardState; step: number }
export interface AutoAnnotationCallbacks {
  request(step: number, runId: string): Promise<AutoTurn>;
  repair(request: AutoRepairRequest, runId: string): Promise<AutoTurn>;
  repairEvent(event: AutoRepairEvent): void;
  record(cards: WizardActionCard[], applied: boolean, error?: string, failure?: AutoBatchFailure): void;
  abort(): void;
}

/** Explicitly started, transient automation. Loading a chat never resumes it. */
@Injectable({ providedIn: 'root' })
export class WizardAutoAnnotationService {
  private readonly wizard = inject(WizardStateService);
  private readonly bridge = inject(WizardAiBridgeService);
  private readonly generator = inject(WizardGeneratorService);
  private readonly templates = inject(TemplateService);
  private readonly exporter = new SdrfExportService();
  readonly active = signal(false);
  readonly stopping = signal(false);
  readonly status = signal<'idle' | 'running' | 'complete' | 'blocked' | 'stopped' | 'waiting'>('idle');
  readonly progress = signal('');
  readonly issues = signal<string[]>([]);
  readonly notes = signal<string[]>([]);
  readonly warnings = signal<string[]>([]);
  private readonly result = signal<{ tsv: string; fingerprint: string } | null>(null);
  private readonly undoPoint = signal<{ checkpoint: Checkpoint; fingerprint: string; runId: string } | null>(null);
  readonly canUndo = computed(() => !this.active() && !!this.undoPoint()
    && this.undoPoint()!.fingerprint === this.stateFingerprint());
  readonly downloadable = computed(() => !this.active() && !!this.result()
    && this.result()!.fingerprint === this.stateFingerprint());
  readonly resultChanged = computed(() => this.status() === 'complete' && !!this.result()
    && this.result()!.fingerprint !== this.stateFingerprint());
  private resumePoint: { step: number; appliedFingerprint?: string } | null = null;
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
    const resume = this.resumePoint;
    const startStep = autoAnnotationStartStep(checkpoint.step, step => this.stepErrors(step), resume ? {
      step: resume.step,
      manuallyCompleted: resume.appliedFingerprint === this.stateFingerprint(),
    } : undefined);
    const runId = globalThis.crypto?.randomUUID?.() || `auto_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const controller = new AbortController();
    this.controller = controller;
    this.abortRequest = callbacks.abort;
    this.active.set(true);
    this.stopping.set(false);
    this.status.set('running');
    this.issues.set([]);
    this.notes.set([]);
    this.warnings.set([]);
    this.result.set(null);
    this.undoPoint.set(null);
    const outcome = await runAutoAnnotation({
      snapshot: () => this.checkpoint(),
      restore: point => this.wizard.hydrate(point.state, point.step),
      fingerprint: () => this.fingerprint(),
      navigate: step => {
        this.resumePoint = { step };
        // Preserve the normal next-step initialization (samples, factors, runs).
        if (step === this.wizard.currentStep() + 1) this.wizard.nextStep();
        else this.wizard.goToStep(step);
        if (this.wizard.currentStep() !== step) {
          throw new Error(`Cannot enter step ${step + 1}: the preceding wizard step is incomplete.`);
        }
      },
      request: step => callbacks.request(step, runId),
      repair: request => callbacks.repair(request, runId),
      describeFailure: describeActionFailure,
      repairEvent: callbacks.repairEvent,
      apply: card => {
        this.result.set(null);
        if (card.action.step !== WIZARD_STEPS[this.wizard.currentStep()].id) {
          throw new Error(`Action ${card.action.op} targets a different wizard step.`);
        }
        return this.bridge.applyAction(card.action, controller.signal);
      },
      record: callbacks.record,
      errors: step => this.stepErrors(step),
      notes: (step, notes) => this.notes.update(existing => [...new Set([
        ...existing, ...notes.map(note => `Step ${step + 1}: ${note}`),
      ])]),
      validate: () => this.validate(controller.signal),
      progress: text => this.progress.set(text),
    }, controller.signal, startStep);
    if (outcome.status === 'complete') this.resumePoint = null;
    this.status.set(outcome.status);
    this.issues.set(outcome.issues);
    const location = `step ${this.wizard.currentStep() + 1}: ${WIZARD_STEPS[this.wizard.currentStep()].title}`;
    this.progress.set(outcome.status === 'complete' ? 'SDRF generated and template validation passed.'
      : outcome.status === 'waiting' ? `Waiting for your reply at ${location}. No recommendation cards were generated. Completed steps are kept. Answer the assistant in chat, or choose Auto annotate to continue.`
      : outcome.status === 'stopped' ? `Stopped at ${location}. Completed steps are kept.`
      : `Draft saved at ${location}. Resolve the listed issues, then choose Auto annotate to continue.`);
    if (outcome.status === 'stopped') this.result.set(null);
    this.undoPoint.set({ checkpoint, fingerprint: this.stateFingerprint(), runId });
    this.controller = null;
    this.abortRequest = null;
    this.active.set(false);
    this.stopping.set(false);
  }

  /** Only a successful, fully applied manual card set can complete a paused step. */
  recordManualApplication(stepId: string, allApplied: boolean): void {
    const point = this.resumePoint;
    if (this.active() || !point || WIZARD_STEPS[point.step]?.id !== stepId) return;
    point.appliedFingerprint = allApplied && !this.stepErrors(point.step).length
      ? this.stateFingerprint() : undefined;
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
    this.resumePoint = null;
    this.status.set('idle');
    this.result.set(null);
    this.undoPoint.set(null);
    this.issues.set([]);
    this.notes.set([]);
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
    const accession = this.wizard.getState().projectAccession?.match(/^PXD\d+$/i)?.[0]?.toUpperCase();
    link.download = this.status() === 'complete'
      ? (accession ? `${accession}.sdrf.tsv` : 'auto-annotated.sdrf.tsv')
      : (accession ? `${accession}.draft.sdrf.tsv` : 'auto-annotation-draft.sdrf.tsv');
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
      const names = required.map(c => c.name);
      if (!state.effectiveColumns?.length) errors.push('Load the selected template columns before continuing.');
      for (const name of names) {
        if (!state.characteristicChoices[name]?.length) errors.push(`Add an evidence-supported value for ${name}.`);
      }
      errors.push(...factorDefinitionErrors(state));
      if (!this.wizard.isFactorsDefined()) errors.push('Define study factors and candidates, or explicitly explain why the study has no factors.');
    }
    if (step === 1) {
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
    if (step === 2 && !this.wizard.isRunsFilesValid()) {
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
    if (step === 3 && !this.wizard.isStep5Valid()) {
      const protocolErrors = protocolCompletionErrors(state);
      errors.push(...(protocolErrors.length ? protocolErrors : ['Correct invalid protocol mass tolerances.']));
    }
    return errors;
  }

  private async validate(signal: AbortSignal): Promise<AutoValidation> {
    // An explicit restart after a validation failure should revalidate, not replay protocol cards.
    this.resumePoint = { step: WIZARD_STEPS.length - 1 };
    // Regeneration can fail; never retain an earlier, now stale artifact.
    this.result.set(null);
    for (let step = 0; step < WIZARD_STEPS.length - 1; step++) {
      const issues = this.stepErrors(step);
      if (issues.length) return { issues };
    }
    const state = this.wizard.getState();
    const table = this.generator.generate(state);
    const tsv = this.exporter.exportToTsv(table);
    this.result.set({ tsv, fingerprint: this.stateFingerprint() });
    try {
      if (!state.templateSnapshotId) throw new Error('Missing template snapshot. Return to template selection.');
      const issues = await waitForAutoTask(this.templates.validateTable(state.templateSnapshotId, state.selectedTemplates || [], tsv),
        AbortSignal.any([signal, AbortSignal.timeout(60_000)]));
      if (signal.aborted) return { issues: ['Stopped'] };
      this.warnings.set(issues.filter(issue => issue.level === 'warning').map(issue => issue.message));
      const errors = issues.filter(issue => issue.level === 'error');
      return {
        issues: errors.map(issue => `${issue.column || 'SDRF'}${issue.row >= 0 ? ` row ${issue.row + 1}` : ''}: ${issue.message}`),
      };
    } catch (error) {
      return { issues: [`Final validation unavailable: ${error instanceof Error ? error.message : String(error)}. The generated file is an unvalidated draft.`] };
    }
  }
}
