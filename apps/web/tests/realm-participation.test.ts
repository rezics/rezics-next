import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router';
import * as start from '../.storybook/react-start';

const workerEnv: Record<string, unknown> = {};
mock.module('cloudflare:workers', () => ({ env: workerEnv }));
mock.module('@tanstack/react-start', () => start);
let currentRequest: Request | undefined;
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => currentRequest ?? start.getRequest(),
}));

const { createKernelClient } = await import('@rezics/client');
const { RealmParticipationView } = await import('../src/community/realm-participation');
const { realmMembershipQuery, refreshRealmMembership } = await import('../src/community/realm-membership-queries');
type RealmViewer = import('../src/community/realm-membership-queries').RealmViewer;
const { loadRealmMembership, requestRealmMembership } = await import('../src/community/space');
const { readFollowRecord, writeFollowRecord } = await import('../src/library/follow-records');
const sessionModule = await import('../src/session/query');
let session: ReturnType<typeof sessionModule.useSession> = { state: 'signed-out', csrfToken: null, subject: null };
mock.module('../src/session/query', () => ({ ...sessionModule, useSession: () => session }));
const { RealmMembership } = await import('../src/community/realm-membership');
const { BoardStartThread } = await import('../src/threads/board-community-actions');
const { m } = await import('../src/paraglide/messages.js');

const realmId = '0192f3a0-6c1e-7b2a-9d4e-000000000201';
const spaceId = '0192f3a0-6c1e-7b2a-9d4e-000000000101';
const idempotencyKey = '123e4567-e89b-42d3-a456-426614174000';
const authorization = 'Bearer current-member';
const auth = { headers: { authorization } };
const request = () => new Request('https://site.example.test/action', { method: 'POST', ...auth });
const pause = async () => {};
const view = (
  state: 'none' | 'pending' | 'member' | 'banned' | 'unavailable',
  visibility: 'public' | 'protected' = 'public',
  refresh: 'pending' | 'unavailable' | null = null,
) =>
  renderToStaticMarkup(
    createElement(RealmParticipationView, {
      state,
      visibility,
      refresh,
      onChange: () => {},
      onRetry: () => {},
    }),
  );

