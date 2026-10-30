import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readQueryKey } from '../src/kernel/query';
import { m } from '../src/paraglide/messages.js';
import type { SessionEnv } from '../src/session/client';
import type { SessionStore } from '../src/session/store';

mock.module('cloudflare:workers', () => ({ env: {} }));

const [
  { loadMineCollectionsForOwner },
  { PersonalLibraryPage },
  { loadPersonalLibrary, changePersonalLibraryEntry },
  { readLibraryPins },
  { CollectionFilterFeedback, CollectionFilters },
  { SubjectLibrarySlot },
] = await Promise.all([
  import('../src/library/mine-collections'),
  import('../src/library/entries-page'),
  import('../src/library/entries-read'),
  import('../src/library/pins-read'),
  import('../src/library/collection-filters'),
  import('../src/library/subject-slot-view'),
]);

const sessionId = 'a'.repeat(43);
const subjectId = '0192f3a0-6c1e-7b2a-9d4e-000000000001';
const stamp = '2026-10-29T08:00:00.000Z';
const incarnationId = '0192f3a0-6c1e-7b2a-9d4e-000000000002';

function sessionEnv(): Partial<SessionEnv> {
  const session = {
    credential: async () => ({
      status: 'active' as const,
      subject: 'reader',
      accessToken: 'fresh-token',
      csrfToken: 'csrf-token',
    }),
    signedIn: async () => ({ signedIn: true, subject: 'reader', csrfToken: 'csrf-token' }),
    create: async () => undefined,
    takeLogin: async () => undefined,
    end: async () => undefined,
  };
  return {
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'https://api.example.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'rezics-web-personal-space',
    WEBSITE_CLIENT_KEY: 'unused-by-this-read',
    SITE_ORIGINS: 'https://site.example.test',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => session,
    } as unknown as DurableObjectNamespace<SessionStore>,
  };
}

function pageRequest(path = '/en/library') {
  return new Request(`https://site.example.test${path}`, {
    headers: { cookie: `__Host-rezics_session=${sessionId}` },
  });
}

function fakeKernel() {
  const calls: { method: string; path: string; query: URLSearchParams; body: unknown; authorization: string | null }[] =
    [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const body =
        request.method === 'GET'
          ? null
          : await request
              .clone()
              .json()
              .catch(() => null);
      calls.push({
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        body,
        authorization: request.headers.get('authorization'),
      });

      if (url.pathname === '/v1/openapi/json')
        return Response.json({
          paths: {
            '/v1/libraryPins': { get: { operationId: 'library_pin.list' } },
            '/v1/libraryPins/{collectionId}': {
              put: { operationId: 'library_pin.put' },
              delete: { operationId: 'library_pin.delete' },
            },
          },
        });
      if (url.pathname === '/v1/libraryPins')
        return Response.json({
          pins: [
            { collectionId: 'unavailable-pin', target: null },
            {
              collectionId: 'curated-pin',
              target: { id: 'curated-pin', title: 'Curated shelf', membershipKind: 'curated' },
            },
          ],
          revision: 9,
          next: null,
        });
      if (url.pathname === '/v1/collections')
        return Response.json({
          collections: [
            {
              id: 'builtin-everything',
              title: null,
              curatorAccountId: 'reader',
              membershipKind: 'dynamic',
              builtinKind: 'everything',
              curator: null,
            },
            {
              id: 'builtin-liked',
              title: null,
              curatorAccountId: 'reader',
              membershipKind: 'dynamic',
              builtinKind: 'liked',
              curator: null,
            },
            {
              id: 'builtin-state',
              title: null,
              curatorAccountId: 'reader',
              membershipKind: 'dynamic',
              builtinKind: 'state',
              builtinLabels: { en: 'Reading now' },
              curator: null,
            },
          ],
          next: null,
        });
      if (url.pathname === '/v1/libraryEntries' && request.method === 'GET')
        return Response.json({
          libraryEntries: [
            {
              subjectId,
              state: 'queued_next.v2',
              revision: 4,
              incarnationId,
              createdAt: stamp,
              updatedAt: stamp,
              subject: {
                id: subjectId,
                type: 'schema:Book',
                types: ['schema:Book'],
                label: 'A New Queue',
                cover: null,
              },
            },
          ],
          next: null,
        });
      if (url.pathname === `/v1/libraryEntries/${subjectId}` && request.method === 'PUT')
        return Response.json({
          libraryEntry: {
            subjectId,
            state: 'reading_now',
            revision: 5,
            incarnationId,
            createdAt: stamp,
            updatedAt: stamp,
          },
        });
      throw new Error(`unexpected fake kernel request: ${request.method} ${url.pathname}`);
    }) as typeof fetch,
  });
  return { client, calls };
}

