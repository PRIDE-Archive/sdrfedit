#!/usr/bin/env python3
"""Scan all publicly searchable PRIDE projects for exactly 5, 6 or 7 .raw files.

Filename extension, case insensitive, is authoritative; category is irrelevant.
The API filenameFilter is a case-insensitive substring prefilter. Every returned
filename is checked locally. Candidates are independently verified against the
complete unfiltered file list before inclusion. Successful scans are resumable.
"""
import argparse
import csv
import json
import os
import signal
import sys
import time
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from datetime import datetime, timezone
from pathlib import Path

from find_pride_projects_with_few_raw_files import get_json, list_projects

TARGETS = {5, 6, 7}
RULE = 'filename.lower().endswith(".raw"); distinct filename; no archive unpacking; v1'


def now():
    return datetime.now(timezone.utc).isoformat()


def raw_names(entries):
    if not isinstance(entries, list):
        raise ValueError('Expected a list of file records')
    names = set()
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get('fileName'), str):
            raise ValueError('Malformed file record or missing fileName')
        name = entry['fileName']
        if name.lower().endswith('.raw'):
            names.add(name)
    return names


def scan_project(accession, fetch):
    names = set()
    signatures = set()
    page = 0
    while True:
        records = fetch(f'/projects/{accession}/files?filenameFilter=.raw&pageSize=100&page={page}')
        names.update(raw_names(records))
        if len(names) > 7:
            return dict(accession=accession, status='excluded', raw_file_count_lower_bound=len(names), checked_at=now())
        if not records:
            break
        signature = tuple(sorted(record['fileName'] for record in records))
        if signature in signatures:
            raise ValueError('File pagination repeated a page')
        signatures.add(signature)
        # Fetch until an empty page, not merely a short page: avoid server caps.
        page += 1
    if len(names) not in TARGETS:
        return dict(accession=accession, status='excluded', raw_file_count=len(names), checked_at=now())
    records = fetch(f'/projects/{accession}/files/all')
    verified = raw_names(records)
    if verified != names:
        raise ValueError('Filtered and complete file lists disagree; not accepting an incomplete result')
    matching = []
    seen = set()
    for record in records:
        name = record['fileName']
        if name in verified and name not in seen:
            seen.add(name)
            matching.append({key: record.get(key) for key in ('fileName', 'fileAccession', 'fileSizeBytes', 'fileCategory', 'publicFileLocations')})
    return dict(accession=accession, status='matched', raw_file_count=len(verified),
                total_file_count=len(records), raw_file_names=sorted(verified), files=matching, checked_at=now())


def atomic_json(path, data):
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    temp.replace(path)


def write_csv(path, fields, rows):
    temp = path.with_suffix('.csv.tmp')
    with temp.open('w', newline='', encoding='utf-8-sig') as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    temp.replace(path)


