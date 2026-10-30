import { expect, test } from 'bun:test';
import { runJourney } from './vndb-zero-refresh-fixture.ts';

test('ordinary VNDB zero-vote refresh clears only its exact stale imported statistic and resumes safely', async () => {
  const r = await runJourney();
  try {
    expect(r.initial.code).toBe(0);
    expect(r.zero.code).toBe(0);
    expect(r.clear.status).toBe(204);
    expect(r.clear.body).toEqual({ sourceRecordId: r.sourceRecordId, count: 0, asOf: r.asOf });
    expect(r.publicAfterZero).toEqual([]);
    expect(r.unchanged.code).toBe(0);
    expect(r.unchangedStatisticRequests).toEqual([]);
    expect(r.zeroMean.code).toBe(0);
    expect(r.publicAfterZeroMean).toEqual([]);
    expect(r.unknownStatisticRequests).toEqual([]);
    expect(r.publicAfterUnknown).toEqual(r.positiveBeforeUnknown);
    expect(r.malformedPair.status).toBe('invalid-dump');
    expect(r.originalSubjectAfter).toBe(r.originalSubjectBefore);
    expect(r.originalSemanticReceiptsAfter).toEqual(r.originalSemanticReceiptsBefore);
    expect(r.lostResponse.completedBaseline).toEqual(r.beforeLostResponseBaseline);
    expect(r.resumed.code).toBe(0);
    expect(r.resumedClearBytes).toEqual(r.pendingClearBytes);
    expect(r.resumedClearKeys).toEqual(r.pendingClearKeys);
    expect(r.clearNativeEffectCount).toBe(1);
    expect(r.revokedReplay.status).toBe(403);
    expect(r.revokedReplay.storedSuccess).toBeNull();
    expect(r.independentAfter).toEqual(r.independentBefore);
    expect(r.nativeVotesAndFigureAfter).toEqual(r.nativeVotesAndFigureBefore);
    expect(r.duplicateCandidateEffects).toEqual([]);
  } finally {
    await r.close();
  }
}, 1_800_000);
