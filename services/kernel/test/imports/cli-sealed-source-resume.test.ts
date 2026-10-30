import { expect, test } from 'bun:test';
import { runJourney } from './cli-sealed-source-resume-fixture.ts';

test('VNDB and Wikidata CLI recover the original sealed generation without mixing a replacement acquisition into pending native writes', async () => {
  const r = await runJourney();
  try {
    expect(r.sources.map((s) => s.source).sort()).toEqual(['vndb', 'wikidata']);
    for (const s of r.sources) {
      expect([1, 130]).toContain(s.interrupted.code);
      expect(s.originalPendingBytes.length).toBeGreaterThan(0);
      expect(s.resumed.code).toBe(0);
      expect(s.resumedBodies).toEqual(s.originalPendingBytes);
      expect(s.resumedKeys).toEqual(s.originalPendingKeys);
      expect(s.originalReceiptRowsAfter).toEqual(s.originalReceiptRowsBefore);
      expect(s.duplicateEffects).toEqual([]);
      expect(s.invalidFresh.code).toBe(2);
      expect(s.invalidFreshEffects).toEqual([]);
      expect(s.successor.code).toBe(0);
      expect(s.successorFirstEffect).toBeGreaterThan(s.pendingLastEffect);
      expect(s.subjectIdsAfter).toEqual(s.subjectIdsBefore);
      expect(s.independentSelectionAfter).toEqual(s.independentSelectionBefore);
    }
    expect(r.vndbInvalidBeforeResume.code).toBe(2);
    expect(r.vndbInvalidAuthAndWrites).toEqual([]);
    expect(r.vndbPendingAfterInvalid).toEqual(r.vndbPendingBeforeInvalid);
    expect(r.wikidataReplacementBytesReadWhileResuming).toBe(0);
  } finally {
    await r.close();
  }
}, 1_800_000);
