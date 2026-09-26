"""Action contracts: validate structure before suggestions reach the browser.

State/evidence checks remain in the setup/ontology gates and wizard state. Never
coerce scientific numbers, remove positional blanks, or ignore extra arguments.
"""
import json
import math
import re
from pathlib import Path

CONTRACTS = json.loads(Path(__file__).with_name('action_contracts.json').read_text())
MAX_INTEGER = 9007199254740991


def text(value, nonempty=False):
    if not isinstance(value, str) or (nonempty and not value.strip()):
        raise ValueError('expected a non-empty string' if nonempty else 'expected a string')
    return value.strip()


def integer(value, minimum=0):
    if type(value) is not int or not minimum <= value <= MAX_INTEGER:
        raise ValueError(f'expected a safe integer >= {minimum}')
    return value


def obj(value):
    if not isinstance(value, dict): raise ValueError('expected an object')
    return value


def array(value):
    if not isinstance(value, list): raise ValueError('expected an array')
    return value


def term(value):
    record = obj(value)
    for key in ('id', 'label'): text(record.get(key), True)
    for key in ('iri', 'ontology', 'ontologyPrefix'):
        if key in record: text(record[key])


def factor(value):
    record = obj(value)
    text(record.get('name'), True)
    if 'enabled' in record and type(record['enabled']) is not bool: raise ValueError('enabled must be boolean')
    if 'scope' in record and record['scope'] not in ('sample', 'run'): raise ValueError('scope must be sample or run')
    for key in ('sourceCharacteristic', 'reasoning', 'defaultValue'):
        if key in record: text(record[key])
    if 'values' in record:
        for item in array(record['values']): text(item, True)


def modification(value):
    record = obj(value)
    text(record.get('name'), True)
    if not text(record.get('targetAminoAcids', record.get('target', ''))): raise ValueError('modification needs non-empty targetAminoAcids supported by evidence')
    if 'type' in record and text(record['type']).lower() not in ('fixed', 'variable'): raise ValueError('unknown modification type')
    if 'position' in record and text(record['position']).lower() not in ('anywhere', 'any n-term', 'protein n-term', 'any c-term', 'protein c-term'): raise ValueError('unknown modification position')
    for key in ('targetAminoAcids', 'target', 'unimodAccession', 'accession'):
        if key in record: text(record[key])
    if record.get('deltaMass') is not None:
        mass = record['deltaMass']
        if type(mass) not in (int, float) or not math.isfinite(mass): raise ValueError('deltaMass must be a finite number')


def plan(value):
    groups = array(obj(value).get('groups'))
    if not groups: raise ValueError('plan needs groups')
    for raw in groups:
        group = obj(raw)
        for key in ('name', 'labelConfigId'): text(group.get(key), True)
        if 'sampleMappingMode' in group and group['sampleMappingMode'] != 'rows': raise ValueError('sampleMappingMode must be rows when provided')
        channels = array(group.get('channels'))
        files = array(group.get('files'))
        if not channels or not files: raise ValueError('each group needs channels and files')
        for raw_channel in channels:
            channel = obj(raw_channel)
            text(channel.get('label'), True)
            if group.get('sampleMappingMode') == 'rows': text(channel.get('mappingId'), True)
            if 'pooledSourceNames' in channel:
                if 'sourceName' in channel: raise ValueError('use sourceName or pooledSourceNames, not both')
                sources = [text(v, True) for v in array(channel['pooledSourceNames'])]
                if len(sources) < 2 or len(set(sources)) != len(sources): raise ValueError('pool needs distinct sources')
            else: text(channel.get('sourceName'), True)
        for raw_file in files:
            file = obj(raw_file)
            text(file.get('fileName'), True)
            for key in ('fractionId', 'technicalReplicate'): integer(file.get(key), 1)
            if group.get('sampleMappingMode') == 'rows': text(file.get('mappingId'), True)
        if 'factorValues' in group:
            for key, val in obj(group['factorValues']).items(): text(key, True); text(val)


