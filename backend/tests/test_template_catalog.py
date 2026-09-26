"""Contracts use unfamiliar names so catalogue changes cannot depend on an ID allow-list."""
import asyncio
import json
from copy import deepcopy
from unittest.mock import AsyncMock

import pytest

from app.template_catalog import CatalogSnapshot, TemplateCatalog, CatalogError, check_capabilities
from app.template_validation import validate_table

SHA = 'a' * 40


def doc(name, layer=None, **kwargs):
    return dict(name=name, version='1.0.0', layer=layer, columns=[], **kwargs)


def snapshot(*docs, sha=SHA):
    manifest = {}
    definitions = {}
    for d in docs:
        d = deepcopy(d)
        d['_unsupported'] = check_capabilities(d)
        entry = manifest.setdefault(d['name'], {'latest': d['version'], 'versions': []})
        entry['versions'].append(d['version'])
        entry['latest'] = d['version']
        definitions[f"{d['name']}@{d['version']}"] = d
    return CatalogSnapshot(dict(snapshotId=f'{sha}:1', commitSha=sha, fetchedAt='2026-09-24',
        parserVersion='1', schemaHash='test', manifest={'schema_version': '1.0', 'templates': manifest}, definitions=definitions))


def resolve(s, *names, **kwargs):
    return s.resolve([{'name': n} for n in names], **kwargs)


def test_dynamic_layers_and_inherited_one_way_exclusion():
    s = snapshot(doc('new-tech', 'technology'), doc('new-sample', 'sample', mutually_exclusive_with=['other']),
                 doc('child', 'sample', extends='new-sample@>=1.0.0'), doc('other', 'sample'))
    assert resolve(s, 'new-tech', 'child')['valid']
    result = resolve(s, 'new-tech', 'child', 'other')
    assert not result['valid']
    assert any(i['source']['template'] == 'new-sample' for i in result['issues'])
    assert resolve(s, 'new-tech', 'child')['availability']['other']['status'] == 'conflicting'
    s.definitions['new-sample@1.0.0']['mutually_exclusive_with'] = []
    assert resolve(s, 'new-tech', 'child', 'other')['valid']


def test_no_id_based_rules_and_generic_requirements():
    s = snapshot(doc('new-tech', 'technology'), doc('lc-ms-metabolomics', 'experiment'), doc('gc-ms-metabolomics', 'experiment'),
                 doc('needs-sample', 'experiment', requires=[{'layer': 'sample'}]), doc('generic', 'sample'))
    assert resolve(s, 'new-tech', 'lc-ms-metabolomics', 'gc-ms-metabolomics')['valid']
    assert not resolve(s, 'new-tech', 'needs-sample')['valid']
    assert resolve(s, 'new-tech', 'needs-sample')['availability']['generic']['status'] == 'available'
    assert resolve(s, 'new-tech', 'needs-sample', 'generic')['valid']


def test_technology_ancestry_and_leaf_declarations():
    s = snapshot(doc('first', 'technology'), doc('derived', 'technology', extends='first'), doc('other', 'technology'))
    result = resolve(s, 'first', 'derived')
    assert result['valid']
    assert result['leafTemplates'] == [{'name': 'derived', 'version': '1.0.0'}]
    assert not resolve(s, 'derived', 'other')['valid']


def test_usable_alone_and_explicit_false_and_unknown_rules():
    s = snapshot(doc('tech', 'technology', usable_alone=False), doc('sample', 'sample'))
    assert not resolve(s, 'tech')['valid']
    assert resolve(s, 'tech', 'sample')['valid']
    s.definitions['sample@1.0.0']['_unsupported'] = ['Unsupported requires rule']
    assert not resolve(s, 'tech', 'sample')['valid']
    assert not resolve(s, 'missing')['valid']
    assert resolve(s, 'missing')['snapshotId'] == s.snapshot_id


@pytest.mark.parametrize('excludes', [{'templates': ['foreign']}, {'categories': ['characteristics']}, {'columns': ['characteristics[foreign]']}])
def test_all_exclusion_kinds_preserve_own_hierarchy(excludes):
    root = doc('foundation'); root['columns'] = [{'name': 'characteristics[own]', 'requirement': 'required'}]
    foreign = doc('foreign'); foreign['columns'] = [{'name': 'characteristics[foreign]'}]
    s = snapshot(root, foreign, doc('tech', 'technology', extends='foreign'),
                 doc('sample', 'sample', extends='foundation', excludes=excludes))
    result = resolve(s, 'tech', 'sample')
    assert result['valid']
    assert [c['name'] for c in result['columns']] == ['characteristics[own]']
    assert result['columns'][0]['provenance'][0]['template'] == 'foundation'


