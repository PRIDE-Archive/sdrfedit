"""Opt-in automatic execution contract; manual proposal tools stay unchanged."""

import json
import re
from copy import deepcopy

from ..schemas import AutomationReport
from .prompts import PROPOSE_ACTIONS_TOOL

AUTO_ANNOTATION_PROMPT = """
Automatic annotation is explicitly enabled for this run. The client will apply
your actions without individual approval, validate the result, and request the
next step. Keep the current step restriction and all evidence/ontology gates.
Call propose_wizard_actions with an automation report on every turn, including
when no mutations are needed. Set status=ready only when the evidence supports
completion of this step after these actions; otherwise set status=blocked and
list the concrete missing evidence or unresolved conflicts in issues.
issues contains ONLY blockers for the CURRENT step. Put explanations, preserved
values, no-op decisions, and work belonging to later steps in notes instead.
When this step is complete, return status=ready and issues=[], even if actions=[]
or notes is non-empty. In Sample Values, a run-scoped factor is assigned later in
Runs & Files; this is a note, not a missing sample-level assignment. A single
characteristic candidate already assigned to the sample needs no patch and does
not block advancement. For example:
{"actions": [], "automation": {"status": "ready", "issues": [], "notes":
 ["Existing sample values match; run-scoped factors will be assigned in Runs & Files."]}}
Do not ask the user to click Apply, confirm existing values, or navigate.
Prefer deltas against the latest snapshot; preserve correct existing values.
Never invent sample identities, biological replicates, file/channel assignments,
or experimental facts to pass validation. Retrieve available evidence first.
Unknown values may use SDRF missing-value conventions only where allowed and
justified. Identifier conflicts and ambiguous mappings must be reported blocked.
The client requests each step once and may attempt bounded repairs of invalid
action arguments. It pauses on unresolved evidence or unrepaired application errors. If evidence is insufficient,
state exactly what the user must provide or decide and report blocked. The user
controls when to continue. Any manual confirmation-card instructions are
superseded in this mode; evidence requirements are not. Keep reasoning and
sources in the cards.
"""


def automatic_proposal_tool() -> dict:
    tool = deepcopy(PROPOSE_ACTIONS_TOOL)
    parameters = tool["function"]["parameters"]
    parameters["properties"]["automation"] = {
        "type": "object",
        "properties": {
            "status": {"type": "string", "enum": ["ready", "blocked"],
                       "description": "Whether the CURRENT step is complete after applying this batch. No-op steps may be ready."},
            "issues": {"type": "array", "items": {"type": "string"},
                       "description": "Blocking errors or missing evidence for this step only. Empty when ready. Never put informational notes here."},
            "notes": {"type": "array", "items": {"type": "string"},
                      "description": "Non-blocking explanations: unchanged values, no patch needed, or assignments belonging to a later step."},
        },
        "required": ["status", "issues", "notes"],
    }
    parameters["required"].append("automation")
    return tool


def parse_automation_report(arguments: str, rejected: list[str]) -> AutomationReport:
    try:
        report = AutomationReport.model_validate(json.loads(arguments).get("automation"))
    except (ValueError, TypeError, AttributeError):
        return AutomationReport(status="blocked", issues=["Assistant did not return a valid completion report."])
    # Compatibility with reports produced before `notes` existed. Honor only an
    # explicit informational label, never infer severity from words such as
    # "not needed" (a real error could contain them). Validator rejects are
    # appended afterwards and can never be downgraded this way.
    blockers: list[str] = []
    informational: list[str] = []
    for issue in report.issues:
        if not issue.strip():
            continue
        match = re.match(r"^\s*Informational\s*:\s*(.+)$", issue, re.IGNORECASE | re.DOTALL)
        if match:
            informational.append(match[1].strip())
        else:
            blockers.append(issue.strip())
    report.notes = list(dict.fromkeys(note.strip() for note in [*report.notes, *informational] if note.strip()))
    report.issues = list(dict.fromkeys([*blockers, *rejected]))
    if informational and not report.issues:
        # Old reports sometimes set blocked solely because issues held notes.
        report.status = "ready"
    if report.issues:
        report.status = "blocked"
    if report.status == "blocked" and not report.issues:
        report.issues = ["The assistant could not establish that this step is complete."]
    return report
