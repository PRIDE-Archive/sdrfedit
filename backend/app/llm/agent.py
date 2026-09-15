"""The agent loop: LLM ↔ tools, ending in a user-facing answer plus wizard actions.

The loop is scoped to one wizard step per turn. Suggestions for other steps are
dropped and the model is told to re-propose them when the user gets there, so the
panel walks the user through the wizard page by page instead of dumping every
value at once. Findings are cached per session so the per-step turns do not
re-fetch PRIDE and the paper each time.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncGenerator
from typing import Any

from ..config import get_settings
from ..schemas import (
    ALLOWED_OPS,
    STEP_ORDER,
    STEP_TITLES,
    ChatRequest,
    ChatResult,
    Citation,
    NextStepHint,
    ToolInvocation,
    WizardAction,
    WizardStepId,
    next_step_after,
)
from ..session import get_session_store
from ..skills import parse_slash_command
from ..tools import ontology, registry
from .client import LlmClient, LlmError, ToolCall
from .prompts import (
    PROPOSE_ACTIONS_TOOL,
    SYSTEM_PROMPT,
    render_evidence,
    render_step_focus,
    render_wizard_context,
)
from .thinking import ThinkingSplitter

MAX_HISTORY_MESSAGES = 24
PROPOSE_TOOL_NAME = "propose_wizard_actions"

# A round can end with a ThinkingSplitter that never saw </think> for two very
# different reasons: the model answered directly (short, legitimate), or it
# was still mid-thought when cut off by the token cap (observed in testing --
# the model can spiral into repetitive reasoning for thousands of tokens
# before ever closing the block). Length is the only signal available to
# tell them apart; a genuine direct answer is nowhere near this long.
MAX_UNCLOSED_THINKING_CHARS = 800
CUTOFF_FALLBACK_MESSAGE = (
    "Sorry, that took too long to think through and got cut off. Could you try again?"
)


def _resolve_round_text(text: str, saw_close_tag: bool) -> str:
    """Guard against dumping a runaway, unclosed <think> block on the user.

    Only applies when </think> was never seen this round -- text that
    already streamed after a genuine close tag is never touched here,
    however long it legitimately is.
    """
    if not saw_close_tag and len(text) > MAX_UNCLOSED_THINKING_CHARS:
        return CUTOFF_FALLBACK_MESSAGE
    return text

# The panel lets the user expand a tool result; beyond this it is unreadable
# anyway and only costs bandwidth.
MAX_UI_RESULT_CHARS = 8000
MAX_ARGS_PREVIEW_CHARS = 220


class AgentEvent(dict):
    """A plain dict so routers can serialise it straight to SSE."""

    @staticmethod
    def status(text: str) -> "AgentEvent":
        return AgentEvent(type="status", text=text)

    @staticmethod
    def token(text: str) -> "AgentEvent":
        return AgentEvent(type="token", text=text)

    @staticmethod
    def tool_start(payload: dict[str, Any]) -> "AgentEvent":
        """Emitted before a tool runs so the UI can show a live, expandable row."""
        return AgentEvent(type="tool_start", tool=payload)

    @staticmethod
    def tool(invocation: ToolInvocation) -> "AgentEvent":
        return AgentEvent(type="tool", tool=invocation.model_dump())

    @staticmethod
    def actions(actions: list[WizardAction]) -> "AgentEvent":
        return AgentEvent(type="actions", actions=[a.model_dump() for a in actions])

    @staticmethod
    def citations(citations: list[Citation]) -> "AgentEvent":
        return AgentEvent(type="citations", citations=[c.model_dump() for c in citations])

    @staticmethod
    def next_step(hint: NextStepHint) -> "AgentEvent":
        return AgentEvent(type="next_step", nextStep=hint.model_dump())

    @staticmethod
    def error(text: str) -> "AgentEvent":
        return AgentEvent(type="error", text=text)

    @staticmethod
    def done(result: ChatResult) -> "AgentEvent":
        return AgentEvent(type="done", result=result.model_dump())


def resolve_focus_step(request: ChatRequest) -> WizardStepId:
    """Which step this turn advises on: the panel's request, else where the user is."""
    if request.focusStep in STEP_ORDER:
        return request.focusStep  # type: ignore[return-value]
    snapshot = request.wizardState
    if snapshot and snapshot.currentStepId in STEP_ORDER:
        return snapshot.currentStepId  # type: ignore[return-value]
    return "setup"


