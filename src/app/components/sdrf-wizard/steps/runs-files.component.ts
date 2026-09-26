/**
 * Runs & Files — Step 4
 *
 * Left: manage MS runs.
 * Right (per run): add files (modal) → fill F → fill Tech → channels → editable table.
 */

import {
  Component,
  Input,
  OnInit,
  inject,
  signal,
  computed,
  effect,
  HostListener,
  ChangeDetectionStrategy,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { parseFileNameList } from '../../../core/utils/file-name-list';

import { WizardStateService } from '../../../core/services/wizard-state.service';
import {
  fetchPrideRawFileNames,
  normalizePxdAccession,
  isValidPxdAccession,
} from '../../../core/services/pride-archive.service';
import {
  LABEL_CONFIGS,
  groupSamplesByFactors,
  WizardMsRun,
  WizardDataFile,
  WizardChannelAssignment,
  countUsedChannels,
  buildWizardExpansionRows,
  resolveRunLabelConfigId,
  labelConfigDisplayName,
  estimatePlannerSdrfRows,
  estimatePlannerFileSlots,
  plannedFractionCount,
  plannedTechRepCount,
  parseFractionTechFromName,
} from '../../../core/models/wizard';

type ImportTab = 'pxd' | 'paste' | 'upload';
type FillMode = 'all1' | 'seq' | 'custom';
type AcquisitionMethod = 'dda' | 'dia' | 'prm' | 'srm';

const ACQUISITION: { id: AcquisitionMethod; label: string }[] = [
  { id: 'dda', label: 'DDA' },
  { id: 'dia', label: 'DIA' },
  { id: 'prm', label: 'PRM' },
  { id: 'srm', label: 'SRM' },
];

@Component({
  selector: 'wizard-runs-files',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="rf">
      <!-- Import -->
      <section class="question-region" aria-labelledby="raw-files-question">
        <header class="question-header">
          <span class="question-number" aria-hidden="true">1</span>
          <div class="question-heading"><h3 id="raw-files-question">Which raw files belong to your experiment?</h3><p class="step-description">Import file names from ProteomeXchange, paste a list, or upload a file list.</p></div>
          <span class="question-badge">Required</span>
        </header>
        <div class="question-body">
        <div class="import-tabs">
          <button type="button" class="import-tab" [class.on]="importTab() === 'pxd'" (click)="importTab.set('pxd')">
            ProteomeXchange
          </button>
          <button type="button" class="import-tab" [class.on]="importTab() === 'paste'" (click)="importTab.set('paste')">
            Paste list
          </button>
          <button type="button" class="import-tab" [class.on]="importTab() === 'upload'" (click)="importTab.set('upload')">
            Upload file
          </button>
        </div>
        <div class="import-body">
          @if (importTab() === 'pxd') {
            <div class="row">
              <input class="input mono grow" placeholder="PXD000547"
                [ngModel]="pxdInput()" (ngModelChange)="pxdInput.set($event)"
                (keydown.enter)="fetchFromPxd()" />
              <button type="button" class="btn accent" [disabled]="pxdLoading() || !pxdInput().trim()"
                (click)="fetchFromPxd()">{{ pxdLoading() ? 'Fetching…' : 'Fetch' }}</button>
            </div>
          } @else if (importTab() === 'paste') {
            <textarea class="textarea mono" rows="4" placeholder='Separate filenames with spaces, commas, semicolons, tabs or newlines. Use double quotes for names containing spaces.'
              [ngModel]="pasteText()" (ngModelChange)="pasteText.set($event)"></textarea>
            <div class="row gap">
              <button type="button" class="btn accent" (click)="applyPaste(false)">Replace pool</button>
              <button type="button" class="btn" (click)="applyPaste(true)">Append</button>
            </div>
          } @else {
            <label class="upload">
              <input type="file" accept=".txt,.csv,.tsv,text/plain,text/csv" (change)="onUploadSelected($event)" />
              @if (uploadFileName()) {
                <span class="mono">{{ uploadFileName() }}</span>
                <span class="muted">{{ uploadNames().length }} name(s) parsed</span>
              } @else {
                <span>Drop or click · .txt / .csv / .tsv</span>
              }
            </label>
            <div class="row gap">
              <button type="button" class="btn accent" [disabled]="!uploadNames().length" (click)="applyUpload(false)">Replace pool</button>
              <button type="button" class="btn" [disabled]="!uploadNames().length" (click)="applyUpload(true)">Append</button>
            </div>
          }
        </div>
        </div>
      </section>

      @if (statusMsg()) {
        <div class="toast" [class.err]="statusError()">{{ statusMsg() }}</div>
      }

      <section class="question-region" aria-labelledby="grouping-question">
        <header class="question-header"><span class="question-number" aria-hidden="true">2</span><div class="question-heading"><h3 id="grouping-question">How would you like to group samples to map their metadata to raw files?</h3></div></header>
        <div class="question-body">
          <label class="grouping-label">Grouping method <select class="input" [ngModel]="groupingMode()" (ngModelChange)="changeGroupingMode($event)"><option value="all">All samples</option><option value="factors">Study factors</option><option value="custom">Custom groups</option></select></label>
          @if (groupingMode() === 'factors') {
            <div class="group-members" role="group" aria-label="Factors defining groups">
              @for (factor of sampleGroupingFactors(); track factor.name) { <label><input type="checkbox" [checked]="groupingFactors().includes(factor.name)" (change)="toggleGroupingFactor(factor.name, $any($event.target).checked)" /> {{ factor.name }}</label> }
            </div>
          }
          @if (groupingMode() === 'custom') {
            @for (group of customGroups(); track $index; let gi = $index) {
              <div class="custom-group"><div class="row"><input class="input grow" aria-label="Group name" placeholder="Group name" [ngModel]="group.name" (ngModelChange)="renameCustomGroup(gi, $event)" /><button type="button" class="btn sm" (click)="removeCustomGroup(gi)">Remove</button></div><div class="group-members">@for (sample of state().samples; track sample.index) { <label><input type="checkbox" [checked]="group.members.includes(sample.index)" (change)="toggleGroupMember(gi, sample.index, $any($event.target).checked)" /> {{ sample.sourceName }}</label> }</div></div>
            }
            <button type="button" class="link" (click)="addCustomGroup()">＋ Add group</button>
          }
          @if (proposedGroups().length) {
            <div class="group-preview" aria-live="polite"><strong>{{ proposedGroups().length }} groups</strong>@for (group of proposedGroups(); track $index) { <div class="group-preview-row"><span>{{ groupPreviewName(group.name) || 'Unnamed group' }}</span><span class="group-preview-count">{{ group.members.length }} samples</span></div> }</div>
          }
          @if (groupingAffectedFiles()) { <p class="help">{{ groupingAffectedFiles() }} files will return to the pool.</p> }
          @if (groupingPending()) {
            <div class="row"><span class="help">{{ msRuns().length }} current groups → {{ proposedGroups().length }} new groups</span><button type="button" class="btn accent" (click)="applyGrouping()">Apply {{ proposedGroups().length }} groups</button></div>
          }
          @if (groupingError()) { <p class="toast err" role="alert">{{ groupingError() }}</p> }
        </div>
      </section>
      <!-- Workspace -->
      <section class="question-region" aria-labelledby="run-setup-question">
        <header class="question-header">
          <span class="question-number" aria-hidden="true">3</span>
          <div class="question-heading"><h3 id="run-setup-question">How are samples and files linked within each group?</h3><p class="step-description">Select a group, choose its labels and mapping, then assign files to samples or pools.</p></div>
          <span class="question-badge">Required</span>
        </header>
        <div class="question-body">
          <div class="run-summary"><span>{{ unassignedCount() }} files in pool · {{ msRuns().length }} groups · {{ sdrfRowCount() }} SDRF rows</span><button type="button" class="btn sm" [class.on]="showMore()" (click)="showMore.set(!showMore())">Planner &amp; options</button></div>
      @if (showMore()) {
        <div class="drawer">
          <div class="more-grid">
            <label>Default kit
              <select class="input" [ngModel]="state().labelConfigId" (ngModelChange)="selectDefaultKit($event)">
                @for (c of kits(); track c.id) {
                  <option [value]="c.id">{{ c.name }}</option>
                }
              </select>
            </label>
            <div>
              <div class="lbl">Expected fractions</div>
              <div class="row gap">
                <button type="button" class="btn sm" [class.on]="!state().hasFractions" (click)="wizardState.setHasFractions(false)">Off</button>
                <button type="button" class="btn sm" [class.on]="state().hasFractions" (click)="wizardState.setHasFractions(true)">On</button>
                @if (state().hasFractions) {
                  <input type="number" class="num" min="1" [ngModel]="state().fractionCount"
                    (ngModelChange)="wizardState.setFractionCount($event)" />
                }
              </div>
            </div>
            <label>Tech reps
              <input type="number" class="num" min="1" [ngModel]="state().technicalReplicates"
                (ngModelChange)="wizardState.setTechnicalReplicates($event)" />
            </label>
            <div>
              <div class="lbl">Acquisition</div>
              <div class="row gap">
                @for (a of acquisition; track a.id) {
                  <button type="button" class="btn sm" [class.on]="state().acquisitionMethod === a.id"
                    (click)="wizardState.setAcquisitionMethod(a.id)">{{ a.label }}</button>
                }
              </div>
            </div>
          </div>
          <p class="hint">
            Planner ≈ {{ estimatedFiles() }} slots · {{ estimatedRows() }} rows.
            <button type="button" class="link" (click)="regenerateFromPlanner()">Generate planner slots</button>
            ·
            <button type="button" class="link" (click)="wizardState.autoPackSamplesIntoRuns()">Auto-pack samples</button>
          </p>
        </div>
      }

      <div class="workspace">
        <nav class="rail">
          <div class="rail-h">
            <span>Sample groups</span>
            <button type="button" class="icon" title="Add custom group" (click)="startCustomGrouping()">+</button>
          </div>
          <div class="group-tabs">
          @for (run of msRuns(); track run.id) {
            <div class="rail-item" role="button" tabindex="0" (keydown.enter)="selectRun(run.id)" (keydown.space)="$event.preventDefault(); selectRun(run.id)" [class.active]="selectedRunId() === run.id"
              (click)="selectRun(run.id)">
              <span class="rail-title">
                @if (selectedRunId() === run.id) {
                  <input class="rail-name" [ngModel]="groupDisplayName(run)"
                    (click)="$event.stopPropagation()"
                    (ngModelChange)="wizardState.renameMsRun(run.id, $event)"
                    aria-label="Group name" />
                } @else {
                  <span class="rail-name-text">{{ groupDisplayName(run) }}</span>
                }
                <span class="kit">{{ kitShort(run) }}</span>
              </span>
              <span class="count">{{ filesForRun(run.id).length }}</span>
            </div>
          }
          </div>
          @if (msRuns().length === 0) {
            <p class="empty-rail">Click + to add a run</p>
          }
          <div class="pool-note">
            Pool: <strong>{{ unassignedCount() }}</strong> unassigned
          </div>
        </nav>

        <section class="pane">
          @if (activeRun(); as run) {
              @if (runFactors().length) {
                <div class="block">
                  <h4>Which technical conditions are studied in this run?</h4>
                  <p class="help">Choose a value for every enabled technical factor before continuing.</p>
                  <p class="help">Assign the conditions studied in this run. The same biological sample can appear in runs with different conditions.</p>
                  @for (factor of runFactors(); track factor.name) {
                    <label>{{ factor.name }}</label>
                    <select class="input" [ngModel]="run.factorValues?.[factor.name] || (factor.values.length === 1 ? factor.values[0] : '')"
                      (ngModelChange)="wizardState.setRunFactorValue(run.id, factor.name, $event)">
                      <option value="">Select…</option>
                      @for (value of factor.values; track value) { <option [value]="value">{{ value }}</option> }
                    </select>
                  }
                </div>
              }
              <!-- Step 1: label kit -->
              <div class="block">
                <div class="block-h">
                  <h4>Which labeling method was used?</h4>
                  <button type="button" class="btn danger" [disabled]="msRuns().length <= 1"
                    (click)="removeRun(run.id)">Delete</button>
                </div>
                <p class="help">Pick the plex / label-free kit used for this run. This defines the channels below.</p>
                <select class="input kit-select" [ngModel]="runKitId(run)"
                  (ngModelChange)="onRunKitChange(run.id, $event)">
                  @for (c of kits(); track c.id) {
                    <option [value]="c.id">{{ c.name }}</option>
                  }
                </select>
              </div>

              <!-- Step 2: channel ↔ sample -->
              <div class="block">
                <div class="block-h">
                  <h4>{{ runKitId(run) === 'lf' ? 'Which samples and files belong together?' : 'Which samples belong to each channel?' }}</h4>
                </div>
                <div class="channel-list">
                  @for (ch of run.channels; track ch.mappingId || ch.label; let ci = $index) {
                    <div class="mapping-entry" [class.lf-entry]="runKitId(run) === 'lf'">
                    <div class="mapping-card">
                    <div class="channel-row" [class.open]="samplePickerCi() === ci"
                      [class.filled]="channelSampleCount(ch) > 0">
                      <span class="mono label-tag">{{ runKitId(run) === 'lf' ? 'Label-free' : ch.label }}</span>
                      <select class="input" aria-label="Channel mapping mode" [ngModel]="ch.role === 'pooled' ? 'pooled' : 'single'" (ngModelChange)="setChannelMode(run.id, ci, $event)"><option value="single">Single sample</option><option value="pooled">Pooled sample</option></select>
                      <div class="sample-dd" data-sample-dd
                        [class.open]="samplePickerCi() === ci"
                        [class.has-value]="channelSampleCount(ch) > 0">
                        <button type="button" class="sample-trigger"
                          (click)="toggleSamplePicker(ci, $event)">
                          @if (channelSampleCount(ch) === 0) {
                            <span class="sample-ph">Select samples…</span>
                          } @else {
                            <span class="chip-wrap">
                              @for (name of channelSampleNames(ch); track name; let i = $index) {
                                @if (i < 4) {
                                  <span class="sel-chip" [class.pool]="channelSampleCount(ch) > 1">{{ name }}</span>
                                }
                              }
                              @if (channelSampleCount(ch) > 4) {
                                <span class="sel-chip more">+{{ channelSampleCount(ch) - 4 }}</span>
                              }
                            </span>
                            @if (channelSampleCount(ch) > 1) {
                              <span class="sel-count pool">pool {{ channelSampleCount(ch) }}</span>
                            } @else {
                              <span class="sel-count">1</span>
                            }
                          }
                          <span class="caret">▾</span>
                        </button>
                        @if (samplePickerCi() === ci) {
                          <div class="sample-menu" (click)="$event.stopPropagation()">
                            <div class="sample-menu-tools">
                              @if (ch.role === 'pooled') { <button type="button" class="link" (click)="channelSelectAll(run.id, ci)">All</button> }
                              <button type="button" class="link" (click)="channelClear(run.id, ci)">Clear</button>
                              @if (ch.role === 'pooled') { <span class="muted">Hold &amp; drag</span> }
                            </div>
                            <ul class="sample-menu-list" (mouseup)="endSampleDrag()">
                              @for (s of availableGroupSamples(); track s.index) {
                                <li
                                  class="sample-opt"
                                  [class.on]="isChannelSample(ch, s.index)"
                                  (mousedown)="startSampleDrag(run.id, ci, s.index, $event)"
                                  (mouseenter)="paintSampleDrag(run.id, ci, s.index)"
                                >
                                  <span class="tick" aria-hidden="true"></span>
                                  <span>{{ s.sourceName }}</span>
                                </li>
                              }
                            </ul>
                            @if (ch.role === 'pooled') {
                              <input class="input pool-name" placeholder="Pool name (optional)"
                                [ngModel]="ch.sourceNameOverride || ''"
                                (ngModelChange)="setChannelPoolName(run.id, ci, $event)" />
                            }
                          </div>
                        }
                      </div>
                      @if (runKitId(run) === 'lf') {
                        <div class="mapping-file-actions lf-actions">
                          <button type="button" class="btn sm" [disabled]="!canAssignRowFiles(ch)" (click)="openRowFiles(ch)">Select files</button>
                          <button type="button" class="link" (click)="removeRow(run.id, ch.mappingId!)">Remove</button>
                        </div>
                      }
                    </div>
                    </div>
                    @if (runKitId(run) === 'lf') {
                      <div class="mapping-files lf-files">
                        @if (ch.role === 'pooled' && !canAssignRowFiles(ch)) { <span class="muted">Choose at least two samples.</span> }
                        <ng-container *ngTemplateOutlet="fileMetadata; context: { run: run, mappingId: ch.mappingId }"></ng-container>
                      </div>
                    }
                    </div>
                  }
                </div>
                @if (runKitId(run) === 'lf') {
                  <button type="button" class="btn add-mapping" (click)="addRow(run.id)">+ Add sample or pool</button>
                } @else {
                  <div class="mapping-files shared-files">
                    <div class="mapping-file-actions"><span class="muted">Files shared by these channels</span><button type="button" class="btn sm" (click)="openFilePicker()">Select files</button></div>
                    <ng-container *ngTemplateOutlet="fileMetadata; context: { run: run, mappingId: undefined }"></ng-container>
                  </div>
                }
              </div>

          } @else {
            <div class="blank">
              <p class="blank-title">Select or create an MS run</p>
              <p class="blank-body">Add runs on the left, then attach raw files from the pool.</p>
              <button type="button" class="btn accent" (click)="addRun()">Add MS run</button>
            </div>
          }
        </section>
      </div>

        </div>
      </section>

      <section class="question-region" aria-labelledby="file-review-question">
        <header class="question-header">
          <span class="question-number" aria-hidden="true">4</span>
          <div class="question-heading"><h3 id="file-review-question">Review run and file metadata</h3><p class="step-description">Check sample mappings, fractions and technical replicates across all groups.</p></div>
          <span class="question-badge">Required</span>
        </header>
        <div class="question-body">
          <div class="run-summary"><span>{{ files().length - unassignedCount() }} files assigned · {{ sdrfRowCount() }} SDRF rows</span><button type="button" class="btn sm" [disabled]="files().length === unassignedCount()" (click)="guessAllFractionTech()">Guess F/Tech from names</button></div>
          @if (files().length === unassignedCount()) {
            <p class="muted">Assign files above to review their metadata.</p>
          } @else {
                  <div class="table-wrap review-table" tabindex="0" aria-label="Run and file metadata">
                    <table class="data edit">
                      <thead>
                        <tr>
                          <th style="width:28px"></th>
                          <th>Group</th><th>Raw file / assay</th>
                          <th>Samples / labels</th>
                          <th>Study factors</th>
                          <th style="width:72px">Fraction</th>
                          <th style="width:72px">Tech</th>
                          <th style="width:72px">→ rows</th>
                        </tr>
                      </thead>
                      <tbody>
                        @for (run of msRuns(); track run.id) {
                        @for (item of filesForRun(run.id); track item.index) {
                          <tr>
                            <td>
                              <button type="button" class="link danger" (click)="returnOne(item.index)">Remove</button>
                            </td>
                            <td>{{ groupDisplayName(run) }}</td>
                            <td>
                              <input class="input mono file" [ngModel]="item.file.fileName" [title]="item.file.fileName"
                                (ngModelChange)="wizardState.updateDataFile(item.index, { fileName: $event })" />
                            </td>
                            <td>{{ reviewFileSummary(item.index) }}</td>
                            <td>{{ factorSummary(run) }}</td>
                            <td>
                              <input type="number" class="num" min="1" [ngModel]="item.file.fractionId ?? 1"
                                (ngModelChange)="wizardState.updateDataFile(item.index, { fractionId: +$event || 1 })" />
                            </td>
                            <td>
                              <input type="number" class="num" min="1" [ngModel]="item.file.technicalReplicate ?? 1"
                                (ngModelChange)="wizardState.updateDataFile(item.index, { technicalReplicate: +$event || 1 })" />
                            </td>
                            <td class="accent-t">{{ reviewFileRows(item.index).length }}</td>
                          </tr>
                        }
                        }
                      </tbody>
                    </table>
                  </div>
          }
        </div>
      </section>

      @if (!wizardState.isRunsFilesValid()) {
        <div class="warn">
          <span class="bang">!</span>
          {{ validationHint() }}
        </div>
      }

      <ng-template #fileMetadata let-run="run" let-mappingId="mappingId">
        @if (metadataFiles(run.id, mappingId); as items) {
          @if (items.length) {
            <div class="metadata-tools"><span>{{ items.length }} files</span></div>
            <div class="table-wrap mapping-table"><table class="data"><thead><tr><th>Raw file</th><th><span class="numbering-header">Fraction<button type="button" class="numbering-arrow" title="Number Fraction 1 to N" aria-label="Number Fraction ascending" (click)="numberFiles(run.id, mappingId, 'fractionId', 'asc')">↑</button><button type="button" class="numbering-arrow" title="Number Fraction N to 1" aria-label="Number Fraction descending" (click)="numberFiles(run.id, mappingId, 'fractionId', 'desc')">↓</button></span></th><th><span class="numbering-header">Tech<button type="button" class="numbering-arrow" title="Number Tech 1 to N" aria-label="Number Tech ascending" (click)="numberFiles(run.id, mappingId, 'technicalReplicate', 'asc')">↑</button><button type="button" class="numbering-arrow" title="Number Tech N to 1" aria-label="Number Tech descending" (click)="numberFiles(run.id, mappingId, 'technicalReplicate', 'desc')">↓</button></span></th><th></th></tr></thead><tbody>
              @for (item of items; track item.index) {
                <tr><td class="metadata-filename">{{ item.file.fileName }}</td>
                  <td><input class="num" type="number" min="1" step="1" [attr.aria-label]="'Fraction for ' + item.file.fileName" [ngModel]="item.file.fractionId ?? 1" (ngModelChange)="updateFileMetadata(item.index, 'fractionId', $event)" /></td>
                  <td><input class="num" type="number" min="1" step="1" [attr.aria-label]="'Technical replicate for ' + item.file.fileName" [ngModel]="item.file.technicalReplicate ?? 1" (ngModelChange)="updateFileMetadata(item.index, 'technicalReplicate', $event)" /></td>
                  <td><button type="button" class="x" [attr.aria-label]="'Unassign ' + item.file.fileName" (click)="returnOne(item.index)">×</button></td>
                </tr>
              }
            </tbody></table></div>
          }
        }
      </ng-template>

      <!-- File picker modal -->
      @if (pickerOpen()) {
        <div class="modal-backdrop" (click)="closePicker()"></div>
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="picker-title">
          <div class="modal-h">
            <h4 id="picker-title">Add raw files to {{ pickerTargetName() }}</h4>
            <button type="button" class="icon" (click)="closePicker()">×</button>
          </div>
          <p class="help">
            Scroll and check files from the pool. Hold &amp; drag to select a range.
            Only unassigned files are shown.
          </p>
          <div class="modal-tools">
            <button type="button" class="link" (click)="pickerSelectAll()">Select all</button>
            <button type="button" class="link" (click)="pickerClear()">Clear</button>
            <span class="muted">{{ pickerSelected().size }} selected · {{ unassignedItems().length }} in pool</span>
          </div>
          <ul class="picker-list" (mouseup)="endPickerDrag()">
            @for (item of unassignedItems(); track item.index; let pos = $index) {
              <li class="picker-row" [class.on]="pickerSelected().has(item.index)"
                (mousedown)="startPickerDrag(pos, item.index, $event)"
                (mouseenter)="paintPickerDrag(pos)">
                <span class="check" [class.on]="pickerSelected().has(item.index)"></span>
                <span class="name mono" [title]="item.file.fileName"><bdi>{{ item.file.fileName }}</bdi></span>
              </li>
            }
          </ul>
          @if (unassignedItems().length === 0) {
            <p class="blank-body">Pool is empty. Import names above first.</p>
          }
          <div class="modal-f">
            <button type="button" class="btn" (click)="closePicker()">Cancel</button>
            <button type="button" class="btn accent" [disabled]="pickerSelected().size === 0"
              (click)="confirmPicker()">
              Add {{ pickerSelected().size || '' }} file(s)
            </button>
          </div>
        </div>
      }
    </div>
  `,
  styleUrls: ['./question-regions.css'],
  styles: [`
    :host { display: block; }
    .rf {
      --ink: #0f172a; --muted: #64748b; --line: #e2e8f0; --wash: #f8fafc;
      --accent: #2563eb; --accent-soft: #eff6ff; --warn: #b45309; --danger: #b91c1c;
      max-width: 1100px; color: var(--ink);
    }
    .step-description { margin: 0; color: #64748b; font-size: 13px; line-height: 1.6; }
    .run-summary { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; font-size: 12px; color: #64748b; margin-bottom: 14px; }
    .pane .block { margin: 12px; border: 1px solid #dbe3ee; border-radius: 10px; background: #fff; }
    .pane .block h4 { color: #1f2937; }
    .rf-header { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 14px; }
    .rf-header h3 { margin: 0 0 6px; font-size: 20px; font-weight: 650; letter-spacing: -0.02em; }
    .rf-header p { margin: 0; max-width: 540px; font-size: 13px; line-height: 1.5; color: var(--muted); }
    .rf-metrics { display: flex; gap: 8px; flex-wrap: wrap; }
    .metric { min-width: 72px; padding: 8px 10px; border-radius: 10px; background: var(--wash); border: 1px solid var(--line); }
    .metric.alert { background: #fffbeb; border-color: #fcd34d; }
    .metric-n { display: block; font-size: 18px; font-weight: 700; }
    .metric.alert .metric-n { color: var(--warn); }
    .metric-l { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }

    .import-card { border: 1px solid var(--line); border-radius: 14px; background: #fff; margin-bottom: 10px; overflow: hidden; }
    .import-card-head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 14px 16px 8px; }
    .import-card-head h4 { margin: 0 0 4px; font-size: 14px; font-weight: 650; }
    .import-card-head p { margin: 0; font-size: 12px; color: var(--muted); }
    .import-tabs { display: flex; padding: 0 12px; border-bottom: 1px solid var(--line); }
    .import-tab { border: none; background: none; padding: 10px 14px; font-size: 13px; font-weight: 600; color: var(--muted); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
    .import-tab.on { color: var(--accent); border-bottom-color: var(--accent); }
    .import-body { padding: 14px 16px; }
    .drawer { margin-bottom: 10px; padding: 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--wash); }
    .more-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
    .more-grid label, .lbl { font-size: 11px; font-weight: 600; color: var(--muted); display: flex; flex-direction: column; gap: 6px; }
    .hint { margin: 10px 0 0; font-size: 12px; color: var(--muted); }
    .toast { margin-bottom: 10px; padding: 8px 12px; border-radius: 8px; background: #ecfdf5; color: #166534; font-size: 12px; border: 1px solid #a7f3d0; }
    .toast.err { background: #fef2f2; color: #991b1b; border-color: #fecaca; }

    .row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .row.gap { margin-top: 8px; }
    .grow { flex: 1; min-width: 160px; }
    .input, .num, .textarea {
      height: 34px; border: 1px solid #cbd5e1; border-radius: 8px; padding: 0 10px; font-size: 13px; background: #fff;
    }
    .input.wide { width: 100%; }
    .input.file { width: 100%; font-size: 12px; }
    .textarea { width: 100%; height: auto; padding: 8px 10px; resize: vertical; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    .btn { height: 34px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--line); background: #fff; color: #334155; font-size: 12px; font-weight: 600; cursor: pointer; }
    .btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn.sm { height: 28px; padding: 0 10px; font-size: 11px; }
    .btn.on { border-color: #7dd3fc; background: var(--accent-soft); color: var(--accent); }
    .btn.accent { border-color: var(--accent); background: var(--accent); color: #fff; }
    .btn.danger { border-color: #fecaca; color: var(--danger); }
    .link { border: none; background: none; color: var(--accent); font-size: 12px; font-weight: 600; cursor: pointer; padding: 0; }
    .link.danger { color: var(--danger); }
    .icon { width: 28px; height: 28px; border-radius: 6px; border: 1px solid var(--line); background: #fff; cursor: pointer; font-size: 16px; line-height: 1; }
    .upload { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; min-height: 88px; border: 1.5px dashed #cbd5e1; border-radius: 12px; background: var(--wash); cursor: pointer; font-size: 13px; }
    .upload input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
    .muted { color: var(--muted); font-size: 12px; }
    .help { margin: 0 0 8px; font-size: 12px; color: var(--muted); line-height: 1.4; }

    .workspace { display: grid; grid-template-columns: minmax(0, 1fr); border: 1px solid var(--line); border-radius: 14px; overflow: hidden; background: #fff; min-height: 480px; }
    @media (max-width: 820px) { .workspace { grid-template-columns: 1fr; } }
    .rail { background: var(--wash); border-bottom: 1px solid var(--line); padding: 10px 8px; }
    .rail-h { display: flex; justify-content: space-between; align-items: center; padding: 4px 8px 10px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
    .group-tabs { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 6px; }
    .rail-item { flex: 0 0 205px; min-width: 0; display: flex; justify-content: space-between; gap: 8px; align-items: center; padding: 9px 10px; border: none; border-radius: 8px; background: transparent; cursor: pointer; text-align: left; }
    .rail-item:hover { background: #fff; }
    .rail-item.active { background: #fff; box-shadow: inset 0 -3px 0 var(--accent); }
    .rail-title { display: flex; flex-direction: column; gap: 2px; font-size: 13px; font-weight: 600; min-width: 0; flex: 1; }
    .rail-name-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rail-name {
      width: 100%; height: 26px; border: 1px solid #cbd5e1; border-radius: 6px;
      padding: 0 6px; font-size: 13px; font-weight: 600; background: #fff;
    }
    .kit { font-size: 10px; font-weight: 500; color: var(--muted); }
    .count { font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 999px; background: #e2e8f0; color: #475569; flex-shrink: 0; }
    .empty-rail { margin: 0; padding: 8px; font-size: 12px; color: var(--muted); }
    .pool-note { margin-top: 14px; padding: 8px; font-size: 11px; color: var(--muted); border-top: 1px solid var(--line); }

    .metadata-tools { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin: 8px 0; font-size: 12px; color: var(--muted); }
    .numbering-header { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
    .numbering-arrow { border: 0; background: transparent; color: var(--accent); padding: 3px 6px; font-size: 15px; cursor: pointer; border-radius: 4px; }
    .numbering-arrow:hover { background: var(--accent-soft); }
    .metadata-tools .input { width: auto; max-width: 100%; }
    .mapping-table { max-height: 280px; }
    .mapping-table .num { width: 65px; min-width: 0; box-sizing: border-box; }
    .metadata-filename { overflow-wrap: anywhere; }
    .pane { padding: 0 0 16px; min-width: 0; overflow: auto; max-height: min(70vh, 720px); }
    .pane .block { position: relative; }

    .block { padding: 14px 16px; border-bottom: 1px solid var(--line); }
    .block.disabled { opacity: 0.55; pointer-events: none; }
    .block-h { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 8px; }
    .block h4 { margin: 0 0 8px; font-size: 14px; font-weight: 650; display: flex; align-items: center; gap: 8px; }
    .block-h h4 { margin: 0; }
    .block-tools { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .kit-select {
      min-width: 200px; max-width: 320px; height: 38px;
      border: 1.5px solid #94a3b8; border-radius: 8px; background: #fff;
    }
    .kit-select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
    .n { width: 22px; height: 22px; border-radius: 50%; background: var(--accent-soft); color: var(--accent); display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; }

    .field-l { font-size: 11px; font-weight: 650; color: var(--muted); }
    .mapping-options { margin-bottom: 14px; }
    .separate-sample { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--line); }
    .separate-sample label { flex: 1; }
    .sample-files { flex-basis: 100%; display: flex; flex-wrap: wrap; gap: 6px; }
    .mapping-card { border: 1px solid #cbd5e1; border-radius: 10px; background: white; }
    .mapping-card .channel-row { border: 0; }
    .mapping-files { padding: 0 10px 10px; }
    .lf-files { padding-top: 10px; }
    .lf-entry { min-width: 0; }
    .lf-entry > .mapping-card { min-width: 0; }
    .lf-entry .channel-row { gap: 8px; padding: 8px; }
    .lf-entry .channel-row > select.input { flex-basis: 126px; width: 126px; }
    .lf-entry .label-tag { min-width: 78px; padding-inline: 7px; }

    .mapping-file-actions.lf-actions { justify-content: flex-end; margin: 0; white-space: nowrap; gap: 8px; }
    @media(max-width: 600px) { .lf-entry .lf-actions { margin-left: auto; } }

    .mapping-entry + .mapping-entry { margin-top: 6px; }
    .mapping-file-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 8px; }
    .shared-files { margin-top: 14px; }
    .add-mapping { margin-top: 12px; }
    .channel-list { display: flex; flex-direction: column; gap: 8px; }
    .channel-row {
      display: flex; align-items: center; gap: 10px;
      border: 1.5px solid #cbd5e1; border-radius: 10px; padding: 10px; background: #fff;
    }
    .channel-row.filled { border-color: #7dd3fc; background: #f8fbff; }
    .channel-row.open { border-color: var(--accent); background: #fff; z-index: 5; position: relative; }
    .label-tag {
      font-size: 12px; font-weight: 650; padding: 8px 10px; border-radius: 8px;
      background: #f1f5f9; border: 1.5px solid #94a3b8; min-width: 88px; text-align: center;
      flex-shrink: 0; color: #0f172a; margin-top: 0; box-sizing: border-box; height: 40px; display: flex; align-items: center; justify-content: center;
    }
    .channel-row > select.input { height: 40px; box-sizing: border-box; flex: 0 0 142px; }
    .group-members { display: flex; flex-wrap: wrap; gap: 12px; margin: 12px 0; font-size: 12px; }
    .group-preview { margin: 14px 0; font-size: 12px; }
    .group-preview > strong { display: block; margin-bottom: 6px; color: #475569; }
    .group-preview-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 9px 0; border-bottom: 1px solid var(--line); }
    .group-preview-row > span:first-child { min-width: 0; overflow-wrap: anywhere; }
    .group-preview-count { flex-shrink: 0; color: var(--muted); }
    .group-members { max-height: 180px; overflow-y: auto; }
    .custom-group { padding: 12px; margin-top: 12px; background: #f4f7fb; border-radius: 8px; }
    .grouping-label { display: flex; align-items: center; gap: 12px; font-size: 13px; }
    @media(max-width: 600px) { .channel-row { flex-wrap: wrap; } .channel-row .sample-dd { flex-basis: 100%; } }
    .sample-dd { position: relative; flex: 1; min-width: 0; z-index: 1; }
    .sample-dd.open { z-index: 30; }
    .sample-trigger {
      width: 100%; min-height: 40px; display: flex; align-items: center; gap: 8px;
      border: 1.5px solid #64748b; border-radius: 8px; padding: 6px 10px; background: #fff;
      font-size: 13px; cursor: pointer; text-align: left;
    }
    .sample-trigger:hover { border-color: #0f172a; }
    .sample-dd.has-value .sample-trigger {
      border-color: var(--accent); background: #f0f9ff;
    }
    .sample-dd.open .sample-trigger {
      border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); background: #fff;
    }
    .channel-row > select.input,
    .channel-row .sample-trigger {
      appearance: none; height: 40px; min-height: 40px; box-sizing: border-box;
      border: 1px solid #cbd5e1; border-radius: 8px; color: #334155;
      background-color: #fff; padding: 0 28px 0 10px;
      background-image: linear-gradient(45deg, transparent 50%, #64748b 50%), linear-gradient(135deg, #64748b 50%, transparent 50%);
      background-position: calc(100% - 14px) 18px, calc(100% - 10px) 18px;
      background-size: 4px 4px; background-repeat: no-repeat;
    }
    .channel-row > select.input:hover, .channel-row .sample-trigger:hover { border-color: #94a3b8; }
    .channel-row > select.input:focus-visible, .channel-row .sample-trigger:focus-visible,
    .channel-row .sample-dd.open .sample-trigger { border-color: var(--accent); box-shadow: 0 0 0 2px var(--accent-soft); }
    .channel-row .sample-trigger .caret { display: none; }
    .channel-row .chip-wrap { flex-wrap: nowrap; overflow: hidden; }
    .channel-row .sel-chip { flex-shrink: 1; min-width: 0; }
    .lf-actions { flex-shrink: 0; }
    .sample-ph { flex: 1; color: #64748b; font-size: 13px; }
    .chip-wrap {
      flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: 4px; align-items: center;
    }
    .sel-chip {
      display: inline-flex; align-items: center; max-width: 140px;
      padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 650;
      background: #e0f2fe; color: #0369a1; border: 1px solid #7dd3fc;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .sel-chip.pool { background: #fef3c7; color: #b45309; border-color: #fcd34d; }
    .sel-chip.more { background: #e2e8f0; color: #334155; border-color: #cbd5e1; }
    .sel-count {
      flex-shrink: 0; font-size: 11px; font-weight: 700; padding: 2px 7px; border-radius: 999px;
      background: #0284c7; color: #fff;
    }
    .sel-count.pool { background: #d97706; }
    .channel-row .label-tag,
    .channel-row > select.input,
    .channel-row .sample-trigger,
    .channel-row .sample-ph,
    .channel-row .sel-chip,
    .channel-row .sel-count,
    .mapping-file-actions > button {
      font-family: inherit; font-size: 12px; font-weight: 500; line-height: 18px;
    }
    .mapping-file-actions > button { display: inline-flex; align-items: center; justify-content: center; min-height: 32px; }

    .caret { color: #475569; font-size: 12px; flex-shrink: 0; }
    .sample-menu {
      position: absolute; z-index: 40; left: 0; right: 0; top: calc(100% + 6px);
      background: #fff; border: 1.5px solid #64748b; border-radius: 10px;
      box-shadow: 0 12px 28px rgba(15, 23, 42, 0.18); padding: 8px; max-height: 280px;
      display: flex; flex-direction: column; gap: 6px;
      isolation: isolate;
    }
    .sample-menu-tools {
      display: flex; align-items: center; gap: 10px; padding: 0 4px 6px; border-bottom: 1px solid #e2e8f0;
    }
    .sample-menu-tools .muted { margin-left: auto; font-size: 11px; }
    .sample-menu-list {
      list-style: none; margin: 0; padding: 0; overflow: auto; max-height: 200px;
      user-select: none; -webkit-user-select: none; background: #fff;
    }
    .sample-opt {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 10px; border-radius: 8px; font-size: 13px; color: #0f172a; cursor: pointer;
      border: 1px solid transparent;
    }
    .sample-opt:hover { background: #f1f5f9; }
    .sample-opt.on {
      background: #e0f2fe; color: #0c4a6e; font-weight: 650;
      border-color: #38bdf8;
    }
    .tick {
      width: 16px; height: 16px; border-radius: 4px; flex-shrink: 0;
      border: 1.5px solid #94a3b8; background: #fff; position: relative;
    }
    .sample-opt.on .tick {
      border-color: #0284c7; background: #0284c7;
    }
    .sample-opt.on .tick::after {
      content: ''; position: absolute; left: 4px; top: 1px;
      width: 4px; height: 8px; border: solid #fff; border-width: 0 2px 2px 0;
      transform: rotate(45deg);
    }
    .pool-name { width: 100%; border: 1.5px solid #94a3b8; }

    .chip-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; max-height: 160px; overflow: auto; }
    .file-chip { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-radius: 8px; background: var(--wash); border: 1px solid var(--line); }
    .file-chip .name { flex: 1; min-width: 0; font-family: ui-monospace, Menlo, monospace; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; direction: rtl; text-align: left; }
    .file-chip .name bdi { direction: ltr; unicode-bidi: bidi-override; }
    .x { border: none; background: none; color: var(--muted); cursor: pointer; font-size: 16px; line-height: 1; padding: 0 4px; }
    .x:hover { color: var(--danger); }

    .fill-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; margin-bottom: 8px; }
    .radio { display: flex; align-items: center; gap: 6px; font-size: 12px; cursor: pointer; }
    .inline { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }

    .table-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 10px; }
    .review-table { max-height: 460px; }
    .review-table table { min-width: 850px; }
    .review-table th { position: sticky; top: 0; z-index: 1; }
    .review-table .file { min-width: 180px; }
    .review-table .num { width: 72px; min-width: 0; box-sizing: border-box; }
    .data { width: 100%; border-collapse: collapse; font-size: 12px; }
    .data th, .data td { padding: 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle; }
    .data th { background: var(--wash); color: var(--muted); font-weight: 650; font-size: 11px; }
    .data tr.dim { opacity: 0.5; }
    .data.edit td { background: #fff; }
    .accent-t { color: var(--accent); font-weight: 650; }

    .blank { margin: 40px 20px; text-align: center; padding: 28px; border: 1px dashed #cbd5e1; border-radius: 12px; background: var(--wash); }
    .blank-title { margin: 0 0 6px; font-weight: 650; }
    .blank-body { margin: 0 0 12px; font-size: 13px; color: var(--muted); }

    .warn { display: flex; gap: 10px; align-items: center; margin-top: 12px; padding: 12px 14px; border-radius: 10px; background: #fffbeb; border: 1px solid #fcd34d; color: #92400e; font-size: 13px; }
    .bang { width: 20px; height: 20px; border-radius: 50%; background: #f59e0b; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0; }

    .modal-backdrop { position: fixed; inset: 0; background: rgba(15, 23, 42, 0.35); z-index: 40; }
    .modal {
      position: fixed; z-index: 50; left: 50%; top: 50%; transform: translate(-50%, -50%);
      width: min(520px, calc(100vw - 32px)); max-height: min(80vh, 640px);
      background: #fff; border-radius: 14px; border: 1px solid var(--line);
      display: flex; flex-direction: column; overflow: hidden;
    }
    .modal-h { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; border-bottom: 1px solid var(--line); }
    .modal-h h4 { margin: 0; font-size: 15px; }
    .modal .help { padding: 0 16px; margin: 10px 0 0; }
    .modal-tools { display: flex; gap: 12px; align-items: center; padding: 8px 16px; }
    .picker-list {
      list-style: none; margin: 0; padding: 0 8px 8px; overflow: auto; flex: 1; max-height: 360px;
      user-select: none; -webkit-user-select: none;
    }
    .picker-row { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border-radius: 8px; cursor: pointer; border: 1px solid transparent; }
    .picker-row:hover { background: var(--wash); }
    .picker-row.on { background: var(--accent-soft); border-color: #7dd3fc; }
    .check { width: 18px; height: 18px; border-radius: 5px; border: 1.5px solid #cbd5e1; flex-shrink: 0; margin-top: 1px; background: #fff; }
    .check.on { border-color: var(--accent); background: var(--accent); box-shadow: inset 0 0 0 2px #fff; }
    .picker-row .name { flex: 1; min-width: 0; font-size: 12px; line-height: 1.35; word-break: break-all; }
    .modal-f { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--line); }
  `],
})
export class RunsFilesComponent implements OnInit {
  readonly runFactors = computed(() => this.wizardState.factors().filter(f => f.enabled && f.scope === 'run'));
  @Input() aiEnabled = false;

  readonly wizardState = inject(WizardStateService);
  readonly state = this.wizardState.state;
  readonly acquisition = ACQUISITION;

  readonly selectedRunId = signal<string | null>(null);
  readonly importTab = signal<ImportTab>('pxd');
  readonly showMore = signal(false);

  readonly pxdInput = signal('');
  readonly pxdLoading = signal(false);
  readonly pasteText = signal('');
  readonly statusMsg = signal('');
  readonly statusError = signal(false);

  readonly uploadFileName = signal('');
  readonly uploadNames = signal<string[]>([]);

  readonly pickerOpen = signal(false);
  readonly pickerSelected = signal<Set<number>>(new Set());
  private pickerDrag: {
    paintOn: boolean;
    anchorPos: number;
    base: Set<number>;
  } | null = null;

  readonly fracMode = signal<FillMode>('all1');
  readonly techMode = signal<FillMode>('all1');
  readonly fracStart = signal(1);
  readonly techStart = signal(1);
  readonly fracCustom = signal('');
  readonly techCustom = signal('');
  /** Open sample multi-select dropdown for this channel index. */
  readonly samplePickerCi = signal<number | null>(null);
  private sampleDrag: {
    runId: string;
    channelIndex: number;
    paintOn: boolean;
    anchorPos: number;
    base: Set<number>;
  } | null = null;

  readonly msRuns = computed(() => this.state().msRuns || []);
  readonly files = computed(() => this.state().dataFiles);
  readonly kits = computed(() => LABEL_CONFIGS);

  readonly unassignedIndices = computed(() =>
    this.files().map((f, i) => (!f.runId ? i : -1)).filter(i => i >= 0)
  );
  readonly unassignedCount = computed(() => this.unassignedIndices().length);
  readonly unassignedItems = computed(() =>
    this.unassignedIndices().map(index => ({ index, file: this.files()[index] }))
  );
  readonly sdrfRowCount = computed(() => buildWizardExpansionRows(this.state()).length);

  readonly activeRun = computed(() => {
    const id = this.selectedRunId();
    if (!id) return null;
    return this.msRuns().find(r => r.id === id) || null;
  });

  private readonly syncSelectedRun = effect(() => {
    const runs = this.msRuns();
    for (const run of runs) {
      if (this.runKitId(run) === 'lf' && run.sampleMappingMode !== 'rows') this.wizardState.ensureLabelFreeRows(run.id);
    }
    if (!runs.some(run => run.id === this.selectedRunId())) {
      this.selectedRunId.set(runs[0]?.id ?? null);
      this.closeSamplePicker();
    }
  });

  ngOnInit(): void {
    this.wizardState.ensureMsRunsForFilesStep();
    const runs = this.msRuns();
    if (runs[0]) this.selectedRunId.set(runs[0].id);
  }

  selectRun(id: string): void {
    this.selectedRunId.set(id);
    this.closeSamplePicker();
  }

  metadataFiles(runId: string, mappingId?: string) {
    return this.filesForRun(runId).filter(item => mappingId == null || item.file.mappingId === mappingId);
  }
  numberFiles(runId: string, mappingId: string | undefined, field: 'fractionId' | 'technicalReplicate', direction: 'asc' | 'desc'): void {
    this.wizardState.numberScopedFiles(runId, mappingId, field, direction);
  }
  setFilePattern(runId: string, mappingId: string | undefined, pattern: string): void {
    if (pattern === 'none' || pattern === 'fractions' || pattern === 'repeats') {
      this.wizardState.setScopedFileMetadata(runId, mappingId, pattern);
    }
  }
  updateFileMetadata(index: number, field: 'fractionId' | 'technicalReplicate', value: number | string): void {
    const number = Number(value);
    if (Number.isInteger(number) && number > 0) this.wizardState.updateDataFile(index, { [field]: number });
  }

  filesForRun(runId: string): { index: number; file: WizardDataFile }[] {
    return this.files()
      .map((file, index) => ({ file, index }))
      .filter(x => x.file.runId === runId);
  }

  runKitId(run: WizardMsRun): string {
    return resolveRunLabelConfigId(run, this.state());
  }

  kitShort(run: WizardMsRun): string {
    const id = this.runKitId(run);
    if (id === 'lf') return 'LF';
    return labelConfigDisplayName(id).replace(/\s*\(.*\)\s*$/, '');
  }

  usedChannelCount(run: WizardMsRun): number {
    return countUsedChannels(run);
  }

  addRun(): void {
    this.wizardState.addMsRun();
    const runs = this.wizardState.msRuns();
    const last = runs[runs.length - 1];
    if (last) this.selectedRunId.set(last.id);
  }

  removeRun(runId: string): void {
    this.wizardState.removeMsRun(runId);
    const runs = this.wizardState.msRuns();
    this.selectedRunId.set(runs[0]?.id ?? null);
  }

  selectDefaultKit(configId: string): void {
    this.wizardState.setLabelConfig(configId);
    if ((this.wizardState.msRuns() || []).length === 0) {
      this.wizardState.autoPackSamplesIntoRuns();
    }
  }

  onRunKitChange(runId: string, configId: string): void {
    this.closeSamplePicker();
    this.wizardState.setRunLabelConfig(runId, configId);
  }

  @HostListener('document:mouseup')
  onDocumentMouseUp(): void {
    this.endSampleDrag();
    this.endPickerDrag();
  }

  @HostListener('document:mousedown', ['$event'])
  onDocumentMouseDown(event: MouseEvent): void {
    if (this.samplePickerCi() == null) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('[data-sample-dd]')) return;
    this.closeSamplePicker();
  }

  toggleSamplePicker(channelIndex: number, event: Event): void {
    event.stopPropagation();
    this.samplePickerCi.update(cur => (cur === channelIndex ? null : channelIndex));
  }

  closeSamplePicker(): void {
    this.samplePickerCi.set(null);
    this.endSampleDrag();
  }

  /** All experiment samples are available for channel mapping. */
  readonly groupingMode = signal('all');
  readonly groupingFactors = signal<string[]>([]);
  toggleGroupingFactor(name: string, checked: boolean): void { this.groupingFactors.update(names => checked ? [...new Set([...names, name])] : names.filter(n => n !== name)); this.groupingError.set(''); this.syncGroupingIfSafe(); }
  changeGroupingMode(mode: string): void { this.groupingMode.set(mode); this.syncGroupingIfSafe(); }
  private syncGroupingIfSafe(): void { if (this.groupingMode() !== 'custom' && this.proposedGroups().length && !this.groupingAffectedFiles() && this.groupingPending()) this.applyGrouping(); }
  readonly groupingError = signal('');
  readonly customGroups = signal<{ name: string; members: number[] }[]>([]);
  readonly sampleGroupingFactors = computed(() => this.state().factors.filter(f => f.enabled && f.scope !== 'run'));
  readonly availableGroupSamples = computed(() => { const members = this.activeRun()?.groupMembers; return this.state().samples.filter(s => !members || members.includes(s.index)); });
  readonly proposedGroups = computed(() => {
    if (this.groupingMode() === 'custom') {
      const groups = this.customGroups(); const used = new Set(groups.flatMap(g => g.members));
      const rest = this.state().samples.filter(s => !used.has(s.index)).map(s => s.index);
      return rest.length ? [...groups, { name: 'Ungrouped samples', members: rest }] : groups;
    }
    if (this.groupingMode() === 'factors') return groupSamplesByFactors(this.state(), this.groupingFactors());
    return [{ name: 'All samples', members: this.state().samples.map(s => s.index) }];
  });
  readonly groupingPending = computed(() => {
    const groups = this.proposedGroups();
    if (!groups.length) return false;
    const signature = (name: string, members: number[]) => JSON.stringify([name, [...new Set(members)].sort((a,b) => a-b)]);
    const current = this.msRuns().map(r => signature(r.name, r.groupMembers || [])).sort();
    return JSON.stringify(current) !== JSON.stringify(groups.map(g => signature(g.name, g.members)).sort());
  });
  groupPreviewName(name: string): string {
    if (this.groupingMode() !== 'factors') return name;
    return name.split(' · ').map(part => part.slice(part.indexOf(': ') + 2)).join(' · ');
  }
  readonly groupingAffectedFiles = computed(() => {
    if (!this.proposedGroups().length) return 0;
    const retained = new Set<string>();
    for (const group of this.proposedGroups()) {
      const members = JSON.stringify([...new Set(group.members)].sort((a,b) => a-b));
      const run = this.msRuns().find(r => !retained.has(r.id) && r.groupMembers && JSON.stringify([...r.groupMembers].sort((a,b) => a-b)) === members);
      if (run) retained.add(run.id);
    }
    return this.files().filter(f => f.runId && !retained.has(f.runId)).length;
  });
  groupDisplayName(run: WizardMsRun): string {
    if (/^Run \d+$/i.test(run.name)) return this.msRuns().length === 1 ? 'All samples' : 'Sample group ' + (this.msRuns().indexOf(run) + 1);
    const prefixes = this.state().factors.map(factor => factor.name + ': ');
    return run.name.split(' · ').map(part => {
      const prefix = prefixes.find(prefix => part.startsWith(prefix));
      return prefix ? part.slice(prefix.length) : part;
    }).join(' · ');
  }
  startCustomGrouping(): void { this.groupingMode.set('custom'); if (!this.customGroups().length) this.customGroups.set(this.msRuns().map(r => ({ name: this.groupDisplayName(r), members: [...(r.groupMembers || this.separateIndices(r))] }))); }
  addCustomGroup(): void { this.customGroups.update(groups => [...groups, { name: '', members: [] }]); }
  removeCustomGroup(index: number): void { this.customGroups.update(groups => groups.filter((_,i) => i !== index)); }
  renameCustomGroup(index: number, name: string): void { this.customGroups.update(groups => groups.map((g,i) => i === index ? { ...g, name } : g)); }
  toggleGroupMember(index: number, sample: number, checked: boolean): void { this.customGroups.update(groups => groups.map((g,i) => i === index ? { ...g, members: checked ? [...new Set([...g.members, sample])] : g.members.filter(s => s !== sample) } : g)); }
  applyGrouping(): void { if (this.groupingMode() === 'factors' && !this.proposedGroups().length) { this.groupingError.set('Select at least one study factor.'); return; } try { this.wizardState.configureSampleGroups(this.proposedGroups()); this.selectedRunId.set(this.msRuns()[0]?.id || null); this.groupingError.set(''); this.samplePickerCi.set(null); } catch(error) { this.groupingError.set(error instanceof Error ? error.message : 'Could not apply groups.'); } }

  allSampleIndices(): number[] {
    return this.availableGroupSamples().map(s => s.index);
  }

  channelSampleNames(ch: WizardChannelAssignment): string[] {
    return this.channelSelectedIndices(ch).map(
      i => this.state().samples.find(s => s.index === i)?.sourceName || `sample_${i}`
    );
  }

  /** Effective sample indices bound to a channel (0 / 1 / many). */
  channelSelectedIndices(ch: WizardChannelAssignment): number[] {
    if (ch.role === 'sample' && ch.sampleIndex != null) return [ch.sampleIndex];
    if (ch.role === 'pooled') return [...(ch.pooledSampleIndices || [])];
    return [];
  }

  channelSampleCount(ch: WizardChannelAssignment): number {
    return this.channelSelectedIndices(ch).length;
  }

  isChannelSample(ch: WizardChannelAssignment, sampleIndex: number): boolean {
    return this.channelSelectedIndices(ch).includes(sampleIndex);
  }

  sampleName(index: number): string { return this.state().samples.find(s => s.index === index)?.sourceName || ''; }
  readonly pickerMappingId = signal<string | null>(null);
  canAssignRowFiles(ch: WizardChannelAssignment): boolean {
    return ch.role === 'sample' && ch.sampleIndex != null || ch.role === 'pooled' && (ch.pooledSampleIndices?.length ?? 0) >= 2;
  }
  openRowFiles(ch: WizardChannelAssignment): void { this.openFilePicker(); this.pickerMappingId.set(ch.mappingId!); }
  addRow(runId: string): void { this.closeSamplePicker(); this.wizardState.addLabelFreeRow(runId); }
  removeRow(runId: string, mappingId: string): void { this.closeSamplePicker(); this.wizardState.removeLabelFreeRow(runId, mappingId); }

  separateIndices(run: WizardMsRun): number[] {
    return run.sampleMappingMode === 'separate' ? run.sampleIndices || [] : [...new Set(run.channels.flatMap(ch => this.channelSelectedIndices(ch)))];
  }
  pickerTargetName(): string {
    const run = this.activeRun(), ch = run?.channels.find(c => c.mappingId === this.pickerMappingId());
    return ch ? ch.sourceNameOverride || this.channelSampleNames(ch).join(', ') : run?.name || '';
  }
  setChannelMode(runId: string, index: number, mode: 'single' | 'pooled'): void {
    this.endSampleDrag();
    const ch = this.msRuns().find(r => r.id === runId)?.channels[index]; if (!ch) return;
    this.wizardState.setChannelAssignment(runId, index, mode === 'pooled' ? { role: 'pooled', pooledSampleIndices: this.channelSelectedIndices(ch) } : { role: 'empty' });
  }

  private applyChannelSamples(
    runId: string,
    channelIndex: number,
    indices: number[],
    sourceNameOverride?: string
  ): void {
    const allowed = new Set(this.allSampleIndices());
    const sorted = [...indices].filter(i => allowed.has(i)).sort((a, b) => a - b);
    const channel = this.msRuns().find(r => r.id === runId)?.channels[channelIndex];
    if (channel?.role === 'pooled') {
      this.wizardState.setChannelAssignment(runId, channelIndex, { role: 'pooled', pooledSampleIndices: sorted, sourceNameOverride: sourceNameOverride || channel.sourceNameOverride }); return;
    }
    if (sorted.length > 1) { this.wizardState.setChannelAssignment(runId, channelIndex, { role: 'sample', sampleIndex: sorted[sorted.length - 1] }); return; }
    if (sorted.length === 0) {
      this.wizardState.setChannelAssignment(runId, channelIndex, { role: 'empty' });
      return;
    }
    if (sorted.length === 1) {
      this.wizardState.setChannelAssignment(runId, channelIndex, {
        role: 'sample',
        sampleIndex: sorted[0],
      });
      return;
    }
    this.wizardState.setChannelAssignment(runId, channelIndex, {
      role: 'pooled',
      pooledSampleIndices: sorted,
      sourceNameOverride: sourceNameOverride || undefined,
    });
  }

  setChannelPoolName(runId: string, channelIndex: number, name: string): void {
    const run = this.msRuns().find(r => r.id === runId);
    const ch = run?.channels[channelIndex];
    if (!ch) return;
    this.applyChannelSamples(runId, channelIndex, this.channelSelectedIndices(ch), name);
  }

  startSampleDrag(
    runId: string,
    channelIndex: number,
    sampleIndex: number,
    event: MouseEvent
  ): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const run = this.msRuns().find(r => r.id === runId);
    const ch = run?.channels[channelIndex];
    if (!run || !ch) return;
    const samples = this.availableGroupSamples();
    const anchorPos = samples.findIndex(s => s.index === sampleIndex);
    if (anchorPos < 0) return;
    if (ch.role !== 'pooled') { this.applyChannelSamples(runId, channelIndex, [sampleIndex]); return; }
    const base = new Set(this.channelSelectedIndices(ch));
    const paintOn = !base.has(sampleIndex);
    this.sampleDrag = { runId, channelIndex, paintOn, anchorPos, base };
    this.applySampleDragRange(anchorPos);
  }

  paintSampleDrag(runId: string, channelIndex: number, sampleIndex: number): void {
    const drag = this.sampleDrag;
    if (!drag || drag.runId !== runId || drag.channelIndex !== channelIndex) return;
    const pos = this.availableGroupSamples().findIndex(s => s.index === sampleIndex);
    if (pos < 0) return;
    this.applySampleDragRange(pos);
  }

  private applySampleDragRange(toPos: number): void {
    const drag = this.sampleDrag;
    if (!drag) return;
    const run = this.msRuns().find(r => r.id === drag.runId);
    if (!run) return;
    const samples = this.availableGroupSamples();
    const from = Math.min(drag.anchorPos, toPos);
    const to = Math.max(drag.anchorPos, toPos);
    const next = new Set(drag.base);
    for (let i = from; i <= to; i++) {
      const idx = samples[i]?.index;
      if (idx == null) continue;
      if (drag.paintOn) next.add(idx);
      else next.delete(idx);
    }
    const ch = run.channels[drag.channelIndex];
    this.applyChannelSamples(
      drag.runId,
      drag.channelIndex,
      [...next],
      ch?.sourceNameOverride
    );
  }

  endSampleDrag(): void {
    this.sampleDrag = null;
  }

  channelSelectAll(runId: string, channelIndex: number): void {
    const run = this.msRuns().find(r => r.id === runId);
    const ch = run?.channels[channelIndex];
    this.applyChannelSamples(
      runId,
      channelIndex,
      this.allSampleIndices(),
      ch?.sourceNameOverride
    );
  }

  channelClear(runId: string, channelIndex: number): void {
    this.applyChannelSamples(runId, channelIndex, []);
  }

  openFilePicker(): void {
    this.pickerMappingId.set(null);
    this.pickerSelected.set(new Set());
    this.pickerDrag = null;
    this.pickerOpen.set(true);
  }

  closePicker(): void {
    this.pickerOpen.set(false);
    this.pickerSelected.set(new Set());
    this.pickerDrag = null;
  }

  startPickerDrag(pos: number, fileIndex: number, event: MouseEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    const base = new Set(this.pickerSelected());
    const paintOn = !base.has(fileIndex);
    this.pickerDrag = { paintOn, anchorPos: pos, base };
    this.applyPickerDragRange(pos);
  }

  paintPickerDrag(pos: number): void {
    if (!this.pickerDrag) return;
    this.applyPickerDragRange(pos);
  }

  private applyPickerDragRange(toPos: number): void {
    const drag = this.pickerDrag;
    if (!drag) return;
    const items = this.unassignedItems();
    const from = Math.min(drag.anchorPos, toPos);
    const to = Math.max(drag.anchorPos, toPos);
    const next = new Set(drag.base);
    for (let i = from; i <= to; i++) {
      const idx = items[i]?.index;
      if (idx == null) continue;
      if (drag.paintOn) next.add(idx);
      else next.delete(idx);
    }
    this.pickerSelected.set(next);
  }

  endPickerDrag(): void {
    this.pickerDrag = null;
  }

  pickerSelectAll(): void {
    this.pickerSelected.set(new Set(this.unassignedIndices()));
  }

  pickerClear(): void {
    this.pickerSelected.set(new Set());
  }

  confirmPicker(): void {
    const runId = this.selectedRunId();
    if (!runId || this.pickerSelected().size === 0) return;
    if (this.pickerMappingId()) this.wizardState.assignFilesToLabelFreeRow([...this.pickerSelected()], runId, this.pickerMappingId()!);
    else this.wizardState.assignDataFilesToRun([...this.pickerSelected()], runId);
    const n = this.pickerSelected().size;
    this.closePicker();
    this.statusError.set(false);
    this.statusMsg.set(`Added ${n} file(s) to ${this.activeRun()?.name || 'run'}.`);
  }

  returnOne(index: number): void {
    this.wizardState.unassignDataFiles([index]);
  }

  setFracMode(mode: FillMode, runId: string): void {
    this.fracMode.set(mode);
    if (mode !== 'custom') this.applyFraction(runId, true);
  }

  onFracStartChange(value: number | string, runId: string): void {
    this.fracStart.set(Math.max(1, Number(value) || 1));
    if (this.fracMode() === 'seq') this.applyFraction(runId, true);
  }

  onFracCustomChange(text: string, runId: string): void {
    this.fracCustom.set(text);
    if (this.fracMode() === 'custom') this.applyFraction(runId, true);
  }

  setTechMode(mode: FillMode, runId: string): void {
    this.techMode.set(mode);
    if (mode !== 'custom') this.applyTech(runId, true);
  }

  onTechStartChange(value: number | string, runId: string): void {
    this.techStart.set(Math.max(1, Number(value) || 1));
    if (this.techMode() === 'seq') this.applyTech(runId, true);
  }

  onTechCustomChange(text: string, runId: string): void {
    this.techCustom.set(text);
    if (this.techMode() === 'custom') this.applyTech(runId, true);
  }

  applyFraction(runId: string, silent = false): void {
    const items = this.filesForRun(runId);
    if (!items.length) return;
    const values = this.resolveFillValues(this.fracMode(), items.length, this.fracStart(), this.fracCustom());
    if (!values) return;
    const files = this.files().map((f, i) => {
      const pos = items.findIndex(it => it.index === i);
      if (pos < 0) return f;
      return { ...f, fractionId: values[pos] };
    });
    this.wizardState.setDataFiles(files);
    if (!silent) {
      this.statusError.set(false);
      this.statusMsg.set('Fraction values applied.');
    }
  }

  applyTech(runId: string, silent = false): void {
    const items = this.filesForRun(runId);
    if (!items.length) return;
    const values = this.resolveFillValues(this.techMode(), items.length, this.techStart(), this.techCustom());
    if (!values) return;
    const files = this.files().map((f, i) => {
      const pos = items.findIndex(it => it.index === i);
      if (pos < 0) return f;
      return { ...f, technicalReplicate: values[pos] };
    });
    this.wizardState.setDataFiles(files);
    if (!silent) {
      this.statusError.set(false);
      this.statusMsg.set('Tech replicate values applied.');
    }
  }

  private resolveFillValues(
    mode: FillMode,
    count: number,
    start: number,
    customText: string
  ): number[] | null {
    if (mode === 'all1') return Array.from({ length: count }, () => 1);
    if (mode === 'seq') {
      const s = Math.max(1, start || 1);
      return Array.from({ length: count }, (_, i) => s + i);
    }
    const tokens = customText.split(/[\s,;]+/).filter(Boolean);
    const nums = tokens.map(Number);
    if (nums.length !== count || nums.some(n => !Number.isInteger(n) || n < 1)) {
      this.statusError.set(true);
      this.statusMsg.set(`Enter exactly ${count} positive integers, one per file.`);
      return null;
    }
    return nums;
  }

  guessFractionTech(runId: string): void {
    const files = this.files().map(f => {
      if (f.runId !== runId) return f;
      const parsed = parseFractionTechFromName(f.fileName || '');
      return { ...f, fractionId: parsed.fractionId, technicalReplicate: parsed.technicalReplicate };
    });
    this.wizardState.setDataFiles(files);
    this.statusError.set(false);
    this.statusMsg.set('Guessed F/Tech from filenames.');
  }

  regenerateFromPlanner(): void {
    this.wizardState.generateFileSlotsFromPlanner();
    this.statusError.set(false);
    this.statusMsg.set(`Generated ${this.files().length} planner file slot(s).`);
    const runs = this.msRuns();
    if (runs[0]) this.selectedRunId.set(runs[0].id);
  }

  async fetchFromPxd(): Promise<void> {
    const accession = normalizePxdAccession(this.pxdInput());
    this.pxdInput.set(accession);
    if (!isValidPxdAccession(accession)) {
      this.statusError.set(true);
      this.statusMsg.set('Enter a valid PXD accession.');
      return;
    }
    this.pxdLoading.set(true);
    this.statusError.set(false);
    try {
      const { fileNames, fileUrls } = await fetchPrideRawFileNames(accession);
      this.wizardState.replaceWithUnassignedFileNames(fileNames, fileUrls);
      this.pasteText.set(fileNames.join('\n'));
      this.statusMsg.set(`${fileNames.length} files loaded into the pool.`);
    } catch (err) {
      this.statusError.set(true);
      this.statusMsg.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.pxdLoading.set(false);
    }
  }

  applyPaste(append: boolean): void {
    const lines = parseFileNameList(this.pasteText());
    if (!lines.length) {
      this.statusError.set(true);
      this.statusMsg.set('Paste at least one filename.');
      return;
    }
    if (append) this.wizardState.addUnassignedFileNames(lines);
    else this.wizardState.replaceWithUnassignedFileNames(lines);
    this.statusError.set(false);
    this.statusMsg.set(append ? `Appended ${lines.length} files.` : `Loaded ${lines.length} files into pool.`);
  }

  onUploadSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    void this.readUploadFile(file);
    input.value = '';
  }

  private async readUploadFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      const names = parseFilenamesFromText(text, file.name);
      this.uploadFileName.set(file.name);
      this.uploadNames.set(names);
      this.statusError.set(!names.length);
      this.statusMsg.set(names.length ? `Parsed ${names.length} name(s).` : `No filenames in ${file.name}.`);
    } catch (err) {
      this.statusError.set(true);
      this.statusMsg.set(err instanceof Error ? err.message : String(err));
    }
  }

  applyUpload(append: boolean): void {
    const names = this.uploadNames();
    if (!names.length) return;
    if (append) this.wizardState.addUnassignedFileNames(names);
    else this.wizardState.replaceWithUnassignedFileNames(names);
    this.statusError.set(false);
    this.statusMsg.set(`Loaded ${names.length} files into pool.`);
  }

  plannedF(): number { return plannedFractionCount(this.state()); }
  plannedT(): number { return plannedTechRepCount(this.state()); }
  estimatedRows(): number { return estimatePlannerSdrfRows(this.state()); }
  estimatedFiles(): number { return estimatePlannerFileSlots(this.state()); }

  readonly reviewRows = computed(() => buildWizardExpansionRows(this.state()));
  reviewFileRows(index: number) {
    const file = this.files()[index];
    return this.reviewRows().filter(row => row.runId === file.runId && row.fileName === file.fileName);
  }
  reviewFileSummary(index: number): string {
    return this.reviewFileRows(index).map(row => row.label === 'label free sample' ? row.sourceName : `${row.label}: ${row.sourceName}`).join('; ') || '—';
  }
  guessAllFractionTech(): void { for (const run of this.msRuns()) this.guessFractionTech(run.id); }

  mappingSummary(run: WizardMsRun): string {
    return run.channels.filter(c => c.role !== 'empty').map(c => `${c.label}: ${this.channelSampleNames(c).join(' + ')}`).join('; ');
  }

  factorSummary(run: WizardMsRun): string {
    return this.runFactors().map(f => `${f.name}: ${run.factorValues?.[f.name] || (f.values.length === 1 ? f.values[0] : 'not assigned')}`).join('; ') || '—';
  }

  validationHint(): string {
    if (!this.wizardState.isStep4Valid()) {
      return 'Each run needs at least one bound channel.';
    }
    if (this.files().length === 0) {
      return 'Import raw names into the pool, then add them to a run.';
    }
    if (this.unassignedCount() > 0) {
      return `${this.unassignedCount()} file(s) still in the pool — open a run and Add raw files.`;
    }
    if (this.files().some(f => !f.fileName.trim())) {
      return 'Every file needs a non-empty name.';
    }
    return 'Finish runs and file assignment to continue.';
  }
}

function parseFilenamesFromText(text: string, fileName: string): string[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const lowerName = fileName.toLowerCase();
  const isDelimited = lowerName.endsWith('.csv') || lowerName.endsWith('.tsv') || /[,;\t]/.test(lines[0]);
  if (!isDelimited) return uniqueNames(lines.map(stripQuotes));

  const delim = lowerName.endsWith('.tsv') || lines[0].includes('\t') ? '\t' : lines[0].includes(';') ? ';' : ',';
  const rows = lines.map(line => line.split(delim).map(c => stripQuotes(c.trim())));
  const header = rows[0].map(c => c.toLowerCase());
  const nameKeys = ['filename', 'file name', 'file', 'raw', 'rawfile', 'raw file', 'data file', 'name'];
  let col = header.findIndex(h => nameKeys.includes(h));
  const hasHeader = col >= 0;
  if (col < 0) col = 0;
  const start = hasHeader ? 1 : 0;
  const names: string[] = [];
  for (let i = start; i < rows.length; i++) {
    const cell = rows[i][col]?.trim();
    if (cell) names.push(cell);
  }
  return uniqueNames(names);
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1).trim();
  return s;
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of names) {
    const t = n.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}
