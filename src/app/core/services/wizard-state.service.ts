/**
 * Wizard State Service
 *
 * Signal-based state management for the SDRF Creation Wizard.
 */

import { Injectable, signal, computed, inject } from '@angular/core';
import {
  WizardState,
  applyRunsFilesPlan,
  runPlaceholderSnapshot,
  WizardTemplate,
  WizardSampleEntry,
  WizardModification,
  WizardCleavageAgent,
  WizardDataFile,
  WizardFactor,
  WizardMsRun,
  WizardChannelAssignment,
  OntologyTerm,
  DynamicColumnDefault,
  WizardCharacteristicColumnMeta,
  CharacteristicChoice,
  WIZARD_STEPS,
  LABEL_CONFIGS,
  createEmptyWizardState,
  createDefaultSample,
  factorCandidates,
  factorDecisionValid,
  runFactorAssignmentsValid,
  factorDefinitionErrors,
  factorAssignmentsValid,
  normalizeFactor,
  getSampleTemplateId,
  hasCellLinesExperiment,
  isHumanTemplate,
  isCellLineTemplate,
  isVertebrateTemplate,
  isInvertebrateTemplate,
  isPlantTemplate,
  upsertDynamicColumnDefault,
  getSpecialtyCharacteristicKey,
  isWizardSkippedCharacteristic,
  addCharacteristicChoiceToMap,
  removeCharacteristicChoiceFromMap,
  getCharacteristicChoices,
  choiceValuesEqual,
  materializeSampleFieldsFromChoices,
  isLabelFree,
  resolveWizardLabels,
  packSamplesIntoRuns,
  remapRunsToLabels,
  remapSingleRunToLabels,
  normalizeMsRunKits,
  collectUsedPlexKitIds,
  buildPlannerFileSlots,
  validateMsRuns,
  validateRunsAndFiles,
  createEmptyChannelsForLabels,
  parseFractionTechFromName,
  pruneChannelsToSamples,
} from '../models/wizard';
import { isValidMassTolerance } from '../utils/mass-tolerance';
import { TemplateService } from './template.service';

const RESERVED_VALUE_PATTERN = /^(not available|not applicable|normal|anonymized|pooled)$/i;

function syncLegacyFieldsFromChoices(state: WizardState): WizardState {
  const choices = state.characteristicChoices || {};
  let next = { ...state };

  const first = (col: string): CharacteristicChoice | undefined =>
    (choices[col] || [])[0];

  const organism = first('characteristics[organism]');
  next.organism = organism
    ? organism.ontologyTerm || {
        id: organism.value,
        label: organism.value,
        ontology: 'SDRF',
      }
    : null;

  const disease = first('characteristics[disease]');
  next.disease = disease
    ? disease.ontologyTerm || disease.value
    : null;

  const part = first('characteristics[organism part]');
  next.organismPart = part ? part.ontologyTerm || part.value : null;

  const sex = first('characteristics[sex]');
  if (sex && (sex.value === 'male' || sex.value === 'female' || sex.value === 'not available')) {
    next.defaultSex = sex.value;
  } else if (!(choices['characteristics[sex]'] || []).length) {
    next.defaultSex = null;
  }

  const age = first('characteristics[age]');
  next.defaultAge = age?.value || '';

  const cell = first('characteristics[cell line]');
  next.defaultCellLine = cell?.value || '';

  const strain = first('characteristics[strain/breed]');
  next.strainBreed = strain?.value || '';

  const stage = first('characteristics[developmental stage]');
  next.developmentalStage = stage?.value || '';

  let dynamic = [...next.dynamicColumnDefaults];
  for (const [columnName, list] of Object.entries(choices)) {
    if (list.length === 1) {
      dynamic = upsertDynamicColumnDefault(
        dynamic,
        columnName,
        list[0].value,
        list[0].ontologyTerm
      );
    } else if (list.length === 0) {
      dynamic = dynamic.filter(d => d.columnName !== columnName);
    }
  }
  next.dynamicColumnDefaults = dynamic;
  return next;
}

@Injectable({ providedIn: 'root' })
export class WizardStateService {
  // ============ Core State ============

  private readonly _state = signal<WizardState>(createEmptyWizardState());
  private readonly _currentStep = signal<number>(0);
  private readonly templateService = inject(TemplateService);

  /** Read-only state accessor */
  readonly state = this._state.asReadonly();

  /** Current step index (0-based) */
  readonly currentStep = this._currentStep.asReadonly();

  /** Total number of steps */
  readonly totalSteps = WIZARD_STEPS.length;

  /** Step configuration */
  readonly steps = WIZARD_STEPS;

  // ============ Computed Values ============

  readonly currentStepConfig = computed(() => WIZARD_STEPS[this._currentStep()]);

  /** Selected sample template (preferred) */
  readonly template = computed(() => getSampleTemplateId(this._state()));

  readonly sampleTemplate = computed(() => this._state().sampleTemplate);

  readonly technologyTemplate = computed(() => this._state().technologyTemplate);

  readonly experimentTemplates = computed(() => this._state().experimentTemplates);

  readonly sampleCount = computed(() => this._state().sampleCount);

  readonly samples = computed(() => this._state().samples);

  readonly factors = computed(() => this._state().factors);

  readonly labelConfig = computed(() => {
    const configId = this._state().labelConfigId;
    return LABEL_CONFIGS.find(c => c.id === configId) || LABEL_CONFIGS[0];
  });

  readonly msRuns = computed(() => this._state().msRuns || []);

  readonly isLabelFreeMode = computed(() => isLabelFree(this._state()));

  readonly hasFractions = computed(() => this._state().hasFractions);

  readonly fractionCount = computed(() => this._state().fractionCount);

  readonly technicalReplicates = computed(() => this._state().technicalReplicates);

  readonly dataFiles = computed(() => this._state().dataFiles);

  readonly modifications = computed(() => this._state().modifications);

  // ============ Validation Computed ============

  readonly isStep1Valid = computed(() => {
    const state = this._state();
    if (state.sampleCount < 1) return false;
    return this.templateService.validateTemplateCombination({
      technologyTemplate: state.technologyTemplate,
      sampleTemplate: getSampleTemplateId(state),
      experimentTemplates: state.experimentTemplates || [],
    }).valid;
  });

  readonly step1Combination = computed(() => {
    const state = this._state();
    return this.templateService.validateTemplateCombination({
      technologyTemplate: state.technologyTemplate,
      sampleTemplate: getSampleTemplateId(state),
      experimentTemplates: state.experimentTemplates || [],
    });
  });

  readonly isStep2Valid = computed(() => {
    const state = this._state();
    const choices = state.characteristicChoices || {};
    const required = (state.characteristicColumns || []).filter(
      c =>
        c.requirement === 'required' &&
        !isWizardSkippedCharacteristic(c.name) &&
        getSpecialtyCharacteristicKey(c.name) !== 'material type'
    );

    const characteristicsOk =
      required.length === 0
        ? (choices['characteristics[organism]'] || []).length >= 1 &&
          (choices['characteristics[disease]'] || []).length >= 1 &&
          (choices['characteristics[organism part]'] || []).length >= 1
        : required.every(col => (choices[col.name] || []).length >= 1);

    return characteristicsOk && this.isFactorsDefined();
  });

