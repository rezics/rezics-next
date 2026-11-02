import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { QueryClient } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  followCountsSearch,
  loadPrivateFollowCounts,
  privateFollowCountsQuery,
  readFollowCounts,
  type FollowCountsPage,
} from '../src/library/private-follow-counts';
import { PrivateFollowCountsPageView } from '../src/library/private-follow-counts-page';
import { privateFollowCountsHref } from '../src/library/private-follow-counts-link';
import { LibraryNavigation } from '../src/library/library-nav';
import type { SessionEnv } from '../src/session/client';
import type { SessionStore } from '../src/session/store';

const target = { targetType: 'collection' as const, targetId: '0192f3a0-6c1e-7b2a-9d4e-000000000021' };
const viewer = { subject: 'alice', csrfToken: 'A'.repeat(22) };
const authorization = 'Bearer alice-count-token';
const privateHeaders = { 'cache-control': 'private, no-store' };

function transport(reply: (request: Request) => Response | Promise<Response>) {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      calls.push(request);
      expect(request.method).toBe('GET');
      expect(request.headers.get('authorization')).toBe(authorization);
      expect(new URL(request.url).search).toBe('');
      return reply(request);
    },
  });
  return { client, calls };
}

test('own outgoing count and genuinely authorized contextual target counts distinguish zero from denied or unavailable', async () => {
  // Transport outcomes exercise the consumer; native Access owns whether this caller really manages the target.
  for (const count of [0, 42]) {
    const { client, calls } = transport((request) =>
      Response.json(
        request.url.endsWith('/outgoing') ? { followingCount: count } : { ...target, followerCount: count },
        { headers: privateHeaders },
      ),
    );
    const own = await readFollowCounts(client, authorization, {});
    expect(own).toEqual({ context: {}, outgoing: { state: 'ready', count }, target: null });
    expect(calls).toHaveLength(1);
    const contextual = await readFollowCounts(client, authorization, target);
    expect(contextual.outgoing).toEqual({ state: 'ready', count });
    expect(contextual.target).toEqual({ state: 'ready', count });
    expect(calls.slice(1).map((request) => new URL(request.url).pathname)).toEqual([
      '/v1/followCounts/outgoing',
      `/v1/followCounts/collection/${target.targetId}`,
    ]);
  }
  for (const [status, code, state] of [
    [401, 'invalid_credentials', 'signed-out'],
    [403, 'forbidden', 'denied'],
    [403, 'platform_closed', 'closed'],
    [404, 'not_found', 'denied'],
    [503, 'dependency_unavailable', 'unavailable'],
  ] as const) {
    const { client } = transport(() =>
      Response.json(
        { code },
        {
          status,
          headers: { ...privateHeaders, 'retry-after': '7' },
        },
      ),
    );
    const result = await readFollowCounts(client, authorization, target);
    expect(result.outgoing).toEqual({ state: status === 404 ? 'unavailable' : state, status, code, retryAfter: '7' });
    expect(result.target).toEqual({ state, status, code, retryAfter: '7' });
    expect(JSON.stringify(result)).not.toContain('"count":');
  }
});

test('only validated current resource context requests a target; owner selectors never confer authority', async () => {
  const { client, calls } = transport(() => Response.json({ followingCount: 0 }, { headers: privateHeaders }));
  for (const query of [
    { targetId: target.targetId },
    { ...target, targetType: 'account' },
    { ...target, targetId: '../outgoing' },
    { ...target, targetId: [target.targetId] },
    { ...target, owner: 'alice' },
    { ...target, accountId: 'alice' },
  ]) {
    const result = await readFollowCounts(client, authorization, followCountsSearch(query));
    expect(result.context.invalidContext).toBe(true);
    expect(result.target).toBeNull();
  }
  expect(calls).toHaveLength(6);
  expect(calls.every((request) => request.url.endsWith('/outgoing'))).toBe(true);
  const url = new URL(privateFollowCountsHref(target, 'ja')!, 'https://site.example.test');
  expect(url.pathname).toBe('/ja/library/follow-counts');
  expect(followCountsSearch(Object.fromEntries(url.searchParams))).toEqual(target);
  expect(privateFollowCountsHref({ ...target, targetId: '' }, 'en')).toBeNull();
  const navigation = renderToStaticMarkup(
    createElement(LibraryNavigation, {
      current: 'follow-counts',
      pins: { state: 'closed' },
      collections: [],
      locale: 'fr',
    }),
  );
  expect(navigation).toContain('href="/fr/library/follow-counts"');
  expect(navigation).toContain('aria-current="page"');
});

