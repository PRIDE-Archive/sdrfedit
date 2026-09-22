import json

from app.llm.agent import (
    _citations_from_tool,
    _evidence_note,
    _next_step_hint,
    _parse_actions,
    resolve_focus_step,
)
from app.schemas import ALLOWED_OPS, ChatRequest, WizardSnapshot
from app.tools import registry


def _payload(actions):
    return json.dumps({"actions": actions})


def test_valid_action_is_parsed_with_inferred_step():
    actions, rejected, deferred = _parse_actions(
        _payload(
            [
                {
                    "op": "setCleavageAgent",
                    "argsJson": '[{"name":"Trypsin","msAccession":"MS:1001251"}]',
                    "label": "Cleavage agent: Trypsin",
                    "reasoning": "Methods section.",
                    "confidence": "high",
                }
            ]
        )
    )

    assert rejected == []
    assert deferred == []
    assert len(actions) == 1
    action = actions[0]
    assert action.step == "protocol"
    assert action.args == [{"name": "Trypsin", "msAccession": "MS:1001251"}]
    assert action.confidence == "high"


def test_unknown_op_is_rejected():
    actions, rejected, _ = _parse_actions(
        _payload([{"op": "deleteEverything", "argsJson": "[]", "label": "nope"}])
    )

    assert actions == []
    assert rejected == ["unknown op 'deleteEverything'"]


def test_malformed_args_are_rejected_without_dropping_siblings():
    actions, rejected, _ = _parse_actions(
        _payload(
            [
                {"op": "setSampleCount", "argsJson": "not json", "label": "bad"},
                {"op": "setSampleCount", "argsJson": "[12]", "label": "12 samples"},
            ]
        )
    )

    assert len(actions) == 1
    assert actions[0].args == [12]
    assert len(rejected) == 1


def test_args_accepts_a_raw_list_too():
    actions, _, _ = _parse_actions(
        _payload([{"op": "setLabelConfig", "argsJson": ["tmt10"], "label": "TMT 10-plex"}])
    )
    assert actions[0].args == ["tmt10"]


def test_set_experiment_templates_normalizes_flat_string_list():
    """Models often emit ["cell-lines"] instead of [["cell-lines"]]."""
    actions, rejected, _ = _parse_actions(
        _payload(
            [
                {
                    "op": "setExperimentTemplates",
                    "argsJson": '["cell-lines"]',
                    "label": "Experiment: add cell-lines",
                }
            ]
        )
    )
    assert rejected == []
    assert actions[0].args == [["cell-lines"]]


def test_set_experiment_templates_keeps_nested_array():
    actions, _, _ = _parse_actions(
        _payload(
            [
                {
                    "op": "setExperimentTemplates",
                    "argsJson": '[["cell-lines","dia-acquisition"]]',
                    "label": "Experiment templates",
                }
            ]
        )
    )
    assert actions[0].args == [["cell-lines", "dia-acquisition"]]


def test_scalar_args_are_wrapped():
    actions, _, _ = _parse_actions(_payload([{"op": "setSampleCount", "argsJson": "6", "label": "6"}]))
    assert actions[0].args == [6]


def test_every_allowed_op_maps_to_a_known_step():
    valid_steps = {"setup", "characteristics", "samples", "runs-files", "protocol", "review"}
    assert set(ALLOWED_OPS.values()) <= valid_steps


def test_sample_value_ops_are_on_samples_step():
    assert ALLOWED_OPS["setBiologicalReplicates"] == "samples"
    assert ALLOWED_OPS["setSourceNames"] == "samples"
    assert ALLOWED_OPS["setFactorColumnValues"] == "samples"
    assert ALLOWED_OPS["setSampleFactorValue"] == "samples"
    assert "setSamples" not in ALLOWED_OPS
    assert "factors" not in set(ALLOWED_OPS.values())


def test_factor_definition_ops_are_on_characteristics_step():
    assert ALLOWED_OPS["setFactors"] == "characteristics"
    assert ALLOWED_OPS["addFactor"] == "characteristics"
    assert ALLOWED_OPS["addFactorValue"] == "characteristics"


def test_assign_files_by_name_op_is_on_runs_files_step():
    assert ALLOWED_OPS["assignFilesToRunsByName"] == "runs-files"
    assert ALLOWED_OPS["replaceWithUnassignedFileNames"] == "runs-files"
    assert ALLOWED_OPS["assignDataFilesToRun"] == "runs-files"


# ------------------------------------------------------- one step at a time


def test_actions_outside_the_focus_step_are_deferred():
    actions, rejected, deferred = _parse_actions(
        _payload(
            [
                {"op": "setSampleTemplate", "argsJson": '["human"]', "label": "Human samples"},
                {"op": "setInstrument", "argsJson": '[{"id":"MS:1","label":"x"}]', "label": "Instrument"},
            ]
        ),
        focus_step="setup",
    )

    assert rejected == []
    assert [action.op for action in actions] == ["setSampleTemplate"]
    assert deferred == ["setInstrument belongs to step 'protocol', not the current 'setup'"]


