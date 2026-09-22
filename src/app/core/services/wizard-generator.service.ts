/**
 * Wizard Generator Service
 *
 * Converts WizardState into an SdrfTable structure.
 */

import { normalizeMassTolerance } from '../utils/mass-tolerance';

import { Injectable, inject } from '@angular/core';
import {
  WizardState,
  assayNameForFile,
  WizardModification,
  WizardFactor,
  factorCandidates,
  resolveFactorValue,
  resolveRunFactorValue,
  DynamicColumnDefault,
  WizardExpansionRow,
  WizardSampleEntry,
  SDRF_SPEC_VERSION,
  formatSdrfSemver,
  getSampleTemplateId,
  getDefaultMaterialType,
  isHumanTemplate,
  isCellLineTemplate,
  hasCellLinesExperiment,
  getSpecialtyCharacteristicKey,
  isWizardSkippedCharacteristic,
  materializeSampleFieldsFromChoices,
  buildWizardExpansionRows,
  buildModifiersFromExpansion,
} from '../models/wizard';
import { SdrfTable, createEmptyTable } from '../models/sdrf-table';
import { SdrfColumn, ColumnType, Modifier } from '../models/sdrf-column';
import { TemplateService } from './template.service';

@Injectable({ providedIn: 'root' })
export class WizardGeneratorService {
  private readonly templateService = inject(TemplateService);
  private expansionRows: WizardExpansionRow[] = [];