def _resolve_skill(request: ChatRequest):
    """Prefer an explicit skill from the panel; fall back to parsing the last user turn."""
    if request.skill:
        # Rebuild from the slash line so instructions stay in one place.
        synthetic = f"/{request.skill}"
        if request.skillArgs:
            synthetic = f"{synthetic} {request.skillArgs}"
        parsed = parse_slash_command(synthetic)
        if parsed:
            return parsed
    last_user = next(
        (message.content for message in reversed(request.messages) if message.role == "user"),
        "",
    )
    return parse_slash_command(last_user)


async def run_agent(request: ChatRequest) -> AsyncGenerator[AgentEvent, None]:
    settings = get_settings()
    client = LlmClient(settings)
    store = get_session_store()
    focus_step = resolve_focus_step(request)
    skill = _resolve_skill(request)

    # Collected as parts and joined into ONE system message below -- some
    # OpenAI-compatible backends (e.g. vLLM's default chat template) reject a
    # messages array with more than one system-role entry ("System message
    # must be at the beginning"), so multiple leading system messages is not
    # a portable shape even though OpenAI itself tolerates it.
    system_parts: list[str] = [
        SYSTEM_PROMPT,
        render_wizard_context(request.wizardState),
        render_step_focus(focus_step, request.wizardState),
    ]

    if skill:
        system_parts.append(
            f"The user invoked the /{skill.name} skill"
            + (f" with arguments: {skill.args}" if skill.args else "")
            + ".\n\n"
            + skill.instructions
        )
        yield AgentEvent.status(f"Running /{skill.name}")

    evidence = render_evidence([note.text for note in store.get_evidence(request.sessionId)])
    if evidence:
        system_parts.append(evidence)

    accession = request.accession or (skill.accession if skill else None)
    if accession:
        system_parts.append(f"The panel reports the user is working with accession {accession}.")

    messages: list[dict[str, Any]] = [
        {"role": "system", "content": "\n\n".join(part for part in system_parts if part.strip())}
    ]

    history = request.messages[-MAX_HISTORY_MESSAGES:]
    for index, message in enumerate(history):
        content = message.content
        # If the last user turn is still the raw slash command, expand it so the
        # model sees a concrete request even when the panel forgot to rewrite it.
        if (
            skill
            and message.role == "user"
            and index == len(history) - 1
            and parse_slash_command(message.content)
        ):
            content = skill.user_prompt
        messages.append({"role": message.role, "content": content})

    tools = [*registry.openai_tool_specs(), PROPOSE_ACTIONS_TOOL]

    answer_parts: list[str] = []
    collected_actions: list[WizardAction] = []
    collected_citations: list[Citation] = []
    collected_tools: list[ToolInvocation] = []
    seen_citations: set[str] = set()
    # Accessions / labels verified via ontology or cell-line tools this turn.
    verified_ids: set[str] = set()
    verified_labels: set[str] = set()
    propose_rejected: list[str] = []
    propose_deferred: list[str] = []

    try:
        exhausted_rounds = True
        for _round in range(max(1, settings.llm_max_tool_rounds)):
            round_text: list[str] = []
            calls: list[ToolCall] = []
            splitter = ThinkingSplitter()
            yield AgentEvent.status("Thinking…")

            async for event in client.stream(messages, tools):
                if event.type == "token":
                    visible = splitter.feed(event.text)
                    if visible:
                        round_text.append(visible)
                        yield AgentEvent.token(visible)
                elif event.type == "tool_calls":
                    calls = event.tool_calls
            trailing = _resolve_round_text(splitter.flush(), splitter.saw_close_tag)
            if trailing:
                round_text.append(trailing)
                yield AgentEvent.token(trailing)

            text = "".join(round_text)
            if text.strip():
                answer_parts.append(text)

            if not calls:
                exhausted_rounds = False
                break

            messages.append(
                {
                    "role": "assistant",
                    # Empty string rather than null: some OpenAI-compatible servers
                    # reject a null content even alongside tool_calls.
                    "content": text,
                    "tool_calls": [
                        {
                            "id": call.id,
                            "type": "function",
                            "function": {"name": call.name, "arguments": call.arguments or "{}"},
                        }
                        for call in calls
                    ],
                }
            )

            for call in calls:
                if call.name == PROPOSE_TOOL_NAME:
                    actions, rejected, deferred = _parse_actions(call.arguments, focus_step)
                    actions, gate_rejected = _gate_ontology_actions(
                        actions,
                        request.wizardState,
                        verified_ids,
                        verified_labels,
                    )
                    rejected.extend(gate_rejected)
                    propose_rejected.extend(rejected)
                    propose_deferred.extend(deferred)
                    collected_actions.extend(actions)
                    if actions:
                        yield AgentEvent.actions(actions)
                    if rejected or deferred:
                        yield AgentEvent.status(
                            f"Propose: accepted {len(actions)}, "
                            f"rejected {len(rejected)}, deferred {len(deferred)}"
                        )
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": call.id,
                            "content": json.dumps(_propose_feedback(actions, rejected, deferred)),
                        }
                    )
                    continue

                call_id = call.id or f"call_{len(collected_tools) + 1}"
                args_preview = _args_preview(call.arguments)
                yield AgentEvent.tool_start(
                    {
                        "id": call_id,
                        "name": call.name,
                        "title": registry.title_for(call.name),
                        "summary": registry.status_for(call.name) + "…",
                        "argsPreview": args_preview,
                        "resultJson": "",
                        "ok": True,
                        "durationMs": 0,
                        "running": True,
                    }
                )

                started = time.monotonic()
                result = await registry.dispatch(call.name, call.arguments, request.sessionId)
                duration_ms = int((time.monotonic() - started) * 1000)
                messages.append({"role": "tool", "tool_call_id": call.id, "content": result})

                parsed = _safe_json(result)
                summary, ok = registry.describe(call.name, parsed)
                invocation = ToolInvocation(
                    id=call_id,
                    name=call.name,
                    title=registry.title_for(call.name),
                    summary=summary,
                    argsPreview=args_preview,
                    resultJson=_pretty_json(parsed, result),
                    ok=ok,
                    durationMs=duration_ms,
                )
                collected_tools.append(invocation)
                yield AgentEvent.tool(invocation)

                _record_verified_terms(call.name, parsed, verified_ids, verified_labels)

                note = _evidence_note(call.name, parsed)
                if note:
                    store.add_evidence(request.sessionId, note[0], note[1])

                for citation in _citations_from_tool(call.name, parsed):
                    key = f"{citation.source}|{citation.title}|{citation.url}"
                    if key not in seen_citations:
                        seen_citations.add(key)
                        collected_citations.append(citation)

        if exhausted_rounds:
            # Search rounds are spent; keep ONLY propose_wizard_actions so the model
            # can still emit Apply cards from terms already verified this turn.
            yield AgentEvent.status("Wrapping up — proposing cards from verified evidence")
            messages.append(
                {
                    # "user", not "system": some backends (e.g. vLLM's default chat
                    # template) reject a system-role message anywhere but the very
                    # first position ("System message must be at the beginning").
                    "role": "user",
                    "content": (
                        "Ontology / evidence tool rounds are exhausted. "
                        "You MUST call propose_wizard_actions NOW for the current focus step, "
                        "using only accessions and labels already verified in this turn "
                        "(search_ontology / search_cell_line / verify_* results above). "
                        "Do not call any other tool. Do not answer with prose alone — "
                        "without propose_wizard_actions the user gets no Apply cards."
                    ),
                }
            )
            closing_text: list[str] = []
            closing_calls: list[ToolCall] = []
            closing_splitter = ThinkingSplitter()
            yield AgentEvent.status("Thinking…")
            async for event in client.stream(messages, tools=[PROPOSE_ACTIONS_TOOL]):
                if event.type == "token":
                    visible = closing_splitter.feed(event.text)
                    if visible:
                        closing_text.append(visible)
                        yield AgentEvent.token(visible)
                elif event.type == "tool_calls":
                    closing_calls = event.tool_calls
            trailing = _resolve_round_text(closing_splitter.flush(), closing_splitter.saw_close_tag)
            if trailing:
                closing_text.append(trailing)
                yield AgentEvent.token(trailing)
            if closing_text:
                answer_parts.append("".join(closing_text))

            if closing_calls:
                messages.append(
                    {
                        "role": "assistant",
                        "content": "".join(closing_text),
                        "tool_calls": [
                            {
                                "id": call.id,
                                "type": "function",
                                "function": {
                                    "name": call.name,
                                    "arguments": call.arguments or "{}",
                                },
                            }
                            for call in closing_calls
                        ],
                    }
                )
                for call in closing_calls:
                    if call.name != PROPOSE_TOOL_NAME:
                        messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": call.id,
                                "content": json.dumps(
                                    {
                                        "error": (
                                            f"Tool '{call.name}' is disabled in wrap-up. "
                                            "Call propose_wizard_actions only."
                                        )
                                    }
                                ),
                            }
                        )
                        continue
                    actions, rejected, deferred = _parse_actions(call.arguments, focus_step)
                    actions, gate_rejected = _gate_ontology_actions(
                        actions,
                        request.wizardState,
                        verified_ids,
                        verified_labels,
                    )
                    rejected.extend(gate_rejected)
                    propose_rejected.extend(rejected)
                    propose_deferred.extend(deferred)
                    collected_actions.extend(actions)
                    if actions:
                        yield AgentEvent.actions(actions)
                    if rejected or deferred:
                        yield AgentEvent.status(
                            f"Propose: accepted {len(actions)}, "
                            f"rejected {len(rejected)}, deferred {len(deferred)}"
                        )
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": call.id,
                            "content": json.dumps(
                                _propose_feedback(actions, rejected, deferred)
                            ),
                        }
                    )

        if not collected_actions and focus_step == "characteristics":
            if propose_rejected:
                miss = (
                    "No characteristic suggestion cards were accepted "
                    f"({len(propose_rejected)} rejected). "
                    + "; ".join(propose_rejected[:5])
                )
            else:
                miss = (
                    "No characteristic suggestion cards were proposed this turn. "
                    "Call propose_wizard_actions with verified ontology terms "
                    "(a prose summary alone does not create Apply cards)."
                )
            yield AgentEvent.status(miss)
            if not any(miss[:40] in part for part in answer_parts):
                answer_parts.append(miss)

        if collected_citations:
            yield AgentEvent.citations(collected_citations)

        hint = _next_step_hint(focus_step, bool(collected_actions), request.mode)
        if hint:
            yield AgentEvent.next_step(hint)

        yield AgentEvent.done(
            ChatResult(
                content="\n\n".join(part.strip() for part in answer_parts if part.strip()),
                actions=collected_actions,
                citations=collected_citations,
                toolCalls=collected_tools,
                nextStep=hint,
                trace={
                    "focusStep": focus_step,
                    "mode": request.mode,
                    "acceptedActions": len(collected_actions),
                    "rejected": propose_rejected,
                    "deferred": propose_deferred,
                    "verifiedIds": sorted(verified_ids),
                    "toolCount": len(collected_tools),
                },
            )
        )

    except LlmError as error:
        yield AgentEvent.error(str(error))
    except Exception as error:  # noqa: BLE001 - surface the failure instead of dropping the stream
        yield AgentEvent.error(f"{type(error).__name__}: {error}")


