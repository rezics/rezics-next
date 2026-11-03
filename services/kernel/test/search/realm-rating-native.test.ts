import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { createRealmRatingNativeSource } from '../../src/search/realm-rating-native.ts';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import type { RealmRatingQuery } from '../../src/search/realm-rating-order.ts';

const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };

test('missing live Realm authority fails closed before empty or unscored traversal', async () => {
  const source = createRealmRatingNativeSource({
    pool: {} as Pool,
    search: {} as OpenSearch,
    prefix: 'realm-',
    tokens: ring,
  });
  const query: RealmRatingQuery = {
    principal: 'anonymous',
    populationId: '018f0000-0000-7000-8000-00a000000900',
    release: undefined,
    meaningDigest: undefined,
    text: undefined,
    filter: undefined,
    deadline: Date.now() + 10_000,
  };
  await expect(source.observe(query)).rejects.toMatchObject({ code: 'index_not_ready' });
  await expect(source.readScoredFrontiers(query, {} as never, { size: 20 })).rejects.toMatchObject({
    code: 'index_not_ready',
  });
  await expect(source.readUnscored(query, {} as never, { size: 20 })).rejects.toMatchObject({
    code: 'index_not_ready',
  });
});
