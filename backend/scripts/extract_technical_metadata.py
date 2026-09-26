#!/usr/bin/env python3
"""Standalone metadata probe. No agent registration or SDRF changes."""
import argparse
import asyncio
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from app.tools.technical_metadata import Limits, extract_technical_metadata


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('source', help='Local path or HTTP(S) URL')
    cli.add_argument('--format', choices=['mztab', 'mzidentml', 'mqpar'])
    cli.add_argument('--timeout', type=float, default=15)
    cli.add_argument('--max-download-mib', type=float, default=8)
    cli.add_argument('--max-decoded-mib', type=float, default=32)
    cli.add_argument('--output', type=Path)
    args = cli.parse_args()
    try:
        limits = Limits(timeout_seconds=args.timeout,
                        max_download_bytes=int(args.max_download_mib * 1024 * 1024),
                        max_decoded_bytes=int(args.max_decoded_mib * 1024 * 1024))
        result = asyncio.run(extract_technical_metadata(args.source, format_name=args.format, limits=limits))
    except ValueError as error:
        cli.error(str(error))
    payload = json.dumps(result, ensure_ascii=False, indent=2) + '\n'
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload, encoding='utf-8')
    else:
        print(payload, end='')
    return {'complete': 0, 'partial': 2, 'error': 1}[result['status']]


if __name__ == '__main__':
    sys.exit(main())
