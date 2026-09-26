// Five-page flow: setup, samples/groups, runs/files, protocol, review.
const REVIEW_STEP = 4;

import type { AutomationReport, WizardActionCard } from '../models/assistant';

export interface AutoTurn {
  cards: WizardActionCard[];
  report?: AutomationReport | null;
}

export interface AutoValidation {
  issues: string[];
}

export interface AutoActionFailure {
  code: string;
  message: string;
  repairable: boolean;
  argumentPath?: string;
  allowedValues?: string[];
  allowedLabelsByKit?: Record<string, string[]>;
  editablePaths?: Array<Array<string | number>>;
  contract?: unknown;
}

export interface AutoRepairRequest {
  step: number;
  card: WizardActionCard;
  batch: WizardActionCard[];
  failure: AutoActionFailure;
  attempt: number;
}

export interface AutoRepairEvent {
  request: AutoRepairRequest;
  status: 'requested' | 'accepted' | 'rejected';
  replacements: WizardActionCard[];
  message: string;
}

export interface AutoBatchFailure {
  failedCardId: string;
  attemptedIds: string[];
}

/** Side effects are injected so cancellation and transactions are testable. */
export interface AutoAnnotationPorts<Snapshot> {
  snapshot(): Snapshot;
  restore(snapshot: Snapshot): void;
  fingerprint(): string;
  navigate(step: number): void;
  request(step: number): Promise<AutoTurn>;
  apply(card: WizardActionCard): Promise<void>;
  record(cards: WizardActionCard[], applied: boolean, error?: string, failure?: AutoBatchFailure): void;
  describeFailure?(card: WizardActionCard, error: unknown): AutoActionFailure;
  repair?(request: AutoRepairRequest): Promise<AutoTurn>;
  repairEvent?(event: AutoRepairEvent): void;
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
  const current = Math.min(REVIEW_STEP, Math.max(0, resume
    ? resume.step + (resume.manuallyCompleted ? 1 : 0) : currentStep));
  for (let step = 0; step < current; step++) {
    if (errors(step).length) return step;
  }
  return current;
}

// Stable tiers cover dependencies without reordering operations within a tier.
const ORDER: Record<string, number> = {
  setTechnologyTemplate: 0, setSampleTemplate: 1, setSampleTemplates: 1, setExperimentTemplates: 2,
  setSampleCount: 3, setBiologicalReplicates: 0, addCharacteristicChoice: 1,
  applyCharacteristicDraft: 2, setSampleCharacteristicValue: 2, applyRoundRobin: 2, setFactors: 3,
  addFactor: 3, setNoStudyFactors: 3, addFactorValue: 4, setSourceNames: 0,
  autoGenerateSourceNames: 0, setLabelConfig: 0,
  replaceWithUnassignedFileNames: 1, autoPackSamplesIntoRuns: 2,
  applyRunsFilesPlan: 3, assignDataFilesToRun: 4, assignFilesToRunsByName: 4,
  setRunFactorValue: 5,
};

export function actionKey(card: WizardActionCard): string {
  return stableJson([card.action.step, card.action.op, card.action.args]);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
}

/** setFactors replaces the entire factor list: only the latest definition in this turn applies.
 * Scoped protocol cards and incremental factor edits must never be collapsed.
 */
export function effectiveTurnCards(cards: WizardActionCard[]): WizardActionCard[] {
  const lastFactors = new Map<string, string>();
  for (const card of cards) {
    if (card.action.op === 'setFactors') lastFactors.set(card.action.step, card.id);
  }
  return cards.filter(card => card.action.op !== 'setFactors' || lastFactors.get(card.action.step) === card.id);
}

