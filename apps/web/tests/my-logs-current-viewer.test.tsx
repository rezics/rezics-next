import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { dirname } from 'node:path';
import { act, useLayoutEffect } from 'react';
import * as start from '../.storybook/react-start';
import type { MyLogsViewerHistory } from '../src/library/logs-server';
import type { SessionEnv } from '../src/session/client';
import recording from '../src/kernel/recorded/library-published-logs.json';

const origin = 'https://site.test';
const current = {
  status: 'active',
  subject: 'actual-owner' as string | undefined,
  token: 'opaque-credential',
  preparations: 0,
};
const env: Partial<SessionEnv> = {
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
          ? { status: 'active', subject: current.subject, accessToken: current.token, csrfToken: 'A'.repeat(22) }
          : { status: current.status, csrfToken: 'A'.repeat(22) };
      },
    }),
  } as unknown as SessionEnv['SESSIONS'],
};
const request = () =>
  new Request(`${origin}/en/library/logs`, {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
let actualRequest = request();
let requestReads = 0;
const responseHeaders = new Headers();
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => {
    requestReads++;
    return actualRequest;
  },
  setResponseHeader: (name: string, value: string) => responseHeaders.set(name, value),
}));
mock.module('cloudflare:workers', () => ({ env }));
afterAll(() => mock.restore());
const server = await import('../src/library/logs-server');
const kernel = await import('../src/kernel/client');
const definitions = await import('../src/subject/definitions');
const { prepareSession, sessionSubject } = await import('../src/session/request');

test('actual My Logs viewer export refuses stale or missing preparation without owner data or fallback IO', async () => {
  current.status = 'active';
  current.subject = 'actual-owner';
  actualRequest = request();
  await prepareSession(actualRequest, env);
  let privateCalls = 0;
  const transport = spyOn(kernel, 'kernelClient').mockReturnValue(
    createKernelClient('https://kernel.test', {
      fetch: async () => {
        privateCalls++;
        throw new Error('Refused preparation reached owner IO');
      },
    }),
  );
  try {
    current.status = 'absent';
    const before = current.preparations;
    expect(await server.readMyPublishedLogHistoryForViewer({ data: { cursor: 'opaque/request+' } })).toEqual({
      sessionSubject: null,
      cursor: 'opaque/request+',
      locale: 'en',
      page: { state: 'signed-out' },
    });
    expect(current.preparations - before).toBe(1);
    expect(sessionSubject(actualRequest)).toBe('actual-owner'); // Stale WeakMap entries are not authority.
    current.status = 'unavailable';
    expect(await server.readMyPublishedLogHistoryForViewer({ data: {} })).toMatchObject({
      sessionSubject: null,
      page: { state: 'unavailable' },
    });
    current.status = 'active';
    current.subject = undefined;
    actualRequest = request();
    expect(await server.readMyPublishedLogHistoryForViewer({ data: {} })).toEqual({
      sessionSubject: null,
      cursor: null,
      locale: 'en',
      page: { state: 'signed-out' },
    });
    current.subject = 'actual-owner';
    actualRequest = request();
    await prepareSession(actualRequest, env);
    actualRequest.headers.set('authorization', 'Bearer unrelated-explicit-credential');
    expect(await server.readMyPublishedLogHistoryForViewer({ data: {} })).toMatchObject({
      sessionSubject: null,
      page: { state: 'denied' },
    });
    actualRequest = new Request(`${origin}/en/library/logs`);
    expect(await server.readMyPublishedLogHistoryForViewer({ data: {} })).toMatchObject({
      sessionSubject: null,
      page: { state: 'signed-out' },
    });
    expect(privateCalls).toBe(0);
    expect(responseHeaders.get('cache-control')).toBe('private, no-store');
  } finally {
    transport.mockRestore();
  }
});

