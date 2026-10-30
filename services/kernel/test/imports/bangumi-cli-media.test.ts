import { expect, test } from 'bun:test';
import { runBangumiMediaCliJourney } from './bangumi-cli-media-fixture.ts';

test('Bangumi licensed summary and cover CLI lifecycle', async () => {
  const r = await runBangumiMediaCliJourney();
  try {
    expect(r.initial.code).toBe(0);
    expect(r.unchanged.code).toBe(0);
    expect(r.refreshed.code).toBe(0);
    expect(r.initialSummary.licence).toBe('CC-BY-SA-3.0');
    expect(r.initialSummary.text).toContain(r.summarySentinel);
    expect(r.cover.row.state).toBe('available');
    expect(r.cover.row.purpose).toBe('cover');
    expect(r.cover.row.credit.rightsHolder).toContain('rights holder');
    expect(r.cover.original).not.toEqual(r.sourceBytes);
    expect(r.cover.variants.length).toBeGreaterThan(0);
    expect(r.refreshedCover.row.id).not.toBe(r.cover.row.id);
    expect(r.refreshedCover.original).not.toEqual(r.cover.original);
    expect(r.unchangedWrites).toEqual([]);
    expect(r.fencedRefresh.code).toBe(0);
    expect(r.fencedReopen.code).toBe(0);
    expect(r.afterFenceSourceRequests).toEqual([]);
    expect(r.disclosedCoverAfterFence).toBeNull();
    expect(r.originalBootstrapAfter).toEqual(r.originalBootstrapBefore);
    expect(r.independentMetadataAfter).toEqual(r.independentMetadataBefore);
    expect(r.nativeWriteReceipts.length).toBeGreaterThan(0);
  } finally {
    await r.close();
  }
}, 1_800_000);
