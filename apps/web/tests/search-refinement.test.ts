import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { Refinement } from '../src/search/refinement/refinement';
import { HeaderSearchFilterProvider } from '../src/search/header-search/filter-region';
import { facetProperties, type FilterDocument } from '@rezics/filter';
import recording from '../src/kernel/recorded/definitions-release.json';
import { compileRefinement, refinementHref, refinementProperties } from '../src/search/refinement/model';
import { facetRequest, readFacetPage, refinementKey, type FacetRequest } from '../src/search/refinement/request';
import { searchFormFields, searchLoaderDeps } from '../src/search/search-params';
import { readSearchPage } from '../src/search/search-request';

const release = recording.release;
const book = 'schema:Book';
const author = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const as_of = '2026-10-31T00:00:00Z';

test('the released property picker includes structural bases, code fields and independent range controls', () => {
  const roster = refinementProperties(release, book);
  expect(roster.filter((entry) => entry.property !== 'type').map((entry) => entry.property)).toEqual(
    facetProperties(release, [book]),
  );
  expect(roster.find((entry) => entry.property === 'schema:inLanguage')?.mode).toBe('values');
  expect(roster.find((entry) => entry.property === 'schema:wordCount')).toMatchObject({ mode: 'range', units: ['1'] });
  const structural = {
    types: { 'ex:Base': { facets: ['ex:base'] }, 'ex:Child': { bases: ['ex:Base'], facets: ['ex:own', 'ex:base'] } },
    properties: { 'ex:own': { datatype: 'time' }, 'ex:base': { datatype: 'quantity', units: ['1'] } },
  };
  expect(refinementProperties(structural, 'ex:Child').map((entry) => entry.property)).toEqual([
    'type',
    'ex:own',
    'ex:base',
  ]);
});

test('selected values and ranges compile one closed predicate without detaching nested or same-statement conditions', () => {
  const condition: FilterDocument = { not: { statement: { property: 'schema:inLanguage', in: ['ja'] } } };
  const filter = compileRefinement(release, {
    type: book,
    facetValues: { 'schema:author': [author], 'schema:inLanguage': ['en'] },
    ranges: { 'schema:wordCount': { gte: 1_000_001, unit: '1' }, 'schema:datePublished': { gte: 1900, lte: 2026 } },
    condition,
  });
  expect(filter).toEqual({
    and: [
      condition,
      { type: { in: [book] } },
      { statement: { property: 'schema:author', in: [author] } },
      { statement: { property: 'schema:inLanguage', in: ['en'] } },
      { statement: { property: 'schema:wordCount', range: { gte: 1_000_001, unit: '1' } } },
      { statement: { property: 'schema:datePublished', range: { gte: 1900, lte: 2026 } } },
    ],
  });
  const qualifiedRelease = {
    types: { 'ex:Work': { facets: ['ex:credit'] } },
    properties: {
      'ex:credit': { datatype: 'wikibase-item', qualifiers: ['ex:role'] },
      'ex:role': { datatype: 'string', value: { pattern: '^[a-z]+$' } },
    },
  };
  const qualified: FilterDocument = {
    statement: { property: 'ex:credit', in: [author], qualifiers: [{ property: 'ex:role', in: ['author'] }] },
  };
  expect(compileRefinement(qualifiedRelease, { facetValues: {}, condition: qualified })).toEqual(qualified);
  expect(() =>
    compileRefinement(release, {
      type: book,
      facetValues: {},
      ranges: { 'schema:wordCount': { gte: 2, lte: 1, unit: '1' } },
    }),
  ).toThrow();
  expect(() =>
    compileRefinement(release, { type: book, facetValues: {}, ranges: { 'schema:wordCount': { gte: 2, unit: 'kg' } } }),
  ).toThrow();
});

test('one bounded facet payload retains independent opaque cursors and native value order without counts', async () => {
  const filter = compileRefinement(release, { type: book, facetValues: { 'schema:inLanguage': ['en'] } });
  const request = facetRequest({ text: 'reading', languages: ['en'], filter }, [
    { property: 'schema:author', size: 2, cursor: 'opaque-A' },
    { property: 'schema:inLanguage' },
  ]);
  const calls: FacetRequest[] = [];
  const result = await readFacetPage(request, async (body) => {
    calls.push(body);
    return {
      status: 200,
      data: {
        facets: [
          {
            property: 'schema:author',
            values: [
              { value: 'native-1', labels: { en: 'Zulu' } },
              { value: 'native-2', labels: { en: 'Alpha' } },
            ],
            next: 'opaque-B',
          },
          { property: 'schema:inLanguage', values: [{ value: 'en', labels: { en: 'English' } }], next: null },
        ],
        as_of,
      },
    };
  });
  expect(calls).toEqual([request]);
  expect(result.status).toBe('ready');
  if (result.status === 'ready')
    expect(result.page.facets[0]!.values.map((entry) => entry.labels.en)).toEqual(['Zulu', 'Alpha']);
  expect(JSON.stringify(result)).not.toMatch(/count|total|estimate/);
  expect(() =>
    facetRequest(
      {},
      Array.from({ length: 9 }, (_, i) => ({ property: `ex:p${i}` })),
    ),
  ).toThrow();
  expect(() => facetRequest({}, [{ property: 'type' }, { property: 'type' }])).toThrow();
  expect(() => facetRequest({}, [{ property: 'type', size: 21 }])).toThrow();
});