export function orderAutoCards(cards: WizardActionCard[]): WizardActionCard[] {
  return effectiveTurnCards(cards).sort((a, b) => (ORDER[a.action.op] ?? 10) - (ORDER[b.action.op] ?? 10));
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

// Bound retries across replacement IDs and across the entire automatic run.
const MAX_CARD_REPAIRS = 2;
const MAX_RUN_REPAIRS = 6;

/** Replacement must target the same operation and the same sample/column/factor. */
export function repairScopeError(original: WizardActionCard, replacement: WizardActionCard, failure?: AutoActionFailure): string | null {
  if (replacement.id === original.id || replacement.action.step !== original.action.step
    || replacement.action.op !== original.action.op) return 'Repair must replace exactly the failed operation in the same step.';
  const identityArgs: Record<string, number[]> = {
    addCharacteristicChoice: [0], applyCharacteristicDraft: [0], applyRoundRobin: [0],
    setSampleCharacteristicValue: [0, 1], setSampleFactorValue: [0, 1],
    setProtocolValue: [0, 2],
    setFactorColumnValues: [0], setRunFactorValue: [0, 1], addFactorValue: [0],
  };
  for (const index of identityArgs[original.action.op] || []) {
    if (JSON.stringify(original.action.args[index]) !== JSON.stringify(replacement.action.args[index])) {
      return 'Repair changed the target sample, column, factor or file scope; automatic replacement is not allowed.';
    }
  }
  if (failure?.editablePaths) {
    const mask = (args: unknown[]) => {
      const copy = structuredClone(args);
      for (const path of failure.editablePaths!) {
        let parent: any = copy;
        for (const key of path.slice(0, -1)) parent = parent?.[key];
        if (!parent || typeof parent !== 'object') return null;
        parent[path[path.length - 1]] = '__repair_target__';
      }
      return stableJson(copy);
    };
    if (mask(original.action.args) === null || mask(original.action.args) !== mask(replacement.action.args)) {
      return 'Repair changed arguments outside the reported failure paths.';
    }
  }
  return null;
}

/** One generation per step; bounded repairs replace only a failed action, then replay the transaction. */
export async function runAutoAnnotation<S>(
  ports: AutoAnnotationPorts<S>, signal: AbortSignal,
  startStep = 0,
): Promise<AutoAnnotationOutcome> {
  const check = () => { if (signal.aborted) throw new Error('Stopped'); };
  let repairCount = 0;
  try {
    for (let step = startStep; step < REVIEW_STEP; step++) {
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
      let batch = orderAutoCards(turn.cards);
      const attempts = new Map<string, number>();
      const failedKeys = new Set<string>();
      let applicationError = '';
      while (true) {
        const seen = new Set<string>();
        const attemptedIds: string[] = [];
        let failedCard: WizardActionCard | undefined;
        let caught: unknown;
        applicationError = '';
        try {
          for (const card of batch) {
            check();
            const key = actionKey(card);
            if (seen.has(key)) continue;
            failedCard = card;
            attemptedIds.push(card.id);
            await ports.apply(card);
            check();
            seen.add(key);
          }
          failedCard = undefined;
        } catch (error) {
          ports.restore(structuredClone(snapshot));
          caught = error;
          applicationError = error instanceof Error ? error.message : 'Could not apply action batch.';
          ports.record(batch, false, `Batch rolled back: ${applicationError}`, failedCard ? {
            failedCardId: failedCard.id, attemptedIds,
          } : undefined);
          check();
        }
        if (!applicationError || !failedCard) break;
        const failure = ports.describeFailure?.(failedCard, caught);
        // Evidence blockers must not be erased by a technically successful repair.
        if (!ports.repair || !failure?.repairable || turn.report.status === 'blocked' || turn.report.issues.length) break;
        const previousAttempts = attempts.get(failedCard.id) || 0;
        if (previousAttempts >= MAX_CARD_REPAIRS || repairCount >= MAX_RUN_REPAIRS) {
          applicationError += ' Automatic repair limit reached.';
          break;
        }
        const key = actionKey(failedCard);
        if (failedKeys.has(key)) {
          applicationError += ' Repeated failing arguments; automatic repair stopped.';
          break;
        }
        failedKeys.add(key);
        const request: AutoRepairRequest = {
          step, card: failedCard, batch, failure, attempt: previousAttempts + 1,
        };
        repairCount++;
        ports.progress(`Repairing ${failedCard.action.label} (attempt ${request.attempt}/${MAX_CARD_REPAIRS})`);
        ports.repairEvent?.({ request, status: 'requested', replacements: [], message: failure.message });
        const beforeRepair = ports.fingerprint();
        let repaired: AutoTurn;
        try {
          repaired = await waitForAutoTask(ports.repair(request).then(result => {
            if (signal.aborted) ports.repairEvent?.({ request, status: 'rejected', replacements: result.cards, message: 'Repair cancelled.' });
            return result;
          }), signal);
        } catch (error) {
          applicationError += ` Repair request failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
          ports.repairEvent?.({ request, status: 'rejected', replacements: [], message: applicationError });
          check();
          break;
        }
        check();
        let rejection = beforeRepair !== ports.fingerprint()
          ? 'Wizard changed while the repair was pending; replacement was not applied.'
          : !repaired.report ? 'Repair response has no completion report.'
          : repaired.report.status !== 'ready' || repaired.report.issues.length
            ? `Repair needs evidence or user input: ${repaired.report.issues.join(' ')}`
            : repaired.cards.length !== 1 ? 'Repair must return exactly one replacement card.'
            : repairScopeError(failedCard, repaired.cards[0], failure);
        const replacement = repaired.cards[0];
        if (!rejection && (batch.some(c => c.id === replacement.id)
          || failedKeys.has(actionKey(replacement)))) rejection = 'Repair repeats failing arguments or an existing card; automatic repair stopped.';
        if (rejection) {
          ports.repairEvent?.({ request, status: 'rejected', replacements: repaired.cards, message: rejection });
          applicationError += ` ${rejection}`;
          break;
        }
        attempts.set(replacement.id, request.attempt);
        ports.repairEvent?.({ request, status: 'accepted', replacements: [replacement], message: 'Replacement accepted for transaction replay.' });
        batch = batch.map(c => c.id === failedCard!.id ? replacement : c);
        ports.notes?.(step, [`Auto repair ${request.attempt}: replaced ${failedCard.id} with ${replacement.id} (${failedCard.action.op}).`]);
        ports.progress(`Replaying wizard step ${step + 1} with the repaired card…`);
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
    ports.navigate(REVIEW_STEP);
    return { status: 'complete', issues: [] };
  } catch (error) {
    return signal.aborted
      ? { status: 'stopped', issues: [] }
      : { status: 'blocked', issues: [error instanceof Error ? error.message : 'Automatic annotation failed.'] };
  }
}
