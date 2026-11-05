import { afterAll, expect, mock, spyOn, test } from 'bun:test';
import type { SubjectPageData } from '../src/features/pages/subject';
import { dirname } from 'node:path';
import { act, createElement, Fragment, StrictMode, type ReactNode } from 'react';
import * as start from '../.storybook/react-start';

type SessionResult = {
  state: 'signed-in' | 'signed-out' | 'unavailable';
  subject?: string | null;
  csrfToken: string | null;
};
type Session = SessionResult | { state: 'unknown'; subject?: string | null; csrfToken: null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

let sessionReader: () => Promise<SessionResult> = async () => ({
  state: 'unavailable',
  csrfToken: null,
  subject: null,
});
let sessionReads = 0;
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/session/state', () => ({
  readSessionIdentity: () => sessionReader(),
  readSessionState: async () => {
    sessionReads += 1;
    return sessionReader();
  },
}));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/settings', width: 1280, height: 900 });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLInputElement: window.HTMLInputElement,
  HTMLFormElement: window.HTMLFormElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(
  [...Object.keys(globals), 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot, hydrateRoot } = await import('react-dom/client');
const { renderToString } = await import('react-dom/server');
const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { sessionQuery, useSession, AnonymousSessionContext, sessionCsrfToken } = await import('../src/session/query');
const { uploadAvatar } = await import('../src/threads/upload');

function SessionProbe({ name }: { name: string }) {
  const session = useSession();
  return <output data-session={name}>{JSON.stringify(session)}</output>;
}

function viewer(subject = 'reader-one', csrfToken: string | null = 'csrf-one'): SessionResult {
  return { state: 'signed-in', subject, csrfToken };
}

async function captureUploadToken(): Promise<string | null> {
  let sent: Headers | undefined;
  const previousFetch = Object.getOwnPropertyDescriptor(globalThis, 'fetch');
  const fakeFetch: typeof fetch = async (_input, init) => {
    sent = new Headers(init?.headers);
    return new Response(null, { status: 503 });
  };
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: fakeFetch });
  try {
    await uploadAvatar(
      'account-one',
      new Blob([new Uint8Array([1])], { type: 'image/png' }) as File,
      new AbortController().signal,
    );
  } catch {
    // The fake reservation refusal ends the real uploader at its first HTTP dispatch.
  } finally {
    if (previousFetch) Object.defineProperty(globalThis, 'fetch', previousFetch);
    else Reflect.deleteProperty(globalThis, 'fetch');
  }
  return sent?.get('X-CSRF-Token') ?? null;
}

async function forceSessionError(client: InstanceType<typeof QueryClient>): Promise<void> {
  await client
    .fetchQuery({
      ...sessionQuery,
      queryFn: async () => {
        throw new Error('session read failed');
      },
      staleTime: 0,
    })
    .catch(() => undefined);
}

function countCacheSubscriptions(client: InstanceType<typeof QueryClient>) {
  const counts = { subscribed: 0, unsubscribed: 0 };
  const cache = client.getQueryCache();
  const originalSubscribe = cache.subscribe.bind(cache);
  cache.subscribe = (listener) => {
    counts.subscribed += 1;
    const unsubscribe = originalSubscribe(listener);
    return () => {
      counts.unsubscribed += 1;
      unsubscribe();
    };
  };
  return counts;
}

