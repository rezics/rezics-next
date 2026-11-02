import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { dirname } from 'node:path';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import type { MineFollowingRead } from '../src/library/mine-following-actions';
import type { FollowWriteInput, FollowWriteResult } from '../src/library/follow-records';
import type { SessionEnv } from '../src/session/client';

// UNRUN: one mounted/deferred journey and actual server-export regressions for integration.
// Controlled IO does not establish native authorization, browser, or full acceptance proof.
const origin = 'https://site.test';
const csrfToken = 'A'.repeat(22);
const current = { status: 'active', subject: 'prepared-owner', token: 'opaque-credential', preparations: 0 };
const env: Partial<SessionEnv> = {
  SITE_ORIGINS: origin,
  AUTH_ISSUER: 'https://auth.test',
  API_RESOURCE: 'https://kernel.test',
  WEBSITE_SCOPES: 'openid',
  WEBSITE_CLIENT_ID: 'web',
  WEBSITE_CLIENT_KEY: 'unused',
  SESSIONS: {
    idFromName: (id: string) => id,
    get: () => ({
      credential: async () => {
        current.preparations++;
        return current.status === 'active'
          ? { status: 'active', subject: current.subject, accessToken: current.token, csrfToken }
          : { status: current.status, csrfToken };
      },
    }),
  } as unknown as SessionEnv['SESSIONS'],
};
const request = () =>
  new Request(`${origin}/en/library/following`, {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
let actualRequest = request();
const responseHeaders = new Headers();
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => actualRequest,
  setResponseHeader: (name: string, value: string) => responseHeaders.set(name, value),
}));
mock.module('cloudflare:workers', () => ({ env }));
afterAll(() => mock.restore());

const actions = await import('../src/library/mine-following-actions');
const kernel = await import('../src/kernel/client');
const definitions = await import('../src/subject/definitions');
const { prepareSession, sessionSubject } = await import('../src/session/request');

test('the actual Following server exports refuse stale preparation without private IO or an asserted viewer', async () => {
  current.status = 'active';
  actualRequest = request();
  await prepareSession(actualRequest, env);
  expect(sessionSubject(actualRequest)).toBe('prepared-owner');
  current.status = 'absent';
  let privateCalls = 0;
  const client = createKernelClient('https://kernel.test', {
    fetch: async () => {
      privateCalls++;
      throw new Error('Refused preparation reached private IO');
    },
  });
  const transport = spyOn(kernel, 'kernelClient').mockReturnValue(client);
  try {
    const before = current.preparations;
    const page = { signedIn: false, follows: [], next: null };
    expect(await actions.readMineFollowingForViewer({ data: { cursor: 'private/address+' } })).toEqual({
      subject: null,
      cursor: 'private/address+',
      locale: 'en',
      page,
    });
    expect(current.preparations - before).toBe(1);
    expect(await actions.readMineFollowingPage({ data: {} })).toEqual(page);
    expect(sessionSubject(actualRequest)).toBe('prepared-owner'); // A stale WeakMap entry is not provenance.
    current.status = 'unavailable';
    await expect(actions.readMineFollowingForViewer({ data: {} })).rejects.toMatchObject({
      problem: { status: 502, code: 'dependency_unavailable' },
    });
    actualRequest = new Request(`${origin}/en/library/following`, {
      headers: { authorization: 'Bearer browser-asserted-identity' },
    });
    expect(await actions.readMineFollowingForViewer({ data: { cursor: '' } })).toEqual({
      subject: null,
      cursor: null,
      locale: 'en',
      page,
    });
    expect(privateCalls).toBe(0);
    expect(responseHeaders.get('cache-control')).toBe('private, no-store');
  } finally {
    transport.mockRestore();
  }
});