def _next_step_hint(focus_step: WizardStepId, proposed_actions: bool, mode: str) -> NextStepHint | None:
    """Where to send the user next — only after at least one action was accepted."""
    if not proposed_actions:
        return None
    following = next_step_after(focus_step)
    if following is None:
        return None
    index = STEP_ORDER.index(following)
    title = STEP_TITLES[following]
    return NextStepHint(
        stepId=following,
        index=index,
        title=title,
        prompt=f"Now help me with step {index + 1}: {title}.",
    )


def _propose_feedback(
    actions: list[WizardAction], rejected: list[str], deferred: list[str]
) -> dict[str, Any]:
    note = (
        "Suggestions are shown to the user for review. Now write the explanation; "
        "do not repeat every value."
    )
    if rejected:
        note = (
            "Some actions were rejected (see rejected). For ontology-backed columns, call "
            "search_ontology(column, query) or search_cell_line first, then propose using "
            "the exact returned id/label — never paste recipes or free text. " + note
        )
    if deferred:
        note = (
            "Actions outside the current step were not shown to the user. Re-propose them "
            "when the user reaches that step. " + note
        )
    return {"accepted": len(actions), "rejected": rejected, "deferred": deferred, "note": note}


def _record_verified_terms(
    name: str, result: Any, verified_ids: set[str], verified_labels: set[str]
) -> None:
    """Remember OLS / Cellosaurus hits from this turn for the propose gate."""
    if not isinstance(result, dict) or result.get("error"):
        return
    if result.get("ok") is False or result.get("valid") is False:
        return

    if name == "search_ontology":
        for term in result.get("terms") or []:
            term_id = str(term.get("id") or "").strip()
            label = str(term.get("label") or "").strip()
            if term_id:
                verified_ids.add(term_id.lower())
            if label:
                verified_labels.add(label.lower())
        return

    if name == "verify_ontology_term" and result.get("valid"):
        term = result.get("term") or {}
        term_id = str(term.get("id") or result.get("accession") or "").strip()
        label = str(term.get("label") or "").strip()
        if term_id:
            verified_ids.add(term_id.lower())
        if label:
            verified_labels.add(label.lower())
        return

    if name == "search_cell_line":
        for match in result.get("matches") or []:
            accession = str(match.get("cellosaurusAccession") or "").strip()
            cell_line = str(match.get("cellLine") or "").strip()
            if accession:
                verified_ids.add(accession.lower())
            if cell_line:
                verified_labels.add(cell_line.lower())
        return

    if name == "verify_cellosaurus_accession" and result.get("valid"):
        accession = str(result.get("accession") or "").strip()
        label = str((result.get("term") or {}).get("cellLine") or result.get("cellLine") or "").strip()
        if accession:
            verified_ids.add(accession.lower())
        if label:
            verified_labels.add(label.lower())


