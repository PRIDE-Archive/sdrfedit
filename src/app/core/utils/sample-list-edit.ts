/** Validate the complete resulting list before a batch or individual edit. */
export function validateSampleListEdit(
  samples: { sourceName: string; biologicalReplicate: number }[],
  targets: number[], values: (string | number)[],
  field: 'sourceName' | 'biologicalReplicate',
): string {
  if (!targets.length) return 'Select at least one sample.';
  if (values.length !== targets.length) return `Expected ${targets.length} values; received ${values.length}.`;
  if (targets.some(index => !Number.isInteger(index) || index < 0 || index >= samples.length)) return 'The sample list changed. Select the samples again.';
  if (field === 'biologicalReplicate') {
    return values.some(value => typeof value !== 'number' || !Number.isInteger(value) || value < 1)
      ? 'Use positive whole numbers for biological replicates.' : '';
  }
  if (values.some(value => typeof value !== 'string' || !value.trim() || /[\t\r\n]/.test(value))) return 'Enter a non-empty sample name without tabs or line breaks.';
  const names = samples.map(sample => sample.sourceName);
  targets.forEach((index, i) => { names[index] = String(values[i]).trim(); });
  return new Set(names).size !== names.length ? 'Sample names must be unique, including unselected samples.' : '';
}

/** Parse one-based row numbers/ranges without silently accepting invalid selections. */
export function parseSampleRowSelection(text: string, count: number): number[] {
  if (!text.trim()) throw new Error('Enter sample row numbers, for example 1-11, 15, 18-22.');
  const selected = new Set<number>();
  for (const token of text.trim().split(/[,;，\s]+/).filter(Boolean)) {
    const match = /^(\d+)(?:[-–](\d+))?$/.exec(token);
    if (!match) throw new Error(`Invalid range: ${token}. Use row numbers such as 1-11, 15.`);
    const start = Number(match[1]), end = Number(match[2] ?? match[1]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > count) {
      throw new Error(`Choose row numbers between 1 and ${count}, with each range in ascending order.`);
    }
    for (let index = start - 1; index < end; index++) selected.add(index);
  }
  return [...selected].sort((a, b) => a - b);
}

export function previewRegexRename(names: string[], pattern: string, replacement: string, ignoreCase = false): string[] {
  if (!pattern) throw new Error('Enter a regular expression.');
  const expression = new RegExp(pattern, ignoreCase ? 'i' : '');
  return names.map(name => name.replace(expression, replacement));
}
