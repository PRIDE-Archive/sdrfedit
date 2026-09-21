/**
 * SDRF Editor Component
 *
 * Main container component for the standalone SDRF editor.
 * Uses virtual scrolling for scalability with large files (10,000+ rows).
 */

import {
  Component,
  Input,
  Output,
  EventEmitter,
  OnInit,
  OnChanges,
  OnDestroy,
  SimpleChanges,
  signal,
  computed,
  ChangeDetectionStrategy,
  ElementRef,
  ViewChild,
  AfterViewInit,
  NgZone,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { SdrfTable } from '../../core/models/sdrf-table';
import { SdrfColumn, getValueForSample } from '../../core/models/sdrf-column';
import { ValidationResult } from '../../core/models/validation';
import { getSdrfColumnConfig } from '../../core/models/sdrf-config';
import { SdrfParserService, SdrfParseResult } from '../../core/services/sdrf-parser.service';
import { SdrfValidatorService } from '../../core/services/sdrf-validator.service';
import { SdrfExportService } from '../../core/services/sdrf-export.service';
import { setValueForSample } from '../../core/utils/modifier-utils';
import { SdrfCellEditorComponent } from '../sdrf-cell-editor/sdrf-cell-editor.component';
import { SdrfColumnStatsComponent, SelectByValueEvent, BulkEditEvent } from '../sdrf-column-stats/sdrf-column-stats.component';
import { SdrfBulkToolbarComponent, BulkColumnEditEvent } from '../sdrf-bulk-toolbar/sdrf-bulk-toolbar.component';
import { SdrfFilterBarComponent, FilterResult } from '../sdrf-filter-bar/sdrf-filter-bar.component';
import { SdrfRecommendPanelComponent, ApplyRecommendationEvent, BatchApplyEvent, ApplyFixEvent } from '../sdrf-recommend-panel/sdrf-recommend-panel.component';
import { LlmSettingsDialogComponent } from '../llm-settings/llm-settings-dialog.component';
import { SdrfWizardComponent } from '../sdrf-wizard/sdrf-wizard.component';
import { ColumnEditorPanelComponent, BulkEditEvent as ColumnBulkEditEvent } from '../column-editor-panel/column-editor-panel.component';
import { CacheRecoveryPanelComponent, RecoverCacheEvent } from '../cache-recovery-panel/cache-recovery-panel.component';
import { TableCacheService, tableCacheService } from '../../core/services/table-cache.service';
import { AssistantApiService } from '../../core/services/assistant/assistant-api.service';
import { llmSettingsService } from '../../core/services/llm/settings.service';
import { SdrfRecommendation } from '../../core/models/llm';
import {
  PyodideValidatorService,
  pyodideValidatorService,
  ValidationBackendMode,
  ValidationError,
} from '../../core/services/pyodide-validator.service';
import { sdrfExport } from '../../core/services/sdrf-export.service';

/**
 * Aggregated validation error - groups errors with the same message
 */
export interface AggregatedValidationError {
  message: string;
  level: 'error' | 'warning';
  column: string | null;
  cells: Array<{ row: number; value: string | null }>;
  suggestion: string | null;
}

/**
 * Cell selection state.
 */
export interface CellSelection {
  row: number;
  col: number;
}

/** Row height in pixels for virtual scrolling */
const ROW_HEIGHT = 32;

/** Number of rows to render outside visible area (buffer) */
const BUFFER_ROWS = 10;

@Component({
  selector: 'sdrf-editor-table',
  standalone: true,
  imports: [CommonModule, FormsModule, SdrfCellEditorComponent, SdrfColumnStatsComponent, SdrfBulkToolbarComponent, SdrfFilterBarComponent, SdrfRecommendPanelComponent, LlmSettingsDialogComponent, SdrfWizardComponent, ColumnEditorPanelComponent, CacheRecoveryPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sdrf-editor" [class.loading]="loading()">
      <!-- Collapsible Top Banner -->
      @if (table()) {
        <div class="top-banner" [class.collapsed]="bannerCollapsed()">
          @if (!bannerCollapsed()) {
            <div class="banner-content">
              <div class="banner-left">
                <h1 class="banner-title">SDRF Editor</h1>
              </div>
              <div class="banner-nav">
                <a href="https://sdrf.quantms.org/" target="_blank" class="nav-link">SDRF Project</a>
                <a href="https://sdrf.quantms.org/specification.html" target="_blank" class="nav-link">Specification</a>
              </div>
            </div>
          }
          <button class="banner-toggle" (click)="toggleBanner()" [title]="bannerCollapsed() ? 'Show banner' : 'Hide banner'">
            {{ bannerCollapsed() ? '▼' : '▲' }}
          </button>
        </div>
      }

      <!-- Hidden file input used by landing page -->
      <input
        type="file"
        #fileInput
        accept=".tsv,.txt,.sdrf"
        style="display: none"
        (change)="onFileSelected($event)"
      />

      <!-- Toolbar -->
      @if (table()) {
        <div class="sdrf-toolbar">
          <div class="toolbar-left">
            <button class="btn btn-secondary" (click)="exportTsv()">
              Export TSV
            </button>
            <button class="btn btn-secondary" (click)="validate()">
              Validate
            </button>
            @if (changeCount() > 0) {
              <span class="unsaved-indicator" title="{{ changeCount() }} unsaved change(s)">
                💾 {{ changeCount() }}
              </span>
            }
            <span class="toolbar-divider"></span>
            <button class="btn btn-secondary" (click)="addRowAtEnd()" title="Add a new row at the end">
              + Row
            </button>
            <button class="btn btn-secondary" (click)="showAddColumnDialog()" title="Add a new column">
              + Column
            </button>
            <span class="toolbar-divider"></span>
            <button
              class="btn"
              [class.btn-active]="showFilterBar()"
              (click)="toggleFilterBar()"
              title="Filter rows"
            >
              Filter
            </button>
            <button
              class="btn"
              [class.btn-active]="showStatsPanel()"
              (click)="toggleStatsPanel()"
              title="Show column statistics"
            >
              Stats
            </button>
          </div>

          <div class="toolbar-right">
            <div class="column-legend">
              <span class="legend-item source">Sample Accession</span>
              <span class="legend-item characteristic">Sample Properties</span>
              <span class="legend-item comment">Data Properties</span>
              <span class="legend-item factor">Factor Values</span>
            </div>
            <span class="table-info">
              {{ table()!.columns.length }} columns,
              {{ table()!.sampleCount }} samples
              @if (visibleRange()) {
                (showing {{ visibleRange()!.start }}-{{ visibleRange()!.end }})
              }
            </span>
            <button
              class="btn btn-ai btn-disabled"
              disabled
              title="AI Assistant - Coming soon"
            >
              AI Assistant
            </button>
          </div>
        </div>
      }

      <!-- Loading indicator -->
      @if (loading()) {
        <div class="loading-overlay">
          <div class="loading-spinner"></div>
          <span>{{ loadingMessage() }}</span>
        </div>
      }

      <!-- Error display -->
      @if (error()) {
        <div class="error-banner">
          <span>{{ error() }}</span>
          <button class="btn-close" (click)="clearError()">×</button>
        </div>
      }

      <!-- Bulk Edit Toolbar -->
      <sdrf-bulk-toolbar
        [table]="table()"
        [selectedCount]="selectedSamples().size"
        [selectedSamples]="selectedSamples()"
        [preselectedColumn]="selectedColumnForBulk()"
        (clearSelection)="clearSelection()"
        (bulkEdit)="onBulkColumnEdit($event)"
        (copyFromFirst)="onCopyFromFirst($event)"
      ></sdrf-bulk-toolbar>

      <!-- Filter Bar -->
      @if (table() && showFilterBar()) {
        <sdrf-filter-bar
          [table]="table()"
          (filterChange)="onFilterChange($event)"
        ></sdrf-filter-bar>
      }

      <!-- Main content -->
      @if (table()) {
        <div class="sdrf-content">
          <!-- Table and sidebar row -->
          <div class="table-row" [class.with-sidebar]="showStatsPanel()">
            <!-- Virtual scrolling table container -->
            <div
              class="sdrf-table-container"
              #scrollContainer
              (scroll)="onScroll($event)"
            >
              <!-- Single table with sticky header -->
              <div class="table-scroll-area" [style.height.px]="totalHeight() + 40">
                <table class="sdrf-table">
                  <!-- Column group to ensure consistent widths -->
                  <colgroup>
                    <col class="col-checkbox" />
                    <col class="col-rownum" />
                    @for (column of table()!.columns; track $index) {
                      <col class="col-data" />
                    }
                  </colgroup>
                  <thead>
                    <tr>
                      <th class="row-header checkbox-col">
                        <input
                          type="checkbox"
                          [checked]="isAllVisibleSelected()"
                          [indeterminate]="isSomeVisibleSelected()"
                          (change)="toggleSelectAllVisible()"
                          title="Select all visible rows"
                        />
                      </th>
                      <th class="row-header">#</th>
                      @for (column of table()!.columns; track $index; let colIdx = $index) {
                        <th
                          class="data-col"
                          [class.col-type-source]="getColumnTypeClass(column.name) === 'source'"
                          [class.col-type-characteristic]="getColumnTypeClass(column.name) === 'characteristic'"
                          [class.col-type-comment]="getColumnTypeClass(column.name) === 'comment'"
                          [class.col-type-factor]="getColumnTypeClass(column.name) === 'factor'"
                          [class.required]="column.isRequired"
                          [class.selected]="selectedCell()?.col === colIdx"
                          [class.sorted]="sortColumn() === colIdx"
                          [title]="getColumnTooltip(column.name)"
                          (click)="onHeaderClick(colIdx, $event)"
                        >
                          <div class="col-header-content">
                            <span class="col-name">{{ column.name }}</span>
                            @if (column.isRequired) {
                              <span class="required-marker">*</span>
                            }
                            @if (sortColumn() === colIdx) {
                              <span class="sort-indicator">{{ sortDirection() === 'asc' ? '▲' : '▼' }}</span>
                            }
                            <button
                              class="bulk-edit-btn"
                              (click)="openColumnEditor(colIdx); $event.stopPropagation()"
                              title="Bulk edit this column"
                            >
                              📝
                            </button>
                          </div>
                        </th>
                      }
                    </tr>
                  </thead>
                  <tbody>
                    <!-- Virtual scroll spacer - invisible row for scroll offset -->
                    @if (tableOffset() > 0) {
                      <tr class="virtual-spacer" [style.height.px]="tableOffset()">
                        <td [attr.colspan]="(table()?.columns?.length || 0) + 2"></td>
                      </tr>
                    }
                    @for (rowIndex of visibleRows(); track rowIndex) {
                      <tr
                        [class.selected]="selectedCell()?.row === rowIndex"
                        [class.row-selected]="isRowSelected(rowIndex)"
                        [style.height.px]="ROW_HEIGHT"
                      >
                        <td class="row-header checkbox-col">
                          <input
                            type="checkbox"
                            [checked]="isRowSelected(rowIndex)"
                            (change)="toggleRowSelection(rowIndex, $event)"
                            (click)="$event.stopPropagation()"
                          />
                        </td>
                        <td class="row-header" (click)="onRowHeaderClick(rowIndex, $event)">
                          {{ rowIndex }}
                        </td>
                        @for (column of table()!.columns; track $index; let colIdx = $index) {
                          <td
                            [class.selected]="isSelected(rowIndex, colIdx)"
                            [class.has-error]="hasCellError(rowIndex, colIdx)"
                            (click)="selectCell(rowIndex, colIdx)"
                            (dblclick)="startEditing(rowIndex, colIdx)"
                            (contextmenu)="onCellContextMenu($event, rowIndex, colIdx)"
                          >
                            <span
                              class="cell-value"
                              [class.reserved-value]="isReservedValue(getCellValue(rowIndex, colIdx))"
                              [class.reserved-not-available]="isReservedValueType(getCellValue(rowIndex, colIdx), 'not available')"
                              [class.reserved-not-applicable]="isReservedValueType(getCellValue(rowIndex, colIdx), 'not applicable')"
                              [class.reserved-anonymized]="isReservedValueType(getCellValue(rowIndex, colIdx), 'anonymized')"
                              [class.reserved-pooled]="isReservedValueType(getCellValue(rowIndex, colIdx), 'pooled')"
                            >
                              {{ getCellValue(rowIndex, colIdx) }}
                            </span>
                          </td>
                        }
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
            </div>

          <!-- Stats Panel Sidebar -->
          @if (showStatsPanel()) {
            <sdrf-column-stats
              [table]="table()"
              [selectedSamples]="selectedSamples()"
              (close)="toggleStatsPanel()"
              (selectByValue)="onSelectByValue($event)"
              (bulkEdit)="onStatsPanelBulkEdit($event)"
              (selectSamples)="onSelectSamples($event)"
            ></sdrf-column-stats>
          }
        </div>

          <!-- Jump to row control -->
          <div class="jump-to-row">
            <label>
              Go to row:
              <input
                type="number"
                min="1"
                [max]="table()!.sampleCount"
                [(ngModel)]="jumpToRowInput"
                (keydown.enter)="jumpToRow()"
                class="jump-input"
              />
            </label>
            <button class="btn btn-small" (click)="jumpToRow()">Go</button>
          </div>

          <!-- Validation Panel -->
          @if (showValidationPanel()) {
            <div class="validation-panel-container">
              <div class="validation-panel-header">
                <div class="validation-title">
                  <h3>SDRF Validation</h3>
                  @if (validationMode() === 'api' && pyodideState() === 'loading') {
                    <span class="pyodide-status loading">{{ pyodideLoadProgress() }}</span>
                  } @else if (validationMode() === 'api' && usingApiFallback()) {
                    <span class="pyodide-status api-fallback" title="Using EBI PRIDE SDRF Validator API">API</span>
                  } @else if (validationMode() === 'local' && pyodideState() === 'loading') {
                    <span class="pyodide-status loading">{{ pyodideLoadProgress() }}</span>
                  } @else if (validationMode() === 'local' && pyodideState() === 'ready') {
                    <span class="pyodide-status ready">Ready</span>
                  } @else if (pyodideState() === 'error') {
                    <span class="pyodide-status error">Error</span>
                  }
                </div>
                <button class="btn-close" (click)="closeValidationPanel()">×</button>
              </div>

              <div class="validation-panel-body">
                <div class="validation-backend-row">
                  <span class="template-label">Backend:</span>
                  <label class="backend-option" [class.selected]="validationMode() === 'api'">
                    <input
                      type="radio"
                      name="validation-backend"
                      [checked]="validationMode() === 'api'"
                      (change)="switchValidationMode('api')"
                    />
                    PRIDE API
                  </label>
                  <label class="backend-option" [class.selected]="validationMode() === 'local'">
                    <input
                      type="radio"
                      name="validation-backend"
                      [checked]="validationMode() === 'local'"
                      (change)="switchValidationMode('local')"
                    />
                    Local browser
                  </label>
                  <span class="validation-backend-hint">
                    @if (validationMode() === 'api') {
                      Sends the current SDRF to PRIDE's deployed validator service.
                    } @else {
                      Runs the local sdrf-pipelines validator in the browser and keeps the SDRF on this device.
                    }
                  </span>
                </div>

                <!-- Template Selector: only show templates from library/API when loaded -->
                <div class="template-selector-row">
                  <span class="template-label">Templates:</span>
                  @if (pyodideAvailableTemplates().length > 0) {
                    <div class="template-chips">
                      @for (template of pyodideAvailableTemplates(); track template) {
                        <label class="template-chip" [class.selected]="selectedTemplates().includes(template)">
                          <input
                            type="checkbox"
                            [checked]="selectedTemplates().includes(template)"
                            (change)="toggleTemplate(template)"
                          />
                          {{ template }}
                        </label>
                      }
                    </div>
                  } @else if (pyodideState() === 'loading') {
                    <span class="template-loading">Loading templates...</span>
                  } @else if (validationMode() === 'local' && pyodideState() === 'not-loaded') {
                    <span class="template-loading">Load the local validator to see templates</span>
                  } @else if (validationMode() === 'api' && !usingApiFallback()) {
                    <span class="template-loading">Connect to the PRIDE API to load templates</span>
                  } @else if (pyodideState() === 'error') {
                    <span class="template-loading">Templates unavailable</span>
                  } @else {
                    <span class="template-loading">No templates available</span>
                  }
                  <button
                    class="btn btn-primary btn-sm"
                    [disabled]="pyodideValidating() || selectedTemplates().length === 0"
                    (click)="runPyodideValidation()"
                  >
                    @if (pyodideValidating()) {
                      <span class="spinner-sm"></span> Validating...
                    } @else if (validationMode() === 'api') {
                      Validate via API
                    } @else if (pyodideState() === 'not-loaded') {
                      Load Local Validator & Validate
                    } @else {
                      Validate Locally
                    }
                  </button>
                </div>

                <!-- Results Summary -->
                @if (pyodideHasValidated() && !pyodideValidating()) {
                  <div class="validation-summary-row">
                    @if (pyodideErrorCount() === 0 && pyodideWarningCount() === 0) {
                      <span class="validation-success">✓ Validation passed - no issues found</span>
                    } @else {
                      @if (pyodideErrorCount() > 0) {
                        <span class="error-badge">{{ pyodideErrorCount() }} errors</span>
                      }
                      @if (pyodideWarningCount() > 0) {
                        <span class="warning-badge">{{ pyodideWarningCount() }} warnings</span>
                      }
                    }
                  </div>
                }

                <!-- Aggregated Errors List -->
                @if (aggregatedErrors().length > 0) {
                  <div class="validation-errors-list">
                    @for (error of aggregatedErrors(); track $index) {
                      <div class="validation-error-card" [class.level-error]="error.level === 'error'" [class.level-warning]="error.level === 'warning'">
                        <div class="error-main">
                          <span class="error-icon">{{ error.level === 'error' ? '❌' : '⚠️' }}</span>
                          <div class="error-content">
                            <div class="error-message">{{ error.message }}</div>
                            @if (error.column) {
                              <div class="error-column">Column: <strong>{{ error.column }}</strong></div>
                            }
                            @if (error.cells.length > 0) {
                              <div class="error-cells">
                                <span class="cells-label">Affected rows:</span>
                                <div class="cells-list">
                                  @for (cell of error.cells.slice(0, 8); track $index) {
                                    <button class="cell-link" (click)="jumpToValidationCell(cell.row, error.column)">
                                      {{ cell.row + 1 }}
                                    </button>
                                  }
                                  @if (error.cells.length > 8) {
                                    <span class="cells-more">+{{ error.cells.length - 8 }} more</span>
                                  }
                                </div>
                              </div>
                            }
                            @if (error.suggestion) {
                              <div class="error-suggestion">💡 {{ error.suggestion }}</div>
                            }
                          </div>
                          <button class="btn btn-ai-assist btn-disabled" disabled title="AI Assist - Coming soon">
                            AI Assist
                          </button>
                        </div>
                      </div>
                    }
                  </div>
                }

                <!-- Loading state -->
                @if (pyodideValidating()) {
                  <div class="validation-loading">
                    <span class="spinner"></span>
                    <span>Running validation...</span>
                  </div>
                }
              </div>
            </div>
          }

          <!-- Context Menu -->
          @if (contextMenu()) {
            <div
              class="context-menu"
              [style.top.px]="contextMenu()!.y"
              [style.left.px]="contextMenu()!.x"
            >
              <button (click)="selectAllWithSameValue()">
                Select all with same value
              </button>
              <button (click)="selectAllInColumn()">
                Select all in this column
              </button>
              <hr />
              <button (click)="editSelectedCells()">
                Edit selected cells
              </button>
              <button (click)="clearSelectedCells()">
                Clear selected cells
              </button>
              <hr />
              <button (click)="insertRowAbove()">
                Insert row above
              </button>
              <button (click)="insertRowBelow()">
                Insert row below
              </button>
              <button (click)="deleteSelectedRows()">
                Delete selected rows
              </button>
              <hr />
              <button (click)="showAddColumnDialog()">
                Add column...
              </button>
              <button (click)="deleteColumn()">
                Delete this column
              </button>
              <hr />
              <button (click)="closeContextMenu()">
                Cancel
              </button>
            </div>
          }

          <!-- Add Column Dialog -->
          @if (showAddColumnDialogFlag()) {
            <div class="dialog-backdrop" (click)="closeAddColumnDialog()">
              <div class="dialog-content" (click)="$event.stopPropagation()">
                <h3>Add New Column</h3>
                <div class="dialog-form">
                  <label>Column Name:</label>
                  <input
                    type="text"
                    [value]="newColumnName()"
                    (input)="newColumnName.set($any($event.target).value)"
                    placeholder="e.g., characteristics[tissue], comment[notes]"
                    (keydown.enter)="addNewColumn()"
                    #newColInput
                  />
                  <p class="dialog-hint">
                    Use SDRF format: characteristics[name], comment[name], factor value[name]
                  </p>
                </div>
                <div class="dialog-actions">
                  <button class="btn btn-primary" (click)="addNewColumn()" [disabled]="!newColumnName().trim()">
                    Add Column
                  </button>
                  <button class="btn" (click)="closeAddColumnDialog()">
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          }

        </div>

        <!-- AI Recommend Panel - Slide-in from right -->
        <div class="ai-panel-container" [class.open]="showRecommendPanel()">
          <div class="ai-panel-backdrop" (click)="toggleRecommendPanel()"></div>
          <div class="ai-panel-wrapper">
            <sdrf-recommend-panel
              [table]="table()"
              (close)="toggleRecommendPanel()"
              (openSettings)="openLlmSettings()"
              (applyRecommendation)="onApplyRecommendation($event)"
              (batchApply)="onBatchApplyRecommendations($event)"
              (previewRecommendation)="onPreviewRecommendation($event)"
              (applyFix)="onApplyFix($event)"
              (openChat)="onOpenChat($event)"
            ></sdrf-recommend-panel>
          </div>
        </div>

        <!-- Column Editor Panel - Slide-in from right -->
        <column-editor-panel
          [isOpen]="showColumnEditor"
          [table]="table"
          [columnIndex]="columnEditorIndex"
          (close)="closeColumnEditor()"
          (applyBulkEdit)="onBulkEditColumn($event)"
        ></column-editor-panel>
      } @else if (!loading() && !error()) {
        <!-- Enhanced Landing Page -->
        <div class="landing-page">
          <div class="landing-header">
            <h1>SDRF Editor</h1>
            <p class="tagline">Sample and Data Relationship Format editor for proteomics metadata</p>
          </div>

          <div class="landing-actions">
            <button class="btn btn-create btn-large" (click)="openWizard()">
              ✨ Create New SDRF
            </button>
            <button class="btn btn-primary btn-large" (click)="fileInput.click()">
              📂 Import SDRF File
            </button>
            <input
              type="text"
              [(ngModel)]="loadUrlValue"
              placeholder="Enter SDRF URL..."
              class="url-input"
              (keydown.enter)="onLoadUrlClick()"
            />
            <button class="btn btn-secondary" (click)="onLoadUrlClick()">Load URL</button>
            <button class="btn btn-secondary" (click)="onLoadExampleClick()">Load Example</button>
          </div>

          <div class="landing-content">
            <div class="info-section">
              <h2>What is SDRF?</h2>
              <p>
                The Sample and Data Relationship Format (SDRF) is a standardized format for annotating
                proteomics experiments. It captures the relationships between samples, experimental design,
                and data files in a structured, machine-readable way.
              </p>
              <p>
                SDRF is part of the HUPO Proteomics Standards Initiative (PSI) and is widely used for
                submitting proteomics data to public repositories like PRIDE and ProteomeXchange.
              </p>
            </div>

            <div class="info-section">
              <h2>Getting Started</h2>
              <ul class="feature-list">
                <li><strong>Import:</strong> Load an existing SDRF file (.tsv) from your computer</li>
                <li><strong>Create:</strong> Build a new SDRF from scratch using our guided wizard</li>
                <li><strong>Edit:</strong> Modify metadata with intelligent autocomplete and validation</li>
                <li><strong>Validate:</strong> Check your SDRF against the official specification</li>
                <li><strong>AI Assist:</strong> Get smart suggestions for filling and fixing metadata</li>
              </ul>
            </div>

            <div class="info-section">
              <h2>Resources</h2>
              <div class="resource-links">
                <a href="https://sdrf.quantms.org/" target="_blank" class="resource-link">
                  <span class="link-icon">🏠</span>
                  <div>
                    <div class="link-title">SDRF Project</div>
                    <div class="link-desc">Official SDRF documentation and examples</div>
                  </div>
                </a>
                <a href="https://sdrf.quantms.org/specification.html" target="_blank" class="resource-link">
                  <span class="link-icon">📋</span>
                  <div>
                    <div class="link-title">Specification</div>
                    <div class="link-desc">Detailed format specification and rules</div>
                  </div>
                </a>
                <a href="https://github.com/bigbio/proteomics-metadata-standard" target="_blank" class="resource-link">
                  <span class="link-icon">💻</span>
                  <div>
                    <div class="link-title">GitHub Repository</div>
                    <div class="link-desc">Source code, examples, and issue tracker</div>
                  </div>
                </a>
              </div>
            </div>
          </div>

          <div class="landing-footer">
            <p class="footer-text">Supported by the proteomics community</p>
            <div class="partner-logos">
              <a href="https://eubic-ms.org/" target="_blank" class="partner-logo" title="EuBIC-MS">
                <img [src]="eubicLogoUrl" alt="EuBIC-MS Logo" class="logo-image">
              </a>
              <a href="https://psidev.info/" target="_blank" class="partner-logo" title="HUPO-PSI">
                <img [src]="psiLogoUrl" alt="HUPO-PSI Logo" class="logo-image">
              </a>
              <a href="https://quantms.org/" target="_blank" class="partner-logo" title="QuantMS">
                <img [src]="quantmsLogoUrl" alt="QuantMS Logo" class="logo-image">
              </a>
            </div>
          </div>
        </div>
      }

      <!-- Cell editor popup (fixed position, stays in viewport) -->
      @if (editingCell() && editingColumn()) {
        <div
          class="cell-editor-popup"
          [style.top.px]="editorPosition().top"
          [style.left.px]="editorPosition().left"
        >
          <div class="cell-editor-context">
            <span class="context-info">
              Editing Row <strong>{{ editingCell()!.row }}</strong>,
              Column: <strong>{{ editingColumn()!.name }}</strong>
            </span>
            <button class="btn-close" (click)="cancelEditing()" title="Close">×</button>
          </div>
          <sdrf-cell-editor
            [value]="getCellValue(editingCell()!.row, editingCell()!.col)"
            [column]="editingColumn()!"
            [rowIndex]="editingCell()!.row"
            (save)="onCellEditorSave($event)"
            (cancel)="cancelEditing()"
          ></sdrf-cell-editor>
        </div>
      }

      <!-- LLM Settings Dialog -->
      @if (showLlmSettingsDialog()) {
        <llm-settings-dialog
          (close)="closeLlmSettings()"
          (settingsSaved)="onLlmSettingsSaved()"
        ></llm-settings-dialog>
      }

      <!-- SDRF Creation Wizard -->
      @if (showWizard()) {
        <sdrf-wizard
          [aiEnabled]="isAiConfigured()"
          [availableTemplates]="availableWizardTemplates"
          (complete)="onWizardComplete($event)"
          (cancel)="closeWizard()"
        />
      }

      <!-- Cache Recovery Panel -->
      @if (showCacheRecovery()) {
        <cache-recovery-panel
          (recover)="onRecoverCache($event)"
          (dismiss)="dismissCacheRecovery()"
        ></cache-recovery-panel>
      }
    </div>
  `,
  styles: [`
    :host {
      display: block;
      height: 100%;
      overflow: hidden;
    }

    .sdrf-editor {
      display: flex;
      flex-direction: column;
      height: 100%;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      font-size: 14px;
      overflow: hidden;
    }

    /* Ensure child components don't expand beyond their content */
    sdrf-bulk-toolbar,
    sdrf-filter-bar {
      display: block;
      flex-shrink: 0;
    }

    /* Top Banner Styles */
    .top-banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: linear-gradient(135deg, #5bc0be 0%, #4aa9a7 100%);
      color: white;
      padding: 16px 24px;
      border-bottom: 3px solid #5a67d8;
      flex-shrink: 0;
      transition: all 0.3s ease;
    }

    .top-banner.collapsed {
      padding: 8px 24px;
    }

    .banner-content {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex: 1;
      gap: 24px;
    }

    .banner-left {
      flex: 1;
    }

    .banner-title {
      margin: 0;
      font-size: 20px;
      font-weight: 600;
    }

    .banner-subtitle {
      margin: 4px 0 0 0;
      font-size: 13px;
      opacity: 0.9;
    }

    .banner-nav {
      display: flex;
      gap: 16px;
    }

    .nav-link {
      color: white;
      text-decoration: none;
      font-size: 13px;
      font-weight: 500;
      padding: 6px 12px;
      border-radius: 4px;
      background: rgba(255, 255, 255, 0.15);
      transition: all 0.2s;
    }

    .nav-link:hover {
      background: rgba(255, 255, 255, 0.25);
      transform: translateY(-1px);
    }

    .banner-toggle {
      background: rgba(255, 255, 255, 0.2);
      border: none;
      color: white;
      padding: 4px 12px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      transition: all 0.2s;
      margin-left: 12px;
    }

    .banner-toggle:hover {
      background: rgba(255, 255, 255, 0.3);
    }

    /* Landing Page Styles */
    .landing-page {
      flex: 1;
      overflow-y: auto;
      background: linear-gradient(135deg, #5bc0be 0%, #4aa9a7 100%);
      color: white;
      display: flex;
      flex-direction: column;
    }

    .landing-header {
      text-align: center;
      padding: 60px 40px 40px;
    }

    .landing-header h1 {
      font-size: 48px;
      margin: 0 0 16px 0;
      font-weight: 700;
      text-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
    }

    .tagline {
      font-size: 18px;
      margin: 0;
      opacity: 0.95;
    }

    .landing-actions {
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 0 40px 40px;
    }

    .landing-actions .url-input {
      padding: 10px 14px;
      border: 1px solid rgba(255, 255, 255, 0.5);
      border-radius: 6px;
      font-size: 14px;
      min-width: 280px;
      background: rgba(255, 255, 255, 0.15);
      color: white;
    }

    .landing-actions .url-input::placeholder {
      color: rgba(255, 255, 255, 0.7);
    }

    .btn-large {
      padding: 14px 32px;
      font-size: 16px;
      font-weight: 600;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      transition: all 0.2s;
    }

    .btn-large:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.2);
    }

    .landing-content {
      flex: 1;
      background: white;
      color: #1f2937;
      border-radius: 24px 24px 0 0;
      padding: 48px 40px;
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 40px;
      max-width: 1200px;
      margin: 0 auto;
      width: 100%;
    }

    .info-section h2 {
      font-size: 22px;
      margin: 0 0 16px 0;
      color: #5bc0be;
      font-weight: 600;
    }

    .info-section p {
      margin: 0 0 12px 0;
      line-height: 1.6;
      color: #4b5563;
    }

    .feature-list {
      margin: 0;
      padding-left: 20px;
      line-height: 1.8;
    }

    .feature-list li {
      margin-bottom: 8px;
      color: #4b5563;
    }

    .feature-list strong {
      color: #1f2937;
    }

    .resource-links {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .resource-link {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 16px;
      background: #f9fafb;
      border: 2px solid #e5e7eb;
      border-radius: 8px;
      text-decoration: none;
      transition: all 0.2s;
    }

    .resource-link:hover {
      border-color: #5bc0be;
      background: #f3f4f6;
      transform: translateX(4px);
    }

    .link-icon {
      font-size: 28px;
      flex-shrink: 0;
    }

    .link-title {
      font-weight: 600;
      color: #1f2937;
      margin-bottom: 2px;
    }

    .link-desc {
      font-size: 12px;
      color: #6b7280;
    }

    .landing-footer {
      background: white;
      padding: 32px 40px;
      text-align: center;
      border-top: 2px solid #e5e7eb;
    }

    .footer-text {
      margin: 0 0 16px 0;
      color: #6b7280;
      font-size: 14px;
    }

    .partner-logos {
      display: flex;
      justify-content: center;
      align-items: center;
      gap: 48px;
      flex-wrap: wrap;
    }

    .partner-logo {
      text-decoration: none;
      transition: all 0.3s;
      display: block;
    }

    .partner-logo:hover {
      transform: translateY(-4px);
    }

    .logo-image {
      height: 60px;
      width: auto;
      object-fit: contain;
      filter: grayscale(20%);
      transition: filter 0.3s;
    }

    .logo-image:hover {
      filter: grayscale(0%);
    }

    .sdrf-toolbar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 16px;
      background: #f5f5f5;
      border-bottom: 1px solid #ddd;
      gap: 8px;
      flex-shrink: 0;
    }

    .toolbar-left, .toolbar-right {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .btn {
      padding: 6px 12px;
      border: 1px solid #ccc;
      border-radius: 4px;
      background: white;
      cursor: pointer;
      font-size: 13px;
    }

    .btn:hover {
      background: #f0f0f0;
    }

    .btn-primary {
      background: #0066cc;
      color: white;
      border-color: #0066cc;
    }

    .btn-primary:hover {
      background: #0055aa;
    }

    .btn-secondary {
      background: #6c757d;
      color: white;
      border-color: #6c757d;
    }

    .btn-secondary:hover {
      background: #5a6268;
    }

    .btn-create {
      background: #10b981;
      color: white;
      border-color: #10b981;
    }

    .btn-create:hover {
      background: #059669;
    }

    .btn-small {
      padding: 4px 8px;
      font-size: 12px;
    }

    .table-info {
      color: #666;
      font-size: 12px;
    }

    .column-legend {
      display: flex;
      gap: 8px;
      margin-right: 16px;
      padding-right: 16px;
      border-right: 1px solid #ddd;
    }

    .legend-item {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 3px;
      border-left: 3px solid;
    }

    .legend-item.source {
      border-left-color: #4caf50;
      background: rgba(76, 175, 80, 0.1);
    }

    .legend-item.characteristic {
      border-left-color: #2196f3;
      background: rgba(33, 150, 243, 0.1);
    }

    .legend-item.comment {
      border-left-color: #9e9e9e;
      background: rgba(158, 158, 158, 0.1);
    }

    .legend-item.factor {
      border-left-color: #ff9800;
      background: rgba(255, 152, 0, 0.1);
    }

    .loading-overlay {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 40px;
      color: #666;
      flex: 1;
    }

    .loading-spinner {
      width: 32px;
      height: 32px;
      border: 3px solid #f3f3f3;
      border-top: 3px solid #0066cc;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin-bottom: 12px;
    }

    @keyframes spin {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }

    .error-banner {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: #fee2e2;
      color: #b91c1c;
      border-bottom: 1px solid #fca5a5;
      flex-shrink: 0;
    }

    .btn-close {
      background: none;
      border: none;
      font-size: 20px;
      cursor: pointer;
      padding: 0 4px;
    }

    .sdrf-content {
      display: flex;
      flex-direction: column;
      flex: 1;
      overflow: hidden;
      min-height: 0;
    }

    .table-row {
      display: flex;
      flex-direction: column;
      flex: 1;
      overflow: hidden;
      min-height: 0;
    }

    .table-row.with-sidebar {
      flex-direction: row;
    }

    .table-row.with-sidebar .sdrf-table-container {
      flex: 1;
      min-width: 0;
    }

    .table-row.with-sidebar sdrf-column-stats {
      flex-shrink: 0;
    }

    .sdrf-table-container {
      flex: 1;
      overflow: auto;
      position: relative;
      min-height: 0;
      /* Ensure scrollbars are always visible when content overflows */
      overflow-y: scroll;
      overflow-x: auto;
    }

    /* Custom scrollbar styling for the table container */
    .sdrf-table-container::-webkit-scrollbar {
      width: 12px;
      height: 12px;
    }

    .sdrf-table-container::-webkit-scrollbar-track {
      background: #f1f1f1;
      border-radius: 6px;
    }

    .sdrf-table-container::-webkit-scrollbar-thumb {
      background: #c1c1c1;
      border-radius: 6px;
      border: 2px solid #f1f1f1;
    }

    .sdrf-table-container::-webkit-scrollbar-thumb:hover {
      background: #a1a1a1;
    }

    /* Firefox scrollbar styling */
    .sdrf-table-container {
      scrollbar-width: auto;
      scrollbar-color: #c1c1c1 #f1f1f1;
    }

    .table-scroll-area {
      position: relative;
      width: fit-content;
      min-width: 100%;
    }

    .sdrf-table {
      /* Use separate borders for Firefox sticky header compatibility */
      border-collapse: separate;
      border-spacing: 0;
      font-size: 13px;
      table-layout: auto;
      width: max-content;
      min-width: 100%;
    }

    /* Colgroup for consistent column widths */
    .sdrf-table colgroup .col-checkbox {
      width: 36px;
      min-width: 36px;
    }

    .sdrf-table colgroup .col-rownum {
      width: 60px;
      min-width: 60px;
    }

    .sdrf-table colgroup .col-data {
      min-width: 120px;
    }

    /* Sticky header */
    .sdrf-table thead {
      position: sticky;
      top: 0;
      z-index: 10;
    }

    .sdrf-table thead tr {
      background: #f8f9fa;
    }

    .sdrf-table thead th {
      background: #f8f9fa;
    }

    /* Virtual scroll spacer row - invisible placeholder for scroll offset */
    .sdrf-table .virtual-spacer {
      height: 0;
      padding: 0 !important;
      border: none !important;
      line-height: 0;
      font-size: 0;
      visibility: hidden;
    }

    .sdrf-table .virtual-spacer td {
      padding: 0 !important;
      border: none !important;
      height: inherit;
      line-height: 0;
    }

    .sdrf-table th,
    .sdrf-table td {
      /* Use border-left and border-bottom only to avoid double borders with border-collapse: separate */
      border-left: 1px solid #ddd;
      border-bottom: 1px solid #ddd;
      padding: 6px 8px;
      text-align: left;
      white-space: nowrap;
      min-width: 100px;
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      height: 32px;
      box-sizing: border-box;
    }

    /* First column needs left border */
    .sdrf-table th:first-child,
    .sdrf-table td:first-child {
      border-left: 1px solid #ddd;
    }

    /* Last column needs right border */
    .sdrf-table th:last-child,
    .sdrf-table td:last-child {
      border-right: 1px solid #ddd;
    }

    /* Header row needs top border */
    .sdrf-table thead th {
      border-top: 1px solid #ddd;
    }

    .sdrf-table th {
      background: #f8f9fa;
      font-weight: 600;
      /* Firefox sticky header border fix - use box-shadow for bottom edge */
      box-shadow: inset 0 -1px 0 #ddd;
    }

    .sdrf-table th.required {
      background: #fff3cd !important;
    }

    .sdrf-table th.selected {
      background: #e3f2fd !important;
      outline: 2px solid #2196f3;
      outline-offset: -2px;
    }

    .sdrf-table th.sorted {
      background: #e3f2fd !important;
    }

    .required-marker {
      color: #dc3545;
      margin-left: 2px;
    }

    .row-header {
      background: #f8f9fa;
      font-weight: 500;
      text-align: center;
      width: 60px;
      min-width: 60px;
      max-width: 60px;
      position: sticky;
      left: 0;
      z-index: 5;
    }

    .sdrf-table thead .row-header {
      z-index: 15;
      background: #f8f9fa;
    }

    .checkbox-col {
      width: 32px;
      min-width: 32px;
      max-width: 32px;
      text-align: center;
      padding: 4px !important;
    }

    .checkbox-col input[type="checkbox"] {
      margin: 0;
      cursor: pointer;
    }

    .sdrf-table td.selected,
    .sdrf-table th.selected {
      background: #e3f2fd;
      outline: 2px solid #2196f3;
      outline-offset: -2px;
    }

    .sdrf-table td.has-error {
      background: #ffebee;
    }

    .cell-value {
      display: block;
      min-height: 1em;
    }

    /* Reserved value styling - muted appearance to indicate valid but placeholder values */
    .cell-value.reserved-value {
      color: #9e9e9e;
      font-style: italic;
    }

    /* Specific reserved value types with visible background */
    .cell-value.reserved-not-available {
      color: #e65100;
      font-style: italic;
      font-weight: 500;
      background: #fff3e0;
      border: 1px dashed #ffb74d;
      border-radius: 3px;
      padding: 2px 6px;
      margin: -2px -6px;
    }

    .cell-value.reserved-not-applicable {
      color: #546e7a;
      font-style: italic;
      background: #eceff1;
      border: 1px solid #cfd8dc;
      border-radius: 3px;
      padding: 2px 6px;
      margin: -2px -6px;
    }

    .cell-value.reserved-anonymized {
      color: #7b1fa2;
      font-style: italic;
      background: #f3e5f5;
      border-radius: 3px;
      padding: 2px 6px;
      margin: -2px -6px;
    }

    .cell-value.reserved-pooled {
      color: #1565c0;
      font-style: italic;
      background: #e3f2fd;
      border-radius: 3px;
      padding: 2px 6px;
      margin: -2px -6px;
    }

    .cell-editor-popup {
      position: fixed;
      z-index: 500;
      background: white;
      border-radius: 8px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
      animation: fadeIn 0.15s ease-out;
      max-width: 400px;
      max-height: 80vh;
      overflow: auto;
    }

    .cell-editor-context {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      background: #1a237e;
      color: white;
      border-radius: 8px 8px 0 0;
      font-size: 12px;
    }

    .cell-editor-context .context-info {
      flex: 1;
    }

    .cell-editor-context strong {
      color: #90caf9;
    }

    .cell-editor-context .btn-close {
      background: none;
      border: none;
      color: white;
      font-size: 18px;
      cursor: pointer;
      padding: 0 4px;
      margin-left: 8px;
      opacity: 0.8;
    }

    .cell-editor-context .btn-close:hover {
      opacity: 1;
    }

    @keyframes fadeIn {
      from {
        opacity: 0;
        transform: translateY(-4px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .jump-to-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      background: #f8f9fa;
      border-top: 1px solid #ddd;
      flex-shrink: 0;
    }

    .jump-to-row label {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
    }

    .jump-input {
      width: 80px;
      padding: 4px 8px;
      border: 1px solid #ccc;
      border-radius: 4px;
      font-size: 13px;
    }

    /* New Validation Panel (Pyodide-based) */
    .validation-panel-container {
      border-top: 2px solid #5bc0be;
      background: #f8f9fa;
      max-height: 300px;
      display: flex;
      flex-direction: column;
      flex-shrink: 0;
    }

    .validation-panel-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 16px;
      background: #5bc0be;
      color: white;
    }

    .validation-title {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .validation-title h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 600;
    }

    .pyodide-status {
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 10px;
      background: rgba(255,255,255,0.2);
    }

    .pyodide-status.loading { background: #fef3c7; color: #92400e; }
    .pyodide-status.ready { background: #d1fae5; color: #059669; }
    .pyodide-status.error { background: #fee2e2; color: #b91c1c; }
    .pyodide-status.api-fallback { background: #dbeafe; color: #1e40af; }

    .validation-panel-body {
      padding: 12px 16px;
      overflow-y: auto;
      flex: 1;
    }

    .validation-backend-row {
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }

    .backend-option {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 10px;
      background: white;
      border: 1px solid #d1d5db;
      border-radius: 16px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .backend-option.selected {
      background: #e0f2fe;
      border-color: #0284c7;
      color: #0f4c81;
    }

    .backend-option input {
      margin: 0;
    }

    .validation-backend-hint {
      font-size: 12px;
      color: #4b5563;
      flex: 1 1 320px;
    }

    .template-selector-row {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }

    .template-label {
      font-size: 12px;
      font-weight: 500;
      color: #4b5563;
    }

    .template-chips {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      flex: 1;
    }

    .template-chip {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      background: white;
      border: 1px solid #d1d5db;
      border-radius: 16px;
      font-size: 11px;
      cursor: pointer;
      transition: all 0.2s;
    }

    .template-chip:hover {
      background: #f3f4f6;
    }

    .template-chip.selected {
      background: #eafaf9;
      border-color: #5bc0be;
      color: #17233d;
    }

    .template-chip input {
      margin: 0;
      width: 12px;
      height: 12px;
    }

    .template-loading {
      font-size: 13px;
      color: #666;
      font-style: italic;
    }

    .btn-sm {
      padding: 6px 12px;
      font-size: 12px;
    }

    .spinner-sm {
      display: inline-block;
      width: 12px;
      height: 12px;
      border: 2px solid #fff;
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }

    .validation-summary-row {
      display: flex;
      gap: 12px;
      margin-bottom: 12px;
      padding: 8px 12px;
      background: white;
      border-radius: 6px;
    }

    .validation-success {
      color: #059669;
      font-weight: 500;
      font-size: 13px;
    }

    .error-badge {
      background: #fee2e2;
      color: #b91c1c;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
    }

    .warning-badge {
      background: #fef3c7;
      color: #92400e;
      padding: 4px 10px;
      border-radius: 12px;
      font-size: 12px;
      font-weight: 500;
    }

    .validation-errors-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .validation-error-card {
      background: white;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      border-left: 4px solid #9ca3af;
      overflow: hidden;
    }

    .validation-error-card.level-error {
      border-left-color: #dc2626;
    }

    .validation-error-card.level-warning {
      border-left-color: #f59e0b;
    }

    .error-main {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 10px 12px;
    }

    .error-icon {
      flex-shrink: 0;
      font-size: 14px;
    }

    .error-content {
      flex: 1;
      min-width: 0;
    }

    .error-message {
      font-size: 13px;
      color: #374151;
      margin-bottom: 4px;
    }

    .error-column {
      font-size: 11px;
      color: #6b7280;
      margin-bottom: 4px;
    }

    .error-cells {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      margin-bottom: 4px;
    }

    .cells-label {
      font-size: 11px;
      color: #6b7280;
    }

    .cells-list {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
    }

    .cell-link {
      background: #f3f4f6;
      border: none;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
      color: #5bc0be;
      cursor: pointer;
      font-family: monospace;
    }

    .cell-link:hover {
      background: #eafaf9;
      text-decoration: underline;
    }

    .cells-more {
      font-size: 11px;
      color: #9ca3af;
    }

    .error-suggestion {
      font-size: 11px;
      color: #059669;
      background: #f0fdf4;
      padding: 4px 8px;
      border-radius: 4px;
      margin-top: 4px;
    }

    .btn-ai-assist {
      flex-shrink: 0;
      padding: 6px 12px;
      background: #5bc0be;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;
      transition: opacity 0.2s;
    }

    .btn-ai-assist:hover {
      opacity: 0.9;
    }

    .btn-ai-assist.btn-disabled {
      background: #9ca3af;
      cursor: not-allowed;
      opacity: 0.7;
    }

    .btn-ai-assist.btn-disabled:hover {
      opacity: 0.7;
    }

    .validation-loading {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 20px;
      color: #6b7280;
      font-size: 13px;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 60px;
      color: #666;
      flex: 1;
    }

    .empty-state p {
      margin: 4px 0;
    }

    .empty-state .hint {
      font-size: 12px;
      color: #999;
    }

    /* Column type styling - left border indicates column type */
    .sdrf-table th.data-col {
      position: relative;
      border-left: 4px solid #8d6e63;
    }

    .sdrf-table th .col-name {
      display: inline;
    }

    .col-header-content {
      display: flex;
      align-items: center;
      gap: 4px;
      justify-content: space-between;
      width: 100%;
    }

    .bulk-edit-btn {
      background: rgba(255, 255, 255, 0.9);
      border: 1px solid #ccc;
      border-radius: 3px;
      padding: 2px 6px;
      font-size: 12px;
      cursor: pointer;
      opacity: 0;
      transition: opacity 0.2s, background 0.2s;
      flex-shrink: 0;
    }

    .sdrf-table th:hover .bulk-edit-btn {
      opacity: 1;
    }

    .bulk-edit-btn:hover {
      background: #2196f3;
      border-color: #2196f3;
      transform: scale(1.1);
    }

    /* Sample Accession (source name) - Green */
    .sdrf-table th.col-type-source { border-left-color: #4caf50; background: rgba(76, 175, 80, 0.05); }

    /* Sample Properties (characteristics) - Blue */
    .sdrf-table th.col-type-characteristic { border-left-color: #2196f3; background: rgba(33, 150, 243, 0.05); }

    /* Data Properties (comments, assay, files, technical) - Gray */
    .sdrf-table th.col-type-comment { border-left-color: #9e9e9e; background: rgba(158, 158, 158, 0.05); }

    /* Factor Values - Orange */
    .sdrf-table th.col-type-factor { border-left-color: #ff9800; background: rgba(255, 152, 0, 0.05); }

    /* Sort indicator */
    .sort-indicator {
      margin-left: 4px;
      font-size: 10px;
      color: #1976d2;
    }

    .sdrf-table th:hover {
      cursor: pointer;
      background: #f0f0f0;
    }

    /* Multi-selection styles */
    .toolbar-divider {
      width: 1px;
      height: 24px;
      background: #ddd;
      margin: 0 4px;
    }

    .unsaved-indicator {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 4px 10px;
      background: #fff3cd;
      border: 1px solid #ffc107;
      border-radius: 4px;
      font-size: 12px;
      color: #856404;
      font-weight: 500;
      margin-left: 8px;
    }

    .btn-active {
      background: #e3f2fd !important;
      border-color: #2196f3 !important;
      color: #1976d2 !important;
    }

    .btn-ai {
      background: #5bc0be;
      color: white;
      border-color: #5bc0be;
    }

    .btn-ai:hover {
      background: #5a67d8;
    }

    .btn-ai.btn-active {
      background: #5a67d8 !important;
      border-color: #5a67d8 !important;
      box-shadow: 0 0 0 2px rgba(91, 192, 190, 0.3);
    }

    .btn-ai.btn-disabled {
      background: #9ca3af;
      border-color: #9ca3af;
      color: #f3f4f6;
      cursor: not-allowed;
      opacity: 0.7;
    }

    .btn-ai.btn-disabled:hover {
      background: #9ca3af;
      border-color: #9ca3af;
    }

    /* AI Panel Slide-in Container */
    .ai-panel-container {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      left: 0;
      z-index: 100;
      pointer-events: none;
      visibility: hidden;
    }

    .ai-panel-container.open {
      pointer-events: auto;
      visibility: visible;
    }

    .ai-panel-backdrop {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.3);
      opacity: 0;
      transition: opacity 0.3s ease;
    }

    .ai-panel-container.open .ai-panel-backdrop {
      opacity: 1;
    }

    .ai-panel-wrapper {
      position: absolute;
      top: 0;
      right: 0;
      bottom: 0;
      width: 420px;
      max-width: 90vw;
      transform: translateX(100%);
      transition: transform 0.3s ease;
      box-shadow: -4px 0 20px rgba(0, 0, 0, 0.15);
    }

    .ai-panel-container.open .ai-panel-wrapper {
      transform: translateX(0);
    }

    .ai-panel-wrapper sdrf-recommend-panel {
      display: block;
      height: 100%;
    }

    tr.row-selected td {
      background: #e8f5e9 !important;
    }

    tr.row-selected td.row-header {
      background: #c8e6c9 !important;
    }

    .context-menu {
      position: absolute;
      z-index: 200;
      background: white;
      border: 1px solid #ddd;
      border-radius: 6px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      padding: 4px 0;
      min-width: 200px;
    }

    .context-menu button {
      display: block;
      width: 100%;
      padding: 8px 16px;
      border: none;
      background: none;
      text-align: left;
      cursor: pointer;
      font-size: 13px;
    }

    .context-menu button:hover {
      background: #f5f5f5;
    }

    .context-menu hr {
      margin: 4px 0;
      border: none;
      border-top: 1px solid #eee;
    }

    /* Dialog styles */
    .dialog-backdrop {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .dialog-content {
      background: white;
      border-radius: 8px;
      padding: 24px;
      min-width: 400px;
      max-width: 500px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
    }

    .dialog-content h3 {
      margin: 0 0 16px 0;
      font-size: 18px;
      color: #333;
    }

    .dialog-form {
      margin-bottom: 20px;
    }

    .dialog-form label {
      display: block;
      margin-bottom: 8px;
      font-weight: 500;
      color: #666;
    }

    .dialog-form input {
      width: 100%;
      padding: 10px 12px;
      border: 1px solid #ddd;
      border-radius: 4px;
      font-size: 14px;
      box-sizing: border-box;
    }

    .dialog-form input:focus {
      outline: none;
      border-color: #1a237e;
      box-shadow: 0 0 0 2px rgba(26, 35, 126, 0.1);
    }

    .dialog-hint {
      margin: 8px 0 0 0;
      font-size: 12px;
      color: #888;
    }

    .dialog-actions {
      display: flex;
      gap: 8px;
      justify-content: flex-end;
    }

    .dialog-actions .btn {
      padding: 8px 16px;
      border-radius: 4px;
      font-size: 14px;
      cursor: pointer;
    }

    .dialog-actions .btn-primary {
      background: #1a237e;
      color: white;
      border: none;
    }

    .dialog-actions .btn-primary:hover:not(:disabled) {
      background: #283593;
    }

    .dialog-actions .btn-primary:disabled {
      background: #9e9e9e;
      cursor: not-allowed;
    }

    .dialog-actions .btn:not(.btn-primary) {
      background: #f5f5f5;
      border: 1px solid #ddd;
      color: #333;
    }

    .dialog-actions .btn:not(.btn-primary):hover {
      background: #e0e0e0;
    }
  `],
})
export class SdrfEditorComponent implements OnInit, OnChanges, AfterViewInit, OnDestroy {
  // Expose constant for template
  readonly ROW_HEIGHT = ROW_HEIGHT;

  // ============ Inputs ============

  /** URL to load SDRF from */
  @Input() url?: string;

  /** Example SDRF URL for "Load Example" on the landing page */
  @Input() exampleUrl?: string;

  /** SDRF content to load directly */
  @Input() content?: string;

  /** Whether the editor is read-only */
  @Input() readonly = false;

  /** Available templates for the creation wizard (defaults to common templates) */
  @Input() availableWizardTemplates: string[] = [];

  // ============ Outputs ============

  /** Emitted when the table changes */
  @Output() tableChange = new EventEmitter<SdrfTable>();

  /** Emitted when validation completes */
  @Output() validationComplete = new EventEmitter<ValidationResult>();

  /** Emitted when user requests to load from URL (landing page) */
  @Output() loadUrlRequested = new EventEmitter<string>();

  /** Emitted when user requests to load the example SDRF (landing page) */
  @Output() loadExampleRequested = new EventEmitter<void>();

  // ============ View References ============

  @ViewChild('scrollContainer') scrollContainer!: ElementRef<HTMLDivElement>;

  // ============ State ============

  /** The loaded SDRF table */
  table = signal<SdrfTable | null>(null);

  /** Whether currently loading */
  loading = signal(false);

  /** Loading message */
  loadingMessage = signal('Loading...');

  /** Current error message */
  error = signal<string | null>(null);

  /** Currently selected cell */
  selectedCell = signal<CellSelection | null>(null);

  /** Cell being edited */
  editingCell = signal<CellSelection | null>(null);

  /** Column being edited */
  editingColumn = signal<SdrfColumn | null>(null);

  /** Editor popup position */
  editorPosition = signal({ top: 0, left: 0 });

  /** Validation result */
  validationResult = signal<ValidationResult | null>(null);

  /** Current scroll position */
  scrollTop = signal(0);

  /** Container height */
  containerHeight = signal(500);

  /** Jump to row input */
  jumpToRowInput = 1;

  // ============ Multi-Selection State ============

  /** Selected sample indices (1-based) */
  selectedSamples = signal<Set<number>>(new Set());

  /** Selected column index for bulk operations (when using "Select all in column") */
  selectedColumnForBulk = signal<number | null>(null);

  /** Whether stats panel is visible */
  showStatsPanel = signal(false);

  /** Whether AI recommend panel is visible */
  showRecommendPanel = signal(false);

  /** Whether top banner is collapsed */
  bannerCollapsed = signal(false);

  /** Whether LLM settings dialog is visible */
  showLlmSettingsDialog = signal(false);

  /** Whether SDRF creation wizard is visible */
  showWizard = signal(false);

  /** Whether validation panel is visible */
  showValidationPanel = signal(false);

  /** Whether column editor panel is visible */
  showColumnEditor = signal(false);

  /** Column index being edited in bulk */
  columnEditorIndex = signal(-1);

  /** Whether cache recovery panel is visible */
  showCacheRecovery = signal(false);

  /** Current cache ID (if loaded from cache) */
  currentCacheId = signal<string | null>(null);

  /** Number of changes made (for cache tracking) */
  changeCount = signal(0);

  /** Current file name */
  fileName = signal('untitled.sdrf.tsv');

  /** Asset URLs need to resolve relative to the loaded bundle for embedded deployments */
  readonly eubicLogoUrl = new URL('assets/images/eubic-logo.png', import.meta.url).toString();
  readonly psiLogoUrl = new URL('assets/images/psi-logo.png', import.meta.url).toString();
  readonly quantmsLogoUrl = new URL('assets/images/quantms-logo.png', import.meta.url).toString();

  // ============ Pyodide Validation State ============

  private pyodideService: PyodideValidatorService;
  private cacheService: TableCacheService = tableCacheService;

  /** Pyodide validation in progress */
  pyodideValidating = signal(false);

  /** Pyodide validation errors */
  pyodideErrors = signal<ValidationError[]>([]);

  /** Whether Pyodide validation has been run */
  pyodideHasValidated = signal(false);

  /** Selected templates for validation */
  selectedTemplates = signal<string[]>(['ms-proteomics']);

  /** Active validation backend */
  validationMode = signal<ValidationBackendMode>('api');

  /** Aggregated validation errors (grouped by message) */
  aggregatedErrors = computed(() => this.aggregateErrors(this.pyodideErrors()));

  /** Pyodide state computed signals */
  pyodideState = computed(() => this.pyodideService.state());
  pyodideIsReady = computed(() => this.pyodideService.isReady());
  pyodideIsLoading = computed(() => this.pyodideService.isLoading());
  pyodideLoadProgress = computed(() => this.pyodideService.loadProgress());
  pyodideAvailableTemplates = computed(() => this.pyodideService.availableTemplates());
  pyodideErrorCount = computed(() => this.pyodideErrors().filter(e => e.level === 'error').length);
  pyodideWarningCount = computed(() => this.pyodideErrors().filter(e => e.level === 'warning').length);

  /** API fallback state */
  usingApiFallback = computed(() => this.pyodideService.usingApiFallback());
  apiAvailable = computed(() => this.pyodideService.apiAvailable());

  /** Context menu state */
  contextMenu = signal<{ x: number; y: number; row: number; col: number } | null>(null);

  /** Last selected row for shift-click range selection */
  private lastSelectedRow: number | null = null;

  /** URL input value on the landing page (Load URL) */
  loadUrlValue = '';

  // ============ Filter State ============

  /** Whether filter bar is visible */
  showFilterBar = signal(false);

  /** Filtered row indices (empty = no filter) */
  filteredIndices = signal<number[]>([]);

  // ============ Sorting State ============

  /** Currently sorted column index (-1 = no sort) */
  sortColumn = signal<number>(-1);

  /** Sort direction */
  sortDirection = signal<'asc' | 'desc'>('asc');

  /** Sorted row indices (maps display order to actual sample index) */
  sortedIndices = signal<number[]>([]);

  // ============ Computed (Virtual Scrolling) ============

  /** Total scrollable height (accounts for filtering) */
  totalHeight = computed(() => {
    const t = this.table();
    if (!t) return 0;

    // Use filtered count if filtering, otherwise full count
    const rowCount = this.filteredIndices().length > 0
      ? this.filteredIndices().length
      : t.sampleCount;

    // Add extra height for header
    return (rowCount * ROW_HEIGHT) + ROW_HEIGHT + 100;
  });

  /** Table Y offset for transform */
  tableOffset = computed(() => {
    const range = this.visibleRange();
    if (!range) return 0;
    // Offset to position visible rows, accounting for header
    return (range.start - 1) * ROW_HEIGHT;
  });

  /** Visible row range */
  visibleRange = computed(() => {
    const t = this.table();
    if (!t) return null;

    const scrollPos = this.scrollTop();
    const viewHeight = this.containerHeight();

    // Calculate visible range
    const startRow = Math.max(1, Math.floor(scrollPos / ROW_HEIGHT) - BUFFER_ROWS);
    const visibleCount = Math.ceil(viewHeight / ROW_HEIGHT) + (BUFFER_ROWS * 2);
    const endRow = Math.min(t.sampleCount, startRow + visibleCount);

    return { start: startRow, end: endRow };
  });

  /** Effective row list (filtered and/or sorted) */
  effectiveRows = computed(() => {
    const t = this.table();
    if (!t) return [];

    // Start with all rows or filtered rows
    let rows = this.filteredIndices().length > 0
      ? [...this.filteredIndices()]
      : Array.from({ length: t.sampleCount }, (_, i) => i + 1);

    // Apply sorting if active
    const sorted = this.sortedIndices();
    if (sorted.length > 0) {
      // Filter sorted indices to only include filtered rows
      const rowSet = new Set(rows);
      rows = sorted.filter(i => rowSet.has(i));
    }

    return rows;
  });

  /** Array of visible row indices (accounts for filtering and sorting) */
  visibleRows = computed(() => {
    const range = this.visibleRange();
    if (!range) return [];

    const effective = this.effectiveRows();
    const rows: number[] = [];

    // Get the slice of effective rows for this visible range
    for (let i = range.start - 1; i < range.end && i < effective.length; i++) {
      if (effective[i]) {
        rows.push(effective[i]);
      }
    }

    return rows;
  });

  // ============ Services ============

  private parser = new SdrfParserService();
  private validator = new SdrfValidatorService();
  private exporter = new SdrfExportService();

  private resizeObserver?: ResizeObserver;

  private readonly assistantApi = inject(AssistantApiService);

  constructor(private ngZone: NgZone) {
    this.pyodideService = pyodideValidatorService;
  }

  // ============ Lifecycle ============

  ngOnInit(): void {
    // Check for cached tables first
    if (this.cacheService.hasCachedTables() && !this.url && !this.content) {
      this.showCacheRecovery.set(true);
      return;
    }

    // Auto-load from URL or content if provided
    if (this.url) {
      this.loadFromUrl(this.url);
    } else if (this.content) {
      this.loadFromContent(this.content);
    }
  }

  ngAfterViewInit(): void {
    // Set up resize observer for container height
    if (this.scrollContainer) {
      this.updateContainerHeight();

      this.resizeObserver = new ResizeObserver(() => {
        this.ngZone.run(() => {
          this.updateContainerHeight();
        });
      });
      this.resizeObserver.observe(this.scrollContainer.nativeElement);
    }
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['url'] && !changes['url'].firstChange && this.url) {
      this.loadFromUrl(this.url);
    }
    if (changes['content'] && !changes['content'].firstChange && this.content) {
      this.loadFromContent(this.content);
    }
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }

  // ============ Public Methods ============

  /**
   * Loads SDRF from a URL.
   */
  async loadFromUrl(url: string): Promise<void> {
    this.loading.set(true);
    this.loadingMessage.set('Fetching file...');
    this.error.set(null);

    try {
      const result = await this.parser.parseFromUrl(url);
      this.handleParseResult(result);
    } catch (e) {
      this.error.set(`Failed to load: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Loads SDRF from content string.
   */
  async loadFromContent(content: string): Promise<void> {
    this.loading.set(true);
    this.loadingMessage.set('Parsing file...');
    this.error.set(null);

    try {
      // Use setTimeout to allow UI to update before heavy parsing
      await new Promise(resolve => setTimeout(resolve, 10));
      const result = this.parser.parseFromContent(content);
      this.handleParseResult(result);
    } catch (e) {
      this.error.set(`Failed to parse: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.loading.set(false);
    }
  }

  /**
   * Gets the current table.
   */
  getTable(): SdrfTable | null {
    return this.table();
  }

  /**
   * Validates the current table.
   */
  /**
   * Opens the validation panel and triggers validation
   */
  async validate(): Promise<ValidationResult | null> {
    const t = this.table();
    if (!t) return null;

    // Open the validation panel
    this.showValidationPanel.set(true);

    // Run Pyodide validation automatically
    await this.runPyodideValidation();

    return null;
  }

  /**
   * Initialize the selected validation backend and load its templates.
   */
  async initPyodide(mode: ValidationBackendMode = this.validationMode()): Promise<void> {
    try {
      await this.pyodideService.initialize({
        mode,
        allowApiFallback: mode === 'auto',
      });

      const available = this.pyodideAvailableTemplates();
      if (available.length === 0) return;

      // Prefer auto-detected templates from table content; otherwise keep only valid names
      if (this.table()) {
        const tsvContent = sdrfExport.exportToTsv(this.table()!);
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
      console.error('Failed to initialize validation backend:', err);
    }
  }

  /**
   * Switch between API-backed and local validation.
   */
  async switchValidationMode(mode: ValidationBackendMode): Promise<void> {
    if (this.validationMode() === mode) {
      return;
    }

    this.validationMode.set(mode);
    this.pyodideErrors.set([]);
    this.pyodideHasValidated.set(false);
    await this.initPyodide(mode);
  }

  /**
   * Run validation using the selected backend.
   */
  async runPyodideValidation(): Promise<void> {
    if (!this.table() || this.pyodideValidating()) return;
    const mode = this.validationMode();

    // Initialize the selected backend if needed
    if (
      (mode === 'api' && !this.usingApiFallback()) ||
      (mode === 'local' && this.pyodideState() !== 'ready')
    ) {
      await this.initPyodide(mode);
    }

    this.pyodideValidating.set(true);
    this.pyodideErrors.set([]);

    try {
      // Convert table to TSV
      const currentTable = this.table()!;
      const tsvContent = sdrfExport.exportToTsv(currentTable);

      // Debug: Log the column state for any sdrf template columns
      const templateCol = currentTable.columns.find(c => c.name.includes('sdrf template'));
      if (templateCol) {
        console.log(`[Validate] Template column state: value="${templateCol.value}", modifiers=${JSON.stringify(templateCol.modifiers)}`);
        // Log first few lines of TSV to see actual exported values
        const lines = tsvContent.split('\n').slice(0, 3);
        console.log(`[Validate] First 3 TSV lines:`, lines);
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
        {
          skipOntology: true,
          mode,
          allowApiFallback: false,
        }
      );

      this.pyodideErrors.set(errors);
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

  /**
   * Aggregate errors by message for cleaner display
   */
  private aggregateErrors(errors: ValidationError[]): AggregatedValidationError[] {
    const grouped = new Map<string, AggregatedValidationError>();

    for (const err of errors) {
      // Create a key combining message and column for grouping
      const key = `${err.message}||${err.column || ''}`;

      if (grouped.has(key)) {
        const existing = grouped.get(key)!;
        if (err.row >= 0) {
          existing.cells.push({ row: err.row, value: err.value });
        }
      } else {
        grouped.set(key, {
          message: err.message,
          level: err.level,
          column: err.column,
          cells: err.row >= 0 ? [{ row: err.row, value: err.value }] : [],
          suggestion: err.suggestion
        });
      }
    }

    // Sort by level (errors first) then by number of affected cells
    return Array.from(grouped.values()).sort((a, b) => {
      if (a.level !== b.level) return a.level === 'error' ? -1 : 1;
      return b.cells.length - a.cells.length;
    });
  }

  /**
   * Toggle template selection
   */
  toggleTemplate(template: string): void {
    const current = this.selectedTemplates();
    if (current.includes(template)) {
      this.selectedTemplates.set(current.filter(t => t !== template));
    } else {
      this.selectedTemplates.set([...current, template]);
    }
  }

  /**
   * Close the validation panel
   */
  closeValidationPanel(): void {
    this.showValidationPanel.set(false);
  }

  /**
   * Jump to a specific cell from validation error
   */
  jumpToValidationCell(row: number, column: string | null): void {
    if (row < 0) return;

    // Find column index
    const t = this.table();
    if (!t) return;

    let colIndex = -1;
    if (column) {
      colIndex = t.columns.findIndex(c => c.name === column);
    }

    // Scroll to row (row is 0-based from validation, convert to 1-based for display)
    this.jumpToRowInput = row + 1;
    this.jumpToRow();

    // Select the cell if column found
    if (colIndex >= 0) {
      this.selectedCell.set({ row: row + 1, col: colIndex });
    }
  }

  /**
   * Send validation error to AI chat
   */
  /**
   * Opens the AI panel when user clicks on a validation error.
   * The AI recommendations will include all validation errors automatically.
   */
  sendErrorToAI(error: AggregatedValidationError): void {
    // Open the AI panel - validation errors are automatically included in AI analysis
    this.showRecommendPanel.set(true);
  }

  /**
   * Exports to TSV and triggers download.
   */
  exportTsv(): void {
    const t = this.table();
    if (!t) return;

    const filename = t.metadata?.filename?.replace(/\.[^.]+$/, '.tsv') || 'sdrf.tsv';
    this.exporter.downloadTsv(t, filename);
  }

  /**
   * Exports to Excel and triggers download.
   */
  async exportExcel(): Promise<void> {
    const t = this.table();
    if (!t) return;

    const filename = t.metadata?.filename?.replace(/\.[^.]+$/, '.xlsx') || 'sdrf.xlsx';
    await this.exporter.downloadExcel(t, filename);
  }

  // ============ Event Handlers ============

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    this.loading.set(true);
    this.loadingMessage.set(`Parsing ${file.name}...`);
    this.error.set(null);

    this.parser.parseFromFile(file).then((result) => {
      this.handleParseResult(result);
      this.loading.set(false);
      input.value = ''; // Reset input
    });
  }

  onLoadUrlClick(): void {
    const url = this.loadUrlValue?.trim();
    if (url) {
      this.loadUrlRequested.emit(url);
    }
  }

  onLoadExampleClick(): void {
    this.loadExampleRequested.emit();
  }

  onScroll(event: Event): void {
    const target = event.target as HTMLDivElement;
    this.scrollTop.set(target.scrollTop);
  }

  selectCell(row: number, col: number): void {
    this.selectedCell.set({ row, col });
  }

  selectColumn(col: number): void {
    this.selectedCell.set({ row: 0, col });
  }

  startEditing(row: number, col: number): void {
    if (this.readonly) return;

    const t = this.table();
    if (!t || col >= t.columns.length) return;

    // Get the cell element to position the editor
    const cellSelector = `tr:nth-child(${row - (this.visibleRange()?.start ?? 1) + 1}) td:nth-child(${col + 2})`;
    const cell = this.scrollContainer?.nativeElement.querySelector(cellSelector) as HTMLElement;

    if (cell) {
      const cellRect = cell.getBoundingClientRect();

      // Position editor below the cell, using viewport coordinates (fixed positioning)
      let top = cellRect.bottom + 4;
      let left = cellRect.left;

      // Keep editor within viewport bounds
      const editorWidth = 400; // Approximate editor width
      const editorHeight = 300; // Approximate editor height

      // Adjust horizontal position if too close to right edge
      if (left + editorWidth > window.innerWidth - 20) {
        left = window.innerWidth - editorWidth - 20;
      }
      if (left < 20) left = 20;

      // Adjust vertical position if too close to bottom edge
      if (top + editorHeight > window.innerHeight - 20) {
        // Position above the cell instead
        top = cellRect.top - editorHeight - 4;
        if (top < 20) top = 20;
      }

      this.editorPosition.set({ top, left });
    } else {
      // Fallback positioning - center of viewport
      this.editorPosition.set({
        top: window.innerHeight / 2 - 150,
        left: window.innerWidth / 2 - 200
      });
    }

    this.editingCell.set({ row, col });
    this.editingColumn.set(t.columns[col]);
  }

  onCellEditorSave(newValue: string): void {
    const editing = this.editingCell();
    if (!editing) {
      this.cancelEditing();
      return;
    }

    this.setCellValue(editing.row, editing.col, newValue);
    this.editingCell.set(null);
    this.editingColumn.set(null);
  }

  cancelEditing(): void {
    this.editingCell.set(null);
    this.editingColumn.set(null);
  }

  clearError(): void {
    this.error.set(null);
  }

  clearValidation(): void {
    this.validationResult.set(null);
  }

  jumpToRow(): void {
    const t = this.table();
    if (!t || !this.scrollContainer) return;

    const row = Math.max(1, Math.min(this.jumpToRowInput, t.sampleCount));
    const scrollPos = (row - 1) * ROW_HEIGHT;

    this.scrollContainer.nativeElement.scrollTop = scrollPos;
    this.scrollTop.set(scrollPos);
    this.selectedCell.set({ row, col: 0 });
  }

  // ============ Helper Methods ============

  getCellValue(row: number, col: number): string {
    const t = this.table();
    if (!t || col >= t.columns.length) return '';

    const column = t.columns[col];
    return getValueForSample(column, row);
  }

  setCellValue(row: number, col: number, value: string): void {
    const t = this.table();
    if (!t || col >= t.columns.length) return;

    // Clone the table and update the value
    const newTable = { ...t, columns: [...t.columns] };
    const column = { ...newTable.columns[col], modifiers: [...newTable.columns[col].modifiers] };

    // Update value using modifier utilities
    if (value === column.value) {
      // Remove from modifiers if setting to default
      column.modifiers = column.modifiers.filter((m) => {
        const samples = m.samples.split(',').map((s) => parseInt(s.trim(), 10));
        return !samples.includes(row);
      });
    } else {
      // Add or update modifier
      const existingModifier = column.modifiers.find((m) => m.value === value);
      if (existingModifier) {
        existingModifier.samples = `${existingModifier.samples},${row}`;
      } else {
        column.modifiers.push({ samples: String(row), value });
      }
    }

    newTable.columns[col] = column;
    this.table.set(newTable);
    this.tableChange.emit(newTable);

    // Auto-save after cell edit
    this.autoSaveTable();
  }

  isSelected(row: number, col: number): boolean {
    const sel = this.selectedCell();
    return sel?.row === row && sel?.col === col;
  }

  hasCellError(row: number, col: number): boolean {
    const result = this.validationResult();
    if (!result) return false;

    const t = this.table();
    if (!t) return false;

    const column = t.columns[col];
    return result.errors.some(
      (e) => e.column?.toLowerCase() === column.name.toLowerCase() && (!e.row || e.row === row)
    );
  }

  /**
   * Reserved SDRF values that are valid but indicate missing/special data.
   */
  private readonly RESERVED_VALUES = [
    'not available',
    'not applicable',
    'anonymized',
    'pooled'
  ];

  /**
   * Checks if a cell value is a reserved SDRF value.
   */
  isReservedValue(value: string): boolean {
    if (!value) return false;
    const lower = value.toLowerCase().trim();
    return this.RESERVED_VALUES.includes(lower);
  }

  /**
   * Checks if a cell value matches a specific reserved value type.
   */
  isReservedValueType(value: string, type: string): boolean {
    if (!value) return false;
    return value.toLowerCase().trim() === type.toLowerCase();
  }

  private updateContainerHeight(): void {
    if (this.scrollContainer) {
      this.containerHeight.set(this.scrollContainer.nativeElement.clientHeight);
    }
  }

  private handleParseResult(result: SdrfParseResult): void {
    if (result.success && result.table) {
      this.table.set(result.table);
      this.tableChange.emit(result.table);
      this.validationResult.set(null);
      this.scrollTop.set(0);
      this.clearSelection();

      // Reset cache state for new file
      this.currentCacheId.set(null);
      this.changeCount.set(0);

      if (result.warnings.length > 0) {
        console.warn('Parse warnings:', result.warnings);
      }

      console.log(`Loaded ${result.table.sampleCount} samples, ${result.table.columns.length} columns in ${result.stats.parseTimeMs.toFixed(0)}ms`);
    } else {
      this.error.set(result.error || 'Unknown error');
    }
  }

  // ============ Multi-Selection Methods ============

  toggleStatsPanel(): void {
    this.showStatsPanel.set(!this.showStatsPanel());
  }

  toggleRecommendPanel(): void {
    this.showRecommendPanel.set(!this.showRecommendPanel());
  }

  toggleBanner(): void {
    this.bannerCollapsed.set(!this.bannerCollapsed());
  }

  openLlmSettings(): void {
    this.showLlmSettingsDialog.set(true);
  }

  closeLlmSettings(): void {
    this.showLlmSettingsDialog.set(false);
  }

  onLlmSettingsSaved(): void {
    // Settings were saved, panel can now use the new configuration
    console.log('LLM settings saved');
  }

  // ============ Column Editor Methods ============

  openColumnEditor(columnIndex: number): void {
    this.columnEditorIndex.set(columnIndex);
    this.showColumnEditor.set(true);
  }

  closeColumnEditor(): void {
    this.showColumnEditor.set(false);
    this.columnEditorIndex.set(-1);
  }

  onBulkEditColumn(event: ColumnBulkEditEvent): void {
    const t = this.table();
    if (!t || event.columnIndex < 0 || event.columnIndex >= t.columns.length) {
      console.error('Invalid column index for bulk edit:', event.columnIndex);
      return;
    }

    const column = t.columns[event.columnIndex];

    // Apply the value to all selected samples
    for (const sampleIndex of event.sampleIndices) {
      if (sampleIndex >= 1 && sampleIndex <= t.sampleCount) {
        setValueForSample(column, sampleIndex, event.value);
      }
    }

    // Force update
    this.table.set({ ...t });
    this.tableChange.emit(t);

    // Auto-save
    this.autoSaveTable();

    console.log(`Bulk edited column "${column.name}" for ${event.sampleIndices.length} samples`);

    // Close the panel
    this.closeColumnEditor();
  }

  // ============ Cache Recovery Methods ============

  onRecoverCache(event: RecoverCacheEvent): void {
    const cached = this.cacheService.loadTable(event.cacheId);
    if (!cached) {
      console.error('Failed to load cached table:', event.cacheId);
      return;
    }

    // Load the table
    this.table.set(cached.table);
    this.tableChange.emit(cached.table);
    this.currentCacheId.set(event.cacheId);
    this.changeCount.set(cached.entry.changeCount);
    this.fileName.set(cached.entry.fileName);

    // Hide recovery panel
    this.showCacheRecovery.set(false);

    console.log(`Recovered table from cache: ${cached.entry.fileName}`);
  }

  dismissCacheRecovery(): void {
    this.showCacheRecovery.set(false);
  }

  private autoSaveTable(): void {
    const t = this.table();
    const name = this.fileName();

    if (!t || !name) return;

    // Increment change count
    const count = this.changeCount() + 1;
    this.changeCount.set(count);

    // Save to cache
    const cacheId = this.cacheService.saveTable(
      t,
      name,
      this.currentCacheId() || undefined,
      count
    );

    if (cacheId && !this.currentCacheId()) {
      this.currentCacheId.set(cacheId);
    }
  }

  // ============ Recommendation Methods ============

  onApplyRecommendation(event: ApplyRecommendationEvent): void {
    const rec = event.recommendation;

    // Handle add_column type - create new column first
    if (rec.type === 'add_column') {
      this.addColumnWithValue(rec.column, rec.suggestedValue, rec.sampleIndices);
      return;
    }

    this.applyRecommendationToTable(rec);
  }

  /**
   * Adds a new column to the table with a default value for specified samples.
   */
  private addColumnWithValue(columnName: string, value: string, sampleIndices: number[]): void {
    const t = this.table();
    if (!t) return;

    console.log(`[AddColumn] Adding column "${columnName}" with value "${value}" for ${sampleIndices.length} samples`);

    // Determine column type from name
    const nameLower = columnName.toLowerCase();
    let columnType: 'source_name' | 'characteristics' | 'comment' | 'factor_value' | 'special' = 'special';
    if (nameLower.startsWith('characteristics[')) {
      columnType = 'characteristics';
    } else if (nameLower.startsWith('comment[')) {
      columnType = 'comment';
    } else if (nameLower.startsWith('factor value[')) {
      columnType = 'factor_value';
    } else if (nameLower === 'source name') {
      columnType = 'source_name';
    }

    // Create the new column
    const newColumn: SdrfColumn = {
      name: columnName.toLowerCase().trim(),
      type: columnType,
      value: value,
      modifiers: [],
      columnPosition: t.columns.length,
      isRequired: false,
    };

    // Create new table with the column added
    const newTable = {
      ...t,
      columns: [...t.columns, newColumn],
    };

    this.table.set(newTable);
    this.tableChange.emit(newTable);
    console.log(`[AddColumn] Added column "${columnName}" to table`);
  }

  onBatchApplyRecommendations(event: BatchApplyEvent): void {
    for (const rec of event.recommendations) {
      this.applyRecommendationToTable(rec);
    }
    console.log(`Applied ${event.recommendations.length} recommendations`);
  }

  onApplyFix(event: ApplyFixEvent): void {
    // Update the table with the cleaned version
    this.table.set(event.table);
    this.tableChange.emit(event.table);

    // Reset scroll and selection state to avoid stale references
    this.selectedCell.set(null);
    this.clearSelection();

    // Force scroll container to re-measure
    if (this.scrollContainer) {
      // Reset scroll to top to avoid display issues
      this.scrollContainer.nativeElement.scrollTop = 0;
      this.scrollTop.set(0);
    }

    console.log(`Applied fix: ${event.fix.description} (${event.result.changesCount} changes)`);
  }

  onPreviewRecommendation(rec: SdrfRecommendation): void {
    // Jump to the first affected sample and select the column
    if (rec.sampleIndices.length > 0) {
      const sampleIndex = rec.sampleIndices[0];
      this.jumpToRowInput = sampleIndex;
      this.jumpToRow();
      this.selectCell(sampleIndex, rec.columnIndex);
    }
  }

  /**
   * Handle the Explain button from AI recommendations.
   * Shows the explanation prompt (future: could send to AI chat).
   */
  onOpenChat(prompt: string): void {
    // For now, show the explanation in an alert
    // Future: integrate with a chat component
    console.log('AI Explanation Request:', prompt);
    alert('AI Explanation:\n\n' + prompt);
  }

  private applyRecommendationToTable(rec: SdrfRecommendation): void {
    const t = this.table();
    if (!t || rec.columnIndex < 0 || rec.columnIndex >= t.columns.length) return;

    const column = t.columns[rec.columnIndex];
    let sampleIndices = rec.sampleIndices;

    console.log(`[ApplyRec] Starting: column="${rec.column}", currentValue="${rec.currentValue}", suggestedValue="${rec.suggestedValue}", sampleIndices=${JSON.stringify(sampleIndices)}`);
    console.log(`[ApplyRec] Column state: value="${column.value}", modifiers=${JSON.stringify(column.modifiers)}`);

    // If sampleIndices is empty, determine which samples to update
    if (sampleIndices.length === 0) {
      if (rec.currentValue !== undefined && rec.currentValue !== '') {
        // Find all samples that currently have the currentValue
        sampleIndices = this.findSamplesWithValue(column, rec.currentValue, t.sampleCount);
        console.log(`[ApplyRec] Found ${sampleIndices.length} samples with currentValue "${rec.currentValue}"`);
      } else {
        // No currentValue specified - apply to ALL samples by changing the default value
        this.setColumnDefaultValue(rec.columnIndex, rec.suggestedValue);
        console.log(`[ApplyRec] Applied to all samples: set default value to "${rec.suggestedValue}"`);
        return;
      }
    }

    if (sampleIndices.length === 0) {
      console.warn(`[ApplyRec] No samples found to apply recommendation for ${rec.column}. Column value="${column.value}", searching for="${rec.currentValue}"`);
      return;
    }

    // Optimization: if ALL samples are affected and no other values exist, just change the default
    if (sampleIndices.length === t.sampleCount && column.modifiers.length === 0) {
      this.setColumnDefaultValue(rec.columnIndex, rec.suggestedValue);
      console.log(`[ApplyRec] Applied to all ${t.sampleCount} samples via default value: "${rec.suggestedValue}"`);
      return;
    }

    // Apply the recommendation value to all affected samples in bulk
    this.setCellValuesBulk(rec.columnIndex, sampleIndices, rec.suggestedValue);
    console.log(`[ApplyRec] Applied recommendation to ${rec.column}: "${rec.suggestedValue}" for ${sampleIndices.length} samples`);
  }

  /**
   * Finds all sample indices that have a specific value in a column.
   */
  private findSamplesWithValue(column: SdrfColumn, value: string, totalSamples: number): number[] {
    const normalizedValue = value.toLowerCase().trim();
    const normalizedDefault = column.value.toLowerCase().trim();
    const samples: number[] = [];

    // Check the default value
    const defaultMatches = normalizedDefault === normalizedValue;

    console.log(`[FindSamples] Searching for: "${normalizedValue}"`);
    console.log(`[FindSamples] Column default: "${normalizedDefault}", matches=${defaultMatches}`);
    console.log(`[FindSamples] Modifiers count: ${column.modifiers.length}`);

    // Build a set of samples covered by modifiers
    const modifierSamples = new Set<number>();
    for (const modifier of column.modifiers) {
      const normalizedModifier = modifier.value.toLowerCase().trim();
      const modifierMatches = normalizedModifier === normalizedValue;
      const samplesInRange = this.parseSampleRange(modifier.samples);

      console.log(`[FindSamples] Modifier: "${normalizedModifier}", matches=${modifierMatches}, samples=${samplesInRange.length}`);

      for (const s of samplesInRange) {
        modifierSamples.add(s);
        if (modifierMatches) {
          samples.push(s);
        }
      }
    }

    // If default matches, add all samples not covered by modifiers
    if (defaultMatches) {
      for (let i = 1; i <= totalSamples; i++) {
        if (!modifierSamples.has(i)) {
          samples.push(i);
        }
      }
      console.log(`[FindSamples] Added ${totalSamples - modifierSamples.size} samples from default value`);
    }

    console.log(`[FindSamples] Total samples found: ${samples.length}`);
    return samples;
  }

  /**
   * Parses a sample range string like "1-3,5,7-10" into an array of sample indices.
   */
  private parseSampleRange(rangeString: string): number[] {
    const samples: number[] = [];
    const parts = rangeString.split(',');

    for (const part of parts) {
      const trimmed = part.trim();
      if (trimmed.includes('-')) {
        const [start, end] = trimmed.split('-').map(Number);
        if (!isNaN(start) && !isNaN(end)) {
          for (let i = start; i <= end; i++) {
            samples.push(i);
          }
        }
      } else {
        const num = Number(trimmed);
        if (!isNaN(num)) {
          samples.push(num);
        }
      }
    }

    return samples;
  }

  /**
   * Sets the default value for a column (used when applying to all samples).
   */
  private setColumnDefaultValue(colIndex: number, value: string): void {
    const t = this.table();
    if (!t || colIndex >= t.columns.length) return;

    const newTable = { ...t, columns: [...t.columns] };
    const column = { ...newTable.columns[colIndex] };

    // Set new default value and clear all modifiers (since all samples now have this value)
    column.value = value;
    column.modifiers = [];

    newTable.columns[colIndex] = column;
    this.table.set(newTable);
    this.tableChange.emit(newTable);
  }

  /**
   * Sets cell values for multiple samples in bulk (more efficient than calling setCellValue in a loop).
   */
  private setCellValuesBulk(colIndex: number, sampleIndices: number[], value: string): void {
    const t = this.table();
    if (!t || colIndex >= t.columns.length) return;

    const newTable = { ...t, columns: [...t.columns] };
    const column = { ...newTable.columns[colIndex], modifiers: [...newTable.columns[colIndex].modifiers] };

    // Group samples: those setting to default vs those needing modifiers
    const sampleSet = new Set(sampleIndices);

    if (value === column.value) {
      // Setting to default value - remove these samples from modifiers
      column.modifiers = column.modifiers.map(m => {
        const modifierSamples = this.parseSampleRange(m.samples);
        const remainingSamples = modifierSamples.filter(s => !sampleSet.has(s));
        if (remainingSamples.length === 0) {
          return null; // Remove this modifier entirely
        }
        return { ...m, samples: this.compactSampleRange(remainingSamples) };
      }).filter((m): m is { samples: string; value: string } => m !== null);
    } else {
      // Setting to a new value
      // First, remove these samples from any existing modifiers
      column.modifiers = column.modifiers.map(m => {
        const modifierSamples = this.parseSampleRange(m.samples);
        const remainingSamples = modifierSamples.filter(s => !sampleSet.has(s));
        if (remainingSamples.length === 0) {
          return null;
        }
        return { ...m, samples: this.compactSampleRange(remainingSamples) };
      }).filter((m): m is { samples: string; value: string } => m !== null);

      // Then add a new modifier for these samples with the new value
      // Check if there's an existing modifier with this value to merge with
      const existingModifier = column.modifiers.find(m => m.value === value);
      if (existingModifier) {
        const existingSamples = this.parseSampleRange(existingModifier.samples);
        const mergedSamples = [...new Set([...existingSamples, ...sampleIndices])].sort((a, b) => a - b);
        existingModifier.samples = this.compactSampleRange(mergedSamples);
      } else {
        column.modifiers.push({
          samples: this.compactSampleRange(sampleIndices.sort((a, b) => a - b)),
          value
        });
      }
    }

    newTable.columns[colIndex] = column;
    this.table.set(newTable);
    this.tableChange.emit(newTable);
  }

  /**
   * Compacts an array of sample indices into a range string (e.g., [1,2,3,5,7,8,9] -> "1-3,5,7-9").
   */
  private compactSampleRange(samples: number[]): string {
    if (samples.length === 0) return '';
    if (samples.length === 1) return String(samples[0]);

    const sorted = [...samples].sort((a, b) => a - b);
    const ranges: string[] = [];
    let start = sorted[0];
    let end = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === end + 1) {
        end = sorted[i];
      } else {
        ranges.push(start === end ? String(start) : `${start}-${end}`);
        start = sorted[i];
        end = sorted[i];
      }
    }
    ranges.push(start === end ? String(start) : `${start}-${end}`);

    return ranges.join(',');
  }

  isRowSelected(rowIndex: number): boolean {
    return this.selectedSamples().has(rowIndex);
  }

  toggleRowSelection(rowIndex: number, event: Event): void {
    const checkbox = event.target as HTMLInputElement;
    const newSelection = new Set(this.selectedSamples());

    if (checkbox.checked) {
      newSelection.add(rowIndex);
    } else {
      newSelection.delete(rowIndex);
    }

    this.selectedSamples.set(newSelection);
    this.lastSelectedRow = rowIndex;
  }

  onRowHeaderClick(rowIndex: number, event: MouseEvent): void {
    const newSelection = new Set(this.selectedSamples());

    if (event.shiftKey && this.lastSelectedRow !== null) {
      // Range selection
      const start = Math.min(this.lastSelectedRow, rowIndex);
      const end = Math.max(this.lastSelectedRow, rowIndex);
      for (let i = start; i <= end; i++) {
        newSelection.add(i);
      }
    } else if (event.ctrlKey || event.metaKey) {
      // Toggle selection
      if (newSelection.has(rowIndex)) {
        newSelection.delete(rowIndex);
      } else {
        newSelection.add(rowIndex);
      }
    } else {
      // Single selection
      newSelection.clear();
      newSelection.add(rowIndex);
    }

    this.selectedSamples.set(newSelection);
    this.lastSelectedRow = rowIndex;
  }

  isAllVisibleSelected(): boolean {
    const visible = this.visibleRows();
    if (visible.length === 0) return false;
    return visible.every(r => this.selectedSamples().has(r));
  }

  isSomeVisibleSelected(): boolean {
    const visible = this.visibleRows();
    const selected = this.selectedSamples();
    const someSelected = visible.some(r => selected.has(r));
    const allSelected = visible.every(r => selected.has(r));
    return someSelected && !allSelected;
  }

  toggleSelectAllVisible(): void {
    const visible = this.visibleRows();
    const newSelection = new Set(this.selectedSamples());

    if (this.isAllVisibleSelected()) {
      // Deselect all visible
      for (const r of visible) {
        newSelection.delete(r);
      }
    } else {
      // Select all visible
      for (const r of visible) {
        newSelection.add(r);
      }
    }

    this.selectedSamples.set(newSelection);
  }

  clearSelection(): void {
    this.selectedSamples.set(new Set());
    this.selectedColumnForBulk.set(null);
    this.lastSelectedRow = null;
  }

  // ============ Context Menu Methods ============

  onCellContextMenu(event: MouseEvent, row: number, col: number): void {
    event.preventDefault();
    this.contextMenu.set({
      x: event.clientX,
      y: event.clientY,
      row,
      col,
    });
  }

  closeContextMenu(): void {
    this.contextMenu.set(null);
  }

  selectAllWithSameValue(): void {
    const ctx = this.contextMenu();
    if (!ctx) return;

    const value = this.getCellValue(ctx.row, ctx.col);
    const t = this.table();
    if (!t) return;

    const newSelection = new Set(this.selectedSamples());
    for (let i = 1; i <= t.sampleCount; i++) {
      if (this.getCellValue(i, ctx.col) === value) {
        newSelection.add(i);
      }
    }

    this.selectedSamples.set(newSelection);
    this.closeContextMenu();
  }

  selectAllInColumn(): void {
    const ctx = this.contextMenu();
    const t = this.table();
    if (!ctx || !t) return;

    // Select all samples in this column
    const newSelection = new Set<number>();
    for (let i = 1; i <= t.sampleCount; i++) {
      newSelection.add(i);
    }

    this.selectedSamples.set(newSelection);
    // Remember which column was selected for bulk operations
    this.selectedColumnForBulk.set(ctx.col);
    this.closeContextMenu();
  }

  editSelectedCells(): void {
    const ctx = this.contextMenu();
    if (ctx) {
      this.startEditing(ctx.row, ctx.col);
    }
    this.closeContextMenu();
  }

  clearSelectedCells(): void {
    const ctx = this.contextMenu();
    const selected = this.selectedSamples();
    if (!ctx || selected.size === 0) {
      this.closeContextMenu();
      return;
    }

    this.bulkSetValue(ctx.col, '', Array.from(selected));
    this.closeContextMenu();
  }

  // ============ Row Management Methods ============

  /**
   * Add a new row at the end of the table.
   */
  addRowAtEnd(): void {
    const t = this.table();
    if (!t) return;

    // Create new table with one more sample
    const newTable: SdrfTable = {
      ...t,
      sampleCount: t.sampleCount + 1,
      columns: t.columns.map((col) => {
        // If column has a single value, it applies to all samples including new one
        // If column has modifiers, we need to add a default value for the new sample
        if (col.modifiers.length > 0) {
          return {
            ...col,
            modifiers: [
              ...col.modifiers,
              {
                samples: `${t.sampleCount + 1}`,
                value: '',
              },
            ],
          };
        }
        return col;
      }),
    };

    this.table.set(newTable);
    this.closeContextMenu();
  }

  /**
   * Insert a row above the current context menu row.
   */
  insertRowAbove(): void {
    const ctx = this.contextMenu();
    if (!ctx) return;
    this.insertRowAt(ctx.row);
  }

  /**
   * Insert a row below the current context menu row.
   */
  insertRowBelow(): void {
    const ctx = this.contextMenu();
    if (!ctx) return;
    this.insertRowAt(ctx.row + 1);
  }

  /**
   * Insert a row at a specific position (1-based).
   */
  private insertRowAt(position: number): void {
    const t = this.table();
    if (!t) return;

    // Adjust all sample ranges in modifiers
    const newColumns = t.columns.map((col) => {
      if (col.modifiers.length === 0) {
        // Single value column - add modifier for new row
        return {
          ...col,
          modifiers: [
            {
              samples: `${position}`,
              value: '',
            },
          ],
        };
      }

      // Shift existing modifiers and add new row
      const newModifiers = col.modifiers.map((mod) => {
        const ranges = mod.samples.split(',').map((r: string) => {
          if (r.includes('-')) {
            const [start, end] = r.split('-').map(Number);
            const newStart = start >= position ? start + 1 : start;
            const newEnd = end >= position ? end + 1 : end;
            return `${newStart}-${newEnd}`;
          }
          const idx = parseInt(r);
          return idx >= position ? `${idx + 1}` : r;
        });
        return { ...mod, samples: ranges.join(',') };
      });

      // Add new row modifier
      newModifiers.push({
        samples: `${position}`,
        value: '',
      });

      return { ...col, modifiers: newModifiers };
    });

    const newTable: SdrfTable = {
      ...t,
      sampleCount: t.sampleCount + 1,
      columns: newColumns,
    };

    this.table.set(newTable);
    this.closeContextMenu();
  }

  /**
   * Delete selected rows from the table.
   */
  deleteSelectedRows(): void {
    const t = this.table();
    const selected = this.selectedSamples();
    if (!t || selected.size === 0) {
      this.closeContextMenu();
      return;
    }

    const rowsToDelete = Array.from(selected).sort((a, b) => b - a); // Delete from end first

    const newColumns = t.columns.map((col) => {
      if (col.modifiers.length === 0) {
        // Single value column - no change needed except sample count
        return col;
      }

      // Filter and adjust modifiers
      let newModifiers = col.modifiers.filter((mod) => {
        // Check if this modifier covers any of the deleted rows
        const ranges = mod.samples.split(',');
        for (const range of ranges) {
          if (range.includes('-')) {
            const [start, end] = range.split('-').map(Number);
            // If range is completely within deleted rows, filter it out
            const allDeleted = Array.from({ length: end - start + 1 }, (_, i) => start + i)
              .every((idx) => selected.has(idx));
            if (!allDeleted) return true;
          } else {
            if (!selected.has(parseInt(range))) return true;
          }
        }
        return false;
      });

      // Adjust remaining modifier ranges
      for (const deletedRow of rowsToDelete) {
        newModifiers = newModifiers.map((mod) => {
          const ranges = mod.samples.split(',').map((r: string) => {
            if (r.includes('-')) {
              const [start, end] = r.split('-').map(Number);
              const newStart = start > deletedRow ? start - 1 : start;
              const newEnd = end > deletedRow ? end - 1 : end;
              return `${newStart}-${newEnd}`;
            }
            const idx = parseInt(r);
            return idx > deletedRow ? `${idx - 1}` : r;
          });
          return { ...mod, samples: ranges.join(',') };
        });
      }

      return { ...col, modifiers: newModifiers };
    });

    const newSampleCount = t.sampleCount - selected.size;

    const newTable: SdrfTable = {
      ...t,
      sampleCount: newSampleCount,
      columns: newColumns,
    };

    this.table.set(newTable);
    this.clearSelection();
    this.closeContextMenu();
  }

  // ============ Column Management Methods ============

  /** Signal for add column dialog visibility */
  showAddColumnDialogFlag = signal(false);
  newColumnName = signal('');

  /**
   * Show dialog to add a new column.
   */
  showAddColumnDialog(): void {
    this.showAddColumnDialogFlag.set(true);
    this.newColumnName.set('');
    this.closeContextMenu();
  }

  /**
   * Close the add column dialog.
   */
  closeAddColumnDialog(): void {
    this.showAddColumnDialogFlag.set(false);
    this.newColumnName.set('');
  }

  /**
   * Add a new column to the table at the correct section position.
   * SDRF column order: source_name → characteristics → comments → factor_value
   */
  addNewColumn(): void {
    const name = this.newColumnName().trim();
    if (!name) return;

    const t = this.table();
    if (!t) return;

    // Determine column type from name
    let type: 'characteristics' | 'comment' | 'factor_value' | 'special' = 'special';
    const lowerName = name.toLowerCase();
    if (lowerName.startsWith('characteristics[')) {
      type = 'characteristics';
    } else if (lowerName.startsWith('comment[')) {
      type = 'comment';
    } else if (lowerName.startsWith('factor value[')) {
      type = 'factor_value';
    }

    // Find the correct insertion position based on column type order
    const insertPosition = this.findColumnInsertPosition(t.columns, type);

    const newColumn: SdrfColumn = {
      name,
      type,
      columnPosition: insertPosition,
      value: '',
      modifiers: [],
      isRequired: false,
    };

    // Insert column at the correct position and update positions
    const newColumns = [...t.columns];
    newColumns.splice(insertPosition, 0, newColumn);
    // Update columnPosition for all columns after the insertion
    for (let i = insertPosition; i < newColumns.length; i++) {
      newColumns[i] = { ...newColumns[i], columnPosition: i };
    }

    const newTable: SdrfTable = {
      ...t,
      columns: newColumns,
    };

    this.table.set(newTable);
    this.closeAddColumnDialog();
  }

  /**
   * Find the correct insertion position for a new column based on type.
   * Order: source_name → characteristics → comments → factor_value → special
   */
  private findColumnInsertPosition(
    columns: SdrfColumn[],
    type: 'characteristics' | 'comment' | 'factor_value' | 'special'
  ): number {
    // Type priority order (lower = earlier in table)
    const typePriority: Record<string, number> = {
      'source_name': 0,
      'characteristics': 1,
      'comment': 2,
      'factor_value': 3,
      'special': 4,
    };

    const newTypePriority = typePriority[type] ?? 4;

    // Find the last column of the same type
    let lastSameTypeIndex = -1;
    // Find the first column with higher priority (comes after this type)
    let firstHigherPriorityIndex = columns.length;

    for (let i = 0; i < columns.length; i++) {
      const colType = columns[i].type;
      const colPriority = typePriority[colType] ?? 4;

      if (colType === type) {
        lastSameTypeIndex = i;
      } else if (colPriority > newTypePriority && firstHigherPriorityIndex === columns.length) {
        firstHigherPriorityIndex = i;
      }
    }

    // If we found columns of the same type, insert after the last one
    if (lastSameTypeIndex >= 0) {
      return lastSameTypeIndex + 1;
    }

    // Otherwise, insert before the first column of higher priority type
    return firstHigherPriorityIndex;
  }

  /**
   * Delete the column from context menu.
   */
  deleteColumn(): void {
    const ctx = this.contextMenu();
    const t = this.table();
    if (!ctx || !t) return;

    const colIndex = ctx.col;
    if (colIndex < 0 || colIndex >= t.columns.length) {
      this.closeContextMenu();
      return;
    }

    const columnName = t.columns[colIndex].name;
    if (!confirm(`Delete column "${columnName}"? This cannot be undone.`)) {
      this.closeContextMenu();
      return;
    }

    const newColumns = t.columns
      .filter((_, idx) => idx !== colIndex)
      .map((col, idx) => ({ ...col, columnPosition: idx }));

    const newTable: SdrfTable = {
      ...t,
      columns: newColumns,
    };

    this.table.set(newTable);
    this.closeContextMenu();
  }

  // ============ Bulk Edit Methods ============

  onSelectByValue(event: SelectByValueEvent): void {
    const newSelection = new Set(this.selectedSamples());
    for (const idx of event.sampleIndices) {
      newSelection.add(idx);
    }
    this.selectedSamples.set(newSelection);
  }

  onSelectSamples(indices: number[]): void {
    this.selectedSamples.set(new Set(indices));
  }

  onStatsPanelBulkEdit(event: BulkEditEvent): void {
    this.bulkSetValue(event.columnIndex, event.newValue, event.sampleIndices);
  }

  onBulkColumnEdit(event: BulkColumnEditEvent): void {
    this.bulkSetValue(event.columnIndex, event.newValue, event.sampleIndices);
  }

  onCopyFromFirst(columnIndex: number): void {
    const selected = Array.from(this.selectedSamples()).sort((a, b) => a - b);
    if (selected.length < 2) return;

    const firstValue = this.getCellValue(selected[0], columnIndex);
    const restIndices = selected.slice(1);
    this.bulkSetValue(columnIndex, firstValue, restIndices);
  }

  private bulkSetValue(columnIndex: number, newValue: string, sampleIndices: number[]): void {
    const t = this.table();
    if (!t || columnIndex >= t.columns.length) return;

    // Clone the table
    const newTable = { ...t, columns: [...t.columns] };
    const column = { ...newTable.columns[columnIndex], modifiers: [...newTable.columns[columnIndex].modifiers] };

    // Apply value to all samples
    for (const sampleIndex of sampleIndices) {
      setValueForSample(column, sampleIndex, newValue);
    }

    newTable.columns[columnIndex] = column;
    this.table.set(newTable);
    this.tableChange.emit(newTable);

    console.log(`Bulk updated ${sampleIndices.length} samples in column "${column.name}" to "${newValue}"`);
  }

  // ============ Column Type Methods ============

  /**
   * Gets the CSS class for a column based on its name/type.
   * SDRF columns are categorized into 4 groups:
   * - source: Sample Accession (source name)
   * - characteristic: Sample Properties (characteristics[...])
   * - comment: Data Properties (comment[...], assay name, technology type, etc.)
   * - factor: Factor Values (factor value[...])
   */
  getColumnTypeClass(columnName: string): string {
    const name = columnName.toLowerCase().trim();

    // Sample Accession - Green (sample identifiers)
    if (name === 'source name' || name === 'sample name') {
      return 'source';
    }

    // Sample Properties - Blue (characteristics about the sample)
    if (name.startsWith('characteristics[')) {
      return 'characteristic';
    }

    // Factor Values - Orange (experimental variables)
    if (name.startsWith('factor value[') || name.startsWith('factorvalue[')) {
      return 'factor';
    }

    // Data Properties - Gray (everything else: comments, assay, technical, files)
    // This includes: comment[...], assay name, technology type, data files, etc.
    return 'comment';
  }

  /**
   * Gets the tooltip text for a column header.
   * Combines description, examples, and ontology info from column config.
   */
  getColumnTooltip(columnName: string): string {
    const config = getSdrfColumnConfig(columnName);
    if (!config) {
      return columnName;
    }

    const parts: string[] = [];

    // Description
    if (config.description) {
      parts.push(config.description);
    }

    // Required indicator
    if (config.isRequired) {
      parts.push('(Required column)');
    }

    // Ontologies
    if (config.ontologies && config.ontologies.length > 0) {
      parts.push(`Ontologies: ${config.ontologies.join(', ')}`);
    }

    // Examples
    if (config.examples && config.examples.length > 0) {
      const exampleList = config.examples.slice(0, 3).join(', ');
      parts.push(`Examples: ${exampleList}`);
    }

    return parts.length > 0 ? parts.join('\n') : columnName;
  }

  // ============ Sorting Methods ============

  onHeaderClick(columnIndex: number, event: MouseEvent): void {
    // If clicking for selection (with modifier) don't sort
    if (event.ctrlKey || event.metaKey || event.shiftKey) {
      this.selectColumn(columnIndex);
      return;
    }

    // Toggle sort
    if (this.sortColumn() === columnIndex) {
      if (this.sortDirection() === 'asc') {
        this.sortDirection.set('desc');
      } else {
        // Clear sort
        this.sortColumn.set(-1);
        this.sortedIndices.set([]);
        return;
      }
    } else {
      this.sortColumn.set(columnIndex);
      this.sortDirection.set('asc');
    }

    this.applySorting();
  }

  private applySorting(): void {
    const t = this.table();
    const colIndex = this.sortColumn();
    if (!t || colIndex < 0) {
      this.sortedIndices.set([]);
      return;
    }

    // Build array of [sampleIndex, value] pairs
    const pairs: [number, string][] = [];
    for (let i = 1; i <= t.sampleCount; i++) {
      pairs.push([i, this.getCellValue(i, colIndex)]);
    }

    // Sort by value
    const dir = this.sortDirection() === 'asc' ? 1 : -1;
    pairs.sort((a, b) => {
      const valA = a[1].toLowerCase();
      const valB = b[1].toLowerCase();

      // Try numeric comparison first
      const numA = parseFloat(valA);
      const numB = parseFloat(valB);
      if (!isNaN(numA) && !isNaN(numB)) {
        return (numA - numB) * dir;
      }

      // Fall back to string comparison
      return valA.localeCompare(valB) * dir;
    });

    this.sortedIndices.set(pairs.map(p => p[0]));
  }

  /**
   * Gets the actual sample index for a display row (accounts for sorting).
   */
  getActualRowIndex(displayIndex: number): number {
    const sorted = this.sortedIndices();
    if (sorted.length === 0) {
      return displayIndex;
    }
    return sorted[displayIndex - 1] || displayIndex;
  }

  // ============ Filter Methods ============

  toggleFilterBar(): void {
    this.showFilterBar.set(!this.showFilterBar());
  }

  onFilterChange(result: FilterResult): void {
    if (result.matchingIndices.length === result.totalCount) {
      // No filter active
      this.filteredIndices.set([]);
    } else {
      this.filteredIndices.set(result.matchingIndices);
    }

    // Reset scroll position when filter changes
    this.scrollTop.set(0);
    if (this.scrollContainer) {
      this.scrollContainer.nativeElement.scrollTop = 0;
    }
  }

  // ============ Wizard Methods ============

  openWizard(): void {
    this.showWizard.set(true);
    // The wizard assistant lives on the backend, so re-probe it every time the
    // wizard opens; the panel only appears once we know it is reachable.
    void this.assistantApi.checkHealth();
  }

  closeWizard(): void {
    this.showWizard.set(false);
  }

  onWizardComplete(table: SdrfTable): void {
    this.showWizard.set(false);
    this.table.set(table);
    this.tableChange.emit(table);

    // Reset any previous state
    this.selectedCell.set(null);
    this.clearSelection();
    this.filteredIndices.set([]);
    this.scrollTop.set(0);

    // Trigger validation
    this.validate();
  }

  isAiConfigured(): boolean {
    // Two independent paths: the wizard assistant runs on the backend, while the
    // editor's recommendation panel uses browser-side providers.
    return this.assistantApi.available() || llmSettingsService.isAnyProviderConfigured();
  }
}
