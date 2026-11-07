import { expect, test } from 'bun:test';
import { createSearchApplication } from '../src/search/search-application';
import { searchLoaderDeps } from '../src/search/search-params';
import { searchSessionLifetime } from '../src/search/scoped-search-lifetime';

const application = createSearchApplication({
  createClient: () => {
    throw new Error('The query identity and recovery projection do not read Kernel.');
  },
  readRelease: async () => {
    throw new Error('The query identity and recovery projection do not read definitions.');
  },
  requestLanguages: () => ['en'],
});

test('Search shares its query identity and pending/recovery page pair across the adapter and observer', () => {
  const params = searchLoaderDeps({ q: 'Mira', language: ['ja', 'en'] });
  expect(application.queryKey('en', params)).toEqual(['search', 'discovery-v1', searchSessionLifetime('en', params)]);
  expect(application.loadingPage(params)).toMatchObject({ queryState: params, recovery: { status: 'loading' } });
  expect(application.unavailablePage(params)).toMatchObject({
    queryState: params,
    recovery: { status: 'unavailable' },
    selectedFacets: params.facets,
  });
});
