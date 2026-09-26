/**
 * Suggestion cards for one assistant turn, grouped by the wizard step they touch.
 *
 * Visual language mirrors the left-hand Create New SDRF wizard: layer badges,
 * soft blue surfaces, and clear Apply / Dismiss actions.
 */

import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';

import { AssistantCitation, WizardAction, WizardActionCard } from '../../core/models/assistant';
import { WIZARD_STEPS } from '../../core/models/wizard';
import { WizardAiBridgeService } from '../../core/services/assistant/wizard-ai-bridge.service';
import { WizardStateService } from '../../core/services/wizard-state.service';

interface CardGroup {
  step: string;
  stepIndex: number;
  title: string;
  cards: WizardActionCard[];
  pending: WizardActionCard[];
}

type LayerKind = 'technology' | 'sample' | 'experiment' | 'count' | 'description' | 'attribute' | 'generic';

const OP_LAYER: Record<string, LayerKind> = {
  setTechnologyTemplate: 'technology',
  setSampleTemplate: 'sample',
  setSampleTemplates: 'sample',
  applyCharacteristicDraft: 'attribute',
  setExperimentTemplates: 'experiment',
  setSampleCount: 'count',
  setExperimentDescription: 'description',
  setFactors: 'generic',
  addFactor: 'generic',
};

const LAYER_LABEL: Record<LayerKind, string> = {
  technology: 'Technology',
  sample: 'Sample',
  experiment: 'Experiment',
  count: 'Samples',
  description: 'Notes',
  attribute: 'Sample attribute',
  generic: 'Suggestion',
};

