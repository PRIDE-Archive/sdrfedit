/** SDRF database-search tolerance; an empty value means the recommended column is omitted. */
export function normalizeMassTolerance(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Mass tolerance must be text with a unit.');
  const text = value.trim();
  if (!text) return '';
  if (text.toLowerCase() === 'not available') return 'not available';
  const match = /^(\d+(?:\.\d+)?|\.\d+)\s*(ppm|da|mmu)$/i.exec(text);
  if (!match || !Number.isFinite(Number(match[1])) || Number(match[1]) <= 0) {
    throw new Error('Enter a positive number with ppm, Da, or mmu (e.g. 10 ppm or 0.02 Da), or not available.');
  }
  const unit = match[2].toLowerCase() === 'da' ? 'Da' : match[2].toLowerCase();
  return `${Number(match[1])} ${unit}`;
}

export function isValidMassTolerance(value: unknown): boolean {
  try { normalizeMassTolerance(value); return true; } catch { return false; }
}
