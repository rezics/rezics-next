import { expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, useState } from 'react';
import { createKernelClient } from '@rezics/client';
import type { SessionEnv } from '../src/session/client';
import type { SessionStore } from '../src/session/store';
import { viewerExposureLifetime, viewerExposureQuery } from '../src/kernel/viewer-exposure';
import { loadMineFollowingPage, unfollowFollow } from '../src/library/mine-following';
import type { MineFollowingPage } from '../src/library/mine-following';
import { loadFollowState, writeFollowRecord, type FollowWriteInput } from '../src/library/follow-records';

const siteOrigin = 'https://site.example.test';
const sessionId = 'a'.repeat(43);
const csrfToken = 'A'.repeat(22);
const stamp = '2026-10-30T07:00:00.000Z';

function signedInSession() {
  return {
    async credential() {
      return { status: 'active', subject: 'alice', accessToken: 'alice-page-token', csrfToken };
    },
    async signedIn() {
      return { signedIn: true, subject: 'alice', csrfToken };
    },
  };
}

function sessionEnv(): Partial<SessionEnv> {
  const session = signedInSession();
  const sessions = {
    idFromName: (name: string) => name,
    get: () => session,
  } as unknown as DurableObjectNamespace<SessionStore>;

  return {
    SITE_ORIGINS: siteOrigin,
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'https://api.example.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'rezics-web-following-test',
    WEBSITE_CLIENT_KEY: 'unused-by-the-session-read',
    SESSIONS: sessions,
  };
}

function pageRequest(path: string, method = 'GET', unsafe = false): Request {
  return new Request(`${siteOrigin}${path}`, {
    method,
    headers: {
      cookie: `__Host-rezics_session=${sessionId}`,
      ...(unsafe ? { origin: siteOrigin, 'x-csrf-token': csrfToken } : {}),
    },
  });
}

test('Following reads only each requested FULL page and maps embedded targets without exposing totals', async () => {
  const requests: { method: string; path: string; cursor: string | null }[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push({ method: request.method, path: url.pathname, cursor: url.searchParams.get('cursor') });
      expect(url.pathname).toBe('/v1/follows');
      expect(request.method).toBe('GET');
      expect(request.headers.get('authorization')).toBe('Bearer alice-page-token');
      expect(url.searchParams.get('view')).toBe('FULL');
      expect(url.searchParams.get('limit')).toBe('100');

      if (url.searchParams.get('cursor') === null)
        return Response.json({
          follows: [
            {
              targetId: 'subject-1',
              targetType: 'subject',
              state: 'following',
              reason: 'explicit',
              updatedAt: stamp,
              target: {
                id: 'subject-1',
                type: 'schema:Book',
                types: ['schema:Book'],
                label: { value: 'Embedded book title', language: 'en' },
                creativeWork: true,
                cover: null,
              },
            },
            {
              targetId: 'collection-1',
              targetType: 'collection',
              state: 'following',
              reason: 'explicit',
              updatedAt: stamp,
              target: { id: 'collection-1', type: 'collection', label: 'Embedded collection title' },
            },
          ],
          next: 'cursor-page-two',
        });

      expect(url.searchParams.get('cursor')).toBe('cursor-page-two');
      return Response.json({
        follows: [
          {
            targetId: 'space-1',
            targetType: 'space',
            state: 'following',
            reason: 'membership',
            updatedAt: stamp,
            target: { id: 'space-1', type: 'space', label: 'Embedded space title' },
          },
          {
            targetId: 'erased-subject',
            targetType: 'subject',
            state: 'following',
            reason: 'explicit',
            updatedAt: stamp,
            target: null,
          },
        ],
        next: null,
      });
    }) as typeof fetch,
  });
  const env = sessionEnv();

  const first = await loadMineFollowingPage(client, pageRequest('/en/library/following'), env, {});
  expect(first.signedIn).toBe(true);
  expect(first.follows.map(({ targetId, targetType }) => [targetId, targetType])).toEqual([
    ['subject-1', 'subject'],
    ['collection-1', 'collection'],
  ]);
  expect(first.follows[0]?.target?.label).toEqual({ value: 'Embedded book title', language: 'en' });
  expect(first.follows[1]?.target?.label).toBe('Embedded collection title');
  expect(first.next).toBe('cursor-page-two');

  const second = await loadMineFollowingPage(client, pageRequest('/en/library/following?cursor=cursor-page-two'), env, {
    cursor: first.next ?? undefined,
  });
  expect(second.signedIn).toBe(true);
  expect(second.follows.map(({ targetId, targetType }) => [targetId, targetType])).toEqual([
    ['space-1', 'space'],
    ['erased-subject', 'subject'],
  ]);
  expect(second.follows[0]?.target?.label).toBe('Embedded space title');
  expect(second.follows[1]?.target).toBeNull();
  expect(second.next).toBeNull();
  expect(requests).toEqual([
    { method: 'GET', path: '/v1/follows', cursor: null },
    { method: 'GET', path: '/v1/follows', cursor: 'cursor-page-two' },
  ]);
  expect([...first.follows, ...second.follows].every((follow) => !('followerCount' in follow))).toBe(true);
});