def _column_ontologies(snapshot: Any, column: str) -> list[str] | None:
    """Ontologies for a column from the wizard snapshot, else COLUMN_ONTOLOGIES.

    Returns None when the column is not ontology-backed (free text / pattern).
    """
    if snapshot is not None:
        for item in snapshot.characteristicColumns or []:
            if isinstance(item, str):
                if item != column:
                    continue
                return ontology.COLUMN_ONTOLOGIES.get(ontology.column_key(column))
            if item.name != column:
                continue
            if item.ontologies:
                return [str(prefix).strip().lower() for prefix in item.ontologies if str(prefix).strip()]
            return ontology.COLUMN_ONTOLOGIES.get(ontology.column_key(column))
    return ontology.COLUMN_ONTOLOGIES.get(ontology.column_key(column))


def _gate_ontology_actions(
    actions: list[WizardAction],
    snapshot: Any,
    verified_ids: set[str],
    verified_labels: set[str],
) -> tuple[list[WizardAction], list[str]]:
    """Drop ontology-column proposals that were not verified this turn."""
    kept: list[WizardAction] = []
    rejected: list[str] = []

    for action in actions:
        if action.op != "addCharacteristicChoice":
            kept.append(action)
            continue

        args = action.args or []
        if len(args) < 2:
            rejected.append(f"{action.op}: needs [column, value, optionalTerm]")
            continue

        column = str(args[0])
        value = str(args[1]).strip()
        term = args[2] if len(args) > 2 and isinstance(args[2], dict) else None
        key = ontology.column_key(column)

        if ontology.is_reserved_value(value):
            kept.append(action)
            continue

        if key == "cellosaurus accession":
            if not value.upper().startswith("CVCL_"):
                rejected.append(
                    f"{column}: value must be a Cellosaurus id (CVCL_…); got '{value}'"
                )
                continue
            if value.lower() not in verified_ids:
                rejected.append(
                    f"{column}: '{value}' was not verified this turn — call "
                    "search_cell_line or verify_cellosaurus_accession first"
                )
                continue
            kept.append(action)
            continue

        if key == "cell line":
            label_ok = value.lower() in verified_labels
            id_ok = bool(term and str(term.get("id") or "").lower() in verified_ids)
            if not label_ok and not id_ok:
                rejected.append(
                    f"{column}: '{value}' was not verified this turn — call "
                    "search_cell_line (preferred) or search_ontology first"
                )
                continue
            kept.append(action)
            continue

        ontologies = _column_ontologies(snapshot, column)
        if not ontologies:
            kept.append(action)
            continue

        if not term or not term.get("id") or not term.get("label"):
            rejected.append(
                f"{column}: ontology column requires args "
                f'[column, label, {{"id","label"}}] from search_ontology; '
                f"refused free-text '{value[:80]}'"
            )
            continue

        term_id = str(term["id"]).strip()
        term_label = str(term["label"]).strip()
        if term_id.lower() not in verified_ids:
            rejected.append(
                f"{column}: term {term_id} was not returned by search_ontology/"
                "verify_ontology_term this turn — search first, then propose"
            )
            continue

        # Accept any short query the model used as value; always store the OLS label.
        kept.append(
            action.model_copy(
                update={
                    "args": [column, term_label, {"id": term_id, "label": term_label}],
                }
            )
        )

    return kept, rejected