def test_no_focus_step_keeps_every_step():
    actions, _, deferred = _parse_actions(
        _payload(
            [
                {"op": "setSampleTemplate", "argsJson": '["human"]', "label": "Human samples"},
                {"op": "setInstrument", "argsJson": '[{"id":"MS:1","label":"x"}]', "label": "Instrument"},
            ]
        )
    )

    assert len(actions) == 2
    assert deferred == []


def test_focus_step_prefers_the_request_over_the_snapshot():
    request = ChatRequest(
        sessionId="s",
        messages=[],
        focusStep="protocol",
        wizardState=WizardSnapshot(currentStep=0, currentStepId="setup"),
    )
    assert resolve_focus_step(request) == "protocol"


def test_focus_step_falls_back_to_where_the_user_is():
    request = ChatRequest(
        sessionId="s",
        messages=[],
        wizardState=WizardSnapshot(currentStep=3, currentStepId="runs-files"),
    )
    assert resolve_focus_step(request) == "runs-files"
    assert resolve_focus_step(ChatRequest(sessionId="s", messages=[])) == "setup"


def test_next_step_hint_points_at_the_following_page():
    hint = _next_step_hint("characteristics", proposed_actions=True, mode="chat")
    assert hint is not None
    assert hint.stepId == "samples"
    assert hint.index == 2
    assert "step 3" in hint.prompt


def test_next_step_hint_is_omitted_for_a_bare_question():
    assert _next_step_hint("setup", proposed_actions=False, mode="chat") is None
    # Even step-scoped turns must not advance without accepted suggestion cards.
    assert _next_step_hint("setup", proposed_actions=False, mode="step") is None


def test_next_step_hint_stops_at_the_last_page():
    assert _next_step_hint("review", proposed_actions=True, mode="step") is None


# --------------------------------------------------------- evidence digests


def test_pride_metadata_and_raw_files_are_separate_tools():
    tools = {tool["declaration"]["name"]: tool for tool in registry.TOOLS}

    assert "get_pride_metadata" in tools
    assert "get_pride_raw_files" in tools
    assert "get_pride_dataset" not in tools
    assert "Does not fetch raw files" in tools["get_pride_metadata"]["declaration"]["description"]


def test_pride_result_becomes_replayable_evidence():
    note = _evidence_note(
        "get_pride_metadata",
        {
            "accession": "PXD000547",
            "title": "TMT time course",
            "organisms": ["Homo sapiens (9606)"],
            "instruments": ["Q Exactive (MS:1001911)"],
            "references": [{"pubmedId": "24006456"}],
        },
    )

    assert note is not None
    key, text = note
    assert key == "pride:PXD000547"
    assert "Homo sapiens" in text
    assert "raw files" not in text
    assert "PMID 24006456" in text


def test_failed_tool_leaves_no_evidence():
    assert _evidence_note("get_pride_metadata", {"error": "boom"}) is None
    assert _evidence_note("find_publication", {"found": False}) is None
    assert _evidence_note("search_ontology", {"terms": []}) is None


# ------------------------------------------------------------- tool summaries


def test_tool_summary_reads_as_a_sentence():
    summary, ok = registry.describe(
        "search_ontology",
        {"query": "liver", "terms": [{"label": "liver", "id": "UBERON:0002107"}]},
    )
    assert ok
    assert summary == "1 hits: liver (UBERON:0002107)"


def test_tool_error_is_flagged_for_attention():
    summary, ok = registry.describe("get_pride_metadata", {"error": "404 Not Found\nsecond line"})
    assert not ok
    assert summary == "Failed: 404 Not Found"


def test_not_found_outcomes_are_flagged_too():
    _, ok = registry.describe("find_publication", {"found": False})
    assert not ok
    _, ok = registry.describe("verify_ontology_term", {"accession": "UNIMOD:1", "valid": False})
    assert not ok


def test_every_tool_has_a_title_and_summarizer():
    for tool in registry.TOOLS:
        name = tool["declaration"]["name"]
        assert tool.get("title"), f"{name} has no display title"
        assert callable(tool.get("summarize")), f"{name} has no summarizer"


def test_document_list_title_covers_every_document_source():
    tool = next(tool for tool in registry.TOOLS if tool["declaration"]["name"] == "list_documents")

    assert tool["title"] == "Available documents"
    assert "uploads, pasted text, and retrieved articles" in tool["declaration"]["description"]


# ------------------------------------------------------------------ citations


def test_spec_search_results_become_citations():
    citations = _citations_from_tool(
        "search_specification",
        {
            "passages": [
                {
                    "section": "5.3 Reserved words",
                    "anchor": "https://sdrf.quantms.org/specification.html#53-reserved-words",
                    "text": "not available, not applicable, anonymized, pooled",
                }
            ]
        },
    )

    assert len(citations) == 1
    assert citations[0].source == "spec"
    assert citations[0].title == "5.3 Reserved words"


def test_failed_tool_result_yields_no_citations():
    assert _citations_from_tool("get_pride_metadata", {"error": "boom"}) == []
    assert _citations_from_tool("get_pride_metadata", "not json") == []


def test_pride_result_becomes_citation():
    citations = _citations_from_tool(
        "get_pride_metadata",
        {"accession": "PXD000001", "title": "TMT spikes", "url": "https://example.org/PXD000001"},
    )
    assert citations[0].source == "pride"
    assert citations[0].url == "https://example.org/PXD000001"
