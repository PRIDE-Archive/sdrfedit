import type { AutomationReport, WizardActionCard } from '../models/assistant';

export interface AutoTurn {
  cards: WizardActionCard[];
  report?: AutomationReport | null;
}

export interface AutoValidation {
  issues: string[];
  repairStep?: number;
}

/** Side effects are injected so cancellation, transactions and retries are testable. */
export interface AutoAnnotationPorts<Snapshot> {
  snapshot(): Snapshot;
  restore(snapshot: Snapshot): void;
  fingerprint(): string;
  navigate(step: number): void;
  request(step: number, feedback: string[]): Promise<AutoTurn>;
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

/** Resume at the displayed step unless an earlier step is actually incomplete. */
export function autoAnnotationStartStep(currentStep: number, errors: (step: number) => string[]): number {
  const current = Math.min(5, Math.max(0, currentStep));
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

/** Five mutation steps followed by final SDRF validation. Never runs implicitly. */
export async function runAutoAnnotation<S>(
  ports: AutoAnnotationPorts<S>, signal: AbortSignal,
  startStep = 0,
): Promise<AutoAnnotationOutcome> {
  const check = () => { if (signal.aborted) throw new Error('Stopped'); };
  let lastCommittedBatch = '';
  let lastCommittedState = '';
  let step = startStep;
  let feedback: string[] = [];
  let finalRepairs = 0;
  try {
    while (true) {
      for (; step < 5; step++) {
        check();
        ports.navigate(step);
        let finished = false;
        for (let attempt = 0; attempt < 3; attempt++) {
          check();
          ports.progress(`Annotating wizard step ${step + 1}${attempt ? ` · repair ${attempt} of 2` : ''}`);
          const beforeRequest = ports.fingerprint();
          const turn = await ports.request(step, feedback);
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
          const batchKey = JSON.stringify(batch.map(actionKey));
          const alreadyApplied = batchKey === lastCommittedBatch && beforeRequest === lastCommittedState;
          let applicationError = '';
          try {
            for (const card of batch) {
              check();
              const key = actionKey(card);
              if (alreadyApplied || seen.has(key)) continue;
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
            lastCommittedBatch = batchKey;
            lastCommittedState = ports.fingerprint();
            ports.record(batch, true);
          }
          feedback = [
            ...(applicationError ? [applicationError] : []),
            ...turn.report.issues,
            ...ports.errors(step),
          ];
          if (turn.report.status === 'blocked' && !turn.report.issues.length) {
            feedback.push('The assistant could not establish that this step is complete.');
          }
          if (!feedback.length) { finished = true; break; }
          if (attempt > 0 && beforeRequest === ports.fingerprint()) break;
        }
        if (!finished) return { status: 'blocked', issues: feedback };
        feedback = [];
      }
      check();
      ports.progress('Generating SDRF and validating selected templates…');
      const result = await waitForAutoTask(ports.validate(), signal);
      check();
      if (!result.issues.length) {
        ports.navigate(5);
        return { status: 'complete', issues: [] };
      }
      if (result.repairStep === undefined || finalRepairs++ >= 2) {
        return { status: 'blocked', issues: result.issues };
      }
      step = result.repairStep;
      feedback = result.issues;
      // Final validation may require correcting an earlier successful mutation.
      lastCommittedBatch = '';
      lastCommittedState = '';
    }
  } catch (error) {
    return signal.aborted
      ? { status: 'stopped', issues: [] }
      : { status: 'blocked', issues: [error instanceof Error ? error.message : 'Automatic annotation failed.'] };
  }
}