def _parse_actions(
    raw_arguments: str, focus_step: WizardStepId | None = None
) -> tuple[list[WizardAction], list[str], list[str]]:
    """Validate proposed actions against the op whitelist and the current step."""
    try:
        payload = json.loads(raw_arguments or "{}")
    except json.JSONDecodeError as error:
        return [], [f"arguments were not valid JSON: {error}"], []

    actions: list[WizardAction] = []
    rejected: list[str] = []
    deferred: list[str] = []

    for entry in payload.get("actions") or []:
        if not isinstance(entry, dict):
            rejected.append("action was not an object")
            continue

        op = str(entry.get("op") or "").strip()
        expected_step = ALLOWED_OPS.get(op)
        if not expected_step:
            rejected.append(f"unknown op '{op}'")
            continue

        if focus_step and expected_step != focus_step:
            deferred.append(f"{op} belongs to step '{expected_step}', not the current '{focus_step}'")
            continue

        raw_args = entry.get("argsJson")
        if isinstance(raw_args, list):
            args = raw_args
        else:
            try:
                args = json.loads(raw_args or "[]")
            except json.JSONDecodeError as error:
                rejected.append(f"{op}: argsJson was not valid JSON ({error})")
                continue
        if not isinstance(args, list):
            args = [args]

        # Models often emit setExperimentTemplates as ["cell-lines"] instead of
        # [["cell-lines"]]. Normalize so the frontend always receives a nested list.
        if op == "setExperimentTemplates":
            if not args:
                args = [[]]
            elif isinstance(args[0], list):
                args = [list(args[0])]
            elif all(isinstance(item, str) for item in args):
                args = [list(args)]

        actions.append(
            WizardAction(
                step=expected_step,
                op=op,
                args=args,
                label=str(entry.get("label") or op),
                reasoning=str(entry.get("reasoning") or ""),
                confidence=entry.get("confidence") if entry.get("confidence") in ("high", "medium", "low") else "medium",
            )
        )

    return actions, rejected, deferred


