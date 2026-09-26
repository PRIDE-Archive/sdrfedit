import type { WizardActionCard, WizardSnapshot } from '../../models/assistant';

/** Omit only applied arguments exactly recoverable from the rendered current state. */
export function actionHistoryFeedback(card: WizardActionCard, snapshot: WizardSnapshot) {
  const { action } = card;
  const fields: Record<string, unknown> = {
    setSampleCount: snapshot.sampleCount,
    setTechnologyTemplate: snapshot.technologyTemplate,
    setPrecursorMassTolerance: snapshot.precursorMassTolerance,
    setFragmentMassTolerance: snapshot.fragmentMassTolerance,
  };
  // The backend renders only eight source names and sixteen replicates unless
  // detailed assignments are present. Never rely on a truncated preview.
  if (snapshot.sampleSourceNames && snapshot.sampleSourceNames.length <= 8) {
    fields['setSourceNames'] = snapshot.sampleSourceNames;
  }
  if (snapshot.biologicalReplicates && snapshot.biologicalReplicates.length <= 16) {
    fields['setBiologicalReplicates'] = snapshot.biologicalReplicates;
  }
  const recoverable = card.status === 'applied' && !card.executionState && !card.error
    && Object.hasOwn(fields, action.op) && fields[action.op] !== undefined
    && action.args.length === 1
    && JSON.stringify(action.args[0]) === JSON.stringify(fields[action.op]);
  return {
    op: action.op,
    ...(recoverable ? { argsFrom: 'current wizard state', label: action.label } : { args: action.args }),
    status: card.status,
    error: card.error,
  };
}
