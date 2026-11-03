import { expect, test } from 'bun:test';
import type { SearchLoaderDeps } from '../src/search/search-params';
import { scopedRefinementRequests } from '../src/search/refinement/scoped-refinement';

const scope = { kind: 'collection', id: '438cb7b1-e7a2-4a40-831e-a90b1b143264' } as const;

test('scoped refinements send the same complete predicate with the additive scope binding', () => {
  const state: SearchLoaderDeps = {
    query: 'maps',
    type: undefined,
    facets: {},
    cursor: undefined,
    sort: undefined,
    filter: JSON.stringify({ statement: { property: 'schema:genre', in: ['maps'] } }),
    resourceScope: scope,
  };
  const { search, facets } = scopedRefinementRequests(state, ['ja', 'en'], [{ property: 'schema:author', size: 10 }]);

  expect(facets).toEqual({
    text: 'maps',
    filter: search.filter,
    conditions: search.filter,
    scope,
    languages: ['ja', 'en'],
    facets: [{ property: 'schema:author', size: 10 }],
  });
  expect(JSON.stringify(facets?.conditions)).toContain(scope.id);
});
