/**
 * SDRF Validator Service
 *
 * Provides comprehensive validation for SDRF tables including:
 * - Required column checks
 * - Format validation (collision energy, age, mass tolerance, etc.)
 * - Ontology validation (via OLS API)
 * - Modification format validation
 *
 * Based on SDRF-Proteomics specification v1.1.0
 */

import { equivalentFactorValue } from '../utils/factor-values';
import { SdrfTable } from '../models/sdrf-table';
import { SdrfColumn, getValueForSample } from '../models/sdrf-column';
import { getRequiredSdrfColumns, getSdrfColumnConfig } from '../models/sdrf-config';
import {
  ValidationResult,
  ValidationError,
  ValidationOptions,
  createEmptyValidationResult,
  createValidationError,
  createValidationWarning,
} from '../models/validation';
import { DirectOlsService } from './ols.service';
import { decodeSampleRange } from '../utils/sample-range';

/**
 * Validation patterns for SDRF v1.1.0
 */
const VALIDATION_PATTERNS = {
  // Collision energy: "30 NCE", "30% NCE", "25 NCE;27 NCE;30 NCE"
  collisionEnergy: /^\d+(\.\d+)?%? (NCE|eV)(;\d+(\.\d+)?%? (NCE|eV))*$|^not available$/,

  // Age format: "30Y", "30Y6M", "25Y-35Y"
  age: /^(\d+Y)?(\d+M)?(\d+D)?(-(\d+Y)?(\d+M)?(\d+D)?)?$|^not available$|^not applicable$/,

  // Mass tolerance: "10 ppm", "0.02 Da"
  massTolerance: /^\d+(\.\d+)?\s*(ppm|Da)$|^not available$|^not applicable$/,

  // Scan window limits: numeric
  scanWindowLimit: /^\d+(\.\d+)?$|^not available$|^not applicable$/,

  // ProteomeXchange accession: PXD followed by 6 digits
  pxdAccession: /^PXD\d{6}$/,
};

/**
 * Required columns per SDRF-Proteomics specification
 */
const REQUIRED_COLUMNS = [
  'source name',
  'characteristics[organism]',
  'characteristics[disease]',
  'characteristics[organism part]',
  'assay name',
  'technology type',
  'comment[label]',
  'comment[data file]',
  'comment[instrument]',
  'comment[modification parameters]',
  'comment[cleavage agent details]',
];

/**
 * Column-to-ontology mapping for validation
 */
const COLUMN_ONTOLOGIES: Record<string, string[]> = {
  'characteristics[organism]': ['ncbitaxon'],
  'characteristics[disease]': ['efo', 'mondo', 'doid'],
  'characteristics[cell type]': ['cl', 'bto'],
  'characteristics[organism part]': ['uberon', 'bto'],
  'characteristics[cell line]': ['clo', 'bto'],
  'comment[instrument]': ['ms'],
  'comment[dissociation method]': ['ms', 'pride'],
  'comment[fractionation method]': ['pride'],
};

/**
 * SDRF Validator Service
 *
 * Validates SDRF tables against the specification.
 */
export class SdrfValidatorService {
  private olsService: DirectOlsService;

  constructor(olsService?: DirectOlsService) {
    this.olsService = olsService || new DirectOlsService();
  }