test('legacy previews and count metadata cannot establish terminal exhaustion; native refusals remain distinct', async () => {
  const request = facetRequest({}, [{ property: 'type' }]);
  for (const facet of [
    { property: 'type', values: [] },
    { property: 'type', values: [], next: null, count: 0 },
    { property: 'type', values: [], next: 'sampled-next' },
  ]) {
    expect((await readFacetPage(request, async () => ({ status: 200, data: { facets: [facet], as_of } }))).status).toBe(
      'invalid',
    );
  }
  expect(
    (
      await readFacetPage(request, async () => ({
        status: 200,
        data: { facets: [{ property: 'type', values: [], next: null }], as_of },
      }))
    ).status,
  ).toBe('ready');
  for (const [status, code, expected] of [
    [403, 'platform_closed', 'refused'],
    [404, 'not_found', 'refused'],
    [503, 'index_not_ready', 'preparing'],
    [409, 'search_restart_required', 'restart'],
    [422, 'unsupported_query', 'invalid'],
  ] as const) {
    const problem = { code };
    expect(await readFacetPage(request, async () => ({ status, error: problem }))).toEqual({
      status: expected,
      httpStatus: status,
      code,
      problem,
    });
  }
});

test('predicate edits, header submission and generation restarts keep conditions and reset pagination', async () => {
  const condition: FilterDocument = { not: { type: { in: ['schema:Movie'] } } };
  const conditions = {
    type: book,
    facetValues: { 'schema:inLanguage': ['en'] },
    ranges: { 'schema:datePublished': { gte: 1900 } },
    condition,
  };
  const href = refinementHref('en', 'reading', conditions, 'rating');
  const params = Object.fromEntries(new URL(href, 'https://example.test').searchParams);
  expect(params.cursor).toBeUndefined();
  const deps = searchLoaderDeps(params);
  expect(deps.ranges).toEqual(conditions.ranges);
  expect(deps.condition).toEqual(condition);
  expect(searchFormFields({ ...params, cursor: 'old-hit-token' })).toContainEqual([
    'condition',
    JSON.stringify(condition),
  ]);
  expect(searchFormFields({ ...params, cursor: 'old-hit-token' }).some(([key]) => key === 'cursor')).toBe(false);
  const calls: unknown[] = [];
  const request = { text: 'reading', filter: compileRefinement(release, conditions), cursor: 'old-generation' };
  const read = await readSearchPage(request, async (body) => {
    calls.push(body);
    return calls.length === 1 ? { status: 409, error: { code: 'search_restart_required' } } : { status: 200 };
  });
  expect(read.restarted).toBe(true);
  const { cursor: _cursor, ...first } = request;
  expect(calls).toEqual([request, first]);
  const context = {
    principal: 'anonymous',
    languages: ['en'],
    release: recording.digest,
    source: 'public-global',
    text: 'reading',
    filter: request.filter,
  };
  expect(refinementKey(context)).not.toBe(refinementKey({ ...context, release: 'next-release' }));
  expect(refinementKey(context)).not.toBe(refinementKey({ ...context, languages: ['ja'] }));
});

test('the real visible Search journey consumes its actual typed API and current data through the shared Web shell with no fake trends counts or permission', async () => {
  const calls: unknown[] = [];
  const request = facetRequest({ text: 'reading', languages: ['en'] }, [{ property: 'schema:inLanguage' }]);
  const client = createKernelClient('http://kernel.local', {
    fetch: async (url, init) => {
      calls.push({
        url: String(url),
        body: JSON.parse(String(init?.body)),
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return Response.json({
        facets: [{ property: 'schema:inLanguage', values: [{ value: 'en', labels: { en: 'English' } }], next: null }],
        as_of,
      });
    },
  });
  const state = await readFacetPage(request, (body) => client.subjects.$facets.post(body));
  const render = (initial: typeof state) =>
    renderToStaticMarkup(
      createElement(HeaderSearchFilterProvider, {
        children: createElement(Refinement, {
          query: 'reading',
          locale: 'en',
          conditions: { facetValues: { 'schema:inLanguage': ['en'] } },
          data: { key: 'actual-response', properties: refinementProperties(release, book), initial },
          load: async () => initial,
        }),
      }),
    );
  const html = render(state);
  expect(calls).toEqual([{ url: 'http://kernel.local/v1/subjects:facets', body: request, authorization: null }]);
  expect(html).toContain('English');
  expect(html).toContain('checked=""');
  expect(html).toContain('Choose a property');
  expect(html).toContain('Clear filters');
  expect(html).not.toMatch(/Trending|total|estimate|permission|opaque|More values/);
  const refused = render({ status: 'refused', httpStatus: 403, code: 'platform_closed' });
  expect(refused).toContain('role="alert"');
  expect(refused).toContain('disabled=""');
  expect(refused).not.toContain('No eligible values');
});