def publish(output, projects, results, errors, started, finished=False):
    fields = ['accession', 'raw_file_count', 'total_file_count', 'title', 'submission_type',
              'submission_date', 'publication_date', 'project_url', 'raw_file_names', 'checked_at']
    rows, files = [], []
    for project in projects:
        accession = project['accession']
        record = results.get(accession, {})
        if record.get('status') != 'matched':
            continue
        rows.append(dict(accession=accession, raw_file_count=record['raw_file_count'],
                         total_file_count=record['total_file_count'], title=project.get('title', ''),
                         submission_type=project.get('submissionType', ''), submission_date=project.get('submissionDate', ''),
                         publication_date=project.get('publicationDate', ''),
                         project_url=f'https://www.ebi.ac.uk/pride/archive/projects/{accession}',
                         raw_file_names=json.dumps(record['raw_file_names'], ensure_ascii=False), checked_at=record['checked_at']))
        for file in record['files']:
            files.append(dict(accession=accession, file_name=file['fileName'],
                              file_accession=file.get('fileAccession'),
                              locations=json.dumps(file.get('publicFileLocations'), ensure_ascii=False)))
    rows.sort(key=lambda row: row['accession'])
    files.sort(key=lambda row: (row['accession'], row['file_name']))
    write_csv(output/'projects_raw_5_6_7.csv', fields, rows)
    for count in sorted(TARGETS):
        write_csv(output/f'projects_raw_eq{count}.csv', fields, [row for row in rows if row['raw_file_count'] == count])
    write_csv(output/'raw_files.csv', ['accession', 'file_name', 'file_accession', 'locations'], files)
    write_csv(output/'failures.csv', ['accession', 'error'], [dict(accession=k, error=v) for k,v in sorted(errors.items())])
    status = dict(started_at=started, updated_at=now(), finished=finished,
                  complete=finished and not errors and len(results)==len(projects), rule=RULE,
                  public_projects=len(projects), checked=len(results), failed=len(errors),
                  pending=len(projects)-len(results)-len(errors), matched=len(rows),
                  by_count={str(n):sum(row['raw_file_count']==n for row in rows) for n in sorted(TARGETS)})
    atomic_json(output/'progress.json', status)
    print(json.dumps(status), flush=True)


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument('--output-dir', type=Path, required=True)
    cli.add_argument('--workers', type=int, default=16)
    cli.add_argument('--timeout', type=float, default=30)
    cli.add_argument('--attempts', type=int, default=4)
    args = cli.parse_args()
    if args.workers < 1 or args.workers > 32: cli.error('workers must be 1–32')
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    config = output/'scan-config.json'
    if config.exists() and json.loads(config.read_text())['rule'] != RULE:
        raise RuntimeError('Output directory uses a different counting rule')
    atomic_json(config, dict(rule=RULE, api='https://www.ebi.ac.uk/pride/ws/archive/v3', workers=args.workers))
    started = now()
    lock = output/'scan.lock'
    if lock.exists():
        pid = int(lock.read_text())
        try: os.kill(pid, 0)
        except ProcessLookupError: lock.unlink()
        else: raise RuntimeError(f'Scan already running: {pid}')
    with lock.open('x') as handle: handle.write(str(os.getpid()))
    stopped = False
    def stop(*_):
        nonlocal stopped
        stopped = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        projects = list_projects(100, args.timeout, args.attempts, args.workers, output/'public-projects.json')
        checkpoint = output/'checkpoint.jsonl'
        results = {}
        if checkpoint.exists():
            for line in checkpoint.read_text().splitlines():
                if line.strip():
                    row = json.loads(line)
                    results[row['accession']] = row
        errors = {}
        pending = iter(p['accession'] for p in projects if p['accession'] not in results)
        publish(output, projects, results, errors, started)
        def run(accession):
            return scan_project(accession, lambda path: get_json(path, timeout=args.timeout, attempts=args.attempts))
        with checkpoint.open('a', encoding='utf-8') as handle, ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = {}
            def fill():
                while not stopped and len(futures) < args.workers:
                    accession = next(pending, None)
                    if accession is None: break
                    futures[pool.submit(run, accession)] = accession
            fill()
            last_report = time.monotonic()
            while futures:
                done, _ = wait(futures, timeout=5, return_when=FIRST_COMPLETED)
                for future in done:
                    accession = futures.pop(future)
                    try:
                        record = future.result()
                        results[accession] = record
                        handle.write(json.dumps(record, ensure_ascii=False, separators=(',', ':'))+'\n')
                        handle.flush()
                    except Exception as error:
                        errors[accession] = f'{type(error).__name__}: {error}'
                fill()
                if time.monotonic()-last_report >= 30:
                    publish(output, projects, results, errors, started)
                    last_report = time.monotonic()
        publish(output, projects, results, errors, started, finished=not stopped)
    finally:
        lock.unlink(missing_ok=True)


if __name__ == '__main__':
    main()
