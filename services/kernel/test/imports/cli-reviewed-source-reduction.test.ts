import { expect, test } from 'bun:test';
import { runReviewedProviderReduction } from './cli-reviewed-source-reduction-fixture.ts';

test('ordinary operator reviews VNDB Open Library and Wikidata reductions without deleting communal subjects or other source state', async () => {
  const r = await runReviewedProviderReduction();
  try {
    expect(r.sources.map((s) => s.source).sort()).toEqual(['openlibrary', 'vndb', 'wikidata']);
    for (const source of r.sources) {
      expect(source.initial.code).toBe(0);
      expect(source.initialBaseline.records).toBe(5);
      expect(source.stopped.code).toBe(3);
      expect(source.stopWrites).toEqual([]);
      expect(source.baselineAfterStop).toEqual(source.initialBaseline);
      expect(source.reviewed.code).toBe(0);
      expect(source.reviewedBaseline.records).toBe(3);
      expect(source.removedExternalIds).toHaveLength(2);
      expect(source.nativeRetractionReceipts.length).toBeGreaterThan(0);
      expect(source.subjectIdsAfter).toEqual(source.subjectIdsBefore);
      expect(source.communitySelectionAfter).toEqual(source.communitySelectionBefore);
      expect(source.unrelatedSourcesAfter).toEqual(source.unrelatedSourcesBefore);
      expect(source.originalBootstrapAfter).toEqual(source.originalBootstrapBefore);
      expect(source.unchanged.code).toBe(0);
      expect(source.unchangedWrites).toEqual([]);
      expect(source.lossAll.code).toBe(3);
      expect(source.lossAllWrites).toEqual([]);
      expect(source.baselineAfterLossAll).toEqual(source.reviewedBaseline);
      expect(source.revokedReplay.status).toBe(403);
      expect(source.revokedReplay.storedSuccess).toBeNull();
      expect(source.openHandlesAtEnd).toBe(0);
    }
  } finally {
    await r.close();
  }
}, 1_800_000);