  /**
   * Generate an SdrfTable from wizard state.
   */
  generate(state: WizardState): SdrfTable {
    state = materializeSampleFieldsFromChoices(state);
    this.expansionRows = buildWizardExpansionRows(state);
    const table = createEmptyTable(Math.max(1, this.expansionRows.length));
    let columnPosition = 0;
    const sampleTemplate = getSampleTemplateId(state);
    const experiments = state.experimentTemplates || [];

    table.columns.push(this.createSourceNameColumn(state, columnPosition++));

    const charCols = (state.characteristicColumns || []).filter(
      c => !isWizardSkippedCharacteristic(c.name)
    );

    const emitted = new Set<string>();

    const emitSpecialty = (name: string, col: SdrfColumn) => {
      if (emitted.has(name.toLowerCase())) return;
      table.columns.push(col);
      emitted.add(name.toLowerCase());
    };

    // Always emit core organism/disease/part when present in meta or as legacy fallback
    const hasMeta = charCols.length > 0;
    const shouldEmit = (columnName: string, requirement: string): boolean => {
      if (!hasMeta) {
        return ['characteristics[organism]', 'characteristics[disease]', 'characteristics[organism part]', 'characteristics[material type]'].includes(columnName);
      }
      const meta = charCols.find(c => c.name.toLowerCase() === columnName.toLowerCase());
      if (!meta) return false;
      if (meta.requirement === 'required') return true;
      // recommended: only if has default or sample override
      return this.hasCharacteristicOutputValue(state, columnName);
    };

    if (shouldEmit('characteristics[organism]', 'required') || !hasMeta) {
      emitSpecialty('characteristics[organism]', this.createOrganismColumn(state, columnPosition++));
    }
    if (shouldEmit('characteristics[disease]', 'required') || !hasMeta) {
      emitSpecialty('characteristics[disease]', this.createDiseaseColumn(state, columnPosition++));
    }
    if (shouldEmit('characteristics[organism part]', 'required') || !hasMeta) {
      emitSpecialty('characteristics[organism part]', this.createOrganismPartColumn(state, columnPosition++));
    }

    // material type: always for generated tables (structural)
    emitSpecialty(
      'characteristics[material type]',
      this.createMaterialTypeColumn(sampleTemplate, experiments, columnPosition++)
    );

    if (
      charCols.some(c => c.name.toLowerCase() === 'characteristics[sex]') &&
      (shouldEmit('characteristics[sex]', 'required') ||
        this.hasCharacteristicOutputValue(state, 'characteristics[sex]'))
    ) {
      emitSpecialty('characteristics[sex]', this.createSexColumn(state, columnPosition++));
    } else if (!hasMeta && isHumanTemplate(sampleTemplate)) {
      emitSpecialty('characteristics[sex]', this.createSexColumn(state, columnPosition++));
    }

    if (
      charCols.some(c => c.name.toLowerCase() === 'characteristics[age]') &&
      (shouldEmit('characteristics[age]', 'required') ||
        this.hasCharacteristicOutputValue(state, 'characteristics[age]'))
    ) {
      emitSpecialty('characteristics[age]', this.createAgeColumn(state, columnPosition++));
    } else if (!hasMeta && isHumanTemplate(sampleTemplate)) {
      emitSpecialty('characteristics[age]', this.createAgeColumn(state, columnPosition++));
    }

    if (
      charCols.some(c => c.name.toLowerCase() === 'characteristics[cell line]') &&
      (shouldEmit('characteristics[cell line]', 'required') ||
        this.hasCharacteristicOutputValue(state, 'characteristics[cell line]'))
    ) {
      emitSpecialty('characteristics[cell line]', this.createCellLineColumn(state, columnPosition++));
    } else if (
      !hasMeta &&
      (hasCellLinesExperiment(state) || isCellLineTemplate(sampleTemplate))
    ) {
      emitSpecialty('characteristics[cell line]', this.createCellLineColumn(state, columnPosition++));
    }

    if (
      shouldEmit('characteristics[strain/breed]', 'required') ||
      this.hasCharacteristicOutputValue(state, 'characteristics[strain/breed]')
    ) {
      emitSpecialty('characteristics[strain/breed]', this.createStrainBreedColumn(state, columnPosition++));
    }
    if (
      shouldEmit('characteristics[developmental stage]', 'required') ||
      this.hasCharacteristicOutputValue(state, 'characteristics[developmental stage]')
    ) {
      emitSpecialty(
        'characteristics[developmental stage]',
        this.createDevelopmentalStageColumn(state, columnPosition++)
      );
    }

    // Remaining characteristics from meta / dynamic defaults
    for (const meta of charCols) {
      const lower = meta.name.toLowerCase();
      if (emitted.has(lower)) continue;
      if (meta.requirement === 'recommended' && !this.hasCharacteristicOutputValue(state, meta.name)) {
        continue;
      }
      if (meta.requirement !== 'required' && meta.requirement !== 'recommended') {
        continue;
      }
      table.columns.push(this.createDynamicCharacteristicColumn(state, meta.name, columnPosition++));
      emitted.add(lower);
    }

    // Dynamic defaults not already emitted
    for (const colDefault of state.dynamicColumnDefaults) {
      if (!colDefault.columnName.toLowerCase().startsWith('characteristics[')) continue;
      if (emitted.has(colDefault.columnName.toLowerCase())) continue;
      if (isWizardSkippedCharacteristic(colDefault.columnName)) continue;
      table.columns.push(this.createDynamicCharacteristicColumn(state, colDefault.columnName, columnPosition++));
      emitted.add(colDefault.columnName.toLowerCase());
    }

    // Linked factor sources must be emitted even when they are optional characteristics.
    for (const factor of state.factors.filter(f => f.enabled && f.sourceCharacteristic)) {
      const source = factor.sourceCharacteristic!;
      if (!emitted.has(source.toLowerCase())) {
        table.columns.push(this.createDynamicCharacteristicColumn(state, source, columnPosition++));
        emitted.add(source.toLowerCase());
      }
    }

    // Biological replicate
    table.columns.push(this.createBiologicalReplicateColumn(state, columnPosition++));

    // Assay / technology (data section — use comment priority for column ordering)
    table.columns.push(this.createAssayNameColumn(state, columnPosition++));
    table.columns.push(this.createTechnologyTypeColumn(columnPosition++));

    // Technical columns (always emit tech replicate — SDRF requires the column even when all = 1)
    table.columns.push(this.createFractionColumn(state, columnPosition++));
    table.columns.push(this.createLabelColumn(state, columnPosition++));
    table.columns.push(this.createDataAcquisitionMethodColumn(state, columnPosition++));
    table.columns.push(this.createTechnicalReplicateColumn(state, columnPosition++));

    // Instrument & Protocol
    table.columns.push(this.createInstrumentColumn(state, columnPosition++));
    table.columns.push(this.createCleavageAgentColumn(state, columnPosition++));

    // Recommended search parameters: omit unfilled columns, preserve explicit unknowns.
    for (const [name, tolerance] of [
      ['precursor mass tolerance', state.precursorMassTolerance],
      ['fragment mass tolerance', state.fragmentMassTolerance],
    ]) {
      if (!tolerance?.trim()) continue;
      table.columns.push({
        name: `comment[${name}]`, type: 'comment',
        value: normalizeMassTolerance(tolerance), modifiers: [],
        columnPosition: columnPosition++, isRequired: false,
      });
    }

    // Modifications
    for (const mod of state.modifications) {
      table.columns.push(this.createModificationColumn(mod, columnPosition++));
    }

    // Data file
    table.columns.push(this.createDataFileColumn(state, columnPosition++));

    // Versioning metadata
    table.columns.push(this.createSdrfVersionColumn(columnPosition++));
    for (const templateCol of this.createSdrfTemplateColumns(state, columnPosition)) {
      table.columns.push(templateCol);
      columnPosition++;
    }

    // Factor values (after data section)
    for (const factor of state.factors.filter(f => f.enabled && f.name.trim())) {
      table.columns.push(this.createFactorColumn(state, factor, columnPosition++));
    }

    return table;
  }

