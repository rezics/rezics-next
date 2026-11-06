import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { discoveryExample } from '../src/kernel/fake/search-discovery';
import { loadRealmDiscovery } from '../src/community/realm-discovery/source';
import { discoveryRequest } from '../src/search/search-request';
import { headerSearchFields } from '../src/search/header-search/header-search';
import { readFacetPage } from '../src/search/refinement/request';
import { realmCatalogueWindow } from '../src/search/realm-catalogue-window';
import { searchLoaderDeps } from '../src/search/search-params';
import {
  nativeSearchCheckpoint,
  nativeSearchObservation,
  readSearchOutcome,
  suggestionFailureFromSearchRecovery,
  searchRecoveryFromResponse,
  searchUnavailablePage,
} from '../src/search/search-recovery';
import { searchRetryOwnerCurrent } from '../src/search/search-retry-focus';
import {
  searchStateForScopeRestart,
  searchStateWithoutScope,
  withoutRetiredScopeFacets,
} from '../src/search/search-scope-restart';
import { reduceRealmDiscovery } from '../src/search/realm-discovery-loader';
import { suggestionFailure } from '../src/search/typeahead';
import { readSubjectSuggestions } from '../src/search/suggestions';
import { requestLanguages } from '../src/kernel/languages';
import type { SearchPageData } from '../src/search/search';

const realmId = '5a522c45-d94f-4d36-8b2a-3af80d988cff';
const filter = JSON.stringify({ realm: { id: realmId } });
const state = searchLoaderDeps({
  q: 'maps',
  filter,
  cursor: 'opaque-next',
  'f.schema:inLanguage': ['ja'],
});
const request = discoveryRequest(state, ['en']);
const card = {
  realmId: '01a1a000-0000-7000-8000-000000000002',
  spaceId: '01a1a000-0000-7000-8000-000000000001',
  name: 'A public Realm',
  description: 'A native summary',
  avatar: null,
};

function problem(status: number, code: string, extra?: Record<string, unknown>) {
  return createKernelClient('http://kernel.local', {
    headers: { authorization: 'Bearer original-session' },
    fetch: async () => Response.json({ code, ...extra }, { status, headers: { 'retry-after': '2' } }),
  });
}

test('installed Search, suggest and facet readers consume the same native HTTP families', async () => {
  const cases = [
    [
      400,
      'invalid_request',
      { errors: [{ pointer: '/text', code: 'invalid_format' }] },
      'invalid',
      'invalid',
      'invalid',
    ],
    [401, 'invalid_credentials', {}, 'session', 'credentials', 'unavailable'],
    [403, 'platform_closed', {}, 'closed', 'closed', 'refused'],
    [403, 'forbidden', {}, 'denied', 'unavailable', 'refused'],
    [409, 'search_restart_required', {}, 'restart', 'restart', 'restart'],
    [503, 'index_not_ready', {}, 'index-not-ready', 'preparing', 'preparing'],
    [503, 'semantic_not_ready', {}, 'source-not-ready', 'preparing', 'preparing'],
    [503, 'overloaded', {}, 'unavailable', 'unavailable', 'unavailable'],
  ] as const;
  for (const [status, code, extra, searchStatus, suggestStatus, facetStatus] of cases) {
    const client = problem(status, code, extra);
    const outcome = await readSearchOutcome(request, (body) => client.subjects.$search.post(body));
    expect(outcome.recovery.status).toBe(searchStatus);
    expect(outcome.discovery).toBeUndefined();
    expect(suggestionFailure(status, code)).toBe(suggestStatus);
    const facets = await readFacetPage(
      { text: 'maps', languages: ['en'], facets: [{ property: 'type', size: 10 }] },
      (body) => client.subjects.$facets.post(body),
    );
    expect(facets.status).toBe(facetStatus);
    if (facets.status === 'ready') throw new Error('A native refusal became facet success');
  }
  const preparing = suggestionFailureFromSearchRecovery(
    searchRecoveryFromResponse({ status: 503, error: { code: 'semantic_not_ready' } }),
    503,
  );
  expect(preparing).toBe('preparing');
});

test('typeahead and result readers bind Retry-After and never publish ready from a native refusal', async () => {
  const client = problem(503, 'semantic_not_ready');
  const before = Date.now();
  await expect(
    readSubjectSuggestions(
      client,
      { q: 'maps', limit: 8, languages: requestLanguages('en') },
      null,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ problem: { status: 503, code: 'semantic_not_ready' } });
  const outcome = await readSearchOutcome(request, (body) => client.subjects.$search.post(body));
  if (outcome.recovery.status === 'ready') throw new Error('A native refusal became success');
  expect(outcome.recovery.status).toBe('source-not-ready');
  expect(outcome.recovery.retryAt).toBeGreaterThanOrEqual(before + 2000);
});