@Component({
  selector: 'assistant-action-cards',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (group of groups(); track group.step) {
      <section class="group" [attr.inert]="disabled() ? '' : null" [attr.aria-busy]="disabled()">
        <header class="group-head">
          <span class="step-pill">
            <span class="step-num">{{ group.stepIndex + 1 }}</span>
            <span class="step-meta">
              <span class="step-kicker">Wizard step</span>
              <span class="step-title">{{ group.title }}</span>
            </span>
          </span>
          <span class="group-count">
            {{ group.pending.length || group.cards.length }}
            {{ (group.pending.length || group.cards.length) === 1 ? 'suggestion' : 'suggestions' }}
          </span>
          @if (group.pending.length > 1) {
            <button class="apply-all" (click)="applyAll.emit(group.pending)">Apply all</button>
          }
        </header>

        @for (card of group.cards; track card.id) {
          <article class="card" [class]="card.status" [attr.data-layer]="layerOf(card)">
            <div class="card-head">
              <span class="layer-badge" [attr.data-layer]="layerOf(card)">{{ layerLabel(card) }}</span>
              <span class="card-label">{{ card.action.label }}</span>
              <span class="confidence" [class]="card.action.confidence">{{ card.action.confidence }}</span>
            </div>

            <div class="card-diff">
              <span class="diff-label">Change</span>
              <code>{{ preview(card) }}</code>
            </div>

            @if (card.replacesCardId) {
              <p class="state">Repair for {{ card.replacesCardId }}</p>
            }
            @if (card.executionState === 'rolled-back') {
              <p class="state">Rolled back because another card failed. Original recommendation retained.</p>
            } @else if (card.executionState === 'not-executed') {
              <p class="state">Not executed: waiting for the failed card to be repaired.</p>
            }

            @if (card.action.reasoning) {
              <p class="card-why">
                <span class="why-label">Why</span>
                <span>{{ card.action.reasoning }}</span>
              </p>
            }

            @if (card.action.citations.length) {
              <div class="card-sources">
                @for (citation of card.action.citations; track $index) {
                  <a
                    class="source"
                    [href]="citation.url || '#'"
                    target="_blank"
                    rel="noopener noreferrer"
                    [title]="citation.snippet"
                  >
                    {{ sourceLabel(citation) }}
                  </a>
                }
              </div>
            }

            @if (importDependency(card); as dependency) {
              <p class="state failed">{{ dependency }}</p>
            }
            <footer class="card-foot">
              <button
                class="jump"
                [disabled]="!canJump(card.action)"
                (click)="jump(card.action)"
                [title]="jumpTitle(card.action)"
              >
                Open in wizard
              </button>
              <button
                class="ask"
                (click)="askAbout.emit(card)"
                title="Question or challenge this suggestion"
              >
                Ask
              </button>
              @if (card.executionState === 'superseded') {
                <span class="state dismissed">Replaced by {{ card.replacedByCardId }}</span>
              } @else if (card.executionState === 'repair-rejected') {
                <span class="state failed">Repair not applied: {{ card.error }}</span>
              } @else if (card.status === 'pending') {
                <button class="dismiss" (click)="dismiss.emit(card)">Dismiss</button>
                <button class="apply" [disabled]="!!importDependency(card)" (click)="apply.emit(card)">Apply</button>
              } @else if (card.status === 'applied') {
                <span class="state applied">{{ card.autoApplied ? 'Auto-applied' : 'Applied' }}</span>
                <button class="apply secondary" (click)="apply.emit(card)" title="Apply this suggestion again">
                  Re-apply
                </button>
              } @else if (card.status === 'dismissed') {
                <span class="state dismissed">Dismissed</span>
                <button class="apply secondary" (click)="apply.emit(card)">Apply</button>
              } @else {
                <span class="state failed" [title]="card.error || ''">{{ card.error || 'Could not apply' }}</span>
                <button class="apply secondary" (click)="apply.emit(card)">Ask AI to fix</button>
              }
            </footer>
          </article>
        }
      </section>
    }
  `,
  styles: [`
    :host { display: block; min-width: 0; overflow-wrap: anywhere; }
    .group { margin-top: 12px; min-width: 0; }
    .card-why > span:last-child { min-width: 0; white-space: pre-wrap; }

    .group-head {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 0 2px 10px;
      flex-wrap: wrap;
    }

    .step-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .step-num {
      width: 26px;
      height: 26px;
      border-radius: 999px;
      background: #3b82f6;
      color: white;
      font-size: 12px;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 0 3px #dbeafe;
    }

    .step-meta {
      display: flex;
      flex-direction: column;
      min-width: 0;
      line-height: 1.2;
    }
    .step-kicker {
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #93c5fd;
    }
    .step-title {
      font-size: 13px;
      font-weight: 650;
      color: #1e3a8a;
    }

    .group-count {
      color: #94a3b8;
      font-size: 11.5px;
    }

    .apply-all {
      margin-left: auto;
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      color: #1d4ed8;
      border-radius: 999px;
      padding: 4px 12px;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
    }
    .apply-all:hover { background: #dbeafe; }

    .card {
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      background: #ffffff;
      padding: 12px 12px 10px;
      margin-bottom: 10px;
      box-shadow: 0 1px 2px rgba(15, 23, 42, 0.04);
    }
    .card.pending { border-color: #dbeafe; background: linear-gradient(180deg, #f8fbff 0%, #ffffff 48%); }
    .card.applied { border-color: #bbf7d0; background: #f7fdf9; }
    .card.dismissed { opacity: 0.62; }
    .card.failed { border-color: #fecaca; background: #fffafa; }

    .card-head {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      flex-wrap: wrap;
    }

    .layer-badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      background: #f1f5f9;
      color: #475569;
    }
    .layer-badge[data-layer='technology'] { background: #dcfce7; color: #166534; }
    .layer-badge[data-layer='sample'] { background: #dbeafe; color: #1e40af; }
    .layer-badge[data-layer='experiment'] { background: #fef3c7; color: #92400e; }
    .layer-badge[data-layer='count'] { background: #e0e7ff; color: #3730a3; }
    .layer-badge[data-layer='description'] { background: #f3e8ff; color: #6b21a8; }

    .card-label {
      flex: 1;
      min-width: 0;
      font-weight: 650;
      color: #0f172a;
      font-size: 13px;
      line-height: 1.35;
    }

    .confidence {
      flex-shrink: 0;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .confidence.high { background: #dcfce7; color: #15803d; }
    .confidence.medium { background: #fef3c7; color: #b45309; }
    .confidence.low { background: #fee2e2; color: #b91c1c; }

    .card-diff {
      display: flex;
      flex-direction: column;
      gap: 4px;
      background: #f8fafc;
      border: 1px solid #eef2f7;
      border-radius: 10px;
      padding: 8px 10px;
    }
    .diff-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: #94a3b8;
    }
    .card-diff code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.45;
      color: #334155;
      word-break: break-word;
      white-space: pre-wrap;
    }

    .card-why {
      display: flex;
      gap: 8px;
      margin: 8px 0 0;
      color: #475569;
      font-size: 12px;
      line-height: 1.5;
    }
    .why-label {
      flex-shrink: 0;
      margin-top: 1px;
      color: #2563eb;
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .card-sources {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-top: 8px;
    }
    .source {
      background: #eff6ff;
      color: #1d4ed8;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 10.5px;
      text-decoration: none;
    }
    .source:hover { background: #dbeafe; }

    .card-foot {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid #f1f5f9;
    }

    .jump {
      margin-right: auto;
      background: none;
      border: none;
      color: #2563eb;
      padding: 0;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
    }
    .jump:hover:not(:disabled) { text-decoration: underline; text-underline-offset: 2px; }
    .jump:disabled { color: #cbd5e1; cursor: default; }

    .ask {
      background: white;
      border: 1px solid #e2e8f0;
      color: #475569;
      border-radius: 8px;
      padding: 5px 11px;
      font-size: 11.5px;
      font-weight: 600;
      cursor: pointer;
    }
    .ask:hover { background: #f8fafc; color: #1e293b; border-color: #cbd5e1; }

    .dismiss {
      background: white;
      border: 1px solid #e2e8f0;
      color: #64748b;
      border-radius: 8px;
      padding: 5px 11px;
      font-size: 11.5px;
      cursor: pointer;
    }
    .dismiss:hover { background: #f8fafc; color: #334155; }

    .apply {
      background: #3b82f6;
      border: none;
      color: white;
      border-radius: 8px;
      padding: 5px 14px;
      font-size: 11.5px;
      font-weight: 650;
      cursor: pointer;
      box-shadow: 0 1px 2px rgba(37, 99, 235, 0.25);
    }
    .apply:hover { background: #2563eb; }
    .apply.secondary {
      background: white;
      border: 1px solid #bfdbfe;
      color: #1d4ed8;
      box-shadow: none;
    }
    .apply.secondary:hover { background: #eff6ff; }

    .state {
      font-size: 11.5px;
      font-weight: 650;
    }
    .state.applied { color: #15803d; }
    .state.dismissed { color: #94a3b8; }
    .state.failed { color: #b91c1c; font-weight: 500; min-width: 0; white-space: pre-wrap; }
    .card-foot .state.failed { flex-basis: 100%; }
    .card-foot button { flex-shrink: 0; white-space: nowrap; }
    .apply:disabled { opacity: .5; cursor: not-allowed; }
  `],
})
export class ActionCardListComponent {
  readonly cards = input<WizardActionCard[]>([]);
  readonly disabled = input(false);

  readonly apply = output<WizardActionCard>();
  readonly dismiss = output<WizardActionCard>();
  readonly applyAll = output<WizardActionCard[]>();
  /** Prefill the composer so the user can question or challenge this card. */
  readonly askAbout = output<WizardActionCard>();

  private readonly bridge = inject(WizardAiBridgeService);
  private readonly wizardState = inject(WizardStateService);

  importDependency(card: WizardActionCard): string {
    if (card.action.op !== 'applyRunsFilesPlan' || card.status !== 'pending') return '';
    const plan = card.action.args[0] as { groups?: { files?: { fileName?: string }[] }[] } | undefined;
    if (!Array.isArray(plan?.groups)) return '';
    const known = new Set(this.wizardState.state().dataFiles.map(f => f.fileName.trim()));
    const missing = new Set(plan.groups.flatMap(group => Array.isArray(group?.files) ? group.files : [])
      .map(file => file?.fileName?.trim()).filter((name): name is string => !!name && !known.has(name)));
    return missing.size ? `Import ${missing.size} missing file name(s) first. Apply the file-pool import card before this plan, or import names in Runs & Files.` : '';
  }

  readonly groups = computed<CardGroup[]>(() => {
    const byStep = new Map<string, CardGroup>();

    for (const card of this.cards()) {
      const step = card.action.step;
      let group = byStep.get(step);
      if (!group) {
        const stepIndex = this.bridge.stepIndexOf(card.action);
        group = {
          step,
          stepIndex,
          title: WIZARD_STEPS[stepIndex]?.title || step,
          cards: [],
          pending: [],
        };
        byStep.set(step, group);
      }
      group.cards.push(card);
      if (card.status === 'pending') group.pending.push(card);
    }

    return [...byStep.values()].sort((a, b) => a.stepIndex - b.stepIndex);
  });

  layerOf(card: WizardActionCard): LayerKind {
    return OP_LAYER[card.action.op] || 'generic';
  }

  layerLabel(card: WizardActionCard): string {
    return LAYER_LABEL[this.layerOf(card)];
  }

  /** Pending cards re-read the live state, so the diff stays honest as it changes. */
  preview(card: WizardActionCard): string {
    // Older saved cards contain shortened previews; recover full lists from
    // the preserved arguments without changing their applied/dismissed state.
    if (['setSourceNames', 'setBiologicalReplicates', 'replaceWithUnassignedFileNames',
         'assignDataFilesToRun', 'assignFilesToRunsByName', 'setFactorColumnValues'].includes(card.action.op)) {
      return this.bridge.previewAction(card.action);
    }
    if (card.status !== 'pending' && card.action.op === 'setExperimentDescription') {
      return `Set experiment description:\n${String(card.action.args[0] ?? '')}`;
    }
    return card.status === 'pending' ? this.bridge.previewAction(card.action) : card.preview;
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

  canJump(action: WizardAction): boolean {
    return this.bridge.stepIndexOf(action) <= this.wizardState.currentStep();
  }

  jumpTitle(action: WizardAction): string {
    return this.canJump(action)
      ? 'Jump to this wizard page'
      : 'Complete the earlier steps before jumping here';
  }

  jump(action: WizardAction): void {
    if (this.canJump(action)) this.wizardState.goToStep(this.bridge.stepIndexOf(action));
  }
}
