import { expect, test } from 'bun:test';
import type { SearchLoaderDeps } from '../src/search/search-params';
import { scopedRefinementRequests } from '../src/search/refinement/scoped-refinement';

const scope = { kind: 'collection', id: '438cb7b1-e7a2-4a40-831e-a90b1b143264' } as const;

test('scoped refinements keep semantic conditions and result kinds bound beside the native scope', () => {
  const state: SearchLoaderDeps = {
    query: 'maps',
    type: 'schema:Book',
    facets: { 'schema:author': ['writer-1'] },
    cursor: undefined,
    sort: undefined,
    filter: JSON.stringify({ statement: { property: 'schema:genre', in: ['maps'] } }),
    resourceScope: scope,
    kinds: ['schema:Book', 'collection'],
  };
  const { search, facets } = scopedRefinementRequests(state, ['ja', 'en'], [{ property: 'schema:author', size: 10 }]);

  expect(facets).toEqual({
    text: 'maps',
    filter: {
      and: [
        { statement: { property: 'schema:genre', in: ['maps'] } },
        { type: { in: ['schema:Book'] } },
        { statement: { property: 'schema:author', in: ['writer-1'] } },
      ],
    },
    conditions: {
      and: [
        { statement: { property: 'schema:genre', in: ['maps'] } },
        { type: { in: ['schema:Book'] } },
        { statement: { property: 'schema:author', in: ['writer-1'] } },
      ],
    },
    scope,
    kinds: ['schema:Book', 'collection'],
    languages: ['ja', 'en'],
    facets: [{ property: 'schema:author', size: 10 }],
  });
  expect(JSON.stringify(search.filter)).toContain(scope.id);
  expect(JSON.stringify(facets?.conditions)).not.toContain(scope.id);
  expect(facets?.conditions).not.toEqual(search.filter);
});

test('discovery-only filter clauses stay in results and prevent an incomplete facet request', () => {
  const filter = { and: [{ kind: { in: ['collection'] } }, { statement: { property: 'schema:genre', in: ['maps'] } }] };
  const state: SearchLoaderDeps = {
    query: 'maps',
    type: undefined,
    facets: {},
    cursor: undefined,
    sort: undefined,
    filter: JSON.stringify(filter),
  };
  const result = scopedRefinementRequests(state, ['en'], [{ property: 'schema:author', size: 10 }]);

  expect(result.search.filter).toEqual({ and: [filter] });
  expect(result.facets).toBeUndefined();
});
