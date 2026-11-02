import { afterAll, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { act, createElement, StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import type { Root } from 'react-dom/client';
import type { QueryClient } from '@tanstack/react-query';
import type { MyRealmsPage } from '../src/community/space';
import * as start from '../.storybook/react-start';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.example.test/en/realms' });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  location: window.location,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Node: window.Node,
  Element: window.Element,
  Event: window.Event,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

type ReadInput = { cursor?: string };
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void };
const readCalls: ReadInput[] = [];
let readPage: (input: ReadInput) => Promise<MyRealmsPage> = async () => page('Current account realm');
let mockReaderSession: { state: string; subject: string | null; csrfToken: string | null } = {
  state: 'signed-in',
  subject: 'realm-owner',
  csrfToken: 'csrf-original',
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function page(name: string, next: string | null = null): MyRealmsPage {
  const readerOrigin =
    mockReaderSession.state === 'signed-in' && mockReaderSession.subject
      ? {
          kind: 'session' as const,
          subject: mockReaderSession.subject,
          csrfFingerprint: createHash('sha256')
            .update(mockReaderSession.csrfToken === null ? 'null\u0000' : `token\u0000${mockReaderSession.csrfToken}`)
            .digest('hex'),
        }
      : { kind: 'anonymous' as const };
  return {
    signedIn: true,
    realms: [{ realmId: '0192f3a0-6c1e-7b2a-9d4e-000000000201', name, description: `Private description for ${name}` }],
    next,
    readerOrigin,
  };
}

mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => ({
  ...start,
  getRequest: () => start.getRequest(),
  setResponseHeader: () => undefined,
}));
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/community/space-actions', () => ({
  readMyRealmsPage: ({ data }: { data: ReadInput }) => {
    readCalls.push(data);
    return readPage(data);
  },
}));

const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRouteWithContext, createRouter, Outlet, RouterProvider } =
  await import('@tanstack/react-router');
const { createRoot, hydrateRoot } = await import('react-dom/client');
const { deLocalizeUrl, localizeUrl, setLocale } = await import('../src/paraglide/runtime.js');
const { sessionQuery } = await import('../src/session/query');
const { Route: MyRealmsRoute } = await import('../src/routes/realms/index');

function signedIn(subject = 'realm-owner', csrfToken: string | null = 'csrf-original') {
  return { state: 'signed-in' as const, subject, csrfToken };
}

function signedOut() {
  return { state: 'signed-out' as const, subject: null, csrfToken: null };
}

