"""Request/response contracts shared with the Angular frontend.

`WizardAction.op` names intentionally mirror the public setters of
`WizardStateService` (src/app/core/services/wizard-state.service.ts) so the
frontend bridge can dispatch them without a translation table.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

WizardStepId = Literal[
    "setup",
    "characteristics",
    "samples",
    "runs-files",
    "protocol",
    "review",
]

# The order the wizard walks through, mirroring WIZARD_STEPS in
# src/app/core/models/wizard.ts. Used to scope suggestions to one step and to
# work out which step to guide the user to next.
STEP_ORDER: list[WizardStepId] = [
    "setup",
    "characteristics",
    "samples",
    "runs-files",
    "protocol",
    "review",
]

STEP_TITLES: dict[WizardStepId, str] = {
    "setup": "Experiment Setup",
    "characteristics": "Sample Characteristics",
    "samples": "Sample Values",
    "runs-files": "Runs & Files",
    "protocol": "Instrument & Protocol",
    "review": "Review & Create",
}

# Whitelist of wizard mutations the assistant is allowed to propose. Anything
# outside this set is dropped before it reaches the browser.
ALLOWED_OPS: dict[str, WizardStepId] = {
    "setTechnologyTemplate": "setup",
    "setSampleTemplate": "setup",
    "setExperimentTemplates": "setup",
    "setSampleCount": "setup",
    "setExperimentDescription": "setup",
    "addCharacteristicChoice": "characteristics",
    "setFactors": "characteristics",
    "setNoStudyFactors": "characteristics",
    "setRunFactorValue": "runs-files",
    "addFactor": "characteristics",
    "addFactorValue": "characteristics",
    "setSampleCharacteristicValue": "samples",
    "applyRoundRobin": "samples",
    "autoGenerateSourceNames": "samples",
    "setSourceNames": "samples",
    "setBiologicalReplicates": "samples",
    "setFactorColumnValues": "samples",
    "setSampleFactorValue": "samples",
    "setLabelConfig": "runs-files",
    "autoPackSamplesIntoRuns": "runs-files",
    "applyRunsFilesPlan": "runs-files",
    "replaceWithUnassignedFileNames": "runs-files",
    "assignDataFilesToRun": "runs-files",
    "assignFilesToRunsByName": "runs-files",
    "setHasFractions": "runs-files",
    "setFractionCount": "runs-files",
    "setTechnicalReplicates": "runs-files",
    "setAcquisitionMethod": "runs-files",
    "setInstrument": "protocol",
    "setCleavageAgent": "protocol",
    "setModifications": "protocol",
    "setPrecursorMassTolerance": "protocol",
    "setFragmentMassTolerance": "protocol",
}

# Reverse index of ALLOWED_OPS, so the prompt can show only the operations that
# belong to the step being worked on.
OPS_BY_STEP: dict[WizardStepId, list[str]] = {step: [] for step in STEP_ORDER}
for _op, _step in ALLOWED_OPS.items():
    OPS_BY_STEP[_step].append(_op)


def next_step_after(step: WizardStepId | None) -> WizardStepId | None:
    """The step the user should move to once `step` is done."""
    if step is None:
        return None
    index = STEP_ORDER.index(step)
    return STEP_ORDER[index + 1] if index + 1 < len(STEP_ORDER) else None


class Citation(BaseModel):
    """A retrieved evidence snippet backing an answer or a suggestion."""

    source: str = Field(description="spec | pride | paper | ontology | template")
    title: str = ""
    anchor: str | None = None
    url: str | None = None
    snippet: str = ""


class WizardAction(BaseModel):
    """One proposed mutation of the wizard state."""

    step: WizardStepId
    op: str
    args: list[Any] = Field(default_factory=list)
    label: str = ""
    reasoning: str = ""
    confidence: Literal["high", "medium", "low"] = "medium"
    citations: list[Citation] = Field(default_factory=list)


class ToolInvocation(BaseModel):
    """One completed tool call, surfaced so the user can audit the evidence."""

    id: str
    name: str
    title: str = ""
    summary: str = ""
    argsPreview: str = ""
    resultJson: str = ""
    ok: bool = True
    durationMs: int = 0


class NextStepHint(BaseModel):
    """Where the assistant wants to take the user once this step is settled."""

    stepId: WizardStepId
    index: int
    title: str
    prompt: str


class ChatMessageIn(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str


class CharacteristicColumnInfo(BaseModel):
    """One characteristics column unlocked by the Step 1 templates."""

    name: str
    requirement: Literal["required", "recommended", "optional"] = "optional"
    # Ontology prefixes from the template validators (e.g. ["ncit"]). Empty = free text / pattern.
    ontologies: list[str] = Field(default_factory=list)


class FactorInfo(BaseModel):
    """Study factor defined on Step 2 with candidate values."""

    name: str
    values: list[str] = Field(default_factory=list)
    scope: Literal["sample", "run"] = "sample"
    sourceCharacteristic: str | None = None
    reasoning: str | None = None


class MsRunSummary(BaseModel):
    """One MS run with the source names bound to it (for file↔run matching)."""

    name: str
    sampleSourceNames: list[str] = Field(default_factory=list)
    labelConfigId: str | None = None
    channels: list[dict[str, Any]] = Field(default_factory=list)
    files: list[dict[str, Any]] = Field(default_factory=list)
    factorValues: dict[str, str] = Field(default_factory=dict)


class WizardSnapshot(BaseModel):
    """Lightweight view of the wizard that the assistant reasons about."""

    currentStep: int = 0
    currentStepId: WizardStepId | None = None
    sampleTemplate: str | None = None
    sampleMetadataTemplates: list[str] = Field(default_factory=list)
    templateSnapshotId: str | None = None
    selectedTemplates: list[dict[str, str]] = Field(default_factory=list)
    technologyTemplate: str | None = None
    experimentTemplates: list[str] = Field(default_factory=list)
    sampleCount: int = 0
    experimentDescription: str = ""
    # Prefer {name, requirement}; plain strings still accepted for older panels.
    characteristicColumns: list[CharacteristicColumnInfo | str] = Field(default_factory=list)
    characteristicChoices: dict[str, list[str]] = Field(default_factory=dict)
    # Step 3 (Sample Values) live state — mirrors what the wizard asks the user to fill.
    sampleSourceNames: list[str] = Field(default_factory=list)
    sampleAssignments: list[dict[str, Any]] = Field(default_factory=list)
    factorValues: dict[str, str] = Field(default_factory=dict)
    biologicalReplicates: list[int] = Field(default_factory=list)
    # Characteristics columns that have 2+ candidates (shown as per-sample picks on Step 3).
    multiValueCharacteristicColumns: list[str] = Field(default_factory=list)
    labelConfigId: str | None = None
    msRunCount: int = 0
    msRunSummaries: list[MsRunSummary] = Field(default_factory=list)
    dataFileCount: int = 0
    dataFileNames: list[str] = Field(default_factory=list)
    unassignedFileCount: int = 0
    unassignedFileNames: list[str] = Field(default_factory=list)
    hasFractions: bool | None = None
    fractionCount: int | None = None
    technicalReplicates: int | None = None
    instrument: str | None = None
    cleavageAgent: str | None = None
    modifications: list[str] = Field(default_factory=list)
    precursorMassTolerance: str = ""
    fragmentMassTolerance: str = ""
    # Enabled factor names (legacy / short view).
    factors: list[str] = Field(default_factory=list)
    # Full factor definitions with Step-2 candidate values.
    factorDefinitions: list[FactorInfo] = Field(default_factory=list)
    factorDecision: Literal["pending", "none"] = "pending"
    noFactorReason: str = ""
    # Factors with 2+ candidates that need per-sample picks on Step 3.
    multiValueFactorColumns: list[str] = Field(default_factory=list)
    acquisitionMethod: str | None = None


class AutomationReport(BaseModel):
    status: Literal["ready", "blocked"]
    issues: list[str] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class ChatRequest(BaseModel):
    sessionId: str
    messages: list[ChatMessageIn]
    wizardState: WizardSnapshot | None = None
    # Optional accession the UI already knows about (e.g. typed in Runs & Files).
    accession: str | None = None
    # Which wizard step the assistant should work on. Suggestions for other
    # steps are deferred until the user gets there.
    focusStep: WizardStepId | None = None
    # "step" means the panel asked for this turn because the user moved to a new
    # wizard step; "chat" means the user typed something.
    mode: Literal["chat", "step"] = "chat"
    executionMode: Literal["manual", "auto"] = "manual"
    # Named skill the panel resolved from a slash command (e.g. sdrf-annotate).
    skill: str | None = None
    skillArgs: str | None = None


class ChatResult(BaseModel):
    """Non-streaming payload; also emitted as the final SSE `done` event."""

    content: str = ""
    actions: list[WizardAction] = Field(default_factory=list)
    citations: list[Citation] = Field(default_factory=list)
    toolCalls: list[ToolInvocation] = Field(default_factory=list)
    nextStep: NextStepHint | None = None
    needsUserInput: str | None = None
    automation: AutomationReport | None = None
    # Debug payload for the panel's downloadable agent trace.
    trace: dict[str, Any] | None = None


class UploadResult(BaseModel):
    documentId: str
    fileName: str
    charCount: int
    sections: list[str] = Field(default_factory=list)
    preview: str = ""
    parser: str = ""


class HealthResult(BaseModel):
    status: str = "ok"
    llmConfigured: bool
    embeddingsConfigured: bool
    mineruConfigured: bool
    specIndexReady: bool
    specChunkCount: int
    retrieval: str
    celllineIndexReady: bool = False
    celllineRecordCount: int = 0
    celllineRetrieval: str = "unavailable"