test('actual My Logs envelope retains the same request prepared subject, exact stale requested cursor and named subjects', async () => {
  current.status = 'active';
  current.subject = 'actual-owner';
  actualRequest = request();
  const calls: Request[] = [];
  const transport = spyOn(kernel, 'kernelClient').mockReturnValue(
    createKernelClient('https://kernel.test', {
      fetch: async (input, init) => {
        const call = new Request(input, init);
        calls.push(call);
        expect(call.cache).toBe('no-store');
        expect(call.redirect).toBe('manual');
        expect(call.headers.get('authorization')).toBe('Bearer opaque-credential');
        const url = new URL(call.url);
        expect(url.pathname).toBe('/v1/publishedLogs');
        expect(url.searchParams.get('accountId')).toBe('actual-owner');
        expect(url.searchParams.get('view')).toBe('FULL');
        expect(url.searchParams.get('limit')).toBe('100');
        current.subject = 'wrong-if-prepared-again';
        // A second outer getRequest() would also stamp the wrong request and locale.
        actualRequest = new Request(`${origin}/ja/library/logs`);
        return calls.length === 1
          ? Response.json({ code: 'stale_cursor' }, { status: 409 })
          : Response.json({
              publishedLogs: [
                recording.publishedLogs[0],
                { ...recording.publishedLogs[0], id: 'withheld', subjectId: 'withheld-original', subject: null },
              ],
              next: 'opaque/next+',
            });
      },
    }),
  );
  const naming = spyOn(definitions, 'nameSubjectTypes').mockImplementation(async (subjects) => {
    for (const subject of subjects) if (subject) subject.typeLabel = 'Released type name';
  });
  try {
    const before = current.preparations;
    const beforeRequests = requestReads;
    const cursor = 'opaque+/requested==&cursor';
    const read = await server.readMyPublishedLogHistoryForViewer({
      data: { cursor, accountId: 'forged-owner', sessionSubject: 'forged-owner' } as { cursor: string },
    });
    expect(current.preparations - before).toBe(1);
    expect(requestReads - beforeRequests).toBe(1);
    expect(read).toMatchObject({ sessionSubject: 'actual-owner', cursor, locale: 'en' });
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]!.url).searchParams.get('cursor')).toBe(cursor);
    expect(new URL(calls[1]!.url).searchParams.has('cursor')).toBe(false);
    expect(read.page).toMatchObject({ state: 'loaded', restarted: true, next: 'opaque/next+' });
    if (read.page.state !== 'loaded') throw new Error('Expected owner history');
    expect(read.page.logs[0]!.subject?.typeLabel).toBe('Released type name');
    expect(read.page.logs[1]!.subject).toBeNull();
    expect([...naming.mock.calls[0]![0]]).toEqual(read.page.logs.map((log) => log.subject));
    expect(JSON.stringify(read.page)).not.toMatch(/withheld-original|subjectId|accountId|completedUnitCount|changes/);
  } finally {
    transport.mockRestore();
    naming.mockRestore();
  }
});