async function settle() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function until(predicate: () => boolean, label: string) {
  for (let turn = 0; turn < 120; turn++) {
    if (predicate()) return;
    await settle();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

type Surface = Awaited<ReturnType<typeof createSurface>>;

async function createSurface(options: { locale?: 'en' | 'zh-Hant'; cursor?: string } = {}) {
  const locale = options.locale ?? 'en';
  await setLocale(locale, { reload: false });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockReaderSession = signedIn();
  client.setQueryData(sessionQuery.queryKey, signedIn());
  const rootRoute = createRootRouteWithContext<{
    queryClient: QueryClient;
    credentialMode: 'anonymous' | 'session';
  }>()({ component: Outlet });
  const actualRoute = (
    MyRealmsRoute as unknown as {
      update(options: { getParentRoute: () => typeof rootRoute }): unknown;
    }
  ).update({ getParentRoute: () => rootRoute });
  const routeTree = rootRoute.addChildren([actualRoute as never]);
  const cursorSearch = options.cursor ? `?cursor=${encodeURIComponent(options.cursor)}` : '';
  const router = createRouter({
    routeTree: routeTree as never,
    context: { queryClient: client, credentialMode: 'anonymous' },
    history: createMemoryHistory({ initialEntries: [`/${locale}/realms${cursorSearch}`] }),
    rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
  } as never);
  const host = window.document.createElement('main') as unknown as HTMLElement;
  window.document.body.append(host);
  let root: Root | undefined;
  let unmountRoot: (() => void) | undefined;

  const tree = (strict = false) => {
    const routed = createElement(RouterProvider, { router: router as never });
    return createElement(QueryClientProvider, { client }, strict ? createElement(StrictMode, null, routed) : routed);
  };

  async function mount(strict = false) {
    if (root) return;
    if (!host.isConnected) window.document.body.append(host);
    root = createRoot(host);
    unmountRoot = () => root?.unmount();
    await act(async () => root!.render(tree(strict)));
  }

  async function hydrate(strict = false) {
    if (root) return;
    unmountRoot = undefined;
    await act(async () => {
      root = undefined;
      const hydrate = hydrateRoot(host, tree(strict), { onRecoverableError: (error) => hydrationErrors.push(error) });
      root = { unmount: () => hydrate.unmount() } as Root;
      unmountRoot = () => hydrate.unmount();
    });
  }

  async function dispose() {
    await unmountSurface();
    client.clear();
    host.remove();
  }

  async function unmountSurface() {
    if (unmountRoot) {
      const disposeRoot = unmountRoot;
      unmountRoot = undefined;
      await act(async () => disposeRoot());
      root = undefined;
      await settle();
    }
  }

  async function setSession(
    value:
      | ReturnType<typeof signedIn>
      | ReturnType<typeof signedOut>
      | { state: 'unknown' | 'unavailable'; subject: string | null; csrfToken: string | null },
  ) {
    await act(async () => {
      client.setQueryData(sessionQuery.queryKey, value);
      mockReaderSession = value;
    });
  }

  return {
    client,
    router,
    host,
    tree,
    mount,
    hydrate,
    dispose,
    unmount: unmountSurface,
    setSession,
    load: () => router.load(),
  };
}

const hydrationErrors: unknown[] = [];

function visiblePrivateNames(surface: Surface) {
  return surface.host.textContent ?? '';
}

function resetReader(
  implementation: (input: ReadInput) => Promise<MyRealmsPage> = async () => page('Current account realm'),
) {
  readCalls.length = 0;
  hydrationErrors.length = 0;
  readPage = implementation;
}

afterAll(async () => {
  await window.happyDOM.close();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('the actual signed-in route hydrates its one read through the current query result and keeps SSR metadata and native links', async () => {
  resetReader(async () => page('SSR member realm', 'opaque-next-cursor'));
  const surface = await createSurface();
  try {
    await surface.load();
    // Exercise the route's loader envelope when query data is not available after hydration.
    surface.client.removeQueries({ queryKey: ['my-realms', ''], exact: true });
    const markup = renderToString(surface.tree());
    expect(markup).toContain('SSR member realm');
    expect(markup).toContain('Private description for SSR member realm');
    expect(markup).toContain('href="/en/realms/0192f3a0-6c1e-7b2a-9d4e-000000000201"');
    expect(readCalls).toEqual([{}]);

    surface.host.innerHTML = markup;
    await surface.hydrate();
    await settle();
    expect(hydrationErrors).toEqual([]);
    expect(visiblePrivateNames(surface)).toContain('SSR member realm');
    expect(readCalls).toHaveLength(1);
  } finally {
    await surface.dispose();
  }
});

test('the actual current route reads once under StrictMode and renders the QueryClient success with the complete ContentItem', async () => {
  resetReader(async () => page('Query-owned realm'));
  const surface = await createSurface();
  try {
    await surface.load();
    await surface.mount(true);
    expect(readCalls).toEqual([{}]);
    expect(visiblePrivateNames(surface)).toContain('Query-owned realm');
    expect(visiblePrivateNames(surface)).toContain('Private description for Query-owned realm');
    expect(surface.host.querySelector('h2')?.textContent).toBe('Query-owned realm');
    expect(surface.host.querySelector('a[href="/en/realms/0192f3a0-6c1e-7b2a-9d4e-000000000201"]')).not.toBeNull();
  } finally {
    await surface.dispose();
  }
});

test('same-account CSRF replacement and a batched away/back session transition retire the ready loader and query views', async () => {
  for (const transition of ['csrf', 'away-back'] as const) {
    resetReader(async () => page(`Old ${transition} realm`));
    const surface = await createSurface();
    try {
      await surface.load();
      await surface.mount();
      expect(visiblePrivateNames(surface)).toContain(`Old ${transition} realm`);
      if (transition === 'csrf') await surface.setSession(signedIn('realm-owner', 'csrf-replaced'));
      else {
        await act(async () => {
          surface.client.setQueryData(sessionQuery.queryKey, signedOut());
          surface.client.setQueryData(sessionQuery.queryKey, signedIn());
        });
      }
      await settle();
      expect(visiblePrivateNames(surface)).not.toContain(`Old ${transition} realm`);
      expect(surface.client.getQueryData(['my-realms', ''])).toBeUndefined();
    } finally {
      await surface.dispose();
    }
  }
});

test('signed-out, replaced-account and unavailable readiness transitions close the original list without borrowing replacement credentials', async () => {
  for (const next of [
    signedOut(),
    signedIn('different-owner', 'csrf-replacement'),
    { state: 'unknown' as const, subject: 'realm-owner', csrfToken: 'csrf-original' },
    { state: 'unavailable' as const, subject: null, csrfToken: null },
  ]) {
    resetReader(async () => page('Original private realm'));
    const surface = await createSurface();
    try {
      await surface.load();
      await surface.mount();
      await surface.setSession(next);
      await settle();
      expect(visiblePrivateNames(surface)).not.toContain('Original private realm');
      expect(surface.client.getQueryData(['my-realms', ''])).toBeUndefined();
    } finally {
      await surface.dispose();
    }
  }
});

test('a fresh explicit visit after a same-account credential replacement uses a new caller and is usable', async () => {
  resetReader(async () => page(`Current visit ${readCalls.length + 1}`));
  const surface = await createSurface();
  try {
    await surface.load();
    await surface.mount();
    expect(visiblePrivateNames(surface)).toContain('Current visit 1');
    await surface.setSession(signedIn('realm-owner', 'csrf-next'));
    await settle();
    expect(visiblePrivateNames(surface)).not.toContain('Current visit 1');
    await surface.router.invalidate();
    await settle();
    expect(readCalls).toHaveLength(2);
    expect(visiblePrivateNames(surface)).toContain('Current visit 2');
  } finally {
    await surface.dispose();
  }
});

test('same-account CSRF replacement while the existing server action is pending prevents its late result from reaching cache or display', async () => {
  const response = deferred<MyRealmsPage>();
  resetReader(() => response.promise);
  const surface = await createSurface();
  try {
    const loading = surface.load();
    await until(() => readCalls.length === 1, 'the existing My Realms server action');
    await surface.setSession(signedIn('realm-owner', 'csrf-replacement'));
    response.resolve(page('Late original realm'));
    await expect(loading).rejects.toThrow();
    await settle();
    expect(surface.client.getQueryData(['my-realms', ''])).toBeUndefined();
    expect(surface.host.textContent ?? '').not.toContain('Late original realm');
  } finally {
    response.resolve(page('Settled response'));
    await surface.dispose();
  }
});

test('a session transition while the route import is queued skips the private read', async () => {
  resetReader(async () => page('Should never be read'));
  const surface = await createSurface();
  try {
    const originalFetchQuery = surface.client.fetchQuery.bind(surface.client);
    surface.client.fetchQuery = ((options: { queryKey?: readonly unknown[] }) => {
      const pending = originalFetchQuery(options as never);
      if (options.queryKey?.[0] === 'my-realms') surface.client.setQueryData(sessionQuery.queryKey, signedOut());
      return pending;
    }) as typeof surface.client.fetchQuery;
    const loading = surface.load();
    await expect(loading).rejects.toThrow();
    expect(readCalls).toHaveLength(0);
    expect(surface.client.getQueryData(['my-realms', ''])).toBeUndefined();
  } finally {
    await surface.dispose();
  }
});

test('cursor and locale changes form a new route visit, keep native cursor order and perform one read per visit', async () => {
  const cursor = 'opaque/next?private=%25';
  resetReader(async (input) => page(input.cursor ? 'Second cursor realm' : 'First cursor realm', 'native-next-cursor'));
  const surface = await createSurface();
  try {
    await surface.load();
    await surface.mount();
    expect(visiblePrivateNames(surface)).toContain('First cursor realm');
    await surface.router.navigate({ to: '/realms', search: { cursor } } as never);
    await settle();
    expect(readCalls).toEqual([{}, { cursor }]);
    expect(visiblePrivateNames(surface)).toContain('Second cursor realm');
    expect(surface.host.querySelector('a[href*="cursor="]')).not.toBeNull();

    await setLocale('zh-Hant', { reload: false });
    surface.router.history.push(`/zh-Hant/realms?cursor=${encodeURIComponent(cursor)}`);
    await until(() => readCalls.length === 3, 'the locale-specific route visit');
    await settle();
    expect(readCalls).toHaveLength(3);
    expect(visiblePrivateNames(surface)).toContain('Second cursor realm');
  } finally {
    await surface.dispose();
  }
});

test('a failed continuation keeps same-request retry and restarts through a fresh first-page visit', async () => {
  const cursor = 'opaque/failed?private=%25';
  resetReader(async (input) => {
    if (input.cursor) throw new Error('Realm list is unavailable');
    return page('Recovered first-page realm');
  });
  const surface = await createSurface({ cursor });
  try {
    await expect(surface.load()).rejects.toThrow();
    await surface.mount();
    expect(surface.host.querySelector('button')).not.toBeNull();
    const retry = surface.host.querySelector('button')!;
    await act(async () => retry.click());
    await until(() => readCalls.length === 2 && surface.router.state.status === 'idle', 'the same cursor retry');
    expect(readCalls).toEqual([{ cursor }, { cursor }]);
    expect(surface.client.getQueryState(['my-realms', cursor])).toBeUndefined();

    const firstPage = surface.host.querySelector<HTMLAnchorElement>('a[href="/en/realms"]');
    expect(firstPage?.textContent).toBe(m.realms_first_page());
    await act(async () => firstPage!.click());
    await until(() => visiblePrivateNames(surface).includes('Recovered first-page realm'), 'the first-page route');
    expect(readCalls).toEqual([{ cursor }, { cursor }, {}]);
    expect(surface.router.state.location.search).toEqual({});
    expect(surface.client.getQueryState(['my-realms', cursor])).toBeUndefined();
  } finally {
    await surface.dispose();
  }

  resetReader(async () => {
    throw Object.assign(new Error('My Realms access is denied'), { status: 403 });
  });
  const denied = await createSurface({ cursor });
  try {
    await expect(denied.load()).rejects.toThrow();
    await denied.mount();
    expect(denied.host.querySelector('a[href="/en/realms"]')).toBeNull();
  } finally {
    await denied.dispose();
  }
});

test('unmount retires saved loader callbacks; a later explicit visit can load a fresh list', async () => {
  resetReader(async () => page(`Mounted visit ${readCalls.length + 1}`));
  const surface = await createSurface();
  try {
    await surface.load();
    await surface.mount();
    expect(visiblePrivateNames(surface)).toContain('Mounted visit 1');
    await surface.unmount();
    await surface.mount();
    await settle();
    expect(visiblePrivateNames(surface)).not.toContain('Mounted visit 1');
    await surface.router.invalidate();
    await settle();
    expect(readCalls).toHaveLength(2);
    expect(visiblePrivateNames(surface)).toContain('Mounted visit 2');
  } finally {
    await surface.dispose();
  }
});