  /**
   * Validates an entire SDRF table.
   *
   * @param table The table to validate
   * @param options Validation options
   * @returns Validation result with errors and warnings
   */
  async validate(
    table: SdrfTable,
    options: ValidationOptions = {}
  ): Promise<ValidationResult> {
    const result = createEmptyValidationResult();
    result.options = options;

    const errors: ValidationError[] = [];
    const warnings: ValidationError[] = [];

    // 1. Validate required columns
    const requiredErrors = this.validateRequiredColumns(table);
    errors.push(...requiredErrors);

    // 2. Validate column formats
    for (const column of table.columns) {
      if (options.skipColumns?.includes(column.name)) {
        continue;
      }

      const columnErrors = this.validateColumnFormat(column, table.sampleCount);
      errors.push(...columnErrors.filter((e) => e.type === 'error'));
      warnings.push(...columnErrors.filter((e) => e.type === 'warning'));
    }

    // 3. Validate ontology terms (if enabled)
    if (options.validateOntology !== false) {
      const ontologyErrors = await this.validateOntologyTerms(table, options);
      warnings.push(...ontologyErrors);
    }

    // 4. Validate pools
    const poolErrors = this.validatePools(table);
    errors.push(...poolErrors.filter((e) => e.type === 'error'));
    warnings.push(...poolErrors.filter((e) => e.type === 'warning'));

    // 5. Check for duplicates and other structural issues
    const structuralErrors = this.validateStructure(table);
    errors.push(...structuralErrors.filter((e) => e.type === 'error'));
    warnings.push(...structuralErrors.filter((e) => e.type === 'warning'));

    // 6. Validate whitespace issues
    const whitespaceErrors = this.validateWhitespace(table);
    warnings.push(...whitespaceErrors);

    // 7. Validate factor-characteristic relationships
    const factorErrors = this.validateFactorCharacteristicRelations(table);
    warnings.push(...factorErrors.filter((e) => e.type === 'warning'));
    errors.push(...factorErrors.filter((e) => e.type === 'error'));

    // Build result
    result.errors = errors;
    result.warnings = warnings;
    result.isValid = errors.length === 0;
    result.timestamp = new Date();

    result.summary = {
      errorCount: errors.length,
      warningCount: warnings.length,
      infoCount: 0,
      columnsValidated: table.columns.length,
      samplesValidated: table.sampleCount,
      ontologyValidated: options.validateOntology !== false,
    };

    // Apply strict mode if enabled
    if (options.strictMode && warnings.length > 0) {
      result.isValid = false;
    }

    return result;
  }

  /**
   * Validates that all required columns are present.
   */
  private validateRequiredColumns(table: SdrfTable): ValidationError[] {
    const errors: ValidationError[] = [];
    const presentColumns = new Set(
      table.columns.map((c) => c.name.toLowerCase())
    );

    for (const required of REQUIRED_COLUMNS) {
      if (!presentColumns.has(required.toLowerCase())) {
        errors.push(
          createValidationError(
            'MISSING_REQUIRED_COLUMN',
            `Required column '${required}' is missing`,
            { column: required }
          )
        );
      }
    }

    return errors;
  }

  /**
   * Validates the format of a column's values.
   */
  private validateColumnFormat(
    column: SdrfColumn,
    sampleCount: number
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const name = column.name.toLowerCase();

    // Get all unique values to validate
    const valuesToValidate = this.getUniqueValuesToValidate(column);

    // Collision energy validation
    if (name.includes('collision energy')) {
      for (const value of valuesToValidate) {
        if (value && !VALIDATION_PATTERNS.collisionEnergy.test(value)) {
          errors.push(
            createValidationError(
              'INVALID_COLLISION_ENERGY',
              `Invalid collision energy format: '${value}'. Expected: {value} {unit} (e.g., '30 NCE', '25% NCE;27% NCE')`,
              { column: column.name, value }
            )
          );
        }
      }
    }

    // Age format validation
    else if (name === 'characteristics[age]') {
      for (const value of valuesToValidate) {
        if (value && !VALIDATION_PATTERNS.age.test(value)) {
          errors.push(
            createValidationWarning(
              'INVALID_AGE_FORMAT',
              `Non-standard age format: '${value}'. Expected: XY[XM][XD] (e.g., '30Y', '30Y6M', '25Y-35Y')`,
              { column: column.name, value }
            )
          );
        }
      }
    }

    // Mass tolerance validation
    else if (
      name.includes('mass tolerance') ||
      name.includes('precursor mass tolerance') ||
      name.includes('fragment mass tolerance')
    ) {
      for (const value of valuesToValidate) {
        if (value && !VALIDATION_PATTERNS.massTolerance.test(value)) {
          errors.push(
            createValidationError(
              'INVALID_MASS_TOLERANCE',
              `Invalid mass tolerance format: '${value}'. Expected: {value} {unit} (e.g., '10 ppm', '0.02 Da')`,
              { column: column.name, value }
            )
          );
        }
      }
    }

    // Scan window limits validation
    else if (
      name.includes('scan window lower limit') ||
      name.includes('scan window upper limit') ||
      name.includes('isolation window width')
    ) {
      for (const value of valuesToValidate) {
        if (value && !VALIDATION_PATTERNS.scanWindowLimit.test(value)) {
          errors.push(
            createValidationWarning(
              'INVALID_PATTERN',
              `Invalid numeric format: '${value}'. Expected: numeric value`,
              { column: column.name, value }
            )
          );
        }
      }
    }

    // Modification parameters validation
    else if (name === 'comment[modification parameters]') {
      for (const value of valuesToValidate) {
        if (value && value !== 'not available') {
          const modErrors = this.validateModificationFormat(value, column.name);
          errors.push(...modErrors);
        }
      }
    }

    // Cleavage agent validation
    else if (name === 'comment[cleavage agent details]') {
      for (const value of valuesToValidate) {
        if (value && value !== 'not available') {
          const cleavageErrors = this.validateCleavageFormat(value, column.name);
          errors.push(...cleavageErrors);
        }
      }
    }

    // ProteomeXchange accession validation
    else if (name === 'comment[proteomexchange accession number]') {
      for (const value of valuesToValidate) {
        if (value && !VALIDATION_PATTERNS.pxdAccession.test(value)) {
          errors.push(
            createValidationWarning(
              'INVALID_PATTERN',
              `Invalid ProteomeXchange accession: '${value}'. Expected format: PXD000000`,
              { column: column.name, value }
            )
          );
        }
      }
    }

    // Check for empty required values
    if (column.isRequired && !column.value && column.modifiers.length === 0) {
      errors.push(
        createValidationError(
          'EMPTY_REQUIRED_VALUE',
          `Required column '${column.name}' has no values`,
          { column: column.name }
        )
      );
    }

    return errors;
  }