def validate_value(kind, value):
    if kind == 'text': text(value)
    elif kind == 'name': text(value, True)
    elif kind == 'nullableName':
        if value is not None: text(value, True)
    elif kind in ('names', 'assignments'):
        for item in array(value): text(item, kind == 'names')
    elif kind in ('index', 'positiveInteger', 'sampleCount'):
        integer(value, 0 if kind == 'index' else 1)
        if kind == 'sampleCount' and value > 10000: raise ValueError('sample count must be between 1 and 10000')
    elif kind in ('indices', 'replicates'):
        for item in array(value): integer(item, 1 if kind == 'replicates' else 0)
    elif kind == 'boolean':
        if type(value) is not bool and value not in ('true', 'false'): raise ValueError('expected boolean')
    elif kind == 'acquisition':
        if text(value).lower() not in ('dda', 'dia', 'prm', 'srm'): raise ValueError('unknown acquisition method')
    elif kind == 'explicit':
        if value != 'explicit': raise ValueError('assignment mode must be explicit')
    elif kind in ('term', 'optionalTerm'):
        if kind == 'term' or value is not None: term(value)
    elif kind == 'enzyme':
        record = obj(value); text(record.get('name'), True)
        text(record.get('msAccession', record.get('accession')), True)
    elif kind == 'choices':
        for item in array(value):
            record = obj(item); text(record.get('value'), True)
            if record.get('ontologyTerm') is not None: term(record['ontologyTerm'])
    elif kind == 'factor': factor(value)
    elif kind == 'factors':
        for item in array(value): factor(item)
    elif kind == 'modifications':
        for item in array(value): modification(item)
    elif kind == 'protocolValue': pass  # Validated against the column after argument shape validation.
    elif kind == 'protocolScope':
        if value != 'all':
            files = [text(item, True) for item in array(value)]
            if not files or len(set(files)) != len(files): raise ValueError('protocol scope must be all or a non-empty list of unique raw file names')
    elif kind == 'plan': plan(value)
    elif kind == 'fileUrls':
        for name, url in obj(value).items():
            text(name, True)
            if not re.match(r'^(https?|ftp)://[^\s/]+/', text(url)): raise ValueError('invalid repository file URL')
    elif kind == 'namedAssignments':
        for row in array(value):
            if not isinstance(row, list) or len(row) != 2: raise ValueError('expected [runName, files]')
            text(row[0], True)
            for entry in array(row[1]):
                if isinstance(entry, str): text(entry, True); continue
                if not isinstance(entry, list) or not 1 <= len(entry) <= 3: raise ValueError('expected [fileName, fractionId?, technicalReplicate?]')
                text(entry[0], True)
                for val in entry[1:]: integer(val, 1)
    elif kind == 'tolerance':
        val = text(value)
        if not val or val.lower() == 'not available': return
        match = re.fullmatch(r'(\d+(?:\.\d+)?|\.\d+)\s*(ppm|da|mmu)', val, re.I)
        if not match or not math.isfinite(float(match[1])) or float(match[1]) <= 0: raise ValueError('expected a positive mass tolerance with ppm, Da or mmu')
    else: raise ValueError(f'unknown parameter kind {kind}')


def normalize_action_args(op, args, sample_count=None):
    contract = CONTRACTS[op]
    args = list(array(args))
    normalization = contract.get('normalize')
    if normalization == 'stringList' and (not args or all(isinstance(item, str) for item in args)):
        args = [args]
    elif normalization == 'objectList' and args and all(isinstance(item, dict) for item in args):
        args = [args]
    elif normalization == 'object' and len(args) == 1 and isinstance(args[0], list) and len(args[0]) == 1 and isinstance(args[0][0], dict):
        args = [args[0][0]]
    # File import has a second URL-map argument; unwrap only an all-string list.
    if op == 'replaceWithUnassignedFileNames' and args and all(isinstance(v, str) for v in args): args = [args]
    types = contract['parameters']
    try:
        if not contract['minArgs'] <= len(args) <= len(types): raise ValueError(f'expected {contract["minArgs"]}..{len(types)} arguments, got {len(args)}')
        for kind, value in zip(types, args): validate_value(kind, value)
        if op == 'setProtocolValue':
            column = text(args[0], True)
            kind = {'comment[instrument]':'term', 'comment[cleavage agent details]':'enzyme',
                    'comment[modification parameters]':'modifications', 'comment[precursor mass tolerance]':'tolerance',
                    'comment[fragment mass tolerance]':'tolerance'}.get(column, 'text')
            validate_value(kind, args[1])
        if op == 'setInstrument' or (op == 'setProtocolValue' and args[0].strip() == 'comment[instrument]'):
            value = args[0] if op == 'setInstrument' else args[1]
            if not re.fullmatch(r'MS:\d{7}', value['id'].strip()): raise ValueError('instrument accession must be MS: followed by 7 digits')
        if op == 'setSourceNames':
            names = [v.strip() for v in args[0]]
            if len(set(names)) != len(names): raise ValueError('source names must be unique')
        if op in ('setSourceNames','setBiologicalReplicates','setFactorColumnValues','applyCharacteristicDraft'):
            position = {'setSourceNames':0,'setBiologicalReplicates':0,'setFactorColumnValues':1,'applyCharacteristicDraft':3}[op]
            if sample_count is not None and len(args[position]) != sample_count: raise ValueError(f'expected exactly {sample_count} values in current sample order')
        if op in ('setSampleCharacteristicValue','setSampleFactorValue') and sample_count is not None and args[0] >= sample_count: raise ValueError('sample index is out of range')
        if op == 'autoGenerateSourceNames' and (sample_count is None or sample_count > 1) and '{n}' not in args[0]: raise ValueError('name pattern must contain {n} to produce unique source names')
    except (ValueError, TypeError) as error:
        example = json.dumps(contract['example'], separators=(',', ':'))
        raise ValueError(f'{op}: {error}. Expected argsJson={example}') from error
    return args
