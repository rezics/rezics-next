import { expect, test } from 'bun:test';
import { runStagingResumeJourney } from './cli-staging-resume-fixture.ts';

test('checkpointed Open Library and Wikidata staging resumes the same generation and finishes ordinary native selection', async () => {
  const r = await runStagingResumeJourney();
  try {
    expect(r.sources.map((s) => s.source).sort()).toEqual(['openlibrary', 'wikidata']);
    for (const s of r.sources) {
      expect(s.interrupted.code).toBe(130);
      expect(s.interrupted.stderr).toContain('--resume-staging');
      expect(s.prefixConversions).toBeGreaterThan(0);
      expect(s.resumeConversions).toBeLessThan(s.totalRecords);
      expect(s.preSealNative).toBe(0);
      expect(s.resumed.code).toBe(0);
      expect(s.subjectIds.length).toBeGreaterThan(0);
    }
  } finally {
    await r.close();
  }
}, 1_800_000);