async function createUi() {
  const host = window.document.createElement('div') as unknown as HTMLElement;
  window.document.body.append(host as unknown as Node);
  let root: ReturnType<typeof createRoot> | undefined;
  const clients = new Set<InstanceType<typeof QueryClient>>();
  const client = () => {
    const next = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    clients.add(next);
    return next;
  };
  const tree = (queryClient: InstanceType<typeof QueryClient>, children: ReactNode, strict = false) => {
    const provider = createElement(QueryClientProvider, { client: queryClient }, children);
    return strict ? createElement(StrictMode, null, provider) : provider;
  };
  const render = async (queryClient: InstanceType<typeof QueryClient>, children: ReactNode, strict = false) =>
    act(async () => {
      root ??= createRoot(host);
      root.render(tree(queryClient, children, strict));
      await Promise.resolve();
    });
  const hydrate = async (queryClient: InstanceType<typeof QueryClient>, children: ReactNode) =>
    act(async () => {
      root = hydrateRoot(host, tree(queryClient, children));
      await Promise.resolve();
    });
  const flush = async () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
    });
  const session = (name: string) => {
    const node = host.querySelector(`[data-session="${name}"]`);
    expect(node).toBeDefined();
    return JSON.parse(node!.textContent || '{}') as Session;
  };
  const close = async () => {
    const mounted = root;
    root = undefined;
    if (mounted) await act(async () => mounted.unmount());
    for (const queryClient of clients) queryClient.clear();
    host.remove();
  };
  return { host, client, render, hydrate, flush, session, close };
}

async function withUi(run: (ui: Awaited<ReturnType<typeof createUi>>) => Promise<void>) {
  const ui = await createUi();
  try {
    await run(ui);
  } finally {
    await ui.close();
  }
}

test('session hydration stays private on the server and guard-seeded data becomes current only after browser hydration', async () => {
  await withUi(async (ui) => {
    const client = ui.client();
    sessionReads = 0;
    sessionReader = async () => viewer();
    const { requireSignedIn } = await import('../src/session/guard');
    await requireSignedIn({ context: { queryClient: client }, location: { publicHref: '/en/settings' } });
    expect(sessionReads).toBe(1);
    const content = createElement(SessionProbe, { name: 'main' });
    const serverTree = createElement(QueryClientProvider, { client }, content);

    const markup = renderToString(serverTree);
    expect(markup).toContain('"state":"unknown"');
    expect(sessionCsrfToken()).toBeNull();
    expect(sessionReads).toBe(1);

    ui.host.innerHTML = markup;
    await ui.hydrate(client, content);
    await ui.flush();

    expect(ui.session('main')).toEqual(viewer());
    expect(await captureUploadToken()).toBe('csrf-one');
  });
});

test('an initial browser session read with null CSRF remains signed in without granting upload authority', async () => {
  await withUi(async (ui) => {
    const client = ui.client();
    sessionReads = 0;
    sessionReader = async () => viewer('reader-one', null);

    await ui.render(client, createElement(SessionProbe, { name: 'main' }));
    await ui.flush();

    expect(sessionReads).toBe(1);
    expect(client.getQueryState(sessionQuery.queryKey)?.status).toBe('success');
    expect(ui.session('main')).toEqual(viewer('reader-one', null));
    expect(sessionCsrfToken()).toBeNull();
    expect(await captureUploadToken()).toBe('');
  });
});

test('a successful null-CSRF read stays signed in through the real guard, hook, and upload boundary', async () => {
  await withUi(async (ui) => {
    const client = ui.client();
    sessionReads = 0;
    sessionReader = async () => viewer('reader-one', null);
    const { requireSignedIn } = await import('../src/session/guard');

    await requireSignedIn({ context: { queryClient: client }, location: { publicHref: '/en/settings' } });
    expect(sessionReads).toBe(1);
    expect(client.getQueryState(sessionQuery.queryKey)?.status).toBe('success');

    const content = createElement(SessionProbe, { name: 'main' });
    const serverTree = createElement(QueryClientProvider, { client }, content);
    const markup = renderToString(serverTree);
    expect(markup).toContain('"state":"unknown"');
    expect(sessionCsrfToken()).toBeNull();

    ui.host.innerHTML = markup;
    await ui.hydrate(client, content);
    await ui.flush();

    expect(ui.session('main')).toEqual(viewer('reader-one', null));
    await expect(
      requireSignedIn({ context: { queryClient: client }, location: { publicHref: '/en/settings' } }),
    ).resolves.toBeUndefined();
    expect(sessionCsrfToken()).toBeNull();
    expect(await captureUploadToken()).toBe('');
  });
});

