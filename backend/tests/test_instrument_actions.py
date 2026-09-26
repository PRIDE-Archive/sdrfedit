import json

import pytest

from app.llm.agent import _parse_actions


TERM = {"id": "MS:1000556", "label": "LTQ Orbitrap XL", "ontology": "MS"}


def parse_instrument(args, encode=True):
    return _parse_actions(json.dumps({"actions": [{
        "op": "setInstrument",
        "argsJson": json.dumps(args) if encode else args,
    }]}), "protocol")


@pytest.mark.parametrize("args", [TERM, [TERM], [[TERM]]])
def test_instrument_normalizes_to_one_object_argument(args):
    actions, rejected, deferred = parse_instrument(args)
    assert rejected == deferred == []
    assert len(actions) == 1
    assert actions[0].args == [TERM]


def test_instrument_accepts_extra_array_in_native_args():
    actions, rejected, deferred = parse_instrument([[TERM]], encode=False)
    assert rejected == deferred == []
    assert actions[0].args == [TERM]


@pytest.mark.parametrize("args", [
    [], [[]], [TERM, TERM], [[TERM, TERM]], [[[TERM]]],
    [None], ["LTQ Orbitrap XL"], [{}],
    [{"id": "MS:1000556"}], [{"label": "LTQ Orbitrap XL"}],
    [{**TERM, "id": " "}], [{**TERM, "label": " "}],
    [{**TERM, "id": 1000556}], [{**TERM, "label": []}],
])
def test_invalid_instrument_is_rejected_before_reaching_frontend(args):
    actions, rejected, deferred = parse_instrument(args)
    assert actions == deferred == []
    assert len(rejected) == 1
    assert "setInstrument: expected exactly one ontology term object" in rejected[0]
    assert "argsJson=" in rejected[0]


def test_instrument_trims_required_fields_and_preserves_metadata():
    term = {**TERM, "id": " MS:1000556 ", "label": " LTQ Orbitrap XL ",
            "iri": "http://example.org/MS_1000556", "ontologyPrefix": "MS"}
    actions, rejected, _ = parse_instrument([[term]])
    assert rejected == []
    assert actions[0].args == [{**term, **TERM}]


def test_invalid_instrument_does_not_discard_other_valid_actions():
    actions, rejected, deferred = _parse_actions(json.dumps({"actions": [
        {"op": "setInstrument", "argsJson": json.dumps([[TERM, TERM]])},
        {"op": "setPrecursorMassTolerance", "argsJson": '["10 ppm"]'},
    ]}), "protocol")
    assert [action.op for action in actions] == ["setPrecursorMassTolerance"]
    assert len(rejected) == 1
    assert deferred == []
