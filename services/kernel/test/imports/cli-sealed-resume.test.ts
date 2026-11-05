import { expect, test } from 'bun:test';
import { runSealedResumeJourney } from './cli-sealed-resume-fixture.ts';

test('operator resumes a sealed generation without its original dump through native delivery and current authority', async () => {
  const r = await runSealedResumeJourney();
  try {
    expect(r.sources.map((s) => s.source).sort()).toEqual(['vndb', 'wikidata']);
    for (const s of r.sources) {
      expect(s.originalBytes.length).toBeGreaterThan(0);
      expect(s.denied).toBe(4);
      expect(s.resumed).toBe(0);
      expect(s.inputPasses).toBe(0);
      expect(s.consumed).toBe(0);
      expect(s.candidates.length).toBeGreaterThan(0);
    }
  } finally {
    await r.close();
  }
}, 1_800_000);