test('Library composes actual owner Collections and bounded pin targets into Collection tabs', async () => {
  const { client, calls } = fakeKernel();
  const [pins, owner] = await Promise.all([
    readLibraryPins(client, 'Bearer fresh-token', 8),
    loadMineCollectionsForOwner(client, 'reader', 'Bearer fresh-token'),
  ]);
  expect(pins.state).toBe('loaded');
  if (pins.state !== 'loaded') throw new Error('expected a pins response');
  expect(owner.collections.map(({ builtinKind }) => builtinKind)).toEqual(['everything', 'liked', 'state']);

  const queryClient = new QueryClient();
  queryClient.setQueryData(readQueryKey(['library-navigation', 'en', 8], 'session'), {
    pins,
    collections: owner.collections,
  });
  const page = {
    signedIn: true as const,
    state: 'queued_next.v2',
    stateLabel: 'Queued next',
    entries: [],
    next: null,
  };
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(PersonalLibraryPage, {
        page,
        locale: 'en',
        display: { layout: 'grid', size: 'l' },
        continueEntries: [
          {
            subjectId,
            label: 'Continue title',
            summary: { id: subjectId, type: 'schema:Book', types: ['schema:Book'], label: 'Continue title' },
            progress: null,
            stateLabel: 'Reading now',
          },
        ],
      }),
    ),
  );

  expect(html).toContain('Continue title');
  expect(html).toContain('Reading now');
  expect(html).toContain('sm:[&amp;&gt;*]:w-[9rem]');
  expect(html).toContain('Tracked entries');
  expect(html).toContain('Everything');
  expect(html).toContain('href="/en/collections/builtin-everything"');
  expect(html).toContain('Liked');
  expect(html).toContain('href="/en/collections/builtin-liked"');
  expect(html).toContain('Curated shelf');
  expect(html).toContain(m.library_pin_unavailable());
  expect(html).not.toContain('href="/en/collections/unavailable-pin"');
  expect(html).not.toContain('href="/en/collections/builtin-state"');
  expect(html).toContain('aria-current="page"');
  expect(html).not.toContain('/en/library?state=planned');
  expect(calls.filter((call) => call.path === '/v1/libraryPins')).toHaveLength(1);
  expect(calls.filter((call) => call.path === '/v1/collections')).toHaveLength(1);
  expect(calls.some((call) => call.path.startsWith('/v1/collections/'))).toBe(false);
  queryClient.clear();
});

test('Collection filters begin behind one responsive menu trigger without exposing property IDs', () => {
  const html = renderToStaticMarkup(
    createElement(CollectionFilters, {
      id: 'curated-collection',
      type: 'schema:Book',
      properties: [
        { id: 'wdt:P50', label: 'Author', datatype: 'wikibase-item', targets: ['schema:Person'] },
        { id: 'wdt:P577', label: 'Publication date', datatype: 'quantity' },
      ],
      params: { selected: {}, selectedLabels: {}, ranges: {}, ignored: [] },
    }),
  );

  expect(html).toContain(m.collection_filters());
  expect(html).not.toMatch(/>wdt:P(?:50|577)</);
  expect(html).not.toContain('Concept ID');
});

test('an existing entry without profile states stays visible as Other and can be removed', () => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(['exposure', 'anonymous'], ['personal_library']);
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(SubjectLibrarySlot, {
        subject: { id: subjectId, type: 'schema:Unconfigured', label: 'Unconfigured subject' },
        locale: 'en',
        data: {
          session: 'signed-in',
          csrfToken: 'csrf-token',
          entryAvailable: true,
          entry: { subjectId, state: 'kept_state', revision: 3, incarnationId },
          stateOptions: [],
          entryStateLabel: m.library_other(),
          publicCollections: null,
          publicCollectionsNext: null,
          collectionsLoaded: false,
          collections: null,
          labels: null,
        },
      }),
    ),
  );

  expect(html).toContain('data-library-entry-state');
  expect(html).toContain(m.library_other());
  expect(html).toContain(m.library_subject_remove());
  expect(html).not.toContain(`aria-label="${m.library_subject_entry()}"`);
  queryClient.clear();
});

test('a failed filter source does not show unfiltered members as filtered results', () => {
  const html = renderToStaticMarkup(
    createElement(CollectionFilterFeedback, {
      id: 'curated-collection',
      filterType: 'schema:Book',
      status: 'failed',
      empty: true,
      emptyLabel: 'Collection is empty.',
    }),
  );

  expect(html).toContain(m.collection_filter_failed());
  expect(html).toContain('href="/en/collections/curated-collection?type=schema%3ABook"');
  expect(html).not.toContain('Collection is empty.');
});

test('a profile state remains an exact bounded filter and writes carry the freshly read incarnation', async () => {
  const { client, calls } = fakeKernel();
  const view = await loadPersonalLibrary(
    client,
    pageRequest('/en/library?state=queued_next.v2&cursor=next'),
    sessionEnv(),
    {
      state: 'queued_next.v2',
      cursor: 'next',
    },
  );
  expect(view.signedIn).toBe(true);
  if (!view.signedIn) throw new Error('expected a signed-in library');
  expect(view.state).toBe('queued_next.v2');
  expect(view.entries[0]).toMatchObject({ subjectId, state: 'queued_next.v2', incarnationId });
  const list = calls.find((call) => call.path === '/v1/libraryEntries' && call.method === 'GET');
  expect(list?.query.get('state')).toBe('queued_next.v2');
  expect(list?.query.get('cursor')).toBe('next');
  expect(list?.query.get('limit')).toBe('100');

  const saved = await changePersonalLibraryEntry(client, pageRequest(), sessionEnv(), {
    subjectId,
    state: 'reading_now',
    revision: 4,
    incarnationId: view.entries[0]!.incarnationId,
    idempotencyKey: '0192f3a0-6c1e-7b2a-9d4e-000000000003',
  });
  expect(saved).toMatchObject({ ok: true, entry: { state: 'reading_now', revision: 5, incarnationId } });
  const write = calls.find((call) => call.path === `/v1/libraryEntries/${subjectId}` && call.method === 'PUT');
  expect(write?.body).toMatchObject({ state: 'reading_now', revision: 4, incarnationId });
  expect(write?.authorization).toBe('Bearer fresh-token');
});