test('signed-out Following returns an empty private view without reading the native list', async () => {
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async () => {
      throw new Error('signed-out Following must not read native follows');
    }) as typeof fetch,
  });

  const page = await loadMineFollowingPage(client, new Request(`${siteOrigin}/en/library/following`), {}, {});

  expect(page).toEqual({ signedIn: false, follows: [], next: null });
});

test('unfollow sends one authenticated native delete for the selected target', async () => {
  const requests: Request[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return Response.json({ follow: { targetId: 'collection-1', state: 'unfollowed' } });
    }) as typeof fetch,
  });

  const ok = await unfollowFollow(client, pageRequest('/en/library/following', 'POST', true), sessionEnv(), {
    targetId: 'collection-1',
    idempotencyKey: '123e4567-e89b-42d3-a456-426614174000',
  });

  expect(ok).toBe(true);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.method).toBe('DELETE');
  expect(new URL(requests[0]!.url).pathname).toBe('/v1/follows/collection-1');
  expect(requests[0]?.headers.get('authorization')).toBe('Bearer alice-page-token');
  expect(requests[0]?.headers.get('idempotency-key')).toBe('123e4567-e89b-42d3-a456-426614174000');
});

test('Following management has a genuine discovery destination after the last unfollow and never claims a partial empty page proves an empty account', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: `${siteOrigin}/en/library/following`, width: 1280, height: 900 });
  window.document.documentElement.lang = 'en';
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLButtonElement: window.HTMLButtonElement,
    Element: window.Element,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Document: window.Document,
    ShadowRoot: window.ShadowRoot,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    PointerEvent: window.PointerEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    scrollTo: window.scrollTo.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

  const requests: Request[] = [];
  const follow = {
    targetId: '01a17a3b-6b89-748f-a486-33c354ef3c9a',
    targetType: 'subject',
    state: 'following',
    reason: 'library',
    updatedAt: stamp,
    target: { id: '01a17a3b-6b89-748f-a486-33c354ef3c9a', type: 'schema:Book', label: 'Kokoro' } as {
      id: string;
      type: string;
      label: string;
    } | null,
  };
  let list = { follows: [follow], next: 'opaque-next' as string | null };
  let listStatus = 200;
  let deleteResponse = async () => Response.json({ code: 'forbidden' }, { status: 403 });
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      expect(request.headers.get('authorization')).toBe('Bearer alice-page-token');
      const url = new URL(request.url);
      if (request.method === 'GET') {
        expect(url.pathname).toBe('/v1/follows');
        expect(url.searchParams.get('view')).toBe('FULL');
        expect(url.searchParams.get('limit')).toBe('100');
        return listStatus === 200
          ? Response.json(list)
          : Response.json({ code: listStatus === 403 ? 'forbidden' : 'unavailable' }, { status: listStatus });
      }
      expect(request.method).toBe('DELETE');
      expect(url.pathname).toBe(`/v1/follows/${follow.targetId}`);
      return deleteResponse();
    },
  });
  const env = sessionEnv();
  const read = (cursor?: string) =>
    loadMineFollowingPage(client, pageRequest('/en/library/following'), env, { cursor });
  // Only the server-function transport/session boundary is supplied by this DOM test.
  // The page, shared control and default client consume constructed HTTP responses, not native evidence.
  mock.module('cloudflare:workers', () => ({ env: {} }));
  const originalFollowActions = { ...(await import('../src/library/follow-actions')) };
  mock.module('../src/library/follow-actions', () => ({
    readFollowState: ({ data }: { data: { targetId: string } }) =>
      loadFollowState(client, pageRequest('/en/library/following'), env, data.targetId),
    setFollow: ({ data, headers }: { data: FollowWriteInput; headers: Record<string, string> }) => {
      expect(headers['X-CSRF-Token']).toBe(csrfToken);
      return writeFollowRecord(client, pageRequest('/en/library/following', 'POST', true), env, data);
    },
  }));
  const session = { ...(await import('../src/session/query')) };
  mock.module('../src/session/query', () => ({
    ...session,
    useSession: () => ({ state: 'signed-in', subject: 'alice', csrfToken }),
  }));
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
  const { MineFollowingPageView } = await import('../src/library/mine-following-page');
  const { m } = await import('../src/paraglide/messages.js');
  const initial = await read();
  let showPage!: (page: MineFollowingPage) => void;
  let showAddressRejected!: (rejected: boolean) => void;
  function Page() {
    const [page, setPage] = useState(initial);
    const [addressRejected, setRejected] = useState(false);
    showPage = setPage;
    showAddressRejected = setRejected;
    return createElement(MineFollowingPageView, {
      page,
      ...(addressRejected ? { cursor: 'x'.repeat(2049) } : {}),
      invalidAddress: addressRejected,
    });
  }
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnMount: false } } });
  queryClient.setQueryData(session.sessionQuery.queryKey, { state: 'signed-in', subject: 'alice', csrfToken });
  const lifetime = viewerExposureLifetime(queryClient);
  const stopAdmission = lifetime.subscribe(() => {});
  const admission = lifetime.getSnapshot();
  if (admission.state !== 'signed-in') throw new Error('Expected current viewer observation');
  queryClient.setQueryData(viewerExposureQuery(admission.observation).queryKey, {
    subject: 'alice',
    admitted: ['personal_library'],
  });
  const router = createRouter({
    routeTree: createRootRoute({ component: Page }),
    history: createMemoryHistory({ initialEntries: ['/library/following'] }),
  });
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const row = () => host.querySelector('[data-slot="list-row"]');
  const empty = () => host.querySelector('[data-slot="empty"]');
  const discovery = () => host.querySelector<HTMLAnchorElement>('[data-slot="empty"] a');
  const more = () =>
    [...host.querySelectorAll<HTMLAnchorElement>('a')].find((link) => link.textContent === m.library_collection_more());
  const followButton = () => host.querySelector<HTMLButtonElement>('[data-slot="follow-control"] button');
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });
  const awaitFollowAction = async () => {
    for (let i = 0; i < 20 && !followButton(); i++) await settle();
    expect(followButton()).not.toBeNull();
  };
  const remove = async () => {
    await awaitFollowAction();
    await act(async () => {
      followButton()!.click();
    });
    await settle();
    const action = window.document.querySelector<HTMLElement>('[role="menuitem"]');
    expect(action?.textContent).toBe(m.library_follow_unfollow());
    await act(async () => {
      action!.click();
    });
    await settle();
  };
  try {
    await router.load();
    await act(async () => {
      root.render(
        createElement(QueryClientProvider, { client: queryClient }, createElement(RouterProvider, { router })),
      );
    });
    expect(row()?.textContent).toContain('Kokoro');
    expect(row()?.textContent).toContain(m.library_follow_reason_library());
    await awaitFollowAction();
    expect(empty()).toBeNull();
    await act(async () => showAddressRejected(true));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(m.library_directory_address_invalid());
    expect(host.querySelector<HTMLAnchorElement>('a[href="/en/library/following"]')?.textContent).toBe(
      m.library_directory_address_first_page(),
    );
    expect(row()).toBeNull();
    expect(host.textContent).not.toContain('Kokoro');
    await act(async () => showAddressRejected(false));
    expect(row()?.textContent).toContain('Kokoro');
    await awaitFollowAction();
    for (const response of [
      async () => Response.json({ code: 'forbidden' }, { status: 403 }),
      async () => Response.json({ code: 'unavailable' }, { status: 503 }),
      async () => Response.json({}),
      async () => {
        throw new TypeError('Response lost');
      },
    ]) {
      deleteResponse = response;
      await remove();
      expect(row()?.textContent).toContain('Kokoro');
      expect(host.querySelector('[role="alert"]')).not.toBeNull();
      expect(empty()).toBeNull();
      expect(host.textContent).not.toContain(m.library_follow_removed());
    }
    let resolveDelete!: (response: Response) => void;
    deleteResponse = () =>
      new Promise<Response>((resolve) => {
        resolveDelete = resolve;
      });
    await remove();
    expect(row()).not.toBeNull();
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(empty()).toBeNull();
    await act(async () => {
      resolveDelete(Response.json({ follow: { ...follow, state: 'unfollowed' } }));
    });
    expect(row()).toBeNull();
    expect(host.textContent).toContain(m.library_follow_removed());
    expect(empty()?.textContent).toContain(m.library_following_page_empty());
    expect(discovery()?.getAttribute('href')).toBe('/en/search');
    expect(discovery()?.textContent).toBe(m.search_heading());
    expect(new URL(more()!.href).searchParams.get('cursor')).toBe('opaque-next');
    const deletes = requests.filter((request) => request.method === 'DELETE');
    expect(deletes).toHaveLength(5);
    expect(
      deletes.every((request) => request.headers.get('idempotency-key') === initial.follows[0]!.idempotencyKey),
    ).toBe(true);
    expect(requests.filter((request) => request.method === 'GET')).toHaveLength(1);

    list = { follows: [{ ...follow, state: 'unfollowed', target: null }], next: 'opaque-next' };
    const inactive = await read('opaque-current');
    await act(async () => showPage(inactive));
    expect(row()).toBeNull();
    expect(empty()?.textContent).toContain(m.library_following_page_empty());
    expect(empty()?.textContent).not.toContain(m.library_following_empty());
    expect(host.textContent).not.toContain(m.library_follow_removed());
    expect(discovery()?.getAttribute('href')).toBe('/en/search');
    expect(new URL(more()!.href).searchParams.get('cursor')).toBe('opaque-next');
    expect(requests.filter((request) => request.method === 'GET')).toHaveLength(2);
    expect(new URL(requests.at(-1)!.url).searchParams.get('cursor')).toBe('opaque-current');

    list = { follows: [], next: null };
    await act(async () => showPage(await read()));
    expect(empty()?.textContent).toContain(m.library_following_empty());
    expect(host.textContent).not.toContain(m.library_follow_removed());
    expect(discovery()?.getAttribute('href')).toBe('/en/search');
    const beforeSignedOut = requests.length;
    const signedOut = await loadMineFollowingPage(client, new Request(`${siteOrigin}/en/library/following`), {}, {});
    await act(async () => showPage(signedOut));
    expect(empty()).toBeNull();
    expect(requests).toHaveLength(beforeSignedOut);
    for (const status of [403, 503]) {
      listStatus = status;
      await expect(read()).rejects.toThrow();
    }
  } finally {
    stopAdmission();
    await act(async () => root.unmount());
    queryClient.clear();
    await window.happyDOM.close();
    mock.module('../src/library/follow-actions', () => originalFollowActions);
    mock.module('../src/session/query', () => session);
    mock.restore();
    for (const key of Object.keys(globals)) {
      const descriptor = previous.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

// Authored recovery acceptance is intentionally UNRUN in this source-only attempt.
test('hidden follow targets stay a successful FULL page and never become a thrown kernel read', async () => {
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async () =>
      Response.json({
        follows: [
          {
            targetId: 'hidden-subject',
            targetType: 'subject',
            state: 'following',
            reason: 'explicit',
            updatedAt: stamp,
            target: null,
          },
          {
            targetId: 'visible-subject',
            targetType: 'subject',
            state: 'following',
            reason: 'library',
            updatedAt: stamp,
            target: { id: 'visible-subject', type: 'schema:Book', label: 'Kokoro', types: ['schema:Book'] },
          },
        ],
        next: null,
      }),
  });
  const page = await loadMineFollowingPage(client, pageRequest('/en/library/following'), sessionEnv(), {});
  expect(page.signedIn).toBe(true);
  expect(page.follows).toHaveLength(2);
  expect(page.follows[0]).toMatchObject({ targetId: 'hidden-subject', target: null, state: 'following' });
  expect(page.follows[1]?.target).toMatchObject({ id: 'visible-subject', label: 'Kokoro' });
});

