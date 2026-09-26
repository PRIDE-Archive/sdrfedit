#!/usr/bin/env python3
"""Run the standalone extractor against a saved PRIDE API file selection.

Each attempt is saved, including partial reads/errors. No agent integration.
"""
import argparse
import asyncio
from dataclasses import asdict
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.tools.technical_metadata import Limits, extract_technical_metadata


async def main(manifest, output, timeout, resume=False):
    output.mkdir(parents=True, exist_ok=True)
    entries = json.loads(manifest.read_text())
    previous = {}
    if resume and (output / 'summary.json').exists():
        previous = {row['url']: row for row in json.loads((output / 'summary.json').read_text())}
    sem = asyncio.Semaphore(2)

    async def run(index, entry):
        if entry['url'] in previous and (output / previous[entry['url']]['result_file']).exists():
            row = previous[entry['url']]
            saved = json.loads((output / row['result_file']).read_text())
            if saved.get('limits') == asdict(Limits(timeout_seconds=timeout)):
                return row
        async with sem:
            result = await extract_technical_metadata(entry['url'], format_name=entry['format'],
                                                     limits=Limits(timeout_seconds=timeout))
            name = f"{index:02d}-{entry['accession']}.json"
            (output / name).write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
            row = {**entry, 'result_file': name, 'status': result['status'],
                   'stop_reason': result['stop_reason'], 'error': result['error'],
                   'fact_count': len(result['facts']), 'warnings': result['warnings'],
                   'fields': sorted({f['field'] for f in result['facts']}), **result['metrics']}
            print(json.dumps({k: v for k, v in row.items() if k not in {'fields', 'warnings', 'url'}}, ensure_ascii=False), flush=True)
            return row

    rows = await asyncio.gather(*(run(i, e) for i, e in enumerate(entries, 1)))
    (output / 'summary.json').write_text(json.dumps(rows, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--manifest', type=Path, required=True)
    cli.add_argument('--output-dir', type=Path, required=True)
    cli.add_argument('--timeout', type=float, default=15)
    cli.add_argument('--resume', action='store_true', help='Keep existing attempts with identical limits, including failures')
    args = cli.parse_args()
    asyncio.run(main(args.manifest, args.output_dir, args.timeout, args.resume))