// Protocol fixtures exercise the real bounded BFF readers/writers, not native workflow authority.
test('accepted join and leave settle visibly through bounded current reads; pending, denied and unavailable remain truthful', async () => {
  let state: 'none' | 'member' = 'none';
  let participation = 204;
  let membershipStatus = 200;
  let commandStatus = 202;
  let commands = 0;
  let reads = 0;
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (input, init) => {
      const next = new Request(input, init);
      expect(next.headers.get('authorization')).toBe(authorization);
      const path = new URL(next.url).pathname;
      if (path.endsWith('/membership')) {
        commands++;
        if (next.method === 'POST') expect(next.headers.get('idempotency-key')).toBe(JSON.stringify(idempotencyKey));
        return commandStatus === 202
          ? Response.json({ workflowId: 'native-membership-workflow' }, { status: 202 })
          : Response.json({ code: 'forbidden', detail: 'Native leave denied' }, { status: commandStatus });
      }
      reads++;
      if (path.endsWith('/members/me')) return Response.json({ state, since: null }, { status: membershipStatus });
      expect(path).toBe(`/v1/realms/${realmId}/participation`);
      return new Response(null, { status: participation });
    },
  });
  const change = (action: 'join' | 'leave') =>
    requestRealmMembership(client, request(), {}, { realmId, action, idempotencyKey });
  const read = () => loadRealmMembership(client, realmId, auth);
  expect(await change('join')).toEqual({ outcome: 'accepted', workflowId: 'native-membership-workflow' });
  expect(await refreshRealmMembership(read, 'member', { pause })).toEqual({ kind: 'pending' });
  expect(reads).toBe(8);
  expect(view('pending', 'public', 'pending')).toContain('Check membership');
  expect(view('pending', 'public', 'pending')).not.toContain('>Leave</button>');
  state = 'member';
  const joined = await refreshRealmMembership(read, 'member', { pause });
  expect(joined.kind).toBe('settled');
  if (joined.kind !== 'settled') throw new Error('Join did not settle');
  expect(view(joined.viewer.state)).toContain('>Leave</button>');
  expect(commands).toBe(1); // Manual refresh never resends the accepted command.
  expect((await change('leave')).outcome).toBe('accepted');
  let observations = 0;
  const left = await refreshRealmMembership(
    async () => {
      if (++observations === 2) state = 'none';
      return read();
    },
    'none',
    { pause },
  );
  expect(left.kind).toBe('settled');
  if (left.kind !== 'settled') throw new Error('Leave did not settle');
  expect(view(left.viewer.state)).toContain('>Join</button>');
  expect(view('none', 'protected')).not.toContain('>Join</button>');
  state = 'member';
  participation = 403;
  const denied = await refreshRealmMembership(read, 'member', { pause });
  expect(denied.kind).toBe('denied');
  expect(view('banned')).not.toContain('>Join</button>');
  for (membershipStatus of [403, 404, 503]) {
    expect(await refreshRealmMembership(read, 'none', { pause })).toEqual({ kind: 'unavailable' });
    expect(view('pending', 'public', 'unavailable')).toContain('current membership is unavailable');
  }
  membershipStatus = 200;
  participation = 503;
  expect(await refreshRealmMembership(read, 'member', { pause })).toEqual({ kind: 'unavailable' });
  commandStatus = 403;
  expect(await change('leave')).toEqual({ outcome: 'refused', detail: 'Native leave denied' });
  commandStatus = 200;
  expect((await change('join')).outcome).toBe('refused'); // A malformed acceptance is not success.
  expect(commands).toBe(4);
});

test('explicit Space unfollow survives visible leave and rejoin; membership never sends a follow write', async () => {
  let state: 'none' | 'member' = 'member';
  let explicitlyUnfollowed = false;
  let following = true;
  const followWrites: string[] = [];
  const follow = () => ({
    targetId: spaceId,
    targetType: 'space',
    state: following ? 'following' : 'unfollowed',
    reason: 'explicit',
    updatedAt: '2026-10-31T07:00:00Z',
  });
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (input, init) => {
      const next = new Request(input, init);
      const path = new URL(next.url).pathname;
      if (path.startsWith('/v1/follows/')) {
        expect(path).toBe(`/v1/follows/${spaceId}`);
        if (next.method !== 'GET') {
          followWrites.push(next.method);
          expect(next.headers.get('idempotency-key')).toBe(idempotencyKey);
          explicitlyUnfollowed = next.method === 'DELETE';
          following = next.method === 'PUT';
        }
        return Response.json({ follow: follow() });
      }
      if (path.endsWith('/membership')) {
        state = next.method === 'POST' ? 'member' : 'none';
        // The native workflow's explicit-unfollow precedence, represented by this protocol fixture.
        if (state === 'member' && !explicitlyUnfollowed) following = true;
        return Response.json({ workflowId: 'native-membership-workflow' }, { status: 202 });
      }
      if (path.endsWith('/members/me')) return Response.json({ state, since: null });
      expect(path).toBe(`/v1/realms/${realmId}/participation`);
      return new Response(null, { status: 204 });
    },
  });
  expect(await readFollowRecord(client, spaceId, authorization)).toEqual({ state: 'ready', following: true });
  expect(
    await writeFollowRecord(client, request(), {}, { targetId: spaceId, following: false, idempotencyKey }),
  ).toEqual({ ok: true, following: false });
  for (const action of ['leave', 'join'] as const) {
    expect((await requestRealmMembership(client, request(), {}, { realmId, action, idempotencyKey })).outcome).toBe(
      'accepted',
    );
    const result = await refreshRealmMembership(
      () => loadRealmMembership(client, realmId, auth),
      action === 'join' ? 'member' : 'none',
      { pause },
    );
    expect(result.kind).toBe('settled');
    if (result.kind !== 'settled') throw new Error('Membership did not settle');
    expect(view(result.viewer.state)).toContain(action === 'join' ? '>Leave</button>' : '>Join</button>');
    expect(await readFollowRecord(client, spaceId, authorization)).toEqual({ state: 'ready', following: false });
  }
  expect(followWrites).toEqual(['DELETE']);
});

