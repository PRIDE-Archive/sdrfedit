import json
from pathlib import Path

import pytest

from app.llm.action_args import CONTRACTS, normalize_action_args
from app.llm.agent import _parse_actions
from app.schemas import ALLOWED_OPS

CASES = json.loads((Path(__file__).resolve().parents[2]/'tests/fixtures/wizard-action-args.json').read_text())


def test_every_operation_has_a_contract_and_a_shared_example():
    assert CONTRACTS.keys() == ALLOWED_OPS.keys()
    assert {c['op'] for c in CASES if c['name'].startswith('documented ')} == ALLOWED_OPS.keys()


@pytest.mark.parametrize('case', CASES, ids=lambda c:c['name'])
def test_shared_argument_contract(case):
    if not case['valid']:
        with pytest.raises(ValueError): normalize_action_args(case['op'],case['args'],case.get('sampleCount'))
    else:
        assert normalize_action_args(case['op'],case['args'],case.get('sampleCount')) == case.get('expected',case['args'])


@pytest.mark.parametrize('payload', [[],42,True,{'actions':42},{'actions':{}},{'actions':None}])
def test_malformed_envelope_returns_rejection(payload):
    actions,rejected,_ = _parse_actions(json.dumps(payload))
    assert not actions and rejected


@pytest.mark.parametrize('bad', [{},True,False,None,5,'', 'broken'])
def test_bad_args_do_not_drop_valid_sibling(bad):
    actions,rejected,_ = _parse_actions(json.dumps({'actions':[
        {'op':'setSampleTemplates','argsJson':bad},
        {'op':'setAcquisitionMethod','argsJson':'["dda"]'},
    ]}))
    assert [a.op for a in actions] == ['setAcquisitionMethod']
    assert len(rejected)==1


def test_flat_names_fixed_before_reaching_frontend():
    actions,rejected,_ = _parse_actions(json.dumps({'actions':[
        {'op':'setSourceNames','argsJson':'["a","b","c"]'},
    ]}),sample_count=3)
    assert not rejected
    assert actions[0].args == [['a','b','c']]
