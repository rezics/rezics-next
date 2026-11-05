import { expect, test } from 'bun:test';
import { runJourney } from './cli-source-reappearance-fixture.ts';

test('ordinary CLI reappears after a bounded removal without replacing native subjects or bypassing a new fence', async () => {
  const r = await runJourney();
  try {
    expect(r.sources.map((s) => s.source).sort()).toEqual(['bangumi', 'openlibrary', 'vndb', 'wikidata']);
    for (const s of r.sources) {
      for (const run of [s.initial, s.removed, s.returned, s.removedAgain, s.fencedReturn, s.unchanged])
        expect(run.code).toBe(0);
      expect(s.counts).toEqual([5, 4, 5, 4, 5]);
      expect(s.returnedSubjectId).toBe(s.originalSubjectId);
      expect(s.bootstrapAfter).toEqual(s.bootstrapBefore);
      expect(s.originalReceiptsAfter).toEqual(s.originalReceiptsBefore);
      expect(s.removalReceipts.length).toBeGreaterThan(0);
      expect(s.oldOwnedCandidates.every((c) => c.retracted !== null)).toBe(true);
      expect(s.newNativeProposals.length).toBeGreaterThan(0);
      expect(s.newNativeProposals.every((c) => c.source.external_id === s.returnedExternalId)).toBe(true);
      expect(s.fencedFactsWrites).toEqual([]);
      expect(s.disclosedFencedFacts).toEqual([]);
      expect(s.independentSelectionAfter).toEqual(s.independentSelectionBefore);
      expect(s.otherSourceStateAfter).toEqual(s.otherSourceStateBefore);
      expect(s.unchangedWrites).toEqual([]);
    }
  } finally {
    await r.close();
  }
}, 1_800_000);