const publicRealm = { id: realmId, visibility: 'public' as const, viewer: null };
const returnTo = '/zh-Hant/spaces/atlas?from=/boards/a+b&label=心%20#membership';

test('A signed-out Join entry navigates to sign-in for both absent and earlier viewer-none snapshots', () => {
  session = { state: 'signed-out', csrfToken: null, subject: null };
  for (const viewer of [null, { state: 'none' as const, idempotencyKey }]) {
    const realm = { ...publicRealm, viewer };
    const html = renderToStaticMarkup(createElement(RealmMembership, { realm, returnTo }));
    expect(html).toContain(`href="/auth/sign-in?return_to=${encodeURIComponent(returnTo)}"`);
    expect(html).toContain(`>${m.realm_join()}</a>`);
    expect(html).not.toContain('<button');
    for (const admittedAction of [null, 'join', 'leave'] as const)
      expect(renderToStaticMarkup(createElement(RealmMembership, { realm, returnTo, admittedAction }))).toBe('');
    expect(renderToStaticMarkup(createElement(RealmMembership, { realm, returnTo, admittedAction: 'sign-in' }))).toBe(
      html,
    );
    const protectedHtml = renderToStaticMarkup(
      createElement(RealmMembership, { realm: { ...realm, visibility: 'protected' }, returnTo }),
    );
    expect(protectedHtml).toContain(m.realm_protected_admission());
    expect(protectedHtml).not.toContain('/auth/sign-in');
    expect(protectedHtml).not.toContain('<button');
  }
  for (const state of ['unknown', 'unavailable', 'signed-in'] as const) {
    session = { state, csrfToken: 'csrf-without-subject', subject: null };
    expect(renderToStaticMarkup(createElement(RealmMembership, { realm: publicRealm, returnTo }))).toBe('');
  }
});

async function renderMembershipEntries(queries: QueryClient, advice: 'allowed' | 'denied' = 'allowed') {
  const board = {
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000301',
    realmId,
    availability: 'available',
    visibility: 'published',
  } as Parameters<typeof BoardStartThread>[0]['board'];
  const root = createRootRoute({
    component: () =>
      createElement(
        'div',
        null,
        createElement(RealmMembership, { realm: publicRealm, returnTo }),
        createElement(BoardStartThread, {
          board,
          advice,
          returnTo,
        }),
      ),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queries }, createElement(RouterProvider, { router })),
  );
}

