import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { dehydrate, QueryClient } from '@tanstack/react-query';
import { isNotFound } from '@tanstack/react-router';
import type { SessionEnv } from '../src/session/client';
import { collectionRenderPolicy, loadEditableCollectionPage } from '../src/library/collection-load';
import { cachePublicPage, duringPublicCacheRender, recordPublicPageCachePolicy } from '../src/security/page-cache';

// The conditional fixture has no nonce attributes; current HTML is still normalized before its ETag.
const originalHtmlRewriter = globalThis.HTMLRewriter;
beforeEach(() => {
  globalThis.HTMLRewriter = class {
    on(): this {
      return this;
    }
    transform(response: Response): Response {
      return response;
    }
  } as never;
});
afterEach(() => {
  if (originalHtmlRewriter === undefined) delete (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter;
  else globalThis.HTMLRewriter = originalHtmlRewriter;
});

mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://rezics.com' } }));
const { collectionPageHead } = await import('../src/library/collection-page');
const { Route } = await import('../src/routes/collections/$id');
const { feed } = await import('../src/sitemap/feeds/collections');

const stamp = '2026-10-31T00:00:00.000Z';
const member = {
  id: 'occurrence-a',
  note: 'A public note',
  addedAt: stamp,
  subject: { id: 'subject-a', type: 'schema:Book', label: 'Public book' },
};
const header = {
  id: 'collection-a',
  title: 'Public shelf',
  description: 'A reading list',
  visibility: 'public' as const,
  curatorAccountId: 'curator',
  curator: { handle: 'ada', displayName: 'Ada' },
  memberCount: 957,
  revision: 8,
  createdAt: stamp,
  updatedAt: stamp,
};
const context = { origin: 'https://rezics.com', locale: 'en', path: '/collections/collection-a' };
type Call = { path: string; authorization: string | null; query: URLSearchParams };
function clientFor(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const call = { path: url.pathname, authorization: request.headers.get('authorization'), query: url.searchParams };
      calls.push(call);
      return respond(call);
    }) as typeof fetch,
  });
  return { client, calls };
}
function source(visibility: 'public' | 'unlisted' | 'private' = 'public', status = 200, next: string | null = null) {
  return clientFor((call) => {
    if (call.path.endsWith('/viewerActions'))
      return Response.json({
        resources: [
          {
            type: 'library.collection',
            id: header.id,
            viewerActions: [{ action: 'collection:update', operations: ['collection.update'] }],
          },
        ],
      });
    if (call.path.endsWith('/members')) {
      if (status !== 200) return Response.json({ preparing: true }, { status, headers: { 'retry-after': '2' } });
      return Response.json({
        members: [member, { id: 'hidden-occurrence', note: 'secret note', addedAt: stamp, subject: null }],
        next,
      });
    }
    if (visibility === 'private' && !call.authorization) return Response.json({ code: 'not_found' }, { status: 404 });
    return Response.json({ collection: { ...header, visibility, rule: { secret: 'private predicate' } } });
  });
}
function sessionEnv(): Partial<SessionEnv> {
  return {
    AUTH_ISSUER: 'https://auth.test',
    API_RESOURCE: 'https://kernel.test',
    WEBSITE_SCOPES: 'collection:read',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'configured',
    SESSIONS: {
      idFromName: () => 'session',
      get: () => ({
        credential: async () => ({
          status: 'active',
          accessToken: 'private-token',
          subject: 'curator',
          csrfToken: 'private-csrf',
        }),
      }),
    } as SessionEnv['SESSIONS'],
  };
}
const privateRequest = () =>
  new Request('https://rezics.com/en/collections/collection-a', {
    headers: { cookie: '__Host-rezics_session=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  });

test('anonymous SSR uses current FULL native projections with two bounded reads and no private dehydration', async () => {
  const { client, calls } = source();
  const request = privateRequest();
  const page = await duringPublicCacheRender(request, () =>
    loadEditableCollectionPage(client, request, sessionEnv(), { id: header.id }, 'anonymous'),
  );
  expect(calls).toHaveLength(2);
  expect(calls.every((call) => call.authorization === null)).toBe(true);
  expect(calls.map((call) => call.query.get('view'))).toEqual(['FULL', 'FULL']);
  expect(calls[1]!.query.get('limit')).toBe('100');
  expect(page.members).toHaveLength(1);
  expect('memberCount' in page && page.memberCount).toBe(1);
  expect(collectionRenderPolicy(page)).toEqual({ cache: 'public', indexable: true, completeItemList: true });
  const queries = new QueryClient();
  queries.setQueryData(['collection-page', header.id, 'anonymous'], page);
  const serialized = JSON.stringify(dehydrate(queries));
  expect(serialized).not.toMatch(/957|private-token|private-csrf|secret note|hidden-occurrence|private predicate/);
  const graph = JSON.stringify(collectionPageHead(page, context));
  expect(graph).toContain('numberOfItems');
  expect(graph).not.toContain('957');
});

test('signed-in public browsing still uses anonymous membership; private navigation keeps authorized native reads', async () => {
  for (const visibility of ['public', 'private'] as const) {
    const { client, calls } = source(visibility);
    const page = await loadEditableCollectionPage(client, privateRequest(), sessionEnv(), { id: header.id }, 'session');
    // Two data reads plus the landed exact-resource native action projection; no per-member requests.
    expect(calls).toHaveLength(3);
    expect(calls.filter((call) => call.path.includes('/collections/'))).toHaveLength(2);
    expect(calls[2]!.path).toBe('/v1/viewerActions');
    expect(calls[2]!.authorization).toBe('Bearer private-token');
    expect(calls[0]!.authorization).toBe('Bearer private-token');
    expect(calls[1]!.authorization).toBe(visibility === 'private' ? 'Bearer private-token' : null);
    expect('visibility' in page && page.visibility).toBe(visibility);
    expect(collectionRenderPolicy(page).cache).toBe('private');
  }
  const editing = source();
  const editor = await loadEditableCollectionPage(
    editing.client,
    privateRequest(),
    sessionEnv(),
    { id: header.id, editor: true },
    'session',
  );
  expect(editing.calls).toHaveLength(3);
  expect(editing.calls.filter((call) => call.path.includes('/collections/'))).toHaveLength(2);
  expect(editing.calls.every((call) => call.authorization === 'Bearer private-token')).toBe(true);
  expect(editor.members).toHaveLength(2);
  expect(collectionRenderPolicy(editor).completeItemList).toBe(false);
  const hidden = source('private');
  await loadEditableCollectionPage(hidden.client, privateRequest(), {}, { id: header.id }, 'anonymous').then(
    () => {
      throw new Error('Private Collection was disclosed anonymously');
    },
    (error) => expect(isNotFound(error)).toBe(true),
  );
  expect(hidden.calls).toHaveLength(1);
});

test('current native membership replaces removed public rows without an extra detail read', async () => {
  let currentMembers = [member];
  const { client, calls } = clientFor((call) =>
    Response.json(call.path.endsWith('/members') ? { members: currentMembers, next: null } : { collection: header }),
  );
  const read = () =>
    loadEditableCollectionPage(client, new Request('https://rezics.com'), {}, { id: header.id }, 'anonymous');
  const before = await read();
  expect(before.members).toHaveLength(1);
  currentMembers = [];
  const after = await read();
  expect(after.members).toHaveLength(0);
  expect('memberCount' in after && after.memberCount).toBe(0);
  expect(JSON.stringify(collectionPageHead(after, context))).not.toContain('subject-a');
  expect(calls).toHaveLength(4);
  expect(calls.every((call) => call.authorization === null)).toBe(true);
});

test('unlisted, later, filtered, preparing and unavailable results cannot export a full list or claim a pending zero', async () => {
  for (const [visibility, status, cursor, next] of [
    ['unlisted', 200, undefined, null],
    ['public', 200, 'later', null],
    ['public', 202, undefined, null],
    ['public', 503, undefined, null],
    ['public', 200, undefined, 'next-page'],
  ] as const) {
    const { client, calls } = source(visibility, status, next);
    const page = await loadEditableCollectionPage(
      client,
      new Request('https://rezics.com'),
      {},
      { id: header.id, ...(cursor ? { cursor } : {}) },
      'anonymous',
    );
    const policy = collectionRenderPolicy(page);
    expect(policy.completeItemList).toBe(false);
    if (next === null) {
      expect(policy.cache).toBe('private');
      expect(collectionPageHead(page, context).meta).toContainEqual({ name: 'robots', content: 'noindex, follow' });
    }
    if (status !== 200) expect('memberCount' in page && page.memberCount).toBeNull();
    expect(JSON.stringify(collectionPageHead(page, context))).not.toContain('numberOfItems');
    expect(calls).toHaveLength(2);
  }
  const { client } = source();
  const page = await loadEditableCollectionPage(
    client,
    new Request('https://rezics.com'),
    {},
    { id: header.id },
    'anonymous',
  );
  expect(collectionRenderPolicy({ ...page, filterActive: true }).completeItemList).toBe(false);
  expect(collectionRenderPolicy({ ...page, filterIgnored: ['invalid'] }).cache).toBe('private');
  expect(JSON.stringify(feed.family({ id: header.id, lastModified: stamp }))).not.toContain('lastmod');
});

test('the public route loader stays anonymous and cache promotion needs a disclosed public result', async () => {
  const loader = Route.options.loader;
  if (typeof loader !== 'function') throw new Error('Collection route has no loader');
  const queryClient = new QueryClient();
  // A real query cache hit lets this case exercise the route's selected credential without an RPC runtime.
  queryClient.setQueryData(['collection-page', header.id, null, null, 'anonymous'], { id: header.id });
  await loader({
    params: { id: header.id },
    deps: {},
    context: { queryClient, credentialMode: 'session' },
  } as Parameters<typeof loader>[0]);
  expect(queryClient.getQueryCache().getAll()).toHaveLength(1);
  expect(Route.options.staticData?.sessionReread).toBeUndefined();
  const request = new Request('https://rezics.com/en/collections/collection-a', { headers: { 'if-none-match': '*' } });
  for (const policy of ['private', 'public'] as const) {
    const response = await cachePublicPage(request, {
      publicRoute: true,
      buildId: 'test-build',
      dehydratedData: () => ({ public: true }),
      render: async () => {
        recordPublicPageCachePolicy(request, policy);
        return new Response('<html>Public projection</html>', { headers: { 'content-type': 'text/html' } });
      },
    });
    expect(response.headers.get('cache-control')).toBe(
      policy === 'public' ? 'public, max-age=0, s-maxage=0, must-revalidate' : 'private, no-store',
    );
    expect(response.status).toBe(policy === 'public' ? 304 : 200);
    expect(response.headers.has('etag')).toBe(policy === 'public');
  }
});
