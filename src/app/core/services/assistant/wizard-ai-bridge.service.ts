import { characteristicValueError } from '../../models/wizard';
import { PROTOCOL_COLUMNS, protocolColumns, protocolField, protocolCompletionErrors } from '../../utils/protocol-fields';
import { planProtocolValue } from '../../utils/protocol-actions';
/**
 * Bridge between assistant suggestions and the wizard state.
 *
 * Two responsibilities:
 *  - summarise the wizard for the backend (`buildSnapshot`), so the assistant
 *    proposes deltas instead of resetting fields the user already filled in;
 *  - validate and apply one approved action (`applyAction`), plus render the
 *    before/after text the panel shows before the user approves it.
 *
 * Called by manual Apply or by an explicitly started automatic annotation run.
 */

import { genericTemplateColumns, templateFieldValue, templateOptions } from '../../utils/template-fields';

import { Injectable, inject } from '@angular/core';

import { WizardAction, WizardSnapshot } from '../../models/assistant';
import { getSpecialtyCharacteristicKey, isWizardSkippedCharacteristic, factorCandidates, factorDefinitionErrors, LABEL_CONFIGS, WIZARD_STEPS, resolveRunSampleIndices } from '../../models/wizard';
import { WizardStateService } from '../wizard-state.service';
import { TemplateService } from '../template.service';
import {
  WizardActionError,
  validateActionArgs,
  asAssignments,
  asProtocolValue,
  asProtocolScope,
  asAcquisitionMethod,
  asBiologicalReplicates,
  asFileUrls,
  asCharacteristicDraft,
  asBoolean,
  asFactor,
  asFactors,
  asNamedRunFileAssignments,
  asNumber,
  asNumberArray,
  asString,
  asStringArray,
  optionalOntologyTerm,
} from './wizard-action-args';

export { WizardActionError } from './wizard-action-args';

@Injectable({ providedIn: 'root' })
export class WizardAiBridgeService {
  private readonly wizardState = inject(WizardStateService);
  private readonly templates = inject(TemplateService);

  /** Which wizard step index an action belongs to, for the "go to step" affordance. */
  private validateFactorProposal(factors: import('../../models/wizard').WizardFactor[]): void {
    const errors = factorDefinitionErrors({ ...this.wizardState.getState(), factors });
    if (errors.length) throw new WizardActionError(errors.join(' '));
  }

  stepIndexOf(action: WizardAction): number {
    const index = WIZARD_STEPS.findIndex(step => step.id === (action.step === 'characteristics' ? 'samples' : action.step));
    return index >= 0 ? index : 0;
  }

  // ------------------------------------------------------------------ snapshot