test('the actual envelope names returned targets and carries the reader-prepared subject and exact requested address', async () => {
  current.status = 'active';
  current.subject = 'actual-owner';
  current.token = 'opaque-not-a-decoded-identity';
  actualRequest = request();
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const call = new Request(input, init);
      calls.push(call);
      current.subject = 'different-if-reprepared';
      if (new URL(call.url).searchParams.has('cursor')) return Response.json({ code: 'stale_cursor' }, { status: 409 });
      return Response.json({
        follows: [
          {
            targetId: 'stored-original',
            targetType: 'subject',
            state: 'following',
            reason: 'library',
            target: { id: 'returned-canonical', type: 'Book', label: 'Actual supplied title' },
          },
          { targetId: 'hidden-space', targetType: 'space', state: 'following', reason: 'membership', target: null },
        ],
        next: 'opaque/next+',
      });
    },
  });
  const transport = spyOn(kernel, 'kernelClient').mockReturnValue(client);
  const naming = spyOn(definitions, 'nameSubjectTypes').mockImplementation(async (targets) => {
    for (const target of targets) if (target) target.typeLabel = 'Released book label';
  });
  try {
    const before = current.preparations;
    const address = 'opaque/stale+cursor=';
    const result = await actions.readMineFollowingForViewer({
      data: { cursor: address, subject: 'browser-forgery' } as { cursor: string },
    });
    expect(current.preparations - before).toBe(1);
    expect(result.subject).toBe('actual-owner');
    expect(result.cursor).toBe(address);
    expect(result.locale).toBe('en');
    expect(result.page).toMatchObject({ signedIn: true, next: 'opaque/next+' });
    const target = result.page.follows[0]!.target;
    expect(target).toMatchObject({ id: 'returned-canonical', typeLabel: 'Released book label' });
    const named = [...naming.mock.calls[0]![0]];
    expect(named[0]).toBe(target);
    expect(named[1]).toBeNull();
    expect(calls.map((call) => Object.fromEntries(new URL(call.url).searchParams))).toEqual([
      { view: 'FULL', limit: '100', cursor: address },
      { view: 'FULL', limit: '100' },
    ]);
    expect(calls.every((call) => call.headers.get('authorization') === 'Bearer opaque-not-a-decoded-identity')).toBe(
      true,
    );
    expect(calls.every((call) => call.cache === 'no-store' && call.redirect === 'manual')).toBe(true);
    const compatible = await actions.readMineFollowingPage({ data: { cursor: '' } });
    expect(Object.keys(compatible).sort()).toEqual(['follows', 'next', 'signedIn']);
    expect(compatible.follows[0]!.target?.typeLabel).toBe('Released book label');
  } finally {
    naming.mockRestore();
    transport.mockRestore();
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const loaded = (
  subject: string,
  cursor: string | null,
  title: string,
  next: string | null = `${subject}-next`,
): MineFollowingRead => ({
  subject,
  cursor,
  locale: 'en',
  page: {
    signedIn: true,
    follows: [
      {
        targetId: 'same-stored-target',
        targetType: 'subject',
        state: 'following',
        reason: subject === 'A' ? 'library' : 'explicit',
        idempotencyKey: crypto.randomUUID(),
        target: {
          id: `${subject}-canonical`,
          type: 'Book',
          types: ['Book'],
          label: title,
          typeLabel: `${subject} kind`,
          cover: null,
        },
      },
    ],
    next,
  },
});

test('the mounted default Following composition retires viewer, cursor and row lifetimes while current native removal remains usable', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: `${origin}/en/library/following`, width: 1280, height: 900 });
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
    scrollTo: window.scrollTo.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } =
    await import('@tanstack/react-router');
  const { sessionQuery, exposureQuery } = await import('../src/session/query');
  const exposure = await import('../src/kernel/viewer-exposure');
  const exposureRead = spyOn(exposure, 'readViewerExposure').mockImplementation(async ({ data }) => ({
    subject: data,
    admitted: client.getQueryData<string[]>(exposureQuery.queryKey) ?? [],
  }));
  const { mineFollowingQuery } = await import('../src/library/mine-following-page');
  const { Route } = await import('../src/routes/library/following');
  const followActions = await import('../src/library/follow-actions');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale } = await import('../src/paraglide/runtime.js');
  const reads: (ReturnType<typeof deferred<MineFollowingRead>> & { cursor?: string })[] = [];
  const writes: (ReturnType<typeof deferred<FollowWriteResult>> & { input: FollowWriteInput; csrf: string | null })[] =
    [];
  const read = spyOn(actions, 'readMineFollowingForViewer').mockImplementation(({ data }) => {
    const call = { ...deferred<MineFollowingRead>(), cursor: data.cursor };
    reads.push(call);
    return call.promise;
  });
  const write = spyOn(followActions, 'setFollow').mockImplementation(({ data, headers }) => {
    const call = {
      ...deferred<FollowWriteResult>(),
      input: structuredClone(data),
      csrf: new Headers(headers).get('X-CSRF-Token'),
    };
    writes.push(call);
    return call.promise;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const viewer = (subject: string, token: string | null = 'csrf-one') => ({
    state: 'signed-in',
    subject,
    csrfToken: token,
  });
  client.setQueryData(sessionQuery.queryKey, viewer('A', null));
  client.setQueryData(exposureQuery.queryKey, ['personal_library']);
  const initial = loaded('A', null, 'A private title');
  const retainedLoader = spyOn(Route, 'useLoaderData').mockImplementation(() => initial);
  const rootRoute = createRootRoute();
  const followingRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/library/following',
    component: Route.options.component!,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([followingRoute]),
    history: createMemoryHistory({ initialEntries: ['/library/following'] }),
  });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
  const settle = <T,>(call: ReturnType<typeof deferred<T>>, result: T) =>
    act(async () => {
      call.resolve(result);
      await tick();
    });
  const key = (cursor: string | null) => mineFollowingQuery('B', cursor, getLocale()).queryKey;
  const refetch = (cursor: string | null) =>
    act(async () => {
      void client.refetchQueries({ queryKey: key(cursor) });
      await tick();
    });
  const remove = async () => {
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-slot="follow-control"] button')!.click();
      await tick();
    });
    const action = window.document.querySelector<HTMLElement>('[role="menuitem"]');
    expect(action?.textContent).toBe(m.library_follow_unfollow());
    await act(async () => {
      action!.click();
      await tick();
    });
  };
  const expectRetired = () => {
    expect(host.querySelector('[data-slot="list-row"]')).toBeNull();
    expect(host.querySelector('[data-slot="follow-control"]')).toBeNull();
    expect(host.querySelector('nav')).toBeNull();
    expect(host.textContent).not.toContain(m.library_follow_removed());
  };
  try {
    await router.load();
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
      await tick();
    });
    expect(host.textContent).toContain('A private title');
    expect(reads).toHaveLength(1);
    await remove();
    expect(writes).toHaveLength(0);
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, viewer('A'));
      await tick();
    });
    expect(writes).toHaveLength(0);
    await remove();
    const aRead = reads[0]!;
    const aRemoval = writes[0]!;
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, viewer('B'));
      await tick();
    });
    expectRetired();
    expect(host.textContent).not.toContain('A private title');
    expect(host.textContent).not.toContain(m.library_follow_reason_library());
    expect(host.querySelector('a[href*="A-canonical"]')).toBeNull();
    expect(reads).toHaveLength(2); // B progresses while both A operations remain pending.
    const b = loaded('B', null, 'B current title');
    await settle(reads[1]!, b);
    expect(host.textContent).toContain('B current title');
    await remove();
    const uncertain = writes[1]!;
    expect(uncertain.input.idempotencyKey).toBe(b.page.follows[0]!.idempotencyKey);
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, viewer('B', 'csrf-rotated'));
      await tick();
    });
    await refetch(null);
    await settle(reads.at(-1)!, loaded('B', null, 'B current title'));
    expect(host.querySelector('[data-slot="follow-control"]')?.getAttribute('aria-busy')).toBe('true');
    await settle(uncertain, { ok: false, reason: 'unavailable' });
    await remove();
    const retry = writes.at(-1)!;
    expect(retry.input).toEqual(uncertain.input);
    expect(retry.csrf).toBe('csrf-one');
    await settle(aRead, loaded('A', null, 'Late A disclosure'));
    await settle(aRemoval, { ok: true, following: false });
    expect(host.textContent).toContain('B current title');
    expect(host.textContent).not.toContain('Late A disclosure');
    expect(host.textContent).not.toContain(m.library_follow_removed());

    await act(async () => {
      await router.navigate({ to: '/library/following', search: { cursor: 'current/cursor+' } });
      await tick();
    });
    expectRetired();
    expect(reads.at(-1)!.cursor).toBe('current/cursor+');
    await settle(reads.at(-1)!, loaded('B', 'wrong/cursor+', 'Wrong address disclosure'));
    expectRetired();
    expect(host.textContent).not.toContain('Wrong address disclosure');
    await refetch('current/cursor+');
    await settle(reads.at(-1)!, loaded('B', 'current/cursor+', 'B next page title'));
    await settle(retry, { ok: true, following: false });
    expect(host.textContent).toContain('B next page title');
    expect(host.textContent).not.toContain(m.library_follow_removed());
    await remove();
    const replacedRowRemoval = writes.at(-1)!;
    await refetch('current/cursor+');
    await settle(reads.at(-1)!, loaded('B', 'current/cursor+', 'B replacement row', 'bounded-more'));
    await settle(replacedRowRemoval, { ok: true, following: false });
    expect(host.textContent).toContain('B replacement row');
    expect(host.textContent).not.toContain(m.library_follow_removed());

    await act(async () => {
      const snapshot = exposure.viewerExposureLifetime(client).getSnapshot();
      if (snapshot.state !== 'signed-in') throw new Error('No current viewer');
      client.setQueryData(exposure.viewerExposureQuery(snapshot.observation).queryKey, { subject: 'B', admitted: [] });
      client.setQueryData(exposureQuery.queryKey, []);
      await tick();
    });
    expectRetired();
    await act(async () => {
      const snapshot = exposure.viewerExposureLifetime(client).getSnapshot();
      if (snapshot.state !== 'signed-in') throw new Error('No current viewer');
      client.setQueryData(exposure.viewerExposureQuery(snapshot.observation).queryKey, {
        subject: 'B',
        admitted: ['personal_library'],
      });
      client.setQueryData(exposureQuery.queryKey, ['personal_library']);
      await tick();
    });
    await settle(reads.at(-1)!, loaded('B', 'current/cursor+', 'B replacement row', 'bounded-more'));
    await remove();
    await settle(writes.at(-1)!, { ok: true, following: false });
    expect(host.querySelector('[data-slot="list-row"]')).toBeNull();
    expect(host.textContent).toContain(m.library_follow_removed());
    expect(host.textContent).toContain(m.library_following_page_empty());
    expect(host.querySelector('[data-slot="empty"] a')?.getAttribute('href')).toBe('/en/search');
    const more = host.querySelector<HTMLAnchorElement>('nav a');
    expect(new URL(more!.href).searchParams.get('cursor')).toBe('bounded-more');
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, { state: 'unknown', subject: null, csrfToken: null });
      await tick();
    });
    expectRetired();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    exposureRead.mockRestore();
    read.mockRestore();
    write.mockRestore();
    retainedLoader.mockRestore();
    await window.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('the actual Following reset envelope preserves the originating prepared viewer and normalized requested address', async () => {
  current.status = 'active';
  current.subject = 'reset-owner';
  current.token = 'reset-owner-token';
  actualRequest = request();
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      const call = new Request(input, init);
      calls.push(call);
      current.subject = 'another-viewer-if-reprepared';
      return new URL(call.url).searchParams.has('cursor')
        ? Response.json({ code: 'stale_cursor' }, { status: 409 })
        : Response.json({ follows: [], next: null });
    },
  });
  const transport = spyOn(kernel, 'kernelClient').mockReturnValue(client);
  try {
    const before = current.preparations;
    const result = await actions.readMineFollowingForViewer({ data: { cursor: 'expired/original+address=' } });
    expect(result).toEqual({
      subject: 'reset-owner',
      cursor: 'expired/original+address=',
      locale: 'en',
      page: { signedIn: true, follows: [], next: null, cursorReset: true },
    });
    expect(current.preparations - before).toBe(1);
    expect(calls.map((call) => new URL(call.url).searchParams.get('cursor'))).toEqual([
      'expired/original+address=',
      null,
    ]);
    expect(calls.every((call) => call.headers.get('authorization') === 'Bearer reset-owner-token')).toBe(true);
    expect(calls.every((call) => call.cache === 'no-store' && call.redirect === 'manual')).toBe(true);
    expect(responseHeaders.get('cache-control')).toBe('private, no-store');
    const normal = await actions.readMineFollowingForViewer({ data: { cursor: '' } });
    expect(normal.cursor).toBeNull();
    expect(normal.page.cursorReset).toBeUndefined();
    expect(calls).toHaveLength(3);
    expect(() => actions.readMineFollowingForViewer({ data: { cursor: 'x'.repeat(2049) } })).toThrow(
      'Invalid follows cursor',
    );
    expect(calls).toHaveLength(3);
  } finally {
    transport.mockRestore();
  }
});

