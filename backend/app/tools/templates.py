"""Assistant adapters over the same commit-pinned catalogue as the wizard."""
from contextvars import ContextVar
from ..template_catalog import get_catalog, CatalogError
from .http import ToolHttpError

active_snapshot: ContextVar[str | None] = ContextVar('template_snapshot', default=None)

def _ontologies_from_validators(column: dict) -> list[str]:
    return list(dict.fromkeys(ontology for validator in column.get('validators', [])
        if validator.get('validator_name') == 'ontology'
        for ontology in validator.get('params', {}).get('ontologies', [])))

async def _snapshot():
    try:
        return await get_catalog().get(active_snapshot.get())
    except (CatalogError, ValueError) as exc:
        raise ToolHttpError(str(exc)) from exc

async def _load_manifest() -> dict:
    # Kept for setup-gate catalogue membership checks.
    return (await _snapshot()).payload['manifest']

async def list_templates(layer: str | None = None) -> dict:
    snapshot = await _snapshot()
    grouped = {}
    for template in snapshot.public()['templates']:
        group = template.get('layer') or 'internal'
        if layer and layer != group: continue
        grouped.setdefault(group, []).append({
            'name': template['name'], 'latest': template['version'],
            'description': template.get('description', ''), 'usableAlone': template.get('usable_alone', True),
            'extends': template.get('extends'), 'requires': template.get('requires', []),
            'mutuallyExclusiveWith': template.get('mutually_exclusive_with', []),
            'excludes': template.get('excludes', {}), 'unsupported': template.get('_unsupported', []),
        })
    return {'snapshotId': snapshot.snapshot_id, 'layers': grouped,
            'selectionRules': [
                'Choose a technology; select any compatible sample and experiment templates.',
                'Resolve inherited requirements and mutual exclusions using validate_template_combination.',
                'Sample-layer templates may be combined unless their definitions prohibit it.',
                'Internal templates are inherited; do not select them directly.',
            ]}

async def get_template_columns(name: str, version: str | None = None, include_inherited: bool = True) -> dict:
    snapshot = await _snapshot()
    if name not in snapshot.manifest: raise ToolHttpError(f'Unknown template: {name}')
    version = version or snapshot.manifest[name]['latest']
    result = snapshot.resolve([{'name': name, 'version': version}], preview=True, availability=False)
    if not result['valid']: raise ToolHttpError(' '.join(result['errors']))
    doc = snapshot.doc(name, version)
    raw_columns = result['columns'] if include_inherited else doc['columns']
    columns = [{**col,
        'ontologies': _ontologies_from_validators(col),
        'allowNotAvailable': col.get('allow_not_available', False),
        'allowNotApplicable': col.get('allow_not_applicable', False),
    } for col in raw_columns]
    return {'snapshotId': snapshot.snapshot_id, 'name': name, 'version': version, 'layer': doc.get('layer'),
            'description': doc.get('description', ''), 'documentation': doc.get('documentation', ''),
            'mutuallyExclusiveWith': doc.get('mutually_exclusive_with', []),
            'inheritanceChain': [ref['name'] for ref in result['resolvedTemplates']],
            'columns': columns,
            'requiredColumns': [c['name'] for c in columns if c.get('requirement') == 'required'],
            'recommendedColumns': [c['name'] for c in columns if c.get('requirement') == 'recommended']}

async def validate_combination(technology: str | None, sample: str | None,
                               experiments: list[str] | None = None, sample_metadata: list[str] | None = None) -> dict:
    snapshot = await _snapshot()
    names = list(dict.fromkeys(n for n in [technology, sample, *(sample_metadata or []), *(experiments or [])] if n))
    result = snapshot.resolve([{'name': name} for name in names], availability=False)
    # Legacy action argument roles are validated as well as the general selection.
    for name, layer in [(technology, 'technology'), (sample, 'sample')]:
        if name in snapshot.manifest:
            doc = snapshot.doc(name, snapshot.manifest[name]['latest'])
            if doc.get('layer') != layer:
                result['errors'].append(f'{name} is not a {layer} template.')
    result['valid'] = not result['errors']
    return {key: result[key] for key in ('snapshotId', 'valid', 'errors', 'warnings', 'issues', 'leafTemplates')}
