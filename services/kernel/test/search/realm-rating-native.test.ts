import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { createRealmRatingNativeSource } from '../../src/search/realm-rating-native.ts';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import type { RealmRatingQuery } from '../../src/search/realm-rating-order.ts';
import type { Access } from '../../src/request/access.ts';

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

test('selected Realm stays unavailable with live authority until canonical predicate/order execution is delivered', async () => {
  const unexpected = () => {
    throw new Error('Partial native or Global execution must not run');
  };
  const source = createRealmRatingNativeSource({
    pool: { query: unexpected, connect: unexpected } as unknown as Pool,
    search: { request: unexpected } as unknown as OpenSearch,
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
    authority: { actor: { kind: 'anonymous' }, access: {} as Access },
  };
  for (const read of [
    () => source.observe(query),
    () => source.readScoredFrontiers(query, {} as never, { size: 20 }),
    () => source.readUnscored(query, {} as never, { size: 20 }),
  ])
    await expect(read()).rejects.toMatchObject({ code: 'index_not_ready', headers: { 'retry-after': '1' } });
});
