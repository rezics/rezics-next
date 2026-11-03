import { expect, test } from 'bun:test';
import { searchLoaderDeps } from '../src/search/search-params';
import { searchRequiresCurrentReader, searchSessionLifetime } from '../src/search/scoped-search-lifetime';
import { searchSessionOwner } from '../src/search/search-session-owner';
import { refinementKey } from '../src/search/refinement/request';

const realmId = '5a522c45-d94f-4d36-8b2a-3af80d988cff';
const otherRealmId = '438cb7b1-e7a2-4a40-831e-a90b1b143264';

test('session-bound Search lifetime includes the principal, complete basis, locale and read mode', () => {
  const publicState = searchLoaderDeps({ q: 'maps' });
  const realmState = searchLoaderDeps({ q: 'maps', ratingPopulation: realmId, sort: 'rating' });
  const scopedState = searchLoaderDeps({ q: 'maps', filter: JSON.stringify({ realm: { id: realmId } }) });

  expect(searchRequiresCurrentReader(publicState)).toBe(false);
  expect(searchRequiresCurrentReader(realmState)).toBe(true);
  expect(searchRequiresCurrentReader(scopedState)).toBe(true);
  const ownerA = searchSessionLifetime('en', realmState, '["signed-in","reader-a"]');
  expect(ownerA).not.toBe(searchSessionLifetime('en', realmState, '["signed-in","reader-b"]'));
  expect(ownerA).not.toBe(searchSessionLifetime('zh-Hans', realmState, '["signed-in","reader-a"]'));
  expect(ownerA).not.toBe(
    searchSessionLifetime(
      'en',
      searchLoaderDeps({ q: 'maps', ratingPopulation: otherRealmId, sort: 'rating' }),
      '["signed-in","reader-a"]',
    ),
  );
  expect(ownerA).not.toBe(
    searchSessionLifetime('en', searchLoaderDeps({ q: 'maps', ratingPopulation: realmId }), '["signed-in","reader-a"]'),
  );
  expect(searchSessionLifetime('en', publicState, '["signed-in","reader-a"]')).toBe(
    searchSessionLifetime('en', publicState, '["signed-in","reader-b"]'),
  );
});

test('uncertain session state has no owner and facet continuation identity changes with rating basis', () => {
  expect(searchSessionOwner({ state: 'signed-in', subject: 'reader-a' })).toBe('["signed-in","reader-a"]');
  expect(searchSessionOwner({ state: 'signed-out', subject: null })).toBe('["signed-out"]');
  expect(searchSessionOwner({ state: 'unknown', subject: null })).toBeNull();

  const base = {
    principal: '["signed-in","reader-a"]',
    languages: ['en'],
    release: 'release-a',
    source: 'public-global',
    text: 'maps',
  };
  const identity = refinementKey({ ...base, ratingPopulation: realmId, sort: 'rating', mode: 'personal' });
  expect(refinementKey({ ...base, ratingPopulation: otherRealmId, sort: 'rating', mode: 'personal' })).not.toBe(
    identity,
  );
  expect(refinementKey({ ...base, ratingPopulation: realmId, sort: 'relevance', mode: 'personal' })).not.toBe(identity);
  expect(refinementKey({ ...base, ratingPopulation: realmId, sort: 'rating', mode: 'public-anonymous' })).not.toBe(
    identity,
  );
});
