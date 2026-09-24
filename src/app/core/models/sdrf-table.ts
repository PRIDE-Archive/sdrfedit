/**
 * SDRF Table Models
 *
 * Defines the structure for SDRF tables including sample pools.
 */

import { SdrfColumn } from './sdrf-column';

/**
 * Represents a pool of samples in SDRF.
 * Pools are defined by SN= notation in characteristics[pooled sample] column.
 */
export interface SamplePool {
  /** Name of the pool */
  poolName: string;

  /** Sample indices that are ONLY in this pool (not independent) */
  pooledOnlySamples: number[];

  /** Sample indices that are in this pool AND also analyzed independently */
  pooledAndIndependentSamples: number[];

  /** Whether this pool is a reference pool */
  isReference: boolean;

  /** SDRF value (e.g., "SN=sample1,sample2") */
  sdrfValue: string;

  /** Metadata columns for this pool (derived from pooled samples) */
  metadata?: SdrfColumn[];
}

/**
 * Represents an in-memory SDRF table.
 */
export interface SdrfTable {
  /** Columns in the table */
  columns: SdrfColumn[];

  /** Number of samples (rows) in the table */
  sampleCount: number;

  /** Sample pools detected from pooled sample column */
  pools: SamplePool[];

  /** Optional metadata about the table */
  metadata?: SdrfTableMetadata;
}

/**
 * Optional metadata about the SDRF table.
 */
export interface SdrfTableMetadata {
  templateSnapshotId?: string;
  templateRefs?: Array<{ name: string; version: string }>;
  /** Original filename if loaded from file */
  filename?: string;

  /** Source URL if loaded from URL */
  sourceUrl?: string;

  /** When the table was loaded/created */
  loadedAt?: Date;

  /** When the table was last modified */
  modifiedAt?: Date;

  /** SDRF specification version */
  version?: string;
}

/**
 * Creates an empty SDRF table.
 */
export function createEmptyTable(sampleCount: number = 1): SdrfTable {
  return {
    columns: [],
    sampleCount,
    pools: [],
    metadata: {
      loadedAt: new Date(),
      modifiedAt: new Date(),
    },
  };
}

/**
 * Gets all unique values for a column across all samples.
 */
export function getUniqueValuesForColumn(
  table: SdrfTable,
  columnIndex: number
): string[] {
  const column = table.columns[columnIndex];
  if (!column) return [];

  const values = new Set<string>();

  // Add default value
  if (column.value) {
    values.add(column.value);
  }

  // Add modifier values
  for (const modifier of column.modifiers) {
    if (modifier.value) {
      values.add(modifier.value);
    }
  }

  return Array.from(values);
}

/**
 * Gets the full data matrix for the table.
 * Returns a 2D array where each row is a sample.
 */
export function getTableDataMatrix(table: SdrfTable): string[][] {
  const matrix: string[][] = [];

  for (let sampleIndex = 1; sampleIndex <= table.sampleCount; sampleIndex++) {
    const row: string[] = [];

    for (const column of table.columns) {
      let value = column.value;

      // Check modifiers for sample-specific value
      for (const modifier of column.modifiers) {
        if (isSampleInModifierRange(sampleIndex, modifier.samples)) {
          value = modifier.value;
          break;
        }
      }

      row.push(value);
    }

    matrix.push(row);
  }

  return matrix;
}

/**
 * Helper to check if sample is in modifier range.
 */
function isSampleInModifierRange(sampleIndex: number, rangeString: string): boolean {
  const parts = rangeString.split(',');

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.includes('-')) {
      const [start, end] = trimmed.split('-').map(Number);
      if (sampleIndex >= start && sampleIndex <= end) {
        return true;
      }
    } else {
      if (sampleIndex === Number(trimmed)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Finds a column by name (case-insensitive).
 */
export function findColumnByName(
  table: SdrfTable,
  name: string
): SdrfColumn | undefined {
  const nameLower = name.toLowerCase();
  return table.columns.find((col) => col.name.toLowerCase() === nameLower);
}

/**
 * Finds all columns matching a pattern (e.g., "characteristics[*]").
 */
export function findColumnsByPattern(
  table: SdrfTable,
  pattern: string
): SdrfColumn[] {
  const regex = new RegExp(
    '^' + pattern.replace(/\[/g, '\\[').replace(/\]/g, '\\]').replace(/\*/g, '.*') + '$',
    'i'
  );
  return table.columns.filter((col) => regex.test(col.name));
}
