import { WizardState } from './wizard';

/**
 * Wizard AI assistant contracts.
 *
 * Mirrors `backend/app/schemas.py`. `WizardAction.op` names match the public
 * setters of `WizardStateService`, which is what lets the bridge dispatch them
 * without a translation table.
 */

export type AssistantStepId =
  | 'setup'
  | 'characteristics'
  | 'samples'
  | 'runs-files'
  | 'protocol'
  | 'review';

export type AssistantConfidence = 'high' | 'medium' | 'low';

export type CitationSource = 'spec' | 'pride' | 'paper' | 'ontology' | 'template';

export interface AssistantCitation {
  source: CitationSource;
  title: string;
  anchor?: string | null;
  url?: string | null;
  snippet: string;
}

/** One proposed mutation of the wizard state, pending user approval. */
export interface WizardAction {
  step: AssistantStepId;
  op: string;
  args: unknown[];
  label: string;
  reasoning: string;
  confidence: AssistantConfidence;
  citations: AssistantCitation[];
}

/** UI wrapper tracking review state for a proposed action. */
export interface WizardActionCard {
  id: string;
  action: WizardAction;
  status: 'pending' | 'applied' | 'dismissed' | 'failed';
  preview: string;
  error?: string;
  /** Present only on cards owned by an explicit automatic annotation run. */
  automationRunId?: string;
  autoApplied?: boolean;
}

export interface AutomationReport {
  status: 'ready' | 'blocked';
  /** Blocking problems for the current step only. */
  issues: string[];
  /** Informational explanations never trigger retries. Optional for older servers. */
  notes?: string[];
}

/** One tool call in the timeline — may still be running. */
export interface AssistantToolCall {
  id: string;
  name: string;
  title: string;
  summary: string;
  argsPreview: string;
  resultJson: string;
  ok: boolean;
  durationMs: number;
  /** True while the backend is still executing this tool. */
  running?: boolean;
}

/** Where the assistant wants to take the user once the current step is settled. */
export interface AssistantNextStep {
  stepId: AssistantStepId;
  index: number;
  title: string;
  prompt: string;
}

/**
 * One item in an assistant turn, in the order the backend streamed it.
 * Status lines stay on `AssistantChatMessage.status` so they never replace a
 * tool/text block in the tracked list (that was hiding results in the UI).
 */
export type AssistantTimelineItem =
  | { kind: 'thinking'; id: string; content: string; reasoning?: string; startedAt: number; finishedAt?: number }
  | { kind: 'tool'; id: string; call: AssistantToolCall }
  | { kind: 'text'; id: string; content: string };

/** A PDF (or other document) shown as a card instead of a text bubble. */
export interface AssistantAttachment {
  fileName: string;
  documentId: string;
  parser: string;
  sections: string[];
  charCount: number;
  /** Human label like "PDF 2.37MB", shown under the file name. */
  sizeLabel?: string;
  status: 'parsing' | 'ready' | 'error';
  error?: string;
}

/** A slash-command skill invocation shown as a chip in the transcript. */
export interface AssistantSkillRef {
  name: string;
  args?: string;
}

export interface AssistantChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** True when the panel asked on the user's behalf after a step change. */
  auto?: boolean;
  /** Short label for an automatic turn; content remains the full model context. */
  autoLabel?: string;
  /** Uploaded file card (UI); `content` still holds the prompt sent to the model. */
  attachment?: AssistantAttachment;
  /** Slash skill chip (UI), e.g. /sdrf-annotate PXD000547. */
  skill?: AssistantSkillRef;
  /** Which wizard step this turn advised on. */
  focusStep?: AssistantStepId;
  /** Live progress line for the tool currently running. */
  status?: string;
  /** Streamed blocks in arrival order (thinking, tools and text). */
  timeline?: AssistantTimelineItem[];
  /** Mirror of tool blocks; kept for older localStorage sessions. */
  toolCalls?: AssistantToolCall[];
  citations?: AssistantCitation[];
  actionIds?: string[];
  nextStep?: AssistantNextStep;
  pending?: boolean;
  error?: string;
  /** Backend debug info from the turn's `done.trace` (propose rejects, etc.). */
  trace?: Record<string, unknown> | null;
  /** Preserve the completion decision separately from the conversational text. */
  automation?: AutomationReport | null;
}

/** One persisted chat the user can reopen without logging in. */
export interface AssistantChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Backend session id (documents/evidence); may expire server-side. */
  backendSessionId: string;
  messages: AssistantChatMessage[];
  cards: Record<string, WizardActionCard>;
  advisedSteps: number[];
  cardSequence: number;
  /**
   * Wizard form snapshot for this chat.
   * `undefined` = legacy session (do not overwrite live wizard on load).
   * `null` = explicitly cleared (cancel / create / new chat).
   */
  wizardState?: WizardState | null;
  /** Wizard step index paired with `wizardState`. */
  currentStep?: number;
}

