import { expect, test } from 'bun:test';
import { runOpenLibrarySetPreviewJourney } from './cli-openlibrary-set-preview.ts';

test('an operator previews one mixed Open Library set, imports it, then resumes sealed work without member files', async () => {
  const r = await runOpenLibrarySetPreviewJourney();
  try {
    expect(r.initial.code).toBe(0);
    expect(r.previewed.code).toBe(0);
    expect(r.imported.code).toBe(0);
    expect(r.recovered.code).toBe(0);
    expect(r.denied.code).toBe(4);
    expect(r.workId).toBeTruthy();
    expect(r.editionId).toBeTruthy();
  } finally {
    await r.close();
  }
}, 1_800_000);