test('same-subject null-CSRF refresh and subject changes preserve reads without borrowing a mutation token', async () => {
  await withUi(async (ui) => {
    const client = ui.client();
    const { requireSignedIn } = await import('../src/session/guard');
    client.setQueryData(sessionQuery.queryKey, viewer('reader-one', 'original-explicit-token'));
    await ui.render(client, createElement(SessionProbe, { name: 'main' }));
    expect(await captureUploadToken()).toBe('original-explicit-token');

    client.setQueryData(sessionQuery.queryKey, viewer('reader-one', null));
    expect(sessionCsrfToken()).toBeNull();
    expect(await captureUploadToken()).toBe('');
    await ui.flush();
    expect(ui.session('main')).toEqual(viewer('reader-one', null));
    await expect(
      requireSignedIn({ context: { queryClient: client }, location: { publicHref: '/en/settings' } }),
    ).resolves.toBeUndefined();

    const exactToken = 'csrf:opaque/value==';
    client.setQueryData(sessionQuery.queryKey, viewer('reader-one', exactToken));
    expect(sessionCsrfToken()).toBe(exactToken);
    await ui.flush();
    expect(await captureUploadToken()).toBe(exactToken);

    client.setQueryData(sessionQuery.queryKey, viewer('reader-two', null));
    expect(sessionCsrfToken()).toBeNull();
    expect(await captureUploadToken()).toBe('');
    await ui.flush();
    expect(ui.session('main')).toEqual(viewer('reader-two', null));
    await expect(
      requireSignedIn({ context: { queryClient: client }, location: { publicHref: '/en/settings' } }),
    ).resolves.toBeUndefined();
  });
});

test('background reads keep successful null-CSRF data usable until failure, then recover only current null authority', async () => {
  await withUi(async (ui) => {
    const client = ui.client();
    client.setQueryData(sessionQuery.queryKey, viewer('reader-one', null));
    await ui.render(client, createElement(SessionProbe, { name: 'main' }));
    expect(ui.session('main')).toEqual(viewer('reader-one', null));

    const backgroundResult = deferred<SessionResult>();
    const backgroundRead = client
      .fetchQuery({ ...sessionQuery, queryFn: () => backgroundResult.promise, staleTime: 0 })
      .catch(() => undefined);
    expect(client.getQueryState(sessionQuery.queryKey)?.status).toBe('success');
    expect(ui.session('main')).toEqual(viewer('reader-one', null));
    expect(sessionCsrfToken()).toBeNull();
    expect(await captureUploadToken()).toBe('');
    backgroundResult.resolve(viewer('reader-one', null));
    await act(async () => {
      await backgroundRead;
    });
    await ui.flush();
    expect(ui.session('main')).toEqual(viewer('reader-one', null));

    await client
      .fetchQuery({
        ...sessionQuery,
        queryFn: async () => {
          throw new Error('background null-CSRF session failure');
        },
        staleTime: 0,
      })
      .catch(() => undefined);
    expect(client.getQueryState(sessionQuery.queryKey)?.status).toBe('error');
    expect(client.getQueryData(sessionQuery.queryKey)).toEqual(viewer('reader-one', null));
    await ui.flush();
    expect(ui.session('main').state).toBe('unknown');
    expect(sessionCsrfToken()).toBeNull();
    expect(await captureUploadToken()).toBe('');

    client.setQueryData(sessionQuery.queryKey, viewer('reader-one', null));
    expect(sessionCsrfToken()).toBeNull();
    await ui.flush();
    expect(ui.session('main')).toEqual(viewer('reader-one', null));
    expect(await captureUploadToken()).toBe('');
  });
});