test('current membership plus uncertain leave intent cannot carry across a known session-subject replacement', async () => {
  const queries = new QueryClient();
  const previous = realmMembershipQuery(realmId, 'previous-person');
  const current = realmMembershipQuery(realmId, 'current-person');
  try {
    session = { state: 'signed-in', subject: 'previous-person', csrfToken: 'original-csrf' };
    queries.setQueryData(previous.queryKey, { state: 'member', idempotencyKey });
    const before = RealmMembership({ realm: publicRealm, returnTo });
    expect(before).not.toBeNull();
    expect(await renderMembershipEntries(queries)).toContain(`>${m.realm_leave()}</button>`);
    expect(await renderMembershipEntries(queries)).toContain(m.board_start_thread());
    session = { ...session, csrfToken: 'rotated-csrf' };
    // The keyed subtree owns pending, refusal/recovery and the uncertain original leave action/key.
    // Token rotation keeps that whole subtree; replacing the subject discards it.
    expect(RealmMembership({ realm: publicRealm, returnTo })?.key).toBe(before?.key);
    session = { ...session, subject: 'current-person' };
    expect(RealmMembership({ realm: publicRealm, returnTo })?.key).not.toBe(before?.key);
    const waiting = await renderMembershipEntries(queries);
    expect(waiting).toContain(m.realm_membership_loading());
    expect(waiting).not.toContain(`>${m.realm_leave()}</button>`);
    expect(waiting).not.toContain(m.realm_leave_retry_same());

    let finishOldRead!: (viewer: RealmViewer) => void;
    const oldRead = queries.fetchQuery({
      ...previous,
      queryFn: () =>
        new Promise<RealmViewer>((resolve) => {
          finishOldRead = resolve;
        }),
    });
    queries.setQueryData(current.queryKey, { state: 'banned', idempotencyKey: 'current-key' });
    finishOldRead({ state: 'member', idempotencyKey });
    await oldRead;
    const denied = await renderMembershipEntries(queries);
    expect(denied.replaceAll('&#x27;', "'")).toContain(m.realm_banned());
    expect(denied).not.toContain(`>${m.realm_leave()}</button>`);
    expect(denied).toContain(m.board_start_thread());
    expect(queries.getQueryData(current.queryKey)).toEqual({ state: 'banned', idempotencyKey: 'current-key' });
    for (const state of ['unknown', 'unavailable', 'signed-in'] as const) {
      session = { state, csrfToken: null, subject: null };
      expect(await renderMembershipEntries(queries)).toBe('<div></div>');
    }
    expect(realmMembershipQuery(realmId, null).enabled).toBe(false);
  } finally {
    queries.clear();
  }
});

async function renderStartThread(
  queries: QueryClient,
  advice: 'allowed' | 'denied' | 'sign-in' = 'allowed',
  viewer?: { participation: 'allowed' | 'denied' | 'sign-in' | 'unavailable' },
) {
  const board = {
    id: '0192f3a0-6c1e-7b2a-9d4e-000000000301',
    realmId,
    availability: 'available',
    visibility: 'published',
  } as Parameters<typeof BoardStartThread>[0]['board'];
  const root = createRootRoute({
    component: () =>
      createElement(BoardStartThread, {
        board,
        advice,
        returnTo,
        ...(viewer ? { viewer } : {}),
      }),
  });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ['/'] }) });
  await router.load();
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client: queries }, createElement(RouterProvider, { router })),
  );
}

test('Board start visibility follows mounted action advice', async () => {
  const queries = new QueryClient();
  try {
    session = { state: 'signed-in', subject: 'current-person', csrfToken: 'csrf' };
    expect(await renderMembershipEntries(queries, 'allowed')).toContain(m.board_start_thread());
    expect(await renderMembershipEntries(queries, 'denied')).not.toContain(m.board_start_thread());
    for (const state of ['unknown', 'unavailable'] as const) {
      session = { state, subject: 'current-person', csrfToken: 'csrf' };
      expect(await renderMembershipEntries(queries, 'allowed')).not.toContain(m.board_start_thread());
    }
    session = { state: 'signed-in', subject: null, csrfToken: 'csrf' };
    expect(await renderMembershipEntries(queries, 'allowed')).not.toContain(m.board_start_thread());
  } finally {
    queries.clear();
  }
});

test('Board start-thread requires the mounted viewer participation when the page supplies it', async () => {
  const queries = new QueryClient();
  try {
    session = { state: 'signed-in', subject: 'current-person', csrfToken: 'csrf' };
    expect(await renderStartThread(queries, 'allowed', { participation: 'allowed' })).toContain(m.board_start_thread());
    expect(await renderStartThread(queries, 'allowed', { participation: 'denied' })).not.toContain(
      m.board_start_thread(),
    );
    expect(await renderStartThread(queries, 'allowed', { participation: 'unavailable' })).not.toContain(
      m.board_start_thread(),
    );
    session = { state: 'signed-out', csrfToken: null, subject: null };
    expect(await renderStartThread(queries, 'denied', { participation: 'sign-in' })).toContain(
      m.board_sign_in_to_start(),
    );
  } finally {
    queries.clear();
  }
});

