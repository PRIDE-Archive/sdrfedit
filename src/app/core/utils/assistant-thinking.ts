import type { AssistantTimelineItem } from '../models/assistant';

export function appendThinking(timeline: AssistantTimelineItem[], text: string): AssistantTimelineItem[] {
  if (!text) return timeline;
  const last = timeline[timeline.length - 1];
  const next = last?.kind === 'thinking' && last.finishedAt === undefined
    ? timeline : recordThinking(timeline, 'Thinking…');
  return next.map((item, index) => index === next.length - 1 && item.kind === 'thinking'
    ? { ...item, reasoning: (item.reasoning || '') + text } : item);
}

export function finishThinking(timeline: AssistantTimelineItem[], now = Date.now()): AssistantTimelineItem[] {
  return timeline.map(item => item.kind === 'thinking' && item.finishedAt === undefined
    ? { ...item, finishedAt: now } : item);
}

export function recordThinking(timeline: AssistantTimelineItem[], content: string, now = Date.now()): AssistantTimelineItem[] {
  const last = timeline[timeline.length - 1];
  if (last?.kind === 'thinking' && last.finishedAt === undefined) {
    return [...timeline.slice(0, -1), { ...last, content }];
  }
  return [...finishThinking(timeline, now), {
    kind: 'thinking', id: `thinking_${timeline.length}_${now}`, content, startedAt: now,
  }];
}
