import { expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import * as v from 'valibot';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { discoveryExample } from '../src/kernel/fake/search-discovery';
import { setLocale } from '../src/paraglide/runtime.js';
import { SearchPage, type SearchPageData } from '../src/search/search';
import { discoveryRequest } from '../src/search/search-request';
import { discoverySearchHref, searchLoaderDeps, searchParams } from '../src/search/search-params';

test('SearchPage keeps admitted language tags readable and removable when Intl cannot name one', async () => {
  setLocale('en', { reload: false });
  const languages = ['en-a', 'ja', 'fr'];
  const query = {
    q: 'Soseki', type: 'schema:Book', sort: 'rating', language: languages, cursor: 'signed+/=',
    condition: JSON.stringify({ not: { type: { in: ['schema:Movie'] } } }),
    filter: JSON.stringify({ type: { in: ['schema:CreativeWork'] } }),
    'f.schema:genre': ['classic', 'fiction'], 'r.schema:datePublished': JSON.stringify({ gte: 1900 }),
  };
  const state = searchLoaderDeps(v.parse(searchParams, query));
  const data = {
    queryState: state, type: state.type, typeLabels: { en: 'Book' }, condition: state.condition,
    ranges: state.ranges, selectedFacets: state.facets, selectedFacetLabels: { 'schema:genre': { en: 'Genre' } },
    groups: [], typeChoices: [], hitTypes: {}, yearProperties: [], facetsAvailable: true, facetRetry: false,
    facetIndexNotReady: false, staleCursorRestarted: false, sort: state.sort ?? 'relevance',
    discovery: { status: 'ready' as const, page: discoveryExample },
  } satisfies SearchPageData;
  const route = createRootRoute({
    validateSearch: (search) => v.parse(searchParams, search),
    component: () => createElement(SearchPage, { query: state.query, cursor: state.cursor, data }),
  });
  const parseSearch = (value: string) => {
    const params = new URLSearchParams(value);
    return Object.fromEntries([...new Set(params.keys())].map((key) => {
      const values = params.getAll(key);
      return [key, values.length === 1 ? values[0] : values];
    }));
  };
  const stringifySearch = (search: Record<string, unknown>) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(search))
      for (const item of Array.isArray(value) ? value : [value])
        if (typeof item === 'string') params.append(key, item);
    return params.size ? `?${params}` : '';
  };
  const router = createRouter({
    routeTree: route, parseSearch, stringifySearch,
    history: createMemoryHistory({ initialEntries: [discoverySearchHref('en', state)] }),
  });
  await router.load();
  const roundTrip = searchLoaderDeps(v.parse(searchParams, router.state.location.search));
  expect(roundTrip.languages).toEqual(languages);
  expect(discoveryRequest(roundTrip, ['en']).languages).toEqual(languages);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router })));
  expect(html).toContain('Results');
  expect(html).toContain('Language: en-a');
  expect(html).toContain('Language: Japanese');
  expect(html).toContain('Language: French');

  const chip = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].find(([, , body]) => body!.includes('Language: en-a'));
  const href = chip?.[1]!.match(/\bhref="([^"]+)"/)?.[1];
  expect(href).toBeDefined();
  const destination = new URL(href!.replaceAll('&amp;', '&'), 'https://site.test');
  expect(destination.searchParams.get('q')).toBe('Soseki');
  expect(destination.searchParams.get('type')).toBe('schema:Book');
  expect(destination.searchParams.get('sort')).toBe('rating');
  expect(destination.searchParams.getAll('language')).toEqual(['ja', 'fr']);
  expect(destination.searchParams.has('cursor')).toBe(false);
  expect(destination.searchParams.get('condition')).toBe(query.condition);
  expect(destination.searchParams.get('filter')).toBe(query.filter);
  expect(destination.searchParams.getAll('f.schema:genre')).toEqual(['classic', 'fiction']);
  expect(destination.searchParams.get('r.schema:datePublished')).toBe(query['r.schema:datePublished']);
});