test('hydrated membership standing stays visible before the caller is command-ready', async () => {
  const queries = new QueryClient();
  try {
    session = { state: 'signed-in', subject: 'current-person', csrfToken: null };
    queries.setQueryData(realmMembershipQuery(realmId, 'current-person').queryKey, {
      state: 'member',
      idempotencyKey,
    });
    const html = await renderMembershipEntries(queries);
    expect(html).toContain(`>${m.realm_leave()}</button>`);
    expect(html).toContain('disabled=""');
    expect(html).not.toContain(m.realm_membership_loading());
    expect(html).toContain(m.board_start_thread());
  } finally {
    queries.clear();
  }
});

test('a retired membership refresh ignores its late result and never starts another read', async () => {
  const controller = new AbortController();
  let finish!: (viewer: RealmViewer) => void;
  const read = mock(
    () =>
      new Promise<RealmViewer>((resolve) => {
        finish = resolve;
      }),
  );
  const refresh = refreshRealmMembership(read, 'member', { signal: controller.signal, pause });
  controller.abort();
  finish({ state: 'member', idempotencyKey });
  expect(await refresh).toEqual({ kind: 'cancelled' });
  expect(read).toHaveBeenCalledTimes(1);
  const delays: number[] = [];
  expect(
    await refreshRealmMembership(async () => ({ state: 'pending', idempotencyKey }), 'member', {
      pause: async (delay) => {
        delays.push(delay);
      },
    }),
  ).toEqual({ kind: 'pending' });
  expect(delays).toEqual([500, 1500, 3000]);
});

