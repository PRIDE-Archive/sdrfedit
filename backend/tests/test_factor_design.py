from app.llm.prompts import FACTOR_DESIGN_RULES, SYSTEM_PROMPT, render_wizard_context
from app.schemas import WizardSnapshot


def test_factor_source_and_evidence_survive_snapshot_and_prompt():
    snapshot = WizardSnapshot.model_validate({"factorDefinitions": [{
        "name": "compound", "values": ["untreated", "drug A"],
        "sourceCharacteristic": "characteristics[compound]",
        "reasoning": "Methods compares treatments in the same cell line",
    }]})
    context = render_wizard_context(snapshot)
    assert "source=characteristics[compound]" in context
    assert "Methods compares treatments" in context
    assert FACTOR_DESIGN_RULES in SYSTEM_PROMPT


def test_legacy_independent_factor_snapshot_remains_supported():
    snapshot = WizardSnapshot.model_validate({"factorDefinitions": [{"name": "disease", "values": ["normal"]}]})
    assert snapshot.factorDefinitions[0].sourceCharacteristic is None
    assert "source=independent" in render_wizard_context(snapshot)


def test_run_factors_and_explicit_decision_reach_model_context():
    snapshot = WizardSnapshot.model_validate({
        "factorDecision": "none", "noFactorReason": "Descriptive inventory",
        "factorDefinitions": [{"name": "strategy", "scope": "run", "values": ["DT", "DDNL"]}],
        "msRunSummaries": [{"name": "DT run", "sampleSourceNames": ["sample_1"], "factorValues": {"strategy": "DT"}}],
    })
    context = render_wizard_context(snapshot)
    assert 'scope=run' in context
    assert 'Descriptive inventory' in context
    assert "'strategy': 'DT'" in context


def test_technical_actions_have_correct_steps():
    import json
    from app.llm.agent import _parse_actions
    actions, rejected, deferred = _parse_actions(json.dumps({"actions": [
        {"op": "setNoStudyFactors", "argsJson": '["Descriptive inventory"]'},
        {"op": "setRunFactorValue", "argsJson": '["DT run", "strategy", "DT"]'},
    ]}))
    assert not rejected and not deferred
    assert [action.step for action in actions] == ['samples', 'runs-files']
