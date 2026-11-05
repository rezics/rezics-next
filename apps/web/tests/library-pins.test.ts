import { afterAll, expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { m } from '../src/paraglide/messages.js';
import { builtinCollectionDestinations } from '../src/library/builtin-collections';
import { LibraryNavigation } from '../src/library/library-nav';
import { PlatformClosedError } from '../src/kernel/platform-closed';
import { operationIsAdmitted } from '../src/kernel/exposure';

mock.module('cloudflare:workers', () => ({ env: {} }));
afterAll(() => mock.restore());
const { libraryPinsListExposed, loadLibraryNavigation, readLibraryPins } = await import('../src/library/pins-read');
const { deleteLibraryPin, putLibraryPin } = await import('../src/library/pins-actions');

const collection = (id: string, title: string, builtinKind?: 'everything' | 'liked' | 'state') => ({
  id,
  title,
  membershipKind: builtinKind ? ('dynamic' as const) : ('curated' as const),
  ...(builtinKind ? { builtinKind } : {}),
});

test('Native personal-library admission and exact OpenAPI pin capability together expose only supported own pin controls including removal of unavailable targets', async () => {
  for (const operation of ['library_pin.list', 'library_pin.put', 'library_pin.delete'] as const) {
    expect(operationIsAdmitted(operation, ['personal_library'])).toBe(true);
    for (const groups of [undefined, [], ['collections'], [operation]])
      expect(operationIsAdmitted(operation, groups)).toBe(false);
  }
  for (const operation of ['library_label.list', 'library_continue.list', 'library_entry.restore'] as const)
    expect(operationIsAdmitted(operation, ['personal_library'])).toBe(false);

  const list = { get: { operationId: 'library_pin.list' } };
  const put = { operationId: 'library_pin.put' };
  const remove = { operationId: 'library_pin.delete' };
  const retained = { collectionId: 'retained-unavailable', target: null };
  const cases = [
    { item: { put, delete: remove }, canUpdate: true, canRemove: true },
    { item: { put }, canUpdate: true, canRemove: false },
    { item: { delete: remove }, canUpdate: false, canRemove: true },
    { item: {}, canUpdate: false, canRemove: false },
    { item: { post: put, patch: remove }, canUpdate: false, canRemove: false },
    { item: { put: remove, delete: put }, canUpdate: false, canRemove: false },
    {
      item: { put: { operationId: 'collection.update' }, delete: { operationId: 'collection.delete' } },
      canUpdate: false,
      canRemove: false,
    },
  ];
  for (const { item, canUpdate, canRemove } of cases) {
    const calls: string[] = [];
    let revision = 7;
    let pins = [retained];
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        calls.push(`${request.method} ${url.pathname}`);
        expect(request.headers.get('authorization')).toBe('Bearer viewer');
        if (request.method === 'GET' && url.pathname === '/v1/openapi.json')
          return Response.json({ paths: { '/v1/libraryPins': list, '/v1/libraryPins/{collectionId}': item } });
        if (request.method === 'GET' && url.pathname === '/v1/libraryPins')
          return Response.json({ pins, revision, next: null });
        if (request.method === 'DELETE' && url.pathname === '/v1/libraryPins/retained-unavailable') {
          expect(url.searchParams.get('revision')).toBe('7');
          expect(request.headers.get('idempotency-key')).toBe(JSON.stringify('remove-retained'));
          pins = [];
          return Response.json({ revision: ++revision });
        }
        throw new Error(`Unexpected pin request: ${request.method} ${url.pathname}`);
      }) as typeof fetch,
    });
    const read = await readLibraryPins(client, 'Bearer viewer', 100);
    expect(read).toEqual({ state: 'loaded', pins: [retained], revision: 7, next: null, canUpdate, canRemove });
    expect(calls).toEqual(['GET /v1/openapi.json', 'GET /v1/libraryPins']);
    const html = renderToStaticMarkup(
      createElement(LibraryNavigation, { current: 'collections', pins: read, collections: [] }),
    );
    expect(html).toContain(m.library_pin_unavailable());
    expect(html).not.toContain('href="/en/collections/retained-unavailable"');
    if (canRemove) {
      expect(await deleteLibraryPin(client, 'Bearer viewer', retained.collectionId, 7, 'remove-retained')).toEqual({
        ok: true,
        revision: 8,
      });
      expect(await readLibraryPins(client, 'Bearer viewer', 100)).toMatchObject({
        state: 'loaded',
        pins: [],
        revision: 8,
      });
      expect(calls).toEqual([
        'GET /v1/openapi.json',
        'GET /v1/libraryPins',
        'DELETE /v1/libraryPins/retained-unavailable',
        'GET /v1/openapi.json',
        'GET /v1/libraryPins',
      ]);
    }
  }

  for (const paths of [
    {},
    { '/v1/libraryPins': { post: { operationId: 'library_pin.list' } } },
    { '/v1/libraryPins': { get: { operationId: 'collection.list' } } },
  ]) {
    const calls: string[] = [];
    const client = createKernelClient('https://kernel.example.test', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        calls.push(new URL(request.url).pathname);
        return Response.json({ paths });
      }) as typeof fetch,
    });
    expect(await readLibraryPins(client, 'Bearer viewer', 100)).toEqual({ state: 'closed' });
    expect(calls).toEqual(['/v1/openapi.json']);
  }
});

