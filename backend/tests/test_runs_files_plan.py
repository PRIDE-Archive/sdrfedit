import json
from app.llm.agent import _parse_actions, _propose_feedback
from app.llm.prompts import RUNS_FILES_PROCEDURE, render_wizard_context
from app.schemas import WizardSnapshot


def test_unknown_import_operation_feedback_supports_successful_retry():
    actions, rejected, deferred = _parse_actions(json.dumps({'actions': [
        {'op': 'addDataFiles', 'argsJson': '[["dt.raw"]]'},
    ]}), 'runs-files')
    feedback = _propose_feedback(actions, rejected, deferred, 'runs-files')
    assert 'replaceWithUnassignedFileNames' in feedback['allowedOperations']
    assert 'setInstrument' not in feedback['allowedOperations']
    assert 'argsJson' in feedback['recovery']
    plan = {'groups': [{'name': 'DT', 'labelConfigId': 'lf',
        'channels': [{'label': 'label free sample', 'sourceName': 'shared'}],
        'files': [{'fileName': 'dt.raw', 'fractionId': 1, 'technicalReplicate': 1}]}]}
    actions, rejected, deferred = _parse_actions(json.dumps({'actions': [
        {'op': 'replaceWithUnassignedFileNames', 'argsJson': '[["dt.raw"]]'},
        {'op': 'applyRunsFilesPlan', 'argsJson': json.dumps([plan])},
    ]}), 'runs-files')
    assert not rejected and not deferred
    assert [action.op for action in actions] == ['replaceWithUnassignedFileNames', 'applyRunsFilesPlan']
    assert actions[0].args == [['dt.raw']]


def test_plan_action_survives_validation():
    plan = {'groups': [{'name': 'DDNL', 'labelConfigId': 'lf',
        'channels': [{'label': 'label free sample', 'sourceName': 'shared'}],
        'factorValues': {'strategy': 'DDNL'},
        'files': [{'fileName': 'ddnl.raw', 'fractionId': 1, 'technicalReplicate': 2}]}]}
    actions, rejected, deferred = _parse_actions(json.dumps({'actions': [{
        'op': 'applyRunsFilesPlan', 'argsJson': json.dumps([plan]),
    }]}))
    assert not rejected and not deferred
    assert actions[0].step == 'runs-files'
    assert actions[0].args == [plan]


def test_snapshot_retains_mapping_for_repair():
    snapshot = WizardSnapshot.model_validate({'msRunSummaries': [{
        'name': 'DT', 'sampleSourceNames': ['shared'], 'labelConfigId': 'lf',
        'channels': [{'label': 'label free sample', 'sourceName': 'shared'}],
        'files': [{'fileName': 'dt.raw', 'fractionId': 1, 'technicalReplicate': 3}],
    }]})
    context = render_wizard_context(snapshot)
    assert 'dt.raw' in context and 'technicalReplicate' in context
    assert 'label free sample' in context
    assert 'filename tags are supporting evidence' in RUNS_FILES_PROCEDURE