test('failed retained data, recovery, transitions, malformed observations, and removal govern the real upload dispatch token', async () => {
  await withUi(async (ui) => {
    const client = ui.client();
    client.setQueryData(sessionQuery.queryKey, viewer());
    await ui.render(client, createElement(SessionProbe, { name: 'main' }));
    expect(await captureUploadToken()).toBe('csrf-one');

    await forceSessionError(client);
    await ui.flush();
    expect(client.getQueryState(sessionQuery.queryKey)?.status).toBe('error');
    expect(client.getQueryData(sessionQuery.queryKey)).toEqual(viewer());
    expect(ui.session('main').state).toBe('unknown');
    expect(await captureUploadToken()).toBe('');

    const query = client.getQueryCache().find({ queryKey: sessionQuery.queryKey, exact: true });
    expect(query).toBeDefined();
    await act(async () => {
      query!.setState({ status: 'error', error: new Error('synchronous failure') });
      expect(sessionCsrfToken()).toBeNull();
      client.setQueryData(sessionQuery.queryKey, viewer('reader-one', 'csrf-recovered'));
      expect(sessionCsrfToken()).toBe('csrf-recovered');
    });
    await ui.flush();
    expect(ui.session('main')).toEqual(viewer('reader-one', 'csrf-recovered'));
    expect(await captureUploadToken()).toBe('csrf-recovered');

    const backgroundResult = deferred<SessionResult>();
    const backgroundRead = client
      .fetchQuery({ ...sessionQuery, queryFn: () => backgroundResult.promise, staleTime: 0 })
      .catch(() => undefined);
    expect(client.getQueryState(sessionQuery.queryKey)?.status).toBe('success');
    expect(ui.session('main')).toEqual(viewer('reader-one', 'csrf-recovered'));
    expect(await captureUploadToken()).toBe('csrf-recovered');
    backgroundResult.resolve(viewer('reader-one', 'csrf-after-background-refresh'));
    await act(async () => {
      await backgroundRead;
    });
    await ui.flush();
    expect(ui.session('main')).toEqual(viewer('reader-one', 'csrf-after-background-refresh'));
    expect(await captureUploadToken()).toBe('csrf-after-background-refresh');

    client.setQueryData(sessionQuery.queryKey, viewer('reader-two', 'csrf-two'));
    await ui.flush();
    expect(ui.session('main')).toEqual(viewer('reader-two', 'csrf-two'));
    expect(await captureUploadToken()).toBe('csrf-two');
    client.setQueryData(sessionQuery.queryKey, viewer('reader-two', 'csrf-refreshed'));
    await ui.flush();
    expect(ui.session('main')).toEqual(viewer('reader-two', 'csrf-refreshed'));
    expect(await captureUploadToken()).toBe('csrf-refreshed');

    const invalidObservations: unknown[] = [
      { state: 'signed-out', subject: 'ignored', csrfToken: 'must-not-lend' },
      { state: 'signed-out', subject: null },
      { state: 'unavailable', subject: 'ignored', csrfToken: 'must-not-lend' },
      { state: 'signed-in', subject: null, csrfToken: 'missing-subject' },
      { state: 'signed-in', subject: ' ', csrfToken: 'blank-subject' },
      { state: 'signed-in', subject: 'reader-two', csrfToken: ' ' },
      { state: 'signed-in', csrfToken: null },
      { state: 'signed-in', subject: 12, csrfToken: null },
      { state: 'signed-in', subject: 'reader-two' },
      { state: 'signed-in', subject: 'reader-two', csrfToken: false },
      { state: 'signed-in', subject: 'reader-two', csrfToken: undefined },
      { subject: 'reader-two', csrfToken: null },
      { state: 1, subject: 'reader-two', csrfToken: null },
      null,
      [],
    ];
    for (const invalid of invalidObservations) {
      client.setQueryData(sessionQuery.queryKey, invalid);
      await ui.flush();
      expect(await captureUploadToken()).toBe('');
      expect(ui.session('main').state).not.toBe('signed-in');
    }
    expect(ui.session('main').state).toBe('unavailable');

    client.setQueryData(sessionQuery.queryKey, viewer());
    expect(await captureUploadToken()).toBe('csrf-one');
    client.removeQueries({ queryKey: sessionQuery.queryKey, exact: true });
    expect(sessionCsrfToken()).toBeNull();
    await ui.flush();
    expect(ui.session('main').state).toBe('unknown');
    expect(await captureUploadToken()).toBe('');

    client.setQueryData(sessionQuery.queryKey, viewer());
    expect(await captureUploadToken()).toBe('csrf-one');
    client.clear();
    expect(sessionCsrfToken()).toBeNull();
    await ui.flush();
    expect(ui.session('main').state).toBe('unknown');
    expect(await captureUploadToken()).toBe('');
  });
});

