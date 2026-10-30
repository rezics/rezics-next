import { expect, test } from 'bun:test';
import { runJourney } from './cli-rejected-cover-recovery-fixture.ts';

test('ordinary Bangumi and Open Library CLI retain explicit native cover rejection and recover through a valid successor', async () => {
  const r = await runJourney();
  try {
    expect(r.sources.map((s) => s.source).sort()).toEqual(['bangumi', 'openlibrary']);
    for (const s of r.sources) {
      expect(s.first.code).toBe(0);
      expect(s.rejected.row.state).toBe('rejected');
      expect(s.rejected.variants).toEqual([]);
      expect(s.rejectedMappedMediaIds).toEqual([]);
      expect(s.rejectedAttachments).toEqual([]);
      expect(s.rejectedDownload.status).not.toBe(200);
      expect(s.reopened.code).toBe(0);
      expect(s.reopenMediaPosts).toEqual([]);
      expect(s.reopenSourceRequests).toEqual([]);
      expect(s.successor.code).toBe(0);
      expect(s.available.row.state).toBe('available');
      expect(s.available.row.id).not.toBe(s.rejected.row.id);
      expect(s.available.original).toEqual(s.successorSourceBytes);
      expect(s.available.variants.length).toBeGreaterThan(0);
      for (const v of s.available.variants) {
        expect(['avif', 'webp']).toContain(v.format);
        expect(v.bytes).not.toEqual(s.successorSourceBytes);
      }
      expect(s.originalReceiptsAfter).toEqual(s.originalReceiptsBefore);
      expect(s.independentSelectionAfter).toEqual(s.independentSelectionBefore);
    }
  } finally {
    await r.close();
  }
}, 1_800_000);
