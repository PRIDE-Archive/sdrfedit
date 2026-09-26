import assert from 'node:assert/strict';
import { it } from 'node:test';
import { fetchPrideRawFileNames } from './pride-archive.service.ts';

it('respects PRIDE classifications and uses conservative fallback for missing categories', async (t) => {
  const entries = [
    { fileName: 'WT_1.baf', fileCategory: { value: 'RAW' } },
    { fileName: 'WT_2.baf', fileCategory: ' raw ' },
    { fileName: 'WT_1.dat', fileCategory: { value: 'SEARCH' } },
    { fileName: 'result.raw', fileCategory: 'RESULT' },
    { fileName: 'peaks.mzML', fileCategory: { value: 'PEAK' } },
    { fileName: 'run.mzML', fileCategory: 'RAW' },
    { fileName: 'fallback.d.tar.gz' },
    { fileName: 'fallback.baf' },
    { fileName: 'ambiguous.dat' },
    { fileName: 'ambiguous.mzML' },
    { fileName: 'peaks.pkl' },
    { fileName: 'run.wiff.scan' },
  ];
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(entries)));
  const result = await fetchPrideRawFileNames('PXD003149');
  assert.deepEqual(result.fileNames, [
    'fallback.baf', 'fallback.d.tar.gz', 'run.mzML', 'WT_1.baf', 'WT_2.baf',
  ]);
});

it('preserves public download locations separately from names', async (t) => {
  const url = 'ftp://ftp.pride.ebi.ac.uk/pride/data/archive/2020/01/PXD000070/a.raw';
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify([
    {fileName:'a.raw',fileCategory:'RAW',publicFileLocations:[{value:url}]},
    {fileName:'b.raw',fileCategory:'RAW'},
  ])));
  const result = await fetchPrideRawFileNames('PXD000070');
  assert.deepEqual(result.fileNames,['a.raw','b.raw']);
  assert.equal(result.fileUrls['a.raw'],url);
  assert.equal(result.fileUrls['b.raw'],undefined);
});