def test_column_merge_strengthens_and_retains_all_validators():
    parent = doc('parent'); parent['columns'] = [{'name': 'x', 'requirement': 'required', 'allow_not_available': False,
        'validators': [{'validator_name': 'values', 'params': {'values': ['a', 'b']}}]}]
    child = doc('child', 'technology', extends='parent'); child['columns'] = [{'name': 'x', 'requirement': 'optional',
        'allow_not_available': True, 'validators': [{'validator_name': 'pattern', 'params': {'pattern': '^a$'}}]}]
    column = resolve(snapshot(parent, child), 'child')['columns'][0]
    assert column['requirement'] == 'required'
    assert column['allow_not_available'] is False
    assert len(column['validators']) == 2


def test_dependency_ranges_intersect_and_do_not_use_latest():
    v1 = doc('parent'); v2 = dict(v1, version='2.0.0')
    s = snapshot(v1, v2, doc('tech', 'technology', extends='parent@>=1.0.0,<2.0.0'),
                 doc('sample', 'sample', extends='parent@1.0.0'), doc('bad', 'sample', extends='parent@2.0.0'))
    lock = resolve(s, 'tech', 'sample')['resolvedTemplates']
    assert {'name': 'parent', 'version': '1.0.0'} in lock
    assert not resolve(s, 'tech', 'bad')['valid']


def test_cycles_missing_parents_and_future_semantics_fail_closed():
    assert not resolve(snapshot(doc('cycle', 'technology', extends='cycle')), 'cycle')['valid']
    assert not resolve(snapshot(doc('orphan', 'technology', extends='missing')), 'orphan')['valid']
    assert not resolve(snapshot(doc('future', 'technology', incompatible_future_rule=True)), 'future')['valid']


async def test_atomic_snapshot_stale_fallback_and_old_restore(tmp_path):
    catalog = TemplateCatalog(tmp_path)
    first = snapshot(doc('tech', 'technology'))
    catalog._head = AsyncMock(return_value=SHA)
    catalog.build = AsyncMock(return_value=first)
    fresh = await catalog.revalidate()
    assert not fresh['stale']
    catalog._head.return_value = 'b' * 40
    catalog.build.side_effect = CatalogError('Partial fetch failed')
    stale = await catalog.revalidate()
    assert stale['stale'] and stale['snapshotId'] == first.snapshot_id
    assert (tmp_path / 'latest').read_text() == first.snapshot_id
    restarted = TemplateCatalog(tmp_path)
    assert (await restarted.get(first.snapshot_id)).snapshot_id == first.snapshot_id
    assert not list(tmp_path.glob('*.tmp'))


async def test_concurrent_entry_coalesces_sync(tmp_path):
    catalog = TemplateCatalog(tmp_path)
    catalog._head = AsyncMock(return_value=SHA)
    catalog.build = AsyncMock(return_value=snapshot(doc('tech', 'technology')))
    results = await asyncio.gather(*(catalog.revalidate() for _ in range(8)))
    assert all(r['snapshotId'] == f'{SHA}:1' for r in results)
    assert catalog._head.await_count == catalog.build.await_count == 1


async def test_first_load_failure_has_no_fabricated_fallback(tmp_path):
    catalog = TemplateCatalog(tmp_path)
    catalog._head = AsyncMock(side_effect=CatalogError('offline'))
    with pytest.raises(CatalogError, match='complete official catalogue'): await catalog.revalidate()


async def test_build_fetches_only_pinned_sha_and_checks_schema(tmp_path):
    catalog = TemplateCatalog(tmp_path)
    d = doc('unknown-new-tech', 'technology')
    manifest = {'schema_version': '1.0', 'templates': {d['name']: {'latest': d['version'], 'versions': [d['version']]}}}
    files = {'templates.yaml': json.dumps(manifest), 'sdrf-template.schema.json': json.dumps({'type': 'object'}),
             'unknown-new-tech/1.0.0/unknown-new-tech.yaml': json.dumps(d)}
    seen = []
    async def text(sha, path):
        seen.append((sha, path)); return files[path]
    catalog._text = text
    result = await catalog.build(SHA)
    assert result.public()['templates'][0]['name'] == 'unknown-new-tech'
    assert all(sha == SHA for sha, _ in seen)
    files['sdrf-template.schema.json'] = json.dumps({'type': 'array'})
    with pytest.raises(CatalogError, match='Invalid unknown-new-tech'): await catalog.build(SHA)


