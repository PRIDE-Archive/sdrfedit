import json

from app.llm.agent import _parse_actions
from app.schemas import WizardSnapshot


def test_search_tolerances_are_protocol_actions():
    actions, rejected, deferred = _parse_actions(json.dumps({"actions": [
        {"op": "setPrecursorMassTolerance", "argsJson": '["10 ppm"]', "label": "Precursor tolerance"},
        {"op": "setFragmentMassTolerance", "argsJson": '["0.02 Da"]', "label": "Fragment tolerance"},
    ]}))
    assert not rejected
    assert not deferred
    assert [action.step for action in actions] == ["protocol", "protocol"]
    assert [action.args for action in actions] == [["10 ppm"], ["0.02 Da"]]


def test_snapshot_preserves_tolerances_and_supports_old_clients():
    old = WizardSnapshot()
    assert old.precursorMassTolerance == old.fragmentMassTolerance == ""
    snapshot = WizardSnapshot(precursorMassTolerance="10 ppm", fragmentMassTolerance="0.02 Da")
    assert snapshot.model_dump()["precursorMassTolerance"] == "10 ppm"
    assert snapshot.model_dump()["fragmentMassTolerance"] == "0.02 Da"
