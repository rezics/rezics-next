import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { discoveryExample, factualDiscoveryExample } from '../src/kernel/fake/search-discovery';
import { discoveryRequest } from '../src/search/search-request';
import { discoverySearchHref, searchLoaderDeps, searchParams, searchFormFields } from '../src/search/search-params';
import { parseDiscoveryPage, parseLegacySearchPage, readDiscovery, readDiscoveryKinds } from '../src/search/discovery';
import { DiscoveryResults } from '../src/search/discovery-results';
import { DiscoveryKinds } from '../src/search/discovery-kinds';
import { refinementHref } from '../src/search/refinement/model';
import { SearchSort } from '../src/search/sort';

function params(cursor?: string) {
  return searchLoaderDeps(
    v.parse(searchParams, {
      q: '"Mira" | 星 -old',
      kinds: ['account', 'catalogue:Atlas'],
      language: ['ja', 'en'],
      filter: '{"not":{"type":{"in":["schema:Book"]}}}',
      'f.schema:genre': ['fiction'],
      ...(cursor ? { cursor } : {}),
    }),
  );
}

test('the real request builder carries the complete URL predicate and opaque consumed cursor into one Eden operation', async () => {
  const cursor = '+/='.repeat(1621) + 'x';
  expect(cursor).toHaveLength(4864);
  const state = params(cursor);
  const href = new URL(discoverySearchHref('en', state), 'https://rezics.local');
  expect(href.searchParams.get('cursor')).toBe(cursor);
  expect(href.searchParams.get('q')).toBe(state.query);
  expect(href.searchParams.getAll('language')).toEqual(['ja', 'en']);
  expect(href.searchParams.getAll('kinds')).toEqual(state.kinds!);
  expect(href.searchParams.get('filter')).toBe(state.filter!);
  expect(
    searchFormFields({ q: state.query, cursor, kinds: state.kinds, language: state.languages }),
  ).not.toContainEqual(['cursor', cursor]);
  expect(v.safeParse(searchParams, { q: '星'.repeat(170) }).success).toBe(true);
  expect(v.safeParse(searchParams, { q: '星'.repeat(171) }).success).toBe(false);
  const body = discoveryRequest(state, ['en']);
  expect(body.filter).toEqual({
    and: [
      JSON.parse(state.filter!),
      { statement: { property: 'schema:genre', in: ['fiction'] } },
      { kind: { in: state.kinds } },
    ],
  });
  expect(body.kindCountLeaf).toBeUndefined();
  const calls: unknown[] = [];
  const client = createKernelClient('http://kernel.local', {
    fetch: async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json(discoveryExample);
    },
  });
  expect((await readDiscovery(body, (body) => client.subjects.$search.post(body))).discovery.status).toBe('ready');
  expect(calls).toEqual([body]);
});

test('unknown factual cards retain native descriptions, aliases, direct facts and current public rating without a profile read', () => {
  const page = parseDiscoveryPage(factualDiscoveryExample());
  expect(page).toBeDefined();
  const html = renderToStaticMarkup(
    createElement(DiscoveryResults, { state: { status: 'ready', page: page! }, locale: 'en' }),
  );
  expect(html).toContain('Mira Star Atlas');
  expect(html).toContain('Maps of Mira');
  expect(html).toContain('An atlas of nearby stars.');
  expect(html).toContain('2026');
  expect(html).toContain('8 out of 10');
  expect(html).not.toContain('7.8');
  expect(html).toContain(`/en/subjects/${discoveryExample.hits[0]!.key.id}/mira`);
  expect(html).toContain('Mira Reading Room');
  expect(html).not.toContain('operatorId');
  expect(parseLegacySearchPage(discoveryExample)).toBeUndefined();
  expect(parseDiscoveryPage({ subjects: [], next: null, as_of: page!.as_of })).toBeUndefined();
  expect(parseLegacySearchPage({ subjects: [], next: null, as_of: page!.as_of })?.subjects).toEqual([]);
});