def _safe_json(raw_result: str) -> Any:
    try:
        return json.loads(raw_result)
    except json.JSONDecodeError:
        return raw_result


def _pretty_json(parsed: Any, raw_result: str) -> str:
    """Indented JSON for the expandable tool row, truncated to keep the SSE small."""
    if isinstance(parsed, (dict, list)):
        rendered = json.dumps(parsed, ensure_ascii=False, indent=2, default=str)
    else:
        rendered = raw_result
    if len(rendered) <= MAX_UI_RESULT_CHARS:
        return rendered
    return f"{rendered[:MAX_UI_RESULT_CHARS]}\n… truncated, {len(rendered) - MAX_UI_RESULT_CHARS} more characters"


def _args_preview(raw_arguments: str | None) -> str:
    parsed = _safe_json(raw_arguments or "{}")
    rendered = (
        json.dumps(parsed, ensure_ascii=False, default=str)
        if isinstance(parsed, (dict, list))
        else str(parsed)
    )
    if rendered in ("{}", "[]"):
        return ""
    if len(rendered) <= MAX_ARGS_PREVIEW_CHARS:
        return rendered
    return f"{rendered[:MAX_ARGS_PREVIEW_CHARS]}…"


def _evidence_note(name: str, result: Any) -> tuple[str, str] | None:
    """A compact, replayable digest of what a tool established."""
    if not isinstance(result, dict) or result.get("error"):
        return None

    if name == "get_pride_dataset":
        accession = result.get("accession") or "dataset"
        files = result.get("files") or {}
        names = files.get("rawFileNames") or []
        parts = [
            f"PRIDE {accession}: {result.get('title') or 'untitled'}",
            f"organisms: {_listing(result.get('organisms'))}",
            f"organism parts: {_listing(result.get('organismParts'))}",
            f"diseases: {_listing(result.get('diseases'))}",
            f"instruments: {_listing(result.get('instruments'))}",
            f"experiment types: {_listing(result.get('experimentTypes'))}",
            f"quantification: {_listing(result.get('quantificationMethods'))}",
            f"reported PTMs: {_listing(result.get('identifiedPtms'))}",
            f"raw files: {files.get('rawFileCount', len(names))}, e.g. {_listing(names, 3)}",
            f"references: {_references(result.get('references'))}",
        ]
        return f"pride:{accession}", "; ".join(part for part in parts if not part.endswith(": -"))

    if name == "get_pride_raw_files":
        accession = result.get("accession") or "dataset"
        names = result.get("rawFileNames") or []
        return (
            f"raw-files:{accession}",
            f"PRIDE {accession} has {result.get('rawFileCount', len(names))} raw files, "
            f"e.g. {_listing(names, 5)}. Call get_pride_raw_files again for the full list.",
        )

    if name == "find_publication":
        if not result.get("found"):
            return None
        identifier = result.get("pmcid") or result.get("pmid") or result.get("doi") or "paper"
        return (
            f"publication:{identifier}",
            f"Paper \"{result.get('title')}\" ({result.get('journal')}, {result.get('year')}), "
            f"pmid {result.get('pmid')}, pmcid {result.get('pmcid')}, doi {result.get('doi')}. "
            f"Open full text: {'yes' if result.get('fullTextAvailable') else 'no'}.",
        )

    if name == "get_publication_full_text":
        pmcid = result.get("pmcid") or "article"
        sections = result.get("sections") or {}
        methods = (sections.get("methods") or next(iter(sections.values()), "") or "")[:700]
        return (
            f"fulltext:{pmcid}",
            f"Read {pmcid} sections {_listing(list(sections), 6)}. Methods excerpt: {methods} "
            f"(call get_publication_full_text with pmcid={pmcid} to re-read in full).",
        )

    if name in ("read_document", "parse_pdf_url"):
        if result.get("ok") is False:
            return None
        document_id = result.get("documentId") or result.get("fileName") or "document"
        sections = result.get("sections") or {}
        available = result.get("availableSections") or list(sections)
        excerpt = (sections.get("methods") or next(iter(sections.values()), "") or "")[:700]
        detail = f" Methods excerpt: {excerpt}" if excerpt else ""
        return (
            f"document:{document_id}",
            f"Uploaded document {result.get('fileName') or document_id} has sections "
            f"{_listing(available, 6)}; call read_document to re-read it.{detail}",
        )

    return None


