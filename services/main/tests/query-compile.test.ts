import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import type { ResourceQuery } from '../../../model/definitions/filter-document-v1.ts';
import type { ResourceQuery as ResourceQueryV2 } from '../../../model/definitions/filter-document-v2.ts';
import { conceptMembership } from '../src/modules/concept-page/read.ts';
import { compileQuery, QueryRejected } from '../src/modules/query/compile.ts';
import { combineConcepts, pageConcepts, type CompleteSearch } from '../src/modules/query/concept-set.ts';
import { queryRoutes, resourceQueryV1, resourceQueryV2 } from '../src/routes/query.ts';

const id = (n: number) => `https://rezics.com/id/019d0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const book = 'https://schema.org/Book', recipe = 'https://schema.org/Recipe';
const base: ResourceQuery = { context: 'global', scope: { kind: 'all' },
  text: { phrase: 'pride and prejudice' }, sort: 'relevance', page: { size: 20 } };

test('Query: sparse and empty Filters compile to the same bounded phrase template', () => {
  const sparse = compileQuery(base), empty = compileQuery({ ...base, filter: { all: [] } });
  expect(empty).toEqual(sparse);
  expect(sparse).toMatchObject({ template: 'search', request: {
    profile: 'public-main-phrase-page-v1', phrase: 'pride and prejudice', language: null, pageSize: 20 },
  });
});

test('Query: type include/exclude and language compile onto the exact search selectors', () => {
  expect(compileQuery({ ...base, filter: { all: [
    { facet: 'type', any: [book] }, { facet: 'type', none: [recipe] },
    { facet: 'language', any: ['en'] },
  ] } })).toMatchObject({ template: 'search', request: {
    includeTypes: [book], excludeTypes: [recipe], language: 'en',
  }, graphReads: 2 });
});

test('Query: a Concept Condition binds its exact revision before classified search', () => {
  expect(compileQuery({ ...base, context: { realm: id(1) }, filter: { all: [
    { facet: 'concept', any: [id(2)], interpretation: { definition: id(3) } },
  ] } })).toMatchObject({ template: 'search', concept: { value: id(2), revision: id(3) },
    request: { profile: 'public-realm-classified-phrase-page-v1', context: { kind: 'realm-local', id: id(1) } },
  });
});

test('Query: include and exclude Concepts compile to a bounded complete-set template', () => {
  const query: ResourceQuery = { ...base, filter: { all: [
    { facet: 'concept', any: [id(2)], interpretation: { definition: id(3) } },
    { facet: 'concept', none: [id(4)], interpretation: { definition: id(5) } },
  ] } };
  expect(compileQuery(query)).toMatchObject({ template: 'search-concepts', graphReads: 6,
    concepts: [{ operator: 'include', value: id(2), revision: id(3) },
      { operator: 'exclude', value: id(4), revision: id(5) }],
    request: { profile: 'public-main-phrase-v1', phrase: 'pride and prejudice' },
  });
});

const relation = (names: number[]): CompleteSearch => ({ resultGrain: 'mainVersion', complete: true,
  context: 'main-version-default', population: 10, total: names.length,
  results: names.map(n => ({ work: id(n), mainVersion: id(n + 100) })),
  sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '4' }, indexGeneration: 'index-1' });

test('Query: Concept include/exclude filters the complete grain before the final page', () => {
  const baseRelation = relation([1, 2, 3, 4]);
  const selected = combineConcepts(baseRelation, [
    { operator: 'include', relation: relation([1, 2, 3]) },
    { operator: 'exclude', relation: relation([2]) },
  ]);
  expect(selected.map(row => row.work)).toEqual([id(1), id(3)]);
  const query: ResourceQuery = { ...base, page: { size: 1 }, filter: { all: [
    { facet: 'concept', any: [id(7)], interpretation: { definition: id(8) } },
    { facet: 'concept', none: [id(9)], interpretation: { definition: id(10) } },
  ] } };
  const first = pageConcepts(query, baseRelation, selected, [id(8), id(10)], 'a'.repeat(64), 1000);
  expect(first.results.map(row => row.work)).toEqual([id(1)]);
  expect(first.next).not.toBeNull();
  const second = pageConcepts({ ...query, page: { size: 1, continuation: first.next } },
    baseRelation, selected, [id(8), id(10)], 'a'.repeat(64), 1001);
  expect(second.results.map(row => row.work)).toEqual([id(3)]);
  expect(second.next).toBeNull();
  expect(() => pageConcepts({ ...query, page: { size: 1, continuation: first.next } },
    baseRelation, selected, [id(8), id(10)], 'b'.repeat(64), 1001)).toThrow(QueryRejected);
  expect(() => pageConcepts({ ...query, page: { size: 1, continuation: first.next } },
    baseRelation, selected, [id(8), id(11)], 'a'.repeat(64), 1001)).toThrow(QueryRejected);
  expect(() => pageConcepts({ ...query, page: { size: 1, continuation: first.next } },
    { ...baseRelation, sourcePosition: { ...baseRelation.sourcePosition, sequence: '5' } },
    selected, [id(8), id(10)], 'a'.repeat(64), 1001)).toThrow(QueryRejected);
});

test('Query: Concept relations from different index or graph generations are refused', () => {
  const different = { ...relation([1]), indexGeneration: 'index-2' };
  expect(() => combineConcepts(relation([1]), [{ operator: 'include', relation: different }]))
    .toThrow(QueryRejected);
});

test('Query: Realm scope compiles onto the bounded Zone population, not the Realm search Context', () => {
  expect(compileQuery({ context: { realm: id(1) }, scope: { kind: 'realm', realm: id(1) },
    text: { phrase: 'Pride' }, sort: 'relevance', page: { size: 20 }, filter: { all: [
      { facet: 'type', any: [book] }, { facet: 'concept', any: [id(2)] },
    ] } })).toMatchObject({ template: 'zone-browse', realm: id(1),
    request: { q: 'Pride', sort: 'relevance', limit: 20, type: [book], concept: [id(2)] } });
});

test('Query: unsupported boolean and type combinations are typed refusals', () => {
  const refusals: ResourceQuery['filter'][] = [
    { any: [{ facet: 'type', any: [book] }, { facet: 'type', any: [recipe] }] },
    { all: [{ facet: 'type', all: [book, recipe] }] },
  ];
  for (const filter of refusals) {
    expect(() => compileQuery({ ...base, filter })).toThrow(QueryRejected);
    try { compileQuery({ ...base, filter }); }
    catch (error) { expect((error as QueryRejected).refusal).toBe('unsupported_query_shape'); }
  }
});

test('Query: two rating thresholds never collapse into one template selector', () => {
  const rating = (context: string) => ({ facet: 'rating', bind: { ratingContext: context },
    range: { min: '7.0' } });
  expect(() => compileQuery({ ...base, context: { realm: id(1) }, filter: { all: [
    { facet: 'concept', any: [id(2)], interpretation: { definition: id(3) } },
    rating(id(4)), rating(id(5)),
  ] } })).toThrow(QueryRejected);
});

test('Query: admission refuses unsupported sources, depth and graph-read budget before execution', () => {
  expect(() => compileQuery({ ...base, sourcePolicy: { kind: 'multi-dataset', datasetIds: ['a', 'b'] } }))
    .toThrow(QueryRejected);
  const nested = { all: [{ all: [{ all: [{ all: [{ all: [
    { facet: 'type', any: [book] },
  ] }] }] }] }] } as ResourceQuery['filter'];
  expect(() => compileQuery({ ...base, filter: nested })).toThrow(QueryRejected);
  const many = { all: [2, 3, 4].map(n => ({ facet: 'concept', any: [id(n)] })) };
  try { compileQuery({ ...base, filter: many }); }
  catch (error) { expect((error as QueryRejected).refusal).toBe('query_budget_exceeded'); }
});

test('Query route: an unsupported shape returns a typed 422 before touching the backend', async () => {
  const app = queryRoutes({} as never, {} as never);
  const response = await app.handle(new Request('http://main.local/v1/query', { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...base,
      filter: { any: [{ facet: 'type', any: [book] }, { facet: 'type', any: [recipe] }] },
    }) }));
  expect(response.status).toBe(422);
  expect(await response.json()).toMatchObject({ code: 'unsupported_query_shape' });
});

test('Query: Concept page Conditions use the bounded Works template', () => {
  const query: ResourceQuery = { context: 'global', scope: { kind: 'all' }, sort: 'newest',
    page: { size: 20 }, filter: { all: [
      { facet: 'concept', any: [id(2), id(3)] }, { facet: 'concept', none: [id(4)] },
      { facet: 'type', any: [book] },
    ] } };
  expect(compileQuery(query)).toMatchObject({ template: 'concept-works', concept: id(2),
    request: { scope: 'global', match: 'any', include: [id(3)], exclude: [id(4)], type: book } });
  expect(() => compileQuery({ ...query, page: { size: 21 } })).toThrow(QueryRejected);
  expect(compileQuery({ ...query, filter: { all: [{ facet: 'concept', none: [id(4)] }] } }))
    .toMatchObject({ template: 'concept-works', concept: id(4),
      request: { role: 'filter', exclude: [id(4)], sort: 'recent' } });
  const ranked: ResourceQueryV2 = { profile: 'filter-document-v2', context: 'global', scope: { kind: 'all' },
    sort: 'top-rated', ratingContext: id(9), page: { size: 20 },
    filter: { all: [{ facet: 'concept', any: [id(2)] }] } };
  expect(compileQuery(ranked)).toMatchObject({ template: 'concept-works',
    request: { role: 'filter', sort: 'top-rated', context: id(9), include: [id(2)], match: 'any' } });
  const mine: ResourceQueryV2 = { profile: 'filter-document-v2', context: 'global', scope: { kind: 'mine' },
    sort: 'top-rated', page: { size: 12 }, ratingContext: id(9), actingSubject: id(8),
    filter: { all: [{ facet: 'concept', all: [id(2)] }] } };
  expect(compileQuery(mine)).toMatchObject({ request: { scope: 'mine', role: 'filter', sort: 'top-rated',
    actingSubject: id(8) } });
});

test('filter-document-v1 rejects top-rated, Mine, ratingContext and actingSubject; v2 admits them', () => {
  const page = { size: 12 };
  const v1 = { context: 'global' as const, scope: { kind: 'all' as const }, sort: 'newest' as const, page,
    filter: { all: [{ facet: 'concept', any: [id(2)] }] } };
  expect(Value.Check(resourceQueryV1, v1)).toBe(true);
  expect(Value.Check(resourceQueryV2, v1)).toBe(false);
  for (const extra of [
    { sort: 'top-rated' }, { scope: { kind: 'mine' } }, { ratingContext: id(9) }, { actingSubject: id(8) },
  ]) expect(Value.Check(resourceQueryV1, { ...v1, ...extra })).toBe(false);
  const v2 = { profile: 'filter-document-v2' as const, ...v1, scope: { kind: 'mine' as const },
    sort: 'top-rated' as const, ratingContext: id(9), actingSubject: id(8) };
  expect(Value.Check(resourceQueryV1, v2)).toBe(false);
  expect(Value.Check(resourceQueryV2, v2)).toBe(true);
  expect(Value.Check(resourceQueryV2, { profile: 'filter-document-v2', ...v1, sort: 'top-rated',
    ratingContext: id(9) })).toBe(true);
  expect(Value.Check(resourceQueryV2, { profile: 'filter-document-v2', ...v1,
    ratingContext: id(9), actingSubject: id(8) })).toBe(true);
});

test('Query: Concept membership is all or any, and exclusion removes a Work', () => {
  const terms = new Set(['a', 'b']);
  expect(conceptMembership(terms, [['a'], ['b']], [], 'all')).toBe(true);
  expect(conceptMembership(terms, [['a'], ['c']], [], 'all')).toBe(false);
  expect(conceptMembership(terms, [['a'], ['c']], [], 'any')).toBe(true);
  expect(conceptMembership(terms, [], ['b'], 'all')).toBe(false);
  expect(conceptMembership(terms, [], ['c'], 'all')).toBe(true);
});

test('Query: phrase Concept any and all retain their different set meanings', () => {
  const all = compileQuery({ ...base, filter: { all: [
    { facet: 'concept', all: [id(2), id(3)] }, { facet: 'concept', none: [id(4)] },
  ] } });
  const any = compileQuery({ ...base, filter: { all: [
    { facet: 'concept', any: [id(2), id(3)] }, { facet: 'concept', none: [id(4)] },
  ] } });
  expect(all).toMatchObject({ template: 'search-concepts', includeMatch: 'all' });
  expect(any).toMatchObject({ template: 'search-concepts', includeMatch: 'any' });
  const relations = [
    { operator: 'include' as const, relation: relation([1, 2]) },
    { operator: 'include' as const, relation: relation([2, 3]) },
    { operator: 'exclude' as const, relation: relation([3]) },
  ];
  expect(combineConcepts(relation([1, 2, 3, 4]), relations, 'all').map(row => row.work)).toEqual([id(2)]);
  expect(combineConcepts(relation([1, 2, 3, 4]), relations, 'any').map(row => row.work))
    .toEqual([id(1), id(2)]);
});
