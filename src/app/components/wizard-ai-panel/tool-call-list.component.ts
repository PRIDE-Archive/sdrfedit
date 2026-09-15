/**
 * One tool invocation as a collapsible block in the chat timeline.
 *
 * While running: spinner + title + "Running…".
 * When done: title + one-line summary; click to expand args + JSON.
 */

import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';

import { AssistantToolCall } from '../../core/models/assistant';

type ToolKind = 'data' | 'paper' | 'spec' | 'ontology' | 'template';

const TOOL_KINDS: Record<string, ToolKind> = {
  get_pride_dataset: 'data',
  get_pride_raw_files: 'data',
  find_publication: 'paper',
  get_publication_full_text: 'paper',
  check_pdf_url: 'paper',
  parse_pdf_url: 'paper',
  list_documents: 'paper',
  read_document: 'paper',
  search_specification: 'spec',
  search_ontology: 'ontology',
  verify_ontology_term: 'ontology',
  search_cell_line: 'ontology',
  verify_cellosaurus_accession: 'ontology',
  list_sdrf_templates: 'template',
  get_template_columns: 'template',
  validate_template_combination: 'template',
};

const KIND_MONOGRAMS: Record<ToolKind, string> = {
  data: 'DB',
  paper: 'DOC',
  spec: 'SPEC',
  ontology: 'OLS',
  template: 'TPL',
};

@Component({
  selector: 'assistant-tool-block',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="block"
      [class.failed]="!call().ok && !running()"
      [class.running]="running()"
      [class.open]="open()"
    >
      <button
        class="head"
        (click)="toggle()"
        [attr.aria-expanded]="open()"
      >
        <span class="caret" [class.open]="open()">&#9656;</span>
        @if (running()) {
          <span class="spinner" aria-hidden="true"></span>
        } @else {
          <span class="mono" [class]="kind()">{{ monogram() }}</span>
        }
        <span class="text">
          <span class="title">
            {{ call().title }}
            @if (!running() && call().durationMs) {
              <span class="time">{{ duration() }}</span>
            }
            <span class="hint">{{ open() ? 'Collapse' : 'View details' }}</span>
          </span>
          <span class="summary">{{ call().summary || (running() ? 'Running…' : '') }}</span>
        </span>
      </button>

      @if (open()) {
        <div class="body">
          <div class="meta">
            <code class="name">{{ call().name }}</code>
            @if (call().argsPreview) {
              <code class="args">{{ call().argsPreview }}</code>
            }
            @if (call().resultJson) {
              <button class="copy" (click)="copy($event)">
                {{ copied() ? 'Copied' : 'Copy JSON' }}
              </button>
            }
          </div>
          @if (call().resultJson) {
            <pre class="json">{{ call().resultJson }}</pre>
          } @else if (running()) {
            <p class="empty">The tool is still running; the result will appear here once it finishes.</p>
          } @else {
            <p class="empty">This tool did not return any result content.</p>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .block {
      border: 1px solid #e6e8ef;
      border-radius: 9px;
      background: #fbfcfe;
      overflow: hidden;
    }
    .block.failed { border-color: #fecaca; background: #fffafa; }
    .block.running { border-color: #c7d2fe; background: #f8f9ff; }

    .head {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      width: 100%;
      padding: 8px 10px;
      background: none;
      border: none;
      cursor: pointer;
      font: inherit;
      text-align: left;
    }
    .head:hover:not(:disabled) { background: #f4f6fb; }
    .head:disabled { cursor: wait; }

    .caret {
      flex-shrink: 0;
      margin-top: 3px;
      font-size: 10px;
      color: #9ca3af;
      transition: transform 0.15s ease;
    }
    .caret.open { transform: rotate(90deg); }
    .caret.hidden { visibility: hidden; }

    .spinner {
      flex-shrink: 0;
      width: 16px;
      height: 16px;
      margin-top: 2px;
      border: 2px solid #c7d2fe;
      border-top-color: #4f46e5;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .mono {
      flex-shrink: 0;
      min-width: 34px;
      text-align: center;
      padding: 2px 4px;
      border-radius: 5px;
      font-size: 9.5px;
      font-weight: 700;
      letter-spacing: 0.03em;
      line-height: 1.5;
    }
    .mono.data { background: #e0f2fe; color: #0369a1; }
    .mono.paper { background: #ede9fe; color: #6d28d9; }
    .mono.spec { background: #dcfce7; color: #15803d; }
    .mono.ontology { background: #fef3c7; color: #b45309; }
    .mono.template { background: #f1f5f9; color: #475569; }
    .failed .mono { background: #fee2e2; color: #b91c1c; }

    .text { flex: 1; min-width: 0; }

    .title {
      display: flex;
      align-items: baseline;
      flex-wrap: wrap;
      gap: 6px;
      font-weight: 600;
      color: #374151;
      font-size: 12px;
    }
    .time { font-weight: 400; color: #b0b6c1; font-size: 10.5px; }
    .hint {
      margin-left: auto;
      font-weight: 500;
      font-size: 10.5px;
      color: #6366f1;
    }

    .summary {
      display: block;
      margin-top: 2px;
      color: #4b5563;
      font-size: 12px;
      line-height: 1.45;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .running .summary { color: #4338ca; }
    .failed .summary { color: #b91c1c; }

    .body { padding: 0 10px 10px 52px; }

    .meta {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 6px;
    }

    .name, .args {
      background: #eef1f6;
      color: #4b5563;
      border-radius: 4px;
      padding: 1px 5px;
      font-size: 10.5px;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .copy {
      margin-left: auto;
      background: white;
      border: 1px solid #d8dce5;
      color: #4b5563;
      border-radius: 5px;
      padding: 2px 7px;
      font-size: 10.5px;
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

  private readonly _open = signal(false);
  private readonly _copied = signal(false);

  readonly open = this._open.asReadonly();
  readonly copied = this._copied.asReadonly();
  readonly running = computed(() => !!this.call().running);

  readonly kind = computed<ToolKind>(() => TOOL_KINDS[this.call().name] || 'template');
  readonly monogram = computed(() => KIND_MONOGRAMS[this.kind()]);
  readonly duration = computed(() => {
    const ms = this.call().durationMs;
    return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
  });

  toggle(): void {
    this._open.update(value => !value);
  }

  async copy(event: Event): Promise<void> {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(this.call().resultJson);
      this._copied.set(true);
      setTimeout(() => this._copied.set(false), 1500);
    } catch {
      // Clipboard can be denied; the <pre> is still selectable.
    }
  }
}