  /**
   * Validates modification parameters format.
   */
  private validateModificationFormat(
    value: string,
    columnName: string
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const pairs = value.split(';');

    const keys: string[] = [];
    for (const pair of pairs) {
      const parts = pair.split('=');
      if (parts.length >= 2) {
        keys.push(parts[0].trim());
      }
    }

    // Check for recommended fields
    if (!keys.includes('NT')) {
      errors.push(
        createValidationWarning(
          'INVALID_MODIFICATION_FORMAT',
          `Modification missing NT (Name of Term): '${value}'`,
          { column: columnName, value, suggestion: 'Add NT=<modification name>' }
        )
      );
    }

    if (!keys.includes('TA')) {
      errors.push(
        createValidationWarning(
          'INVALID_MODIFICATION_FORMAT',
          `Modification missing TA (Target Amino acid): '${value}'`,
          { column: columnName, value, suggestion: 'Add TA=<amino acid>' }
        )
      );
    }

    return errors;
  }

  /**
   * Validates cleavage agent format.
   */
  private validateCleavageFormat(
    value: string,
    columnName: string
  ): ValidationError[] {
    const errors: ValidationError[] = [];
    const pairs = value.split(';');

    const keys: string[] = [];
    for (const pair of pairs) {
      const parts = pair.split('=');
      if (parts.length >= 2) {
        keys.push(parts[0].trim());
      }
    }

    // Check for recommended fields
    if (!keys.includes('NT')) {
      errors.push(
        createValidationWarning(
          'INVALID_CLEAVAGE_FORMAT',
          `Cleavage agent missing NT (Name of Term): '${value}'`,
          { column: columnName, value, suggestion: 'Add NT=<enzyme name>' }
        )
      );
    }

    return errors;
  }

  /**
   * Validates ontology terms against OLS.
   */
  private async validateOntologyTerms(
    table: SdrfTable,
    options: ValidationOptions
  ): Promise<ValidationError[]> {
    const warnings: ValidationError[] = [];
    const validatedTerms = new Set<string>();

    for (const column of table.columns) {
      const ontologies = COLUMN_ONTOLOGIES[column.name.toLowerCase()];
      if (!ontologies) continue;

      // Get unique values
      const values = this.getUniqueValuesToValidate(column);

      for (const value of values) {
        if (!value) continue;

        const lower = value.toLowerCase();
        if (lower === 'not applicable' || lower === 'not available') continue;

        // Skip if already validated
        const cacheKey = `${column.name}:${value}`;
        if (validatedTerms.has(cacheKey)) continue;
        validatedTerms.add(cacheKey);

        // Validate against OLS
        try {
          const isValid = await this.olsService.validateTerm(value, ontologies);

          if (!isValid) {
            warnings.push(
              createValidationWarning(
                'ONTOLOGY_TERM_NOT_FOUND',
                `Term '${value}' not found in ${ontologies.join('/')} ontologies`,
                { column: column.name, value }
              )
            );
          }
        } catch {
          // Skip validation on network errors
        }
      }
    }

    return warnings;
  }