/** One characteristics column unlocked by Step 1 templates. */
export interface CharacteristicColumnSnapshot {
  name: string;
  requirement: 'required' | 'recommended' | 'optional';
  /** Ontology prefixes from template validators (e.g. ['ncit']). Empty = free text / pattern. */
  ontologies?: string[];
}

/** Lightweight view of the wizard sent to the backend on every turn. */
export interface WizardSnapshot {
  currentStep: number;
  currentStepId: AssistantStepId | null;
  sampleTemplate: string | null;
  sampleMetadataTemplates?: string[];
  templateSnapshotId?: string;
  selectedTemplates?: Array<{ name: string; version: string }>;
  technologyTemplate: string | null;
  experimentTemplates: string[];
  sampleCount: number;
  experimentDescription: string;
  characteristicColumns: CharacteristicColumnSnapshot[];
  characteristicChoices: Record<string, string[]>;
  /** Current source names in wizard order (Step 3). */
  sampleSourceNames?: string[];
  /** Detailed assignments are sent only by automatic runs, to preserve existing edits. */
  sampleAssignments?: {
    index: number;
    sourceName: string;
    biologicalReplicate: number;
    characteristicValues: Record<string, string>;
    factorValues: Record<string, string>;
  }[];
  /** Current biological replicate numbers in wizard order (Step 3). */
  biologicalReplicates?: number[];
  /** Columns with 2+ Step-2 candidates that need per-sample values on Step 3. */
  multiValueCharacteristicColumns?: string[];
  labelConfigId: string | null;
  msRunCount: number;
  /** Run name + bound sample source names (for file↔run matching). */
  msRunSummaries?: { name: string; sampleSourceNames: string[]; factorValues?: Record<string, string>; labelConfigId?: string; channels?: {label: string; sourceName?: string; role: string}[]; files?: {fileName: string; fractionId: number; technicalReplicate: number}[] }[];
  dataFileCount: number;
  /** All current raw file names in wizard order. */
  dataFileNames?: string[];
  unassignedFileCount: number;
  /** Files with no runId / sampleIndex yet. */
  unassignedFileNames?: string[];
  hasFractions?: boolean | null;
  fractionCount?: number | null;
  technicalReplicates?: number | null;
  instrument: string | null;
  cleavageAgent: string | null;
  modifications: string[];
  precursorMassTolerance: string;
  fragmentMassTolerance: string;
  /** Enabled factor names (short view). */
  factors: string[];
  /** Factor definitions with Step-2 candidate values. */
  factorDefinitions?: { name: string; values: string[]; sourceCharacteristic?: string; reasoning?: string; scope?: 'sample' | 'run' }[];
  factorDecision?: 'pending' | 'none';
  noFactorReason?: string;
  /** Factors with 2+ candidates needing per-sample picks on Step 3. */
  multiValueFactorColumns?: string[];
  acquisitionMethod: string | null;
}

export interface AssistantChatRequest {
  sessionId: string;
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[];
  wizardState?: WizardSnapshot;
  accession?: string | null;
  /** The only step the backend may propose actions for on this turn. */
  focusStep?: AssistantStepId;
  /** `step` when the panel asked on the user's behalf after a step change. */
  mode?: 'chat' | 'step';
  executionMode?: 'manual' | 'auto';
  /** Named skill resolved from a slash command. */
  skill?: string | null;
  skillArgs?: string | null;
}

/** Events streamed from `POST /api/chat`. */
export type AssistantStreamEvent =
  | { type: 'thinking'; text: string }
  | { type: 'status'; text: string }
  | { type: 'token'; text: string }
  | { type: 'tool_start'; tool: AssistantToolCall }
  | { type: 'tool'; tool: AssistantToolCall }
  | { type: 'actions'; actions: WizardAction[] }
  | { type: 'citations'; citations: AssistantCitation[] }
  | { type: 'next_step'; nextStep: AssistantNextStep }
  | { type: 'error'; text: string }
  | {
      type: 'done';
      result: {
        content: string;
        actions: WizardAction[];
        citations: AssistantCitation[];
        toolCalls: AssistantToolCall[];
        nextStep: AssistantNextStep | null;
        automation?: AutomationReport | null;
        trace?: Record<string, unknown> | null;
      };
    };

export interface AssistantHealth {
  status: string;
  llmConfigured: boolean;
  embeddingsConfigured: boolean;
  mineruConfigured: boolean;
  specIndexReady: boolean;
  specChunkCount: number;
  retrieval: string;
  celllineIndexReady?: boolean;
  celllineRecordCount?: number;
  celllineRetrieval?: string;
}

export interface AssistantUploadResult {
  documentId: string;
  fileName: string;
  charCount: number;
  sections: string[];
  preview: string;
  parser: string;
}