test('the navigation exposes only actual Everything and Liked records beside tracked entries', () => {
  const builtins = builtinCollectionDestinations([
    collection('curated', 'Reading list'),
    collection('everything', 'Everything', 'everything'),
    collection('liked', 'Liked', 'liked'),
    collection('state', 'In progress', 'state'),
  ]);
  expect(builtins).toEqual([
    { id: 'everything', title: 'Everything', kind: 'everything' },
    { id: 'liked', title: 'Liked', kind: 'liked' },
  ]);
  expect(builtinCollectionDestinations([collection('curated', 'Reading list')])).toEqual([]);
});

test('a missing list operation makes no pins request, while a failed read is not an empty list', async () => {
  const calls: string[] = [];
  const client = {
    'openapi.json': { get: async () => ({ data: { paths: {} } }) },
    libraryPins: { get: async () => (calls.push('pins'), { data: { pins: [], revision: 0, next: null } }) },
  };
  expect(libraryPinsListExposed({ paths: {} })).toBe(false);
  const unavailable = await readLibraryPins(client as never, 'Bearer viewer', 8);
  expect(unavailable).toEqual({ state: 'closed' });
  expect(calls).toEqual([]);

  const exposed = {
    'openapi.json': {
      get: async () => ({
        data: { paths: { '/v1/libraryPins': { get: { operationId: 'library_pin.list' } } } },
      }),
    },
    libraryPins: { get: async () => ({ error: { status: 503 } }) },
  };
  expect(await readLibraryPins(exposed as never, 'Bearer viewer', 8)).toEqual({ state: 'unavailable' });
});

test('Pins reads keep permission, closure, preparation and transport distinct', async () => {
  const document = { paths: { '/v1/libraryPins': { get: { operationId: 'library_pin.list' } } } };
  const scenarios = [
    ['openapi', { error: { status: 403 } }, { state: 'denied' }],
    [
      'openapi',
      { error: { status: 403, value: { code: 'platform_closed' } } },
      { state: 'closed', platformClosed: true },
    ],
    ['list', { error: { status: 403 } }, { state: 'denied' }],
    ['list', { error: { status: 403, value: { code: 'platform_closed' } } }, { state: 'closed', platformClosed: true }],
    ['list', new PlatformClosedError(403, { code: 'platform_closed' }), { state: 'closed', platformClosed: true }],
    ['list', { status: 202 }, { state: 'preparing' }],
    ['openapi', new TypeError('fetch failed'), { state: 'unavailable' }],
    ['list', new TypeError('fetch failed'), { state: 'unavailable' }],
    ['list', new Error('unexpected client error'), 'throws'],
  ] as const;
  for (const [stage, response, expected] of scenarios) {
    const calls: string[] = [];
    const client = {
      'openapi.json': {
        get: async () => {
          calls.push('openapi');
          if (stage !== 'openapi') return { data: document };
          if (response instanceof Error) throw response;
          return response;
        },
      },
      libraryPins: {
        get: async () => {
          calls.push('pins');
          if (stage !== 'list') throw new Error('Pins read after OpenAPI refusal');
          if (response instanceof Error) throw response;
          return response;
        },
      },
    };
    const read = readLibraryPins(client as never, 'Bearer viewer', 8);
    if (expected === 'throws') await expect(read).rejects.toThrow('unexpected client error');
    else expect(await read).toEqual(expected);
    expect(calls).toEqual(stage === 'openapi' ? ['openapi'] : ['openapi', 'pins']);
  }
});

test('pins use their returned current targets; an unavailable target has no title or destination', () => {
  const html = renderToStaticMarkup(
    createElement(LibraryNavigation, {
      current: 'tracked',
      pins: {
        state: 'loaded',
        revision: 3,
        next: null,
        pins: [
          {
            collectionId: 'readable',
            target: { id: 'readable', title: 'Readable collection', membershipKind: 'curated' },
          },
          { collectionId: 'unavailable', target: null },
        ],
      },
      collections: [],
    }),
  );
  expect(html).toContain('Tracked entries');
  expect(html).toContain('Readable collection');
  expect(html.toLowerCase()).toContain(m.library_pin_unavailable().toLowerCase());
  expect(html).not.toContain('href="/en/collections/unavailable"');
  expect(html).toContain('aria-current="page"');
});