  buildSnapshot(includeAssignments = true): WizardSnapshot {
    const state = this.wizardState.getState();
    const stepIndex = this.wizardState.currentStep();

    const choices: Record<string, string[]> = {};
    for (const [column, list] of Object.entries(state.characteristicChoices || {})) {
      choices[column] = list.map(choice => choice.value);
    }

    const multiValueCharacteristicColumns = Object.entries(state.characteristicChoices || {})
      .filter(([, list]) => (list?.length || 0) >= 2)
      .map(([column]) => column)
      .sort();

    const enabledFactors = (state.factors || []).filter(
      factor => factor.enabled && (factor.name || '').trim()
    );
    const factorDefinitions = enabledFactors.map(factor => ({
      name: factor.name.trim(),
      values: factorCandidates(state, factor),
      sourceCharacteristic: factor.sourceCharacteristic,
      reasoning: factor.reasoning,
      scope: factor.scope || 'sample',
    }));
    const multiValueFactorColumns = factorDefinitions
      .filter(factor => factor.scope !== 'run' && !factor.sourceCharacteristic && factor.values.length >= 2)
      .map(factor => factor.name);

    const samplesByIndex = new Map(state.samples.map(sample => [sample.index, sample]));
    const msRunSummaries = (state.msRuns || []).map(run => ({
      name: run.name,
      factorValues: run.factorValues || {},
      sampleMappingMode: run.sampleMappingMode,
      labelConfigId: run.labelConfigId || state.labelConfigId,
      channels: run.channels.map(ch => ({label: ch.label, role: ch.role, mappingId: ch.mappingId, pooledSourceNames: (ch.pooledSampleIndices || []).map(index => samplesByIndex.get(index)?.sourceName || ''), sourceNameOverride: ch.sourceNameOverride, sourceName: samplesByIndex.get(ch.sampleIndex ?? -1)?.sourceName})),
      files: state.dataFiles.filter(f => f.runId === run.id).map(f => ({fileName: f.fileName, mappingId: f.mappingId, sourceName: samplesByIndex.get(f.sampleIndex ?? -1)?.sourceName, fractionId: f.fractionId ?? 1, technicalReplicate: f.technicalReplicate ?? 1})),
      sampleSourceNames: resolveRunSampleIndices(run)
        .map(index => samplesByIndex.get(index)?.sourceName?.trim() || '')
        .filter(Boolean),
    }));
    const dataFileNames = state.dataFiles.map(file => file.fileName || '').filter(Boolean);
    const unassignedFileNames = state.dataFiles
      .filter(file => !file.runId && file.sampleIndex == null)
      .map(file => file.fileName || '')
      .filter(Boolean);

    return {
      currentStep: stepIndex,
      currentStepId: (WIZARD_STEPS[stepIndex]?.id as WizardSnapshot['currentStepId']) ?? null,
      sampleTemplate: state.sampleTemplate ?? null,
      sampleMetadataTemplates: state.sampleMetadataTemplates || [],
      templateSnapshotId: state.templateSnapshotId,
      selectedTemplates: state.selectedTemplates,
      technologyTemplate: state.technologyTemplate ?? null,
      experimentTemplates: state.experimentTemplates || [],
      sampleCount: state.sampleCount,
      experimentDescription: state.experimentDescription || '',
      characteristicColumns: (state.characteristicColumns || []).filter(column =>
        !isWizardSkippedCharacteristic(column.name) && getSpecialtyCharacteristicKey(column.name) !== 'material type'
      ).map(column => ({
        name: column.name,
        requirement: column.requirement || 'optional',
        ontologies: column.ontologies || [],
      })),
      protocolFields: Object.fromEntries(protocolColumns(state).map(column => [column.name, structuredClone(protocolField(state, column.name))])),
      protocolIssues: protocolCompletionErrors(state),
      protocolColumns: protocolColumns(state).map(column => ({
        name: column.name, requirement: column.requirement || 'optional',
      })),
      genericProtocolFields: protocolColumns(state).filter(column => genericTemplateColumns(state).some(c => c.name === column.name)).map(column => ({
        name: column.name, requirement: column.requirement || 'optional', description: column.description || '',
        value: templateFieldValue(state, column), options: templateOptions(column),
        type: column.type, validators: column.validators || [],
        allowNotAvailable: column.allowNotAvailable, allowNotApplicable: column.allowNotApplicable,
      })),
      characteristicChoices: choices,
      sampleSourceNames: (state.samples || []).map(sample => sample.sourceName),
      ...(includeAssignments ? {
        sampleAssignments: state.samples.map((sample, index) => ({
          index, sourceName: sample.sourceName, biologicalReplicate: sample.biologicalReplicate,
          characteristicValues: sample.characteristicValues || {}, factorValues: sample.factorValues || {},
        })),
      } : {}),
      biologicalReplicates: (state.samples || []).map(sample => sample.biologicalReplicate),
      multiValueCharacteristicColumns,
      labelConfigId: state.labelConfigId ?? null,
      availableLabelConfigs: LABEL_CONFIGS.map(config => ({ ...config, labels: [...config.labels] })),
      msRunCount: (state.msRuns || []).length,
      msRunSummaries,
      dataFileCount: state.dataFiles.length,
      dataFileNames,
      unassignedFileCount: unassignedFileNames.length,
      unassignedFileNames,
      hasFractions: state.hasFractions,
      fractionCount: state.fractionCount,
      technicalReplicates: state.technicalReplicates,
      instrument: state.instrument ? `${state.instrument.label} (${state.instrument.id})` : null,
      cleavageAgent: state.cleavageAgent ? `${state.cleavageAgent.name} (${state.cleavageAgent.msAccession})` : null,
      precursorMassTolerance: state.precursorMassTolerance,
      fragmentMassTolerance: state.fragmentMassTolerance,
      modifications: state.modifications.map(
        modification => `${modification.name} ${modification.type} on ${modification.targetAminoAcids}`
      ),
      factors: factorDefinitions.map(factor => factor.name),
      factorDefinitions,
      factorDecision: state.factorDecision,
      noFactorReason: state.noFactorReason,
      multiValueFactorColumns,
      acquisitionMethod: state.acquisitionMethod ?? null,
    };
  }

