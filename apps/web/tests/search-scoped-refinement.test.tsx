import { describe, expect, test } from 'bun:test';
import type { FilterDocument } from '@rezics/filter';
import { facetRequest, readFacetPage, refinementKey } from '../src/search/refinement/request';
import { scopedRefinementRequests } from '../src/search/refinement/scoped-refinement';
import { FacetContinuationLedger } from '../src/search/refinement/facet-continuation';
import type { SearchLoaderDeps } from '../src/search/search-params';

const realm = { kind: 'realm', id: '5a522c45-d94f-4d36-8b2a-3af80d988cff' } as const;
const collection = { kind: 'collection', id: '438cb7b1-e7a2-4a40-831e-a90b1b143264' } as const;
const as_of = '2026-11-03T08:00:00.000Z';

const current: SearchLoaderDeps = {
  query: 'maps',
  type: 'ex:Book',
  facets: { 'ex:language': ['en'] },
  ranges: { 'ex:pages': { gte: 100, unit: 'page' } },
  condition: { not: { type: { in: ['ex:Film'] } } } as FilterDocument,
  cursor: 'result-page-token',
  sort: 'rating',
  kinds: ['ex:Book'],
  languages: ['ja', 'en'],
  filter: JSON.stringify({ statement: { property: 'ex:series', in: ['atlas'] } }),
  resourceScope: realm,
};

describe('scoped Search refinement', () => {
  test('Realm and Collection reads and each value page keep one full predicate and native order', async () => {
    for (const resourceScope of [realm, collection]) {
      const first = scopedRefinementRequests(
        { ...current, resourceScope },
        ['en'],
        [{ property: 'ex:author', size: 2 }],
      );
      expect(first.search.text).toBe('maps');
      expect(first.search.languages).toEqual(['ja', 'en']);
      expect(first.search.filter).toMatchObject({ and: expect.any(Array) });
      const serialized = JSON.stringify(first.search.filter);
      for (const value of [
        resourceScope.kind,
        resourceScope.id,
        'ex:series',
        'atlas',
        'ex:Book',
        'ex:language',
        'ex:pages',
        'page',
        'ex:Film',
      ])
        expect(serialized).toContain(value);
      expect(first.facets).toEqual({
        text: first.search.text,
        filter: first.search.filter,
        languages: first.search.languages,
        facets: [{ property: 'ex:author', size: 2 }],
      });

      const continuation = facetRequest(
        { text: first.search.text, filter: first.search.filter, languages: first.search.languages },
        [{ property: 'ex:author', size: 2, cursor: 'native-next' }],
      );
      const calls: unknown[] = [];
      const state = await readFacetPage(continuation, async (body) => {
        calls.push(body);
        return {
          status: 200,
          data: {
            facets: [{ property: 'ex:author', values: [{ value: 'id-2', labels: { en: 'B' } }], next: null }],
            as_of,
          },
        };
      });
      expect(calls).toEqual([continuation]);
      expect(state).toMatchObject({
        status: 'ready',
        page: { facets: [{ values: [{ value: 'id-2' }], next: null }] },
      });
      expect(JSON.stringify(state)).not.toMatch(/count|total|estimate/);
    }
  });

  test('empty terminal, withheld, preparing, invalid and restart outcomes stay distinct', async () => {
    const request = facetRequest({}, [{ property: 'ex:author', size: 10 }]);
    const absent = await readFacetPage(request, async () => ({
      status: 200,
      data: { facets: [{ property: 'ex:author', values: [], next: null }], as_of },
    }));
    expect(absent).toMatchObject({ status: 'ready', page: { facets: [{ values: [], next: null }] } });

    const counted = await readFacetPage(request, async () => ({
      status: 200,
      data: { facets: [{ property: 'ex:author', values: [], next: null, count: 0 }], as_of },
    }));
    expect(counted).toMatchObject({ status: 'invalid', code: 'invalid_facet_response' });
    for (const [status, code, expected] of [
      [503, 'coverage_withheld', 'withheld'],
      [503, 'index_not_ready', 'preparing'],
      [400, 'invalid_request', 'invalid'],
      [409, 'search_restart_required', 'restart'],
    ] as const) {
      expect(await readFacetPage(request, async () => ({ status, error: { code } }))).toMatchObject({
        status: expected,
        code,
      });
    }
  });

  test('owner, scope, predicate edits and retry retire the old bounded continuation ledger', () => {
    const owner = {
      principal: '["signed-in","reader-a"]',
      languages: ['ja', 'en'],
      release: 'release-1',
      source: `realm:${realm.id}`,
      scope: realm,
      text: 'maps',
      filter: { statement: { property: 'ex:series', in: ['atlas'] } } as FilterDocument,
    };
    const identity = refinementKey(owner);
    expect(refinementKey({ ...owner, principal: '["signed-in","reader-b"]' })).not.toBe(identity);
    expect(refinementKey({ ...owner, source: `collection:${collection.id}`, scope: collection })).not.toBe(identity);
    expect(refinementKey({ ...owner, filter: { type: { in: ['ex:Book'] } } })).not.toBe(identity);

    const ledger = new FacetContinuationLedger(identity);
    ledger.retain(['ex:author']);
    ledger.consume('ex:author', 'opaque-a');
    expect(ledger.has('ex:author', 'opaque-a')).toBe(true);
    ledger.reset('ex:author');
    expect(ledger.has('ex:author', 'opaque-a')).toBe(false);
    const changedOwner = new FacetContinuationLedger(refinementKey({ ...owner, scope: collection }));
    changedOwner.retain(['ex:author']);
    expect(changedOwner.has('ex:author', 'opaque-a')).toBe(false);
  });
});