  /**
   * Calculate total row count based on samples, fractions, and replicates.
   */
  private calculateRowCount(state: WizardState): number {
    return Math.max(1, buildWizardExpansionRows(state).length);
  }

  private findSample(state: WizardState, sampleIndex?: number): WizardSampleEntry | undefined {
    if (sampleIndex == null) return undefined;
    return state.samples.find(s => s.index === sampleIndex);
  }

  /** Build modifiers from expansion rows; omit values equal to defaultValue when provided. */
  private modsFromRows(
    getValue: (row: WizardExpansionRow) => string,
    defaultValue?: string
  ): { value: string; modifiers: Modifier[] } {
    const built = buildModifiersFromExpansion(this.expansionRows, getValue, defaultValue);
    return {
      value: built.value,
      modifiers: built.modifiers as Modifier[],
    };
  }

  private termOrStringValue(
    value: { label: string } | string | null | undefined,
    fallback = 'not available'
  ): string {
    if (value == null) return fallback;
    if (typeof value === 'string') return value;
    return value.label.toLowerCase();
  }

  // ============ Column Generators ============

  private createSourceNameColumn(state: WizardState, position: number): SdrfColumn {
    const { value, modifiers } = this.modsFromRows(r => r.sourceName);
    return {
      name: 'source name',
      type: 'source_name',
      value: value || state.samples[0]?.sourceName || '',
      modifiers,
      columnPosition: position,
      isRequired: true,
    };
  }

  private createOrganismColumn(state: WizardState, position: number): SdrfColumn {
    const value = state.organism
      ? state.organism.label.toLowerCase()
      : 'not available';
    const { modifiers } = this.modsFromRows(row => {
      const sample = this.findSample(state, row.sampleIndex);
      const sampleOrg = sample?.organism
        ? typeof sample.organism === 'string'
          ? sample.organism
          : sample.organism.label.toLowerCase()
        : '';
      return sampleOrg || value;
    }, value);

    return {
      name: 'characteristics[organism]',
      type: 'characteristics',
      value,
      modifiers,
      columnPosition: position,
      isRequired: true,
      ontologyType: 'ncbitaxon',
    };
  }

  private createDiseaseColumn(state: WizardState, position: number): SdrfColumn {
    const defaultValue = this.termOrStringValue(state.disease);
    const { modifiers } = this.modsFromRows(row => {
      const sample = this.findSample(state, row.sampleIndex);
      if (sample?.disease) {
        return typeof sample.disease === 'string'
          ? sample.disease
          : sample.disease.label.toLowerCase();
      }
      return defaultValue;
    }, defaultValue);

    return {
      name: 'characteristics[disease]',
      type: 'characteristics',
      value: defaultValue,
      modifiers,
      columnPosition: position,
      isRequired: true,
      ontologyType: 'mondo',
    };
  }