  private protocolActionPlan(op: string, args: unknown[]) {
    const legacyNames: Record<string, string> = {
      setInstrument: PROTOCOL_COLUMNS.instrument, setCleavageAgent: PROTOCOL_COLUMNS.cleavageAgent,
      setModifications: PROTOCOL_COLUMNS.modifications, setPrecursorMassTolerance: PROTOCOL_COLUMNS.precursorMassTolerance,
      setFragmentMassTolerance: PROTOCOL_COLUMNS.fragmentMassTolerance,
    };
    const scoped = op === 'setProtocolValue';
    const generic = op === 'setTemplateValue';
    if (!scoped && !generic && !legacyNames[op]) return null;
    const name = scoped || generic ? asString(args[0]).trim() : legacyNames[op];
    try {
      if (generic && !genericTemplateColumns(this.wizardState.getState()).some(column => column.name === name)) {
        throw new Error(`No editable protocol field named ${name} in the selected templates.`);
      }
      const value = asProtocolValue(name, args[scoped || generic ? 1 : 0]);
      const scope = scoped ? asProtocolScope(args[2]) : 'all';
      return { name, ...planProtocolValue(this.wizardState.getState(), name, value, scope, !scoped) };
    } catch (error) {
      throw new WizardActionError(error instanceof Error ? error.message : String(error));
    }
  }

  private validateCharacteristicAction(op: string, args: unknown[]): void {
    if (op === 'applyCharacteristicDraft') {
      const { column, choices } = asCharacteristicDraft(args);
      if (!this.wizardState.getState().characteristicColumns.some(c => c.name === column)) throw new WizardActionError('This attribute is no longer available.');
      for (const choice of choices) {
        const error = characteristicValueError(this.wizardState.getState(), column, choice.value);
        if (error) throw new WizardActionError(error);
      }
      return;
    }
    if (!['addCharacteristicChoice', 'setSampleCharacteristicValue'].includes(op)) return;
    const state = this.wizardState.getState();
    const name = asString(args[op === 'addCharacteristicChoice' ? 0 : 1]);
    const value = asString(args[op === 'addCharacteristicChoice' ? 1 : 2]).trim();
    const error = characteristicValueError(state, name, value);
    // Clearing an assignment is allowed; unknown fields never are.
    if (error && (value || !state.characteristicColumns.some(c => c.name === name))) throw new WizardActionError(error);
    if (op === 'setSampleCharacteristicValue' && value && !this.wizardState.getChoices(name).some(c => c.value.trim().toLowerCase() === value.toLowerCase())) {
      throw new WizardActionError('Choose sample values from the defined options.');
    }
  }

  // ------------------------------------------------------------------- preview

