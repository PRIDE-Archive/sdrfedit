# PRIDE projects with 1–9 RAW files

Scan date: 2026-09-22

## Result

- Publicly searchable PRIDE projects scanned: **41,703**
- Projects with `RAW = 1–9`: **12,501**
- Projects with `RAW = 0` excluded from the CSV: **548**
- Project-level file-count failures: **0**

The result file is `pride_projects_raw_lt10_2026-09-22.csv`. It is sorted by
`raw_file_count`, then `accession`.

| RAW file count | Projects |
|---:|---:|
| 1 | 2,017 |
| 2 | 1,642 |
| 3 | 1,119 |
| 4 | 1,440 |
| 5 | 510 |
| 6 | 2,708 |
| 7 | 330 |
| 8 | 1,472 |
| 9 | 1,263 |
| **Total** | **12,501** |

Accession coverage in the 41,703-project search snapshot was 35 PAD, 524 PRD,
and 41,144 PXD projects. After excluding RAW=0, the filtered result contains
15 PAD and 12,486 PXD projects. All 524 legacy PRD projects had RAW=0 and are
therefore excluded.

## Definition and method

“RAW file” means a PRIDE file whose official `fileCategory.value` is `RAW`.
This is more complete than checking only for a `.raw` filename suffix because
vendor raw formats can use other filenames/extensions.

The CSV selection is `1 <= RAW < 10`; projects with zero RAW files are not
included. Projects were enumerated from the v3 `/search/projects` endpoint
with a stable ascending accession sort. Each project's category counts were read from
`/files/getCountOfFilesByType/{accession}`. Successful responses were written
immediately to the JSONL checkpoint so the scan could resume safely.

During this scan, PRIDE's project endpoints disagreed: `/projects` exposed
41,121 records, `/projects/count` changed from 41,680 to 41,682, and the sorted
public search exposed 41,703 unique records. The report deliberately uses all
41,703 publicly searchable records, including legacy PRD and PAD accessions.

## Validation

- The project cache and category-count checkpoint each contain exactly 41,703
  unique matching accessions.
- Recomputing the filter from the checkpoint reproduced all 12,501 CSV rows.
- Every CSV row has a RAW count in the inclusive range 1–9 and ordering was
  verified.
- Full per-file records were independently fetched for representative PAD,
  PRD, and PXD projects. One PXD example at every RAW count from 0 through 9
  matched the compact category-count endpoint.
- CSV SHA-256:
  `53b8a3cfcae9f88e43d45e52cdb58d603c1db77bd0b464364ebb9d95d8fc983c`

## Reproduction

Run from the repository root using the backend virtual environment:

```bash
backend/.venv/bin/python \
  backend/scripts/find_pride_projects_with_few_raw_files.py \
  reports/pride_projects_raw_lt10_2026-09-22.csv \
  --workers 48 \
  --min-raw-count 1
```

The script resumes from the existing checkpoint and project cache by default.
