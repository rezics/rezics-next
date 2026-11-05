import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import { searchFacetStoryPaths } from '../src/kernel/fake/search-facets';
import typedSearch from '../src/kernel/recorded/search-typed.json';
import emptySearch from '../src/kernel/recorded/search-empty.json';
import definitions from '../src/kernel/recorded/definitions-release.json';
import { parseDiscoveryPage, parseLegacySearchPage } from '../src/search/discovery';
import { DiscoveryResults } from '../src/search/discovery-results';
import { discoveryRequest } from '../src/search/search-request';
import { readSearchOutcome } from '../src/search/search-recovery';
import { searchLoaderDeps } from '../src/search/search-params';
import { refinementHref, refinementProperties } from '../src/search/refinement/model';
import { Refinement } from '../src/search/refinement/refinement';
import { facetRequest, readFacetPage } from '../src/search/refinement/request';

function stateFor(path: string) {
  const url = new URL(path, 'http://rezics.local');
  const search = Object.fromEntries(
    [...new Set(url.searchParams.keys())].map((key) => {
      const values = url.searchParams.getAll(key);
      return [key, values.length === 1 ? values[0] : values];
    }),
  );
  return searchLoaderDeps(search);
}

function storyClient() {
  const transport = createStoryRecordedKernelFetch();
  const calls: { path: string; body: unknown }[] = [];
  const client = createKernelClient('http://kernel.local', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push({ path: new URL(request.url).pathname, body: await request.clone().json() });
      return transport(request);
    },
  });
  return { client, calls };
}

test('connected typed and selected-facet story requests return the recorded Prince and current count-free refinements', async () => {
  for (const path of [searchFacetStoryPaths.results, searchFacetStoryPaths.active]) {
    for (const locale of ['en', 'zh-Hans']) {
      const state = stateFor(path);
      const { client, calls } = storyClient();
      const request = discoveryRequest(state, [locale]);
      const outcome = await readSearchOutcome(request, (body) => client.subjects.$search.post(body));
      expect(outcome.recovery.status).toBe('ready');
      expect(outcome.result).toBeUndefined();
      if (outcome.discovery?.status !== 'ready') throw new Error('The connected story lost its mixed result.');
      const page = outcome.discovery.page;
      expect(page.hits).toHaveLength(typedSearch.subjects.length);
      const hit = page.hits[0]!;
      const recorded = typedSearch.subjects[0]!;
      expect(hit.key).toEqual({ owner: 'semantic', kind: recorded.type, route: 0xd7ff, id: recorded.id });
      expect(hit.summary.kind).toBe('subject');
      expect(hit.summary.value.id).toBe(recorded.summary.id);
      expect(hit.labels).toEqual({ [locale]: recorded.labels[locale as keyof typeof recorded.labels] });
      expect(hit.facts).toEqual(recorded.facts);
      expect(page.next).toBe(typedSearch.next);
      expect(page.as_of).toBe(typedSearch.as_of);
      expect(parseLegacySearchPage(page)).toBeUndefined();
      const resultHtml = renderToStaticMarkup(createElement(DiscoveryResults, { state: outcome.discovery, locale }));
      expect(resultHtml).toContain(recorded.labels[locale as keyof typeof recorded.labels]);
      expect(resultHtml).toContain(`/${locale}/subjects/${recorded.id}/`);
      expect(resultHtml).toContain(locale === 'en' ? 'A poetic novella' : 'Conte poétique');

      // Use the same released roster as the connected page, including its type facet.
      const roster = refinementProperties(definitions.release, state.type);
      const requested = roster
        .slice(0, 8)
        .filter((entry) => entry.mode === 'values' || entry.mode === 'types')
        .map(({ property }) => ({ property, size: 10 }));
      expect(requested).toContainEqual({ property: 'type', size: 10 });
      const facets = facetRequest({ text: state.query, languages: [locale], filter: request.filter }, requested);
      const refinement = await readFacetPage(facets, (body) => client.subjects.$facets.post(body));
      expect(refinement.status).toBe('ready');
      if (refinement.status !== 'ready') throw new Error('The connected story lost its facet values.');
      expect(refinement.page.facets.map(({ property }) => property)).toEqual(requested.map(({ property }) => property));
      expect(refinement.page.facets.every(({ next }) => next === null)).toBe(true);
      const fable = locale === 'zh-Hans' ? '寓言' : 'Fable';
      expect(refinement.page.facets.find(({ property }) => property === 'schema:genre')?.values).toEqual([
        { value: '01a17dfd-5da5-76da-bc50-a1fb5dbc87d2', labels: { [locale]: fable } },
      ]);
      const refinementHtml = renderToStaticMarkup(
        createElement(Refinement, {
          data: { key: path, properties: roster, initial: refinement },
          conditions: { type: state.type, facetValues: state.facets },
          query: state.query,
          locale,
          load: async () => refinement,
        }),
      );
      expect(refinementHtml).toContain(fable);
      const genreControl = refinementHtml.match(/<input\b[^>]*name="f\.schema:genre"[^>]*>/)?.[0];
      expect(genreControl).toBeDefined();
      expect(genreControl!.includes('checked=""')).toBe(path === searchFacetStoryPaths.active);
      expect(JSON.stringify([page, refinement.page])).not.toMatch(/"(?:count|total|relation|estimate)":/);
      expect(calls).toEqual([
        { path: '/v1/subjects:search', body: request },
        { path: '/v1/subjects:facets', body: facets },
      ]);
    }
  }
});