def test_pinned_table_preflight_validates_required_values_and_declares_limits():
    d = doc('tech', 'technology'); d['columns'] = [{'name': 'field', 'requirement': 'required',
        'validators': [{'validator_name': 'values', 'params': {'values': ['allowed']}},
                       {'validator_name': 'ontology', 'params': {'ontologies': ['ms']}}]}]
    s = snapshot(d)
    result = validate_table(s, [{'name': 'tech'}], 'field\nwrong\n')
    assert not result['valid'] and not result['complete']
    assert result['snapshotId'] == s.snapshot_id
    assert any(i['level'] == 'warning' and 'ontology' in i['message'] for i in result['issues'])

async def test_http_api_shares_snapshot_and_returns_source_rules(monkeypatch, tmp_path):
    import httpx
    from fastapi import FastAPI
    from app.routers import template_catalog as api
    catalog = TemplateCatalog(tmp_path)
    catalog._head = AsyncMock(return_value=SHA)
    catalog.build = AsyncMock(return_value=snapshot(doc('new-tech', 'technology'), doc('new-sample', 'sample')))
    monkeypatch.setattr(api, 'get_catalog', lambda: catalog)
    app = FastAPI(); app.include_router(api.router)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        assert (await client.get('/api/template-catalog/status')).json()['service'] == 'template-catalog'
        fresh = (await client.post('/api/template-catalog/revalidate')).json()
        selection = dict(snapshotId=fresh['snapshotId'], selectedTemplates=[{'name': 'new-tech', 'version': '1.0.0'}])
        resolved = (await client.post('/api/template-catalog/resolve', json=selection)).json()
        assert resolved['valid'] and resolved['snapshotId'] == fresh['snapshotId']
        restored = (await client.get(f"/api/template-catalog/snapshots/{fresh['snapshotId']}")).json()
        assert restored['commitSha'] == SHA
        assert (await client.post('/api/template-catalog/resolve', json=dict(selection, snapshotId='bad'))).status_code == 422
        checked = (await client.post('/api/template-catalog/validate-table', json=dict(selection, tsv='source name\nsample-1\n'))).json()
        assert checked['snapshotId'] == fresh['snapshotId']


def test_conflicts_identify_selected_roots_without_automatic_replacement():
    s = snapshot(doc('old-tech', 'technology'), doc('new-tech', 'technology'),
                 doc('old-experiment', 'experiment', extends='old-tech'),
                 doc('organism-a', 'sample', mutually_exclusive_with=['organism-b']),
                 doc('organism-b', 'sample'), doc('clinical', 'sample'))
    result = resolve(s, 'old-tech', 'old-experiment', 'organism-a', 'clinical')
    conflict = result['availability']['new-tech']
    assert conflict['status'] == 'conflicting'
    assert {r['name'] for r in conflict['conflictsWith']} == {'old-tech', 'old-experiment'}
    assert 'selection' not in conflict and 'replaces' not in conflict
    assert [r['name'] for r in result['availability']['organism-b']['conflictsWith']] == ['organism-a']
    assert resolve(s, 'old-tech', 'clinical')['availability']['organism-b']['status'] == 'available'


def test_switch_does_not_enable_intrinsically_unsupported_templates():
    s = snapshot(doc('tech', 'technology'), doc('future', 'technology', unknown_rule=True))
    assert resolve(s, 'tech')['availability']['future']['status'] == 'conflicting'