  /**
   * Step 2: at least one enabled factor with a name and ≥1 candidate value.
   */
  readonly isFactorsDefined = computed(() => factorDecisionValid(this._state()));

  /** @deprecated Use isFactorsDefined (Step 2) or per-sample checks in isStep3Valid. */
  readonly isFactorsValid = this.isFactorsDefined;

  /** Sample Values: names, bio-reps, multi-value chars, and per-sample factor picks. */
  readonly isStep3Valid = computed(() => {
    const state = this._state();
    if (state.samples.length === 0) return false;
    if (!state.samples.every(s => s.sourceName.trim().length > 0)) return false;

    const multiRequired = (state.characteristicColumns || []).filter(c => {
      if (c.requirement !== 'required') return false;
      if (isWizardSkippedCharacteristic(c.name)) return false;
      if (getSpecialtyCharacteristicKey(c.name) === 'material type') return false;
      return (state.characteristicChoices?.[c.name] || []).length >= 2;
    });

    const sampleValuesOk = state.samples.every(sample =>
      multiRequired.every(col => !!sample.characteristicValues?.[col.name]?.trim())
    );

    const factorValuesOk = factorAssignmentsValid(state);

    return sampleValuesOk && factorValuesOk;
  });

  readonly isStep4Valid = computed(() => {
    return validateMsRuns(this._state());
  });

  /** Combined Runs & Files step (packing + assigned files). */
  readonly isRunsFilesValid = computed(() => validateRunsAndFiles(this._state()) && runFactorAssignmentsValid(this._state()));

  readonly isStep5Valid = computed(() => {
    const state = this._state();
    return state.instrument !== null && state.cleavageAgent !== null
      && isValidMassTolerance(state.precursorMassTolerance)
      && isValidMassTolerance(state.fragmentMassTolerance);
  });

  readonly isStep6Valid = computed(() => {
    const state = this._state();
    return state.dataFiles.length > 0;
  });

  /** @deprecated Use `isFactorsDefined`. */
  readonly isStep7Valid = this.isFactorsDefined;

  readonly isAllValid = computed(() => {
    return (
      this.isStep1Valid() &&
      this.isStep2Valid() &&
      this.isStep3Valid() &&
      this.isRunsFilesValid() &&
      this.isStep5Valid()
    );
  });

  readonly isCurrentStepValid = computed(() => {
    const step = this._currentStep();
    const id = WIZARD_STEPS[step]?.id;
    switch (id) {
      case 'setup':
        return this.isStep1Valid();
      case 'characteristics':
        return this.isStep2Valid();
      case 'samples':
        return this.isStep3Valid();
      case 'runs-files':
        return this.isRunsFilesValid();
      case 'protocol':
        return this.isStep5Valid();
      case 'review':
        return this.isAllValid();
      default:
        return false;
    }
  });

  readonly canProceed = computed(() => {
    return this.isCurrentStepValid() && this._currentStep() < this.totalSteps - 1;
  });

  readonly canGoBack = computed(() => this._currentStep() > 0);

  readonly canCreate = computed(() => {
    return this._currentStep() === this.totalSteps - 1 && this.isAllValid();
  });

  readonly progressPercent = computed(() => {
    return Math.round(((this._currentStep() + 1) / this.totalSteps) * 100);
  });

  // ============ Navigation Methods ============

  nextStep(): void {
    if (this.canProceed()) {
      const next = this._currentStep() + 1;
      if (WIZARD_STEPS[next]?.id === 'characteristics') {
        this.ensureDefaultFactors();
      }
      if (WIZARD_STEPS[next]?.id === 'samples') {
        this.syncCharacteristicAssignments();
        this.syncFactorAssignments();
        this.ensureDefaultFactors();
      }
      this._currentStep.set(next);
      if (WIZARD_STEPS[next]?.id === 'runs-files') {
        this.ensureMsRunsForFilesStep();
      }
    }
  }

  previousStep(): void {
    if (this.canGoBack()) {
      this._currentStep.update(s => s - 1);
    }
  }

  goToStep(step: number): void {
    if (step >= 0 && step < this.totalSteps) {
      if (WIZARD_STEPS[step]?.id === 'characteristics') {
        this.ensureDefaultFactors();
      }
      if (WIZARD_STEPS[step]?.id === 'samples') {
        this.syncCharacteristicAssignments();
        this.syncFactorAssignments();
        this.ensureDefaultFactors();
      }
      this._currentStep.set(step);
      if (WIZARD_STEPS[step]?.id === 'runs-files') {
        this.ensureMsRunsForFilesStep();
      }
    }
  }

  /**
   * Entering Runs & Files: ensure at least one packed run exists.
   * Does not auto-generate file slots (PXD / paste / planner are explicit).
   */
  ensureMsRunsForFilesStep(): void {
    const s = this._state();
    if ((s.msRuns || []).length === 0) {
      this.autoPackSamplesIntoRuns();
      this._state.update(state => ({ ...state, msRuns: state.msRuns.map(run => ({
        ...run, placeholderSnapshot: runPlaceholderSnapshot(run),
      })) }));
    } else {
      this._state.update(st => {
        return {
          ...st,
          msRuns: normalizeMsRunKits(st.msRuns || [], st.labelConfigId || 'lf').map(
            run => ({ ...run, sampleIndices: [...new Set(run.channels.flatMap(c => c.role === 'pooled' ? c.pooledSampleIndices || [] : c.sampleIndex == null ? [] : [c.sampleIndex]))] })
          ),
        };
      });
    }
  }

  /**
   * Auto-create planner file slots when entering Step 6 if the table is empty.
   * @deprecated Prefer explicit Generate on Runs & Files; kept for compatibility.
   */
  ensurePlannerDataFiles(): void {
    if (this._state().dataFiles.length > 0) return;
    this.generateFileSlotsFromPlanner();
  }

  // ============ Step 1: Experiment Setup ============

  /**
   * Set the sample template (also syncs legacy `template` field).
   */
  setSampleTemplate(template: WizardTemplate | null): void {
    this._state.update(s => ({
      ...s,
      sampleTemplate: template,
      template,
    }));
  }

  /**
   * Set the technology template.
   */
  setTechnologyTemplate(template: WizardTemplate): void {
    this._state.update(s => ({ ...s, technologyTemplate: template }));
  }

  setExperimentTemplates(templates: string[]): void {
    this._state.update(s => ({ ...s, experimentTemplates: [...templates] }));
  }

