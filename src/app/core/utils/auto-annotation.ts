import type { AutomationReport, WizardActionCard } from '../models/assistant';

export interface AutoTurn {
  cards: WizardActionCard[];
  report?: AutomationReport | null;
}

export interface AutoValidation {
  issues: string[];
}

/** Side effects are injected so cancellation and transactions are testable. */
export interface AutoAnnotationPorts<Snapshot> {
  snapshot(): Snapshot;
  restore(snapshot: Snapshot): void;
  fingerprint(): string;
  navigate(step: number): void;
  request(step: number): Promise<AutoTurn>;
  apply(card: WizardActionCard): Promise<void>;
  record(cards: WizardActionCard[], applied: boolean, error?: string): void;
  errors(step: number): string[];
  notes?(step: number, notes: string[]): void;
  validate(): Promise<AutoValidation>;
  progress(message: string): void;
}

export interface AutoAnnotationOutcome {
  status: 'complete' | 'blocked' | 'stopped' | 'waiting';
  issues: string[];
}

/** Prefer saved progress, but always repair incomplete prerequisites before advancing. */
export function autoAnnotationStartStep(
  currentStep: number, errors: (step: number) => string[],
  resume?: { step: number; manuallyCompleted: boolean },
): number {
  const current = Math.min(5, Math.max(0, resume
    ? resume.step + (resume.manuallyCompleted ? 1 : 0) : currentStep));
  for (let step = 0; step < current; step++) {
    if (errors(step).length) return step;
  }
  return current;
}

// Stable tiers cover dependencies without reordering operations within a tier.
const ORDER: Record<string, number> = {
  setTechnologyTemplate: 0, setSampleTemplate: 1, setExperimentTemplates: 2,
  setSampleCount: 3, addCharacteristicChoice: 0, setFactors: 1,
  addFactor: 1, addFactorValue: 2, setSourceNames: 0,
  autoGenerateSourceNames: 0, setLabelConfig: 0,
  replaceWithUnassignedFileNames: 1, autoPackSamplesIntoRuns: 2,
  applyRunsFilesPlan: 3, assignDataFilesToRun: 4, assignFilesToRunsByName: 4,
  setRunFactorValue: 5,
};

export function actionKey(card: WizardActionCard): string {
  return JSON.stringify([card.action.step, card.action.op, card.action.args]);
}

export function orderAutoCards(cards: WizardActionCard[]): WizardActionCard[] {
  return [...cards].sort((a, b) => (ORDER[a.action.op] ?? 10) - (ORDER[b.action.op] ?? 10));
}

/** Interrupt read-only work; mutation batches must settle before rollback. */
export function waitForAutoTask<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('Stopped'));
    signal.addEventListener('abort', abort, { once: true });
    task.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

/** One request per step, then one final validation. Any blocker returns control to the user. */
export async function runAutoAnnotation<S>(
  ports: AutoAnnotationPorts<S>, signal: AbortSignal,
  startStep = 0,
): Promise<AutoAnnotationOutcome> {
  const check = () => { if (signal.aborted) throw new Error('Stopped'); };
  try {
    for (let step = startStep; step < 5; step++) {
      check();
      ports.navigate(step);
      ports.progress(`Annotating wizard step ${step + 1}`);
      const beforeRequest = ports.fingerprint();
      const turn = await ports.request(step);
      check();
      if (beforeRequest !== ports.fingerprint()) {
        return { status: 'blocked', issues: ['Wizard changed while the assistant was responding. Start a new run using the latest state.'] };
      }
      if (!turn.cards.length) {
        ports.notes?.(step, turn.report?.notes || []);
        return { status: 'waiting', issues: [
          ...(turn.report?.issues || []), ...ports.errors(step),
        ] };
      }
      if (!turn.report) {
        return { status: 'blocked', issues: ['The backend did not return an automatic completion report. Update the backend before using Auto annotate.'] };
      }
      ports.notes?.(step, turn.report.notes || []);
      const snapshot = ports.snapshot();
      const seen = new Set<string>();
      const batch = orderAutoCards(turn.cards);
      let applicationError = '';
      try {
        for (const card of batch) {
          check();
          const key = actionKey(card);
          if (seen.has(key)) continue;
          await ports.apply(card);
          check();
          seen.add(key);
        }
      } catch (error) {
        ports.restore(snapshot);
        applicationError = error instanceof Error ? error.message : 'Could not apply action batch.';
        ports.record(batch, false, `Batch rolled back: ${applicationError}`);
        check();
      }
      if (!applicationError) {
        ports.record(batch, true);
      }
      const issues = [
        ...(applicationError ? [applicationError] : []),
        ...turn.report.issues,
        ...ports.errors(step),
      ];
      if (turn.report.status === 'blocked' && !turn.report.issues.length) {
        issues.push('The assistant could not establish that this step is complete.');
      }
      if (issues.length) return { status: 'blocked', issues };
    }
    check();
    ports.progress('Generating SDRF and validating selected templates…');
    const result = await waitForAutoTask(ports.validate(), signal);
    check();
    if (result.issues.length) return { status: 'blocked', issues: result.issues };
    ports.navigate(5);
    return { status: 'complete', issues: [] };
  } catch (error) {
    return signal.aborted
      ? { status: 'stopped', issues: [] }
      : { status: 'blocked', issues: [error instanceof Error ? error.message : 'Automatic annotation failed.'] };
  }
}
