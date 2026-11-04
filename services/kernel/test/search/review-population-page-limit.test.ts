import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { createDefaultDiscoveryOwnerAdapters } from '../../src/search/default-discovery.ts';
import { REVIEW_DISCOVERY_PAGE_LIMIT } from '../../src/content/review-discovery.ts';

test('mixed population respects the Review owner page bound and keeps its signed continuation', async () => {
  const after = { route: 0, id: '00000000-0000-8000-8000-000000000001' };
  const adapters = createDefaultDiscoveryOwnerAdapters({
    pool: {} as Pool,
    routeKey: new Uint8Array(32),
    access: {} as never,
    reviewSource: {
      pageWithCut: async (partition: number, cursor: unknown, limit: number) => {
        expect(partition).toBe(0);
        expect(cursor).toEqual({ ...after, token: 'signed-cut' });
        expect(limit).toBe(REVIEW_DISCOVERY_PAGE_LIMIT);
        return { state: 'ready', partition, position: 0n, reviews: [], next: null };
      },
    } as never,
  });
  expect(await adapters.metadataProducers.review!.page(0, after, 'signed-cut', 100)).toMatchObject({
    records: [],
    next: null,
    continuation: null,
  });
});