test('kind metadata continuation makes one bounded metadata-only call and distinguishes unknown, zero and positive evidence', async () => {
  const body = discoveryRequest(params(), ['en']);
  const calls: unknown[] = [];
  const result = await readDiscoveryKinds(
    { ...body, cursor: 'hits', kindCountLeaf: 2 },
    'opaque-kind-page+/=',
    async (request) => {
      calls.push(request);
      return {
        status: 200,
        data: {
          kinds: { values: [{ id: 'catalogue:Atlas', labels: { en: 'Atlas' }, icon: 'map' }], next: null },
          as_of: discoveryExample.as_of,
        },
      };
    },
  );
  expect(calls).toEqual([
    {
      representation: 'discovery-v1',
      text: body.text,
      languages: body.languages,
      filter: body.filter,
      kindPage: { limit: 8, cursor: 'opaque-kind-page+/=' },
    },
  ]);
  expect(result.status).toBe('ready');
  expect(result).toMatchObject({ asOf: discoveryExample.as_of });
  const html = renderToStaticMarkup(
    createElement(DiscoveryKinds, {
      initial: factualDiscoveryExample().kinds,
      checkpoint: factualDiscoveryExample().as_of,
      selected: ['catalogue:Atlas'],
      locale: 'en',
      hydrated: true,
      load: async () => result,
    }),
  );
  expect(html).toContain('Count unavailable');
  expect(html).toContain('1+');
  expect(html).toContain('>0<');
  expect(html).toContain('More types');
  expect(html).toContain('value="catalogue:Atlas"');
});

test('restart, closed, preparing, invalid and unsupported preserve the query as explicit outcomes instead of empty success', async () => {
  for (const [status, code, expected] of [
    [409, 'search_restart_required', 'restart'],
    [403, 'platform_closed', 'closed'],
    [202, 'preparing', 'preparing'],
    [400, 'invalid_request', 'invalid'],
    [422, 'unsupported_query', 'unsupported'],
  ] as const) {
    let calls = 0;
    const { discovery } = await readDiscovery(discoveryRequest(params('opaque'), ['en']), async () => {
      calls++;
      return { status, error: { value: { code } } };
    });
    expect(calls).toBe(1);
    expect(discovery.status).toBe(expected);
    const html = renderToStaticMarkup(
      createElement(DiscoveryResults, {
        state: discovery,
        locale: 'en',
        restartHref: discoverySearchHref('en', params()),
      }),
    );
    expect(html).not.toContain('No results');
    expect(html).toContain('q=');
    expect(html).not.toContain('cursor=');
  }
});

test('current native refinement and mixed discovery retain the same predicate through links, sorting and metadata reads', async () => {
  const state = {
    ...params(),
    facets: { type: ['schema:Book'], 'schema:genre': ['fiction'] },
    ranges: { 'schema:datePublished': { gte: 1900 } },
    condition: { not: { type: { in: ['schema:Movie'] } } },
  };
  const href = refinementHref('en', state.query, {
    facetValues: state.facets,
    ranges: state.ranges,
    condition: state.condition,
    kinds: state.kinds!,
    languages: state.languages!,
    filter: state.filter!,
  });
  const url = new URL(href, 'https://rezics.local');
  const restored = searchLoaderDeps({
    ...Object.fromEntries(url.searchParams),
    kinds: url.searchParams.getAll('kinds'),
    language: url.searchParams.getAll('language'),
  });
  expect(discoveryRequest(restored, ['en'])).toEqual(discoveryRequest(state, ['en']));
  const body = discoveryRequest(state, ['en']);
  expect(body.filter).toEqual({
    and: [
      state.condition,
      JSON.parse(state.filter!),
      { type: { in: ['schema:Book'] } },
      { statement: { property: 'schema:genre', in: ['fiction'] } },
      { statement: { property: 'schema:datePublished', range: { gte: 1900 } } },
      { kind: { in: state.kinds } },
    ],
  });
  const html = renderToStaticMarkup(
    createElement(SearchSort, {
      sort: 'relevance',
      locale: 'en',
      query: state.query,
      facets: state.facets,
      state,
    }),
  );
  expect(html).toContain('name="r.schema:datePublished"');
  expect(html).toContain('name="condition"');
  expect(html).toContain('name="language" value="ja"');
  expect(html).toContain('name="kinds" value="account"');
  let sent: unknown;
  await readDiscoveryKinds(body, 'metadata', async (request) => {
    sent = request.filter;
    return { status: 503 };
  });
  expect(sent).toEqual(body.filter);
});
