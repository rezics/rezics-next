import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import type { ResourceQuery } from '../../../model/definitions/filter-document-v1.ts';
import type { ResourceQuery as ResourceQueryV2 } from '../../../model/definitions/filter-document-v2.ts';
import { compileQuery, QueryRejected } from '../src/modules/query/compile.ts';
import { combineConcepts, pageConcepts, type CompleteSearch } from '../src/modules/query/concept-set.ts';
import { queryRoutes, resourceQueryV1, resourceQueryV2 } from '../src/routes/query.ts';

const id = (n: number) => `https://rezics.com/id/019d0000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const book = 'https://schema.org/Book', recipe = 'https://schema.org/Recipe';
const base: ResourceQuery = { context: 'global', scope: { kind: 'all' },
  text: { keywords: 'pride prejudice' }, sort: 'relevance', page: { size: 20 } };
const queries = (query: ResourceQuery): [ResourceQuery, ResourceQueryV2] =>
  [query, { ...query, profile: 'filter-document-v2' }];

test('ResourceQuery revisions admit explicit keywords, exact phrase and the existing title/body alternative', () => {
  for (const text of [{ keywords: 'pride prejudice' }, { phrase: 'pride and prejudice' },
    { title: 'pride', body: 'prejudice' }]) {
    const [v1, v2] = queries({ ...base, text });
    expect(Value.Check(resourceQueryV1, v1)).toBe(true);
    expect(Value.Check(resourceQueryV2, v2)).toBe(true);
  }
});

test('ResourceQuery keywords compile to the existing producer text with explicit keyword mode', () => {
  // Query compilation preserves literal user text. The search owner escapes and matches it.
  for (const keywords of ['pride prejudice', '"pride prejudice"', 'title:猫 OR * +犬 -魚', ' 猫 犬 ']) {
    for (const query of queries({ ...base, text: { keywords } })) {
      expect(compileQuery(query)).toMatchObject({ template: 'search', request: {
        profile: 'public-main-phrase-page-v1', phrase: keywords, matchMode: 'keywords',
        language: null, pageSize: 20,
      } });
    }
  }
});

test('ResourceQuery phrase keeps legacy exact mode and title/body keeps its field profile', () => {
  for (const query of queries({ ...base, text: { phrase: 'pride and prejudice' } })) {
    const plan = compileQuery(query);
    expect(plan).toMatchObject({ template: 'search', request: {
      profile: 'public-main-phrase-page-v1', phrase: 'pride and prejudice',
    } });
    expect(plan.request).not.toHaveProperty('matchMode');
  }
  expect(compileQuery({ ...base, text: { title: 'pride', body: 'prejudice' } }))
    .toMatchObject({ template: 'search', request: {
      profile: 'public-main-title-body-page-v1', titleTerm: 'pride', bodyTerm: 'prejudice',
    } });
});

test('ResourceQuery keywords retain each admitted global/Realm, Concept and rated search profile', () => {
  const concept = { facet: 'concept', any: [id(2)], interpretation: { definition: id(3) } };
  const cases: [Partial<ResourceQuery>, string][] = [
    [{}, 'public-main-phrase-page-v1'],
    [{ context: { realm: id(1) } }, 'public-realm-phrase-page-v1'],
    [{ filter: { all: [concept] } }, 'public-main-classified-phrase-page-v1'],
    [{ context: { realm: id(1) }, filter: { all: [concept] } }, 'public-realm-classified-phrase-page-v1'],
    [{ context: { realm: id(1) }, filter: { all: [concept,
      { facet: 'rating', bind: { ratingContext: id(4) }, range: { min: '7.0' } },
    ] } }, 'public-realm-classified-rated-phrase-page-v1'],
  ];
  for (const [extra, profile] of cases) for (const query of queries({ ...base, ...extra })) {
    const plan = compileQuery(query);
    expect(plan).toMatchObject({ template: 'search', request: {
      profile, phrase: 'pride prejudice', matchMode: 'keywords',
    } });
    if (query.context !== 'global') expect(plan.request).toHaveProperty('context', {
      kind: 'realm-local', id: query.context.realm,
    });
    if (query.filter) expect(plan).toHaveProperty('concept', { value: id(2), revision: id(3) });
    if (profile.includes('rated')) expect(plan.request).toMatchObject({ ratingContext: id(4), minimumMeanTimes10: 70 });
  }
});

test('ResourceQuery keyword continuation retains language, types, contributor, Realm and exact Concept revision', () => {
  const continuation = { profile: 'opaque-owner-continuation', next: { offset: 20 }, digest: 'selection' };
  const query: ResourceQuery = { ...base, context: { realm: id(1) }, filter: { all: [
    { facet: 'type', any: [book] }, { facet: 'type', none: [recipe] },
    { facet: 'language', any: ['ja'] }, { facet: 'contributor', any: [id(5)] },
    { facet: 'concept', any: [id(2)], interpretation: { definition: id(3) } },
  ] } };
  for (const input of queries(query)) {
    const first = compileQuery(input);
    const next = compileQuery({ ...input, page: { ...input.page, continuation } });
    expect(next).toEqual({ ...first, request: { ...first.request, continuation } });
    expect(next).toMatchObject({ template: 'search', concept: { value: id(2), revision: id(3) }, request: {
      includeTypes: [book], excludeTypes: [recipe], language: 'ja', author: id(5),
      context: { kind: 'realm-local', id: id(1) }, matchMode: 'keywords',
    } });
    expect(next.request).toHaveProperty('continuation', continuation);
  }
});

test('ResourceQuery keywords retain complete-set Concept include/exclude semantics in either Context', () => {
  for (const context of ['global', { realm: id(1) }] as const) {
    const plan = compileQuery({ ...base, context, filter: { all: [
      { facet: 'concept', all: [id(2)] }, { facet: 'concept', none: [id(4)] },
    ] } });
    expect(plan).toMatchObject({ template: 'search-concepts', includeMatch: 'all',
      concepts: [{ operator: 'include', value: id(2) }, { operator: 'exclude', value: id(4) }],
      request: { profile: context === 'global' ? 'public-main-phrase-v1' : 'public-realm-phrase-v1',
        phrase: 'pride prejudice', matchMode: 'keywords' },
    });
  }
});

const relation = (members: number[]): CompleteSearch => ({ resultGrain: 'mainVersion', complete: true,
  context: 'main-version-default', population: 4, total: members.length,
  results: members.map(n => ({ work: id(n), mainVersion: id(n + 100) })),
  sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '4' }, indexGeneration: 'index-1' });

test('ResourceQuery keyword Concept pages traverse without loss and fence mode, text and filters', () => {
  const query: ResourceQuery = { ...base, page: { size: 1 }, filter: { all: [
    { facet: 'concept', all: [id(2)] }, { facet: 'concept', none: [id(4)] },
    { facet: 'type', any: [book] },
  ] } };
  const plan = compileQuery(query);
  expect(plan.template).toBe('search-concepts');
  const complete = relation([1, 2, 3, 4]);
  const selected = combineConcepts(complete, [
    { operator: 'include', relation: relation([1, 2, 3]) },
    { operator: 'exclude', relation: relation([2]) },
  ]);
  const first = pageConcepts(query, complete, selected, [id(2), id(4)], 'a'.repeat(64), 1000);
  expect(first.results.map(row => row.work)).toEqual([id(1)]);
  expect(first.next).not.toBeNull();
  const input = { ...query, page: { size: 1, continuation: first.next } };
  expect(compileQuery(input)).toEqual(plan);
  const last = pageConcepts(input, complete, selected, [id(2), id(4)], 'a'.repeat(64), 1001);
  expect(last.results.map(row => row.work)).toEqual([id(3)]);
  expect(last.next).toBeNull();
  for (const change of [{ text: { phrase: 'pride prejudice' } }, { text: { keywords: 'other words' } },
    { context: { realm: id(9) } }, { filter: { all: [
      ...query.filter && 'all' in query.filter ? query.filter.all : [], { facet: 'language', any: ['ja'] },
    ] } }]) {
    expect(() => pageConcepts({ ...input, ...change }, complete, selected,
      [id(2), id(4)], 'a'.repeat(64), 1001)).toThrow(QueryRejected);
  }
});

test('ResourceQuery keyword and phrase bounds preserve single characters, CJK and 80 Unicode code points', () => {
  for (const text of ['猫', 'a', '𠮷', '猫 犬', '𠮷'.repeat(80)]) for (const mode of ['keywords', 'phrase'] as const) {
    const input = mode === 'keywords' ? { keywords: text } : { phrase: text };
    for (const [index, query] of queries({ ...base, text: input }).entries()) {
      expect(Value.Check(index ? resourceQueryV2 : resourceQueryV1, query)).toBe(true);
      expect(compileQuery(query).request).toHaveProperty('phrase', text);
    }
  }
  for (const mode of ['keywords', 'phrase'] as const) {
    const text = mode === 'keywords' ? { keywords: '𠮷'.repeat(81) } : { phrase: '𠮷'.repeat(81) };
    for (const [index, query] of queries({ ...base, text }).entries()) {
      expect(Value.Check(index ? resourceQueryV2 : resourceQueryV1, query)).toBe(false);
      expect(() => compileQuery(query)).toThrow(QueryRejected);
    }
  }
});

test('ResourceQuery refuses contradictory text objects before any search owner read', async () => {
  const app = queryRoutes({} as never, {} as never);
  const malformed = [{ keywords: 'cat', phrase: 'cat' }, { keywords: 'cat', title: 'cat', body: 'cat' },
    { keywords: 'cat', matchMode: 'phrase' }, { keywords: '' }, { keywords: 1 }, {}, null];
  for (const text of malformed) for (const [index, input] of queries(base).entries()) {
    const query = { ...input, text };
    expect(Value.Check(index ? resourceQueryV2 : resourceQueryV1, query)).toBe(false);
    const response = await app.handle(new Request('http://main.local/v1/query', { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(query) }));
    expect(response.status).toBe(422);
  }
  expect(() => compileQuery({ ...base, text: { keywords: 'cat', phrase: 'cat' } })).toThrow(QueryRejected);
});

test('ResourceQuery keyword mode refuses unsupported scopes, sorts, qualifiers and contradictory filters', () => {
  const refused: (ResourceQuery | ResourceQueryV2)[] = [
    { ...base, sort: 'newest' }, { ...base, text: { keywords: '   ' } },
    { ...base, context: { realm: id(1) }, scope: { kind: 'realm', realm: id(1) } },
    { ...base, profile: 'filter-document-v2', scope: { kind: 'mine' } },
    { ...base, filter: { all: [{ facet: 'type', any: [book] }, { facet: 'type', none: [book] }] } },
    { ...base, filter: { all: [{ facet: 'language', any: ['ja', 'en'] }] } },
    { ...base, filter: { all: [{ facet: 'status', any: ['ongoing'] }] } },
    { ...base, sourcePolicy: { datasetId: 'other' } }, { ...base, asOf: 'yesterday' },
    { ...base, page: { size: 20, continuation: 'wrong-owner-cursor' } },
  ];
  for (const query of refused) expect(() => compileQuery(query)).toThrow(QueryRejected);
});
