import { expect, test } from 'bun:test';
import { createRealmRatingNativeSource } from '../../src/search/realm-rating-native.ts';
import type { RealmRatingQuery } from '../../src/search/realm-rating-order.ts';

test('missing complete native order refuses observation and reads instead of classifying unscored', async () => {
  const source = createRealmRatingNativeSource();
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
  // A direct read cannot turn missing observation into an empty successful page.
  await expect(source.read(query, {} as never, { size: 20 })).rejects.toMatchObject({ code: 'index_not_ready' });
});