  private createOrganismPartColumn(state: WizardState, position: number): SdrfColumn {
    const value = this.termOrStringValue(state.organismPart);
    const { modifiers } = this.modsFromRows(row => {
      const sample = this.findSample(state, row.sampleIndex);
      const samplePart = sample?.organismPart
        ? typeof sample.organismPart === 'string'
          ? sample.organismPart
          : sample.organismPart.label.toLowerCase()
        : '';
      return samplePart || value;
    }, value);

    return {
      name: 'characteristics[organism part]',
      type: 'characteristics',
      value,
      modifiers,
      columnPosition: position,
      isRequired: true,
      ontologyType: 'uberon',
    };
  }

  private createMaterialTypeColumn(
    sampleTemplate: string | null,
    experimentTemplates: string[],
    position: number
  ): SdrfColumn {
    return {
      name: 'characteristics[material type]',
      type: 'characteristics',
      value: getDefaultMaterialType(sampleTemplate, experimentTemplates),
      modifiers: [],
      columnPosition: position,
      isRequired: true,
    };
  }

  private createSexColumn(state: WizardState, position: number): SdrfColumn {
    const defaultValue = state.defaultSex || 'not available';
    const { modifiers } = this.modsFromRows(row => {
      const sample = this.findSample(state, row.sampleIndex);
      return sample?.sex || defaultValue;
    }, defaultValue);

    return {
      name: 'characteristics[sex]',
      type: 'characteristics',
      value: defaultValue,
      modifiers,
      columnPosition: position,
    };
  }

  private createAgeColumn(state: WizardState, position: number): SdrfColumn {
    const defaultValue = state.defaultAge || 'not available';
    const { modifiers } = this.modsFromRows(row => {
      const sample = this.findSample(state, row.sampleIndex);
      return sample?.age || defaultValue;
    }, defaultValue);

    return {
      name: 'characteristics[age]',
      type: 'characteristics',
      value: defaultValue,
      modifiers,
      columnPosition: position,
    };
  }

  private createCellLineColumn(state: WizardState, position: number): SdrfColumn {
    const defaultValue = state.defaultCellLine || 'not applicable';
    const { modifiers } = this.modsFromRows(row => {
      const sample = this.findSample(state, row.sampleIndex);
      return sample?.cellLine || defaultValue;
    }, defaultValue);

    return {
      name: 'characteristics[cell line]',
      type: 'characteristics',
      value: defaultValue,
      modifiers,
      columnPosition: position,
    };
  }

  private createStrainBreedColumn(state: WizardState, position: number): SdrfColumn {
    return {
      name: 'characteristics[strain/breed]',
      type: 'characteristics',
      value: state.strainBreed || 'not available',
      modifiers: [],
      columnPosition: position,
    };
  }

  private createDevelopmentalStageColumn(state: WizardState, position: number): SdrfColumn {
    return {
      name: 'characteristics[developmental stage]',
      type: 'characteristics',
      value: state.developmentalStage || 'not available',
      modifiers: [],
      columnPosition: position,
    };
  }

  private createBiologicalReplicateColumn(state: WizardState, position: number): SdrfColumn {
    const { value, modifiers } = this.modsFromRows(r => String(r.biologicalReplicate));
    return {
      name: 'characteristics[biological replicate]',
      type: 'characteristics',
      value: value || '1',
      modifiers,
      columnPosition: position,
    };
  }

  private createAssayNameColumn(state: WizardState, position: number): SdrfColumn {
    const { value, modifiers } = this.modsFromRows(row => assayNameForFile(row.fileName));
    return {
      name: 'assay name',
      type: 'comment',
      value: value || 'assay',
      modifiers,
      columnPosition: position,
      isRequired: true,
    };
  }

  private createTechnologyTypeColumn(position: number): SdrfColumn {
    return {
      name: 'technology type',
      type: 'comment',
      value: 'proteomic profiling by mass spectrometry',
      modifiers: [],
      columnPosition: position,
      isRequired: true,
    };
  }

  private createDataAcquisitionMethodColumn(state: WizardState, position: number): SdrfColumn {
    const method = state.acquisitionMethod || 'dda';

    const byMethod: Record<string, string> = {
      dia: 'NT=Data-independent acquisition;AC=PRIDE:0000450',
      dda: 'NT=Data-dependent acquisition;AC=PRIDE:0000627',
      prm: 'NT=Parallel reaction monitoring;AC=PRIDE:0000629',
      srm: 'NT=Selected reaction monitoring;AC=PRIDE:0000630',
    };
    const value = byMethod[method] || byMethod['dda'];

    return {
      name: 'comment[proteomics data acquisition method]',
      type: 'comment',
      value,
      modifiers: [],
      columnPosition: position,
      isRequired: true,
    };
  }

