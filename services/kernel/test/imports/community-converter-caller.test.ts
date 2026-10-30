import { expect, test } from 'bun:test';
import { runJourney } from './community-converter-caller-fixture.ts';

test('a community caller uses each public pure converter export and real public bulk identities independently of the platform importer', async () => {
  const r = await runJourney();
  try {
    expect(r.sources.map((s) => s.source).sort()).toEqual(['bangumi', 'openlibrary', 'vndb', 'wikidata']);
    for (const s of r.sources) {
      expect(s.createdId).toBe(s.boundTargetId);
      expect(s.nativeSubject.id).toBe(s.createdId);
      expect(s.nativeCandidates.length).toBeGreaterThan(0);
      expect(s.nativeCandidates.every((c) => c.source?.converter_revision === s.converterRevision)).toBe(true);
      expect(s.citedSelectedFacts.length).toBeGreaterThan(0);
      expect(s.inputAfter).toEqual(s.inputBefore);
      expect(s.replayReceiptsAfter).toEqual(s.replayReceiptsBefore);
      expect(s.duplicateEffects).toEqual([]);
    }
    expect(r.revokedReplay.status).toBe(403);
    expect(r.revokedReplay.storedSuccess).toBeNull();
  } finally {
    await r.close();
  }
}, 1_800_000);