  toggleExperimentTemplate(templateId: string): void {
    this._state.update(s => {
      const current = s.experimentTemplates || [];
      const exists = current.includes(templateId);
      return {
        ...s,
        experimentTemplates: exists
          ? current.filter(id => id !== templateId)
          : [...current, templateId],
      };
    });
  }

  /**
   * @deprecated Use setSampleTemplate
   */
  setTemplate(template: WizardTemplate | null): void {
    this.setSampleTemplate(template);
  }

  setSampleCount(count: number): void {
    const sampleCount = Math.max(1, Math.floor(count));
    this._state.update(s => {
      const samples = [...s.samples];
      while (samples.length < sampleCount) {
        samples.push(createDefaultSample(samples.length + 1));
      }
      while (samples.length > sampleCount) {
        samples.pop();
      }
      return { ...s, sampleCount, samples };
    });
  }

  setExperimentDescription(description: string): void {
    this._state.update(s => ({ ...s, experimentDescription: description }));
  }

  // ============ Step 2: Sample Characteristics ============

  /**
   * Load characteristic columns from selected sample + experiment templates.
   */
  async refreshCharacteristicColumns(signal?: AbortSignal): Promise<void> {
    const state = this._state();
    const result = await this.templateService.getWizardCharacteristicColumns({
      sampleTemplate: getSampleTemplateId(state),
      experimentTemplates: state.experimentTemplates || [],
    });
    signal?.throwIfAborted();

    const meta: WizardCharacteristicColumnMeta[] = result.all.map(c => ({
      name: c.name,
      description: c.description || '',
      requirement: (c.requirement || 'optional') as WizardCharacteristicColumnMeta['requirement'],
      ontologies: c.validators?.find(v => v.validatorName === 'ontology')?.params?.ontologies,
      allowNotAvailable: c.allowNotAvailable,
      allowNotApplicable: c.allowNotApplicable,
    }));

    this._state.update(s => ({ ...s, characteristicColumns: meta }));
  }

  addCharacteristicChoice(
    columnName: string,
    value: string,
    ontologyTerm?: OntologyTerm
  ): void {
    const trimmed = value.trim();
    if (!trimmed) return;
    this._state.update(s => {
      const characteristicChoices = addCharacteristicChoiceToMap(
        s.characteristicChoices || {},
        columnName,
        { value: trimmed, ontologyTerm }
      );
      return syncLegacyFieldsFromChoices({ ...s, characteristicChoices });
    });
  }

  removeCharacteristicChoice(columnName: string, value: string): void {
    this._state.update(s => {
      const characteristicChoices = removeCharacteristicChoiceFromMap(
        s.characteristicChoices || {},
        columnName,
        value
      );
      return syncLegacyFieldsFromChoices({ ...s, characteristicChoices });
    });
  }

  getChoices(columnName: string): CharacteristicChoice[] {
    return getCharacteristicChoices(this._state(), columnName);
  }

  setOrganism(organism: OntologyTerm | null): void {
    if (!organism) {
      this._state.update(s => {
        const characteristicChoices = { ...(s.characteristicChoices || {}) };
        delete characteristicChoices['characteristics[organism]'];
        return syncLegacyFieldsFromChoices({ ...s, characteristicChoices });
      });
      return;
    }
    this.addCharacteristicChoice(
      'characteristics[organism]',
      organism.label,
      organism
    );
  }

  setDisease(disease: OntologyTerm | string): void {
    if (typeof disease === 'string') {
      if (!disease.trim()) {
        this._state.update(s => {
          const characteristicChoices = { ...(s.characteristicChoices || {}) };
          delete characteristicChoices['characteristics[disease]'];
          return syncLegacyFieldsFromChoices({ ...s, characteristicChoices });
        });
        return;
      }
      this.addCharacteristicChoice('characteristics[disease]', disease);
      return;
    }
    this.addCharacteristicChoice(
      'characteristics[disease]',
      disease.label.toLowerCase(),
      disease
    );
  }

  setOrganismPart(organismPart: OntologyTerm | string): void {
    if (typeof organismPart === 'string') {
      if (!organismPart.trim()) {
        this._state.update(s => {
          const characteristicChoices = { ...(s.characteristicChoices || {}) };
          delete characteristicChoices['characteristics[organism part]'];
          return syncLegacyFieldsFromChoices({ ...s, characteristicChoices });
        });
        return;
      }
      this.addCharacteristicChoice('characteristics[organism part]', organismPart);
      return;
    }
    this.addCharacteristicChoice(
      'characteristics[organism part]',
      organismPart.label.toLowerCase(),
      organismPart
    );
  }

  setDefaultSex(sex: 'male' | 'female' | 'not available'): void {
    this.addCharacteristicChoice('characteristics[sex]', sex);
  }

  setDefaultAge(age: string): void {
    if (!age.trim()) {
      this._state.update(s => {
        const characteristicChoices = { ...(s.characteristicChoices || {}) };
        delete characteristicChoices['characteristics[age]'];
        return syncLegacyFieldsFromChoices({ ...s, characteristicChoices });
      });
      return;
    }
    this.addCharacteristicChoice('characteristics[age]', age.trim());
  }

  setDefaultCellLine(cellLine: string): void {
    if (!cellLine.trim()) {
      this._state.update(s => {
        const characteristicChoices = { ...(s.characteristicChoices || {}) };
        delete characteristicChoices['characteristics[cell line]'];
        return syncLegacyFieldsFromChoices({ ...s, characteristicChoices });
      });
      return;
    }
    this.addCharacteristicChoice('characteristics[cell line]', cellLine.trim());
  }

  setStrainBreed(strainBreed: string): void {
    if (!strainBreed.trim()) {
      this._state.update(s => {
        const characteristicChoices = { ...(s.characteristicChoices || {}) };
        delete characteristicChoices['characteristics[strain/breed]'];
        return syncLegacyFieldsFromChoices({ ...s, characteristicChoices });
      });
      return;
    }
    this.addCharacteristicChoice('characteristics[strain/breed]', strainBreed.trim());
  }

  setDevelopmentalStage(developmentalStage: string): void {
    if (!developmentalStage.trim()) {
      this._state.update(s => {
        const characteristicChoices = { ...(s.characteristicChoices || {}) };
        delete characteristicChoices['characteristics[developmental stage]'];
        return syncLegacyFieldsFromChoices({ ...s, characteristicChoices });
      });
      return;
    }
    this.addCharacteristicChoice(
      'characteristics[developmental stage]',
      developmentalStage.trim()
    );
  }

  // ============ Step 2: Dynamic Column Defaults ============

  setColumnDefault(columnName: string, value: string, ontologyTerm?: OntologyTerm): void {
    if (!value.trim()) {
      this._state.update(s => {
        const characteristicChoices = { ...(s.characteristicChoices || {}) };
        delete characteristicChoices[columnName];
        return syncLegacyFieldsFromChoices({ ...s, characteristicChoices });
      });
      return;
    }
    this.addCharacteristicChoice(columnName, value, ontologyTerm);
  }

