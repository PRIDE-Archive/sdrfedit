/**
 * SDRF Recommend Panel Component
 *
 * AI-powered recommendations sidebar panel.
 * Features:
 * - Slide-in sidebar like Stats panel
 * - Nicely rendered recommendations sorted by confidence
 * - OLS-validated suggestions with auto-apply
 * - Advanced settings for power users
 */

import {
  Component,
  Input,
  Output,
  EventEmitter,
  signal,
  computed,
  ChangeDetectionStrategy,
  OnChanges,
  OnInit,
  AfterViewInit,
  SimpleChanges,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import {
  SdrfRecommendation,
  RecommendationResult,
  RecommendationType,
  RecommendationConfidence,
  AnalysisFocusArea,
  LlmError,
  getProviderDisplayName,
} from '../../core/models/llm';
import {
  ActionableSuggestion,
  SuggestionActionEvent,
  SuggestionAction,
  getSuggestionTypeLabel,
} from '../../core/models/actionable-suggestion';
import { OntologySuggestion } from '../../core/models/ontology';
import { SdrfTable } from '../../core/models/sdrf-table';
import { getValueForSample } from '../../core/models/sdrf-column';
import {
  RecommendationService,
  recommendationService,
  ActionableRecommendationResult,
  AnalysisProgress,
} from '../../core/services/llm/recommendation.service';
import {
  LlmSettingsService,
  llmSettingsService,
} from '../../core/services/llm/settings.service';
import {
  ColumnQualityService,
  TableQualityResult,
  ColumnQuality,
} from '../../core/services/column-quality.service';
import {
  DataCleaningService,
  AutoFix,
  FixResult,
  dataCleaningService,
} from '../../core/services/data-cleaning.service';
import {
  SdrfExamplesService,
  sdrfExamplesService,
} from '../../core/services/sdrf-examples.service';
import { promptService } from '../../core/services/llm/prompt.service';
import { AiWorkerService } from '../../core/services/ai-worker.service';
import {
  PyodideValidatorService,
  pyodideValidatorService,
  ValidationError,
} from '../../core/services/pyodide-validator.service';
import { sdrfExport } from '../../core/services/sdrf-export.service';
import {
  SuggestionEnrichmentService,
  suggestionEnrichmentService,
} from '../../core/services/llm/suggestion-enrichment.service';
import {
  SuggestionStateService,
  suggestionStateService,
} from '../../core/services/suggestion-state.service';
import { SuggestionCardComponent } from '../suggestion-card/suggestion-card.component';

export interface ApplyRecommendationEvent {
  recommendation: SdrfRecommendation;
}

export interface BatchApplyEvent {
  recommendations: SdrfRecommendation[];
}

export interface ApplyFixEvent {
  table: SdrfTable;
  fix: AutoFix;
  result: FixResult;
}

type SortOption = 'confidence' | 'column' | 'type' | 'samples';
type ViewTab = 'recommendations' | 'quality' | 'advanced';

@Component({
  selector: 'sdrf-recommend-panel',
  standalone: true,
  imports: [CommonModule, FormsModule, SuggestionCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="ai-panel">
      <!-- Header -->
      <div class="panel-header">
        <div class="header-title">
          <span class="ai-icon">✨</span>
          <span>AI Assistant</span>
          @if (isConfigured()) {
            <span class="provider-tag">{{ getActiveProviderName() }}</span>
          }
        </div>
        <div class="header-actions">
          <button type="button" class="icon-btn" (click)="openSettings.emit()" title="Settings">
            ⚙️
          </button>
          <button type="button" class="icon-btn" (click)="close.emit()" title="Close">×</button>
        </div>
      </div>

      <!-- Initializing State -->
      @if (isInitializing()) {
        <div class="initializing-state">
          <div class="initializing-spinner"></div>
          <p>Initializing AI Assistant...</p>
        </div>
      } @else if (!isConfigured()) {
        <!-- Not Configured -->
        <div class="empty-state">
          <p>Configure an AI provider to get started.</p>
          <button type="button" class="btn btn-primary" (click)="openSettings.emit()">
            Configure Provider
          </button>
        </div>
      } @else {
        <!-- Tabs -->
        <div class="panel-tabs">
          <button
            type="button"
            class="tab"
            [class.active]="activeTab() === 'quality'"
            (click)="activeTab.set('quality')"
          >
            Quality
            @if (qualityIssueCount() > 0) {
              <span class="tab-badge tab-badge-warn">{{ qualityIssueCount() }}</span>
            }
          </button>
          <button
            type="button"
            class="tab"
            [class.active]="activeTab() === 'recommendations'"
            (click)="activeTab.set('recommendations')"
          >
            AI Suggest
            @if (result() && result()!.recommendations.length > 0) {
              <span class="tab-badge">{{ result()!.recommendations.length }}</span>
            }
          </button>
          <button
            type="button"
            class="tab"
            [class.active]="activeTab() === 'advanced'"
            (click)="activeTab.set('advanced')"
          >
            Advanced
          </button>
        </div>

        <!-- Tab Content -->
        <div class="panel-content">
          <!-- Quality Tab -->
          @if (activeTab() === 'quality') {
            <div class="quality-tab">
              <!-- Analyze Button -->
              <div class="quality-actions">
                <button
                  type="button"
                  class="btn btn-primary btn-block"
                  [disabled]="qualityAnalyzing() || !table"
                  (click)="analyzeQuality()"
                >
                  @if (qualityAnalyzing()) {
                    <span class="spinner"></span> Analyzing...
                  } @else {
                    Analyze Quality
                  }
                </button>
                @if (!table) {
                  <p class="quality-hint">No table loaded</p>
                }
              </div>

              <!-- Quality Error -->
              @if (error() && activeTab() === 'quality') {
                <div class="quality-error">
                  {{ error() }}
                </div>
              }

              @if (qualityResult()) {
                <!-- Summary -->
                <div class="quality-summary">
                  <div class="summary-stats">
                    <div class="stat">
                      <span class="stat-value">{{ qualityResult()!.summary.totalColumns }}</span>
                      <span class="stat-label">Columns</span>
                    </div>
                    <div class="stat stat-error" [class.hidden]="qualityResult()!.summary.effectivelyEmptyColumns === 0">
                      <span class="stat-value">{{ qualityResult()!.summary.effectivelyEmptyColumns }}</span>
                      <span class="stat-label">Empty</span>
                    </div>
                    <div class="stat stat-warn" [class.hidden]="qualityResult()!.summary.columnsWithIssues === 0">
                      <span class="stat-value">{{ qualityResult()!.summary.columnsWithIssues }}</span>
                      <span class="stat-label">Issues</span>
                    </div>
                  </div>
                </div>

                <!-- Auto-Fixes Available -->
                @if (availableFixes().length > 0) {
                  <div class="fixes-section">
                    <div class="section-header">
                      <h4>Auto-Fixes Available</h4>
                      <button type="button" class="btn btn-sm" (click)="applyAllSafeFixes()" [disabled]="safeFixes().length === 0">
                        Apply Safe ({{ safeFixes().length }})
                      </button>
                    </div>
                    <div class="fixes-list">
                      @for (fix of availableFixes(); track fix.id) {
                        <div class="fix-card" [class.fix-safe]="fix.isSafe">
                          <div class="fix-icon">
                            @switch (fix.type) {
                              @case ('standardize_nulls') { 🔄 }
                              @case ('fix_reserved_words') { ✓ }
                              @case ('lowercase_values') { Aa }
                              @case ('lowercase_column_names') { Aa }
                              @case ('remove_column') { 🗑️ }
                            }
                          </div>
                          <div class="fix-content">
                            <div class="fix-desc">{{ fix.description }}</div>
                            @if (fix.preview && fix.preview.length > 0) {
                              <div class="fix-preview">
                                @for (p of fix.preview.slice(0, 2); track $index) {
                                  <span class="preview-item">
                                    <span class="prev-old">{{ p.before }}</span>
                                    <span class="prev-arrow">→</span>
                                    <span class="prev-new">{{ p.after }}</span>
                                  </span>
                                }
                                @if (fix.preview.length > 2) {
                                  <span class="preview-more">+{{ fix.preview.length - 2 }} more</span>
                                }
                              </div>
                            }
                            <div class="fix-meta">
                              {{ fix.affectedCount }} {{ fix.type === 'remove_column' ? 'column' : 'cell' }}{{ fix.affectedCount > 1 ? 's' : '' }}
                              @if (fix.isSafe) {
                                <span class="safe-badge">Safe</span>
                              } @else {
                                <span class="review-badge">Review</span>
                              }
                            </div>
                          </div>
                          <button type="button" class="btn btn-xs btn-primary" [disabled]="isApplyingFix()" (click)="logClick(fix); applyFixAction(fix); $event.stopPropagation()">
                            {{ isApplyingFix() ? 'Applying...' : 'Apply' }}
                          </button>
                        </div>
                      }
                    </div>
                  </div>
                }

                <!-- Column Issues -->
                @if (columnsWithIssues().length > 0) {
                  <div class="issues-section">
                    <div class="section-header">
                      <h4>Column Issues</h4>
                    </div>
                    <div class="issues-list">
                      @for (col of columnsWithIssues(); track col.columnIndex) {
                        <div class="issue-card" [class]="'action-' + col.action">
                          <div class="issue-header">
                            <span class="issue-col-name">{{ col.name }}</span>
                            <span class="action-badge" [class]="'badge-' + col.action">
                              {{ col.action }}
                            </span>
                          </div>
                          <div class="issue-reason">{{ col.reason }}</div>
                          @if (col.suggestedFix) {
                            <div class="issue-fix">💡 {{ col.suggestedFix }}</div>
                          }
                          <div class="issue-stats">
                            <span>{{ col.uniqueValues }} unique</span>
                            <span>{{ col.emptyCount }} empty</span>
                            <span>{{ col.notAvailableCount }} N/A</span>
                          </div>
                        </div>
                      }
                    </div>
                  </div>
                }

                <!-- Good Columns -->
                @if (goodColumns().length > 0) {
                  <details class="good-section">
                    <summary>
                      ✅ {{ goodColumns().length }} columns OK
                    </summary>
                    <div class="good-list">
                      @for (col of goodColumns(); track col.columnIndex) {
                        <div class="good-item">{{ col.name }}</div>
                      }
                    </div>
                  </details>
                }
              } @else {
                <div class="empty-quality">
                  @if (isLargeTable()) {
                    <div class="large-table-warning">
                      <p><strong>Large table detected</strong></p>
                      <p>This table has {{ table?.sampleCount }} samples. Quality analysis was not run automatically to avoid slowing down your browser.</p>
                      <p>Click "Analyze Quality" to run the analysis manually.</p>
                    </div>
                  } @else {
                    <p>Click "Analyze Quality" to detect issues in your SDRF columns.</p>
                    <ul class="quality-checks">
                      <li>Columns with 100% identical values</li>
                      <li>Columns with 100% "not available"</li>
                      <li>Inconsistent case or null representations</li>
                      <li>Wrong reserved words (control → normal)</li>
                    </ul>
                  }
                </div>
              }

            </div>
          }

          <!-- Recommendations Tab -->
          @if (activeTab() === 'recommendations') {
            <div class="recommendations-tab">
              <!-- Analysis Controls -->
              <div class="analysis-section">
                <div class="focus-options">
                  <label class="focus-option">
                    <input type="checkbox" [checked]="focusFillMissing()" (change)="toggleFocus('fill_missing')" />
                    Fill missing
                  </label>
                  <label class="focus-option">
                    <input type="checkbox" [checked]="focusValidateOntology()" (change)="toggleFocus('validate_ontology')" />
                    Ontology
                  </label>
                  <label class="focus-option">
                    <input type="checkbox" [checked]="focusCheckConsistency()" (change)="toggleFocus('check_consistency')" />
                    Consistency
                  </label>
                </div>

                <!-- Toggle for OLS validation -->
                <label class="focus-option ols-toggle">
                  <input type="checkbox" [checked]="useActionableSuggestions()" (change)="useActionableSuggestions.set(!useActionableSuggestions())" />
                  <span class="ols-label">
                    Validate with OLS
                    <span class="ols-hint" title="Validates suggestions against the Ontology Lookup Service">?</span>
                  </span>
                </label>

                <button
                  type="button"
                  class="btn btn-primary btn-block"
                  [disabled]="(useActionableSuggestions() ? actionableAnalyzing() : analyzing()) || !table"
                  (click)="useActionableSuggestions() ? analyzeActionable() : analyze()"
                >
                  @if (useActionableSuggestions() ? actionableAnalyzing() : analyzing()) {
                    <span class="spinner"></span>
                    @if (enrichmentProgress()) {
                      {{ enrichmentProgress() }}
                    } @else {
                      Analyzing...
                    }
                  } @else {
                    Analyze SDRF
                  }
                </button>
              </div>

              <!-- Error -->
              @if (error()) {
                <div class="error-msg">
                  {{ error() }}
                  <button type="button" class="dismiss-btn" (click)="clearError()">×</button>
                </div>
              }

              <!-- Validation Errors Section (from sdrf-pipelines validator) -->
              @if (pyodideErrors().length > 0 && pyodideHasValidated()) {
                <div class="validation-errors-section">
                  <div class="section-header-line">
                    <h3 class="section-title">
                      🔍 Validation Errors
                      <span class="error-count-badge">
                        {{ pyodideErrorCount() }} error{{ pyodideErrorCount() !== 1 ? 's' : '' }}
                        @if (pyodideWarningCount() > 0) {
                          , {{ pyodideWarningCount() }} warning{{ pyodideWarningCount() !== 1 ? 's' : '' }}
                        }
                      </span>
                    </h3>
                  </div>
                  <div class="validation-errors-list">
                    @for (error of pyodideErrors().slice(0, 10); track $index) {
                      <div class="validation-error-item" [class.error-level-warning]="error.level === 'warning'">
                        <div class="error-level-badge" [class.level-error]="error.level === 'error'" [class.level-warning]="error.level === 'warning'">
                          {{ error.level === 'error' ? '❌' : '⚠️' }}
                        </div>
                        <div class="error-content">
                          <div class="error-message">{{ error.message }}</div>
                          @if (error.column || error.row >= 0) {
                            <div class="error-location">
                              @if (error.column) {
                                <span>{{ error.column }}</span>
                              }
                              @if (error.row >= 0) {
                                <span>Row {{ error.row + 1 }}</span>
                              }
                              @if (error.value) {
                                <span class="error-value">Value: "{{ error.value }}"</span>
                              }
                            </div>
                          }
                          @if (error.suggestion) {
                            <div class="error-suggestion">💡 {{ error.suggestion }}</div>
                          }
                        </div>
                        @if (error.column && error.row >= 0) {
                          <button type="button" class="btn btn-xs btn-jump" (click)="jumpToValidationError(error)" title="Jump to cell">
                            Jump
                          </button>
                        }
                      </div>
                    }
                    @if (pyodideErrors().length > 10) {
                      <div class="more-errors-notice">
                        ... and {{ pyodideErrors().length - 10 }} more error{{ pyodideErrors().length - 10 !== 1 ? 's' : '' }}
                      </div>
                    }
                  </div>
                </div>
              }

              <!-- Streaming Output (collapsible) -->
              @if (streamContent()) {
                <details class="stream-section" [open]="analyzing()">
                  <summary>
                    @if (analyzing()) {
                      <span class="spinner-sm"></span> Processing...
                    } @else {
                      Raw Output
                    }
                  </summary>
                  <pre class="stream-output">{{ streamContent() }}</pre>
                </details>
              }

              <!-- AI Recommendations Section -->
              @if ((useActionableSuggestions() && pendingActionableSuggestions().length > 0) || (!useActionableSuggestions() && result())) {
                <div class="ai-recommendations-header">
                  <h3 class="section-title">✨ AI Recommendations</h3>
                  <p class="section-subtitle">Suggestions based on validation results and AI knowledge</p>
                </div>
              }

              <!-- Results - Actionable Suggestions (new system with OLS validation) -->
              @if (useActionableSuggestions() && pendingActionableSuggestions().length > 0 && !actionableAnalyzing()) {
                <div class="results-section">
                  <!-- OLS Stats Banner -->
                  <div class="ols-stats-banner">
                    <span class="ols-stat">
                      <span class="material-icons">verified</span>
                      {{ olsMatchedCount() }} OLS verified
                    </span>
                    <span class="ols-stat">
                      <span class="material-icons">search</span>
                      {{ olsValidatedCount() }} validated
                    </span>
                    <span class="ols-stat">
                      <span class="material-icons">lightbulb</span>
                      {{ actionableSuggestionCount() }} suggestions
                    </span>
                  </div>

                  <!-- Batch Actions -->
                  <div class="batch-actions">
                    @if (olsMatchedCount() > 0) {
                      <button type="button" class="btn btn-sm btn-success" (click)="applyOlsValidatedActionable()">
                        Apply OLS Verified ({{ olsMatchedCount() }})
                      </button>
                    }
                    <button type="button" class="btn btn-sm" (click)="applyHighConfidenceActionable()">
                      Apply High Confidence
                    </button>
                  </div>

                  <!-- Actionable Suggestions List -->
                  <div class="actionable-suggestions-list">
                    @for (suggestion of pendingActionableSuggestions(); track suggestion.id) {
                      <app-suggestion-card
                        [suggestion]="suggestion"
                        (actionTriggered)="handleSuggestionAction($event)"
                        (alternativeSelected)="handleAlternativeSelected($event)"
                      />
                    }
                  </div>
                </div>
              }

              <!-- Results - Legacy system (without OLS validation) -->
              @if (!useActionableSuggestions() && result() && !analyzing()) {
                <div class="results-section">
                  <!-- Sort & Filter Bar -->
                  <div class="results-bar">
                    <span class="results-count">
                      {{ filteredRecommendations().length }} suggestion{{ filteredRecommendations().length !== 1 ? 's' : '' }}
                    </span>
                    <select class="sort-select" [value]="sortBy()" (change)="onSortChange($event)">
                      <option value="confidence">Sort: Confidence</option>
                      <option value="column">Sort: Column</option>
                      <option value="type">Sort: Type</option>
                      <option value="samples">Sort: # Samples</option>
                    </select>
                  </div>

                  <!-- Filter Pills -->
                  <div class="filter-pills">
                    <button
                      type="button"
                      class="pill"
                      [class.active]="filterType() === 'all'"
                      (click)="filterType.set('all')"
                    >All</button>
                    <button
                      type="button"
                      class="pill"
                      [class.active]="filterType() === 'fill_value'"
                      (click)="filterType.set('fill_value')"
                    >Fill</button>
                    <button
                      type="button"
                      class="pill"
                      [class.active]="filterType() === 'ontology_suggestion'"
                      (click)="filterType.set('ontology_suggestion')"
                    >Ontology</button>
                    <button
                      type="button"
                      class="pill"
                      [class.active]="filterType() === 'consistency_fix'"
                      (click)="filterType.set('consistency_fix')"
                    >Consistency</button>
                  </div>

                  <!-- Batch Actions -->
                  @if (unappliedCount() > 0) {
                    <div class="batch-actions">
                      <button type="button" class="btn btn-sm" (click)="applyHighConfidence()">
                        Apply High Confidence ({{ highConfidenceCount() }})
                      </button>
                      <button type="button" class="btn btn-sm" (click)="applyAll()">
                        Apply All ({{ unappliedCount() }})
                      </button>
                    </div>
                  }

                  <!-- Recommendations List -->
                  <div class="recommendations-list">
                    @if (filteredRecommendations().length === 0) {
                      <div class="no-results">
                        @if (result()!.recommendations.length === 0) {
                          No issues found. Your SDRF looks good!
                        } @else {
                          No recommendations match current filter.
                        }
                      </div>
                    } @else {
                      @for (rec of sortedRecommendations(); track rec.id) {
                        <div class="rec-card" [class.applied]="rec.applied">
                          <!-- Confidence indicator -->
                          <div class="rec-confidence-bar" [class]="'conf-' + rec.confidence"></div>

                          <div class="rec-content">
                            <!-- Header row -->
                            <div class="rec-header">
                              <span class="rec-type-badge" [class]="'type-' + rec.type">
                                {{ formatType(rec.type) }}
                              </span>
                              <span class="rec-column-name">{{ rec.column }}</span>
                              <span class="rec-confidence-badge" [class]="'conf-' + rec.confidence">
                                {{ rec.confidence }}
                              </span>
                            </div>

                            <!-- Change -->
                            <div class="rec-change">
                              @if (rec.currentValue && rec.currentValue !== rec.suggestedValue) {
                                <span class="old-val">{{ rec.currentValue }}</span>
                                <span class="arrow">→</span>
                              }
                              <span class="new-val">{{ rec.suggestedValue }}</span>
                            </div>

                            <!-- Meta -->
                            <div class="rec-meta">
                              {{ rec.sampleIndices.length }} sample{{ rec.sampleIndices.length > 1 ? 's' : '' }}
                              <span class="sample-list">({{ formatSamples(rec.sampleIndices) }})</span>
                            </div>

                            <!-- Reasoning -->
                            <div class="rec-reasoning">{{ rec.reasoning }}</div>

                            <!-- Actions -->
                            <div class="rec-actions">
                              @if (rec.applied) {
                                <span class="applied-label">Applied</span>
                              } @else {
                                <button type="button" class="btn btn-primary btn-xs" (click)="onApplyClick(rec)">
                                  Accept
                                </button>
                                <button type="button" class="btn btn-xs" (click)="onPreviewClick(rec)">
                                  Preview
                                </button>
                                <button type="button" class="btn btn-xs btn-muted" (click)="dismissRecommendation(rec)">
                                  Dismiss
                                </button>
                              }
                            </div>
                          </div>
                        </div>
                      }
                    }
                  </div>
                </div>
              }

              <!-- Empty state when no suggestions -->
              @if ((useActionableSuggestions() ? pendingActionableSuggestions().length === 0 : !result()) && !(useActionableSuggestions() ? actionableAnalyzing() : analyzing())) {
                <div class="no-results empty-state-suggestions">
                  <p>Click "Analyze SDRF" to get AI-powered suggestions.</p>
                  @if (useActionableSuggestions()) {
                    <p class="hint">Suggestions will be validated against OLS for accurate ontology terms.</p>
                  }
                </div>
              }
            </div>
          }

          <!-- Advanced Tab -->
          @if (activeTab() === 'advanced') {
            <div class="advanced-tab">
              <div class="adv-section">
                <h4>Context Options</h4>
                <label class="adv-option">
                  <input type="checkbox" [checked]="includeSampleData()" (change)="includeSampleData.set(!includeSampleData())" />
                  Include sample data in context
                </label>
                <label class="adv-option">
                  <span>Max samples in context:</span>
                  <input type="number" class="num-input" [value]="maxSampleRows()" (input)="onMaxSamplesChange($event)" min="1" max="50" />
                </label>
                <label class="adv-option">
                  <span>Max unique values per column:</span>
                  <input type="number" class="num-input" [value]="maxUniqueValues()" (input)="onMaxUniqueChange($event)" min="5" max="100" />
                </label>
              </div>

              <div class="adv-section">
                <h4>Custom Instructions</h4>
                <p class="adv-hint">Add additional instructions for the AI. These will be appended to the analysis prompt.</p>
                <textarea
                  class="adv-textarea"
                  [value]="customInstructions()"
                  (input)="onCustomInstructionsChange($event)"
                  placeholder="e.g., Focus on human samples only. Suggest UBERON terms for organism parts. Be conservative with low-confidence suggestions."
                  rows="4"
                ></textarea>
              </div>

              <div class="adv-section">
                <h4>System Prompt Preview</h4>
                <p class="adv-hint">The base system prompt used for SDRF analysis. Read-only.</p>
                <details class="prompt-preview">
                  <summary>View system prompt</summary>
                  <pre class="prompt-content">{{ systemPromptPreview() }}</pre>
                </details>
              </div>

              <div class="adv-section">
                <h4>Debug</h4>
                <label class="adv-option">
                  <input type="checkbox" [checked]="showRawOutput()" (change)="showRawOutput.set(!showRawOutput())" />
                  Show raw LLM output
                </label>
                @if (result()?.rawResponse && showRawOutput()) {
                  <pre class="raw-output">{{ result()!.rawResponse }}</pre>
                }
              </div>
            </div>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .ai-panel {
      width: 100%;
      height: 100%;
      background: white;
      display: flex;
      flex-direction: column;
      font-size: 13px;
    }

    .panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: #5bc0be;
      color: white;
      flex-shrink: 0;
    }

    .header-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
    }

    .ai-icon { font-size: 16px; }

    .provider-tag {
      font-size: 10px;
      background: rgba(255,255,255,0.2);
      padding: 2px 8px;
      border-radius: 10px;
      font-weight: 400;
    }

    .header-actions {
      display: flex;
      gap: 4px;
    }

    .icon-btn {
      background: rgba(255,255,255,0.15);
      border: none;
      color: white;
      width: 28px;
      height: 28px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
    }
    .icon-btn:hover { background: rgba(255,255,255,0.25); }

    .empty-state {
      padding: 40px 20px;
      text-align: center;
      color: #6b7280;
    }

    .initializing-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 60px 20px;
      color: #6b7280;
      gap: 16px;
    }

    .initializing-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid #e5e7eb;
      border-top-color: #4aa9a7;
      border-radius: 50%;
      animation: init-spin 0.8s linear infinite;
    }

    @keyframes init-spin {
      to { transform: rotate(360deg); }
    }

    .initializing-state p {
      font-size: 14px;
      margin: 0;
    }

    .panel-tabs {
      display: flex;
      border-bottom: 1px solid #e5e7eb;
      flex-shrink: 0;
    }

    .tab {
      flex: 1;
      padding: 10px 12px;
      background: none;
      border: none;
      border-bottom: 2px solid transparent;
      cursor: pointer;
      font-size: 12px;
      color: #6b7280;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
    }
    .tab:hover { background: #f9fafb; }
    .tab.active {
      color: #5bc0be;
      border-bottom-color: #5bc0be;
      font-weight: 500;
    }

    .tab-badge {
      background: #5bc0be;
      color: white;
      font-size: 10px;
      padding: 1px 6px;
      border-radius: 10px;
    }

    .tab-badge-warn {
      background: #f59e0b;
    }

    .panel-content {
      flex: 1;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    /* Recommendations Tab */
    .recommendations-tab {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow: hidden;
    }

    .analysis-section {
      padding: 12px 16px;
      border-bottom: 1px solid #e5e7eb;
      flex-shrink: 0;
    }

    .focus-options {
      display: flex;
      gap: 12px;
      margin-bottom: 10px;
      flex-wrap: wrap;
    }

    .focus-option {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: #4b5563;
      cursor: pointer;
    }

    .error-msg {
      margin: 8px 16px;
      padding: 8px 12px;
      background: #fee2e2;
      color: #b91c1c;
      border-radius: 6px;
      font-size: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .dismiss-btn {
      background: none;
      border: none;
      cursor: pointer;
      font-size: 16px;
      color: inherit;
    }

    .stream-section {
      margin: 8px 16px;
      font-size: 11px;
    }

    .stream-section summary {
      cursor: pointer;
      color: #6b7280;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .stream-output {
      background: #1e1e1e;
      color: #d4d4d4;
      padding: 10px;
      border-radius: 6px;
      font-size: 10px;
      max-height: 150px;
      overflow: auto;
      margin-top: 6px;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .validation-errors-section {
      margin: 12px 16px;
      padding: 12px;
      background: #fef2f2;
      border: 2px solid #fecaca;
      border-radius: 8px;
    }

    .section-header-line {
      margin-bottom: 12px;
    }

    .section-title {
      font-size: 14px;
      font-weight: 600;
      margin: 0;
      color: #1f2937;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .error-count-badge {
      font-size: 11px;
      font-weight: 500;
      background: #fee2e2;
      color: #991b1b;
      padding: 2px 8px;
      border-radius: 10px;
    }

    .validation-errors-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .validation-error-item {
      display: flex;
      gap: 10px;
      padding: 10px;
      background: white;
      border: 1px solid #fecaca;
      border-radius: 6px;
      align-items: flex-start;
    }

    .validation-error-item.error-level-warning {
      background: #fffbeb;
      border-color: #fde68a;
    }

    .error-level-badge {
      font-size: 16px;
      flex-shrink: 0;
      width: 24px;
      text-align: center;
    }

    .error-content {
      flex: 1;
      min-width: 0;
    }

    .error-message {
      font-size: 13px;
      color: #1f2937;
      margin-bottom: 4px;
      font-weight: 500;
    }

    .error-location {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      font-size: 11px;
      color: #6b7280;
      margin-bottom: 4px;
    }

    .error-location span {
      background: #f3f4f6;
      padding: 2px 6px;
      border-radius: 3px;
    }

    .error-value {
      font-family: monospace;
      color: #991b1b;
    }

    .error-suggestion {
      font-size: 12px;
      color: #059669;
      margin-top: 4px;
      padding: 4px 8px;
      background: #d1fae5;
      border-radius: 4px;
    }

    .btn-jump {
      flex-shrink: 0;
      font-size: 11px;
    }

    .more-errors-notice {
      text-align: center;
      font-size: 12px;
      color: #6b7280;
      padding: 8px;
      background: white;
      border-radius: 4px;
    }

    .ai-recommendations-header {
      margin: 12px 16px 8px;
      padding-bottom: 8px;
      border-bottom: 2px solid #e5e7eb;
    }

    .ai-recommendations-header .section-title {
      margin-bottom: 4px;
    }

    .section-subtitle {
      font-size: 12px;
      color: #6b7280;
      margin: 0;
    }

    .results-section {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .results-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 16px;
      border-bottom: 1px solid #e5e7eb;
      flex-shrink: 0;
    }

    .results-count {
      font-size: 12px;
      color: #6b7280;
    }

    .sort-select {
      font-size: 11px;
      padding: 4px 8px;
      border: 1px solid #d1d5db;
      border-radius: 4px;
      background: white;
    }

    .filter-pills {
      display: flex;
      gap: 6px;
      padding: 8px 16px;
      border-bottom: 1px solid #e5e7eb;
      flex-shrink: 0;
      flex-wrap: wrap;
    }

    .pill {
      padding: 4px 10px;
      border: 1px solid #d1d5db;
      border-radius: 12px;
      background: white;
      font-size: 11px;
      cursor: pointer;
      color: #6b7280;
    }
    .pill:hover { background: #f3f4f6; }
    .pill.active {
      background: #5bc0be;
      color: white;
      border-color: #5bc0be;
    }

    .batch-actions {
      display: flex;
      gap: 8px;
      padding: 8px 16px;
      border-bottom: 1px solid #e5e7eb;
      flex-shrink: 0;
    }

    .recommendations-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px 12px;
    }

    .no-results {
      padding: 30px 20px;
      text-align: center;
      color: #9ca3af;
      font-size: 13px;
    }

    .rec-card {
      display: flex;
      background: white;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      margin-bottom: 8px;
      overflow: hidden;
    }
    .rec-card.applied { opacity: 0.5; }

    .rec-confidence-bar {
      width: 4px;
      flex-shrink: 0;
    }
    .rec-confidence-bar.conf-high { background: #22c55e; }
    .rec-confidence-bar.conf-medium { background: #f59e0b; }
    .rec-confidence-bar.conf-low { background: #9ca3af; }

    .rec-content {
      flex: 1;
      padding: 10px 12px;
    }

    .rec-header {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
      flex-wrap: wrap;
    }

    .rec-type-badge {
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      padding: 2px 6px;
      border-radius: 3px;
    }
    .type-fill_value { background: #dbeafe; color: #1d4ed8; }
    .type-correct_value { background: #fef3c7; color: #b45309; }
    .type-ontology_suggestion { background: #f3e8ff; color: #7c3aed; }
    .type-consistency_fix { background: #eafaf9; color: #17233d; }

    .rec-column-name {
      font-weight: 600;
      color: #374151;
      font-size: 12px;
    }

    .rec-confidence-badge {
      margin-left: auto;
      font-size: 9px;
      padding: 2px 6px;
      border-radius: 3px;
    }
    .conf-high { background: #d1fae5; color: #059669; }
    .conf-medium { background: #fef3c7; color: #d97706; }
    .conf-low { background: #f3f4f6; color: #6b7280; }

    .rec-change {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 4px;
      flex-wrap: wrap;
    }

    .old-val {
      color: #9ca3af;
      text-decoration: line-through;
      font-size: 11px;
    }

    .arrow { color: #6b7280; font-size: 10px; }

    .new-val {
      background: #d1fae5;
      color: #059669;
      padding: 2px 6px;
      border-radius: 3px;
      font-size: 11px;
      font-weight: 500;
    }

    .rec-meta {
      font-size: 10px;
      color: #9ca3af;
      margin-bottom: 4px;
    }

    .sample-list { opacity: 0.7; }

    .rec-reasoning {
      font-size: 11px;
      color: #6b7280;
      font-style: italic;
      background: #f9fafb;
      padding: 6px 8px;
      border-radius: 4px;
      margin-bottom: 8px;
      line-height: 1.4;
    }

    .rec-actions {
      display: flex;
      gap: 6px;
    }

    .applied-label {
      color: #059669;
      font-size: 11px;
      font-weight: 500;
    }

    /* Advanced Tab */
    .advanced-tab {
      padding: 16px;
      overflow-y: auto;
    }

    .adv-section {
      margin-bottom: 20px;
    }

    .adv-section h4 {
      margin: 0 0 10px 0;
      font-size: 12px;
      color: #374151;
    }

    .adv-hint {
      font-size: 11px;
      color: #9ca3af;
      margin: 0 0 8px 0;
    }

    .adv-option {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
      color: #4b5563;
      margin-bottom: 8px;
      cursor: pointer;
    }

    .num-input {
      width: 60px;
      padding: 4px 8px;
      border: 1px solid #d1d5db;
      border-radius: 4px;
      font-size: 12px;
    }

    .adv-textarea {
      width: 100%;
      padding: 10px;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      font-size: 12px;
      font-family: inherit;
      resize: vertical;
    }

    .prompt-preview summary {
      cursor: pointer;
      font-size: 11px;
      color: #5bc0be;
    }

    .prompt-content {
      background: #f9fafb;
      padding: 10px;
      border-radius: 6px;
      font-size: 10px;
      max-height: 200px;
      overflow: auto;
      margin-top: 8px;
      white-space: pre-wrap;
    }

    .raw-output {
      background: #1e1e1e;
      color: #d4d4d4;
      padding: 10px;
      border-radius: 6px;
      font-size: 10px;
      max-height: 200px;
      overflow: auto;
      margin-top: 8px;
      white-space: pre-wrap;
    }

    /* Buttons */
    .btn {
      padding: 8px 14px;
      border: 1px solid #d1d5db;
      border-radius: 6px;
      font-size: 12px;
      cursor: pointer;
      background: white;
      color: #374151;
      font-weight: 500;
    }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn:hover:not(:disabled) { background: #f3f4f6; }

    .btn-primary {
      background: #5bc0be;
      color: white;
      border: none;
    }
    .btn-primary:hover:not(:disabled) { opacity: 0.9; }

    .btn-block { width: 100%; }

    .btn-sm { padding: 5px 10px; font-size: 11px; }
    .btn-xs { padding: 4px 8px; font-size: 10px; }
    .btn-muted { color: #9ca3af; border-color: #e5e7eb; }

    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid rgba(255,255,255,0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    .spinner-sm {
      display: inline-block;
      width: 10px;
      height: 10px;
      border: 2px solid #d1d5db;
      border-top-color: #5bc0be;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    /* Quality Tab */
    .quality-tab {
      display: flex;
      flex-direction: column;
      height: 100%;
      overflow-y: auto;
    }

    .quality-actions {
      padding: 12px 16px;
      border-bottom: 1px solid #e5e7eb;
      flex-shrink: 0;
    }

    .quality-hint {
      margin: 8px 0 0 0;
      font-size: 11px;
      color: #9ca3af;
      text-align: center;
    }

    .quality-error {
      margin: 12px 16px;
      padding: 10px 12px;
      background: #fef2f2;
      border: 1px solid #fecaca;
      border-radius: 6px;
      color: #dc2626;
      font-size: 12px;
    }

    .quality-summary {
      padding: 12px 16px;
      border-bottom: 1px solid #e5e7eb;
      flex-shrink: 0;
    }

    .summary-stats {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
    }

    .stat {
      text-align: center;
      padding: 8px 12px;
      background: #f3f4f6;
      border-radius: 6px;
      min-width: 60px;
    }

    .stat-value {
      display: block;
      font-size: 18px;
      font-weight: 600;
      color: #374151;
    }

    .stat-label {
      font-size: 10px;
      color: #6b7280;
    }

    .stat-warn { background: #fef3c7; }
    .stat-warn .stat-value { color: #d97706; }

    .stat-error { background: #fee2e2; }
    .stat-error .stat-value { color: #dc2626; }

    .stat.hidden { display: none; }

    .fixes-section, .issues-section {
      padding: 12px 16px;
      border-bottom: 1px solid #e5e7eb;
    }

    .section-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 10px;
    }

    .section-header h4 {
      margin: 0;
      font-size: 12px;
      font-weight: 600;
      color: #374151;
    }

    .fixes-list, .issues-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .fix-card {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px;
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
    }

    .fix-card.fix-safe {
      border-left: 3px solid #22c55e;
    }

    .fix-icon {
      font-size: 14px;
      width: 24px;
      text-align: center;
      flex-shrink: 0;
    }

    .fix-content {
      flex: 1;
      min-width: 0;
    }

    .fix-desc {
      font-size: 12px;
      color: #374151;
      margin-bottom: 4px;
    }

    .fix-preview {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      margin-bottom: 4px;
    }

    .preview-item {
      font-size: 10px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }

    .prev-old {
      color: #9ca3af;
      text-decoration: line-through;
    }

    .prev-arrow { color: #6b7280; }

    .prev-new {
      color: #059669;
      background: #d1fae5;
      padding: 1px 4px;
      border-radius: 2px;
    }

    .preview-more {
      font-size: 10px;
      color: #9ca3af;
    }

    .fix-meta {
      font-size: 10px;
      color: #9ca3af;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .safe-badge {
      background: #d1fae5;
      color: #059669;
      padding: 1px 6px;
      border-radius: 8px;
      font-size: 9px;
    }

    .review-badge {
      background: #fef3c7;
      color: #d97706;
      padding: 1px 6px;
      border-radius: 8px;
      font-size: 9px;
    }

    .issue-card {
      padding: 10px 12px;
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      border-left: 3px solid #9ca3af;
    }

    .issue-card.action-remove { border-left-color: #dc2626; }
    .issue-card.action-review { border-left-color: #f59e0b; }

    .issue-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }

    .issue-col-name {
      font-size: 12px;
      font-weight: 600;
      color: #374151;
    }

    .action-badge {
      font-size: 9px;
      padding: 2px 6px;
      border-radius: 8px;
      text-transform: uppercase;
      font-weight: 500;
    }

    .badge-remove { background: #fee2e2; color: #dc2626; }
    .badge-review { background: #fef3c7; color: #d97706; }
    .badge-keep { background: #d1fae5; color: #059669; }

    .issue-reason {
      font-size: 11px;
      color: #6b7280;
      margin-bottom: 4px;
    }

    .issue-fix {
      font-size: 11px;
      color: #059669;
      background: #f0fdf4;
      padding: 4px 8px;
      border-radius: 4px;
      margin-bottom: 4px;
    }

    .issue-stats {
      display: flex;
      gap: 12px;
      font-size: 10px;
      color: #9ca3af;
    }

    .good-section {
      padding: 12px 16px;
    }

    .good-section summary {
      cursor: pointer;
      font-size: 12px;
      color: #059669;
      font-weight: 500;
    }

    .good-list {
      margin-top: 8px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .good-item {
      font-size: 11px;
      padding: 4px 8px;
      background: #f3f4f6;
      border-radius: 4px;
      color: #4b5563;
    }

    .empty-quality {
      padding: 30px 20px;
      text-align: center;
      color: #6b7280;
      font-size: 12px;
    }

    .quality-checks {
      text-align: left;
      margin: 16px auto;
      max-width: 250px;
      padding-left: 20px;
    }

    .quality-checks li {
      margin-bottom: 6px;
      font-size: 11px;
      color: #9ca3af;
    }

    .large-table-warning {
      background: #fef3c7;
      border: 1px solid #f59e0b;
      border-radius: 8px;
      padding: 16px;
      margin: 8px;
      text-align: left;
    }

    .large-table-warning p {
      margin: 0 0 8px 0;
      font-size: 12px;
      color: #92400e;
    }

    .large-table-warning p:last-child {
      margin-bottom: 0;
    }

    /* OLS Toggle */
    .ols-toggle {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px dashed #e5e7eb;
    }

    .ols-label {
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .ols-hint {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #e5e7eb;
      color: #6b7280;
      font-size: 9px;
      cursor: help;
    }

    /* OLS Stats Banner */
    .ols-stats-banner {
      display: flex;
      gap: 16px;
      padding: 8px 16px;
      background: linear-gradient(90deg, #e0f2fe, #f0fdf4);
      border-bottom: 1px solid #e5e7eb;
      flex-shrink: 0;
    }

    .ols-stat {
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: #4b5563;
    }

    .ols-stat .material-icons {
      font-size: 14px;
      color: #059669;
    }

    /* Actionable Suggestions List */
    .actionable-suggestions-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px 12px;
    }

    /* Empty state for suggestions */
    .empty-state-suggestions {
      padding: 40px 20px;
      text-align: center;
    }

    .empty-state-suggestions p {
      margin: 0 0 8px 0;
      color: #6b7280;
      font-size: 13px;
    }

    .empty-state-suggestions .hint {
      font-size: 11px;
      color: #9ca3af;
    }

    /* Success button */
    .btn-success {
      background: #059669;
      color: white;
      border-color: #059669;
    }

    .btn-success:hover {
      background: #047857;
    }

  `],
})
export class SdrfRecommendPanelComponent implements OnChanges, AfterViewInit {
  @Input() table: SdrfTable | null = null;

  /** Tracks whether the panel is still initializing */
  readonly isInitializing = signal(true);
  private hasInitialized = false;

  @Output() close = new EventEmitter<void>();
  @Output() openSettings = new EventEmitter<void>();
  @Output() applyRecommendation = new EventEmitter<ApplyRecommendationEvent>();
  @Output() batchApply = new EventEmitter<BatchApplyEvent>();
  @Output() previewRecommendation = new EventEmitter<SdrfRecommendation>();
  @Output() applyFix = new EventEmitter<ApplyFixEvent>();
  @Output() openChat = new EventEmitter<string>();

  // State
  readonly activeTab = signal<ViewTab>('quality');
  readonly analyzing = signal(false);
  readonly error = signal<string | null>(null);
  readonly result = signal<RecommendationResult | null>(null);
  readonly streamContent = signal<string>('');

  // Focus options
  readonly focusFillMissing = signal(true);
  readonly focusValidateOntology = signal(true);
  readonly focusCheckConsistency = signal(true);

  // Sort & Filter
  readonly sortBy = signal<SortOption>('confidence');
  readonly filterType = signal<RecommendationType | 'all'>('all');

  // Advanced options
  readonly includeSampleData = signal(true);
  readonly maxSampleRows = signal(10);
  readonly maxUniqueValues = signal(20);
  readonly customInstructions = signal('');
  readonly showRawOutput = signal(false);
  readonly examplesLoaded = signal(false);

  // Quality state
  readonly qualityResult = signal<TableQualityResult | null>(null);
  readonly qualityAnalyzing = signal(false);
  readonly availableFixes = signal<AutoFix[]>([]);

  // Pyodide validation state
  readonly pyodideValidating = signal(false);
  readonly pyodideErrors = signal<ValidationError[]>([]);
  readonly pyodideHasValidated = signal(false);
  readonly selectedTemplates = signal<string[]>(['ms-proteomics']);

  // Dismissed recommendations
  private dismissedIds = new Set<string>();

  // Services
  private recommendationService: RecommendationService;
  private settingsService: LlmSettingsService;
  private qualityService: ColumnQualityService;
  private cleaningService: DataCleaningService;
  private examplesService: SdrfExamplesService;
  private pyodideService: PyodideValidatorService;
  private aiWorker: AiWorkerService;
  private enrichmentService: SuggestionEnrichmentService;
  private suggestionState: SuggestionStateService;

  // Actionable Suggestions State
  readonly actionableResult = signal<ActionableRecommendationResult | null>(null);
  readonly actionableAnalyzing = signal(false);
  readonly enrichmentProgress = signal<string>('');
  readonly useActionableSuggestions = signal(true); // Toggle between old and new

  constructor() {
    // Initialize lightweight services synchronously
    this.recommendationService = recommendationService;
    this.settingsService = llmSettingsService;
    this.cleaningService = dataCleaningService;
    this.examplesService = sdrfExamplesService;
    this.pyodideService = pyodideValidatorService;
    this.enrichmentService = suggestionEnrichmentService;
    this.suggestionState = suggestionStateService;

    // Initialize heavier services lazily
    this.qualityService = null as unknown as ColumnQualityService;
    this.aiWorker = null as unknown as AiWorkerService;
  }

  ngAfterViewInit(): void {
    // Defer heavy initialization to after view is rendered
    // Use requestAnimationFrame to ensure UI is visible first
    requestAnimationFrame(() => {
      setTimeout(() => {
        this.initializePanel();
      }, 0);
    });
  }

  private async initializePanel(): Promise<void> {
    try {
      // Initialize heavier services
      this.qualityService = new ColumnQualityService();
      this.aiWorker = new AiWorkerService();

      // Load examples index in background (non-blocking)
      this.loadExamplesIndex();

      // Mark initialization as complete
      this.hasInitialized = true;
      this.isInitializing.set(false);

      // If table is available, trigger quality analysis for small tables
      if (this.table && this.table.sampleCount <= this.AUTO_ANALYZE_THRESHOLD) {
        // Small delay to ensure UI is responsive
        setTimeout(() => {
          this.analyzeQuality();
        }, 100);
      }
    } catch (err) {
      console.error('Error initializing AI panel:', err);
      this.isInitializing.set(false);
    }
  }

  private async loadExamplesIndex(): Promise<void> {
    try {
      await this.examplesService.loadIndex();
      this.examplesLoaded.set(true);
    } catch (err) {
      console.warn('Could not load SDRF examples index:', err);
    }
  }

  // Quality computed
  readonly qualityIssueCount = computed(() => {
    const q = this.qualityResult();
    if (!q) return 0;
    return q.summary.columnsWithIssues + q.summary.effectivelyEmptyColumns;
  });

  readonly columnsWithIssues = computed(() => {
    const q = this.qualityResult();
    if (!q) return [];
    return q.columns.filter(c => c.action !== 'keep');
  });

  readonly goodColumns = computed(() => {
    const q = this.qualityResult();
    if (!q) return [];
    return q.columns.filter(c => c.action === 'keep');
  });

  readonly safeFixes = computed(() => {
    return this.availableFixes().filter(f => f.isSafe);
  });

  // Pyodide computed
  readonly pyodideState = computed(() => this.pyodideService.state());
  readonly pyodideIsReady = computed(() => this.pyodideService.isReady());
  readonly pyodideIsLoading = computed(() => this.pyodideService.isLoading());
  readonly pyodideLoadProgress = computed(() => this.pyodideService.loadProgress());
  readonly pyodideAvailableTemplates = computed(() => this.pyodideService.availableTemplates());
  readonly pyodideErrorCount = computed(() => this.pyodideErrors().filter(e => e.level === 'error').length);
  readonly usingApiFallback = computed(() => this.pyodideService.usingApiFallback());
  readonly apiAvailable = computed(() => this.pyodideService.apiAvailable());
  readonly pyodideWarningCount = computed(() => this.pyodideErrors().filter(e => e.level === 'warning').length);
  readonly pyodideLastError = computed(() => this.pyodideService.lastError());

  // Computed
  readonly filteredRecommendations = computed(() => {
    const res = this.result();
    if (!res) return [];

    let recs = res.recommendations.filter(r => !this.dismissedIds.has(r.id));

    // Filter out recommendations where currentValue equals suggestedValue (no-op changes)
    recs = recs.filter(r => {
      const current = (r.currentValue || '').trim().toLowerCase();
      const suggested = (r.suggestedValue || '').trim().toLowerCase();
      return current !== suggested;
    });

    const typeFilter = this.filterType();
    if (typeFilter !== 'all') {
      recs = recs.filter(r => r.type === typeFilter);
    }

    return recs;
  });

  readonly sortedRecommendations = computed(() => {
    const recs = [...this.filteredRecommendations()];
    const sort = this.sortBy();

    recs.sort((a, b) => {
      switch (sort) {
        case 'confidence':
          const confOrder = { high: 0, medium: 1, low: 2 };
          return confOrder[a.confidence] - confOrder[b.confidence];
        case 'column':
          return a.column.localeCompare(b.column);
        case 'type':
          return a.type.localeCompare(b.type);
        case 'samples':
          return b.sampleIndices.length - a.sampleIndices.length;
        default:
          return 0;
      }
    });

    return recs;
  });

  readonly unappliedCount = computed(() =>
    this.filteredRecommendations().filter(r => !r.applied).length
  );

  readonly highConfidenceCount = computed(() =>
    this.filteredRecommendations().filter(r => !r.applied && r.confidence === 'high').length
  );

  // Actionable Suggestions Computed
  readonly pendingActionableSuggestions = computed(() => {
    const suggestions = this.suggestionState.pendingSuggestions();
    // Filter out suggestions where ALL current values equal the suggestedValue (no-op changes)
    return suggestions.filter(s => {
      const suggested = (s.suggestedValue || '').trim().toLowerCase();

      // If no current values are tracked, keep the suggestion (can't determine if it's a no-op)
      if (s.currentValues.size === 0) {
        return true;
      }

      // Check if any current value is different from the suggested value
      for (const [_, current] of s.currentValues) {
        if ((current || '').trim().toLowerCase() !== suggested) {
          return true; // Keep this suggestion - at least one value would change
        }
      }
      return false; // All values are the same - filter out this suggestion
    });
  });

  readonly actionableSuggestionCount = computed(() =>
    this.pendingActionableSuggestions().length
  );

  readonly olsValidatedCount = computed(() => {
    const result = this.actionableResult();
    return result?.olsValidatedCount || 0;
  });

  readonly olsMatchedCount = computed(() => {
    const result = this.actionableResult();
    return result?.olsMatchedCount || 0;
  });

  readonly systemPromptPreview = computed(() => {
    // Return a preview of the system prompt
    return `You are an expert in proteomics data annotation, specifically the SDRF format...

Key concepts:
- Reserved values: "not available", "not applicable", "anonymized", "pooled"
- Column types: source name, characteristics[...], factor value[...], comment[...]
- Ontology requirements per column type

Output: JSON with recommendations array containing type, column, suggestedValue, confidence, reasoning...`;
  });

  // Threshold for auto-analysis (skip for large tables to avoid browser freeze)
  private readonly AUTO_ANALYZE_THRESHOLD = 1000;

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['table']) {
      // Skip if not yet initialized (will be handled by initializePanel)
      if (!this.hasInitialized) {
        return;
      }

      // Skip reset if we're applying a fix (we'll re-analyze after)
      if (this.isApplyingFix()) {
        console.log('ngOnChanges: Skipping reset because fix is being applied');
        return;
      }

      console.log('ngOnChanges: Table changed, resetting state');

      this.result.set(null);
      this.error.set(null);
      this.streamContent.set('');
      this.dismissedIds.clear();

      // Reset quality state
      this.qualityResult.set(null);
      this.availableFixes.set([]);

      // Auto-analyze quality when table changes (but skip for large tables)
      if (this.table && this.table.sampleCount <= this.AUTO_ANALYZE_THRESHOLD) {
        // Defer to prevent UI blocking
        setTimeout(() => {
          this.analyzeQuality();
        }, 100);
      }
    }
  }

  /**
   * Returns true if the table is too large for auto-analysis.
   */
  isLargeTable(): boolean {
    return this.table ? this.table.sampleCount > this.AUTO_ANALYZE_THRESHOLD : false;
  }

  isConfigured(): boolean {
    return this.settingsService.isActiveProviderConfigured();
  }

  getActiveProviderName(): string {
    return getProviderDisplayName(this.settingsService.getActiveProvider());
  }

  toggleFocus(area: 'fill_missing' | 'validate_ontology' | 'check_consistency'): void {
    switch (area) {
      case 'fill_missing': this.focusFillMissing.set(!this.focusFillMissing()); break;
      case 'validate_ontology': this.focusValidateOntology.set(!this.focusValidateOntology()); break;
      case 'check_consistency': this.focusCheckConsistency.set(!this.focusCheckConsistency()); break;
    }
  }

  async analyze(): Promise<void> {
    if (!this.table || this.analyzing()) return;

    this.analyzing.set(true);
    this.error.set(null);
    this.streamContent.set('');
    this.result.set(null);
    this.dismissedIds.clear();

    const focusAreas: AnalysisFocusArea[] = [];
    if (this.focusFillMissing()) focusAreas.push('fill_missing');
    if (this.focusValidateOntology()) focusAreas.push('validate_ontology');
    if (this.focusCheckConsistency()) focusAreas.push('check_consistency');

    try {
      let finalResult: RecommendationResult | null = null;

      for await (const chunk of this.recommendationService.analyzeStreaming(
        this.table,
        focusAreas
      )) {
        if (typeof chunk === 'string') {
          this.streamContent.update(s => s + chunk);
        } else {
          finalResult = chunk;
        }
      }

      if (finalResult) {
        this.result.set(finalResult);
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      this.analyzing.set(false);
    }
  }

  clearError(): void {
    this.error.set(null);
  }

  // ============ Actionable Suggestions Methods ============

  /**
   * Analyzes using the new actionable suggestions system with OLS validation.
   * Includes validation errors from SDRF-pipelines validator in the AI prompt.
   */
  async analyzeActionable(): Promise<void> {
    if (!this.table || this.actionableAnalyzing()) return;

    this.actionableAnalyzing.set(true);
    this.error.set(null);
    this.streamContent.set('');
    this.enrichmentProgress.set('');
    this.actionableResult.set(null);

    const focusAreas: AnalysisFocusArea[] = [];
    if (this.focusFillMissing()) focusAreas.push('fill_missing');
    if (this.focusValidateOntology()) focusAreas.push('validate_ontology');
    if (this.focusCheckConsistency()) focusAreas.push('check_consistency');

    // Get validation errors to include in AI analysis
    const validatorErrors = this.pyodideErrors().map(e => ({
      message: e.message,
      level: e.level,
      row: e.row,
      column: e.column ?? undefined,
      value: e.value ?? undefined,
      suggestion: e.suggestion ?? undefined,
    }));

    try {
      for await (const progress of this.recommendationService.analyzeActionableStreaming(
        this.table,
        focusAreas,
        undefined, // template
        validatorErrors.length > 0 ? validatorErrors : undefined
      )) {
        if (progress.type === 'streaming') {
          this.streamContent.update(s => s + progress.content);
        } else if (progress.type === 'progress') {
          this.enrichmentProgress.set(progress.message);
        }
      }

      // Get final result from suggestion state
      const suggestions = this.suggestionState.pendingSuggestions();
      const result = this.actionableResult();

      if (!result && suggestions.length > 0) {
        // Build result from state
        this.actionableResult.set({
          suggestions,
          timestamp: new Date(),
          provider: this.settingsService.getActiveProvider(),
          model: this.settingsService.getProviderConfig(this.settingsService.getActiveProvider())?.model || '',
          olsValidatedCount: suggestions.filter(s => s.validation.olsValidated).length,
          olsMatchedCount: suggestions.filter(s => s.validation.olsMatch).length,
        });
      }
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Analysis failed');
    } finally {
      this.actionableAnalyzing.set(false);
      this.enrichmentProgress.set('');
    }
  }

  /**
   * Handles an action triggered from a suggestion card.
   */
  handleSuggestionAction(event: SuggestionActionEvent): void {
    const { suggestion, action } = event;

    switch (action.type) {
      case 'apply':
      case 'apply_ols':
        this.applyActionableSuggestion(suggestion);
        break;

      case 'preview':
        this.previewActionableSuggestion(suggestion);
        break;

      case 'dismiss':
        this.dismissActionableSuggestion(suggestion);
        break;

      case 'chat':
        this.explainSuggestion(suggestion);
        break;

      case 'alternatives':
        // Handled by card component
        break;
    }
  }

  /**
   * Opens chat with an explanation request for the suggestion.
   */
  explainSuggestion(suggestion: ActionableSuggestion): void {
    // Build the explanation prompt
    const prompt = this.enrichmentService.buildExplanationPrompt(suggestion);

    // Emit event to open chat with this prompt
    this.openChat.emit(prompt);
  }

  /**
   * Applies an actionable suggestion.
   */
  applyActionableSuggestion(suggestion: ActionableSuggestion): void {
    // Convert to SdrfRecommendation for backward compatibility
    const rec: SdrfRecommendation = {
      id: suggestion.id,
      type: suggestion.type as RecommendationType,
      column: suggestion.column,
      columnIndex: suggestion.columnIndex,
      sampleIndices: suggestion.affectedSamples,
      currentValue: this.getFirstValue(suggestion.currentValues),
      suggestedValue: suggestion.validation.olsMatch
        ? suggestion.validation.olsMatch.label
        : suggestion.suggestedValue,
      confidence: suggestion.confidence,
      reasoning: suggestion.reasoning,
      applied: true,
      ontologyId: suggestion.validation.olsMatch?.id || suggestion.ontologyId,
      ontologyLabel: suggestion.validation.olsMatch?.label || suggestion.ontologyLabel,
    };

    // Mark as applied in state
    this.suggestionState.markAsApplied(suggestion.id);

    // Emit the apply event
    this.applyRecommendation.emit({ recommendation: rec });
  }

  /**
   * Previews an actionable suggestion.
   */
  previewActionableSuggestion(suggestion: ActionableSuggestion): void {
    const rec: SdrfRecommendation = {
      id: suggestion.id,
      type: suggestion.type as RecommendationType,
      column: suggestion.column,
      columnIndex: suggestion.columnIndex,
      sampleIndices: suggestion.affectedSamples,
      currentValue: this.getFirstValue(suggestion.currentValues),
      suggestedValue: suggestion.suggestedValue,
      confidence: suggestion.confidence,
      reasoning: suggestion.reasoning,
      applied: false,
    };

    this.previewRecommendation.emit(rec);
  }

  /**
   * Dismisses an actionable suggestion.
   */
  dismissActionableSuggestion(suggestion: ActionableSuggestion): void {
    this.suggestionState.markAsDismissed(suggestion.id);
  }

  /**
   * Handles selection of an OLS alternative from a suggestion card.
   */
  handleAlternativeSelected(event: { suggestion: ActionableSuggestion; alternative: OntologySuggestion }): void {
    const { suggestion, alternative } = event;

    // Update the suggestion with the selected alternative
    this.suggestionState.updateSuggestionValue(
      suggestion.id,
      alternative.label,
      alternative.id,
      alternative.label
    );
  }

  /**
   * Applies all high-confidence actionable suggestions.
   */
  applyHighConfidenceActionable(): void {
    const highConf = this.suggestionState.highConfidenceSuggestions();
    for (const suggestion of highConf) {
      this.applyActionableSuggestion(suggestion);
    }
  }

  /**
   * Applies all OLS-validated actionable suggestions.
   */
  applyOlsValidatedActionable(): void {
    const validated = this.suggestionState.olsValidatedSuggestions();
    for (const suggestion of validated) {
      this.applyActionableSuggestion(suggestion);
    }
  }

  private getFirstValue(values: Map<number, string>): string {
    const iterator = values.values();
    const first = iterator.next();
    return first.done ? '' : first.value;
  }

  onSortChange(event: Event): void {
    this.sortBy.set((event.target as HTMLSelectElement).value as SortOption);
  }

  formatType(type: RecommendationType): string {
    const labels: Record<RecommendationType, string> = {
      fill_value: 'Fill',
      correct_value: 'Fix',
      ontology_suggestion: 'Ontology',
      consistency_fix: 'Consistency',
      add_column: 'Add Column',
    };
    return labels[type];
  }

  formatSamples(indices: number[]): string {
    if (indices.length <= 3) return indices.join(', ');
    return `${indices.slice(0, 3).join(', ')}...+${indices.length - 3}`;
  }

  onApplyClick(rec: SdrfRecommendation): void {
    rec.applied = true;
    this.applyRecommendation.emit({ recommendation: rec });
    // Force signal update to refresh counters
    this.result.update(r => r ? { ...r } : null);
  }

  onPreviewClick(rec: SdrfRecommendation): void {
    this.previewRecommendation.emit(rec);
  }

  dismissRecommendation(rec: SdrfRecommendation): void {
    this.dismissedIds.add(rec.id);
    // Trigger re-computation
    this.result.update(r => r ? { ...r } : null);
  }

  applyHighConfidence(): void {
    const highConf = this.filteredRecommendations().filter(r => !r.applied && r.confidence === 'high');
    for (const rec of highConf) rec.applied = true;
    this.batchApply.emit({ recommendations: highConf });
    // Force signal update to refresh counters
    this.result.update(r => r ? { ...r } : null);
  }

  applyAll(): void {
    const toApply = this.filteredRecommendations().filter(r => !r.applied);
    for (const rec of toApply) rec.applied = true;
    this.batchApply.emit({ recommendations: toApply });
    // Force signal update to refresh counters
    this.result.update(r => r ? { ...r } : null);
  }

  // Quality methods
  analyzeQuality(): void {
    if (!this.table) {
      console.warn('analyzeQuality: No table available');
      return;
    }
    if (this.qualityAnalyzing()) {
      console.warn('analyzeQuality: Already analyzing');
      return;
    }

    this.qualityAnalyzing.set(true);
    this.error.set(null);

    // Run quality analysis (synchronous but we use setTimeout to allow UI update)
    setTimeout(() => {
      try {
        const result = this.qualityService.analyzeTable(this.table!);
        this.qualityResult.set(result);

        // Detect available fixes
        const fixes = this.cleaningService.detectAvailableFixes(this.table!, result);
        this.availableFixes.set(fixes);
      } catch (err) {
        console.error('Quality analysis failed:', err);
        this.error.set(`Quality analysis failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
      } finally {
        this.qualityAnalyzing.set(false);
      }
    }, 10);
  }

  // Signal to track when a fix is being applied (for UI disabling and ngOnChanges skip)
  readonly isApplyingFix = signal(false);
  // Set of fix IDs currently being applied to prevent duplicate applications
  private fixesInProgress = new Set<string>();
  // Timestamp of last fix application to prevent rapid re-triggers
  private lastFixApplyTime = 0;

  logClick(fix: AutoFix): void {
    console.log('>>> BUTTON CLICKED <<<', fix.id, fix.type);
  }

  applyFixAction(fix: AutoFix): void {
    console.log('=== applyFixAction CALLED ===', fix.id, fix.description);
    const now = Date.now();
    const timeSinceLastFix = now - this.lastFixApplyTime;
    console.log('Time since last fix:', timeSinceLastFix, 'ms, isApplyingFix:', this.isApplyingFix(), 'fixesInProgress:', [...this.fixesInProgress]);

    // Aggressive debounce: prevent any fix application within 500ms of the last one
    if (timeSinceLastFix < 500) {
      console.warn('applyFixAction: Debounced (too soon after last fix)', timeSinceLastFix, 'ms');
      return;
    }

    if (!this.table) {
      console.warn('applyFixAction: No table available');
      return;
    }

    // Prevent duplicate applications of the same fix
    if (this.fixesInProgress.has(fix.id)) {
      console.warn('applyFixAction: Fix already in progress:', fix.id);
      return;
    }

    // Prevent applying while another fix is in progress
    if (this.isApplyingFix()) {
      console.warn('applyFixAction: Another fix is already being applied');
      return;
    }

    // Set all locks IMMEDIATELY before any other operations
    this.lastFixApplyTime = now;
    this.isApplyingFix.set(true);
    this.fixesInProgress.add(fix.id);

    console.log('Applying fix:', fix.id, fix.description);

    try {
      const { table: newTable, result } = this.cleaningService.applyFix(this.table, fix);

      console.log('Fix result:', result);

      if (result.success) {
        // Remove the applied fix from the list BEFORE emitting
        this.availableFixes.update(fixes => fixes.filter(f => f.id !== fix.id));

        // Emit the fix event with new table
        this.applyFix.emit({ table: newTable, fix, result });

        console.log('Fix applied successfully, changes:', result.changesCount);

        // Re-analyze quality after a delay to get updated fixes
        setTimeout(() => {
          this.isApplyingFix.set(false);
          this.fixesInProgress.delete(fix.id);
          if (this.table) {
            this.analyzeQuality();
          }
        }, 200);
      } else {
        console.warn('Fix was not successful:', result);
        this.error.set(`Fix failed: ${fix.description}`);
        this.isApplyingFix.set(false);
        this.fixesInProgress.delete(fix.id);
      }
    } catch (err) {
      console.error('Error applying fix:', err);
      this.error.set(`Error applying fix: ${err instanceof Error ? err.message : 'Unknown error'}`);
      this.isApplyingFix.set(false);
      this.fixesInProgress.delete(fix.id);
    }
  }

  applyAllSafeFixes(): void {
    const now = Date.now();

    // Aggressive debounce: prevent fix application within 500ms of the last one
    if (now - this.lastFixApplyTime < 500) {
      console.warn('applyAllSafeFixes: Debounced (too soon after last fix)');
      return;
    }

    if (!this.table) return;

    // Prevent applying while another fix is in progress
    if (this.isApplyingFix()) {
      console.warn('applyAllSafeFixes: Another fix is already being applied');
      return;
    }

    const safeFixes = this.safeFixes();
    if (safeFixes.length === 0) return;

    // Set all locks IMMEDIATELY
    this.lastFixApplyTime = now;
    this.isApplyingFix.set(true);

    console.log('Applying all safe fixes:', safeFixes.length);

    try {
      const { table: newTable, results } = this.cleaningService.applyFixes(this.table, safeFixes);

      const successCount = results.filter(r => r.success).length;
      console.log('Safe fixes applied:', successCount, 'of', safeFixes.length);

      if (successCount > 0) {
        // Clear applied fixes BEFORE emitting
        this.availableFixes.update(fixes =>
          fixes.filter(f => !safeFixes.some(sf => sf.id === f.id))
        );

        // Emit fix event for the combined result
        this.applyFix.emit({
          table: newTable,
          fix: safeFixes[0], // First fix for reference
          result: {
            success: true,
            changesCount: results.reduce((sum, r) => sum + r.changesCount, 0),
          }
        });

        // Re-analyze quality after a delay
        setTimeout(() => {
          this.isApplyingFix.set(false);
          if (this.table) {
            this.analyzeQuality();
          }
        }, 200);
      } else {
        this.isApplyingFix.set(false);
      }
    } catch (err) {
      console.error('Error applying safe fixes:', err);
      this.error.set(`Error applying fixes: ${err instanceof Error ? err.message : 'Unknown error'}`);
      this.isApplyingFix.set(false);
    }
  }

  // Pyodide validation methods
  async initPyodide(): Promise<void> {
    try {
      await this.pyodideService.initialize();

      const available = this.pyodideAvailableTemplates();
      if (available.length === 0) return;

      // Prefer auto-detected templates from table content; otherwise keep only valid names
      if (this.table) {
        const tsvContent = sdrfExport.exportToTsv(this.table);
        const detected = this.pyodideService.detectTemplates(tsvContent);
        const valid = detected.filter(t => available.includes(t));
        const fallback = available.includes('ms-proteomics') ? 'ms-proteomics' : available[0];
        this.selectedTemplates.set(valid.length > 0 ? valid : [fallback]);
      } else {
        const current = this.selectedTemplates().filter(t => available.includes(t));
        const fallback = available.includes('ms-proteomics') ? 'ms-proteomics' : available[0];
        this.selectedTemplates.set(current.length > 0 ? current : [fallback]);
      }
    } catch (err) {
      console.error('Failed to initialize Pyodide:', err);
    }
  }

  async runPyodideValidation(): Promise<void> {
    if (!this.table || this.pyodideValidating()) return;

    // Initialize Pyodide if not ready
    if (!this.pyodideIsReady()) {
      await this.initPyodide();
    }

    this.pyodideValidating.set(true);
    this.pyodideErrors.set([]);

    try {
      // Convert table to TSV
      const tsvContent = sdrfExport.exportToTsv(this.table);

      // Debug: Log the column state for any sdrf template columns
      const templateCol = this.table.columns.find(c => c.name.includes('sdrf template'));
      if (templateCol) {
        console.log(`[RecPanel Validate] Template column state: value="${templateCol.value}", modifiers=${JSON.stringify(templateCol.modifiers)}`);
        // Log first few lines of TSV to see actual exported values
        const lines = tsvContent.split('\n').slice(0, 3);
        console.log(`[RecPanel Validate] First 3 TSV lines:`, lines);
      }

      // Use only template names that exist in the loaded library/API list
      const available = this.pyodideAvailableTemplates();
      let templatesToUse = this.selectedTemplates().filter(t => available.includes(t));
      if (templatesToUse.length === 0 && available.length > 0) {
        const defaultTemplate = available.includes('ms-proteomics') ? 'ms-proteomics' : available[0];
        templatesToUse = [defaultTemplate];
        this.selectedTemplates.set(templatesToUse);
      }

      // Run validation
      const errors = await this.pyodideService.validate(
        tsvContent,
        templatesToUse,
        { skipOntology: true } // Skip ontology for speed
      );

      this.pyodideErrors.set(errors);

      // Auto-trigger AI analysis if errors found and LLM provider is configured
      if (errors.length > 0 && this.settingsService.isAnyProviderConfigured()) {
        // Small delay to ensure UI updates
        setTimeout(() => {
          this.analyzeActionable();
        }, 100);
      }
    } catch (err) {
      console.error('Pyodide validation failed:', err);
      this.pyodideErrors.set([{
        message: `Validation failed: ${err instanceof Error ? err.message : String(err)}`,
        row: -1,
        column: null,
        value: null,
        level: 'error',
        suggestion: null
      }]);
    } finally {
      this.pyodideValidating.set(false);
      this.pyodideHasValidated.set(true);
    }
  }

  toggleTemplate(template: string): void {
    const current = this.selectedTemplates();
    if (current.includes(template)) {
      this.selectedTemplates.set(current.filter(t => t !== template));
    } else {
      this.selectedTemplates.set([...current, template]);
    }
  }

  jumpToValidationError(error: ValidationError): void {
    if (error.row >= 0 && error.column) {
      // Emit event to parent to jump to cell
      // The row is 0-based from Python, but UI is 1-based
      const columnIndex = this.findColumnIndex(error.column);
      if (columnIndex >= 0) {
        // Create a recommendation to trigger preview
        const rec: SdrfRecommendation = {
          id: 'validation-' + Date.now(),
          type: 'fill_value',
          column: error.column,
          columnIndex,
          sampleIndices: [error.row + 1], // Convert to 1-based
          currentValue: error.value || '',
          suggestedValue: error.suggestion || '',
          confidence: 'high',
          reasoning: error.message,
          applied: false
        };
        this.previewRecommendation.emit(rec);
      }
    }
  }

  /**
   * Builds validation context for AI prompts.
   */
  buildValidationContext(): string {
    const errors = this.pyodideErrors();
    if (errors.length === 0) return '';

    const errorLines = errors.slice(0, 15).map(e => {
      const location = e.row >= 0 ? `Row ${e.row + 1}` : 'General';
      const col = e.column ? `, ${e.column}` : '';
      const val = e.value ? ` (value: "${e.value}")` : '';
      const sug = e.suggestion ? ` Fix: ${e.suggestion}` : '';
      return `- [${e.level.toUpperCase()}] ${location}${col}${val}: ${e.message}${sug}`;
    });

    return `\nSDRF-PIPELINES VALIDATION (${this.selectedTemplates().join(', ')}):
${errors.length} issues found (${this.pyodideErrorCount()} errors, ${this.pyodideWarningCount()} warnings)
${errorLines.join('\n')}
${errors.length > 15 ? `...and ${errors.length - 15} more` : ''}`;
  }

  /**
   * Finds the column index by name.
   */
  private findColumnIndex(columnName: string): number {
    if (!this.table) return -1;
    const normalizedName = columnName.toLowerCase().trim();
    return this.table.columns.findIndex(
      c => c.name.toLowerCase().trim() === normalizedName
    );
  }

  private buildTableContext(): string {
    if (!this.table) return 'No table loaded';

    const columns = this.table.columns;
    const sampleCount = this.table.sampleCount;

    let context = `## SDRF Table Summary\n`;
    context += `- **Samples:** ${sampleCount}\n`;
    context += `- **Columns:** ${columns.length}\n\n`;

    // Add column details with statistics
    context += `### Column Details\n\n`;

    for (const col of columns) {
      // Get all unique values for this column
      const values: string[] = [];
      for (let i = 1; i <= sampleCount; i++) {
        const val = getValueForSample(col, i);
        if (val) values.push(val);
      }

      const uniqueValues = [...new Set(values)];
      const emptyCount = sampleCount - values.filter(v => v && v.trim() !== '').length;
      const naCount = values.filter(v => v?.toLowerCase() === 'not available').length;

      context += `**${col.name}:**\n`;
      context += `- Unique values: ${uniqueValues.length}\n`;
      if (emptyCount > 0) context += `- Empty: ${emptyCount}\n`;
      if (naCount > 0) context += `- "not available": ${naCount}\n`;

      // Show sample values
      if (uniqueValues.length <= 8) {
        context += `- Values: ${uniqueValues.join(', ')}\n`;
      } else {
        context += `- Sample values: ${uniqueValues.slice(0, 5).join(', ')}... (${uniqueValues.length} total)\n`;
      }
      context += '\n';
    }

    // Add sample data (first 3 rows)
    context += `### Sample Data (first ${Math.min(3, sampleCount)} rows)\n\n`;
    context += '| Sample | ' + columns.slice(0, 6).map(c => c.name.replace(/characteristics\[|\]/g, '')).join(' | ') + ' |\n';
    context += '|' + '----|'.repeat(Math.min(7, columns.length + 1)) + '\n';

    for (let i = 1; i <= Math.min(3, sampleCount); i++) {
      const rowValues = columns.slice(0, 6).map(col => {
        const val = getValueForSample(col, i);
        // Truncate long values
        return val && val.length > 20 ? val.substring(0, 17) + '...' : (val || '');
      });
      context += `| ${i} | ${rowValues.join(' | ')} |\n`;
    }

    return context;
  }

  private buildQualityContext(): string {
    const q = this.qualityResult();
    if (!q) return 'Quality analysis not yet performed';

    const issues = this.columnsWithIssues();
    if (issues.length === 0) return 'No quality issues detected';

    return `Found ${issues.length} columns with issues:
${issues.slice(0, 5).map(i => `- ${i.name}: ${i.reason}`).join('\n')}
${issues.length > 5 ? `...and ${issues.length - 5} more` : ''}`;
  }

  /**
   * Builds example context from annotated datasets.
   */
  private buildExamplesContext(): string {
    if (!this.examplesLoaded() || !this.table) return '';

    // Detect organism for more relevant examples
    const organism = this.detectOrganism();

    // Get columns that could benefit from examples
    const relevantColumns = [
      'characteristics[disease]',
      'characteristics[organism part]',
      'characteristics[developmental stage]',
      'characteristics[sex]',
      'characteristics[cell line]',
      'characteristics[cell type]',
    ];

    // Filter to columns that exist in the table
    const tableColumnNames = this.table.columns.map(c => c.name.toLowerCase());
    const columnsToShow = relevantColumns.filter(col =>
      tableColumnNames.includes(col)
    );

    if (columnsToShow.length === 0) return '';

    return this.examplesService.getContextForColumns(columnsToShow, organism, 5);
  }

  /**
   * Detects the organism from the table data.
   */
  private detectOrganism(): string | undefined {
    if (!this.table) return undefined;

    const orgCol = this.table.columns.find(
      c => c.name.toLowerCase() === 'characteristics[organism]'
    );

    if (!orgCol) return undefined;

    // Get the most common organism value from the column
    // The column's default value is the most common value
    const defaultVal = orgCol.value?.toLowerCase().trim();
    if (defaultVal && defaultVal !== 'not available' && defaultVal !== 'not applicable') {
      return defaultVal;
    }

    // If default is not useful, check modifiers for the most common override
    const values: Record<string, number> = {};
    for (const modifier of orgCol.modifiers) {
      const val = modifier.value?.toLowerCase().trim();
      if (val && val !== 'not available' && val !== 'not applicable') {
        // Count the number of samples in this modifier's range
        const sampleCount = this.countSamplesInRange(modifier.samples);
        values[val] = (values[val] || 0) + sampleCount;
      }
    }

    const sorted = Object.entries(values).sort((a, b) => b[1] - a[1]);
    return sorted[0]?.[0];
  }

  /**
   * Counts the number of samples in a range string like "1-3,5,7-10".
   */
  private countSamplesInRange(rangeString: string): number {
    let count = 0;
    const parts = rangeString.split(',');

    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.includes('-')) {
        const [start, end] = trimmed.split('-').map(Number);
        if (!isNaN(start) && !isNaN(end)) {
          count += end - start + 1;
        }
      } else {
        const num = Number(trimmed);
        if (!isNaN(num)) {
          count += 1;
        }
      }
    }

    return count;
  }

  // Advanced options
  onMaxSamplesChange(event: Event): void {
    this.maxSampleRows.set(parseInt((event.target as HTMLInputElement).value) || 10);
  }

  onMaxUniqueChange(event: Event): void {
    this.maxUniqueValues.set(parseInt((event.target as HTMLInputElement).value) || 20);
  }

  onCustomInstructionsChange(event: Event): void {
    this.customInstructions.set((event.target as HTMLTextAreaElement).value);
  }
}