test('pin writes carry the last list revision and place a move after its anchor', async () => {
  const calls: { method: string; id: string; revision?: number; after?: string | null }[] = [];
  const client = {
    libraryPins: ({ collectionId }: { collectionId: string }) => ({
      put: async (body: { revision: number; after?: string | null }) => {
        calls.push({ method: 'PUT', id: collectionId, ...body });
        return { data: { revision: body.revision + 1 } };
      },
      delete: async (_body: undefined, options: { query: { revision: number } }) => {
        calls.push({ method: 'DELETE', id: collectionId, revision: options.query.revision });
        return { status: 204 };
      },
    }),
  };
  await putLibraryPin(client as never, 'Bearer viewer', 'moved', 8, 'behind', 'key');
  await putLibraryPin(client as never, 'Bearer viewer', 'first', 9, null, 'key-2');
  await deleteLibraryPin(client as never, 'Bearer viewer', 'removed', 10, 'key-3');
  expect(calls).toEqual([
    { method: 'PUT', id: 'moved', revision: 8, after: 'behind' },
    { method: 'PUT', id: 'first', revision: 9, after: null },
    { method: 'DELETE', id: 'removed', revision: 10 },
  ]);
});

test('native Pin adapters distinguish refusals from uncertainty and preserve exact operands', async () => {
  const key = '123e4567-e89b-42d3-a456-426614174000';
  const cases = [
    [{ error: { status: 401 } }, 'signed-out', 'signed-out'],
    [{ status: 403 }, 'denied', 'denied'],
    [{ status: 403, error: { value: { code: 'platform_closed' } } }, 'closed', 'closed'],
    [{ status: 409 }, 'conflict', 'conflict'],
    [{ status: 409, error: { value: { code: 'collection_full' } } }, 'full', 'conflict'],
    [new PlatformClosedError(403, { code: 'platform_closed' }), 'closed', 'closed'],
    [{ status: 503 }, 'unavailable', 'unavailable'],
    [new Error('response lost'), 'unavailable', 'unavailable'],
  ] as const;
  for (const operation of ['put', 'delete'] as const)
    for (const [reply, putReason, deleteReason] of cases) {
      const sent: unknown[] = [];
      const send = async (...args: unknown[]) => {
        sent.push(...args);
        if (reply instanceof Error) throw reply;
        return reply;
      };
      const client = {
        libraryPins: ({ collectionId }: { collectionId: string }) => (
          sent.push(collectionId),
          { put: send, delete: send }
        ),
      };
      const result =
        operation === 'put'
          ? await putLibraryPin(client as never, 'Bearer viewer', 'collection', 23, 'anchor', key)
          : await deleteLibraryPin(client as never, 'Bearer viewer', 'collection', 23, key);
      expect(result).toEqual({ ok: false, reason: operation === 'put' ? putReason : deleteReason });
      expect(sent.slice(0, 2)).toEqual([
        'collection',
        operation === 'put' ? { revision: 23, after: 'anchor' } : undefined,
      ]);
      expect(sent[2]).toMatchObject({
        headers: { authorization: 'Bearer viewer', 'idempotency-key': JSON.stringify(key) },
        ...(operation === 'delete' ? { query: { revision: 23 } } : {}),
      });
    }
});