test('one shared client read and bounded cache subscription serve multiple consumers and release on unmount', async () => {
  await withUi(async (ui) => {
    sessionReads = 0;
    sessionReader = async () => viewer();
    const client = ui.client();
    const cache = client.getQueryCache();
    const originalSubscribe = cache.subscribe.bind(cache);
    let subscriptions = 0;
    let unsubscriptions = 0;
    cache.subscribe = (listener) => {
      subscriptions += 1;
      const unsubscribe = originalSubscribe(listener);
      return () => {
        unsubscriptions += 1;
        unsubscribe();
      };
    };

    await ui.render(
      client,
      createElement(
        Fragment,
        null,
        createElement(SessionProbe, { name: 'first' }),
        createElement(SessionProbe, { name: 'second' }),
      ),
    );
    await ui.flush();

    expect(sessionReads).toBe(1);
    expect(subscriptions).toBe(1);
    expect(ui.session('first')).toEqual(viewer());
    expect(ui.session('second')).toEqual(viewer());
    expect(await captureUploadToken()).toBe('csrf-one');

    await ui.close();
    expect(unsubscriptions).toBe(1);
  });
});

test('replacement clients, delayed old results, abandoned renders, and anonymous nested hosts cannot displace the current owner', async () => {
  await withUi(async (ui) => {
    const oldClient = ui.client();
    const currentClient = ui.client();
    const anonymousClient = ui.client();
    const abandonedClient = ui.client();
    const oldCounts = countCacheSubscriptions(oldClient);
    const currentCounts = countCacheSubscriptions(currentClient);
    const anonymousCounts = countCacheSubscriptions(anonymousClient);
    const abandonedCounts = countCacheSubscriptions(abandonedClient);
    sessionReads = 0;
    oldClient.setQueryData(sessionQuery.queryKey, viewer('old-reader', 'old-csrf'));
    const oldResult = deferred<SessionResult>();

    await ui.render(oldClient, createElement(SessionProbe, { name: 'main' }));
    expect(await captureUploadToken()).toBe('old-csrf');
    expect(oldCounts.subscribed - oldCounts.unsubscribed).toBe(1);
    expect(sessionReads).toBe(0);

    sessionReader = () => oldResult.promise;
    let lateOldQuery!: Promise<SessionResult | undefined>;
    await act(async () => {
      lateOldQuery = oldClient.fetchQuery({ ...sessionQuery, staleTime: 0 }).catch(() => undefined);
    });
    await ui.flush();
    expect(sessionReads).toBe(1);

    const currentResult = deferred<SessionResult>();
    sessionReader = () => currentResult.promise;
    await ui.render(currentClient, createElement(SessionProbe, { name: 'main' }));
    expect(sessionCsrfToken()).toBeNull();
    expect(ui.session('main').state).toBe('unknown');
    expect(oldCounts.subscribed - oldCounts.unsubscribed).toBe(0);
    expect(currentCounts.subscribed - currentCounts.unsubscribed).toBe(1);
    expect(sessionReads).toBe(2);

    currentResult.resolve(viewer('current-reader', 'current-csrf'));
    await ui.flush();
    expect(ui.session('main')).toEqual(viewer('current-reader', 'current-csrf'));
    expect(await captureUploadToken()).toBe('current-csrf');

    abandonedClient.setQueryData(sessionQuery.queryKey, viewer('abandoned', 'abandoned-csrf'));
    const abandoned = createElement(
      QueryClientProvider,
      { client: abandonedClient },
      createElement(SessionProbe, { name: 'abandoned' }),
    );
    expect(renderToString(abandoned)).toContain('"state":"unknown"');
    expect(sessionCsrfToken()).toBe('current-csrf');
    expect(abandonedCounts.subscribed).toBe(0);
    expect(sessionReads).toBe(2);

    oldResult.resolve(viewer('late-old-reader', 'late-old-csrf'));
    await act(async () => {
      await lateOldQuery;
    });
    expect(oldClient.getQueryData(sessionQuery.queryKey)).toEqual(viewer('late-old-reader', 'late-old-csrf'));
    expect(await captureUploadToken()).toBe('current-csrf');

    sessionReader = async () => viewer('anonymous-private-reader', 'anonymous-private-csrf');
    const nested = createElement(
      Fragment,
      null,
      createElement(SessionProbe, { name: 'curator' }),
      createElement(
        QueryClientProvider,
        { client: anonymousClient },
        createElement(
          AnonymousSessionContext.Provider,
          { value: true },
          createElement(SessionProbe, { name: 'anonymous' }),
        ),
      ),
    );
    await ui.render(currentClient, nested);
    await ui.flush();

    expect(sessionReads).toBe(3);
    expect(anonymousCounts.subscribed).toBe(0);
    expect(anonymousCounts.unsubscribed).toBe(0);
    expect(currentCounts.subscribed - currentCounts.unsubscribed).toBe(1);
    expect(anonymousClient.getQueryData(sessionQuery.queryKey)).toEqual(
      viewer('anonymous-private-reader', 'anonymous-private-csrf'),
    );
    expect(ui.session('anonymous').state).toBe('signed-out');
    expect(ui.session('curator')).toEqual(viewer('current-reader', 'current-csrf'));
    expect(await captureUploadToken()).toBe('current-csrf');

    await forceSessionError(anonymousClient);
    expect(anonymousClient.getQueryState(sessionQuery.queryKey)?.status).toBe('error');
    expect(ui.session('anonymous').state).toBe('signed-out');
    expect(await captureUploadToken()).toBe('current-csrf');

    currentClient.setQueryData(sessionQuery.queryKey, viewer('current-reader', null));
    expect(sessionCsrfToken()).toBeNull();
    expect(await captureUploadToken()).toBe('');
    await ui.flush();
    expect(ui.session('curator')).toEqual(viewer('current-reader', null));

    await ui.close();
    expect(currentCounts.subscribed - currentCounts.unsubscribed).toBe(0);
    expect(anonymousCounts.subscribed - anonymousCounts.unsubscribed).toBe(0);
    expect(oldCounts.subscribed - oldCounts.unsubscribed).toBe(0);
  });
});