async def test_assistant_template_columns_paginate_below_dispatch_limit_without_losing_rules(monkeypatch):
    from app.tools import templates, registry
    parent = doc('base')
    parent['columns'] = [
        {'name': f'characteristics[field {i}]', 'description': 'description ' * 100,
         'requirement': 'required', 'allow_not_available': False,
         'validators': [{'validator_name': 'ontology', 'params': {'ontologies': ['ncit']}}]}
        for i in range(45)
    ]
    snap = snapshot(parent, doc('derived', 'sample', extends='base'))
    monkeypatch.setattr(templates, '_snapshot', AsyncMock(return_value=snap))
    seen = []
    offset = 0
    pages = 0
    while True:
        raw = await registry.dispatch('get_template_columns', {
            'name': 'derived', 'offset': offset, 'limit': 100,
        }, 'test')
        result = json.loads(raw)
        assert 'error' not in result, result
        assert len(raw) < registry.MAX_RESULT_CHARS
        assert result['totalColumns'] == 45
        assert len(result['requiredColumns']) == 45
        assert result['snapshotId'] == snap.snapshot_id
        for column in result['columns']:
            assert column['ontologies'] == ['ncit']
            assert column['validators'] == parent['columns'][0]['validators']
            assert column['allowNotAvailable'] is False
            assert column['description'] == parent['columns'][0]['description']
        seen.extend(c['name'] for c in result['columns'])
        pages += 1
        if result['nextOffset'] is None:
            break
        assert result['nextOffset'] > offset
        offset = result['nextOffset']
    assert pages > 1
    assert seen == [c['name'] for c in parent['columns']]
    assert (await templates.get_template_columns('derived', offset=45))['columns'] == []


@pytest.mark.parametrize('offset,limit', [(-1, 20), (0, 0), (0, 101), ('0', 20), (False, 20)])
async def test_template_column_paging_rejects_invalid_arguments(offset, limit):
    from app.tools import templates
    from app.tools.http import ToolHttpError
    with pytest.raises(ToolHttpError, match='offset'):
        await templates.get_template_columns('anything', offset=offset, limit=limit)


@pytest.mark.parametrize('value', ['pooled', 'not pooled'])
def test_pooled_sample_accepts_official_enumeration_without_sentinel_flag(value):
    d = doc('tech', 'technology')
    d['columns'] = [{'name': 'characteristics[pooled sample]',
        'allow_not_available': True, 'allow_not_applicable': True,
        'validators': [
            {'validator_name': 'values', 'params': {'values': ['not pooled', 'pooled'], 'error_level': 'warning'}},
            {'validator_name': 'pattern', 'params': {'pattern': r'^(not pooled|pooled|SN=.+(;SN=.+)*)$', 'error_level': 'warning'}},
        ]}]
    result = validate_table(snapshot(d), [{'name': 'tech'}], f'characteristics[pooled sample]\n{value}\n')
    assert result['valid'] and result['issues'] == []


@pytest.mark.parametrize('definition,value,valid,message', [
    ({}, 'pooled', False, 'Reserved value is not allowed.'),
    ({'validators': [{'validator_name': 'pattern', 'params': {'pattern': '.*'}}]},
     'pooled', False, 'Reserved value is not allowed.'),
    ({'allow_pooled': False, 'validators': [{'validator_name': 'values', 'params': {'values': ['pooled']}}]},
     'pooled', False, 'Reserved value is not allowed.'),
    ({'allow_pooled': True, 'type': 'integer', 'validators': [{'validator_name': 'pattern', 'params': {'pattern': r'^\d+$'}}]},
     'pooled', True, None),
    ({'validators': [{'validator_name': 'values', 'params': {'values': ['pooled']}},
                     {'validator_name': 'pattern', 'params': {'pattern': '^not pooled$'}}]},
     'pooled', False, 'Value fails pattern.'),
    ({'validators': [{'validator_name': 'values', 'params': {'values': ['pooled'], 'case_sensitive': True}}]},
     'POOLED', False, 'Reserved value is not allowed.'),
    ({'validators': [{'validator_name': 'values', 'params': {'values': ['pooled']}}]},
     'POOLED', True, None),
    ({'validators': [{'validator_name': 'values', 'params': {'values': ['pooled']}}]},
     'not available', False, 'Reserved value is not allowed.'),
    ({'allow_not_available': True, 'type': 'integer'}, 'not available', True, None),
])
def test_reserved_value_permissions_preserve_column_constraints(definition, value, valid, message):
    d = doc('tech', 'technology')
    d['columns'] = [{'name': 'field', **definition}]
    result = validate_table(snapshot(d), [{'name': 'tech'}], f'field\n{value}\n')
    assert result['valid'] is valid
    if message:
        assert any(issue['message'] == message for issue in result['issues'])
    else:
        assert result['issues'] == []
