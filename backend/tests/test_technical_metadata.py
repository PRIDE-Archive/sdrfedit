"""Offline regressions for bounded extraction and preservation of evidence scope."""
import asyncio
import gzip
import json

import httpx
import pytest

from app.tools.technical_metadata import Limits, extract_technical_metadata


def extract(path, **kwargs):
    return asyncio.run(extract_technical_metadata(str(path), **kwargs))


def write(tmp_path, name, content):
    path = tmp_path / name
    path.write_bytes(content.encode() if isinstance(content, str) else content)
    return path


MZTAB = ('MTD\tmzTab-version\t1.0\n'
         'MTD\tfixed_mod[1]\t[MS, MS:1002453, No fixed modifications searched, ]\n'
         'MTD\tvariable_mod[1]\t[UNIMOD, UNIMOD:4, Carbamidomethyl, ]\n'
         'MTD\tvariable_mod[1]-site\tC\n'
         'MTD\tcontact[1]-email\tnot-in-output@example.org\n'
         'MTD\tdescription\t10 ppm, 0.5 Da; text is not a structured tolerance\n'
         'COM\tOnly variable modifications can be reported when converted\n'
         'PSH\tsequence\tPSM_ID\n')


@pytest.mark.parametrize('compressed', [False, True])
def test_large_result_tail_is_not_read(tmp_path, compressed):
    payload = MZTAB.encode() + b'PSM\tPEPTIDE\t1\n' * 200_000
    path = write(tmp_path, 'x.mztab.gz' if compressed else 'x.mztab',
                 gzip.compress(payload) if compressed else payload)
    result = extract(path)
    assert result['status'] == 'complete'
    assert result['stop_reason'] == 'metadata_complete'
    assert result['metrics']['decoded_bytes'] <= 16384
    if not compressed:
        assert result['metrics']['source_bytes_read'] < path.stat().st_size / 100
    facts = {f['field']: f for f in result['facts']}
    assert facts['fixed_mod[1]']['value']['accession'] == 'MS:1002453'
    assert facts['variable_mod[1]-site']['scope'] == 'variable_mod[1]'
    assert facts['description']['evidence_kind'] == 'text'
    assert 'not-in-output@example.org' not in json.dumps(result)
    assert result['warnings'] == ['Only variable modifications can be reported when converted']


def test_absent_mods_are_unknown_not_empty(tmp_path):
    result = extract(write(tmp_path, 'x.mztab', 'MTD\tmzTab-version\t1.0\nPSH\tsequence\n'))
    assert result['missing_fields_mean'] == 'unknown'
    assert not any('mod[' in f['field'] for f in result['facts'])


def test_header_only_is_partial(tmp_path):
    result = extract(write(tmp_path, 'x.mztab', 'MTD\tmzTab-version\t1.0'))
    assert result['status'] == 'partial'
    assert result['stop_reason'] == 'eof_before_results'


def test_mzid_scopes_units_and_file_links(tmp_path):
    payload = '''<MzIdentML xmlns="http://psidev.info/psi/pi/mzIdentML/1.2">
    <SequenceCollection><DBSequence id="large"><Seq>PEPTIDE</Seq></DBSequence></SequenceCollection>
    <AnalysisCollection><SpectrumIdentification id="analysis1" spectrumIdentificationProtocol_ref="p1">
      <InputSpectra spectraData_ref="raw1"/></SpectrumIdentification></AnalysisCollection>
    <AnalysisProtocolCollection>
    <SpectrumIdentificationProtocol id="p1">
      <ModificationParams><SearchModification fixedMod="false" residues="C" massDelta="57.02"><!-- source note -->
      <cvParam accession="UNIMOD:4" name="Carbamidomethyl"/></SearchModification></ModificationParams>
      <Enzymes><Enzyme missedCleavages="3"><EnzymeName><cvParam accession="MS:1001251" name="Trypsin"/></EnzymeName></Enzyme></Enzymes>
      <ParentTolerance><cvParam accession="MS:1001412" value="10" unitName="parts per million" unitAccession="UO:0000169"/></ParentTolerance>
      <FragmentTolerance><cvParam value="0.5" unitName="dalton"/></FragmentTolerance>
    </SpectrumIdentificationProtocol>
    <SpectrumIdentificationProtocol id="p2"><ParentTolerance><cvParam value="20" unitName="parts per million"/></ParentTolerance></SpectrumIdentificationProtocol>
    </AnalysisProtocolCollection><DataCollection><Inputs><SpectraData id="raw1" location="file:///run.mgf"/></Inputs>
    <AnalysisData>'''
    result = extract(write(tmp_path, 'x.mzid', payload + '<SpectrumIdentificationList/>' * 100_000))
    assert result['stop_reason'] == 'metadata_complete'
    mods = [f for f in result['facts'] if f['field'] == 'SearchModification']
    assert mods[0]['value']['attributes']['fixedMod'] == 'false'
    assert 'p1' in mods[0]['scope']
    tolerances = [f for f in result['facts'] if f['field'] == 'ParentTolerance']
    assert [f['value']['parameters'][0]['value'] for f in tolerances] == ['10', '20']
    assert tolerances[0]['scope'] != tolerances[1]['scope']
    assert tolerances[0]['value']['parameters'][0]['unitAccession'] == 'UO:0000169'
    links = next(f for f in result['facts'] if f['field'] == 'SpectrumIdentification')
    assert links['value']['parameters'][0]['spectraData_ref'] == 'raw1'
    assert result['metrics']['source_bytes_read'] < 20000


