import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createKernelClient } from '@rezics/client';
import { RealmDiscoverySection, type RealmDiscoveryCard } from '../src/community/realm-discovery';
import { loadRealmDiscovery } from '../src/community/realm-discovery/source';
import {
  isRealmDiscoverySearch,
  realmDiscoveryQueryOptions,
  reduceRealmDiscovery,
  type RealmDiscoveryPage,
  type RealmDiscoveryReader,
  type RealmDiscoveryWindow,
} from '../src/search/realm-discovery-loader';
import { searchLoaderDeps } from '../src/search/search-params';
import { m } from '../src/paraglide/messages.js';

mock.module('cloudflare:workers', () => ({ env: {} }));
const { SearchPage } = await import('../src/search/search');
const empty = searchLoaderDeps({});
const cursor = 'original signed +/= cursor';
const secondCursor = 'next signed +/= cursor';
const card: RealmDiscoveryCard = {
  realmId: '01a1a000-0000-7000-8000-000000000002',
  spaceId: '01a1a000-0000-7000-8000-000000000001',
  name: 'A public Realm',
  description: 'A native summary',
  avatar: null,
};
const fresh = (state: RealmDiscoveryPage): RealmDiscoveryWindow =>
  reduceRealmDiscovery({ state: { kind: 'loading' }, pending: false, retry: false, restart: false }, state);

test('the existing empty-query Search page composes the sole Content section without fetching during render', () => {
  const client = new QueryClient();
  let reads = 0;
  const read: RealmDiscoveryReader = async () => {
    reads++;
    return { kind: 'unavailable' };
  };
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(SearchPage, {
        query: '',
        realmDiscovery: { kind: 'unavailable' },
        realmDiscoveryRead: read,
      }),
    ),
  );
  expect(html.match(new RegExp(`<h2[^>]*>${m.header_search_popular_realms()}</h2>`, 'g'))).toHaveLength(1);
  expect(html).toContain(m.search_facet_retry());
  expect(reads).toBe(0);
  // The same Content export is the presenter; Search does not own another card implementation.
  const section = renderToStaticMarkup(
    createElement(RealmDiscoverySection, {
      sort: 'popular',
      state: { kind: 'unavailable' },
      locale: 'en',
      onRetry() {},
    }),
  );
  expect(html).toContain(section);
  client.clear();
});

test('actual queries, selected filters and advanced conditions never turn into global Realm browsing', () => {
  expect(isRealmDiscoverySearch(empty)).toBe(true);
  const selections = [
    { q: 'a query' },
    { q: ' ' },
    { type: 'schema:Book' },
    { kinds: ['account'] },
    { language: ['ja'] },
    { filter: 'selected native scope' },
    { cursor: 'opaque' },
    { sort: 'rating' },
    { 'f.schema:inLanguage': ['en'] },
    { 'r.schema:wordCount': JSON.stringify({ gte: 10 }) },
    { condition: JSON.stringify({ type: { in: ['schema:Book'] } }) },
  ];
  const client = new QueryClient();
  for (const selection of selections) {
    const state = searchLoaderDeps(selection);
    expect(isRealmDiscoverySearch(state)).toBe(false);
    const html = renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SearchPage, {
          query: state.query,
          realmDiscovery: { kind: 'unavailable' },
          data: {
            queryState: state,
            condition: state.condition,
            ranges: state.ranges,
            ...(state.type ? { type: state.type } : {}),
            hitTypes: {},
            yearProperties: [],
            typeChoices: [],
            groups: [],
            selectedFacets: state.facets,
            selectedFacetLabels: {},
            facetsAvailable: false,
            facetRetry: false,
            facetIndexNotReady: false,
            staleCursorRestarted: false,
            sort: state.sort ?? 'relevance',
          },
        }),
      ),
    );
    expect(html).not.toContain(m.header_search_popular_realms());
    expect(html).toContain('name="q"');
    if (state.filter) expect(html).toContain('name="filter" value="selected native scope"');
    if (state.condition) expect(html).toContain('name="condition"');
  }
  client.clear();
});