test('StrictMode setup and cleanup preserve the mounted owner and release its cache listener on final unmount', async () => {
  await withUi(async (ui) => {
    sessionReads = 0;
    sessionReader = async () => viewer();
    const client = ui.client();
    const cache = client.getQueryCache();
    const originalSubscribe = cache.subscribe.bind(cache);
    let subscriptions = 0;
    let unsubscriptions = 0;
    cache.subscribe = (listener) => {
      subscriptions += 1;
      const unsubscribe = originalSubscribe(listener);
      return () => {
        unsubscriptions += 1;
        unsubscribe();
      };
    };

    await ui.render(client, createElement(SessionProbe, { name: 'strict' }), true);
    await ui.flush();
    expect(sessionReads).toBe(1);
    expect(ui.session('strict')).toEqual(viewer());
    expect(await captureUploadToken()).toBe('csrf-one');
    expect(subscriptions).toBe(2);
    expect(unsubscriptions).toBe(1);

    await ui.close();
    expect(unsubscriptions).toBe(2);
    expect(sessionCsrfToken()).toBeNull();
  });
});

test('mounted phone, following and Subject readers publish query changes after sibling render and retain immediate fences', async () => {
  mock.module('@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2?url', () => ({
    default: '/font.woff2',
  }));
  const { AppShell } = await import('../src/shell/app-shell');
  const { SubjectPage } = await import('../src/features/pages/subject');
  const { default: recorded } = await import('../src/kernel/recorded/subject-page.json');
  const { browserObservation } = await import('../src/session/observation');
  const { currentInboxViewer } = await import('../src/inbox/inbox-viewer');
  const { viewerExposureQuery } = await import('../src/kernel/viewer-exposure');
  const { createMemoryHistory, createRootRoute, createRouter, RouterContextProvider } =
    await import('@tanstack/react-router');
  const communities = await import('../src/shell/community-navigation-actions');
  const inbox = await import('../src/inbox/inbox-read');
  const following = spyOn(communities, 'readShellCommunities').mockResolvedValue({
    subject: 'reader-one',
    locale: 'en',
    more: false,
    items: [{ id: 'space', kind: 'space', title: 'Following space', path: '/spaces/space' }],
  });
  const count = spyOn(inbox, 'readUnreadCount').mockResolvedValue({
    signedIn: true,
    state: 'ready',
    count: 3,
    capped: false,
    basis: 'current-visible-unread',
    witness: { kind: 'current-disclosure', at: '2026-11-04T00:00:00.000Z' },
  });
  const errors = spyOn(console, 'error');
  try {
    await withUi(async (ui) => {
      sessionReader = async () => viewer();
      const client = ui.client();
      const shared = browserObservation(client);
      const router = createRouter({
        routeTree: createRootRoute(),
        history: createMemoryHistory({ initialEntries: ['/en/subjects/book'] }),
      });
      let duringRender: (() => void) | undefined;
      function QueryEvent() {
        const event = duringRender;
        duringRender = undefined;
        event?.();
        return null;
      }
      const page = recorded as unknown as SubjectPageData;
      const messages = { unknown: '?', none: '-', unlabelled: '?', sources: '', aliases: '', search: '' };
      const render = () =>
        ui.render(
          client,
          <RouterContextProvider router={router}>
            <AppShell search={<input aria-label="Search" />}>
              <QueryEvent />
              <SubjectPage page={page} locale="en" messages={messages} />
            </AppShell>
          </RouterContextProvider>,
          true,
        );
      const admit = async () => {
        await ui.flush();
        const snapshot = shared.getSnapshot();
        expect(snapshot.state).toBe('signed-in');
        if (snapshot.state !== 'signed-in') throw new Error('Expected current reader');
        await act(async () =>
          client.setQueryData(viewerExposureQuery(snapshot.observation).queryKey, {
            subject: 'reader-one',
            admitted: ['personal_library', 'collections'],
          }),
        );
        await ui.flush();
        expect(ui.host.textContent).toContain('Following space');
        expect(ui.host.querySelector('[data-phone-navigation]')).not.toBeNull();
      };
      await render();
      await admit();
      const old = currentInboxViewer(client)!;
      duringRender = () => {
        client.setQueryData(sessionQuery.queryKey, viewer('reader-two', 'csrf-two'));
        expect(old.isCurrent()).toBe(false);
        client.setQueryData(sessionQuery.queryKey, viewer());
        expect(old.isCurrent()).toBe(false);
      };
      await render();
      await admit();
      const equal = shared.getSnapshot();
      duringRender = () => {
        client.setQueryData(sessionQuery.queryKey, viewer());
        expect(shared.getSnapshot()).not.toBe(equal);
      };
      await render();
      await admit();
      expect(errors.mock.calls.filter((args) => args.join(' ').includes('Cannot update a component'))).toEqual([]);
    });
  } finally {
    following.mockRestore();
    count.mockRestore();
    errors.mockRestore();
  }
});

afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
});