test('a terminal later Following page is one bounded read without reset metadata or a whole-list count', async () => {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.example.test', {
    fetch: async (input, init) => {
      const call = new Request(input, init);
      calls.push(call);
      return Response.json({ follows: [], next: null });
    },
  });
  const page = await loadMineFollowingPage(client, pageRequest('/en/library/following'), sessionEnv(), {
    cursor: 'terminal/page+',
  });
  expect(page).toEqual({ signedIn: true, follows: [], next: null });
  expect(calls).toHaveLength(1);
  expect(Object.fromEntries(new URL(calls[0]!.url).searchParams)).toEqual({
    view: 'FULL',
    limit: '100',
    cursor: 'terminal/page+',
  });
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer alice-page-token');
  expect(calls[0]!.cache).toBe('no-store');
  expect(calls[0]!.redirect).toBe('manual');
});

test('Following marks only a successful single stale-cursor fallback and never retries the fallback or unrelated errors', async () => {
  for (const fallbackStatus of [200, 409, 503]) {
    const calls: Request[] = [];
    const client = createKernelClient('https://kernel.example.test', {
      fetch: async (input, init) => {
        const call = new Request(input, init);
        calls.push(call);
        if (new URL(call.url).searchParams.has('cursor'))
          return Response.json({ code: 'stale_cursor' }, { status: 409 });
        return fallbackStatus === 200
          ? Response.json({ follows: [], next: 'new/next+' })
          : Response.json(
              { code: fallbackStatus === 409 ? 'stale_cursor' : 'unavailable' },
              { status: fallbackStatus },
            );
      },
    });
    const result = loadMineFollowingPage(client, pageRequest('/en/library/following'), sessionEnv(), {
      cursor: 'expired/page+',
    });
    if (fallbackStatus === 200)
      expect(await result).toEqual({ signedIn: true, follows: [], next: 'new/next+', cursorReset: true });
    else await expect(result).rejects.toThrow();
    expect(calls.map((call) => new URL(call.url).searchParams.get('cursor'))).toEqual(['expired/page+', null]);
    expect(calls.every((call) => call.headers.get('authorization') === 'Bearer alice-page-token')).toBe(true);
    expect(calls.every((call) => call.cache === 'no-store' && call.redirect === 'manual')).toBe(true);
    expect(calls.every((call) => new URL(call.url).searchParams.get('limit') === '100')).toBe(true);
  }
  for (const [cursor, status] of [
    [undefined, 409],
    ['current/page+', 503],
  ] as const) {
    let calls = 0;
    const client = createKernelClient('https://kernel.example.test', {
      fetch: async () => {
        calls++;
        return Response.json({ code: status === 409 ? 'stale_cursor' : 'unavailable' }, { status });
      },
    });
    await expect(
      loadMineFollowingPage(client, pageRequest('/en/library/following'), sessionEnv(), { cursor }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  }
});