test('the story boundary negotiates mixed and explicit legacy responses without changing either strict decoder', async () => {
  const { client } = storyClient();
  const mixed = discoveryRequest(stateFor(searchFacetStoryPaths.results), ['en']);
  const { representation: _representation, kindPage: _kindPage, ...legacy } = mixed;
  const legacyResponse = await client.subjects.$search.post(legacy);
  const { query: _query, filterType: _filterType, ...recordedWire } = typedSearch;
  expect(legacyResponse.data).toEqual(recordedWire);
  expect(parseDiscoveryPage(legacyResponse.data)).toBeUndefined();
  const legacyOutcome = await readSearchOutcome(legacy, (body) => client.subjects.$search.post(body));
  expect(legacyOutcome.recovery.status).toBe('ready');
  expect(legacyOutcome.result?.subjects).toEqual(typedSearch.subjects);
  expect(legacyOutcome.discovery).toBeUndefined();
  expect((await readSearchOutcome(mixed, async () => legacyResponse)).recovery.status).toBe('unavailable');
  const mixedResponse = await client.subjects.$search.post(mixed);
  expect((await readSearchOutcome(legacy, async () => mixedResponse)).recovery.status).toBe('unavailable');

  for (const request of [mixed, legacy]) {
    const outcome = await readSearchOutcome({ ...request, text: emptySearch.query }, (body) =>
      client.subjects.$search.post(body),
    );
    expect(outcome.recovery.status).toBe('ready');
    if (request.representation === 'discovery-v1') {
      expect(outcome.discovery).toMatchObject({ status: 'ready', page: { hits: [], next: null } });
      expect(outcome.result).toBeUndefined();
    } else {
      expect(outcome.result?.subjects).toEqual([]);
      expect(outcome.discovery).toBeUndefined();
    }
  }

  const page = parseDiscoveryPage(mixedResponse.data)!;
  const malformed = structuredClone(page);
  malformed.hits[0]!.summary.value.id = 'different-subject';
  expect(parseDiscoveryPage(malformed)).toBeUndefined();
  expect(
    parseDiscoveryPage({ ...page, hits: [{ ...page.hits[0], key: { ...page.hits[0]!.key, owner: 'accounts' } }] }),
  ).toBeUndefined();
});

test('fixture negotiation retains full query predicates and reset links while other scenario outcomes remain distinct', async () => {
  const original = stateFor(searchFacetStoryPaths.active);
  const state = {
    ...original,
    languages: ['fr', 'en'],
    filter: ' {"not":{"type":{"in":["schema:Movie"]}}} ',
    condition: { statement: { property: 'schema:wordCount', range: { gte: 1000, unit: '1' } } },
    cursor: 'opaque-hits+/=',
  };
  const request = discoveryRequest(state, ['en']);
  const before = structuredClone(request);
  const { client, calls } = storyClient();
  expect((await readSearchOutcome(request, (body) => client.subjects.$search.post(body))).recovery.status).toBe(
    'ready',
  );
  expect(request).toEqual(before);
  expect(calls).toEqual([{ path: '/v1/subjects:search', body: before }]);
  expect(request.filter).toEqual({
    and: [
      state.condition,
      JSON.parse(state.filter),
      { type: { in: [state.type] } },
      { statement: { property: 'schema:genre', in: state.facets['schema:genre'] } },
    ],
  });
  const href = refinementHref('en', state.query, {
    type: state.type,
    languages: state.languages,
    filter: state.filter,
    condition: state.condition,
    facetValues: state.facets,
  });
  const restored = stateFor(href);
  expect(restored.cursor).toBeUndefined();
  expect(restored).toEqual({ ...state, cursor: undefined });

  for (const [text, cursor, expected] of [
    ['Mira closed', undefined, 'closed'],
    ['Mira unavailable', undefined, 'unavailable'],
    ['Mira preparing', undefined, 'index-not-ready'],
    ['Mira restart', 'old+/=', 'restart'],
  ] as const) {
    const outcome = await readSearchOutcome({ ...request, text, cursor }, (body) => client.subjects.$search.post(body));
    expect(outcome.recovery.status).toBe(expected);
    expect(outcome.discovery).toBeUndefined();
    expect(outcome.result).toBeUndefined();
  }
  const first = await readSearchOutcome({ ...request, text: 'Mira continued', cursor: undefined }, (body) =>
    client.subjects.$search.post(body),
  );
  expect(first.discovery).toMatchObject({ status: 'ready', page: { next: 'opaque-hits-page+/=' } });
  const continued = await readSearchOutcome(
    { ...request, text: 'Mira continued', cursor: 'opaque-hits-page+/=' },
    (body) => client.subjects.$search.post(body),
  );
  expect(continued.discovery).toMatchObject({ status: 'ready', page: { next: null } });
  if (continued.discovery?.status !== 'ready') throw new Error('Continuation lost its result.');
  expect(continued.discovery.page.hits).toHaveLength(3);
});
