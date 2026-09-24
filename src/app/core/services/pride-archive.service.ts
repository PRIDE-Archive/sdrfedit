/**
 * PRIDE Archive client — fetch project file lists by ProteomeXchange accession (PXD…).
 * API: https://www.ebi.ac.uk/pride/ws/archive/v3/
 */

export interface PrideArchiveFile {
  fileName: string;
  category: string;
  sizeBytes?: number;
}

const PRIDE_API_BASE = 'https://www.ebi.ac.uk/pride/ws/archive/v3';

const RAW_CATEGORY = 'RAW';
/** Instrument raw dumps commonly deposited as RAW in PRIDE. */
const RAW_NAME_RE = /\.(raw|wiff|wiff2|d|baf|lcd|qgd)(\.tar\.gz|\.tar|\.zip|\.gz)?$/i;

export function normalizePxdAccession(input: string): string {
  const trimmed = (input || '').trim().toUpperCase();
  if (!trimmed) return '';
  if (/^PXD\d+$/i.test(trimmed)) return trimmed;
  if (/^\d+$/.test(trimmed)) {
    return `PXD${trimmed.padStart(6, '0')}`;
  }
  return trimmed;
}

export function isValidPxdAccession(accession: string): boolean {
  return /^PXD\d{6,}$/i.test(accession.trim());
}

function categoryValue(file: Record<string, unknown>): string {
  const cat = file['fileCategory'];
  if (typeof cat === 'string') return cat;
  if (cat && typeof cat === 'object' && cat !== null && 'value' in cat) {
    return String((cat as { value?: string }).value || '');
  }
  return '';
}

function isLikelyRawFile(fileName: string, category: string): boolean {
  const normalizedCategory = category.trim().toUpperCase();
  if (normalizedCategory) return normalizedCategory === RAW_CATEGORY;
  // Match the backend: infer instrument formats only when classification is absent.
  return RAW_NAME_RE.test(fileName);
}

/**
 * Fetch RAW (and common MS raw-like) filenames for a PXD project.
 */
export async function fetchPrideRawFileNames(
  pxdInput: string,
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<{ accession: string; fileNames: string[] }> {
  const accession = normalizePxdAccession(pxdInput);
  if (!isValidPxdAccession(accession)) {
    throw new Error('Invalid PXD accession. Expected format: PXD000001');
  }

  const timeoutMs = options?.timeoutMs ?? 60000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  options?.signal?.addEventListener('abort', onAbort);

  try {
    const url = `${PRIDE_API_BASE}/projects/${encodeURIComponent(accession)}/files/all`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });

    if (response.status === 404) {
      throw new Error(`Project ${accession} was not found in PRIDE Archive`);
    }
    if (!response.ok) {
      throw new Error(`PRIDE API error (${response.status}) for ${accession}`);
    }

    const payload = (await response.json()) as unknown;
    const list = Array.isArray(payload) ? payload : [];
    const names = new Set<string>();

    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const rec = item as Record<string, unknown>;
      const fileName = String(rec['fileName'] || '').trim();
      if (!fileName) continue;
      const category = categoryValue(rec);
      if (!isLikelyRawFile(fileName, category)) continue;
      names.add(fileName);
    }

    const fileNames = [...names].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
    );

    if (fileNames.length === 0) {
      throw new Error(`No RAW files found for ${accession}`);
    }

    return { accession, fileNames };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error(`Timed out fetching files for ${accession}`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    options?.signal?.removeEventListener('abort', onAbort);
  }
}
