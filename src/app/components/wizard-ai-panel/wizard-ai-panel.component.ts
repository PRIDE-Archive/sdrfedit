/**
 * Wizard AI Assistant Panel
 *
 * Chat surface docked beside the SDRF creation wizard. The backend does the
 * reasoning and tool calling; this component streams the reply, shows the
 * evidence behind it, and turns each proposed mutation into a card the user can
 * preview and apply. Nothing touches the wizard state until the user clicks
 * Apply.
 *
 * The assistant advises one wizard page at a time. It picks up the step the user
 * is on, and once that step is settled it offers to move on: clicking through, or
 * navigating the wizard directly, asks for advice on the new step.
 */

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  OnInit,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import {
  AssistantAttachment,
  AssistantChatMessage,
  AssistantCitation,
  AssistantNextStep,
  AssistantSkillRef,
  AssistantStepId,
  AssistantTimelineItem,
  AssistantToolCall,
  WizardAction,
  WizardActionCard,
} from '../../core/models/assistant';
import { WIZARD_STEPS, WizardState } from '../../core/models/wizard';
import { AssistantApiService } from '../../core/services/assistant/assistant-api.service';
import {
  ChatHistoryService,
  migrateTimeline,
} from '../../core/services/assistant/chat-history.service';
import { parseSlashCommand, SLASH_COMMAND_HINTS } from '../../core/services/assistant/slash-commands';
import {
  WizardActionError,
  WizardAiBridgeService,
} from '../../core/services/assistant/wizard-ai-bridge.service';
import { WizardStateService } from '../../core/services/wizard-state.service';
import { resolveAssistantNavigation } from '../../core/utils/wizard-navigation';
import { ActionCardListComponent } from './action-card-list.component';
import { renderMarkdownLite } from './markdown-lite';
import { ToolCallBlockComponent } from './tool-call-list.component';

interface QuickStart {
  label: string;
  hint: string;
  prompt: string;
}

const NO_CARDS: WizardActionCard[] = [];

const WIDTH_KEY = 'sdrf_assistant_width';
const MIN_WIDTH = 340;
const MAX_WIDTH = 640;
const DEFAULT_WIDTH = 400;

