#!/usr/bin/env python3
"""Reproducible public examples and synthetic large-tail checks; opt-in network."""
import argparse
import asyncio
import gzip
import json
from pathlib import Path
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.tools.technical_metadata import Limits, extract_technical_metadata

EXAMPLES = {
    'pxd000070-27915': 'https://ftp.pride.ebi.ac.uk/pride/data/archive/2014/04/PXD000070/generated/PRIDE_Exp_Complete_Ac_27915.pride.mztab.gz',
    'pxd000070-27922': 'https://ftp.pride.ebi.ac.uk/pride/data/archive/2014/04/PXD000070/generated/PRIDE_Exp_Complete_Ac_27922.pride.mztab.gz',
    'sequest-mzid': 'https://raw.githubusercontent.com/HUPO-PSI/mzIdentML/master/examples/1_1examples/Sequest_example_ver1.1.mzid',
    'tandem-mzid': 'https://raw.githubusercontent.com/HUPO-PSI/mzIdentML/master/examples/1_1examples/55merge_tandem.mzid',
    'maxquant': 'https://raw.githubusercontent.com/galaxyproteomics/tools-galaxyp/ab4e4f1817080cbe8a031a82cb180610ff140847/tools/maxquant/test-data/single/mqpar.xml',
}


def check_example(name, result):
    """Expected values cross-checked against source metadata, not inferred by AI."""
    assert result['status'] == 'complete', (result['stop_reason'], result['error'])
    facts = result['facts']
    if name.startswith('pxd'):
        fixed = next(f for f in facts if f['field'] == 'fixed_mod[1]')
        assert fixed['value']['accession'] == 'MS:1002453'
        mods = [f['value']['accession'] for f in facts if f['field'].startswith('variable_mod[')]
        assert len(mods) == 5 and 'MOD:00397' in mods
        assert any('PRIDE XML' in warning for warning in result['warnings'])
    elif name == 'maxquant':
        fixed = next(f for f in facts if f['field'] == 'fixedModifications')
        assert fixed['value'] == ['Carbamidomethyl (C)']
        assert next(f for f in facts if f['field'] == 'enzymes')['value'] == ['Trypsin/P']
        tolerance = next(f for f in facts if f['field'] == 'mainSearchTol')
        assert tolerance['value']['entries'][0]['value'] == '4.5'
        assert next(f for f in facts if f['field'] == 'searchTolInPpm')['value']['entries'][0]['value'] == 'True'
        assert len([f for f in facts if f['field'] == 'msmsParams']) == 4
    else:
        parent = next(f for f in facts if f['field'] == 'ParentTolerance')['value']['parameters']
        fragment = next(f for f in facts if f['field'] == 'FragmentTolerance')['value']['parameters']
        assert {p['value'] for p in parent} == {'1.5'}
        assert {p['value'] for p in fragment} == ({'1.5'} if name == 'sequest-mzid' else {'0.8'})
        assert all(p['unitName'] == 'dalton' for p in parent + fragment)


async def benchmark(output, live):
    output.mkdir(parents=True, exist_ok=True)
    summary = []

    async def run(name, source, checker=None, **kwargs):
        result = await extract_technical_metadata(str(source), **kwargs)
        try:
            if checker:
                checker(name, result)
            else:
                assert result['status'] == 'complete'
                assert result['metrics']['source_bytes_read'] <= 16384
                assert result['metrics']['decoded_bytes'] <= 16384
            check = 'passed'
        except (AssertionError, KeyError, StopIteration) as error:
            check = f'failed: {error}'
        (output / f'{name}.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
        row = {'example': name, 'check': check, 'status': result['status'],
               'stop_reason': result['stop_reason'], 'facts': len(result['facts']), **result['metrics']}
        summary.append(row)
        print(json.dumps(row), flush=True)

    if live:
        for name, source in EXAMPLES.items():
            await run(name, source, check_example)
    with tempfile.TemporaryDirectory(prefix='sdrf-metadata-benchmark-') as folder:
        plain = Path(folder) / 'large-tail.mztab'
        header = b'MTD\tmzTab-version\t1.0\nMTD\tvariable_mod[1]\t[UNIMOD, UNIMOD:35, Oxidation, ]\nPSH\tsequence\n'
        # Intentionally synthetic tail, not a valid full mzTab: only the metadata
        # prefix is under test. Sparse allocation avoids writing 256 MiB to disk.
        with plain.open('wb') as handle:
            handle.write(header)
            handle.truncate(256 * 1024 * 1024)
        await run('synthetic-256mib-tail', plain)
        zipped = Path(folder) / 'large-tail.mztab.gz'
        with gzip.open(zipped, 'wb') as handle:
            handle.write(header)
            for _ in range(64):
                handle.write(b' ' * 1024 * 1024)
        await run('synthetic-64mib-gzip-tail', zipped)
    (output / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    return 1 if any(row['check'] != 'passed' for row in summary) else 0


if __name__ == '__main__':
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--live', action='store_true', help='Also fetch five public files')
    cli.add_argument('--output-dir', type=Path, required=True)
    args = cli.parse_args()
    sys.exit(asyncio.run(benchmark(args.output_dir, args.live)))