  private createFractionColumn(state: WizardState, position: number): SdrfColumn {
    const { value, modifiers } = this.modsFromRows(r => String(r.fractionId));
    const allOne = this.expansionRows.length === 0 || this.expansionRows.every(r => r.fractionId === 1);
    return {
      name: 'comment[fraction identifier]',
      type: 'comment',
      value: value || '1',
      modifiers: allOne ? [] : modifiers,
      columnPosition: position,
      isRequired: true,
    };
  }

  private createLabelColumn(state: WizardState, position: number): SdrfColumn {
    const { value, modifiers } = this.modsFromRows(r => r.label);
    const allSame =
      this.expansionRows.length === 0 ||
      this.expansionRows.every(r => r.label === this.expansionRows[0].label);
    return {
      name: 'comment[label]',
      type: 'comment',
      value: value || 'label free sample',
      modifiers: allSame ? [] : modifiers,
      columnPosition: position,
      isRequired: true,
    };
  }

  private createTechnicalReplicateColumn(state: WizardState, position: number): SdrfColumn {
    const { value, modifiers } = this.modsFromRows(r => String(r.technicalReplicate));
    return {
      name: 'comment[technical replicate]',
      type: 'comment',
      value: value || '1',
      modifiers,
      columnPosition: position,
      isRequired: true,
    };
  }

  private createInstrumentColumn(state: WizardState, position: number): SdrfColumn {
    let value = 'not available';
    if (state.instrument) {
      value = state.instrument.id
        ? `NT=${state.instrument.label};AC=${state.instrument.id}`
        : state.instrument.label;
    }

    return {
      name: 'comment[instrument]',
      type: 'comment',
      value,
      modifiers: [],
      columnPosition: position,
      isRequired: true,
      ontologyType: 'ms',
    };
  }

  private createCleavageAgentColumn(state: WizardState, position: number): SdrfColumn {
    let value = 'not available';
    if (state.cleavageAgent) {
      value = `NT=${state.cleavageAgent.name};AC=${state.cleavageAgent.msAccession}`;
    }

    return {
      name: 'comment[cleavage agent details]',
      type: 'comment',
      value,
      modifiers: [],
      columnPosition: position,
      isRequired: true,
    };
  }

  private createModificationColumn(mod: WizardModification, position: number): SdrfColumn {
    // Spec order: NT → AC → remaining keys (MT, TA, PP, ...)
    const parts = [`NT=${mod.name}`];
    if (mod.unimodAccession) {
      parts.push(`AC=${mod.unimodAccession}`);
    }
    parts.push(`MT=${mod.type}`);
    parts.push(`TA=${mod.targetAminoAcids}`);
    if (mod.position) {
      parts.push(`PP=${mod.position}`);
    }

    return {
      name: 'comment[modification parameters]',
      type: 'comment',
      value: parts.join(';'),
      modifiers: [],
      columnPosition: position,
      isRequired: true,
    };
  }

  private createDataFileColumn(state: WizardState, position: number): SdrfColumn {
    const { value, modifiers } = this.modsFromRows(r => r.fileName);
    return {
      name: 'comment[data file]',
      type: 'comment',
      value: value || 'data.raw',
      modifiers,
      columnPosition: position,
      isRequired: true,
    };
  }

  private createSdrfVersionColumn(position: number): SdrfColumn {
    // Validator expects semantic version with leading "v" (e.g. v3.0.0), not 3.0.0
    return {
      name: 'comment[sdrf version]',
      type: 'comment',
      value: formatSdrfSemver(SDRF_SPEC_VERSION),
      modifiers: [],
      columnPosition: position,
    };
  }

