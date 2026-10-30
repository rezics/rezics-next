import { expect, test } from 'bun:test';
import { runJourney } from './vndb-zero-refresh-fixture.ts';

test('ordinary VNDB alias publication and clear preserve exact tuple fences and the current single-slot association', async () => {
  const journey = await runJourney();
  try {
    const r = await journey.aliasJourney();
    expect(r.positiveBody).toEqual({
      sourceAlias: 'feed-two',
      sourceRecordId: 'v123',
      scale: { min: 1, max: 10 },
      mean: 7,
      count: 2,
      asOf: '2026-10-25',
      licence: 'ODbL-1.0',
      attribution: 'VNDB',
    });
    expect(r.clear.status).toBe(204);
    expect(r.clear.body).toEqual({ sourceAlias: 'feed-two', sourceRecordId: 'v123', count: 0, asOf: '2026-10-25' });
    expect(r.clear.receipt).not.toBeNull();
    expect(r.afterZero).toEqual([]);
    expect(r.beforeMismatch).toHaveLength(1);
    expect(r.afterStaleClear).toEqual(r.otherAssociation);
    expect(r.beforeCanonicalFence).toHaveLength(1);
    expect(r.afterCanonicalFence).toEqual(r.beforeCanonicalFence);
    expect(r.afterAliasFence).toEqual([]);
    expect(r.fencedStatisticRequests).toEqual([]);
    expect(r.fencedClear.status).toBe(204);
    expect(r.fencedClear.body).toEqual(r.clear.body);
    expect(r.fencedClear.receipt).not.toBeNull();
    expect(r.independentAfter).toEqual(r.independentBefore);
  } finally {
    await journey.close();
  }
}, 1_800_000);