  getColumnDefault(columnName: string): DynamicColumnDefault | undefined {
    return this._state().dynamicColumnDefaults.find(d => d.columnName === columnName);
  }

  removeColumnDefault(columnName: string): void {
    this._state.update(s => {
      const characteristicChoices = { ...(s.characteristicChoices || {}) };
      delete characteristicChoices[columnName];
      return syncLegacyFieldsFromChoices({
        ...s,
        characteristicChoices,
        dynamicColumnDefaults: s.dynamicColumnDefaults.filter(d => d.columnName !== columnName),
      });
    });
  }

  clearColumnDefaults(): void {
    this._state.update(s =>
      syncLegacyFieldsFromChoices({
        ...s,
        characteristicChoices: {},
        dynamicColumnDefaults: [],
      })
    );
  }

  /**
   * Sync sample.characteristicValues from choice lists when entering Step3.
   */
  syncCharacteristicAssignments(): void {
    this._state.update(s => {
      const choices = s.characteristicChoices || {};
      const samples = s.samples.map(sample => {
        const values = { ...(sample.characteristicValues || {}) };
        for (const [columnName, list] of Object.entries(choices)) {
          if (list.length === 1) {
            values[columnName] = list[0].value;
          } else if (list.length === 0) {
            delete values[columnName];
          } else if (values[columnName] && !list.some(c => choiceValuesEqual(c.value, values[columnName]))) {
            delete values[columnName];
          }
        }
        // Drop assignments for columns no longer in choices map
        for (const key of Object.keys(values)) {
          if (!(key in choices) || (choices[key] || []).length === 0) {
            delete values[key];
          }
        }
        return { ...sample, characteristicValues: values };
      });
      return { ...s, samples };
    });
  }

  setSampleCharacteristicValue(
    sampleIndex: number,
    columnName: string,
    value: string
  ): void {
    this._state.update(s => {
      const samples = [...s.samples];
      if (sampleIndex < 0 || sampleIndex >= samples.length) return s;
      const sample = { ...samples[sampleIndex] };
      const characteristicValues = { ...(sample.characteristicValues || {}) };
      if (!value.trim()) delete characteristicValues[columnName];
      else characteristicValues[columnName] = value.trim();
      sample.characteristicValues = characteristicValues;
      samples[sampleIndex] = sample;
      return { ...s, samples };
    });
  }

  /** Round-robin assign candidates to all samples for a column. */
  applyRoundRobin(columnName: string): void {
    const list = this.getChoices(columnName);
    if (list.length === 0) return;
    this._state.update(s => ({
      ...s,
      samples: s.samples.map((sample, i) => ({
        ...sample,
        characteristicValues: {
          ...(sample.characteristicValues || {}),
          [columnName]: list[i % list.length].value,
        },
      })),
    }));
  }

  /** Fill groups of N consecutive samples with the same candidate, cycling. */
  applyFillGroups(columnName: string, groupSize: number): void {
    const list = this.getChoices(columnName);
    const n = Math.max(1, Math.floor(groupSize) || 1);
    if (list.length === 0) return;
    this._state.update(s => ({
      ...s,
      samples: s.samples.map((sample, i) => ({
        ...sample,
        characteristicValues: {
          ...(sample.characteristicValues || {}),
          [columnName]: list[Math.floor(i / n) % list.length].value,
        },
      })),
    }));
  }

  /** Set a value on selected sample indices. */
  applyToSelectedRows(
    columnName: string,
    value: string,
    sampleIndices: number[]
  ): void {
    if (!value.trim() || sampleIndices.length === 0) return;
    const set = new Set(sampleIndices);
    this._state.update(s => ({
      ...s,
      samples: s.samples.map((sample, i) => {
        if (!set.has(i)) return sample;
        return {
          ...sample,
          characteristicValues: {
            ...(sample.characteristicValues || {}),
            [columnName]: value.trim(),
          },
        };
      }),
    }));
  }

  /**
   * Paste mapping for a column.
   * Accepts lines of `value` (by row order) or `sourceName\\tvalue`.
   */
  applyPasteMapping(columnName: string, text: string): void {
    const lines = text
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return;

    const named = lines.every(l => l.includes('\t'));
    this._state.update(s => {
      const samples = s.samples.map(sample => ({ ...sample }));
      if (named) {
        const map = new Map<string, string>();
        for (const line of lines) {
          const [name, ...rest] = line.split('\t');
          map.set(name.trim(), rest.join('\t').trim());
        }
        for (let i = 0; i < samples.length; i++) {
          const v = map.get(samples[i].sourceName);
          if (v == null || !v) continue;
          samples[i] = {
            ...samples[i],
            characteristicValues: {
              ...(samples[i].characteristicValues || {}),
              [columnName]: v,
            },
          };
        }
      } else {
        for (let i = 0; i < Math.min(lines.length, samples.length); i++) {
          samples[i] = {
            ...samples[i],
            characteristicValues: {
              ...(samples[i].characteristicValues || {}),
              [columnName]: lines[i],
            },
          };
        }
      }
      return { ...s, samples };
    });
  }

  /** Materialize choices into specialty fields then return a snapshot for generation. */
  getStateForGeneration(): WizardState {
    this.syncCharacteristicAssignments();
    const materialized = materializeSampleFieldsFromChoices(this._state());
    this._state.set(materialized);
    return materialized;
  }

  // ============ Template Type Helpers ============

  readonly isHumanTemplate = computed(() => isHumanTemplate(getSampleTemplateId(this._state())));

  readonly isCellLineTemplate = computed(() => hasCellLinesExperiment(this._state()));

  readonly isVertebrateTemplate = computed(() => isVertebrateTemplate(getSampleTemplateId(this._state())));

  readonly isInvertebrateTemplate = computed(() => isInvertebrateTemplate(getSampleTemplateId(this._state())));

  readonly isPlantTemplate = computed(() => isPlantTemplate(getSampleTemplateId(this._state())));

  readonly needsStrainAndDevelopmentalStage = computed(() =>
    isVertebrateTemplate(getSampleTemplateId(this._state())) ||
    isInvertebrateTemplate(getSampleTemplateId(this._state())) ||
    isPlantTemplate(getSampleTemplateId(this._state()))
  );

  /** Whether disease/organism part must be ontology terms (human) vs reserved allowed */
  readonly requiresStrictCharacteristics = computed(() =>
    isHumanTemplate(getSampleTemplateId(this._state()))
  );

  // ============ Step 3: Sample Values ============

  updateSample(index: number, updates: Partial<WizardSampleEntry>): void {
    this._state.update(s => {
      const samples = [...s.samples];
      if (index >= 0 && index < samples.length) {
        samples[index] = { ...samples[index], ...updates };
      }
      return { ...s, samples };
    });
  }

