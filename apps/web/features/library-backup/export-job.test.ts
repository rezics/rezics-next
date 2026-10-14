import { expect, test } from 'bun:test';
import { ExportError } from './export-api.ts';
import { exportRow, fakeExportApi } from './export-fixtures.ts';
import { assembleFiles, collectExport, collectedRows, IMPORT_FILE_BYTES } from './export-job.ts';
import { memoryExportStore } from './export-store.ts';

test('an interrupted export resumes the bound cursor and snapshot without duplicating pages', async () => {
  const store = memoryExportStore();
  const { api, calls } = fakeExportApi(43, { failAt: 20 });
  const input = { api, store, agent: 'owner', onProgress: () => {} };
  await expect(collectExport(input)).rejects.toMatchObject({ failure: 'unavailable' });
  expect(await store.progress('owner')).toMatchObject({ rows: 20, cursor: 'cursor-20', snapshot: 'snapshot-1' });
  const complete = await collectExport(input);
  expect(calls).toEqual([{}, { cursor: 'cursor-20', snapshot: 'snapshot-1' },
    { cursor: 'cursor-20', snapshot: 'snapshot-1' }, { cursor: 'cursor-40', snapshot: 'snapshot-1' }]);
  expect(await collectedRows(store, 'owner', complete)).toHaveLength(43);
  expect(await store.progress('another-person')).toBeNull();
  expect(await store.pages('another-person')).toEqual([]);
});

test('a changed export basis retains the old pages until an explicit fresh restart', async () => {
  const store = memoryExportStore();
  await store.append('owner', { snapshot: 'old', cursor: 'bound', pages: 1, rows: 1, done: false }, [exportRow(0)]);
  await expect(collectExport({ store, agent: 'owner', onProgress: () => {}, api: {
    page: async () => { throw new ExportError('moved'); },
  } })).rejects.toMatchObject({ failure: 'moved' });
  expect(await store.progress('owner')).toMatchObject({ snapshot: 'old', rows: 1 });
  await store.clear('owner');
  const fresh = fakeExportApi(2);
  const done = await collectExport({ store, agent: 'owner', onProgress: () => {}, api: fresh.api });
  expect(fresh.calls).toEqual([{}]);
  expect(await collectedRows(store, 'owner', done)).toEqual([exportRow(0), exportRow(1)]);
});

test('credit and private review text survive file assembly, with every file importable', () => {
  const row = { ...exportRow(1), title: 'Original author’s volume', creators: ['Original author'],
    review: { text: 'Private reading note', language: 'ja', spoiler: true } };
  const rows = Array.from({ length: 5_001 }, () => row);
  const files = assembleFiles(rows, '2026-10-14');
  expect(files).toHaveLength(2);
  expect(files.flatMap(file => JSON.parse(file.text).rows)).toEqual(rows);
  for (const file of files) expect(new TextEncoder().encode(file.text).length).toBeLessThan(IMPORT_FILE_BYTES);
});

test('a different snapshot is refused before its rows can mix with the saved basis', async () => {
  const store = memoryExportStore();
  let page = 0;
  await expect(collectExport({ store, agent: 'owner', onProgress: () => {}, api: {
    page: async () => ({ profile: 'rezics-library-export-v1', rows: [exportRow(page)],
      snapshot: ++page === 1 ? 'basis-a' : 'basis-b', nextCursor: page === 1 ? 'bound-a' : null }),
  } })).rejects.toMatchObject({ failure: 'moved' });
  expect(await store.progress('owner')).toMatchObject({ rows: 1, snapshot: 'basis-a' });
  expect(await store.pages('owner')).toEqual([[exportRow(0)]]);
});
