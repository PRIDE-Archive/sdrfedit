/**
 * SDRF Creation Wizard Component
 *
 * Main wizard container with step navigation for creating SDRF files from scratch.
 */

import {
  Component,
  Input,
  Output,
  EventEmitter,
  inject,
  OnInit,
  ChangeDetectionStrategy,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';

import { WizardStateService } from '../../core/services/wizard-state.service';
import { ChatHistoryService } from '../../core/services/assistant/chat-history.service';
import { WizardAutoAnnotationService } from '../../core/services/assistant/wizard-auto-annotation.service';
import { SdrfTable } from '../../core/models/sdrf-table';
import { WizardGeneratorService } from '../../core/services/wizard-generator.service';
import { TemplateService } from '../../core/services/template.service';

// Step components
import { ExperimentSetupComponent } from './steps/experiment-setup.component';
import { SampleCharacteristicsComponent } from './steps/sample-characteristics.component';
import { SampleValuesComponent } from './steps/sample-values.component';
import { RunsFilesComponent } from './steps/runs-files.component';
import { InstrumentProtocolComponent } from './steps/instrument-protocol.component';
import { ReviewCreateComponent } from './steps/review-create.component';
import { WizardAiPanelComponent } from '../wizard-ai-panel/wizard-ai-panel.component';

@Component({
  selector: 'sdrf-wizard',
  standalone: true,
  imports: [
    CommonModule,
    ExperimentSetupComponent,
    SampleCharacteristicsComponent,
    SampleValuesComponent,
    RunsFilesComponent,
    InstrumentProtocolComponent,
    ReviewCreateComponent,
    WizardAiPanelComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wizard-overlay">
      <div
        class="wizard-shell"
        [class.ai-open]="aiEnabled && showAiPanel()"
        (click)="$event.stopPropagation()"
      >
      <div class="wizard-container">
        <!-- Header -->
        <div class="wizard-header">
          <h2>Create New SDRF</h2>
          <div class="header-actions">
            @if (aiEnabled && !showAiPanel()) {
              <button class="btn-assistant" (click)="showAiPanel.set(true)" title="Open the SDRF assistant">
                Ask AI
              </button>
            }
            <button class="btn-close" [disabled]="autoAnnotation.active()" (click)="onCancel()" title="Close">&times;</button>
          </div>
        </div>

        <!-- Progress Steps -->
        <div class="wizard-progress" [attr.inert]="autoAnnotation.active() ? '' : null">
          @for (step of wizardState.steps; track step.id; let i = $index) {
            <button
              class="step-indicator"
              [class.active]="i === wizardState.currentStep()"
              [class.completed]="i < wizardState.currentStep()"
              [class.clickable]="i <= wizardState.currentStep()"
              (click)="goToStep(i)"
              [disabled]="i > wizardState.currentStep()"
            >
              <span class="step-number">
                @if (i < wizardState.currentStep()) {
                  <span class="check-icon">&#10003;</span>
                } @else {
                  {{ i + 1 }}
                }
              </span>
              <span class="step-title">{{ step.title }}</span>
            </button>
            @if (i < wizardState.steps.length - 1) {
              <div class="step-connector" [class.completed]="i < wizardState.currentStep()"></div>
            }
          }
        </div>

        <!-- Step Content -->
        <div class="wizard-content" [attr.inert]="autoAnnotation.active() ? '' : null" [attr.aria-busy]="autoAnnotation.active()">
          @switch (wizardState.currentStep()) {
            @case (0) {
              <wizard-experiment-setup
                [aiEnabled]="aiEnabled"
                [availableTemplates]="availableTemplates"
              />
            }
            @case (1) {
              <wizard-sample-characteristics [aiEnabled]="aiEnabled" />
            }
            @case (2) {
              <wizard-sample-values [aiEnabled]="aiEnabled" />
            }
            @case (3) {
              <wizard-runs-files [aiEnabled]="aiEnabled" />
            }
            @case (4) {
              <wizard-instrument-protocol [aiEnabled]="aiEnabled" />
            }
            @case (5) {
              <wizard-review-create
                [aiEnabled]="aiEnabled"
                (createTable)="onCreate($event)"
              />
            }
          }
        </div>

        <!-- Footer Navigation -->
        <div class="wizard-footer" [attr.inert]="autoAnnotation.active() ? '' : null">
          <button
            class="btn btn-secondary"
            [disabled]="!wizardState.canGoBack()"
            (click)="wizardState.previousStep()"
          >
            Back
          </button>

          <div class="step-info">
            Step {{ wizardState.currentStep() + 1 }} of {{ wizardState.totalSteps }}
          </div>

          @if (wizardState.currentStep() < wizardState.totalSteps - 1) {
            <button
              class="btn btn-primary"
              [disabled]="!wizardState.canProceed()"
              (click)="wizardState.nextStep()"
            >
              Next
            </button>
          } @else {
            <button
              class="btn btn-primary btn-create"
              [disabled]="!wizardState.canCreate()"
              (click)="onCreateClick()"
            >
              Create SDRF
            </button>
          }
        </div>
      </div>

      @if (aiEnabled && showAiPanel()) {
        <wizard-ai-panel (close)="showAiPanel.set(false)" />
      }
      </div>
    </div>
  `,
  styles: [`
    .wizard-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      animation: fadeIn 0.2s ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    /*
     * Sized to its content so the docked assistant, whose width the user can drag,
     * simply adds to the overlay instead of squeezing the wizard. Both panes share
     * the same height so the assistant is not a short floating card.
     */
    .wizard-shell {
      display: flex;
      align-items: stretch;
      gap: 14px;
      width: fit-content;
      max-width: 98vw;
      height: min(90vh, 920px);
      max-height: 90vh;
      animation: slideUp 0.25s ease-out;
    }

    .wizard-container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 25px 80px rgba(0, 0, 0, 0.3);
      flex: 1 1 900px;
      width: 900px;
      min-width: 0;
      min-height: 0;
      height: 100%;
      display: flex;
      flex-direction: column;
    }

    wizard-ai-panel {
      display: flex;
      align-self: stretch;
      min-height: 0;
      height: 100%;
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .btn-assistant {
      background: #eef2ff;
      color: #4338ca;
      border: 1px solid #c7d2fe;
      border-radius: 6px;
      padding: 5px 12px;
      font-size: 12.5px;
      font-weight: 500;
      cursor: pointer;
    }

    .btn-assistant:hover {
      background: #e0e7ff;
    }

    @keyframes slideUp {
      from {
        opacity: 0;
        transform: translateY(30px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .wizard-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 20px 24px;
      border-bottom: 1px solid #e5e7eb;
      flex-shrink: 0;
    }

    .wizard-header h2 {
      margin: 0;
      font-size: 20px;
      font-weight: 600;
      color: #1f2937;
    }

    .btn-close {
      background: none;
      border: none;
      font-size: 28px;
      cursor: pointer;
      color: #6b7280;
      padding: 0;
      line-height: 1;
      transition: color 0.15s;
    }

    .btn-close:hover {
      color: #374151;
    }

    .wizard-progress {
      display: flex;
      align-items: center;
      padding: 20px 24px;
      background: #f9fafb;
      border-bottom: 1px solid #e5e7eb;
      flex-shrink: 0;
      overflow-x: auto;
    }

    .step-indicator {
      display: flex;
      flex-direction: column;
      align-items: center;
      background: none;
      border: none;
      cursor: default;
      padding: 0;
      min-width: 80px;
      opacity: 0.5;
      transition: opacity 0.2s;
    }

    .step-indicator.active,
    .step-indicator.completed {
      opacity: 1;
    }

    .step-indicator.clickable {
      cursor: pointer;
    }

    .step-indicator.clickable:hover .step-number {
      transform: scale(1.1);
    }

    .step-number {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: #e5e7eb;
      color: #6b7280;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 6px;
      transition: all 0.2s;
    }

    .step-indicator.active .step-number {
      background: #3b82f6;
      color: white;
    }

    .step-indicator.completed .step-number {
      background: #10b981;
      color: white;
    }

    .check-icon {
      font-size: 16px;
    }

    .step-title {
      font-size: 11px;
      color: #6b7280;
      text-align: center;
      white-space: nowrap;
    }

    .step-indicator.active .step-title {
      color: #3b82f6;
      font-weight: 500;
    }

    .step-indicator.completed .step-title {
      color: #10b981;
    }

    .step-connector {
      flex: 1;
      height: 2px;
      background: #e5e7eb;
      margin: 0 8px;
      margin-bottom: 20px;
      min-width: 20px;
      transition: background 0.2s;
    }

    .step-connector.completed {
      background: #10b981;
    }

    .wizard-content {
      flex: 1;
      overflow-y: auto;
      padding: 24px;
    }

    .wizard-footer {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 24px;
      border-top: 1px solid #e5e7eb;
      background: #f9fafb;
      border-radius: 0 0 12px 12px;
      flex-shrink: 0;
    }

    .step-info {
      font-size: 13px;
      color: #6b7280;
    }

    .btn {
      padding: 10px 24px;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s;
    }

    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-primary {
      background: #3b82f6;
      color: white;
      border-color: #3b82f6;
    }

    .btn-primary:hover:not(:disabled) {
      background: #2563eb;
    }

    .btn-secondary {
      background: white;
      color: #374151;
    }

    .btn-secondary:hover:not(:disabled) {
      background: #f3f4f6;
    }

    .btn-create {
      background: #10b981;
      border-color: #10b981;
    }

    .btn-create:hover:not(:disabled) {
      background: #059669;
    }

    @media (max-width: 1023px) {
      .wizard-overlay { align-items: stretch; background: white; }
      .wizard-shell {
        width: 100vw;
        max-width: none;
        height: 100dvh;
        max-height: none;
        gap: 0;
      }
      .wizard-container {
        width: 100%;
        flex-basis: 100%;
        border-radius: 0;
        box-shadow: none;
      }
      .wizard-shell.ai-open .wizard-container { display: none; }
      wizard-ai-panel { width: 100%; flex: 1 1 100%; }
      .wizard-header { padding: 14px 16px; }
      .wizard-progress { padding: 12px 16px; }
      .wizard-content { padding: 16px; }
      .wizard-footer {
        padding: 12px 16px calc(12px + env(safe-area-inset-bottom));
        border-radius: 0;
      }
      .btn { min-height: 44px; padding: 9px 18px; }
    }
  `],
})
export class SdrfWizardComponent implements OnInit {
  @Input() aiEnabled = false;
  @Input() availableTemplates: string[] = [];
  @Output() complete = new EventEmitter<SdrfTable>();
  @Output() cancel = new EventEmitter<void>();

  /** Desktop starts docked; mobile starts with the form and opens AI on demand. */
  readonly showAiPanel = signal(!isMobileViewport());

  readonly wizardState = inject(WizardStateService);
  readonly autoAnnotation = inject(WizardAutoAnnotationService);
  private readonly generator = inject(WizardGeneratorService);
  readonly templateService = inject(TemplateService);
  private readonly chatHistory = inject(ChatHistoryService);

  constructor() {
    // Reset wizard state when component is created
    this.wizardState.reset();
  }

  ngOnInit(): void {
    // Fetch templates when wizard opens
    this.templateService.fetchTemplates();
  }

  goToStep(step: number): void {
    if (this.autoAnnotation.active()) return;
    if (step <= this.wizardState.currentStep()) {
      this.wizardState.goToStep(step);
    }
  }

  onCancel(): void {
    if (this.autoAnnotation.active()) return;
    this.autoAnnotation.clear();
    // Explicit dismiss — drop the draft so reopen starts clean. Chat text remains.
    this.chatHistory.clearActiveWizard();
    this.wizardState.reset();
    this.cancel.emit();
  }

  onCreateClick(): void {
    if (this.autoAnnotation.active()) return;
    const table = this.generator.generate(this.wizardState.getState());
    this.onCreate(table);
  }

  onCreate(table: SdrfTable): void {
    if (this.autoAnnotation.active()) return;
    this.autoAnnotation.clear();
    this.complete.emit(table);
    this.chatHistory.clearActiveWizard();
    this.wizardState.reset();
  }
}

function isMobileViewport(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(max-width: 1023px)').matches
  );
}