  setSampleCustomCharacteristic(sampleIndex: number, columnName: string, value: string): void {
    this._state.update(s => {
      const samples = [...s.samples];
      if (sampleIndex < 0 || sampleIndex >= samples.length) return s;
      const sample = { ...samples[sampleIndex] };
      const custom = { ...(sample.customCharacteristics || {}) };
      if (!value.trim()) delete custom[columnName];
      else custom[columnName] = value;
      sample.customCharacteristics = custom;
      samples[sampleIndex] = sample;
      return { ...s, samples };
    });
  }

  setSamples(samples: WizardSampleEntry[]): void {
    this._state.update(s => ({ ...s, samples, sampleCount: samples.length }));
  }

  addSample(): void {
    this._state.update(s => {
      const newIndex = s.samples.length > 0
        ? Math.max(...s.samples.map(sample => sample.index)) + 1
        : 1;
      const samples = [...s.samples, createDefaultSample(newIndex)];
      return { ...s, samples, sampleCount: samples.length };
    });
  }

  removeSample(index: number): void {
    this._state.update(s => {
      if (s.samples.length <= 1) return s;
      const samples = s.samples.filter((_, i) => i !== index);
      return { ...s, samples, sampleCount: samples.length };
    });
  }

  autoGenerateSourceNames(pattern: string = 'sample_{n}'): void {
    this._state.update(s => {
      const samples = s.samples.map((sample, i) => ({
        ...sample,
        sourceName: pattern.replace('{n}', String(i + 1)),
      }));
      return { ...s, samples };
    });
  }

  copyToAllSamples(field: keyof WizardSampleEntry): void {
    this._state.update(s => {
      if (s.samples.length === 0) return s;
      const firstValue = s.samples[0][field];
      const samples = s.samples.map(sample => ({
        ...sample,
        [field]: firstValue,
      }));
      return { ...s, samples };
    });
  }

  // ============ Step 4: Technical Configuration ============

  /**
   * Set default kit for new runs / Auto-pack.
   * Does not remap existing runs (use applyDefaultKitToAllRuns or setRunLabelConfig).
   */
  setLabelConfig(configId: string): void {
    this._state.update(s => ({
      ...s,
      labelConfigId: configId,
      customLabels: [],
      msRuns: normalizeMsRunKits(s.msRuns || [], configId),
    }));
  }

  /** Apply default kit to every run (rebuilds channel widths). */
  applyDefaultKitToAllRuns(): void {
    this._state.update(s => {
      const labels = resolveWizardLabels(s);
      return {
        ...s,
        msRuns: remapRunsToLabels(
          s.msRuns || [],
          labels,
          s.samples,
          s.labelConfigId || 'lf'
        ),
      };
    });
  }

  /** Change kit for one run and remap its channels. */
  setRunLabelConfig(runId: string, configId: string): void {
    this._state.update(s => {
      const labels =
        configId === 'lf'
          ? ['label free sample']
          : LABEL_CONFIGS.find(c => c.id === configId)?.labels || [];
      if (labels.length === 0) return s;
      return {
        ...s,
        msRuns: (s.msRuns || []).map(run =>
          run.id === runId
            ? remapSingleRunToLabels(run, labels, configId)
            : run.labelConfigId
              ? run
              : { ...run, labelConfigId: s.labelConfigId || 'lf' }
        ),
      };
    });
  }

  /** Samples involved in this MS run; channel mapping is limited to this subset. */
  setRunSampleIndices(runId: string, sampleIndices: number[]): void {
    this._state.update(s => {
      const allowed = [...new Set(sampleIndices)]
        .filter(i => s.samples.some(sample => sample.index === i))
        .sort((a, b) => a - b);
      return {
        ...s,
        msRuns: (s.msRuns || []).map(run => {
          if (run.id !== runId) return run;
          return {
            ...run,
            sampleIndices: allowed,
            channels: pruneChannelsToSamples(run.channels, allowed),
          };
        }),
      };
    });
  }

  setCustomLabels(labels: string[]): void {
    this._state.update(s => {
      const next = { ...s, customLabels: labels };
      const resolved = resolveWizardLabels(next);
      return {
        ...next,
        msRuns: remapRunsToLabels(
          s.msRuns || [],
          resolved,
          s.samples,
          next.labelConfigId || 'lf'
        ),
      };
    });
  }

  setHasFractions(hasFractions: boolean): void {
    this._state.update(s => ({
      ...s,
      hasFractions,
      fractionCount: hasFractions ? Math.max(1, s.fractionCount) : 1,
    }));
  }

  setFractionCount(count: number): void {
    this._state.update(s => ({
      ...s,
      fractionCount: Math.max(1, Math.floor(count)),
      hasFractions: Math.floor(count) > 1 ? true : s.hasFractions,
    }));
  }

  setTechnicalReplicates(count: number): void {
    this._state.update(s => ({
      ...s,
      technicalReplicates: Math.max(1, Math.floor(count)),
    }));
  }

  setAcquisitionMethod(method: 'dda' | 'dia' | 'prm' | 'srm'): void {
    this._state.update(s => ({ ...s, acquisitionMethod: method }));
  }

  applyRunsFilesPlan(plan: unknown): void {
    this._state.update(state => applyRunsFilesPlan(state, plan));
  }

  autoPackSamplesIntoRuns(): void {
    this._state.update(s => {
      const used = new Set(s.msRuns.flatMap(r => r.channels.flatMap(c =>
        c.role === 'pooled' ? c.pooledSampleIndices || [] : c.sampleIndex == null ? [] : [c.sampleIndex])));
      const missing = s.samples.filter(sample => !used.has(sample.index));
      if (!missing.length && s.msRuns.length) return s;
      const added = packSamplesIntoRuns(missing, resolveWizardLabels(s), undefined, s.labelConfigId || 'lf');
      const names = new Set(s.msRuns.map(r => r.name));
      let ordinal = 1;
      for (const run of added) {
        while (names.has(`Run ${ordinal}`)) ordinal++;
        run.name = `Run ${ordinal++}`;
        names.add(run.name);
      }
      return { ...s, msRuns: [...s.msRuns, ...added] };
    });
  }

