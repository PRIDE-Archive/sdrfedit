"""Fourth-page cards preserve file scope and follow live wizard requirements."""
import json
import pytest
from app.llm.agent import _gate_ontology_actions, _parse_actions
from app.llm.prompts import render_step_focus, render_wizard_context
from app.schemas import WizardSnapshot

INSTRUMENT = 'comment[instrument]'
MODIFICATIONS = 'comment[modification parameters]'
TOLERANCE = 'comment[fragment mass tolerance]'
TERM = {'id': 'MS:1001911', 'label': 'Q Exactive', 'ontology': 'MS'}


def snapshot():
    return WizardSnapshot(protocolColumns=[
        {'name': INSTRUMENT, 'requirement': 'required'},
        {'name': MODIFICATIONS, 'requirement': 'required'},
        {'name': TOLERANCE, 'requirement': 'recommended'},
    ], dataFileNames=['a.raw', 'b.raw'], dataFileCount=2,
        protocolFields={INSTRUMENT: {'choices': [{'id': 'qe', 'value': TERM}], 'assignments': {'a.raw': 'qe'}}},
        protocolIssues=[f'{INSTRUMENT}: unassigned raw files: b.raw'])


def propose(op, args):
    actions, rejected, deferred = _parse_actions(json.dumps({'actions': [{'op': op, 'argsJson': json.dumps(args)}]}), 'protocol')
    assert deferred == []
    if rejected:
        return actions, rejected
    return _gate_ontology_actions(actions, snapshot(), {'ms:1001911', 'unimod:35'}, set())


def test_snapshot_preserves_structured_candidates_scope_and_errors_in_prompt():
    data = snapshot()
    restored = WizardSnapshot.model_validate_json(data.model_dump_json())
    assert restored.protocolFields == data.protocolFields
    text = render_wizard_context(restored)
    assert 'b.raw' in text and 'MS:1001911' in text
    assert 'authoritative protocol candidates' in text and 'protocol completion issues' in text
    assert 'current wizard requirements' in text
    focus = render_step_focus('protocol', restored)
    assert 'setProtocolValue' in focus and 'COMPLETE set' in focus
    assert 'exact raw file names' in focus
    assert 'modifications are required' in focus and 'tolerances are recommended' in focus


@pytest.mark.parametrize('scope', ['all', ['a.raw'], ['a.raw', 'b.raw']])
def test_valid_scoped_instrument_cards_preserve_scope(scope):
    actions, rejected = propose('setProtocolValue', [INSTRUMENT, TERM, scope])
    assert rejected == [] and len(actions) == 1
    assert actions[0].args == [INSTRUMENT, TERM, scope]


@pytest.mark.parametrize('args', [
    [INSTRUMENT, TERM, []], [INSTRUMENT, TERM, ['a.raw', 'a.raw']],
    [INSTRUMENT, TERM, ['unknown.raw']], [INSTRUMENT, TERM, 'selected'],
    [INSTRUMENT, TERM], ['comment[unknown]', 'x', 'all'],
    [INSTRUMENT, [TERM, TERM], 'all'], [TOLERANCE, '10', 'all'],
    [MODIFICATIONS, [], 'all'], [TOLERANCE, '', ['a.raw']],
])
def test_bad_scoped_cards_are_rejected_before_the_browser(args):
    actions, rejected = propose('setProtocolValue', args)
    assert actions == [] and rejected


def test_optional_tolerance_can_be_cleared_explicitly_for_all():
    actions, rejected = propose('setProtocolValue', [TOLERANCE, '', 'all'])
    assert not rejected and len(actions) == 1


@pytest.mark.parametrize('op', ['setModifications', 'setProtocolValue'])
@pytest.mark.parametrize('target', [None, '', ' '])
def test_missing_modification_site_rejected_for_legacy_and_scoped_cards(op, target):
    mod = {'name': 'Oxidation', 'type': 'variable', 'unimodAccession': 'UNIMOD:35'}
    if target is not None:
        mod['targetAminoAcids'] = target
    args = [[mod]] if op == 'setModifications' else [MODIFICATIONS, [mod], 'all']
    actions, rejected = propose(op, args)
    assert not actions and rejected and 'targetAminoAcids' in rejected[0]


def test_cannot_clear_required_modifications_with_a_legacy_card():
    actions, rejected = propose('setModifications', [[]])
    assert not actions and rejected


def test_multiple_cards_keep_distinct_file_scopes_and_modification_sets():
    mod = {'name': 'Oxidation', 'type': 'variable', 'targetAminoAcids': 'M', 'unimodAccession': 'UNIMOD:35'}
    actions, rejected, deferred = _parse_actions(json.dumps({'actions': [
        {'op': 'setProtocolValue', 'argsJson': json.dumps([INSTRUMENT, TERM, ['a.raw']])},
        {'op': 'setProtocolValue', 'argsJson': json.dumps([MODIFICATIONS, [mod], ['b.raw']])},
    ]}), 'protocol')
    assert not rejected and not deferred
    checked, errors = _gate_ontology_actions(actions, snapshot(), set(), set())
    assert not errors and len(checked) == 2
    assert checked[0].args[2] == ['a.raw'] and checked[1].args[2] == ['b.raw']

@pytest.mark.parametrize('accession', ['not-an-accession', 'MS:1', 'NCBITaxon:9606'])
@pytest.mark.parametrize('op', ['setInstrument', 'setProtocolValue'])
def test_invalid_instrument_accession_rejected(accession, op):
    from app.llm.action_args import normalize_action_args
    value = {'id': accession, 'label': 'Q Exactive'}
    args = [value] if op == 'setInstrument' else ['comment[instrument]', value, 'all']
    with pytest.raises(ValueError, match='accession'):
        normalize_action_args(op, args, 1)


def test_unknown_legacy_characteristic_column_is_rejected():
    from types import SimpleNamespace
    from app.llm.agent import _gate_ontology_actions
    from app.schemas import WizardAction
    action = WizardAction(step='samples', op='addCharacteristicChoice', args=['characteristics[typo]', 'example'])
    kept, rejected = _gate_ontology_actions([action], SimpleNamespace(characteristicColumns=[]), set(), set())
    assert not kept
    assert 'not in the current wizard' in rejected[0]