test('The default failed membership journey explains an unconfirmed change without exposing raw native detail and explicitly reads current standing without resending the command', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.example.test/en/spaces/atlas' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    scrollTo: () => {},
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const originalFetch = globalThis.fetch;
  const previousSession = session;
  const csrfToken = 'a'.repeat(22);
  const subject = 'membership-person';
  let preparations = 0;
  Object.assign(workerEnv, {
    KERNEL_ORIGIN: 'https://kernel.example.test',
    SITE_ORIGINS: 'https://site.example.test',
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'kernel',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: 'fixture',
    SESSIONS: {
      idFromName: (id: string) => id,
      get: () => ({
        credential: async () => {
          preparations++;
          return { status: 'active', accessToken: 'current-member', subject, csrfToken };
        },
      }),
    },
  });
  session = { state: 'signed-in', subject, csrfToken };
  const pageRequest = (method = 'GET') =>
    new Request(window.location.href, {
      method,
      headers: {
        cookie: `__Host-rezics_session=${'a'.repeat(43)}`,
        origin: window.location.origin,
        'X-CSRF-Token': csrfToken,
      },
    });
  currentRequest = pageRequest();
  const rawDetail = 'Forbidden: internal Access realm:participate decision';
  const calls: Request[] = [];
  let unavailable = true;
  let releaseRead: ((response: Response) => void) | undefined;
  globalThis.fetch = (async (input, init) => {
    const next = new Request(input, init);
    calls.push(next);
    expect(next.headers.get('authorization')).toBe(authorization);
    const path = new URL(next.url).pathname;
    if (next.method === 'POST') {
      expect(path).toBe(`/v1/realms/${realmId}/membership`);
      expect(next.headers.get('idempotency-key')).toBe(JSON.stringify(idempotencyKey));
      return Response.json({ code: 'forbidden', detail: rawDetail }, { status: 403 });
    }
    expect(next.method).toBe('GET');
    expect(next.headers.get('idempotency-key')).toBeNull();
    if (path.endsWith('/members/me')) {
      if (unavailable && !releaseRead)
        return new Promise<Response>((resolve) => {
          releaseRead = resolve;
        });
      return Response.json({ state: 'member', since: null }, { status: unavailable ? 503 : 200 });
    }
    expect(path).toBe(`/v1/realms/${realmId}/participation`);
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const { createRoot } = await import('react-dom/client');
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const membership = realmMembershipQuery(realmId, subject);
  queries.setQueryData(membership.queryKey, { state: 'none', idempotencyKey });
  const route = createRootRoute({ component: () => createElement(RealmMembership, { realm: publicRealm, returnTo }) });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const button = (label: string) => {
    const found = [...host.querySelectorAll('button')].find((node) => node.textContent === label);
    if (!found) throw new Error(`Missing button: ${label}`);
    return found;
  };
  const settle = async () => {
    await act(async () => {
      await Bun.sleep(10);
    });
  };
  const check = async () => {
    await act(async () => button(m.realm_membership_retry()).click());
    await settle();
  };
  try {
    await router.load();
    await act(async () =>
      root.render(createElement(QueryClientProvider, { client: queries }, createElement(RouterProvider, { router }))),
    );
    await settle();
    expect(calls).toHaveLength(0);
    currentRequest = pageRequest('POST');
    await act(async () => button(m.realm_join()).click());
    await settle();
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(m.realm_change_failed());
    expect(host.textContent).not.toContain(rawDetail);
    expect(host.textContent).not.toContain('Forbidden');
    expect(host.querySelector('[data-slot="badge"]')).toBeNull();
    expect(host.textContent).not.toContain(m.realm_membership_checking());
    expect([...host.querySelectorAll('button')].map((node) => node.textContent)).toEqual([m.realm_membership_retry()]);
    const command = calls[0]!;
    expect(calls).toHaveLength(1); // No automatic read or command replay after refusal.
    currentRequest = pageRequest();
    await check();
    expect(host.textContent).toContain(m.realm_membership_loading());
    expect(button(m.realm_membership_retry()).disabled).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(m.realm_change_failed());
    await act(async () => {
      releaseRead!(Response.json({ code: 'unavailable', detail: rawDetail }, { status: 503 }));
    });
    for (let turn = 0; turn < 700 && button(m.realm_membership_retry()).disabled; turn++) await settle();
    expect(host.textContent).toContain(m.realm_membership_unavailable());
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(m.realm_change_failed());
    expect(host.querySelector('[data-slot="badge"]')).toBeNull();
    expect(host.textContent).not.toContain(m.realm_membership_pending_unavailable());
    expect(host.textContent).not.toContain(rawDetail);
    expect(button(m.realm_membership_retry()).disabled).toBe(false);
    expect(calls.filter((call) => call.method === 'GET')).toHaveLength(8);
    expect(preparations).toBe(5); // The real BFF prepares each of four current-reading rounds.
    unavailable = false;
    const before = calls.length;
    await check();
    expect(calls.slice(before).map((call) => [call.method, new URL(call.url).pathname])).toEqual([
      ['GET', `/v1/realms/${realmId}/members/me`],
      ['GET', `/v1/realms/${realmId}/participation`],
    ]);
    expect(preparations).toBe(6);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[data-slot="badge"]')?.textContent).toBe(m.realm_state_member());
    expect(button(m.realm_leave()).disabled).toBe(false);
    expect(calls.filter((call) => call.method !== 'GET')).toEqual([command]);
    expect(command.headers.get('idempotency-key')).toBe(JSON.stringify(idempotencyKey));
    expect(queries.getQueryData(membership.queryKey)).toMatchObject({ state: 'member' });
    expect(queries.getQueryData(realmMembershipQuery(realmId, 'another-person').queryKey)).toBeUndefined();
    const settledCount = calls.length;
    await act(async () => router.invalidate());
    await settle();
    expect(calls).toHaveLength(settledCount);
  } finally {
    await act(async () => root.unmount());
    queries.clear();
    globalThis.fetch = originalFetch;
    currentRequest = undefined;
    session = previousSession;
    for (const key of Object.keys(workerEnv)) delete workerEnv[key];
    await window.happyDOM.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}, 15_000);