test('empty terminal pages stay distinct from failed continuations that keep the admitted window', async () => {
  const empty = { ...discoveryExample, hits: [], next: null };
  const client = createKernelClient('http://kernel.local', {
    fetch: async () => Response.json(empty),
  });
  const first = await readSearchOutcome({ ...request, cursor: undefined }, (body) =>
    client.subjects.$search.post(body),
  );
  expect(first.recovery.status).toBe('ready');
  expect(nativeSearchObservation(first)).toEqual(expect.objectContaining({ hits: [], next: null }));
  expect(nativeSearchCheckpoint(first)).toBe(discoveryExample.as_of);
  const continuation = await readSearchOutcome(request, (body) => client.subjects.$search.post(body));
  expect(continuation.recovery.status).toBe('exhausted');

  const previous = {
    ...searchUnavailablePage(state),
    result: { subjects: [{ id: 'kept' }], next: 'next', as_of: 'cut', kinds: { values: [], next: null } },
  } as SearchPageData;
  const failed = { ...searchUnavailablePage(state), recovery: { status: 'unavailable' as const } };
  const retained = realmCatalogueWindow(failed, previous);
  expect(retained.result?.subjects).toEqual([{ id: 'kept' }]);
  expect(retained.result?.next).toBeNull();
  expect(retained.result?.kinds).toBeUndefined();
});

test('a new resource scope retires prior facets and cursors on Search and header GET', () => {
  const nextFilter = JSON.stringify({ collection: { id: '438cb7b1-e7a2-4a40-831e-a90b1b143264' } });
  const restarted = searchStateForScopeRestart(state, {
    filter: nextFilter,
    resourceScope: { kind: 'collection', id: '438cb7b1-e7a2-4a40-831e-a90b1b143264' },
  });
  expect(restarted.facets).toEqual({});
  expect(restarted.cursor).toBeUndefined();
  expect(restarted.query).toBe('maps');
  expect(searchStateWithoutScope(state).facets).toEqual({});
  expect(searchStateWithoutScope(state).cursor).toBeUndefined();
  expect(searchStateWithoutScope(state).resourceScope).toBeUndefined();
  expect(
    withoutRetiredScopeFacets(
      [
        ['language', 'ja'],
        ['f.schema:inLanguage', 'ja'],
      ],
      { kind: 'realm', id: realmId },
      undefined,
    ),
  ).toEqual([['language', 'ja']]);
  expect(
    headerSearchFields(
      [
        ['q', 'maps'],
        ['filter', filter],
        ['f.schema:inLanguage', 'ja'],
        ['language', 'ja'],
      ],
      undefined,
      '/en/search',
    ),
  ).toEqual([['language', 'ja']]);
  expect(
    headerSearchFields(
      [
        ['filter', filter],
        ['f.schema:inLanguage', 'ja'],
        ['language', 'ja'],
      ],
      { kind: 'Realm', id: realmId, name: 'Anime' },
      '/en/search',
    ),
  ).toEqual([
    ['f.schema:inLanguage', 'ja'],
    ['language', 'ja'],
    ['filter', filter],
  ]);
});

test('retry focus binds to the native page, reader and locale of the executed request', () => {
  const page = discoveryExample;
  const owner = {
    scope: JSON.stringify(['maps', 'en', null]),
    locale: 'en',
    session: 'one',
    checkpoint: page.as_of,
    observation: page,
    reader: 'reader-a',
  };
  expect(searchRetryOwnerCurrent(owner, owner)).toBe(true);
  expect(searchRetryOwnerCurrent(owner, { ...owner, locale: 'ja' })).toBe(false);
  expect(searchRetryOwnerCurrent(owner, { ...owner, reader: 'reader-b' })).toBe(false);
  expect(searchRetryOwnerCurrent(owner, { ...owner, observation: { ...page } })).toBe(false);
  expect(searchRetryOwnerCurrent(owner, { ...owner, checkpoint: 'other' })).toBe(false);
});

test('Realm More, Retry and Restart consume native Content HTTP and keep the admitted twenty-row window', async () => {
  const calls: URL[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input) => {
      const url = new URL(String(input));
      calls.push(url);
      if (url.searchParams.get('cursor') === 'next-page')
        return Response.json({ code: 'search_restart_required' }, { status: 409 });
      if (url.searchParams.get('fail') === 'unavailable')
        return Response.json({ code: 'index_not_ready' }, { status: 503, headers: { 'retry-after': '1' } });
      return Response.json({ realms: [card], next: 'next-page' });
    },
  });
  const ready = await loadRealmDiscovery(client, { sort: 'popular', limit: 20 });
  expect(ready).toEqual({ kind: 'ready', realms: [card], next: 'next-page' });
  expect(calls[0]!.pathname).toBe('/v1/realms/discovery');
  expect(calls[0]!.searchParams.get('limit')).toBe('20');

  let window = reduceRealmDiscovery(
    { state: { kind: 'loading' }, pending: false, retry: false, restart: false },
    ready,
  );
  expect(window.state).toEqual(ready);

  const unavailable = createKernelClient('https://kernel.test', {
    fetch: async () => Response.json({ code: 'index_not_ready' }, { status: 503, headers: { 'retry-after': '1' } }),
  });
  const retryPage = await loadRealmDiscovery(unavailable, { sort: 'popular', cursor: 'next-page', limit: 20 });
  expect(retryPage).toEqual({ kind: 'unavailable' });
  window = reduceRealmDiscovery(window, retryPage);
  expect(window.retry).toBe(true);
  expect(window.restart).toBe(false);
  expect(window.state).toEqual(ready);

  const restartPage = await loadRealmDiscovery(client, { sort: 'popular', cursor: 'next-page', limit: 20 });
  expect(restartPage).toEqual({ kind: 'restart' });
  window = reduceRealmDiscovery(window, restartPage);
  expect(window.retry).toBe(true);
  expect(window.restart).toBe(true);
  expect(window.state).toEqual(ready);
});
