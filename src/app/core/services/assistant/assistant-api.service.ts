/**
 * Transport for the wizard AI assistant backend.
 *
 * The backend owns the API keys and the agent loop; this service only streams
 * its server-sent events and forwards user documents.
 */

import { Injectable, signal } from '@angular/core';

import { environment } from '../../../../environments/environment';
import {
  AssistantChatRequest,
  AssistantHealth,
  AssistantStreamEvent,
  AssistantUploadResult,
} from '../../models/assistant';

const RUNTIME_OVERRIDE_KEY = 'sdrf_assistant_url';

/**
 * Extra backend bases to try when the page is opened via IP or domain.
 * Despite the name, a full base URL (including a sub-path) works too -- the
 * hh-11 deployment serves the backend under a path, not at its origin root,
 * so location.origin alone (tried first, in assistantUrlCandidates) can't
 * find it.
 */
const HOSTED_ASSISTANT_ORIGINS = [
  'http://47.93.36.196',
  'http://www.sdrf.site',
  'https://www.sdrf.site',
  'https://www.ebi.ac.uk/pride/services/sdrf-assistant',
];

function normalizeOrigin(url: string): string {
  return url.trim().replace(/\/$/, '');
}

function asOriginList(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map(normalizeOrigin).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map(normalizeOrigin)
      .filter(Boolean);
  }
  return [];
}

/**
 * HTTPS pages may only call HTTP backends on loopback (the official editor +
 * local uvicorn pattern). Other http:// origins are mixed content and must be
 * skipped or the browser blocks them.
 */
function isUsableAssistantOrigin(url: string): boolean {
  if (typeof location === 'undefined' || location.protocol !== 'https:') return true;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    return parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

/**
 * Candidate backend origins, in preference order.
 * Same-origin (IP or domain) is tried first so one deployment works both ways.
 */
export function assistantUrlCandidates(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (url: string) => {
    const origin = normalizeOrigin(url);
    if (!origin || seen.has(origin) || !isUsableAssistantOrigin(origin)) return;
    seen.add(origin);
    out.push(origin);
  };

  const global = globalThis as Record<string, unknown>;
  for (const url of asOriginList(global['__SDRF_ASSISTANT_URLS__'])) add(url);
  for (const url of asOriginList(global['__SDRF_ASSISTANT_URL__'])) add(url);

  try {
    const stored = localStorage.getItem(RUNTIME_OVERRIDE_KEY);
    if (stored) add(stored);
  } catch {
    // Storage can be blocked in embedded iframes; fall through.
  }

  if (typeof location !== 'undefined' && location.origin) add(location.origin);

  for (const url of HOSTED_ASSISTANT_ORIGINS) add(url);
  add(environment.assistantBaseUrl || '');
  return out;
}

/**
 * Resolve the backend origin. CDN-embedded deployments cannot rebuild, so a
 * runtime override wins over the compiled default.
 */
export function resolveAssistantBaseUrl(): string {
  return assistantUrlCandidates()[0] || '';
}

@Injectable({ providedIn: 'root' })
export class AssistantApiService {
  private readonly _health = signal<AssistantHealth | null>(null);
  private readonly _available = signal(false);
  private readonly _checked = signal(false);
  private resolvedBaseUrl = '';
  private controller: AbortController | null = null;

  /** Last health report, or null if the backend has not answered yet. */
  readonly health = this._health.asReadonly();

  /** True when the backend is reachable and an LLM is configured on it. */
  readonly available = this._available.asReadonly();

  /** True once a health check has completed (successfully or not). */
  readonly checked = this._checked.asReadonly();

  get baseUrl(): string {
    return this.resolvedBaseUrl || resolveAssistantBaseUrl();
  }

  setBaseUrl(url: string): void {
    this.resolvedBaseUrl = url.trim().replace(/\/$/, '');
    try {
      if (url.trim()) localStorage.setItem(RUNTIME_OVERRIDE_KEY, url.trim());
      else localStorage.removeItem(RUNTIME_OVERRIDE_KEY);
    } catch {
      // Ignore storage failures; the compiled default still applies.
    }
  }

  async checkHealth(timeoutMs = 2500): Promise<AssistantHealth | null> {
    const candidates = assistantUrlCandidates();
    if (!candidates.length) {
      this._checked.set(true);
      this._available.set(false);
      return null;
    }

    for (const base of candidates) {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), timeoutMs);
      try {
        const response = await fetch(`${base}/api/health`, { signal: abort.signal });
        if (!response.ok) continue;
        const health = (await response.json()) as AssistantHealth;
        if (!health.llmConfigured) continue;
        this.resolvedBaseUrl = base;
        this._health.set(health);
        this._available.set(true);
        this._checked.set(true);
        return health;
      } catch {
        // Try the next origin (current page, IP, then domain).
      } finally {
        clearTimeout(timer);
      }
    }

    this._health.set(null);
    this._available.set(false);
    this._checked.set(true);
    return null;
  }

  abort(): void {
    this.controller?.abort();
    this.controller = null;
  }

  /** Stream one assistant turn. Yields parsed SSE events in order. */
  async *streamChat(request: AssistantChatRequest): AsyncGenerator<AssistantStreamEvent> {
    const base = this.baseUrl;
    if (!base) {
      yield { type: 'error', text: 'No assistant backend configured.' };
      return;
    }

    this.abort();
    this.controller = new AbortController();

    let response: Response;
    try {
      response = await fetch(`${base}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(request),
        signal: this.controller.signal,
      });
    } catch (error) {
      yield { type: 'error', text: `Could not reach the assistant backend: ${describeError(error)}` };
      return;
    }

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      yield { type: 'error', text: `Assistant backend error (${response.status}). ${detail.slice(0, 300)}` };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = parseSseFrame(frame);
          if (event) yield event;
          boundary = buffer.indexOf('\n\n');
        }
      }
      const trailing = parseSseFrame(buffer);
      if (trailing) yield trailing;
    } catch (error) {
      if (!isAbortError(error)) {
        yield { type: 'error', text: `Stream interrupted: ${describeError(error)}` };
      }
    } finally {
      reader.releaseLock();
      this.controller = null;
    }
  }

  async uploadPdf(sessionId: string, file: File): Promise<AssistantUploadResult> {
    const form = new FormData();
    form.append('sessionId', sessionId);
    form.append('file', file, file.name);
    return this.postForm('/api/uploads/pdf', form);
  }

  async uploadText(sessionId: string, text: string, fileName = 'pasted-text.md'): Promise<AssistantUploadResult> {
    const form = new FormData();
    form.append('sessionId', sessionId);
    form.append('text', text);
    form.append('fileName', fileName);
    return this.postForm('/api/uploads/text', form);
  }

  private async postForm(path: string, form: FormData): Promise<AssistantUploadResult> {
    const base = this.baseUrl;
    if (!base) throw new Error('No assistant backend configured.');

    const response = await fetch(`${base}${path}`, { method: 'POST', body: form });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.detail || `Upload failed (${response.status}).`);
    }
    return (await response.json()) as AssistantUploadResult;
  }
}

function parseSseFrame(frame: string): AssistantStreamEvent | null {
  const line = frame
    .split('\n')
    .find(candidate => candidate.startsWith('data:'));
  if (!line) return null;

  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;

  try {
    return JSON.parse(payload) as AssistantStreamEvent;
  } catch {
    return null;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