test('the first-page pins read remains one request for 0, 8, and 100 pins', async () => {
  for (const count of [0, 8, 100]) {
    const paths: string[] = [];
    const client = {
      'openapi.json': {
        get: async () => ({
          data: {
            paths: {
              '/v1/libraryPins': { get: { operationId: 'library_pin.list' } },
              '/v1/libraryPins/{collectionId}': {
                put: { operationId: 'library_pin.put' },
                delete: { operationId: 'library_pin.delete' },
              },
            },
          },
        }),
      },
      libraryPins: {
        get: async ({ query }: { query: { limit: number } }) => {
          paths.push(`/v1/libraryPins?limit=${query.limit}`);
          return {
            data: {
              pins: Array.from({ length: Math.min(count, query.limit) }, (_, index) => ({
                collectionId: `c${index}`,
                target: { id: `c${index}`, title: `Collection ${index}`, membershipKind: 'curated' },
              })),
              revision: 2,
              next: count > query.limit ? 'more' : null,
            },
          };
        },
      },
    };
    const pins = await readLibraryPins(client as never, 'Bearer viewer', 8);
    const rendered = renderToStaticMarkup(
      createElement(LibraryNavigation, { current: 'tracked', pins, collections: [] }),
    );
    expect(paths).toEqual(['/v1/libraryPins?limit=8']);
    expect((rendered.match(/\/v1\/collections\//g) ?? []).length).toBeLessThanOrEqual(8);
    expect(rendered).toContain('All Collections');
  }
});

test('the Collection tab bar is bounded to eight pins and the phone shows at most three beside one selector', () => {
  const pins = {
    state: 'loaded' as const,
    revision: 2,
    next: 'more',
    pins: Array.from({ length: 8 }, (_, index) => ({
      collectionId: `c${index}`,
      target: { id: `c${index}`, title: `Collection ${index}`, membershipKind: 'curated' as const },
    })),
  };
  const html = renderToStaticMarkup(createElement(LibraryNavigation, { current: 'tracked', pins, collections: [] }));
  const tabsStart = html.indexOf('data-library-navigation-desktop');
  const tabsEnd = html.indexOf('</nav>', tabsStart);
  const tabs = html.slice(tabsStart, tabsEnd);
  expect((tabs.match(/data-library-pin=/g) ?? []).length).toBe(8);
  expect((tabs.match(/href="\/en\/library\/collections"/g) ?? []).length).toBe(1);
  expect(html).toContain('data-library-navigation-phone');
  expect((html.slice(html.indexOf('data-library-navigation-phone')).match(/data-library-pin=/g) ?? []).length).toBe(3);
  expect(html).toContain(`aria-label="${m.library_nav_selector()}"`);
  expect(html).toContain('aria-current="page"');
});

test('no pins shows only tracked entries and All Collections, while a failed pins read reports unavailable once', () => {
  const empty = renderToStaticMarkup(
    createElement(LibraryNavigation, {
      current: 'tracked',
      pins: { state: 'loaded', revision: 4, next: null, pins: [] },
      collections: [],
    }),
  );
  expect(empty).toContain(m.library_nav_tracked_entries());
  expect(empty).toContain(m.library_nav_all_collections());
  expect(empty).not.toContain(m.library_pin_pinned_section());

  const failed = renderToStaticMarkup(
    createElement(LibraryNavigation, { current: 'tracked', pins: { state: 'unavailable' }, collections: [] }),
  );
  expect(failed).toContain(m.library_pin_read_failed());
  expect(failed).not.toContain(m.library_pin_pinned_section());
  expect(failed).not.toContain(m.library_pin_actions());
});

test('the library navigation reads one first page of pins and owner Collections, with no per-Collection read', async () => {
  for (const count of [0, 8, 100]) {
    const pinsReads: number[] = [];
    const collectionQueries: unknown[] = [];
    const collectionItemReads: string[] = [];
    const client = {
      'openapi.json': {
        get: async () => ({
          data: {
            paths: {
              '/v1/libraryPins': { get: { operationId: 'library_pin.list' } },
              '/v1/libraryPins/{collectionId}': {
                put: { operationId: 'library_pin.put' },
                delete: { operationId: 'library_pin.delete' },
              },
            },
          },
        }),
      },
      libraryPins: {
        get: async ({ query }: { query: { limit: number } }) => {
          pinsReads.push(query.limit);
          return {
            data: {
              pins: Array.from({ length: Math.min(count, query.limit) }, (_, index) => ({
                collectionId: `c${index}`,
                target: null,
              })),
              revision: 5,
              next: count > query.limit ? 'next-page' : null,
            },
          };
        },
      },
      collections: {
        get: async (options: unknown) => {
          collectionQueries.push(options);
          return { data: { collections: [], next: null } };
        },
        collection: (params: { collectionId: string }) => ({
          get: async () => (collectionItemReads.push(params.collectionId), { data: null }),
        }),
      },
    };
    const request = new Request('https://site.example/en/library', {
      headers: { cookie: '__Host-rezics_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    const session = { credential: async () => ({ status: 'active', subject: 'viewer', accessToken: 'token' }) };
    const env = {
      AUTH_ISSUER: 'https://issuer.example',
      API_RESOURCE: 'kernel',
      WEBSITE_SCOPES: 'site',
      WEBSITE_CLIENT_ID: 'site',
      WEBSITE_CLIENT_KEY: '{}',
      SESSIONS: { idFromName: (id: string) => id, get: () => session },
    };
    await loadLibraryNavigation(client as never, request, env as never);
    expect(pinsReads).toEqual([8]);
    expect(collectionQueries).toHaveLength(1);
    expect(collectionItemReads).toEqual([]);

    const pins100 = await readLibraryPins(client as never, 'Bearer token', 100);
    expect(pins100.state).toBe('loaded');
    expect(pinsReads.at(-1)).toBe(100);
  }
});