test('each requested page uses one shared loader call and locale, sort and request caches stay isolated', async () => {
  const calls: Parameters<RealmDiscoveryReader>[0][] = [];
  const read: RealmDiscoveryReader = async (input) => {
    calls.push(input);
    return { kind: 'ready', realms: [], next: secondCursor };
  };
  const client = new QueryClient();
  try {
    const first = realmDiscoveryQueryOptions('en', 'popular', cursor, read);
    const page = await client.fetchQuery(first);
    expect(page).toEqual({ kind: 'ready', realms: [], next: secondCursor });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.data).toEqual({ locale: 'en', sort: 'popular', cursor });
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(first.retry).toBe(false);
    expect(first.refetchOnMount).toBe(false);
    expect(first.refetchOnWindowFocus).toBe(false);
    expect(first.refetchOnReconnect).toBe(false);
    const otherRequest = new QueryClient();
    expect(otherRequest.getQueryData(first.queryKey)).toBeUndefined();
    expect(client.getQueryData(realmDiscoveryQueryOptions('ja', 'popular', cursor).queryKey)).toBeUndefined();
    expect(client.getQueryData(realmDiscoveryQueryOptions('en', 'trending', cursor).queryKey)).toBeUndefined();
    expect(client.getQueryData(realmDiscoveryQueryOptions('en', 'popular', secondCursor).queryKey)).toBeUndefined();
    await client.fetchQuery(realmDiscoveryQueryOptions('en', 'popular', secondCursor, read));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.data.cursor).toBe(secondCursor);
    otherRequest.clear();
  } finally {
    client.clear();
  }
});

test('sparse pages advance explicitly, accepted pages replace the finite window, and failures retain it', () => {
  let window = fresh({ kind: 'ready', realms: [card], next: cursor });
  window = reduceRealmDiscovery(window, { kind: 'loading' });
  expect(window.pending).toBe(true);
  expect(window.state).toEqual({ kind: 'ready', realms: [card], next: cursor });
  window = reduceRealmDiscovery(window, { kind: 'ready', realms: [], next: secondCursor });
  expect(window.state).toEqual({ kind: 'ready', realms: [], next: secondCursor });
  window = reduceRealmDiscovery(window, { kind: 'unavailable' });
  expect(window.retry).toBe(true);
  expect(window.pending).toBe(false);
  expect(window.state).toEqual({ kind: 'ready', realms: [], next: secondCursor });
  window = reduceRealmDiscovery(window, { kind: 'loading' });
  window = reduceRealmDiscovery(window, { kind: 'ready', realms: [{ ...card, name: 'Current title' }], next: null });
  expect(window.retry).toBe(false);
  expect(window.state).toEqual({ kind: 'ready', realms: [{ ...card, name: 'Current title' }], next: null });
  expect(fresh({ kind: 'ready', realms: [], next: cursor }).state).toEqual({ kind: 'ready', realms: [], next: cursor });
  expect(reduceRealmDiscovery(window, { kind: 'closed' }).state).toEqual({ kind: 'closed' });
});

test('the original Content adapter never adds per-row hydration and an absent producer stays unavailable', async () => {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      return Response.json({ realms: [card], next: secondCursor });
    },
  });
  const state = await loadRealmDiscovery(client, { sort: 'popular', cursor, limit: 20 });
  if (calls.length === 0) {
    // The brief explicitly admits the temporary original-module unavailable boundary until Content lands.
    expect(state).toEqual({ kind: 'unavailable' });
  } else {
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('GET');
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/v1/realms/discovery');
    expect(url.searchParams.get('sort')).toBe('popular');
    expect(url.searchParams.get('cursor')).toBe(cursor);
    expect(url.searchParams.get('limit')).toBe('20');
    expect(state).toEqual({ kind: 'ready', realms: [card], next: secondCursor });
  }
});
