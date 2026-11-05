import { expect, test } from 'bun:test';
import { runConcurrentCliOwnersJourney } from './concurrent-cli-owners-fixture.ts';

test('Concurrent ordinary CLI source ownership and isolation', async () => {
  const r = await runConcurrentCliOwnersJourney();
  try {
    expect(r.sameSourceCompetitor.code).toBe(5);
    expect(r.competitorAuthRequests).toEqual([]);
    expect(r.competitorPublicWrites).toEqual([]);
    expect(r.independent.code).toBe(0);
    expect(r.independentBaseline.records).toBeGreaterThan(0);
    expect([1, 130]).toContain(r.cancelledOwner.code);
    expect(r.recoveredOwner.code).toBe(0);
    expect(r.sourceA).not.toBe(r.sourceB);
    expect(r.sourceAClaim).not.toBe(r.sourceBClaim);
    expect(r.sourceARelation).toBe(r.sourceAWork);
    expect(r.sourceBRelation).toBe(r.sourceBWork);
    expect(r.sourceAWork).not.toBe(r.sourceBWork);
    expect(r.sourceBAfter).toEqual(r.sourceBBefore);
    expect(r.foreignReceiptDisclosures).toEqual([]);
    expect(r.fencedSourceVisibleValues).toEqual([]);
    expect(r.unfencedSourceVisibleValues.length).toBeGreaterThan(0);
    expect(r.openHandlesAtEnd).toBe(0);
  } finally {
    await r.close();
  }
}, 1_800_000);
