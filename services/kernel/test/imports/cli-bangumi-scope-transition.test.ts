import { expect, test } from 'bun:test';
import { runJourney } from './cli-bangumi-scope-transition-fixture.ts';

test('ordinary Bangumi CLI preserves complete membership and native identity across supported ignored and supported input transitions', async () => {
  const r = await runJourney();
  try {
    for (const run of [r.initial, r.music, r.liveAction, r.returned, r.unchanged]) expect(run.code).toBe(0);
    expect(r.presentCounts).toEqual([5, 5, 5, 5]);
    expect(r.skippedCounts).toEqual([2, 3, 3, 2]);
    expect(r.subjectIdsAfter).toEqual(r.subjectIdsBefore);
    expect(r.bootstrapAfter).toEqual(r.bootstrapBefore);
    expect(r.originalReceiptsAfter).toEqual(r.originalReceiptsBefore);
    expect(r.retractionReceipts.length).toBeGreaterThan(0);
    expect(r.oldOwnedCandidates.every((c) => c.retracted !== null)).toBe(true);
    expect(r.ignoredCreatesAndProposals).toEqual([]);
    expect(r.ignoredMediaRequests).toEqual([]);
    expect(r.retainedPrivateMarkers).toEqual([]);
    expect(r.returnedProposals.length).toBeGreaterThan(0);
    expect(r.returnedProposals.every((c) => c.source.converter_revision === 'bangumi@3')).toBe(true);
    expect(r.returnedCandidateIds.some((id) => r.oldCandidateIds.includes(id))).toBe(false);
    expect(r.independentSelectionAfter).toEqual(r.independentSelectionBefore);
    expect(r.unchangedWrites).toEqual([]);
  } finally {
    await r.close();
  }
}, 1_800_000);