test('Following recovery stays page-local through terminal pages, last-row removal, stale reset and origin retirement', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: `${origin}/en/library/following`, width: 1280, height: 900 });
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
    scrollTo: window.scrollTo.bind(window),
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } =
    await import('@tanstack/react-router');
  const { sessionQuery, exposureQuery } = await import('../src/session/query');
  const exposure = await import('../src/kernel/viewer-exposure');
  const exposureRead = spyOn(exposure, 'readViewerExposure').mockImplementation(async ({ data }) => ({
    subject: data,
    admitted: client.getQueryData<string[]>(exposureQuery.queryKey) ?? [],
  }));
  const { mineFollowingQuery } = await import('../src/library/mine-following-page');
  const { Route } = await import('../src/routes/library/following');
  const followActions = await import('../src/library/follow-actions');
  const { m } = await import('../src/paraglide/messages.js');
  const { getLocale } = await import('../src/paraglide/runtime.js');
  const reads: (ReturnType<typeof deferred<MineFollowingRead>> & { cursor?: string })[] = [];
  const writes: ReturnType<typeof deferred<FollowWriteResult>>[] = [];
  const read = spyOn(actions, 'readMineFollowingForViewer').mockImplementation(({ data }) => {
    const call = { ...deferred<MineFollowingRead>(), cursor: data.cursor };
    reads.push(call);
    return call.promise;
  });
  const write = spyOn(followActions, 'setFollow').mockImplementation(() => {
    const call = deferred<FollowWriteResult>();
    writes.push(call);
    return call.promise;
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const viewer = (subject: string) => ({ state: 'signed-in', subject, csrfToken: 'current-csrf' });
  client.setQueryData(sessionQuery.queryKey, viewer('A'));
  client.setQueryData(exposureQuery.queryKey, ['personal_library']);
  const initial = loaded('A', 'terminal/page+', 'Last visible row', null);
  const retainedLoader = spyOn(Route, 'useLoaderData').mockReturnValue(initial);
  const rootRoute = createRootRoute();
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: '/library/following',
    component: Route.options.component!,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: ['/library/following?cursor=terminal%2Fpage%2B'] }),
  });
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
  const settle = <T,>(call: ReturnType<typeof deferred<T>>, result: T) =>
    act(async () => {
      call.resolve(result);
      await tick();
    });
  const restart = () =>
    [...host.querySelectorAll<HTMLAnchorElement>('nav a')].find(
      (link) => link.textContent === m.library_collections_first_page(),
    );
  const expectPageEmpty = () => {
    expect(host.querySelector('[data-slot="list-row"]')).toBeNull();
    expect(host.textContent).toContain(m.library_following_page_empty());
    expect(host.textContent).not.toContain(m.library_following_empty());
    expect(host.querySelector('[data-slot="empty"] a')?.getAttribute('href')).toBe('/en/search');
    expect(new URL(restart()!.href).pathname).toBe('/library/following');
    expect(new URL(restart()!.href).searchParams.has('cursor')).toBe(false);
  };
  const expectRetired = () => {
    expect(host.querySelector('[data-slot="list-row"], [data-slot="follow-control"], nav')).toBeNull();
    expect(host.textContent).not.toContain(m.library_collections_cursor_reset());
    expect(host.textContent).not.toContain(m.library_follow_removed());
    expect(host.textContent).not.toContain(m.library_following_empty());
    expect(host.textContent).not.toContain(m.library_following_page_empty());
  };
  const navigate = (cursor: string) =>
    act(async () => {
      await router.navigate({ to: '/library/following', search: { cursor } });
      await tick();
    });
  const refetch = (subject: string, cursor: string) =>
    act(async () => {
      void client.refetchQueries({ queryKey: mineFollowingQuery(subject, cursor, getLocale()).queryKey });
      await tick();
    });
  const remove = async () => {
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-slot="follow-control"] button')!.click();
      await tick();
    });
    const action = window.document.querySelector<HTMLElement>('[role="menuitem"]');
    expect(action?.textContent).toBe(m.library_follow_unfollow());
    await act(async () => {
      action!.click();
      await tick();
    });
  };
  try {
    await router.load();
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
      await tick();
    });
    expect(reads).toHaveLength(1);
    await settle(reads[0]!, initial);
    expect(host.textContent).toContain('Last visible row');
    expect(restart()).toBeDefined(); // Populated later pages also have a way back.
    const beforeRemoval = reads.length;
    await remove();
    await settle(writes[0]!, { ok: true, following: false });
    expectPageEmpty();
    expect(host.textContent).toContain(m.library_follow_removed());
    expect(reads).toHaveLength(beforeRemoval); // No discovery of other pages after a local removal.

    await act(async () => {
      restart()!.click();
      await tick();
    });
    expect(router.state.location.search).toEqual({});
    expectRetired();
    expect(reads.at(-1)!.cursor).toBeUndefined();
    const firstEmpty = loaded('A', null, 'Unused', null);
    firstEmpty.page.follows = [];
    await settle(reads.at(-1)!, firstEmpty);
    expect(host.textContent).toContain(m.library_following_empty());
    expect(host.textContent).not.toContain(m.library_following_page_empty());
    expect(restart()).toBeUndefined();

    await navigate('empty/terminal+');
    const terminal = loaded('A', 'empty/terminal+', 'Unused', null);
    terminal.page.follows = [];
    await settle(reads.at(-1)!, terminal);
    expectPageEmpty();
    expect(host.textContent).not.toContain(m.library_follow_removed());
    expect(host.textContent).not.toContain(m.library_collections_cursor_reset());

    await navigate('expired/page+');
    const reset = loaded('A', 'expired/page+', 'Reset first-page row', 'bounded/next+');
    reset.page.cursorReset = true;
    await settle(reads.at(-1)!, reset);
    expect(host.textContent).toContain(m.library_collections_cursor_reset());
    expect(host.textContent).toContain('Reset first-page row');
    expect(router.state.location.search).toEqual({ cursor: 'expired/page+' });
    const oldRestart = restart()!;
    const oldNext = host.querySelector<HTMLAnchorElement>('nav a')!;
    expect(new URL(oldNext.href).searchParams.get('cursor')).toBe('bounded/next+');
    await remove();
    const oldRemoval = writes.at(-1)!;
    await refetch('A', 'expired/page+');
    const oldRead = reads.at(-1)!;
    const beforeRetirement = reads.length;
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, viewer('B'));
      // Exercise still-connected old handlers before React replaces the retired page.
      oldRestart.click();
      oldNext.click();
      await tick();
    });
    expectRetired();
    expect(router.state.location.search).toEqual({ cursor: 'expired/page+' });
    expect(reads).toHaveLength(beforeRetirement + 1);
    const bRead = reads.at(-1)!;
    await settle(oldRead, reset);
    await settle(oldRemoval, { ok: true, following: false });
    expectRetired();
    await settle(bRead, reset); // A reset is presentation metadata, never authority for another viewer.
    expectRetired();
    expect(host.textContent).toContain(m.library_follow_unavailable());
    await refetch('B', 'expired/page+');
    const wrongAddress = loaded('B', null, 'Wrong reset address', null);
    wrongAddress.page.cursorReset = true;
    await settle(reads.at(-1)!, wrongAddress);
    expectRetired();
    expect(host.textContent).not.toContain('Wrong reset address');
    await refetch('B', 'expired/page+');
    const currentReset = loaded('B', 'expired/page+', 'Unused', null);
    currentReset.page.follows = [];
    currentReset.page.cursorReset = true;
    await settle(reads.at(-1)!, currentReset);
    expectPageEmpty();
    expect(host.textContent).toContain(m.library_collections_cursor_reset());
    expect(host.textContent).not.toContain(m.library_follow_removed());
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
      await tick();
    });
    expectRetired();
  } finally {
    await act(async () => root.unmount());
    client.clear();
    exposureRead.mockRestore();
    read.mockRestore();
    write.mockRestore();
    retainedLoader.mockRestore();
    await window.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
