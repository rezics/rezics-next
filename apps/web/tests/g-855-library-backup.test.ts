import { describe, expect, test } from 'bun:test';
import { ExportError } from '../features/library-backup/export-api.ts';
import { exportRow, fakeExportApi } from '../features/library-backup/export-fixtures.ts';
import { assembleFiles, collectedRows, collectExport, IMPORT_FILE_BYTES, IMPORT_FILE_ROWS } from '../features/library-backup/export-job.ts';
import { memoryExportStore } from '../features/library-backup/export-store.ts';

const agent = 'agent';
const run = (api: ReturnType<typeof fakeExportApi>['api'], store = memoryExportStore(), seen: number[] = []) =>
  collectExport({ api, store, agent, onProgress: progress => seen.push(progress.rows) });

describe('G-855: the export is collected page by page and resumes where it stopped', () => {
  test('every page is kept as it arrives, and the file is only offered once the count matches', async () => {
    const store = memoryExportStore(), seen: number[] = [];
    const progress = await run(fakeExportApi(45).api, store, seen);
    expect(progress).toMatchObject({ done: true, rows: 45, pages: 3, cursor: null });
    expect(seen).toEqual([20, 40, 45]);
    expect(await collectedRows(store, agent, progress)).toHaveLength(45);
  });

  test('an interrupted download resumes with the stored cursor and snapshot, asking only for what remains', async () => {
    const store = memoryExportStore();
    const flaky = fakeExportApi(45, { failAt: 20 });
    await expect(run(flaky.api, store)).rejects.toMatchObject({ failure: 'unavailable' });
    expect(await store.progress(agent)).toMatchObject({ rows: 20, cursor: 'cursor-20', done: false });
    const resumed = await run(flaky.api, store);
    expect(flaky.calls.at(-2)).toEqual({ cursor: 'cursor-20', snapshot: 'snapshot-1' });
    expect(flaky.calls).toHaveLength(4);
    expect((await collectedRows(store, agent, resumed)).map(row => row.work)).toEqual(Array.from({ length: 45 }, (_, index) => exportRow(index).work));
  });

  test('a library that changed is refused rather than mixed, and a pages-do-not-add-up store is not offered', async () => {
    const store = memoryExportStore();
    await store.append(agent, { snapshot: 'snapshot-1', cursor: 'cursor-20', pages: 1, rows: 20, done: false },
      Array.from({ length: 20 }, (_, index) => exportRow(index)));
    await expect(run(fakeExportApi(45, { moved: true }).api, store)).rejects.toBeInstanceOf(ExportError);
    const lost = memoryExportStore();
    await lost.append(agent, { snapshot: 's', cursor: null, pages: 1, rows: 20, done: true }, [exportRow(0)]);
    await expect(collectedRows(lost, agent, { snapshot: 's', cursor: null, pages: 1, rows: 20, done: true })).rejects.toBeInstanceOf(ExportError);
  });

  test('another snapshot or profile mid-download ends it', async () => {
    const swapped = { page: async (position: { cursor?: string }) => ({ profile: 'rezics-library-export-v1' as const,
      rows: [exportRow(0)], snapshot: position.cursor ? 'other' : 'one', nextCursor: position.cursor ? null : 'c' }) };
    await expect(run(swapped)).rejects.toMatchObject({ failure: 'moved' });
    await expect(run({ page: async () => ({ profile: 'other' as never, rows: [], snapshot: 's', nextCursor: null }) })).rejects.toMatchObject({ failure: 'unavailable' });
  });
});

describe('G-855: the file is one bundle the REZICS import reads, or several in order', () => {
  test('a library within one import is one file named by day', () => {
    const files = assembleFiles(Array.from({ length: 1_200 }, (_, index) => exportRow(index)), '2026-10-01');
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('rezics-library-2026-10-01.json');
    expect(JSON.parse(files[0]!.text)).toMatchObject({ profile: 'rezics-library-export-v1' });
    expect(JSON.parse(files[0]!.text).rows).toHaveLength(1_200);
  });

  test('past an import’s rows or bytes the rows continue in the next numbered file, none lost', () => {
    const rows = Array.from({ length: IMPORT_FILE_ROWS + 10 }, (_, index) => exportRow(index));
    const files = assembleFiles(rows, '2026-10-01');
    expect(files.map(file => file.name)).toEqual(['rezics-library-2026-10-01-part-1-of-2.json', 'rezics-library-2026-10-01-part-2-of-2.json']);
    expect(files.reduce((sum, file) => sum + file.rows, 0)).toBe(rows.length);
    const wide = Array.from({ length: 30 }, (_, index) => ({ ...exportRow(index), raw: { note: 'x'.repeat(100_000) } }));
    const byBytes = assembleFiles(wide, '2026-10-01');
    expect(byBytes.length).toBeGreaterThan(1);
    for (const file of byBytes) expect(new TextEncoder().encode(file.text).length).toBeLessThanOrEqual(IMPORT_FILE_BYTES);
  });

  test('an empty library is one empty bundle', () => {
    expect(assembleFiles([], '2026-10-01')).toEqual([{ name: 'rezics-library-2026-10-01.json', rows: 0,
      text: '{"profile":"rezics-library-export-v1","rows":[]}' }]);
  });
});
