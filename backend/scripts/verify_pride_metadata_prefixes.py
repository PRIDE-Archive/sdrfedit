#!/usr/bin/env python3
"""Re-fetch short source prefixes and check extracted facts against raw records.

This checks transcription/source consistency, not scientific correctness or
complete coverage. XML is independently parsed as a tree; recover=True only
allows prefix truncation and is never used by the production extractor.
"""
import argparse
import asyncio
import hashlib
import json
from pathlib import Path
import re
import zlib

import httpx
from lxml import etree


async def main(folder):
    rows = json.loads((folder / 'summary.json').read_text())
    sem = asyncio.Semaphore(2)
    async with httpx.AsyncClient(timeout=20, follow_redirects=True) as client:
        async def verify(row):
            async with sem:
                try:
                    wire = 0
                    prefix = bytearray()
                    zipped = row['url'].lower().endswith('.gz')
                    dec = zlib.decompressobj(16 + zlib.MAX_WBITS) if zipped else None
                    async with client.stream('GET', row['url'], headers={'Accept-Encoding': 'identity'}) as response:
                        response.raise_for_status()
                        async for data in response.aiter_raw(chunk_size=4096):
                            wire += len(data)
                            room = 256 * 1024 - len(prefix)
                            prefix.extend(dec.decompress(data, room) if dec else data[:room])
                            if row['format'] == 'mztab' and re.search(br'\n(?:PRH|PEH|PSH)\t', prefix):
                                break
                            if len(prefix) >= 256 * 1024 or wire >= 128 * 1024:
                                break
                    result = json.loads((folder / row['result_file']).read_text())
                    checked, unavailable, mismatches = [], [], []
                    if row['format'] == 'mztab':
                        lines = bytes(prefix).decode('utf-8-sig').splitlines()
                        for fact in result['facts']:
                            index = int(fact['location'].split(':')[1]) - 1
                            if index >= len(lines):
                                unavailable.append(fact['location'])
                                continue
                            expected = ('COM\t' + fact['raw']) if fact['field'] == 'source_comment' else ('MTD\t' + fact['field'] + '\t' + fact['raw'])
                            (checked if lines[index] == expected else mismatches).append(fact['location'])
                    else:
                        parser = etree.XMLParser(recover=True, resolve_entities=False, no_network=True, load_dtd=False)
                        root = etree.fromstring(bytes(prefix), parser)
                        if root is None:
                            raise ValueError('No XML root found')
                        for el in root.iter():
                            if isinstance(el.tag, str):
                                el.tag = etree.QName(el).localname
                        tree = root.getroottree()
                        for fact in result['facts']:
                            nodes = tree.xpath(fact['location'])
                            if len(nodes) != 1:
                                unavailable.append(fact['location'])
                                continue
                            node, value = nodes[0], fact['value']
                            leaves = [(el.tag, (el.text or '').strip()) for el in node.iter() if isinstance(el.tag, str) and len(el) == 0]
                            if isinstance(value, list):
                                values = [text for _, text in leaves]
                                if len(node) == 0 and not (node.text or '').strip():
                                    values = []
                                ok = value == values
                            elif fact['field'] == 'protocol':
                                ok = value == dict(node.attrib)
                            elif 'entries' in value:
                                ok = value['attributes'] == dict(node.attrib) and value['entries'] == [{'field': tag, 'value': text} for tag, text in leaves]
                            else:
                                actual_params = [dict(el.attrib) for el in node.iter() if isinstance(el.tag, str) and el.tag in {'cvParam', 'userParam', 'InputSpectra', 'SearchDatabaseRef'}]
                                expected_params = [{k: v for k, v in param.items() if k not in {'element', 'parent_element'}} for param in value['parameters']]
                                ok = dict(node.attrib) == value['attributes'] and actual_params == expected_params
                            (checked if ok else mismatches).append(fact['location'])
                    record = {'accession': row['accession'], 'file_name': row['file_name'],
                              'result_file': row['result_file'], 'url': row['url'],
                              'checked_facts': len(checked), 'unavailable_in_prefix': unavailable,
                              'mismatches': mismatches, 'prefix_bytes': len(prefix),
                              'prefix_sha256': hashlib.sha256(prefix).hexdigest(),
                              'first_lines': bytes(prefix).decode('utf-8', errors='replace').splitlines()[:3] if not result['facts'] else [],
                              'status': 'mismatch' if mismatches else 'matched' if checked else 'no_facts_to_verify'}
                except Exception as error:
                    record = {'accession': row['accession'], 'result_file': row['result_file'], 'status': 'verification_error', 'error': str(error)}
                print(json.dumps({k: v for k, v in record.items() if k not in {'first_lines', 'url', 'prefix_sha256'}}, ensure_ascii=False), flush=True)
                return record
        checks = await asyncio.gather(*(verify(row) for row in rows))
    (folder / 'source-checks.json').write_text(json.dumps(checks, ensure_ascii=False, indent=2) + '\n')
    return int(any(check['status'] in {'mismatch', 'verification_error'} for check in checks))


if __name__ == '__main__':
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('results_dir', type=Path)
    args = cli.parse_args()
    raise SystemExit(asyncio.run(main(args.results_dir)))
