/** Failure feedback for bounded, single-card automatic repair. */
import type { WizardActionCard } from '../../models/assistant';
import { LABEL_CONFIGS } from '../../models/wizard';
import type { AutoActionFailure, AutoRepairRequest } from '../../utils/auto-annotation';
import { ACTION_CONTRACTS } from './action-contracts.generated';
import { WizardActionError } from './wizard-action-args';

export function describeActionFailure(card: WizardActionCard, error: unknown): AutoActionFailure {
  const message = error instanceof Error ? error.message : String(error);
  const contract = ACTION_CONTRACTS[card.action.op];
  if (error instanceof WizardActionError && card.action.op === 'setLabelConfig' && message.startsWith('Unknown plex kit')) {
    return { code: 'INVALID_ENUM', message, repairable: true, argumentPath: 'args[0]',
      allowedValues: LABEL_CONFIGS.map(config => config.id), editablePaths: [[0]], contract };
  }
  if (card.action.op === 'applyRunsFilesPlan' && /^(Unknown label kit for |Invalid or duplicate channel:)/.test(message)) {
    const plan = card.action.args[0] as { groups?: Array<{ labelConfigId?: string; channels?: Array<{ label?: string }> }> } | undefined;
    const editablePaths: Array<Array<string | number>> = [];
    for (const [index, group] of (plan?.groups || []).entries()) {
      const kit = LABEL_CONFIGS.find(config => config.id === group.labelConfigId);
      if (!kit) editablePaths.push([0, 'groups', index, 'labelConfigId']);
      const labels: readonly string[] = kit?.labels || LABEL_CONFIGS.flatMap(config => config.labels);
      for (const [channelIndex, channel] of (group.channels || []).entries()) {
        if (!labels.includes(channel.label || '')) editablePaths.push([0, 'groups', index, 'channels', channelIndex, 'label']);
      }
    }
    return { code: 'INVALID_ENUM', message, repairable: editablePaths.length > 0,
      argumentPath: 'args[0].groups: invalid labelConfigId/channel label fields only', editablePaths,
      allowedValues: LABEL_CONFIGS.map(config => config.id),
      allowedLabelsByKit: Object.fromEntries(LABEL_CONFIGS.map(config => [config.id, [...config.labels]])), contract };
  }
  if (/existing candidates or file assignments are protected/.test(message)) {
    return { code: 'EVIDENCE_OR_STATE_REQUIRED', message, repairable: false, contract };
  }
  // Missing scientific evidence/candidates must not be invented to pass validation.
  if (/evidence|candidate|ontology|Unknown template|different wizard step/i.test(message)) {
    return { code: 'EVIDENCE_OR_STATE_REQUIRED', message, repairable: false, contract };
  }
  if (error instanceof WizardActionError && contract) {
    return { code: 'INVALID_ARGUMENTS', message, repairable: true, contract };
  }
  if (/^(Unknown (?:raw file|file|source name|run|MS run|group)|Expected exactly one run named)/i.test(message)) {
    return { code: 'INVALID_REFERENCE', message, repairable: true, contract };
  }
  return { code: 'APPLICATION_ERROR', message, repairable: false, contract };
}

export function buildActionRepairPrompt(request: AutoRepairRequest): string {
  return [
    'Repair exactly ONE failed recommendation card. This is not a request to regenerate the wizard step.',
    'The entire batch was rolled back. The CURRENT wizard snapshot is the state BEFORE this batch; preceding cards in the preserved batch have NOT yet been reapplied.',
    'Return exactly one corrected action with the SAME op and step as the failed card. Preserve the target sample, column and factor. Do not return the other batch actions.',
    'Correct only the reported argument/reference defect using existing evidence and allowed values. Do not change the experiment, sample count, templates, source identities or scientific assignments to bypass validation. Do not invent evidence or re-download documents already available in this session.',
    'If repair requires changing other cards or missing scientific evidence, return no actions and an automation report with status blocked and concrete issues. Otherwise return the one replacement and a ready automation report; ready here means only that replacement is ready to retry, not that the whole step is complete.',
    'The executor will replace the original failed card and replay the preserved batch, then recheck the step. Acknowledge relevant evidence in the replacement reasoning/citations.',
    JSON.stringify({ repairAttempt: request.attempt, failedCardId: request.card.id,
      failedAction: request.card.action, failure: request.failure,
      preservedBatch: request.batch.map(card => ({ id: card.id, action: card.action })) }, null, 2),
  ].join('\n\n');
}
