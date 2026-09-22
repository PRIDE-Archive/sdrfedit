/**
 * One tool invocation as a collapsible block in the chat timeline.
 *
 * Shimmering raw tool name while running; click to expand summary, args and JSON.
 */

import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivityDisclosureComponent } from './activity-disclosure.component';

import { AssistantToolCall } from '../../core/models/assistant';

@Component({
  selector: 'assistant-tool-block',
  standalone: true,
  imports: [CommonModule, ActivityDisclosureComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <assistant-activity [title]="call().name" [active]="running()"
      [failed]="!call().ok && !running()"
      [meta]="!running() && call().durationMs ? duration() : ''">
        <div class="body">
          @if (call().summary) { <p class="summary">{{ call().summary }}</p> }
          @if (formattedArgs()) {
            <div class="section-head">
              <span>Arguments</span>
              <button class="copy" (click)="copy($event, 'args')">
                {{ copied() === 'args' ? 'Copied' : 'Copy' }}
              </button>
            </div>
            <pre class="json">{{ formattedArgs() }}</pre>
          }
          @if (call().resultJson) {
            <div class="section-head">
              <span>Result</span>
              <button class="copy" (click)="copy($event, 'result')">
                {{ copied() === 'result' ? 'Copied' : 'Copy JSON' }}
              </button>
            </div>
            <pre class="json">{{ call().resultJson }}</pre>
          } @else if (running()) {
            <p class="empty">The tool is still running; the result will appear here once it finishes.</p>
          } @else {
            <p class="empty">This tool did not return any result content.</p>
          }
        </div>
    </assistant-activity>
  `,
  styles: [`
    .summary {
      display: block;
      margin-top: 2px;
      color: #4b5563;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .body { min-width: 0; padding: 0 4px 0 0; }

    .section-head {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 8px 0 4px;
      color: #6b7280;
      font-size: 10.5px;
      font-weight: 600;
      letter-spacing: 0.02em;
      text-transform: uppercase;
    }
    .section-head:first-of-type { margin-top: 0; }

    .copy {
      margin-left: auto;
      background: white;
      border: 1px solid #d8dce5;
      color: #4b5563;
      border-radius: 5px;
      padding: 2px 7px;
      font-size: 10.5px;
      text-transform: none;
      letter-spacing: 0;
      font-weight: 500;
      cursor: pointer;
    }
    .copy:hover { background: #f4f6fb; }

    .json {
      margin: 0;
      max-height: 280px;
      overflow: auto;
      background: #1e293b;
      color: #e2e8f0;
      border-radius: 7px;
      padding: 8px 10px;
      font-size: 10.5px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .empty {
      margin: 0;
      color: #9ca3af;
      font-size: 11.5px;
    }
  `],
})
export class ToolCallBlockComponent {
  readonly call = input.required<AssistantToolCall>();

  private readonly _copied = signal<'args' | 'result' | null>(null);

  readonly copied = this._copied.asReadonly();
  readonly running = computed(() => !!this.call().running);
  readonly formattedArgs = computed(() => prettyJson(this.call().argsPreview));

  readonly duration = computed(() => {
    const ms = this.call().durationMs;
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
  });

  async copy(event: Event, which: 'args' | 'result'): Promise<void> {
    event.stopPropagation();
    const text = which === 'args' ? this.formattedArgs() : this.call().resultJson;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this._copied.set(which);
      setTimeout(() => this._copied.set(null), 1500);
    } catch {
      // Clipboard can be denied; the <pre> is still selectable.
    }
  }
}

function prettyJson(raw: string | undefined): string {
  const text = (raw || '').trim();
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}
