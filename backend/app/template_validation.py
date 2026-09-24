"""Pinned structural/value preflight. Ontology lookup is explicitly outside this check."""
import csv
import io
import math
import re
from collections import Counter
from semantic_version import Version

from .template_catalog import CatalogSnapshot


def validate_table(snapshot: CatalogSnapshot, selected: list[dict], tsv: str) -> dict:
    resolved = snapshot.resolve(selected, availability=False)
    issues = []
    deferred = set()
    def report(message, column=None, row=-1, value=None, level='error'):
        if len(issues) < 500:
            issues.append(dict(message=message, column=column, row=row, value=value, level=level, suggestion=None))
    for message in resolved['errors']: report(message)
    rows = list(csv.reader(io.StringIO(tsv), delimiter='\t'))
    if len(rows) < 2:
        report('An SDRF header and at least one data row are required.')
        return {'snapshotId': snapshot.snapshot_id, 'issues': issues, 'complete': False}
    headers, data = rows[0], rows[1:]
    counts = Counter(headers)
    definitions = {c['name']: c for c in resolved['columns']}
    for definition in definitions.values():
        name = definition['name']
        if definition.get('requirement') == 'required' and not counts[name]: report('Required column is missing.', name)
        single = definition.get('cardinality') == 'single' or any(v['validator_name'] == 'single_cardinality_validator' for v in definition.get('validators', []))
        if single and counts[name] > 1: report('This column must occur only once.', name)
    reserved = {'not available': 'allow_not_available', 'not applicable': 'allow_not_applicable',
                'anonymized': 'allow_anonymized', 'pooled': 'allow_pooled'}
    for index, row in enumerate(data):
        if len(row) != len(headers):
            report('Row length does not match the header.', row=index)
            continue
        for name, value in zip(headers, row):
            definition = definitions.get(name)
            if definition is None: continue  # User-defined factor/extension columns are permitted.
            if not value.strip():
                report('Empty cell.', name, index, value)
                continue
            if value.lower() in reserved:
                if definition.get(reserved[value.lower()]) is not True: report('Reserved value is not allowed.', name, index, value)
                continue
            kind = definition.get('type')
            if kind == 'integer' and not re.fullmatch(r'[+-]?\d+', value): report('Expected an integer.', name, index, value)
            if kind == 'float':
                try: valid_number = math.isfinite(float(value))
                except ValueError: valid_number = False
                if not valid_number: report('Expected a finite number.', name, index, value)
            for rule in definition.get('validators', []):
                validator, params = rule['validator_name'], rule.get('params', {})
                level = rule.get('error_level', params.get('error_level', 'error'))
                valid = True
                if validator == 'single_cardinality_validator': continue
                if validator == 'values':
                    allowed = [str(v) for v in params.get('values', [])]
                    valid = value in allowed if params.get('case_sensitive', False) else value.lower() in [v.lower() for v in allowed]
                elif validator == 'pattern':
                    valid = re.search(params['pattern'], value, 0 if params.get('case_sensitive', True) else re.I) is not None
                elif validator == 'semver':
                    prefix = params.get('prefix', '')
                    try:
                        parsed = Version(value[len(prefix):]) if value.startswith(prefix) else None
                        valid = parsed is not None and (params.get('allow_prerelease', False) or not parsed.prerelease)
                    except ValueError: valid = False
                else:
                    deferred.add(validator)
                if not valid: report(params.get('description') or f'Value fails {validator}.', name, index, value, level)
    for rule in resolved.get('validators', []):
        validator, params = rule['validator_name'], rule.get('params', {})
        if validator == 'min_columns':
            if len(headers) < params.get('min_columns', 0): report('Too few columns for the template.')
        elif validator == 'empty_cells':
            for index, row in enumerate(data):
                for name, value in zip(headers, row):
                    if not value.strip() and name not in definitions: report('Empty cell.', name, index, value)
        elif validator == 'trailing_whitespace_validator':
            for index, row in enumerate(data):
                for name, value in zip(headers, row):
                    if value != value.strip(): report('Leading or trailing whitespace.', name, index, value)
        else: deferred.add(validator)
    if deferred:
        report('Additional validation is required for: ' + ', '.join(sorted(deferred)) + '. This snapshot preflight does not claim a complete SDRF/ontology validation.', level='warning')
    return {'snapshotId': snapshot.snapshot_id, 'issues': issues, 'complete': not deferred,
            'valid': not any(i['level'] == 'error' for i in issues)}