  /** Complete "current → proposed" description for a suggestion card. */
  previewAction(action: WizardAction): string {
    const state = this.wizardState.getState();
    try {
      const args = validateActionArgs(action.op, action.args, state.sampleCount);
      this.validateCharacteristicAction(action.op, args);
      const protocolPlan = this.protocolActionPlan(action.op, args);
      if (protocolPlan) return protocolPlan.preview;
      switch (action.op) {
        case 'setTechnologyTemplate':
          return change(state.technologyTemplate, asString(args[0]));
        case 'setSampleTemplate':
          return change(state.sampleTemplate, args[0] === null ? "(none — generic sample)" : asString(args[0]));
        case 'setSampleTemplates':
          return change([state.sampleTemplate, ...(state.sampleMetadataTemplates || [])].filter(Boolean).join(', '), asStringArray(args[0]).join(', '));
        case 'setExperimentTemplates':
          return change((state.experimentTemplates || []).join(', ') || '(none)', asStringArray(args[0]).join(', '));
        case 'setSampleCount':
          return change(String(state.sampleCount), String(asNumber(args[0])));
        case 'setExperimentDescription':
          return change(state.experimentDescription, asString(args[0]));
        case 'applyCharacteristicDraft': {
          const { column, choices, assignments } = asCharacteristicDraft(args);
          const sampleNames = state.samples.map(sample => sample.sourceName);
          return `${column}: ${choices.map(choice => choice.value).join(', ') || '(no values)'}\n`
            + assignments.map((value, i) => `${sampleNames[i] || 'Sample ' + (i + 1)}: ${state.samples[i]?.characteristicValues?.[column] || '(unassigned)'} → ${value || '(unassigned)'}`).join('\n');
        }
        case 'addCharacteristicChoice': {
          const column = asString(args[0]);
          const existing = this.wizardState.getChoices(column).map(choice => choice.value);
          const value = asString(args[1]);
          const term = optionalOntologyTerm(args[2]);
          const proposed = term ? `${value} [${term.id}]` : value;
          return existing.includes(value)
            ? `${column}: "${value}" is already a candidate`
            : `${column}: add "${proposed}" (existing: ${existing.join(', ') || 'none'})`;
        }
        case 'setSampleCharacteristicValue': {
          const index = asNumber(args[0]);
          const column = asString(args[1]);
          const current = state.samples[index]?.characteristicValues?.[column] || '(empty)';
          return `sample ${index + 1} ${column}: ${current} → ${asString(args[2])}`;
        }
        case 'applyRoundRobin': {
          const column = asString(args[0]);
          const values = this.wizardState.getChoices(column).map(choice => choice.value);
          return `Distribute [${values.join(', ')}] across ${state.samples.length} samples for ${column}`;
        }
        case 'autoGenerateSourceNames':
          return `Rename ${state.samples.length} source names using pattern "${asString(args[0])}"`;
        case 'setSourceNames': {
          const names = asStringArray(args[0]);
          return `Set ${names.length} source names:\n${names.map((name, index) => `${index + 1}. ${name}`).join('\n')}`;
        }
        case 'setBiologicalReplicates': {
          const reps = asBiologicalReplicates(args, state.sampleCount);
          const unique = new Set(reps).size;
          return `Set biological replicates for ${reps.length} samples (${unique} distinct number${
            unique === 1 ? '' : 's'
          }): [${reps.join(', ')}]`;
        }
        case 'setLabelConfig':
          return change(labelName(state.labelConfigId), labelName(asString(args[0])));
        case 'applyRunsFilesPlan': {
          const plan = args[0] as {groups: {name: string; labelConfigId: string; channels: {label: string; sourceName?: string; mappingId?: string; pooledSourceNames?: string[]}[]; factorValues?: Record<string,string>; files: {fileName: string; mappingId?: string; fractionId: number; technicalReplicate: number}[]}[]};
          return plan.groups.map(group => {
            const existing = state.msRuns.find(r => r.name === group.name);
            const before = existing ? `Current: ${existing.channels.map(c => `${c.label} → ${state.samples.find(s => s.index === c.sampleIndex)?.sourceName || c.role}`).join(', ')}; factors ${JSON.stringify(existing.factorValues || {})}\n` : '';
            return `${existing ? 'Update' : 'Create'} group ${group.name} (${labelName(group.labelConfigId)})\n${before}` +
              group.channels.map(c => `${c.label}${c.mappingId ? ' [' + c.mappingId + ']' : ''} → ${c.pooledSourceNames?.length ? 'pool: ' + c.pooledSourceNames.join(' + ') : c.sourceName}`).join('\n') + '\n' +
              Object.entries(group.factorValues || {}).map(([k,v]) => `${k}: ${v}`).join('\n') + '\n' +
              group.files.map(f => {
                const old = state.dataFiles.find(old => old.fileName === f.fileName);
                const oldGroup = state.msRuns.find(r => r.id === old?.runId)?.name || 'pool';
                return `${f.fileName}: ${oldGroup} (F=${old?.fractionId ?? 1}, Tech=${old?.technicalReplicate ?? 1}) → ${group.name}${f.mappingId ? ' [' + f.mappingId + ']' : ''} (F=${f.fractionId}, Tech=${f.technicalReplicate})`;
              }).join('\n');
          }).join('\n\n');
        }
        case 'autoPackSamplesIntoRuns':
          return `Pack unassigned samples, preserving existing groups, using ${labelName(state.labelConfigId)}`;
        case 'replaceWithUnassignedFileNames': {
          const names = asStringArray(args[0]);
          const urls = asFileUrls(args[1]);
          return `Replace unassigned pool (preserve assigned files) with ${names.length} file(s):\n${names.map(name => urls[name] ? `${name} → ${urls[name]}` : name).join('\n')}`;
        }
        case 'assignDataFilesToRun': {
          const indices = asNumberArray(args[0]);
          return `Assign file indices [${indices.join(', ')}] to run "${asString(args[1])}"`;
        }
        case 'assignFilesToRunsByName': {
          const groups = asNamedRunFileAssignments(args[0]);
          const fileCount = groups.reduce((sum, group) => sum + group.files.length, 0);
          const preview = groups
            .map(group => `${group.runName}:\n${group.files.map(file => `  ${file.fileName} (fraction ${file.fractionId}, technical replicate ${file.technicalReplicate})`).join('\n')}`)
            .join('\n');
          return `Assign ${fileCount} file(s) across ${groups.length} run(s):\n${preview}`;
        }
        case 'setHasFractions':
          return change(String(state.hasFractions), String(asBoolean(args[0])));
        case 'setFractionCount':
          return change(String(state.fractionCount), String(asNumber(args[0])));
        case 'setTechnicalReplicates':
          return change(String(state.technicalReplicates), String(asNumber(args[0])));
        case 'setAcquisitionMethod':
          return change(state.acquisitionMethod, asAcquisitionMethod(args[0]));
        case 'setNoStudyFactors':
          return `Disable study factors and continue without them. Reason: ${asString(args[0])}`;
        case 'setRunFactorValue':
          return `Run ${asString(args[0])}: ${asString(args[1])} → ${asString(args[2])}`;
        case 'setFactors': {
          const factors = asFactors(args[0]);
          return change(
            state.factors
              .filter(factor => factor.enabled)
              .map(factor => `${factor.name}[${(factor.values || []).join('|')}]`)
              .join(', ') || '(none)',
            factors
              .filter(factor => factor.enabled)
              .map(factor => `${factor.name} (${factor.scope || 'sample'})[${factorCandidates(state, factor).join('|')}]${factor.sourceCharacteristic ? ' ← ' + factor.sourceCharacteristic : ''}${factor.reasoning ? ': ' + factor.reasoning : ''}`)
              .join(', ') || '(none)'
          );
        }
        case 'addFactor': {
          const factor = asFactor(args[0]);
          return `Add ${factor.scope || 'sample'} factor "${factor.name}" with values [${factorCandidates(state, factor).join(', ') || 'none'}]${factor.sourceCharacteristic ? ' from ' + factor.sourceCharacteristic : ' (independent groups)'}${factor.reasoning ? ' — ' + factor.reasoning : ''}`;
        }
        case 'addFactorValue':
          return `Add candidate "${asString(args[1])}" to factor "${asString(args[0])}"`;
        case 'setFactorColumnValues': {
          const factorName = asString(args[0]);
          const values = asAssignments(args[1]);
          return `Set factor "${factorName}" for ${values.length} samples:\n${values.map((value, index) => `${index + 1}. ${value}`).join('\n')}`;
        }
        case 'setSampleFactorValue': {
          const index = asNumber(args[0]);
          const factorName = asString(args[1]);
          const current = state.samples[index]?.factorValues?.[factorName] || '(empty)';
          return `sample ${index + 1} factor[${factorName}]: ${current} → ${asString(args[2])}`;
        }
        default:
          return `Unsupported operation "${action.op}"`;
      }
    } catch (error) {
      return error instanceof Error ? `Invalid suggestion: ${error.message}` : 'Invalid suggestion';
    }
  }

