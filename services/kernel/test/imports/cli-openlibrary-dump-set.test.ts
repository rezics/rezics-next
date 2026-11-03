import { expect, test } from 'bun:test';
import { runOpenLibraryDumpSetJourney } from './cli-openlibrary-dump-set.ts';

test('Open Library dump-set imports one generation, reverse order, refresh and sealed recovery', async () => {
  const r = await runOpenLibraryDumpSetJourney();
  try {
    expect(r.initial.code).toBe(0);
    expect(r.workId).not.toBe(r.editionId);
    expect(r.reversed.code).toBe(0);
    expect(r.reverseWork).not.toBe(r.workId);
    expect(r.refreshed.code).toBe(0);
    expect(r.recovered.code).toBe(0);
    expect(r.denied.code).toBe(4);
  } finally {
    await r.close();
  }
}, 1_800_000);