  /**
   * Validates sample pools.
   */
  private validatePools(table: SdrfTable): ValidationError[] {
    const errors: ValidationError[] = [];

    for (const pool of table.pools) {
      // Check that pooled samples exist
      const allPooledSamples = [
        ...pool.pooledOnlySamples,
        ...pool.pooledAndIndependentSamples,
      ];

      for (const sampleIndex of allPooledSamples) {
        if (sampleIndex < 1 || sampleIndex > table.sampleCount) {
          errors.push(
            createValidationError(
              'POOL_SAMPLE_NOT_FOUND',
              `Pool '${pool.poolName}' references non-existent sample ${sampleIndex}`,
              { value: pool.poolName }
            )
          );
        }
      }

      // Warn if pool has no samples
      if (allPooledSamples.length === 0) {
        errors.push(
          createValidationWarning(
            'INVALID_POOL_REFERENCE',
            `Pool '${pool.poolName}' has no samples`,
            { value: pool.poolName }
          )
        );
      }
    }

    return errors;
  }

  /**
   * Validates table structure.
   */
  private validateStructure(table: SdrfTable): ValidationError[] {
    const errors: ValidationError[] = [];

    // Check for duplicate column names
    const columnNames = new Map<string, number>();
    for (const column of table.columns) {
      const name = column.name.toLowerCase();
      const count = (columnNames.get(name) || 0) + 1;
      columnNames.set(name, count);

      // Only warn for non-multiple columns (modification parameters can be multiple)
      if (count > 1 && !name.includes('modification parameters')) {
        errors.push(
          createValidationWarning(
            'DUPLICATE_COLUMN_NAME',
            `Duplicate column name: '${column.name}' (occurrence ${count})`,
            { column: column.name }
          )
        );
      }
    }

    // Check for empty table
    if (table.columns.length === 0) {
      errors.push(
        createValidationError(
          'UNKNOWN_ERROR',
          'Table has no columns',
          {}
        )
      );
    }

    if (table.sampleCount === 0) {
      errors.push(
        createValidationError(
          'UNKNOWN_ERROR',
          'Table has no samples',
          {}
        )
      );
    }

    return errors;
  }

  /**
   * Validates factor value columns against corresponding characteristics columns.
   * Factor values should reference values that exist in the corresponding characteristics column.
   */
  private validateFactorCharacteristicRelations(table: SdrfTable): ValidationError[] {
    const errors: ValidationError[] = [];

    // Find all factor value columns
    const factorColumns = table.columns.filter((c) =>
      c.name.toLowerCase().startsWith('factor value[')
    );

    // Build a map of characteristics columns
    const characteristicsMap = new Map<string, SdrfColumn>();
    for (const col of table.columns) {
      const match = col.name.toLowerCase().match(/^characteristics\[(.+)\]$/);
      if (match) {
        characteristicsMap.set(match[1].toLowerCase(), col);
      }
    }

    for (const factorCol of factorColumns) {
      // Extract the factor name (e.g., "factor value[disease]" -> "disease")
      const match = factorCol.name.toLowerCase().match(/^factor value\[(.+)\]$/);
      if (!match) continue;

      const factorName = match[1].toLowerCase();
      const correspondingChar = characteristicsMap.get(factorName);

      if (!correspondingChar) {
        // Factor value without corresponding characteristics - this is a warning
        errors.push(
          createValidationWarning(
            'FACTOR_MISSING_CHARACTERISTIC',
            `Factor value column '${factorCol.name}' has no corresponding 'characteristics[${factorName}]' column`,
            { column: factorCol.name }
          )
        );
        continue;
      }

      // Get all values from both columns
      const factorValues = this.getAllValuesForColumn(factorCol, table.sampleCount);
      const charValues = this.getAllValuesForColumn(correspondingChar, table.sampleCount);

      // Compare corresponding rows; set membership misses swapped sample groups.
      for (let sampleIdx = 0; sampleIdx < factorValues.length; sampleIdx++) {
        const factorValue = factorValues[sampleIdx];
        if (!factorValue || factorValue.toLowerCase() === 'not available' || factorValue.toLowerCase() === 'not applicable') {
          continue;
        }

        const characteristicValue = charValues[sampleIdx] || '';
        if (!equivalentFactorValue(factorValue, characteristicValue)) {
          errors.push(
            createValidationWarning(
              'FACTOR_CHARACTERISTIC_MISMATCH',
              `Factor value '${factorValue}' differs from '${characteristicValue}' in '${correspondingChar.name}' on the same row`,
              {
                column: factorCol.name,
                value: factorValue,
                row: sampleIdx + 1,
                suggestion: `Check this sample's group assignment; independently defined groups may intentionally differ.`,
              }
            )
          );
        }
      }
    }

    return errors;
  }