def test_mqpar_group_specific_values_and_empty_lists(tmp_path):
    payload = '''<MaxQuantParams><filePaths><string>a.raw</string><string>b.raw</string></filePaths>
    <paramGroupIndices><int>0</int><int>1</int></paramGroupIndices><parameterGroups>
    <parameterGroup><fixedModifications/><variableModifications><string>Carbamidomethyl (C)</string></variableModifications><mainSearchTol>10</mainSearchTol><searchTolInPpm>true</searchTolInPpm></parameterGroup>
    <parameterGroup><fixedModifications><string>Carbamidomethyl (C)</string></fixedModifications><mainSearchTol>0.01</mainSearchTol><searchTolInPpm>false</searchTolInPpm></parameterGroup>
    </parameterGroups></MaxQuantParams>'''
    result = extract(write(tmp_path, 'mqpar.xml', payload))
    assert result['status'] == 'complete'
    fixed = [f for f in result['facts'] if f['field'] == 'fixedModifications']
    assert fixed[0]['value'] == []
    assert fixed[1]['value'] == ['Carbamidomethyl (C)']
    assert fixed[0]['scope'] == 'parameterGroup[1]'
    assert fixed[1]['scope'] == 'parameterGroup[2]'
    assert next(f for f in result['facts'] if f['field'] == 'paramGroupIndices')['value'] == ['0', '1']


@pytest.mark.parametrize('name,content', [
    ('x.mztab', '<html>Bad gateway</html>'),
    ('x.mzid', '<html/>'),
    ('mqpar.xml', '<MaxQuantParams><broken></MaxQuantParams>'),
    ('mqpar.xml', '<!DOCTYPE x [<!ENTITY secret SYSTEM "file:///etc/passwd">]><MaxQuantParams/>'),
    ('x.mztab.gz', b'not gzip'),
    ('x.mztab.gz', gzip.compress(b'MTD\tmzTab-version\t1.0\n')[:-5]),
])
def test_invalid_inputs_fail_explicitly(tmp_path, name, content):
    result = extract(write(tmp_path, name, content))
    assert result['status'] == 'error'
    assert result['error']


@pytest.mark.parametrize('limit,expected', [
    ({'max_download_bytes': 100}, 'download_limit'),
    ({'max_decoded_bytes': 100}, 'decoded_limit'),
    ({'max_facts': 1}, 'fact_limit'),
    ({'max_line_bytes': 20}, 'line_limit'),
])
def test_budgets_report_partial(tmp_path, limit, expected):
    result = extract(write(tmp_path, 'x.mztab', MZTAB), limits=Limits(**limit))
    assert result['status'] == 'partial'
    assert result['stop_reason'] == expected


def test_gzip_expansion_budget(tmp_path):
    data = gzip.compress(b'MTD\tmzTab-version\t1.0\n' + b' ' * 10_000_000)
    result = extract(write(tmp_path, 'x.mztab.gz', data), limits=Limits(max_decoded_bytes=1024))
    assert result['stop_reason'] == 'decoded_limit'
    assert result['metrics']['decoded_bytes'] == 1024


class Stream(httpx.AsyncByteStream):
    def __init__(self, chunks, delay=0):
        self.chunks, self.delay, self.closed, self.read = chunks, delay, False, 0

    async def __aiter__(self):
        for chunk in self.chunks:
            await asyncio.sleep(self.delay)
            self.read += 1
            yield chunk

    async def aclose(self):
        self.closed = True