  private createSdrfTemplateColumns(state: WizardState, startPosition: number): SdrfColumn[] {
    const leaves = this.templateService.getLeafTemplateIds({
      technologyTemplate: state.technologyTemplate,
      sampleTemplate: getSampleTemplateId(state),
      experimentTemplates: state.experimentTemplates || [],
    });

    if (leaves.length === 0) {
      leaves.push('ms-proteomics');
    }

    return leaves.map((name, i) => {
      const version = formatSdrfSemver(
        this.templateService.getTemplateVersion(name) || SDRF_SPEC_VERSION
      );
      return {
        name: 'comment[sdrf template]',
        type: 'comment' as ColumnType,
        // Spec preferred simple format: "template_name vX.Y.Z"
        value: `${name} ${version}`,
        modifiers: [],
        columnPosition: startPosition + i,
      };
    });
  }

  private createFactorColumn(
    state: WizardState,
    factor: WizardFactor,
    position: number
  ): SdrfColumn {
    const name = `factor value[${factor.name.trim().toLowerCase()}]`;
    const candidates = factorCandidates(state, factor);
    const defaultValue = candidates.length === 1 ? candidates[0] : 'not available';
    const modifiers = this.modsFromRows(row => {
      if (factor.scope === 'run') return resolveRunFactorValue(state.msRuns.find(run => run.id === row.runId), factor) || 'not available';
      const sample = this.findSample(state, row.sampleIndex);
      return sample ? resolveFactorValue(state, sample, factor) || 'not available' : 'not available';
    }, defaultValue).modifiers;

    return {
      name,
      type: 'factor_value',
      value: defaultValue,
      modifiers,
      columnPosition: position,
    };
  }

  private createDynamicColumn(colDefault: DynamicColumnDefault, position: number): SdrfColumn {
    let type: ColumnType = 'comment';
    if (colDefault.columnName.startsWith('characteristics[')) {
      type = 'characteristics';
    } else if (colDefault.columnName.startsWith('factor value[')) {
      type = 'factor_value';
    }

    return {
      name: colDefault.columnName,
      type,
      value: colDefault.value,
      modifiers: [],
      columnPosition: position,
    };
  }

  private hasCharacteristicOutputValue(state: WizardState, columnName: string): boolean {
    const key = getSpecialtyCharacteristicKey(columnName);
    switch (key) {
      case 'organism':
        return !!(
          state.organism ||
          state.samples.some(s => !!s.organism)
        );
      case 'disease':
        return !!(
          (typeof state.disease === 'string' && state.disease.trim()) ||
          (typeof state.disease === 'object' && state.disease?.label) ||
          state.samples.some(s => !!s.disease)
        );
      case 'organism part':
        return !!(
          (typeof state.organismPart === 'string' && state.organismPart.trim()) ||
          (typeof state.organismPart === 'object' && state.organismPart?.label) ||
          state.samples.some(s => !!s.organismPart)
        );
      case 'sex':
        return !!(state.defaultSex || state.samples.some(s => !!s.sex));
      case 'age':
        return !!(state.defaultAge?.trim() || state.samples.some(s => !!s.age?.trim()));
      case 'cell line':
        return !!(
          state.defaultCellLine?.trim() ||
          state.samples.some(s => !!s.cellLine?.trim())
        );
      case 'strain/breed':
        return !!state.strainBreed?.trim();
      case 'developmental stage':
        return !!state.developmentalStage?.trim();
      default: {
        const def = state.dynamicColumnDefaults.find(d => d.columnName === columnName);
        if (def?.value?.trim()) return true;
        return state.samples.some(
          s => !!s.customCharacteristics?.[columnName]?.trim()
        );
      }
    }
  }

  private createDynamicCharacteristicColumn(
    state: WizardState,
    columnName: string,
    position: number
  ): SdrfColumn {
    const def = state.dynamicColumnDefaults.find(d => d.columnName === columnName);
    const defaultValue = def?.value?.trim() || 'not available';
    const { modifiers } = this.modsFromRows(row => {
      const sample = this.findSample(state, row.sampleIndex);
      const override = sample?.customCharacteristics?.[columnName]?.trim();
      const fromChoices = sample?.characteristicValues?.[columnName]?.trim();
      return override || fromChoices || defaultValue;
    }, defaultValue);

    return {
      name: columnName,
      type: 'characteristics',
      value: defaultValue,
      modifiers,
      columnPosition: position,
    };
  }
}
