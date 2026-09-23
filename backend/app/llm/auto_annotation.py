"""Opt-in automatic execution contract; manual proposal tools stay unchanged."""

import json
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
Do not ask the user to click Apply, confirm existing values, or navigate.
Prefer deltas against the latest snapshot; preserve correct existing values.
Never invent sample identities, biological replicates, file/channel assignments,
or experimental facts to pass validation. Retrieve available evidence first.
Unknown values may use SDRF missing-value conventions only where allowed and
justified. Identifier conflicts and ambiguous mappings must be reported blocked.
Application errors in the next request mean the entire failed batch was rolled
back: propose a corrected batch using the new snapshot. Do not repeat a failed
plan unchanged. Any manual confirmation-card instructions are superseded in this
mode; evidence requirements are not. Keep reasoning and sources in the cards.
"""


def automatic_proposal_tool() -> dict:
    tool = deepcopy(PROPOSE_ACTIONS_TOOL)
    parameters = tool["function"]["parameters"]
    parameters["properties"]["automation"] = {
        "type": "object",
        "properties": {
            "status": {"type": "string", "enum": ["ready", "blocked"]},
            "issues": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["status", "issues"],
    }
    parameters["required"].append("automation")
    return tool


def parse_automation_report(arguments: str, rejected: list[str]) -> AutomationReport:
    try:
        report = AutomationReport.model_validate(json.loads(arguments).get("automation"))
    except (ValueError, TypeError, AttributeError):
        return AutomationReport(status="blocked", issues=["Assistant did not return a valid completion report."])
    if rejected:
        return AutomationReport(status="blocked", issues=[*report.issues, *rejected])
    if report.issues:
        report.status = "blocked"
    if report.status == "blocked" and not report.issues:
        report.issues = ["The assistant could not establish that this step is complete."]
    return report