test('malformed, mismatched, unfinished and lost native responses never fabricate counts', async () => {
  for (const body of [
    null,
    {},
    { followingCount: '0' },
    { followingCount: -1 },
    { followingCount: Number.MAX_SAFE_INTEGER + 1 },
    { followingCount: 0, followerCount: 2 },
  ]) {
    const { client } = transport(() => Response.json(body));
    expect((await readFollowCounts(client, authorization, {})).outgoing.state).toBe('unavailable');
  }
  for (const targetType of ['subject', 'collection', 'space'] as const) {
    const context = { ...target, targetType };
    const { client, calls } = transport((request) =>
      Response.json(
        request.url.endsWith('/outgoing')
          ? { followingCount: 3 }
          : { ...context, targetId: 'other-resource', followerCount: 0 },
      ),
    );
    const result = await readFollowCounts(client, authorization, context);
    expect(result.outgoing).toEqual({ state: 'ready', count: 3 });
    expect(result.target?.state).toBe('unavailable');
    expect(calls).toHaveLength(2);
  }
  const { client } = transport(() => Response.json({ followingCount: 0 }, { status: 202 }));
  expect((await readFollowCounts(client, authorization, {})).outgoing.state).toBe('unavailable');
  const lost = transport(() => {
    throw new TypeError('Response lost');
  });
  expect((await readFollowCounts(lost.client, authorization, target)).target?.state).toBe('unavailable');
});

test('private query identity and target isolate cache entries and fence late old-account results', async () => {
  const cache = new QueryClient();
  const ready: FollowCountsPage = {
    viewer,
    context: target,
    outgoing: { state: 'ready', count: 12 },
    target: { state: 'ready', count: 0 },
  };
  const alice = privateFollowCountsQuery(viewer, target, async () => ready);
  const bob = privateFollowCountsQuery({ ...viewer, subject: 'bob' }, target, async () => ready);
  const renewed = privateFollowCountsQuery({ ...viewer, csrfToken: 'B'.repeat(22) }, target, async () => ready);
  const other = privateFollowCountsQuery(viewer, { ...target, targetType: 'space' }, async () => ready);
  const own = privateFollowCountsQuery(viewer, {}, async () => ready);
  expect(renewed.queryKey).toEqual(alice.queryKey);
  expect(new Set([alice, bob, other, own].map((query) => JSON.stringify(query.queryKey))).size).toBe(4);
  expect((await cache.fetchQuery(alice)).outgoing).toEqual({ state: 'ready', count: 12 });
  for (const query of [bob, other, own]) {
    const fenced = await cache.fetchQuery(query);
    expect(fenced.outgoing.state).toBe('unavailable');
    expect(fenced.target).toBeNull();
  }
  expect(alice).toMatchObject({ retry: false, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false });
  let complete!: (page: FollowCountsPage) => void;
  const pending = privateFollowCountsQuery(
    viewer,
    target,
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  cache.removeQueries({ queryKey: alice.queryKey });
  const attempt = cache.fetchQuery(pending).catch(() => null);
  await cache.cancelQueries({ queryKey: pending.queryKey });
  cache.removeQueries({ queryKey: pending.queryKey });
  complete(ready);
  await attempt;
  expect(cache.getQueryData(pending.queryKey)).toBeUndefined();
  cache.clear();
});

test('signed-in BFF uses its prepared session, and absent runtime or session stays unavailable or signed out', async () => {
  const { client, calls } = transport(() => Response.json({ followingCount: 0 }, { headers: privateHeaders }));
  const readViewer = { ...viewer, csrfToken: null };
  const credential = async () => ({ status: 'active' as const, ...readViewer, accessToken: 'alice-count-token' });
  const env: Partial<SessionEnv> = {
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'https://api.example.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web-count-test',
    WEBSITE_CLIENT_KEY: 'unused',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({ credential }),
    } as unknown as DurableObjectNamespace<SessionStore>,
  };
  const request = () =>
    new Request('https://site.example.test/library/follow-counts', {
      headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
    });
  expect(await loadPrivateFollowCounts(client, request(), env, {})).toEqual({
    viewer: readViewer,
    context: {},
    outgoing: { state: 'ready', count: 0 },
    target: null,
  });
  expect((await loadPrivateFollowCounts(null, request(), env, {})).outgoing.state).toBe('unavailable');
  expect((await loadPrivateFollowCounts(client, new Request('https://site.example.test'), {}, {})).outgoing.state).toBe(
    'signed-out',
  );
  expect(calls).toHaveLength(1);
});

test('page shows a real zero, loading, refused, unavailable and context guidance as different outcomes', () => {
  for (const state of [
    { state: 'ready', count: 0 },
    { state: 'loading' },
    { state: 'denied', status: 404 },
    { state: 'unavailable', status: 503, retryAfter: '7' },
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(PrivateFollowCountsPageView, {
        page: { context: {}, outgoing: state, target: null },
      }),
    );
    expect(html).not.toContain('<main');
    expect(html.includes('data-follow-count="0"')).toBe(state.state === 'ready');
    expect(html).toContain('Open follower counts from a resource');
  }
});