test('actual My Logs viewer export preserves native failure distinctions instead of successful empty history', async () => {
  current.status = 'active';
  current.subject = 'actual-owner';
  for (const [status, body, state] of [
    [200, { publishedLogs: [], next: null }, 'loaded'],
    [202, { preparing: true }, 'preparing'],
    [401, { code: 'invalid_credentials' }, 'denied'],
    [403, { code: 'forbidden' }, 'denied'],
    [404, { code: 'not_found' }, 'denied'],
    [503, { code: 'dependency_unavailable' }, 'unavailable'],
    [200, {}, 'unavailable'],
  ] as const) {
    actualRequest = request();
    const transport = spyOn(kernel, 'kernelClient').mockReturnValue(
      createKernelClient('https://kernel.test', { fetch: async () => Response.json(body, { status }) }),
    );
    try {
      const read = await server.readMyPublishedLogHistoryForViewer({ data: {} });
      expect(read.page.state).toBe(state);
      expect(read.sessionSubject).toBe(state === 'loaded' ? 'actual-owner' : null);
      if (state !== 'loaded') {
        expect(read.page).not.toHaveProperty('logs');
        expect(read.page).not.toHaveProperty('next');
      }
    } finally {
      transport.mockRestore();
    }
  }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function history(subject: string, cursor: string | null = null, title = `${subject} history`): MyLogsViewerHistory {
  return {
    sessionSubject: subject,
    cursor,
    locale: 'en',
    page: {
      state: 'loaded',
      logs: [
        {
          id: `${subject}-public-log`,
          sessionState: 'completed',
          startedAt: '2025-01-01T00:00:00Z',
          completedAt: '2025-01-02T00:00:00Z',
          publishedAt: '2025-01-03T00:00:00Z',
          note: `${subject} published note`,
          subject: { id: `${subject}-subject`, type: 'Book', types: ['Book'], label: title, cover: null },
          account: null,
        },
      ],
      next: `${subject}-next+/opaque=`,
      restarted: false,
    },
  };
}

test("My Logs immediately retires an old owner's history on observed viewer replacement and accepts only the actual prepared viewer and requested cursor", async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: `${origin}/en/library/logs` });
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
    scrollTo: () => {},
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { hydrateRoot } = await import('react-dom/client');
  const { renderToString } = await import('react-dom/server');
  const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
  const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } =
    await import('@tanstack/react-router');
  const { sessionQuery, useSession } = await import('../src/session/query');
  const { viewerExposureLifetime, viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
  const { Route } = await import('../src/routes/library/logs');
  const { requireSignedIn } = await import('../src/session/guard');
  const { m } = await import('../src/paraglide/messages.js');
  const { setLocale } = await import('../src/paraglide/runtime.js');
  setLocale('en', { reload: false });
  const reads: (ReturnType<typeof deferred<MyLogsViewerHistory>> & { cursor: string | null })[] = [];
  const transport = spyOn(server, 'readMyPublishedLogHistoryForViewer').mockImplementation(({ data }) => {
    const call = { ...deferred<MyLogsViewerHistory>(), cursor: data.cursor ?? null };
    reads.push(call);
    return call.promise;
  });
  let initial = history('A');
  const retainedLoader = spyOn(Route, 'useLoaderData').mockImplementation(() => initial);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const viewer = (subject: string, csrfToken = 'csrf-one') => ({ state: 'signed-in', subject, csrfToken });
  client.setQueryData(sessionQuery.queryKey, viewer('A'));
  const exposureLifetime = viewerExposureLifetime(client);
  const stopExposure = exposureLifetime.subscribe(() => {});
  const initialExposure = exposureLifetime.getSnapshot();
  if (initialExposure.state !== 'signed-in') throw new Error('Expected the enrolled My Logs viewer');
  client.setQueryData(viewerExposureQuery(initialExposure.observation).queryKey, {
    subject: initialExposure.observation.subject,
    admitted: ['reading_progress'],
  });
  client.setQueryData(['exposure', 'anonymous'], ['reading_progress']);
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const commits: { state: string; subject?: string | null; text: string; links: string[] }[] = [];
  let observe = false;
  let routeGeneration = 0;
  const Page = Route.options.component!;
  function Mounted() {
    const session = useSession();
    useLayoutEffect(() => {
      if (observe)
        commits.push({
          state: session.state,
          subject: session.subject,
          text: host.textContent ?? '',
          links: [...host.querySelectorAll('a')].map((link) => link.getAttribute('href') ?? ''),
        });
    });
    return <Page key={routeGeneration} />;
  }
  const rootRoute = createRootRoute();
  const logsRoute = createRoute({ getParentRoute: () => rootRoute, path: '/library/logs', component: Mounted });
  const outsideRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/outside',
    component: () => <p>Outside My Logs</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([logsRoute, outsideRoute]),
    history: createMemoryHistory({ initialEntries: ['/library/logs'] }),
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
  const hydrationErrors: unknown[] = [];
  let root: ReturnType<typeof hydrateRoot> | undefined;
  const show = async (session: { state: string; subject?: string; csrfToken: string | null }, admitted = true) => {
    await act(async () => {
      if (session.state === 'unknown') client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
      else client.setQueryData(sessionQuery.queryKey, session);
      const exposure = exposureLifetime.getSnapshot();
      if (exposure.state === 'signed-in')
        client.setQueryData(viewerExposureQuery(exposure.observation).queryKey, {
          subject: exposure.observation.subject,
          admitted: admitted ? ['reading_progress'] : [],
        });
      await tick();
    });
  };
  const remountRoute = async () => {
    await act(async () => {
      routeGeneration++;
      root!.render(tree());
      await tick();
    });
  };
  const leaveAndReturnTo = async (cursor: string) => {
    await act(async () => {
      await router.navigate({ href: '/outside' });
      await tick();
    });
    expect(host.textContent).toContain('Outside My Logs');
    await act(async () => {
      await router.navigate({ href: `/library/logs?cursor=${encodeURIComponent(cursor)}` });
      await tick();
    });
    return reads.at(-1)!;
  };
  const settle = async (call: (typeof reads)[number], value: MyLogsViewerHistory | Error) => {
    await act(async () => {
      if (value instanceof Error) call.reject(value);
      else call.resolve(value);
      await tick();
    });
  };
  const refetch = async () => {
    await act(async () => {
      void client.refetchQueries({ queryKey: ['my-logs-current-viewer'], type: 'active' });
      await tick();
    });
    return reads.at(-1)!;
  };
  const retry = async () => {
    const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (item) => item.textContent === m.library_my_logs_retry(),
    );
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
      await tick();
    });
    return reads.at(-1)!;
  };
  const link = (label: string) =>
    [...host.querySelectorAll<HTMLAnchorElement>('a')].find((item) => item.textContent === label);
  const navigate = async (label: string) => {
    await act(async () => {
      link(label)!.click();
      await tick();
    });
    return reads.at(-1)!;
  };
  const retired = () => {
    expect(host.querySelector('ol')).toBeNull();
    expect(link(m.library_my_logs_next())).toBeUndefined();
    expect(link(m.library_my_logs_previous())).toBeUndefined();
    expect(link(m.library_my_logs_newest())).toBeUndefined();
  };
  try {
    expect(Route.options.beforeLoad).toBe(requireSignedIn);
    expect(Route.options.staleTime).toBe(0);
    expect(Route.options.gcTime).toBe(0);
    // The actual route loader consumes the new envelope, not the old unbound page.
    const load = Route.options.loader as unknown as (input: {
      deps: { cursor?: string };
    }) => Promise<MyLogsViewerHistory>;
    const loaderRead = load({ deps: { cursor: 'loader+/address=' } });
    const loaderResponse = history('A', 'loader+/address=');
    reads[0]!.resolve(loaderResponse);
    expect(await loaderRead).toEqual(loaderResponse);
    expect(reads[0]!.cursor).toBe('loader+/address=');
    await router.load();
    host.innerHTML = renderToString(tree());
    expect(host.textContent).toContain('A history');
    await act(async () => {
      root = hydrateRoot(host as unknown as HTMLElement, tree(), {
        onRecoverableError: (error) => hydrationErrors.push(error),
      });
      await tick();
    });
    expect(host.textContent).toContain('A history');
    const pendingA = reads.at(-1)!;
    observe = true;
    await show(viewer('B'));
    retired();
    expect(reads.at(-1)).not.toBe(pendingA);
    await settle(reads.at(-1)!, history('B'));
    expect(host.textContent).toContain('B history');
    await settle(pendingA, history('A', null, 'Late A success'));
    expect(host.textContent).toContain('B history');
    expect(host.textContent).not.toContain('Late A success');
    expect(
      commits
        .filter((commit) => commit.subject === 'B')
        .every((commit) => !commit.text.includes('A history') && !commit.links.some((href) => href.includes('A-next'))),
    ).toBe(true);

    const pendingB = await refetch();
    const article = host.querySelector('article');
    await show(viewer('B', 'csrf-rotated-nonempty'));
    const rotatedCredential = reads.at(-1)!;
    expect(rotatedCredential).not.toBe(pendingB);
    retired();
    await settle(pendingB, history('B', null, 'Late old credential read'));
    retired();
    await settle(rotatedCredential, history('B', null, 'B refreshed history'));
    expect(host.textContent).toContain('B refreshed history');
    initial = structuredClone(initial); // A loader object's identity is not an observed new owner.
    await act(async () => {
      root!.render(tree());
      await tick();
    });
    expect(host.querySelector('article')).toBe(article);
    expect(host.textContent).not.toContain('A history');

    const oldAddress = await refetch();
    const next = await navigate(m.library_my_logs_next());
    expect(next).not.toBe(oldAddress);
    expect(next.cursor).toBe('B-next+/opaque=');
    retired();
    await settle(next, history('A', next.cursor, 'Wrong viewer'));
    retired();
    const wrongAddress = await retry();
    expect(wrongAddress.cursor).toBe(next.cursor);
    await settle(wrongAddress, history('B', 'wrong-address', 'Wrong cursor'));
    retired();
    const wrongLocale = await retry();
    expect(wrongLocale.cursor).toBe(next.cursor);
    await settle(wrongLocale, { ...history('B', next.cursor, 'Wrong locale'), locale: 'ja' });
    retired();
    const acceptedNext = await retry();
    expect(acceptedNext.cursor).toBe(next.cursor);
    await settle(acceptedNext, history('B', next.cursor, 'B next page'));
    expect(host.textContent).toContain('B next page');
    expect(link(m.library_my_logs_previous())).toBeDefined();
    expect(link(m.library_my_logs_newest())).toBeDefined();

    const readsBeforeRemount = reads.length;
    await remountRoute();
    expect(reads).toHaveLength(readsBeforeRemount);
    expect(host.textContent).toContain('B next page');
    expect(link(m.library_my_logs_previous())).toBeDefined();

    const previous = await navigate(m.library_my_logs_previous());
    expect(previous.cursor).toBeNull();
    retired();
    await settle(previous, new Error('Transient Previous failure'));
    const previousRetry = await retry();
    expect(previousRetry).not.toBe(previous);
    expect(previousRetry.cursor).toBeNull();
    await settle(previousRetry, history('B', null, 'B accepted predecessor'));
    expect(host.textContent).toContain('B accepted predecessor');
    expect(link(m.library_my_logs_previous())).toBeUndefined();
    const directAfterRouteReturn = await leaveAndReturnTo(next.cursor!);
    expect(directAfterRouteReturn.cursor).toBe(next.cursor);
    await settle(directAfterRouteReturn, history('B', next.cursor, 'Fresh direct later page'));
    expect(host.textContent).toContain('Fresh direct later page');
    expect(link(m.library_my_logs_previous())).toBeUndefined();
    const newestAfterReturn = await navigate(m.library_my_logs_newest());
    expect(newestAfterReturn.cursor).toBeNull();
    retired();
    await settle(newestAfterReturn, history('B', null, 'Newest after direct route return'));
    expect(host.textContent).toContain('Newest after direct route return');
    await settle(oldAddress, new Error('Late prior-address failure'));
    expect(host.textContent).toContain('Newest after direct route return');
    for (const state of ['denied', 'preparing', 'unavailable'] as const) {
      await settle(await refetch(), { sessionSubject: null, cursor: null, locale: 'en', page: { state } });
      expect(host.textContent).toContain(
        state === 'denied'
          ? m.library_my_logs_denied()
          : state === 'preparing'
            ? m.library_my_logs_preparing()
            : m.library_my_logs_unavailable(),
      );
      expect(host.textContent).not.toContain(m.library_logs_empty());
      retired();
    }
    await settle(await retry(), {
      ...history('B'),
      page: { state: 'loaded', logs: [], next: 'bounded-more', restarted: false },
    });
    expect(host.textContent).toContain(m.library_my_logs_no_visible());
    await settle(await refetch(), {
      ...history('B'),
      page: { state: 'loaded', logs: [], next: null, restarted: false },
    });
    expect(host.textContent).toContain(m.library_logs_empty());
    await settle(await refetch(), history('B'));

    for (const state of ['unknown', 'signed-out', 'unavailable'] as const) {
      const abandoned = await refetch();
      await show({ state, csrfToken: null });
      retired();
      expect(host.querySelector('button')).toBeNull();
      const commit = commits.at(-1)!;
      expect(commit.state).toBe(state);
      expect(commit.text).not.toContain('B history'); // Captured in layout, before passive effects.
      expect(commit.links.some((href) => href.includes('B-next'))).toBe(false);
      await show(viewer('B'));
      retired();
      const fresh = reads.at(-1)!;
      expect(fresh).not.toBe(abandoned);
      await settle(abandoned, history('B', null, 'Retired B success'));
      retired();
      await settle(fresh, history('B'));
    }
    const deniedLifetime = await refetch();
    await show(viewer('B'), false);
    retired();
    expect(host.textContent).toContain(m.library_my_logs_denied());
    await show(viewer('B'));
    const readmitted = reads.at(-1)!;
    await settle(deniedLifetime, new Error('Late lost-admission failure'));
    retired();
    await settle(readmitted, history('B'));

    await show(viewer('A'));
    await settle(reads.at(-1)!, { sessionSubject: null, cursor: null, locale: 'en', page: { state: 'unavailable' } });
    const aRetry = await retry();
    await show(viewer('B'));
    await settle(reads.at(-1)!, history('B'));
    await settle(aRetry, new Error('Late A retry failure'));
    expect(host.textContent).toContain('B history');
    expect(host.textContent).not.toContain(m.library_my_logs_unavailable());
    expect(host.querySelector('button')).toBeNull();
    expect(hydrationErrors).toEqual([]);
    const activeKey = client
      .getQueryCache()
      .findAll({ queryKey: ['my-logs-current-viewer'], type: 'active' })[0]!.queryKey;
    expect(activeKey.slice(1, 6)).toEqual(['B', 'published_log.list', true, null, 'en']);
  } finally {
    if (root) await act(async () => root!.unmount());
    stopExposure();
    client.clear();
    transport.mockRestore();
    retainedLoader.mockRestore();
    await window.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
