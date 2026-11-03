import { expect, test } from 'bun:test';
import { runCompressedStagingResumeJourney } from './cli-compressed-staging.ts';

test('checkpointed gzip Open Library, Wikidata and dump-set staging resume the same generation', async () => {
  const r = await runCompressedStagingResumeJourney();
  try {
    expect(r.sources.map((s) => s.name)).toEqual(['openlibrary', 'wikidata', 'dump-set']);
    for (const s of r.sources) {
      expect(s.interrupted.code).toBe(130);
      expect(s.interrupted.stderr).toContain('--resume-staging');
      expect(s.prefixConversions).toBeGreaterThan(0);
      expect(s.resumeConversions).toBeLessThan(s.totalRecords);
      expect(s.preSealNative).toBe(0);
      expect(s.resumed.code).toBe(0);
    }
  } finally {
    await r.close();
  }
}, 1_800_000);