@Component({
  selector: 'wizard-ai-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, ToolCallBlockComponent, ActionCardListComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <aside class="ai-panel" [class.collapsed]="collapsed()" [style.width.px]="panelWidth()">
      @if (!collapsed()) {
        <div class="resizer" (pointerdown)="startResize($event)" title="Drag to resize"></div>
      }

      <header class="panel-header">
        <div class="header-title">
          <span class="mark">AI</span>
          <div class="title-stack">
            <span class="name">SDRF Assistant</span>
            @if (!collapsed() && activeTitle()) {
              <span class="chat-title" [title]="activeTitle()">{{ activeTitle() }}</span>
            }
          </div>
          @if (retrievalTag()) {
            <span class="tag" [title]="healthTitle()">{{ retrievalTag() }}</span>
          }
        </div>
        <div class="header-actions">
          @if (!collapsed()) {
            <button
              class="icon-btn"
              (click)="downloadTrace()"
              title="Download agent trace (JSON)"
              [disabled]="!messages().length"
            >
              ↓
            </button>
            <button class="icon-btn" (click)="newChat()" title="New chat" [disabled]="busy()">+</button>
            <button
              class="icon-btn"
              (click)="toggleHistory()"
              title="Chat history"
              [class.active]="historyOpen()"
            >
              &#9776;
            </button>
          }
          <button
            class="icon-btn collapse-btn"
            (click)="toggleCollapsed()"
            [title]="collapsed() ? 'Expand assistant' : 'Collapse assistant'"
          >
            {{ collapsed() ? '&laquo;' : '&raquo;' }}
          </button>
          <button class="icon-btn" (click)="close.emit()" title="Hide assistant">&times;</button>
        </div>
      </header>

      @if (!collapsed() && historyOpen()) {
        <div class="history-drawer">
          <div class="history-head">
            <span>Chat history</span>
            <span class="history-note">Saved in this browser</span>
          </div>
          <button class="history-new" [disabled]="busy()" (click)="newChat()">New chat</button>
          <ul class="history-list">
            @for (session of history.ordered(); track session.id) {
              <li
                class="history-item"
                [class.active]="session.id === history.activeId()"
              >
                @if (renamingId() === session.id) {
                  <input
                    class="rename-input"
                    [value]="renameDraft"
                    (input)="renameDraft = $any($event.target).value"
                    (keydown.enter)="commitRename(session.id)"
                    (keydown.escape)="cancelRename()"
                    (blur)="commitRename(session.id)"
                  />
                } @else {
                  <button class="history-open" [disabled]="busy()" (click)="openChat(session.id)">
                    <span class="history-title">{{ session.title }}</span>
                    <span class="history-time">{{ formatTime(session.updatedAt) }}</span>
                  </button>
                  <div class="history-item-actions">
                    <button class="tiny" (click)="startRename(session.id, session.title)" title="Rename">✎</button>
                    <button class="tiny danger" (click)="deleteChat(session.id)" title="Delete">×</button>
                  </div>
                }
              </li>
            } @empty {
              <li class="history-empty">No saved chats yet.</li>
            }
          </ul>
        </div>
      }

      @if (!collapsed()) {
        @if (!api.available() && api.checked()) {
          <div class="offline">
            <p class="offline-title">Assistant backend unreachable</p>
            <p>
              Start the backend (see <code>backend/README.md</code>) and make sure an LLM is
              configured in <code>backend/.env</code>.
            </p>
            <label class="url-label">
              Backend URL
              <input
                type="text"
                [(ngModel)]="baseUrlDraft"
                placeholder="http://localhost:8000"
                (keydown.enter)="saveBaseUrl()"
              />
            </label>
            <button class="btn-secondary" (click)="saveBaseUrl()">Retry connection</button>
          </div>
        } @else {
          <div class="step-strip">
            <div class="strip-line">
              <span class="strip-index">Step {{ stepIndex() + 1 }} of {{ totalSteps }}</span>
              <span class="strip-title">{{ stepTitle() }}</span>
              <button
                class="strip-action"
                [disabled]="busy()"
                (click)="adviseCurrentStep()"
                [title]="
                  advisedCurrentStep()
                    ? 'Ask again for this page'
                    : 'Ask the assistant what to fill in on this page'
                "
              >
                {{ advisedCurrentStep() ? 'Ask again' : 'Advise this page' }}
              </button>
            </div>
            <div class="strip-track">
              <div class="strip-fill" [style.width.%]="stepProgress()"></div>
            </div>
          </div>

          <div class="messages" #scroller>
            @if (messages().length === 0) {
              <div class="intro">
                <p class="intro-title">I fill in this wizard with you, one page at a time.</p>
                <p class="intro-body">
                  Try <code>/sdrf-annotate PXD000547</code>, upload a paper PDF, or ask about
                  the SDRF specification. Every suggestion comes with the evidence behind it.
                </p>
                <div class="quick-starts">
                  @for (quick of quickStarts; track quick.label) {
                    <button class="quick" (click)="useQuickStart(quick)">
                      <span class="quick-label">{{ quick.label }}</span>
                      <span class="quick-hint">{{ quick.hint }}</span>
                    </button>
                  }
                </div>
              </div>
            }

            @for (message of messages(); track $index) {
              @if (message.role === 'user') {
                @if (message.auto) {
                  <div class="step-divider">
                    <span>{{ message.content }}</span>
                  </div>
                } @else if (message.attachment) {
                  <div class="user-row">
                    <div
                      class="file-card"
                      [class.parsing]="message.attachment.status === 'parsing'"
                      [class.error]="message.attachment.status === 'error'"
                    >
                      <div class="file-thumb" aria-hidden="true">
                        <svg viewBox="0 0 48 56" width="36" height="42">
                          <path
                            fill="#ef4444"
                            d="M8 0h22l10 10v42a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V4a4 4 0 0 1 4-4z"
                          />
                          <path fill="#fecaca" d="M30 0v10h10z" />
                          <text
                            x="24"
                            y="36"
                            text-anchor="middle"
                            fill="white"
                            font-size="11"
                            font-weight="700"
                            font-family="system-ui,sans-serif"
                          >
                            PDF
                          </text>
                        </svg>
                        @if (message.attachment.status === 'ready') {
                          <span class="file-ok">✓</span>
                        }
                      </div>
                      <div class="file-meta">
                        <span class="file-name">{{ message.attachment.fileName }}</span>
                        @if (message.attachment.status === 'parsing') {
                          <span class="file-status">Uploading and parsing…</span>
                        } @else if (message.attachment.status === 'error') {
                          <span class="file-status">{{ message.attachment.error || 'Parsing failed' }}</span>
                        } @else {
                          <span class="file-status">
                            {{ message.attachment.sizeLabel || 'PDF' }}
                            @if (message.attachment.parser) {
                              · {{ message.attachment.parser }}
                            }
                          </span>
                          <span class="file-sections">
                            {{ formatSize(message.attachment.charCount) }}
                            @if (message.attachment.sections.length) {
                              · {{ message.attachment.sections.join(', ') }}
                            }
                          </span>
                        }
                      </div>
                    </div>
                  </div>
                } @else if (message.skill) {
                  <div class="user-row">
                    <div class="skill-chip">
                      <span class="skill-mark">/</span>
                      <span class="skill-name">{{ message.skill.name }}</span>
                      @if (message.skill.args) {
                        <span class="skill-args">{{ message.skill.args }}</span>
                      }
                    </div>
                  </div>
                } @else {
                  <div class="user-row">
                    <div class="user-bubble">{{ message.content }}</div>
                  </div>
                }
              } @else {
                <div class="turn">
                  @if (message.focusStep) {
                    <div class="turn-step">{{ stepLabel(message.focusStep) }}</div>
                  }

                  @for (item of timelineOf(message); track item.id) {
                    @if (item.kind === 'tool') {
                      <assistant-tool-block [call]="item.call" />
                    } @else if (item.kind === 'text' && item.content) {
                      <div class="markdown" [innerHTML]="render(item.content)"></div>
                    }
                  }

                  @if (message.pending && !message.content && !timelineOf(message).length && !message.status) {
                    <div class="live"><span class="pulse"></span>Thinking</div>
                  } @else if (message.status && !hasRunningTool(message)) {
                    <div class="live"><span class="pulse"></span>{{ message.status }}</div>
                  }

                  @if (message.error) {
                    <div class="inline-error">{{ message.error }}</div>
                  }

                  @if (cardsFor(message).length) {
                    <assistant-action-cards
                      [cards]="cardsFor(message)"
                      (apply)="apply($event)"
                      (dismiss)="dismiss($event)"
                      (applyAll)="applyMany($event)"
                      (askAbout)="askAbout($event)"
                    />
                  }

                  @if (message.citations?.length) {
                    <div class="sources">
                      <span class="sources-label">Sources</span>
                      @for (citation of message.citations; track $index) {
                        <a
                          class="source"
                          [href]="citation.url || '#'"
                          target="_blank"
                          rel="noopener noreferrer"
                          [title]="citation.snippet"
                        >
                          {{ sourceLabel(citation) }} {{ citation.title }}
                        </a>
                      }
                    </div>
                  }

                  @if (message.nextStep && !message.pending) {
                    <div class="next-bar">
                      <span class="next-text">
                        Next: step {{ message.nextStep.index + 1 }}, {{ message.nextStep.title }}
                      </span>
                      <button class="next-btn" [disabled]="busy()" (click)="goNext(message.nextStep)">
                        Continue &rarr;
                      </button>
                    </div>
                  }
                </div>
              }
            }
          </div>

          <div class="composer">
            @if (slashHintsVisible()) {
              <div class="slash-menu">
                @for (hint of slashHints; track hint.command) {
                  <button type="button" class="slash-item" (click)="applySlashHint(hint.example)">
                    <code>{{ hint.command }}</code>
                    <span>{{ hint.hint }}</span>
                  </button>
                }
              </div>
            }
            <div class="composer-box" [class.disabled]="busy() && !composerFile()">
              @if (composerFile(); as file) {
                <div
                  class="composer-file"
                  [class.parsing]="file.status === 'parsing'"
                  [class.error]="file.status === 'error'"
                  [class.ready]="file.status === 'ready'"
                >
                  <div class="composer-file-icon" aria-hidden="true">
                    @if (file.status === 'parsing') {
                      <span class="composer-file-spinner"></span>
                    } @else if (file.status === 'error') {
                      <span class="composer-file-badge err">!</span>
                    } @else {
                      <svg viewBox="0 0 40 48" width="28" height="34">
                        <path
                          fill="#ef4444"
                          d="M6 0h18l10 10v34a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V4a4 4 0 0 1 4-4z"
                        />
                        <path fill="#fecaca" d="M24 0v10h10z" />
                        <text
                          x="18"
                          y="30"
                          text-anchor="middle"
                          fill="white"
                          font-size="9"
                          font-weight="700"
                          font-family="system-ui,sans-serif"
                        >
                          PDF
                        </text>
                      </svg>
                      <span class="composer-file-ok">✓</span>
                    }
                  </div>
                  <div class="composer-file-meta">
                    <span class="composer-file-name">{{ file.fileName }}</span>
                    @if (file.status === 'parsing') {
                      <span class="composer-file-status">Uploading and parsing…</span>
                    } @else if (file.status === 'error') {
                      <span class="composer-file-status">{{ file.error || 'Parsing failed' }}</span>
                    } @else {
                      <span class="composer-file-status">
                        {{ file.sizeLabel || 'PDF' }}
                        @if (file.parser) {
                          · {{ file.parser }}
                        }
                      </span>
                    }
                  </div>
                  <button
                    type="button"
                    class="composer-file-remove"
                    (click)="clearComposerFile()"
                    [disabled]="file.status === 'parsing'"
                    title="Remove file"
                    aria-label="Remove file"
                  >
                    ×
                  </button>
                </div>
              }
              <textarea
                #composerInput
                [(ngModel)]="draft"
                [disabled]="busy() || composerFile()?.status === 'parsing'"
                rows="3"
                placeholder="Ask a question, /sdrf-annotate PXD…, or describe your experiment…"
                (keydown.enter)="onEnter($event)"
                (input)="onDraftInput()"
              ></textarea>
              <div class="composer-toolbar">
                <button
                  type="button"
                  class="icon-action"
                  [disabled]="busy() || composerFile()?.status === 'parsing'"
                  (click)="fileInput.click()"
                  [title]="
                    api.health()?.mineruConfigured
                      ? 'Attach PDF (parsed with MinerU)'
                      : 'MinerU is not configured; paste the methods text instead'
                  "
                  aria-label="Attach PDF"
                >
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                    <path
                      fill="currentColor"
                      d="M16.5 6.5v9.25a4.25 4.25 0 1 1-8.5 0V6.75a2.75 2.75 0 0 1 5.5 0v8.5a1.25 1.25 0 1 1-2.5 0V7.5h-1.5v7.75a2.75 2.75 0 1 0 5.5 0v-8.5a4.25 4.25 0 1 0-8.5 0v9.25a5.75 5.75 0 1 0 11.5 0V6.5H16.5z"
                    />
                  </svg>
                </button>
                @if (busy()) {
                  <button
                    type="button"
                    class="icon-action stop"
                    (click)="stop()"
                    title="Stop"
                    aria-label="Stop"
                  >
                    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
                      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
                    </svg>
                  </button>
                } @else {
                  <button
                    type="button"
                    class="icon-action send"
                    [disabled]="!canSend()"
                    (click)="send()"
                    title="Send"
                    aria-label="Send"
                  >
                    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                      <path fill="currentColor" d="M3.4 20.4 21 12 3.4 3.6 3 10.3l11.2 1.7L3 13.7z" />
                    </svg>
                  </button>
                }
              </div>
            </div>
            <input
              #fileInput
              type="file"
              accept="application/pdf,.pdf"
              hidden
              (change)="onFileSelected($event)"
            />
          </div>
        }
      }
    </aside>
  `,
  styles: [`
    /*
     * The flex child of .wizard-shell is this host, not .ai-panel. Stretch the
     * host to the wizard's height so the panel doesn't float as a short card.
     */
    :host {
      display: flex;
      align-self: stretch;
      min-height: 0;
      min-width: 0;
    }

    .ai-panel {
      position: relative;
      flex: 1 1 auto;
      width: 100%;
      min-height: 0;
      height: 100%;
      background: #ffffff;
      border-radius: 14px;
      box-shadow: 0 24px 70px rgba(15, 23, 42, 0.28);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      font-size: 13px;
      color: #1f2937;
    }

    .ai-panel.collapsed { width: 54px !important; }

    .resizer {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 6px;
      cursor: col-resize;
      z-index: 2;
    }
    .resizer:hover { background: rgba(74, 169, 167, 0.18); }

    /* ------------------------------------------------------------- header */

    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
      padding: 11px 12px;
      border-bottom: 1px solid #eceef4;
      background: #fbfcfe;
      flex-shrink: 0;
    }

    .header-title {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }

    .mark {
      flex-shrink: 0;
      width: 22px;
      height: 22px;
      border-radius: 6px;
      background: #5bc0be;
      color: white;
      font-size: 9.5px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      letter-spacing: 0.02em;
    }

    .title-stack {
      display: flex;
      flex-direction: column;
      min-width: 0;
      line-height: 1.2;
    }

    .name {
      font-weight: 600;
      color: #111827;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .chat-title {
      font-size: 10.5px;
      color: #9ca3af;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 160px;
    }

    .collapsed .name, .collapsed .tag, .collapsed .title-stack { display: none; }

    .icon-btn.active { background: #eafaf9; color: #17233d; }

    /* ------------------------------------------------------ history drawer */

    .history-drawer {
      flex-shrink: 0;
      border-bottom: 1px solid #eceef4;
      background: #f8f9fc;
      max-height: 42%;
      overflow: auto;
      padding: 8px 10px 10px;
    }

    .history-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
      font-weight: 600;
      color: #374151;
      font-size: 12px;
    }
    .history-note { font-weight: 400; color: #9ca3af; font-size: 10.5px; }

    .history-new {
      width: 100%;
      margin-bottom: 8px;
      background: white;
      border: 1px dashed #bde6e5;
      color: #17233d;
      border-radius: 7px;
      padding: 6px 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
    }
    .history-new:hover:not(:disabled) { background: #eafaf9; }
    .history-new:disabled { opacity: 0.5; cursor: default; }

    .history-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }

    .history-item {
      display: flex;
      align-items: center;
      gap: 4px;
      border-radius: 7px;
      background: white;
      border: 1px solid #e6e8ef;
      padding: 2px;
    }
    .history-item.active { border-color: #bde6e5; background: #eafaf9; }

    .history-open {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 1px;
      text-align: left;
      background: none;
      border: none;
      padding: 5px 7px;
      cursor: pointer;
      font: inherit;
    }
    .history-title {
      color: #111827;
      font-size: 12px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .history-time { color: #9ca3af; font-size: 10.5px; }

    .history-item-actions { display: flex; gap: 2px; padding-right: 2px; }
    .tiny {
      background: none;
      border: none;
      color: #9ca3af;
      width: 22px;
      height: 22px;
      border-radius: 5px;
      cursor: pointer;
      font-size: 12px;
    }
    .tiny:hover { background: #eef1f6; color: #374151; }
    .tiny.danger:hover { background: #fee2e2; color: #b91c1c; }

    .rename-input {
      flex: 1;
      margin: 3px;
      padding: 4px 6px;
      border: 1px solid #bde6e5;
      border-radius: 5px;
      font-size: 12px;
    }

    .history-empty {
      color: #9ca3af;
      font-size: 12px;
      padding: 10px 4px;
      text-align: center;
    }

    .tag {
      flex-shrink: 0;
      font-size: 10px;
      background: #eafaf9;
      color: #17233d;
      padding: 2px 7px;
      border-radius: 999px;
    }

    .header-actions { display: flex; gap: 3px; }

    .icon-btn {
      background: none;
      border: none;
      color: #6b7280;
      width: 24px;
      height: 24px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
      line-height: 1;
    }
    .icon-btn:hover { background: #eef1f6; color: #111827; }
    .collapsed .icon-btn:last-child { display: none; }

    /* --------------------------------------------------------- step strip */

    .step-strip {
      padding: 9px 12px 10px;
      border-bottom: 1px solid #eceef4;
      flex-shrink: 0;
    }

    .strip-line {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 7px;
    }

    .strip-index {
      background: #eafaf9;
      color: #17233d;
      border-radius: 5px;
      padding: 1px 6px;
      font-size: 10px;
      font-weight: 700;
      white-space: nowrap;
    }

    .strip-title {
      font-weight: 600;
      color: #1f2937;
      font-size: 12.5px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .strip-action {
      margin-left: auto;
      flex-shrink: 0;
      background: white;
      border: 1px solid #d5d9e2;
      color: #17233d;
      border-radius: 6px;
      padding: 3px 9px;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    .strip-action:hover:not(:disabled) { background: #eafaf9; border-color: #bde6e5; }
    .strip-action:disabled { color: #b0b6c1; cursor: default; }

    .strip-track {
      height: 3px;
      border-radius: 999px;
      background: #eceef4;
      overflow: hidden;
    }
    .strip-fill {
      height: 100%;
      background: #5bc0be;
      border-radius: 999px;
      transition: width 0.25s ease;
    }

    /* ------------------------------------------------------------ offline */

    .offline { padding: 20px 16px; color: #6b7280; line-height: 1.55; }
    .offline-title { font-weight: 600; color: #b45309; margin: 0 0 8px; }
    .offline code {
      background: #f1f3f8;
      padding: 1px 4px;
      border-radius: 3px;
      font-size: 11px;
    }
    .url-label {
      display: block;
      margin: 14px 0 8px;
      font-size: 10.5px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #6b7280;
    }
    .url-label input {
      width: 100%;
      margin-top: 4px;
      padding: 6px 8px;
      border: 1px solid #d5d9e2;
      border-radius: 6px;
      font-size: 12px;
      box-sizing: border-box;
    }

    /* ----------------------------------------------------------- messages */

    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 14px 12px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      background: #fdfdff;
    }

    .intro { color: #4b5563; line-height: 1.55; }
    .intro-title { font-weight: 600; color: #111827; margin: 0 0 6px; font-size: 13.5px; }
    .intro-body { margin: 0 0 14px; }
    .intro-body code {
      background: #eafaf9;
      color: #17233d;
      border-radius: 4px;
      padding: 1px 5px;
      font-size: 11.5px;
    }

    .quick-starts { display: flex; flex-direction: column; gap: 7px; }

    .quick {
      display: flex;
      flex-direction: column;
      gap: 2px;
      text-align: left;
      background: white;
      border: 1px solid #e3e6ee;
      border-radius: 9px;
      padding: 8px 11px;
      cursor: pointer;
    }
    .quick:hover { border-color: #bde6e5; background: #eafaf9; }
    .quick-label { font-weight: 600; color: #17233d; font-size: 12px; }
    .quick-hint { color: #9ca3af; font-size: 11px; }

    .user-row { display: flex; justify-content: flex-end; }

    .user-bubble {
      max-width: 88%;
      background: #5bc0be;
      color: white;
      border-radius: 12px 12px 3px 12px;
      padding: 8px 11px;
      line-height: 1.55;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .file-card {
      display: flex;
      align-items: center;
      gap: 10px;
      max-width: 92%;
      background: white;
      border: 1px solid #e3e6ee;
      border-radius: 12px;
      padding: 10px 12px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    .file-card.parsing { border-color: #bde6e5; background: #eafaf9; }
    .file-card.error { border-color: #fecaca; background: #fffafa; }

    .file-thumb {
      position: relative;
      flex-shrink: 0;
      width: 40px;
      height: 44px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .file-ok {
      position: absolute;
      right: -4px;
      bottom: -2px;
      width: 16px;
      height: 16px;
      border-radius: 999px;
      background: #16a34a;
      color: white;
      font-size: 10px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 2px solid white;
    }

    .file-meta {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .file-name {
      font-weight: 600;
      color: #111827;
      font-size: 12.5px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .file-status { color: #16a34a; font-size: 11.5px; }
    .file-card.parsing .file-status { color: #17233d; }
    .file-card.error .file-status { color: #b91c1c; }
    .file-sections {
      color: #9ca3af;
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .skill-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 92%;
      background: #111827;
      color: #f9fafb;
      border-radius: 999px;
      padding: 7px 12px;
      font-size: 12.5px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    .skill-mark { color: #a5b4fc; font-weight: 700; }
    .skill-name { font-weight: 600; }
    .skill-args { color: #bde6e5; }

    .slash-menu {
      margin-bottom: 8px;
      border: 1px solid #e3e6ee;
      border-radius: 10px;
      background: white;
      overflow: hidden;
    }
    .slash-item {
      display: flex;
      flex-direction: column;
      gap: 2px;
      width: 100%;
      text-align: left;
      background: none;
      border: none;
      border-bottom: 1px solid #f1f3f8;
      padding: 8px 10px;
      cursor: pointer;
      font: inherit;
    }
    .slash-item:last-child { border-bottom: none; }
    .slash-item:hover { background: #eafaf9; }
    .slash-item code {
      font-size: 12px;
      color: #17233d;
      font-weight: 600;
    }
    .slash-item span { font-size: 11.5px; color: #6b7280; }

    .step-divider {
      display: flex;
      align-items: center;
      gap: 8px;
      color: #9ca3af;
      font-size: 11px;
    }
    .step-divider::before, .step-divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: #e9ebf2;
    }
    .step-divider span { white-space: nowrap; }

    .turn {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding-left: 10px;
      border-left: 2px solid #e0e3ee;
    }

    .turn-step {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #8b90a0;
    }

    .live {
      display: flex;
      align-items: center;
      gap: 7px;
      color: #6b7280;
      font-size: 12px;
    }

    .pulse {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #4aa9a7;
      animation: pulse 1.1s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 0.25; transform: scale(0.8); }
      50% { opacity: 1; transform: scale(1.15); }
    }

    .markdown { line-height: 1.6; word-break: break-word; }
    .markdown :first-child { margin-top: 0; }
    .markdown :last-child { margin-bottom: 0; }
    .markdown p { margin: 0 0 8px; }
    .markdown ul { margin: 0 0 8px; padding-left: 18px; }
    .markdown li { margin: 2px 0; }
    .markdown code {
      background: #f1f3f8;
      padding: 1px 4px;
      border-radius: 3px;
      font-size: 11.5px;
    }
    .markdown .md-heading { font-weight: 600; }

    .inline-error {
      color: #b91c1c;
      background: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: 7px;
      padding: 7px 9px;
    }

    .sources {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 5px;
      padding-top: 7px;
      border-top: 1px dashed #e9ebf2;
    }

    .sources-label {
      font-size: 9.5px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: #9ca3af;
    }

    .source {
      max-width: 100%;
      background: #f4f6fb;
      color: #4b5563;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 10.5px;
      text-decoration: none;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .source:hover { background: #e8ecf6; color: #1f2937; }

    .next-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      background: #f5f6ff;
      border: 1px solid #dfe3fb;
      border-radius: 9px;
      padding: 8px 10px;
    }

    .next-text { flex: 1; color: #17233d; font-size: 11.5px; font-weight: 600; }

    .next-btn {
      flex-shrink: 0;
      background: #5bc0be;
      border: none;
      color: white;
      border-radius: 6px;
      padding: 4px 12px;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
    }
    .next-btn:hover:not(:disabled) { background: #17233d; }
    .next-btn:disabled { background: #b6b9d8; cursor: default; }

    /* ----------------------------------------------------------- composer */

    .upload-note {
      padding: 7px 12px;
      background: #fffbeb;
      border-top: 1px solid #fde68a;
      color: #92400e;
      font-size: 11.5px;
      flex-shrink: 0;
    }

    .composer {
      border-top: 1px solid #eceef4;
      padding: 10px 12px 12px;
      background: #fbfcfe;
      flex-shrink: 0;
    }

    .composer-box {
      display: flex;
      flex-direction: column;
      border: 1px solid #d5d9e2;
      border-radius: 14px;
      background: white;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
      overflow: hidden;
    }
    .composer-box:focus-within {
      border-color: #4aa9a7;
      box-shadow: 0 0 0 3px rgba(74, 169, 167, 0.12);
    }
    .composer-box.disabled { background: #f8f9fc; }

    .composer-file {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 10px 10px 0;
      padding: 8px 10px;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      background: #f8fafc;
      max-width: 280px;
    }
    .composer-file.parsing { border-color: #bde6e5; background: #eafaf9; }
    .composer-file.error { border-color: #fecaca; background: #fffafa; }
    .composer-file.ready { border-color: #e5e7eb; }

    .composer-file-icon {
      position: relative;
      flex-shrink: 0;
      width: 32px;
      height: 36px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .composer-file-spinner {
      width: 18px;
      height: 18px;
      border: 2px solid #bde6e5;
      border-top-color: #5bc0be;
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .composer-file-badge.err {
      width: 22px;
      height: 22px;
      border-radius: 999px;
      background: #ef4444;
      color: white;
      font-weight: 700;
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .composer-file-ok {
      position: absolute;
      right: -4px;
      bottom: -2px;
      width: 14px;
      height: 14px;
      border-radius: 999px;
      background: #16a34a;
      color: white;
      font-size: 9px;
      font-weight: 700;
      display: flex;
      align-items: center;
      justify-content: center;
      border: 1.5px solid white;
    }

    .composer-file-meta {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .composer-file-name {
      font-size: 12.5px;
      font-weight: 600;
      color: #111827;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .composer-file-status {
      font-size: 11px;
      color: #6b7280;
    }
    .composer-file.parsing .composer-file-status { color: #17233d; }
    .composer-file.error .composer-file-status { color: #b91c1c; }

    .composer-file-remove {
      flex-shrink: 0;
      width: 22px;
      height: 22px;
      border: none;
      border-radius: 6px;
      background: transparent;
      color: #9ca3af;
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
    }
    .composer-file-remove:hover:not(:disabled) { background: #eef1f6; color: #374151; }
    .composer-file-remove:disabled { opacity: 0.4; cursor: default; }

    .composer textarea {
      width: 100%;
      min-height: 72px;
      resize: none;
      border: none;
      outline: none;
      padding: 10px 12px 4px;
      font-size: 13px;
      line-height: 1.5;
      font-family: inherit;
      box-sizing: border-box;
      background: transparent;
      color: inherit;
    }
    .composer textarea::placeholder { color: #9ca3af; }
    .composer textarea:disabled { color: #9ca3af; cursor: default; }

    .composer-toolbar {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 4px;
      padding: 4px 6px 6px;
    }

    .icon-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 34px;
      height: 34px;
      border: none;
      border-radius: 9px;
      background: transparent;
      color: #6b7280;
      cursor: pointer;
      flex-shrink: 0;
    }
    .icon-action:hover:not(:disabled) {
      background: #f3f4f8;
      color: #374151;
    }
    .icon-action:disabled {
      color: #c4c8d2;
      cursor: default;
    }

    .icon-action.send {
      background: #5bc0be;
      color: white;
    }
    .icon-action.send:hover:not(:disabled) {
      background: #17233d;
      color: white;
    }
    .icon-action.send:disabled {
      background: #c7c9e2;
      color: white;
    }

    .icon-action.stop {
      background: #fee2e2;
      color: #b91c1c;
    }
    .icon-action.stop:hover {
      background: #fecaca;
      color: #991b1b;
    }

    .btn-secondary {
      background: white;
      border: 1px solid #d5d9e2;
      color: #4b5563;
      border-radius: 7px;
      padding: 5px 11px;
      font-size: 11.5px;
      cursor: pointer;
    }
    .btn-secondary:hover:not(:disabled) { background: #f4f6fb; }
    .btn-secondary:disabled { color: #b0b6c1; cursor: default; }

    @media (max-width: 1023px) {
      :host { width: 100%; height: 100dvh; }
      .ai-panel,
      .ai-panel.collapsed {
        width: 100% !important;
        height: 100dvh;
        border-radius: 0;
        box-shadow: none;
      }
      .resizer { display: none; }
      .panel-header { padding-top: calc(11px + env(safe-area-inset-top)); }
      .collapse-btn { display: none; }
      .composer { padding-bottom: calc(12px + env(safe-area-inset-bottom)); }
    }
  `],
})
export class WizardAiPanelComponent implements OnInit, OnDestroy {
  /** Accession the wizard already knows about, forwarded as context. */
  readonly accession = input<string | null>(null);
  readonly close = output<void>();

  private readonly scroller = viewChild<ElementRef<HTMLDivElement>>('scroller');
  private readonly fileInputRef = viewChild<ElementRef<HTMLInputElement>>('fileInput');
  private readonly composerInput = viewChild<ElementRef<HTMLTextAreaElement>>('composerInput');

  readonly api = inject(AssistantApiService);
  readonly history = inject(ChatHistoryService);
  private readonly bridge = inject(WizardAiBridgeService);
  private readonly wizardState = inject(WizardStateService);

  private readonly _messages = signal<AssistantChatMessage[]>([]);
  private readonly _cards = signal<Record<string, WizardActionCard>>({});
  private readonly _busy = signal(false);
  private readonly _collapsed = signal(false);
  private readonly _composerFile = signal<AssistantAttachment | null>(null);
  private readonly _width = signal(readStoredWidth());
  private readonly _advisedSteps = signal<ReadonlySet<number>>(new Set<number>());
  private readonly _historyOpen = signal(false);
  private readonly _renamingId = signal<string | null>(null);

  readonly messages = this._messages.asReadonly();
  readonly busy = this._busy.asReadonly();
  readonly collapsed = this._collapsed.asReadonly();
  readonly composerFile = this._composerFile.asReadonly();
  readonly panelWidth = this._width.asReadonly();
  readonly historyOpen = this._historyOpen.asReadonly();
  readonly renamingId = this._renamingId.asReadonly();
  readonly activeTitle = computed(() => this.history.active()?.title || '');

  readonly totalSteps = WIZARD_STEPS.length;
  readonly stepIndex = computed(() => this.wizardState.currentStep());
  readonly stepTitle = computed(() => WIZARD_STEPS[this.stepIndex()]?.title || '');
  readonly stepProgress = computed(() => ((this.stepIndex() + 1) / this.totalSteps) * 100);
  readonly advisedCurrentStep = computed(() => this._advisedSteps().has(this.stepIndex()));

  readonly retrievalTag = computed(() => {
    const health = this.api.health();
    if (!health) return '';
    return health.retrieval === 'hybrid' ? 'spec RAG' : health.specIndexReady ? 'spec lexical' : 'no spec index';
  });

  /** Tooltip spelling out which backend capabilities are live. */
  readonly healthTitle = computed(() => {
    const health = this.api.health();
    if (!health) return 'Backend status unknown';
    const parts = [
      `${health.specChunkCount} specification sections indexed (${health.retrieval} retrieval)`,
      health.embeddingsConfigured ? 'embeddings configured' : 'no embeddings - lexical retrieval only',
      health.mineruConfigured ? 'MinerU available for PDFs' : 'MinerU not configured',
    ];
    return parts.join(' · ');
  });

  draft = '';
  baseUrlDraft = '';
  renameDraft = '';

  private readonly _slashHintsVisible = signal(false);
  readonly slashHintsVisible = this._slashHintsVisible.asReadonly();
  readonly slashHints = SLASH_COMMAND_HINTS;

  private sessionId = createSessionId();
  private cardSequence = 0;
  /** A step change that arrived while a turn was streaming, advised once it ends. */
  private queuedStep: number | null = null;
  private resizeCleanup: (() => void) | null = null;
  /** Suppress step auto-advise / debounced persist while swapping history. */
  private loadingSession = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  readonly quickStarts: QuickStart[] = [
    {
      label: '/sdrf-annotate a PXD dataset',
      hint: 'Type /sdrf-annotate PXD000547 to run the annotation skill',
      prompt: '/sdrf-annotate PXD',
    },
    {
      label: 'Ask about the SDRF specification',
      hint: 'Answered from the indexed specification, with section numbers',
      prompt: 'What format should comment[modification parameters] use?',
    },
    {
      label: 'Annotate my own paper',
      hint: 'Upload a PDF — MinerU parses it, then I advise this page',
      prompt: '',
    },
  ];

  constructor() {
    // Follow the wizard: when the user lands on a page we have not advised on yet,
    // ask for that page's suggestions. Only `currentStep` is a dependency; the
    // guards must not re-arm the effect.
    effect(() => {
      const step = this.wizardState.currentStep();
      untracked(() => this.onStepChanged(step));
    });

    // Keep the active chat's wizard snapshot in sync with live form edits so a
    // refresh or history switch can restore AI-filled values.
    effect(() => {
      this.wizardState.state();
      this.wizardState.currentStep();
      untracked(() => this.schedulePersist());
    });
  }

  ngOnInit(): void {
    this.baseUrlDraft = this.api.baseUrl;
    void this.api.checkHealth();
    const session = this.history.ensureActive(() => createSessionId());
    this.loadSession(session.id);
  }

  ngOnDestroy(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    // Keep the last wizard snapshot (or an explicit clear from Cancel/Create).
    // Rewriting wizard here would undo clearActiveWizard() during teardown.
    this.persistActive({ includeWizard: false });
    this.resizeCleanup?.();
  }

  /** Flush chat + wizard before the tab unloads. */
  @HostListener('window:beforeunload')
  onBeforeUnload(): void {
    this.persistActive();
  }

  toggleCollapsed(): void {
    this._collapsed.update(value => !value);
    if (this._collapsed()) this._historyOpen.set(false);
  }

  toggleHistory(): void {
    this._historyOpen.update(value => !value);
  }

  /** Export the full chat + tool timeline + cards for offline debugging. */
  downloadTrace(): void {
    const session = this.history.active();
    const cards = this._cards();
    const payload = {
      exportedAt: new Date().toISOString(),
      chatSessionId: session?.id ?? null,
      title: session?.title ?? this.activeTitle(),
      backendSessionId: this.sessionId,
      wizardSnapshot: this.bridge.buildSnapshot(),
      health: this.api.health(),
      cardSequence: this.cardSequence,
      messages: this._messages().map(message => ({
        role: message.role,
        content: message.content,
        auto: message.auto,
        focusStep: message.focusStep,
        skill: message.skill,
        attachment: message.attachment,
        status: message.status,
        error: message.error,
        pending: message.pending,
        citations: message.citations,
        nextStep: message.nextStep,
        actionIds: message.actionIds,
        trace: message.trace,
        timeline: message.timeline,
        toolCalls: message.toolCalls,
      })),
      cards: Object.values(cards),
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `sdrf-agent-trace-${stamp}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  newChat(): void {
    if (this._busy()) return;
    this.persistActive();
    const session = this.history.create(createSessionId());
    this.loadSession(session.id);
    this._historyOpen.set(false);
  }

  openChat(id: string): void {
    if (this._busy() || id === this.history.activeId()) {
      this._historyOpen.set(false);
      return;
    }
    this.persistActive();
    this.loadSession(id);
    this._historyOpen.set(false);
  }

  deleteChat(id: string): void {
    if (this._busy()) return;
    const wasActive = id === this.history.activeId();
    this.history.remove(id);
    if (wasActive) {
      const next = this.history.active();
      if (next) this.loadSession(next.id);
      else this.newChat();
    }
  }

  startRename(id: string, title: string): void {
    this._renamingId.set(id);
    this.renameDraft = title;
  }

  cancelRename(): void {
    this._renamingId.set(null);
    this.renameDraft = '';
  }

  commitRename(id: string): void {
    if (this._renamingId() !== id) return;
    this.history.rename(id, this.renameDraft);
    this.cancelRename();
  }

  formatTime(timestamp: number): string {
    try {
      return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(
        timestamp
      );
    } catch {
      return new Date(timestamp).toLocaleString();
    }
  }

  timelineOf(message: AssistantChatMessage): AssistantTimelineItem[] {
    return migrateTimeline(message);
  }

  hasRunningTool(message: AssistantChatMessage): boolean {
    return migrateTimeline(message).some(
      item => item.kind === 'tool' && !!item.call.running
    );
  }

  canSend(): boolean {
    if (this._busy()) return false;
    const file = this._composerFile();
    if (file?.status === 'parsing') return false;
    if (file?.status === 'ready') return true;
    // Failed uploads must be removed (or ignored) — text-only send is still ok.
    return !!this.draft.trim();
  }

  clearComposerFile(): void {
    if (this._composerFile()?.status === 'parsing') return;
    this._composerFile.set(null);
  }

  private loadSession(id: string): void {
    const session = this.history.select(id);
    if (!session) return;
    this.loadingSession = true;
    try {
      this.sessionId = session.backendSessionId || createSessionId();
      this._messages.set(session.messages.map(message => ({ ...message, pending: false })));
      this._cards.set({ ...session.cards });
      this._advisedSteps.set(new Set(session.advisedSteps || []));
      this.cardSequence = session.cardSequence || 0;
      this._composerFile.set(null);
      this.queuedStep = null;
      this.restoreWizard(session);
      this.scrollToBottom();
    } finally {
      this.loadingSession = false;
    }
  }

  /**
   * Restore the wizard form that belongs to this chat.
   * Legacy sessions without `wizardState` leave the live form alone.
   */
  private restoreWizard(session: {
    wizardState?: WizardState | null;
    currentStep?: number;
  }): void {
    if (session.wizardState === undefined) return;
    if (session.wizardState) {
      this.wizardState.hydrate(session.wizardState, session.currentStep ?? 0);
    } else {
      this.wizardState.reset();
    }
  }

  private persistActive(options: { includeWizard?: boolean } = {}): void {
    if (!this.history.activeId()) return;
    const includeWizard = options.includeWizard !== false;
    this.history.saveActive({
      messages: this._messages(),
      cards: this._cards(),
      advisedSteps: [...this._advisedSteps()],
      cardSequence: this.cardSequence,
      backendSessionId: this.sessionId,
      ...(includeWizard
        ? {
            wizardState: structuredClone(this.wizardState.getState()),
            currentStep: this.wizardState.currentStep(),
          }
        : {}),
    });
  }

  private schedulePersist(): void {
    if (this.loadingSession) return;
    if (!this.history.activeId()) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistActive();
    }, 400);
  }

  render(text: string): string {
    return renderMarkdownLite(text);
  }

  stepLabel(step: AssistantStepId): string {
    const index = WIZARD_STEPS.findIndex(config => config.id === step);
    return index >= 0 ? `Step ${index + 1} · ${WIZARD_STEPS[index].title}` : step;
  }

  sourceLabel(citation: AssistantCitation): string {
    switch (citation.source) {
      case 'spec':
        return 'Spec';
      case 'pride':
        return 'PRIDE';
      case 'paper':
        return 'Paper';
      case 'template':
        return 'Template';
      case 'ontology':
        return 'Ontology';
      default:
        return 'Source';
    }
  }

  async saveBaseUrl(): Promise<void> {
    this.api.setBaseUrl(this.baseUrlDraft);
    await this.api.checkHealth();
  }

  useQuickStart(quick: QuickStart): void {
    if (quick.label === 'Annotate my own paper') {
      this.fileInputRef()?.nativeElement.click();
      return;
    }
    this.draft = quick.prompt;
    this.onDraftInput();
  }

  onDraftInput(): void {
    const value = this.draft.trimStart();
    this._slashHintsVisible.set(value === '/' || value.startsWith('/sdrf'));
  }

  applySlashHint(example: string): void {
    this.draft = example;
    this._slashHintsVisible.set(false);
  }

  formatSize(charCount: number): string {
    if (charCount < 1000) return `${charCount} chars`;
    if (charCount < 1_000_000) return `${(charCount / 1000).toFixed(1)}k chars`;
    return `${(charCount / 1_000_000).toFixed(1)}M chars`;
  }

  onEnter(event: Event): void {
    const keyboard = event as KeyboardEvent;
    if (keyboard.shiftKey) return;
    event.preventDefault();
    if (this.canSend()) void this.send();
  }

  stop(): void {
    this.api.abort();
    this._busy.set(false);
    this.patchLast(message => ({ ...message, pending: false, status: undefined }));
    this.persistActive();
  }

  // ------------------------------------------------------------------ resizing

  startResize(event: PointerEvent): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = this._width();

    // The panel is docked to the right, so dragging its left edge leftwards widens it.
    const onMove = (move: PointerEvent) => {
      const next = Math.round(startWidth + (startX - move.clientX));
      this._width.set(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, next)));
    };
    const onUp = () => {
      this.resizeCleanup?.();
      this.resizeCleanup = null;
      storeWidth(this._width());
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    this.resizeCleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }

  // -------------------------------------------------------------- step driving

  /** The step strip button: advise on the page currently open. */
  adviseCurrentStep(): void {
    void this.adviseStep(this.wizardState.currentStep(), { force: true });
  }

  /** The "Continue" button under a turn: move the wizard on, then advise. */
  goNext(hint: AssistantNextStep): void {
    const currentStep = this.wizardState.currentStep();
    const decision = resolveAssistantNavigation(
      currentStep,
      hint.index,
      this.wizardState.canProceed(),
      this.totalSteps
    );
    if (decision === 'stay') return;
    if (decision === 'next') this.wizardState.nextStep();
    else this.wizardState.goToStep(hint.index);
    // The step effect picks the new step up, unless it was already advised.
    void this.adviseStep(hint.index);
  }

  private onStepChanged(step: number): void {
    // Nothing to advise on before the user has started a conversation: there is no
    // evidence yet, and an unprompted turn would just be noise.
    if (this.loadingSession) return;
    if (this._messages().length === 0) return;
    if (this._advisedSteps().has(step)) return;
    if (this._busy()) {
      this.queuedStep = step;
      return;
    }
    void this.adviseStep(step);
  }

  private async adviseStep(step: number, options: { force?: boolean } = {}): Promise<void> {
    const config = WIZARD_STEPS[step];
    if (!config || this._busy()) return;
    if (!options.force && this._advisedSteps().has(step)) return;

    await this.send(`Now help me with step ${step + 1}: ${config.title}.`, {
      focusStep: config.id as AssistantStepId,
      mode: 'step',
      auto: true,
    });
  }

  private markAdvised(step: number): void {
    this._advisedSteps.update(steps => new Set(steps).add(step));
  }

  // -------------------------------------------------------------------- chat

  async send(
    text?: string,
    options: {
      focusStep?: AssistantStepId;
      mode?: 'chat' | 'step';
      auto?: boolean;
      attachment?: AssistantAttachment;
      skill?: AssistantSkillRef;
      /** Prompt sent to the model when the UI shows a card/chip instead. */
      modelPrompt?: string;
      accession?: string | null;
    } = {}
  ): Promise<void> {
    if (this._busy()) return;

    // Pick up a ready file from the DeepSeek-style composer when the user hits Send.
    let attachment = options.attachment;
    if (!attachment && text === undefined) {
      const file = this._composerFile();
      if (file?.status === 'parsing') return;
      if (file?.status === 'ready') {
        attachment = file;
        this._composerFile.set(null);
      }
      // Error cards stay in the composer until the user removes them; text-only
      // send still works without attaching the failed file.
    }

    const raw = (text ?? this.draft).trim();
    const uploadPrompt = attachment
      ? `I uploaded the paper "${attachment.fileName}" (documentId ${attachment.documentId}). ` +
        `Please call read_document on that documentId with sections ["methods","results"], then ` +
        `propose wizard actions for the page I am on.`
      : '';
    const slash = !attachment && !options.skill ? parseSlashCommand(raw) : null;
    const skill = options.skill || (slash ? { name: slash.name, args: slash.args || undefined } : undefined);
    const content =
      options.modelPrompt ||
      (attachment ? [uploadPrompt, raw].filter(Boolean).join('\n\n') : '') ||
      slash?.prompt ||
      raw;
    if (!content && !attachment) return;

    const stepIndex = options.focusStep
      ? WIZARD_STEPS.findIndex(config => config.id === options.focusStep)
      : this.wizardState.currentStep();
    const focusStep = (WIZARD_STEPS[stepIndex]?.id || 'setup') as AssistantStepId;

    if (text === undefined) {
      this.draft = '';
      this._slashHintsVisible.set(false);
    }
    this._messages.update(list => [
      ...list,
      {
        role: 'user',
        content: content || uploadPrompt,
        auto: options.auto,
        attachment,
        skill,
      },
      {
        role: 'assistant',
        content: '',
        focusStep,
        timeline: [],
        toolCalls: [],
        citations: [],
        actionIds: [],
        pending: true,
      },
    ]);
    this._busy.set(true);
    this.markAdvised(stepIndex);
    this.scrollToBottom();

    const chatHistory = this._messages()
      .filter(message => !message.pending)
      .map(message => ({ role: message.role, content: message.content }))
      .filter(message => message.content);

    try {
      const stream = this.api.streamChat({
        sessionId: this.sessionId,
        messages: chatHistory,
        wizardState: this.bridge.buildSnapshot(),
        accession: options.accession ?? slash?.accession ?? this.accession(),
        focusStep,
        mode: options.mode || 'chat',
        skill: skill?.name,
        skillArgs: skill?.args || slash?.args || null,
      });

      for await (const event of stream) {
        switch (event.type) {
          case 'status':
            this.patchLast(message => ({ ...message, status: event.text }));
            break;
          case 'tool_start':
            this.patchLast(message => upsertTool(message, { ...event.tool, running: true }));
            break;
          case 'tool':
            this.patchLast(message =>
              upsertTool(message, { ...event.tool, running: false })
            );
            break;
          case 'token':
            this.patchLast(message => {
              const timeline = appendText(message.timeline || [], event.text);
              return {
                ...message,
                status: undefined,
                timeline,
                content: textFromTimeline(timeline),
              };
            });
            break;
          case 'actions':
            this.registerActions(event.actions);
            break;
          case 'citations':
            this.patchLast(message => ({ ...message, citations: event.citations }));
            break;
          case 'next_step':
            this.patchLast(message => ({ ...message, nextStep: event.nextStep }));
            break;
          case 'error':
            this.patchLast(message => ({
              ...message,
              error: event.text,
              status: undefined,
              pending: false,
            }));
            break;
          case 'done':
            this.patchLast(message => finalizeTurn(message, event.result));
            break;
        }
        this.scrollToBottom();
      }
    } finally {
      this._busy.set(false);
      this.patchLast(message => ({
        ...message,
        pending: false,
        status: undefined,
        timeline: clearRunningTools(message.timeline || []),
      }));
      this.persistActive();
      this.scrollToBottom();
      this.flushQueuedStep();
    }
  }

  private flushQueuedStep(): void {
    const step = this.queuedStep;
    this.queuedStep = null;
    if (step !== null && step === this.wizardState.currentStep()) void this.adviseStep(step);
  }

  private registerActions(actions: WizardAction[]): void {
    if (!actions.length) return;

    const created: WizardActionCard[] = actions.map(action => ({
      id: `action_${++this.cardSequence}`,
      action,
      status: 'pending',
      preview: this.bridge.previewAction(action),
    }));

    this._cards.update(map => {
      const next = { ...map };
      for (const card of created) next[card.id] = card;
      return next;
    });
    this.patchLast(message => ({
      ...message,
      actionIds: [...(message.actionIds || []), ...created.map(card => card.id)],
    }));
    this.persistActive();
  }

  private patchLast(update: (message: AssistantChatMessage) => AssistantChatMessage): void {
    this._messages.update(list => {
      if (!list.length) return list;
      const next = [...list];
      const index = next.length - 1;
      if (next[index].role !== 'assistant') return list;
      next[index] = update(next[index]);
      return next;
    });
  }

  private scrollToBottom(): void {
    // Runs after the current change detection pass has rendered the new content.
    setTimeout(() => {
      const element = this.scroller()?.nativeElement;
      if (element) element.scrollTop = element.scrollHeight;
    });
  }

  // ------------------------------------------------------------------- cards

  /**
   * Memoised so each turn keeps a stable array reference between change detection
   * passes; a fresh array every pass would churn the child component's input.
   */
  private readonly cardsByMessage = computed(() => {
    const map = this._cards();
    const grouped = new Map<AssistantChatMessage, WizardActionCard[]>();
    for (const message of this._messages()) {
      if (message.role !== 'assistant' || !message.actionIds?.length) continue;
      const cards = message.actionIds
        .map(id => map[id])
        .filter((card): card is WizardActionCard => !!card);
      if (cards.length) grouped.set(message, cards);
    }
    return grouped;
  });

  cardsFor(message: AssistantChatMessage): WizardActionCard[] {
    return this.cardsByMessage().get(message) || NO_CARDS;
  }

  async apply(card: WizardActionCard): Promise<void> {
    const preview = this.bridge.previewAction(card.action);
    try {
      await this.bridge.applyAction(card.action);
      this.updateCard(card.id, { status: 'applied', preview, error: undefined });
    } catch (error) {
      const message =
        error instanceof WizardActionError || error instanceof Error
          ? error.message
          : 'Could not apply this suggestion.';
      this.updateCard(card.id, { status: 'failed', preview, error: message });
    }
  }

  dismiss(card: WizardActionCard): void {
    this.updateCard(card.id, { status: 'dismissed', preview: this.bridge.previewAction(card.action) });
  }

  /** Prefill the composer so the user can challenge or refine one suggestion. */
  askAbout(card: WizardActionCard): void {
    const preview = this.bridge.previewAction(card.action);
    const why = card.action.reasoning?.trim();
    const lines = [
      `Regarding the suggestion "${card.action.label}":`,
      `Current change: ${preview}`,
    ];
    if (why) lines.push(`AI reasoning: ${why}`);
    lines.push('My feedback:');
    this.draft = lines.join('\n');
    this._collapsed.set(false);
    setTimeout(() => {
      const el = this.composerInput()?.nativeElement;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 0);
  }

  async applyMany(cards: WizardActionCard[]): Promise<void> {
    for (const card of cards) {
      if (this._cards()[card.id]?.status === 'pending') await this.apply(card);
    }
  }

  private updateCard(id: string, patch: Partial<WizardActionCard>): void {
    this._cards.update(map => {
      const existing = map[id];
      if (!existing) return map;
      return { ...map, [id]: { ...existing, ...patch } };
    });
    this.persistActive();
  }

  // ------------------------------------------------------------------ upload

  async onFileSelected(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || this._busy() || this._composerFile()?.status === 'parsing') return;

    const sizeLabel = formatFileSizeLabel(file);
    this._composerFile.set({
      fileName: file.name,
      documentId: '',
      parser: 'MinerU',
      sections: [],
      charCount: 0,
      sizeLabel,
      status: 'parsing',
    });

    try {
      const result = await this.api.uploadPdf(this.sessionId, file);
      this._composerFile.set({
        fileName: result.fileName || file.name,
        documentId: result.documentId,
        parser: result.parser || 'MinerU',
        sections: result.sections || [],
        charCount: result.charCount,
        sizeLabel,
        status: 'ready',
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this._composerFile.set({
        fileName: file.name,
        documentId: '',
        parser: 'MinerU',
        sections: [],
        charCount: 0,
        sizeLabel,
        status: 'error',
        error: detail || 'Upload or parsing failed',
      });
    }
  }
}

function createSessionId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `sess_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function formatFileSizeLabel(file: File): string {
  const bytes = file.size;
  const type = file.name.toLowerCase().endsWith('.pdf') || file.type === 'application/pdf' ? 'PDF' : 'File';
  if (bytes < 1024) return `${type} ${bytes}B`;
  if (bytes < 1024 * 1024) return `${type} ${(bytes / 1024).toFixed(1)}KB`;
  return `${type} ${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

/** Insert or replace a tool row in the turn timeline (tool_start → tool). */
function upsertTool(
  message: AssistantChatMessage,
  call: AssistantToolCall
): AssistantChatMessage {
  if (!call?.id) return { ...message, status: undefined };
  const timeline = [...(message.timeline || [])];
  const index = timeline.findIndex(item => item.kind === 'tool' && item.call.id === call.id);
  const item: AssistantTimelineItem = { kind: 'tool', id: call.id, call };
  if (index >= 0) {
    timeline[index] = item;
  } else {
    timeline.push(item);
  }
  return {
    ...message,
    status: undefined,
    toolCalls: timeline.filter(entry => entry.kind === 'tool').map(entry => entry.call),
    timeline,
  };
}

function clearRunningTools(timeline: AssistantTimelineItem[]): AssistantTimelineItem[] {
  return timeline.map(item =>
    item.kind === 'tool' && item.call.running
      ? { ...item, call: { ...item.call, running: false } }
      : item
  );
}

function appendText(timeline: AssistantTimelineItem[], text: string): AssistantTimelineItem[] {
  if (!text) return timeline;
  const last = timeline[timeline.length - 1];
  if (last?.kind === 'text') {
    const next = timeline.slice();
    next[next.length - 1] = { kind: 'text', id: last.id, content: last.content + text };
    return next;
  }
  return [...timeline, { kind: 'text', id: `text_${timeline.length}_${Date.now()}`, content: text }];
}

function textFromTimeline(timeline: AssistantTimelineItem[]): string {
  return timeline
    .filter((item): item is Extract<AssistantTimelineItem, { kind: 'text' }> => item.kind === 'text')
    .map(item => item.content)
    .join('\n\n');
}

function finalizeTurn(
  message: AssistantChatMessage,
  result: {
    content: string;
    citations: AssistantCitation[];
    toolCalls: AssistantToolCall[];
    nextStep: AssistantNextStep | null;
    trace?: Record<string, unknown> | null;
  }
): AssistantChatMessage {
  let timeline = mergeToolsFromResult(message.timeline || [], result.toolCalls);
  const streamed = textFromTimeline(timeline);
  const finalContent = pickRicherText(streamed, result.content || message.content);
  timeline = ensureTextBlock(timeline, finalContent);

  return {
    ...message,
    status: undefined,
    pending: false,
    timeline,
    toolCalls: timeline.filter(item => item.kind === 'tool').map(item => item.call),
    content: finalContent,
    citations: result.citations.length ? result.citations : message.citations,
    nextStep: result.nextStep || message.nextStep,
    trace: result.trace ?? message.trace ?? null,
  };
}

function mergeToolsFromResult(
  timeline: AssistantTimelineItem[],
  tools: AssistantToolCall[] | undefined
): AssistantTimelineItem[] {
  if (!tools?.length) return clearRunningTools(timeline);
  const next = [...timeline];
  for (const call of tools) {
    if (!call?.id) continue;
    const completed = { ...call, running: false };
    const index = next.findIndex(item => item.kind === 'tool' && item.call.id === call.id);
    if (index >= 0) {
      const existing = next[index];
      if (existing.kind !== 'tool') continue;
      // Prefer the richer payload (streamed resultJson / summary already shown).
      const richer =
        (completed.resultJson?.length || 0) >= (existing.call.resultJson?.length || 0)
          ? completed
          : { ...existing.call, ...completed, resultJson: existing.call.resultJson, running: false };
      next[index] = { kind: 'tool', id: call.id, call: richer };
    } else {
      next.push({ kind: 'tool', id: call.id, call: completed });
    }
  }
  return clearRunningTools(next);
}

function pickRicherText(streamed: string, fromResult: string): string {
  const a = (streamed || '').trim();
  const b = (fromResult || '').trim();
  if (!a) return fromResult || '';
  if (!b) return streamed;
  return b.length > a.length ? fromResult : streamed;
}

function ensureTextBlock(timeline: AssistantTimelineItem[], content: string): AssistantTimelineItem[] {
  if (!content.trim()) return timeline;
  const streamed = textFromTimeline(timeline);
  if (!streamed.trim()) {
    return [...timeline, { kind: 'text', id: `text_final_${Date.now()}`, content }];
  }
  if (content.trim().length <= streamed.trim().length) return timeline;
  // Done payload has a fuller answer than streamed tokens — append it so the
  // conclusion is visible without rewriting earlier interleaved snippets.
  return [...timeline, { kind: 'text', id: `text_final_${Date.now()}`, content }];
}

function readStoredWidth(): number {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    if (stored >= MIN_WIDTH && stored <= MAX_WIDTH) return stored;
  } catch {
    // Storage can be blocked in embedded iframes; the default is fine.
  }
  return DEFAULT_WIDTH;
}

function storeWidth(width: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    // Ignore storage failures; the width just will not persist.
  }
}