  // --------------------------------------------------------------------- apply

  /** Validate and apply one approved action. Throws `WizardActionError` on bad input. */
  async applyAction(action: WizardAction, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const args = validateActionArgs(action.op, action.args, this.wizardState.getState().sampleCount);
    this.validateCharacteristicAction(action.op, args);
    const protocolPlan = this.protocolActionPlan(action.op, args);
    if (protocolPlan) {
      this.wizardState.setProtocolField(protocolPlan.name, protocolPlan.field);
      return;
    }
    if (['setTechnologyTemplate', 'setSampleTemplate', 'setSampleTemplates', 'setExperimentTemplates'].includes(action.op)) {
      const names = action.op === 'setSampleTemplate' && args.length === 1 && args[0] === null
        ? [] : ['setExperimentTemplates', 'setSampleTemplates'].includes(action.op) ? asStringArray(args[0]) : [asString(args[0])];
      const allowed = action.op === 'setTechnologyTemplate' ? ['technology'] : ['setSampleTemplate', 'setSampleTemplates'].includes(action.op) ? ['sample'] : ['experiment'];
      for (const name of names) {
        const info = this.templates.getTemplateInfo(name);
        if (!info || !allowed.includes(info.layer || '')) throw new WizardActionError(`Unknown template or incorrect layer: ${name}`);
      }
    }
    if (action.op === 'setSampleCount' && (typeof args[0] !== 'number' || !Number.isInteger(args[0]) || args[0] < 1 || args[0] > 10000)) {
      throw new WizardActionError('Sample count must be an integer between 1 and 10000.');
    }

    switch (action.op) {
      case 'setTechnologyTemplate':
        this.wizardState.setTechnologyTemplate(asString(args[0]));
        await this.wizardState.refreshCharacteristicColumns(signal);
        return;

      case 'setSampleTemplate':
        this.wizardState.setSampleTemplate(args[0] === null ? null : asString(args[0]));
        await this.wizardState.refreshCharacteristicColumns(signal);
        return;

      case 'setSampleTemplates':
        this.wizardState.setSampleTemplates(asStringArray(args[0]));
        await this.wizardState.refreshCharacteristicColumns(signal);
        return;

      case 'setExperimentTemplates':
        this.wizardState.setExperimentTemplates(asStringArray(args[0]));
        await this.wizardState.refreshCharacteristicColumns(signal);
        return;

      case 'setSampleCount':
        this.wizardState.setSampleCount(asNumber(args[0]));
        return;

      case 'setExperimentDescription':
        this.wizardState.setExperimentDescription(asString(args[0]));
        return;

      case 'applyCharacteristicDraft': {
        const { column, choices, assignments } = asCharacteristicDraft(args);
        this.wizardState.applyCharacteristicDraft(column, choices, 'explicit', assignments);
        return;
      }

      case 'addCharacteristicChoice': {
        const column = asString(args[0]);
        const value = asString(args[1]);
        if (!this.wizardState.getState().characteristicColumns?.length) {
          await this.wizardState.refreshCharacteristicColumns(signal);
        }
        this.wizardState.addCharacteristicChoice(column, value, optionalOntologyTerm(args[2]));
        return;
      }

      case 'setSampleCharacteristicValue': {
        this.wizardState.ensureSamplesInitialized();
        const index = asNumber(args[0]);
        const samples = this.wizardState.getState().samples;
        if (index < 0 || index >= samples.length) {
          throw new WizardActionError(
            `Sample index ${index} is out of range (there are ${samples.length} samples).`
          );
        }
        this.wizardState.setSampleCharacteristicValue(index, asString(args[1]), asString(args[2]));
        return;
      }

      case 'applyRoundRobin': {
        const column = asString(args[0]);
        if (this.wizardState.getChoices(column).length === 0) {
          throw new WizardActionError(`No candidate values exist for ${column} yet.`);
        }
        this.wizardState.ensureSamplesInitialized();
        this.wizardState.applyRoundRobin(column);
        return;
      }

      case 'autoGenerateSourceNames':
        this.wizardState.ensureSamplesInitialized();
        this.wizardState.autoGenerateSourceNames(asString(args[0]) || 'sample_{n}');
        return;

      case 'setSourceNames': {
        this.wizardState.ensureSamplesInitialized();
        const names = asStringArray(args[0]);
        const samples = this.wizardState.getState().samples;
        if (names.length !== samples.length) {
          throw new WizardActionError(
            `Expected ${samples.length} source names (one per sample), got ${names.length}.`
          );
        }
        this.wizardState.setSamples(
          samples.map((sample, index) => ({
            ...sample,
            sourceName: names[index],
            index: index + 1,
          }))
        );
        this.wizardState.syncCharacteristicAssignments();
        return;
      }

      case 'setBiologicalReplicates': {
        const reps = asBiologicalReplicates(args, this.wizardState.getState().sampleCount);
        this.wizardState.ensureSamplesInitialized();
        const samples = this.wizardState.getState().samples;
        this.wizardState.setSamples(
          samples.map((sample, index) => ({
            ...sample,
            biologicalReplicate: reps[index],
          }))
        );
        return;
      }

      case 'setLabelConfig': {
        const configId = asString(args[0]);
        if (!LABEL_CONFIGS.some(config => config.id === configId)) {
          throw new WizardActionError(
            `Unknown plex kit "${configId}". Expected one of: ${LABEL_CONFIGS.map(c => c.id).join(', ')}.`
          );
        }
        this.wizardState.setLabelConfig(configId);
        return;
      }

      case 'applyRunsFilesPlan':
        this.wizardState.applyRunsFilesPlan(args[0]);
        return;

      case 'autoPackSamplesIntoRuns':
        this.wizardState.ensureSamplesInitialized();
        this.wizardState.autoPackSamplesIntoRuns();
        return;

      case 'replaceWithUnassignedFileNames':
        this.wizardState.replaceWithUnassignedFileNames(asStringArray(args[0]), asFileUrls(args[1]));
        return;

      case 'assignDataFilesToRun': {
        const indices = asNumberArray(args[0]);
        const runId = this.resolveRunId(asString(args[1]));
        const fileCount = this.wizardState.getState().dataFiles.length;
        const outOfRange = indices.filter(index => index < 0 || index >= fileCount);
        if (outOfRange.length) {
          throw new WizardActionError(
            `File indices ${outOfRange.join(', ')} are out of range (there are ${fileCount} files).`
          );
        }
        this.wizardState.assignDataFilesToRun(indices, runId);
        return;
      }

      case 'assignFilesToRunsByName': {
        const groups = asNamedRunFileAssignments(args[0]);
        const files = this.wizardState.getState().dataFiles;
        const knownNames = new Set(files.map(file => (file.fileName || '').trim()).filter(Boolean));
        const missing: string[] = [];
        const resolved = groups.map(group => {
          const runId = this.resolveRunId(group.runName);
          for (const file of group.files) {
            if (!knownNames.has(file.fileName)) missing.push(file.fileName);
          }
          return {
            runId,
            files: group.files,
          };
        });
        if (missing.length) {
          const shown = missing.join(', ');
          throw new WizardActionError(
            `Unknown file name(s) not in the wizard pool (${missing.length}): ${shown}. Apply replaceWithUnassignedFileNames first, or use exact names from the snapshot.`
          );
        }
        this.wizardState.assignDataFilesToRunsByName(resolved);
        return;
      }

      case 'setHasFractions':
        this.wizardState.setHasFractions(asBoolean(args[0]));
        return;

      case 'setFractionCount':
        this.wizardState.setFractionCount(asNumber(args[0]));
        return;

      case 'setTechnicalReplicates':
        this.wizardState.setTechnicalReplicates(asNumber(args[0]));
        return;

      case 'setAcquisitionMethod':
        this.wizardState.setAcquisitionMethod(asAcquisitionMethod(args[0]));
        return;

      case 'setNoStudyFactors': {
        const reason = asString(args[0]).trim();
        if (!reason) throw new WizardActionError('Explain why no study factors are being encoded.');
        this.wizardState.setFactorDecision('none', reason);
        return;
      }
      case 'setRunFactorValue':
        this.wizardState.setRunFactorValueByName(asString(args[0]), asString(args[1]), asString(args[2]));
        return;
      case 'setFactors':
        {
          const factors = asFactors(args[0]);
          this.validateFactorProposal(factors);
          this.wizardState.setFactors(factors);
        }
        return;

      case 'addFactor':
        {
          const factor = asFactor(args[0]);
          this.validateFactorProposal([...this.wizardState.getState().factors, factor]);
          this.wizardState.addFactor(factor);
        }
        return;

      case 'addFactorValue':
        this.wizardState.addFactorValueByName(asString(args[0]), asString(args[1]));
        return;

      case 'setFactorColumnValues': {
        const factorName = asString(args[0]);
        const values = asAssignments(args[1]);
        const count = this.wizardState.getState().samples.length;
        if (values.length !== count) {
          throw new WizardActionError(
            `Expected ${count} factor values for "${factorName}" (one per sample), got ${values.length}.`
          );
        }
        this.wizardState.setFactorColumnValues(factorName, values);
        return;
      }

      case 'setSampleFactorValue':
        this.wizardState.setSampleFactorValue(asNumber(args[0]), asString(args[1]), asString(args[2]));
        return;

      default:
        throw new WizardActionError(`Unsupported operation "${action.op}".`);
    }
  }

  /** Accept either a run id or a run name, since the model sees names in prose. */
  private resolveRunId(candidate: string): string {
    const runs = this.wizardState.getState().msRuns || [];
    const byId = runs.find(run => run.id === candidate);
    if (byId) return byId.id;

    const byName = runs.find(run => run.name.toLowerCase() === candidate.toLowerCase());
    if (byName) return byName.id;

    throw new WizardActionError(
      `No MS run matches "${candidate}". Existing runs: ${runs.map(run => run.name).join(', ') || 'none'}.`
    );
  }
}

// --------------------------------------------------------------------- helpers

function change(current: string | null | undefined, proposed: string): string {
  return `${current || '(empty)'} → ${proposed}`;
}

function labelName(configId: string | null | undefined): string {
  return LABEL_CONFIGS.find(config => config.id === configId)?.name || configId || '(none)';
}
