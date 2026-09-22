/**
 * Local chat history for the wizard assistant.
 *
 * The editor is usable without login, so history lives in localStorage on this
 * device. Sessions keep messages, suggestion cards, the wizard form snapshot,
 * and the backend session id (so re-opened chats can still reference uploaded
 * documents until the server TTL expires). Oversized tool JSON is truncated so
 * the quota is not blown.
 */

import { Injectable, computed, signal } from '@angular/core';

import {
  AssistantChatMessage,
  AssistantChatSession,
  AssistantTimelineItem,
  WizardActionCard,
} from '../../models/assistant';
import { WizardState } from '../../models/wizard';

const STORAGE_KEY = 'sdrf_assistant_chats_v1';
const MAX_SESSIONS = 30;
const MAX_RESULT_JSON_CHARS = 4000;

@Injectable({ providedIn: 'root' })
export class ChatHistoryService {
  private readonly _sessions = signal<AssistantChatSession[]>(loadSessions());
  private readonly _activeId = signal<string | null>(null);

  readonly sessions = this._sessions.asReadonly();
  readonly activeId = this._activeId.asReadonly();

  readonly ordered = computed(() =>
    [...this._sessions()].sort((a, b) => b.updatedAt - a.updatedAt)
  );

  readonly active = computed(() => {
    const id = this._activeId();
    return id ? this._sessions().find(session => session.id === id) || null : null;
  });

  /** Create a blank session and make it active. */
  create(backendSessionId: string, title = 'New chat'): AssistantChatSession {
    const now = Date.now();
    const session: AssistantChatSession = {
      id: createId('chat'),
      title,
      createdAt: now,
      updatedAt: now,
      backendSessionId,
      messages: [],
      cards: {},
      advisedSteps: [],
      cardSequence: 0,
      wizardState: null,
      currentStep: 0,
    };
    this._sessions.update(list => trimSessions([session, ...list]));
    this._activeId.set(session.id);
    this.persist();
    return session;
  }

  /** Resume a session, or create one if none exists yet. */
  ensureActive(backendSessionIdFactory: () => string): AssistantChatSession {
    const current = this.active();
    if (current) return current;
    const newest = this.ordered()[0];
    if (newest && newest.messages.length === 0) {
      this._activeId.set(newest.id);
      return newest;
    }
    return this.create(backendSessionIdFactory());
  }

  select(id: string): AssistantChatSession | null {
    const found = this._sessions().find(session => session.id === id);
    if (!found) return null;
    this._activeId.set(id);
    return found;
  }

  rename(id: string, title: string): void {
    const trimmed = title.trim().slice(0, 80) || 'Untitled chat';
    this.patch(id, session => ({ ...session, title: trimmed, updatedAt: Date.now() }));
  }

  remove(id: string): void {
    this._sessions.update(list => list.filter(session => session.id !== id));
    if (this._activeId() === id) {
      const next = this.ordered()[0];
      this._activeId.set(next?.id ?? null);
    }
    this.persist();
  }

  /**
   * Snapshot the open conversation. Titles are inferred from the first real
   * user message once, so auto step-prompts do not rename the chat.
   */
  saveActive(state: {
    messages: AssistantChatMessage[];
    cards: Record<string, WizardActionCard>;
    advisedSteps: number[];
    cardSequence: number;
    backendSessionId: string;
    wizardState?: WizardState | null;
    currentStep?: number;
  }): void {
    const id = this._activeId();
    if (!id) return;

    this.patch(id, session => {
      const title =
        session.title === 'New chat' ? inferTitle(state.messages) || session.title : session.title;
      return {
        ...session,
        title,
        updatedAt: Date.now(),
        backendSessionId: state.backendSessionId,
        messages: compactMessages(state.messages),
        cards: state.cards,
        advisedSteps: state.advisedSteps,
        cardSequence: state.cardSequence,
        wizardState: state.wizardState !== undefined ? state.wizardState : session.wizardState,
        currentStep: state.currentStep !== undefined ? state.currentStep : session.currentStep,
      };
    });
  }

  /** Drop the wizard form on the active chat (Cancel / Create finished). */
  clearActiveWizard(): void {
    const id = this._activeId();
    if (!id) return;
    this.patch(id, session => ({
      ...session,
      wizardState: null,
      currentStep: 0,
      updatedAt: Date.now(),
    }));
  }

  private patch(id: string, update: (session: AssistantChatSession) => AssistantChatSession): void {
    this._sessions.update(list => {
      const next = list.map(session => (session.id === id ? update(session) : session));
      return trimSessions(next);
    });
    this.persist();
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this._sessions()));
    } catch {
      // Quota or privacy mode — keep the in-memory copy for this page load.
    }
  }
}

function loadSessions(): AssistantChatSession[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AssistantChatSession[];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(session => session && typeof session.id === 'string');
  } catch {
    return [];
  }
}

function trimSessions(sessions: AssistantChatSession[]): AssistantChatSession[] {
  return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_SESSIONS);
}

function inferTitle(messages: AssistantChatMessage[]): string | null {
  const first = messages.find(message => message.role === 'user' && !message.auto && message.content.trim());
  if (!first) return null;
  const text = first.content.replace(/\s+/g, ' ').trim();
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

function compactMessages(messages: AssistantChatMessage[]): AssistantChatMessage[] {
  return messages.map(message => {
    if (message.role !== 'assistant') return message;
    const timeline = (message.timeline || migrateTimeline(message)).map(compactTimelineItem);
    return {
      ...message,
      timeline,
      // Drop the legacy array once we have a timeline — saves storage space.
      toolCalls: undefined,
      pending: false,
    };
  });
}

/** Rebuild a timeline for chats saved before the timeline field existed. */
export function migrateTimeline(message: AssistantChatMessage): AssistantTimelineItem[] {
  if (Array.isArray(message.timeline) && message.timeline.length) {
    return message.timeline
      .filter((item): item is AssistantTimelineItem => item.kind === 'tool' || item.kind === 'text' || item.kind === 'thinking')
      .map(item =>
        item.kind === 'thinking' ? item : item.kind === 'tool'
          ? { kind: 'tool', id: item.id || item.call.id, call: item.call }
          : { kind: 'text', id: item.id || 'text_legacy', content: item.content }
      );
  }
  const items: AssistantTimelineItem[] = [];
  for (const call of message.toolCalls || []) {
    items.push({ kind: 'tool', id: call.id, call });
  }
  if (message.content) items.push({ kind: 'text', id: 'text_legacy', content: message.content });
  return items;
}

function compactTimelineItem(item: AssistantTimelineItem): AssistantTimelineItem {
  if (item.kind !== 'tool') return item;
  const json = item.call.resultJson || '';
  if (json.length <= MAX_RESULT_JSON_CHARS) return item;
  return {
    kind: 'tool',
    id: item.id,
    call: {
      ...item.call,
      resultJson: `${json.slice(0, MAX_RESULT_JSON_CHARS)}\n… truncated for local storage`,
    },
  };
}

function createId(prefix: string): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi?.randomUUID) return `${prefix}_${cryptoApi.randomUUID()}`;
  return `${prefix}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