def test_http_stops_and_closes_connection():
    stream = Stream([MZTAB.encode().ljust(16384, b' '), b'x' * 16384])
    transport = httpx.MockTransport(lambda request: httpx.Response(
        200, headers={'content-length': '32768'}, stream=stream))
    result = extract('https://example.org/test.mztab', transport=transport)
    assert result['status'] == 'complete'
    assert stream.read == 1 and stream.closed
    assert result['metrics']['source_size_bytes'] == 32768


def test_timeout_preserves_already_read_facts():
    stream = Stream([(b'MTD\tmzTab-version\t1.0\n' + b'\n' * 16384)[:16384], b'PSH\tseq\n'], delay=.04)
    transport = httpx.MockTransport(lambda request: httpx.Response(200, stream=stream))
    result = extract('https://example.org/test.mztab', transport=transport, limits=Limits(timeout_seconds=.07))
    assert result['stop_reason'] == 'time_limit'
    assert result['status'] == 'partial'
    assert result['facts'][0]['field'] == 'mzTab-version'
    assert stream.closed


@pytest.mark.parametrize('code', [404, 500])
def test_http_errors_are_not_parsed(code):
    transport = httpx.MockTransport(lambda request: httpx.Response(code, content=b'error'))
    result = extract('https://example.org/test.mztab', transport=transport)
    assert result['status'] == 'error'
    assert not result['facts']


def test_xml_dtd_split_at_read_boundary(tmp_path):
    data = b' ' * (16384 - 4) + b'<!DOCTYPE MaxQuantParams><MaxQuantParams/>'
    assert extract(write(tmp_path, 'mqpar.xml', data))['status'] == 'error'


@pytest.mark.parametrize('limits', [{'timeout_seconds': 0}, {'max_download_bytes': -1}, {'timeout_seconds': float('nan')}, {'timeout_seconds': float('inf')}])
def test_invalid_limits(limits):
    with pytest.raises(ValueError):
        Limits(**limits)


def test_mqpar_msms_presets_have_separate_scope(tmp_path):
    xml = '''<MaxQuantParams><msmsParamsArray>
      <msmsParams><Name>FTMS</Name><MatchTolerance>20</MatchTolerance><MatchToleranceInPpm>True</MatchToleranceInPpm></msmsParams>
      <msmsParams><Name>ITMS</Name><MatchTolerance>0.5</MatchTolerance><MatchToleranceInPpm>False</MatchToleranceInPpm></msmsParams>
    </msmsParamsArray></MaxQuantParams>'''
    result = extract(write(tmp_path, 'mqpar.xml', xml))
    facts = result['facts']
    assert [f['scope'] for f in facts] == ['msmsParams[1]', 'msmsParams[2]']
    assert facts[0]['value']['entries'][1]['value'] == '20'
    assert facts[1]['value']['entries'][1]['value'] == '0.5'
    assert any('does not prove' in warning for warning in result['warnings'])


def test_mzid_conflicting_mods_are_retained_with_warning(tmp_path):
    xml = '''<MzIdentML><AnalysisProtocolCollection><SpectrumIdentificationProtocol id="p1" analysisSoftware_ref="software1">
    <ModificationParams>
    <SearchModification fixedMod="true" residues="C"><cvParam accession="UNIMOD:4"/></SearchModification>
    <SearchModification fixedMod="false" residues="C"><cvParam accession="UNIMOD:4"/></SearchModification>
    </ModificationParams></SpectrumIdentificationProtocol></AnalysisProtocolCollection>
    <DataCollection><Inputs/><AnalysisData/></DataCollection></MzIdentML>'''
    result = extract(write(tmp_path, 'x.mzid', xml))
    mods = [f for f in result['facts'] if f['field'] == 'SearchModification']
    assert len(mods) == 2
    assert mods[0]['location'] != mods[1]['location']
    assert any('both fixed and variable' in warning for warning in result['warnings'])
    assert result['facts'][0]['value']['analysisSoftware_ref'] == 'software1'


def test_mzid_protocol_after_large_sequences_hits_budget(tmp_path):
    prefix = '<MzIdentML><SequenceCollection>' + '<DBSequence id="x"><Seq>PEPTIDE</Seq></DBSequence>' * 1000
    result = extract(write(tmp_path, 'x.mzid', prefix), limits=Limits(max_download_bytes=16384))
    assert result['status'] == 'partial'
    assert result['stop_reason'] == 'download_limit'
    assert not result['facts']


def test_utf16_xml_dtd_is_rejected(tmp_path):
    data = '<!DOCTYPE MaxQuantParams><MaxQuantParams/>'.encode('utf-16')
    assert extract(write(tmp_path, 'mqpar.xml', data))['status'] == 'error'