  addMsRun(): void {
    this._state.update(s => {
      const labels = resolveWizardLabels(s);
      if (labels.length === 0) return s;
      const kitId = s.labelConfigId || 'lf';
      const runs = normalizeMsRunKits(s.msRuns || [], kitId);
      runs.push({
        id: `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        name: `Run ${runs.length + 1}`,
        labelConfigId: kitId,
        sampleIndices: s.samples.map(sample => sample.index),
        channels: createEmptyChannelsForLabels(labels),
      });
      return { ...s, msRuns: runs };
    });
  }

  removeMsRun(runId: string): void {
    this._state.update(s => {
      const runs = (s.msRuns || []).filter(r => r.id !== runId);
      // Keep files; return them to the unassigned pool
      const dataFiles = s.dataFiles.map(f => {
        if (f.runId !== runId) return f;
        const { runId: _drop, ...rest } = f;
        return rest;
      });
      return { ...s, msRuns: runs, dataFiles };
    });
  }

  renameMsRun(runId: string, name: string): void {
    this._state.update(s => ({
      ...s,
      msRuns: (s.msRuns || []).map(r =>
        r.id === runId ? { ...r, name: name.trim() || r.name } : r
      ),
    }));
  }

  setChannelAssignment(
    runId: string,
    channelIndex: number,
    patch: Partial<WizardChannelAssignment>
  ): void {
    this._state.update(s => ({
      ...s,
      msRuns: (s.msRuns || []).map(run => {
        if (run.id !== runId) return run;
        const channels = run.channels.map((ch, i) => {
          if (i !== channelIndex) return ch;
          const next = { ...ch, ...patch };
          if (next.role === 'empty') {
            delete next.sampleIndex;
            delete next.pooledSampleIndices;
            delete next.sourceNameOverride;
          }
          if (next.role === 'sample') {
            delete next.pooledSampleIndices;
            delete next.sourceNameOverride;
          }
          if (next.role === 'pooled') {
            delete next.sampleIndex;
            if (!next.pooledSampleIndices) next.pooledSampleIndices = [];
          }
          return next;
        });
        return { ...run, channels };
      }),
    }));
  }

  setMsRuns(msRuns: WizardMsRun[]): void {
    this._state.update(s => ({
      ...s,
      msRuns: normalizeMsRunKits(msRuns, s.labelConfigId || 'lf'),
    }));
  }

  // ============ Step 5: Instrument & Protocol ============

  setInstrument(instrument: OntologyTerm): void {
    this._state.update(s => ({ ...s, instrument }));
  }

  setCleavageAgent(cleavageAgent: WizardCleavageAgent): void {
    this._state.update(s => ({ ...s, cleavageAgent }));
  }

  addModification(modification: WizardModification): void {
    this._state.update(s => ({
      ...s,
      modifications: [...s.modifications, modification],
    }));
  }

  removeModification(index: number): void {
    this._state.update(s => ({
      ...s,
      modifications: s.modifications.filter((_, i) => i !== index),
    }));
  }

  setPrecursorMassTolerance(precursorMassTolerance: string): void {
    this._state.update(s => ({ ...s, precursorMassTolerance }));
  }

  setFragmentMassTolerance(fragmentMassTolerance: string): void {
    this._state.update(s => ({ ...s, fragmentMassTolerance }));
  }

  setModifications(modifications: WizardModification[]): void {
    this._state.update(s => ({ ...s, modifications }));
  }

  addSuggestedPlexModifications(): void {
    const state = this._state();
    const kitIds = collectUsedPlexKitIds(state);
    const suggested: WizardModification[] = [];
    const seenFamilies = new Set<string>();

    for (const id of kitIds) {
      let family = '';
      let mods: WizardModification[] = [];
      if (id.startsWith('tmt16') || id.startsWith('tmt18') || id === 'tmt11' || id === 'tmt10') {
        family = 'TMTpro';
        mods = [
          {
            name: 'TMTpro',
            targetAminoAcids: 'K',
            type: 'fixed',
            position: 'Anywhere',
            unimodAccession: 'UNIMOD:2016',
            deltaMass: 304.207146,
          },
          {
            name: 'TMTpro',
            targetAminoAcids: 'N-term',
            type: 'fixed',
            position: 'Any N-term',
            unimodAccession: 'UNIMOD:2016',
            deltaMass: 304.207146,
          },
        ];
      } else if (id.startsWith('tmt')) {
        family = 'TMT6plex';
        mods = [
          {
            name: 'TMT6plex',
            targetAminoAcids: 'K',
            type: 'fixed',
            position: 'Anywhere',
            unimodAccession: 'UNIMOD:737',
            deltaMass: 229.162932,
          },
          {
            name: 'TMT6plex',
            targetAminoAcids: 'N-term',
            type: 'fixed',
            position: 'Any N-term',
            unimodAccession: 'UNIMOD:737',
            deltaMass: 229.162932,
          },
        ];
      } else if (id.startsWith('itraq4')) {
        family = 'iTRAQ4plex';
        mods = [
          {
            name: 'iTRAQ4plex',
            targetAminoAcids: 'K',
            type: 'fixed',
            position: 'Anywhere',
            unimodAccession: 'UNIMOD:214',
            deltaMass: 144.102063,
          },
          {
            name: 'iTRAQ4plex',
            targetAminoAcids: 'N-term',
            type: 'fixed',
            position: 'Any N-term',
            unimodAccession: 'UNIMOD:214',
            deltaMass: 144.102063,
          },
        ];
      } else if (id.startsWith('itraq')) {
        family = 'iTRAQ8plex';
        mods = [
          {
            name: 'iTRAQ8plex',
            targetAminoAcids: 'K',
            type: 'fixed',
            position: 'Anywhere',
            unimodAccession: 'UNIMOD:730',
            deltaMass: 304.20536,
          },
          {
            name: 'iTRAQ8plex',
            targetAminoAcids: 'N-term',
            type: 'fixed',
            position: 'Any N-term',
            unimodAccession: 'UNIMOD:730',
            deltaMass: 304.20536,
          },
        ];
      }
      if (!family || seenFamilies.has(family)) continue;
      seenFamilies.add(family);
      suggested.push(...mods);
    }

    if (suggested.length === 0) return;

    this._state.update(s => {
      const existing = s.modifications;
      const toAdd = suggested.filter(
        mod =>
          !existing.some(
            e =>
              e.name === mod.name &&
              e.targetAminoAcids === mod.targetAminoAcids &&
              e.position === mod.position
          )
      );
      if (toAdd.length === 0) return s;
      return { ...s, modifications: [...existing, ...toAdd] };
    });
  }

  // ============ Step 6: Data Files ============

  setFileNamingPattern(pattern: string): void {
    this._state.update(s => ({ ...s, fileNamingPattern: pattern }));
  }

  setDataFiles(dataFiles: WizardDataFile[]): void {
    this._state.update(s => ({ ...s, dataFiles }));
  }

  updateDataFile(index: number, patch: Partial<WizardDataFile>): void {
    this._state.update(s => {
      if (index < 0 || index >= s.dataFiles.length) return s;
      const dataFiles = s.dataFiles.map((f, i) =>
        i === index ? { ...f, ...patch } : f
      );
      return { ...s, dataFiles };
    });
  }

  /** Add filenames to the unassigned pool (no runId). */
  addUnassignedFileNames(names: string[]): void {
    const cleaned = names.map(n => n.trim()).filter(Boolean);
    if (cleaned.length === 0) return;
    this._state.update(s => {
      const known = new Set(s.dataFiles.map(f => f.fileName.trim()));
      const added: WizardDataFile[] = [...new Set(cleaned)].filter(n => !known.has(n)).map(fileName => {
        const parsed = parseFractionTechFromName(fileName);
        return {
          fileName,
          fractionId: parsed.fractionId,
          technicalReplicate: parsed.technicalReplicate,
        };
      });
      return { ...s, dataFiles: [...s.dataFiles, ...added] };
    });
  }

  /** Replace only the unassigned pool; preserve existing file mappings. */
  replaceWithUnassignedFileNames(names: string[]): void {
    const cleaned = [...new Set(names.map(n => n.trim()).filter(Boolean))];
    this._state.update(s => {
      const assigned = s.dataFiles.filter(f => !!f.runId);
      const known = new Set(assigned.map(f => f.fileName.trim()));
      return { ...s, dataFiles: [...assigned, ...cleaned.filter(n => !known.has(n)).map(fileName => ({
        fileName, ...parseFractionTechFromName(fileName),
      }))] };
    });
  }

  assignDataFilesToRun(indices: number[], runId: string): void {
    const set = new Set(indices);
    this._state.update(s => ({
      ...s,
      dataFiles: s.dataFiles.map((f, i) =>
        set.has(i) ? { ...f, runId } : f
      ),
    }));
  }

  /**
   * Assign files to runs by exact file name, optionally setting fraction / tech.
   * Used by AI recommendation cards (`assignFilesToRunsByName`).
   */
  assignDataFilesToRunsByName(
    assignments: Array<{
      runId: string;
      files: Array<{ fileName: string; fractionId: number; technicalReplicate: number }>;
    }>
  ): void {
    if (!assignments.length) return;

    const byName = new Map<
      string,
      { runId: string; fractionId: number; technicalReplicate: number }
    >();
    for (const group of assignments) {
      for (const file of group.files) {
        const key = file.fileName.trim();
        if (!key) continue;
        byName.set(key, {
          runId: group.runId,
          fractionId: Math.max(1, Math.floor(file.fractionId) || 1),
          technicalReplicate: Math.max(1, Math.floor(file.technicalReplicate) || 1),
        });
      }
    }

    this._state.update(s => ({
      ...s,
      dataFiles: s.dataFiles.map(f => {
        const hit = byName.get((f.fileName || '').trim());
        if (!hit) return f;
        return {
          ...f,
          runId: hit.runId,
          fractionId: hit.fractionId,
          technicalReplicate: hit.technicalReplicate,
        };
      }),
    }));
  }

  unassignDataFiles(indices: number[]): void {
    const set = new Set(indices);
    this._state.update(s => ({
      ...s,
      dataFiles: s.dataFiles.map((f, i) => {
        if (!set.has(i)) return f;
        const { runId: _r, ...rest } = f;
        return rest;
      }),
    }));
  }

  removeDataFile(index: number): void {
    this._state.update(s => ({
      ...s,
      dataFiles: s.dataFiles.filter((_, i) => i !== index),
    }));
  }

  /** Generate file slots from planner (one file per run×F×T). */
  generateFileSlotsFromPlanner(): void {
    this._state.update(s => {
      let state = s;
      if (!s.msRuns || s.msRuns.length === 0) {
        const labels = resolveWizardLabels(s);
        const kitId = s.labelConfigId || 'lf';
        state = {
          ...s,
          msRuns: packSamplesIntoRuns(s.samples, labels, undefined, kitId),
        };
      } else {
        state = {
          ...s,
          msRuns: normalizeMsRunKits(s.msRuns, s.labelConfigId || 'lf'),
        };
      }
      return { ...state, dataFiles: buildPlannerFileSlots(state) };
    });
  }

  /** @deprecated Use generateFileSlotsFromPlanner */
  autoGenerateDataFiles(): void {
    this.generateFileSlotsFromPlanner();
  }

  // ============ Factors (defined on Step 2, assigned per sample on Step 3) ============

  ensureDefaultFactors(): void {
    // Normalize existing drafts without selecting a comparison variable for the user.
    this._state.update(s => ({ ...s, factors: s.factors.map(normalizeFactor) }));
  }

  setFactorDecision(decision: 'pending' | 'none', reason = ''): void {
    this._state.update(s => ({ ...s, factorDecision: decision, noFactorReason: reason,
      factors: decision === 'none' ? s.factors.map(f => ({ ...f, enabled: false })) : s.factors }));
  }

  setRunFactorValue(runId: string, factorName: string, value: string): void {
    const state = this._state();
    const factor = state.factors.find(f => f.enabled && f.name === factorName && f.scope === 'run');
    if (!factor) throw new Error(`Unknown run factor: ${factorName}.`);
    if (!state.msRuns.some(run => run.id === runId)) throw new Error('Unknown MS run.');
    if (value.trim() && !factor.values.some(candidate => choiceValuesEqual(candidate, value))) {
      throw new Error(`Choose a defined candidate for ${factorName}.`);
    }
    this._state.update(s => ({ ...s, msRuns: s.msRuns.map(run => run.id === runId
      ? { ...run, factorValues: { ...run.factorValues, [factorName]: value.trim() } } : run) }));
  }

  setRunFactorValueByName(runName: string, factorName: string, value: string): void {
    const runs = this._state().msRuns.filter(run => run.name === runName);
    if (runs.length !== 1) throw new Error(`Expected exactly one run named ${runName}.`);
    this.setRunFactorValue(runs[0].id, factorName, value);
  }

  setFactors(factors: WizardFactor[]): void {
    this._state.update(s => ({
      ...s,
      factorDecision: 'pending',
      factors: factors.map(normalizeFactor).filter(f => f.name.trim()),
    }));
  }

  addFactor(factor: WizardFactor): void {
    const next = normalizeFactor(factor);
    this._state.update(s => ({
      ...s,
      factorDecision: 'pending',
      factors: [...s.factors.map(normalizeFactor), next],
    }));
  }

  updateFactor(index: number, updates: Partial<WizardFactor>): void {
    this._state.update(s => {
      const factors = s.factors.map(normalizeFactor);
      if (updates.enabled) s = { ...s, factorDecision: 'pending' };
      if (index >= 0 && index < factors.length) {
        const oldName = factors[index].name;
        factors[index] = normalizeFactor({ ...factors[index], ...updates });
        const newName = factors[index].name;
        if (oldName !== newName) {
          const samples = s.samples.map(sample => {
            const factorValues = { ...sample.factorValues };
            if (oldName in factorValues) {
              factorValues[newName] = factorValues[oldName];
              delete factorValues[oldName];
            }
            return { ...sample, factorValues };
          });
          const msRuns = s.msRuns.map(run => {
            const factorValues = { ...run.factorValues };
            if (oldName in factorValues) { factorValues[newName] = factorValues[oldName]; delete factorValues[oldName]; }
            return { ...run, factorValues };
          });
          return { ...s, factors, samples, msRuns };
        }
      }
      return { ...s, factors };
    });
  }

  removeFactor(index: number): void {
    this._state.update(s => {
      const factors = s.factors.map(normalizeFactor).filter((_, i) => i !== index);
      return {
        ...s,
        factors,
      };
    });
  }

  toggleFactor(index: number, enabled: boolean): void {
    this.updateFactor(index, { enabled });
  }

  addFactorValue(index: number, value: string): void {
    const trimmed = value.trim();
    if (!trimmed) return;
    this._state.update(s => {
      const factors = s.factors.map(normalizeFactor);
      if (index < 0 || index >= factors.length) return s;
      const current = factors[index];
      if (current.values.some(v => choiceValuesEqual(v, trimmed))) return s;
      factors[index] = { ...current, values: [...current.values, trimmed] };
      return { ...s, factors };
    });
  }

  /** Append a candidate by factor name (AI / bridge). */
  addFactorValueByName(factorName: string, value: string): void {
    const trimmedName = factorName.trim();
    const trimmed = value.trim();
    if (!trimmedName || !trimmed) return;
    this._state.update(s => {
      const factors = s.factors.map(normalizeFactor);
      const index = factors.findIndex(f => f.name.toLowerCase() === trimmedName.toLowerCase());
      if (index < 0) {
        return {
          ...s,
          factors: [...factors, { name: trimmedName, enabled: true, values: [trimmed] }],
        };
      }
      const current = factors[index];
      if (current.values.some(v => choiceValuesEqual(v, trimmed))) return s;
      factors[index] = { ...current, values: [...current.values, trimmed] };
      return { ...s, factors };
    });
  }

  removeFactorValue(index: number, value: string): void {
    this._state.update(s => {
      const factors = s.factors.map(normalizeFactor);
      if (index < 0 || index >= factors.length) return s;
      factors[index] = {
        ...factors[index],
        values: factors[index].values.filter(v => !choiceValuesEqual(v, value)),
      };
      return { ...s, factors };
    });
  }

  /**
   * Sync sample.factorValues from factor candidate lists when entering Step 3.
   */
  syncFactorAssignments(): void {
    this._state.update(s => {
      const factors = s.factors.map(normalizeFactor).filter(f => f.enabled && f.name.trim());
      const samples = s.samples.map(sample => {
        const values = { ...(sample.factorValues || {}) };
        for (const factor of factors) {
          if (factor.sourceCharacteristic || factor.scope === 'run') { delete values[factor.name]; continue; }
          const list = factor.values || [];
          if (list.length === 1) {
            values[factor.name] = list[0];
          } else if (list.length === 0) {
            delete values[factor.name];
          } else if (
            values[factor.name] &&
            !list.some(v => choiceValuesEqual(v, values[factor.name]))
          ) {
            delete values[factor.name];
          }
        }
        for (const key of Object.keys(values)) {
          if (!factors.some(f => f.name === key)) delete values[key];
        }
        return { ...sample, factorValues: values };
      });
      return { ...s, samples };
    });
  }

  setSampleFactorValue(sampleIndex: number, factorName: string, value: string): void {
    const name = this.assertFactorAssignment(factorName, [value]);
    this._state.update(s => {
      const samples = [...s.samples];
      if (sampleIndex < 0 || sampleIndex >= samples.length) return s;
      const sample = { ...samples[sampleIndex] };
      const factorValues = { ...(sample.factorValues || {}) };
      if (!value.trim()) delete factorValues[name];
      else factorValues[name] = value.trim();
      sample.factorValues = factorValues;
      samples[sampleIndex] = sample;
      return { ...s, samples };
    });
  }

  /**
   * Assign an entire factor column in sample order (length must match sample count).
   * Used by AI one-click mapping cards.
   */
  setFactorColumnValues(factorName: string, values: string[]): void {
    const name = this.assertFactorAssignment(factorName, values);
    if (values.length !== this._state().samples.length) throw new Error('Provide one factor value per sample.');
    this._state.update(s => {
      if (values.length !== s.samples.length) {
        return s;
      }
      const samples = s.samples.map((sample, i) => {
        const raw = (values[i] || '').trim();
        const factorValues = { ...(sample.factorValues || {}) };
        if (!raw) {
          delete factorValues[name];
        } else {
          factorValues[name] = raw;
        }
        return { ...sample, factorValues };
      });
      return { ...s, samples };
    });
  }

  private assertFactorAssignment(name: string, values: string[]): string {
    const factor = this._state().factors.find(f => f.enabled && f.name.toLowerCase() === name.trim().toLowerCase());
    if (!factor) throw new Error(`Unknown or disabled factor: ${name}.`);
    if (factor.scope === 'run') throw new Error(`Assign ${name} on Runs & Files, not to biological samples.`);
    if (factor.sourceCharacteristic) throw new Error(`Factor ${name} is linked; edit ${factor.sourceCharacteristic} instead.`);
    if (values.some(value => value.trim() && !factor.values.some(candidate => choiceValuesEqual(candidate, value)))) {
      throw new Error(`Values for ${name} must come from its candidate list. Add new candidates first.`);
    }
    return factor.name;
  }

  enabledFactors(): WizardFactor[] {
    return this._state()
      .factors.map(normalizeFactor)
      .filter(f => f.enabled && f.name.trim());
  }

  // ============ Reset ============

  reset(): void {
    this._state.set(createEmptyWizardState());
    this._currentStep.set(0);
  }

  /**
   * Restore a previously persisted wizard form (chat history / accidental leave).
   * Merges onto an empty baseline so older snapshots missing new fields still work.
   */
  hydrate(state: WizardState, step = 0): void {
    const baseline = createEmptyWizardState();
    const factors = (state.factors?.length ? state.factors : baseline.factors).map(normalizeFactor);
    const samples = (state.samples?.length ? state.samples : baseline.samples).map(sample => ({
      ...sample,
      factorValues: sample.factorValues || {},
    }));
    const next: WizardState = {
      ...baseline,
      ...state,
      sampleTemplate: getSampleTemplateId(state),
      template: getSampleTemplateId(state),
      characteristicChoices: state.characteristicChoices || {},
      characteristicColumns: state.characteristicColumns || [],
      experimentTemplates: state.experimentTemplates || [],
      samples,
      msRuns: state.msRuns?.length ? state.msRuns : baseline.msRuns,
      dataFiles: state.dataFiles || [],
      modifications: state.modifications || [],
      factors,
      dynamicColumnDefaults: state.dynamicColumnDefaults || [],
      customLabels: state.customLabels || [],
    };
    this._state.set(next);
    const maxStep = Math.max(0, WIZARD_STEPS.length - 1);
    this._currentStep.set(Math.min(Math.max(0, Math.floor(step) || 0), maxStep));
  }

  // ============ Helpers ============

  ensureSamplesInitialized(): void {
    this._state.update(s => {
      if (s.samples.length >= s.sampleCount) return s;
      const samples = [...s.samples];
      while (samples.length < s.sampleCount) {
        samples.push(createDefaultSample(samples.length + 1));
      }
      return { ...s, samples };
    });
  }

  getState(): WizardState {
    return this._state();
  }

  isReservedCharacteristicValue(value: string): boolean {
    return RESERVED_VALUE_PATTERN.test(value.trim());
  }
}