def _listing(items: Any, limit: int = 4) -> str:
    if not isinstance(items, list) or not items:
        return "-"
    head = ", ".join(str(item) for item in items[:limit] if item)
    return f"{head}, …" if len(items) > limit else head or "-"


def _references(references: Any) -> str:
    if not isinstance(references, list) or not references:
        return "-"
    rendered: list[str] = []
    for reference in references[:3]:
        if not isinstance(reference, dict):
            continue
        if reference.get("pubmedId"):
            rendered.append(f"PMID {reference['pubmedId']}")
        elif reference.get("doi"):
            rendered.append(f"DOI {reference['doi']}")
    return ", ".join(rendered) or "-"


def _citations_from_tool(name: str, result: Any) -> list[Citation]:
    """Turn tool output into citations the panel can link to."""
    if not isinstance(result, dict) or result.get("error"):
        return []

    if name == "search_specification":
        return [
            Citation(
                source="spec",
                title=passage.get("section", "SDRF specification"),
                anchor=passage.get("anchor"),
                url=passage.get("anchor"),
                snippet=(passage.get("text") or "")[:320],
            )
            for passage in result.get("passages") or []
        ]

    if name in ("get_pride_dataset", "get_pride_raw_files"):
        accession = result.get("accession")
        if not accession:
            return []
        return [
            Citation(
                source="pride",
                title=result.get("title") or f"PRIDE {accession}",
                url=result.get("url") or f"https://www.ebi.ac.uk/pride/archive/projects/{accession}",
                snippet=(result.get("description") or "")[:320],
            )
        ]

    if name == "find_publication" and result.get("found"):
        return [
            Citation(
                source="paper",
                title=result.get("title") or "Publication",
                url=result.get("url"),
                snippet=(result.get("abstract") or "")[:320],
            )
        ]

    if name == "get_publication_full_text":
        return [
            Citation(
                source="paper",
                title=result.get("title") or result.get("pmcid") or "Full text",
                url=result.get("url"),
                snippet="",
            )
        ]

    return []