  /**
   * Gets all values for a column across all samples.
   */
  private getAllValuesForColumn(column: SdrfColumn, sampleCount: number): string[] {
    const values: string[] = [];

    // If column has a single value for all samples
    if (column.value && column.modifiers.length === 0) {
      for (let i = 0; i < sampleCount; i++) {
        values.push(column.value);
      }
      return values;
    }

    // Use getValueForSample if modifiers exist
    for (let sampleIdx = 1; sampleIdx <= sampleCount; sampleIdx++) {
      const value = getValueForSample(column, sampleIdx);
      values.push(value);
    }

    return values;
  }

  /**
   * Validates whitespace issues in values.
   * Checks for leading/trailing whitespace which can cause issues with ontology matching.
   */
  private validateWhitespace(table: SdrfTable): ValidationError[] {
    const warnings: ValidationError[] = [];

    for (let colIdx = 0; colIdx < table.columns.length; colIdx++) {
      const column = table.columns[colIdx];

      // Check column-level value
      if (column.value) {
        const trimmed = column.value.trim();
        if (column.value !== trimmed) {
          if (trimmed === '') {
            warnings.push(
              createValidationWarning(
                'EMPTY_VALUE_WITH_WHITESPACE',
                `Column '${column.name}' has value with only whitespace`,
                { column: column.name, columnIndex: colIdx, value: column.value }
              )
            );
          } else {
            warnings.push(
              createValidationWarning(
                'LEADING_TRAILING_WHITESPACE',
                `Column '${column.name}' has leading/trailing whitespace in value '${column.value}'`,
                {
                  column: column.name,
                  columnIndex: colIdx,
                  value: column.value,
                  suggestion: `Trim to '${trimmed}'`,
                }
              )
            );
          }
        }
      }

      // Check modifier values
      for (const modifier of column.modifiers) {
        if (modifier.value) {
          const trimmed = modifier.value.trim();
          if (modifier.value !== trimmed) {
            const samples = modifier.samples;
            if (trimmed === '') {
              warnings.push(
                createValidationWarning(
                  'EMPTY_VALUE_WITH_WHITESPACE',
                  `Column '${column.name}' has value with only whitespace for samples ${samples}`,
                  {
                    column: column.name,
                    columnIndex: colIdx,
                    value: modifier.value,
                    row: parseInt(samples.split('-')[0]) || 1,
                  }
                )
              );
            } else {
              warnings.push(
                createValidationWarning(
                  'LEADING_TRAILING_WHITESPACE',
                  `Column '${column.name}' has leading/trailing whitespace in '${modifier.value}' for samples ${samples}`,
                  {
                    column: column.name,
                    columnIndex: colIdx,
                    value: modifier.value,
                    row: parseInt(samples.split('-')[0]) || 1,
                    suggestion: `Trim to '${trimmed}'`,
                  }
                )
              );
            }
          }
        }
      }
    }

    return warnings;
  }

  /**
   * Gets all unique values from a column for validation.
   */
  private getUniqueValuesToValidate(column: SdrfColumn): string[] {
    const values = new Set<string>();

    if (column.value) {
      values.add(column.value);
    }

    for (const modifier of column.modifiers) {
      if (modifier.value) {
        values.add(modifier.value);
      }
    }

    return Array.from(values);
  }

  /**
   * Validates a single value against a pattern.
   */
  validatePattern(value: string, pattern: RegExp): boolean {
    return pattern.test(value);
  }

  /**
   * Gets the validation patterns.
   */
  getValidationPatterns(): Record<string, RegExp> {
    return { ...VALIDATION_PATTERNS };
  }

  /**
   * Gets the required columns.
   */
  getRequiredColumns(): string[] {
    return [...REQUIRED_COLUMNS];
  }
}

// Export singleton instance for convenience
export const sdrfValidator = new SdrfValidatorService();
