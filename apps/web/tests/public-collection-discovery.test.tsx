import { publicCollectionDiscoveryQueryOptions } from '../src/library/public-collection-discovery/query';
import { renderPublicCollection } from '../src/search/public-collection-directory/presentation';
import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { libraryNavigation } from '../src/library/navigation';
import { PublicCollectionDiscoveryPage } from '../src/library/public-collection-discovery/page';
import { publicCollectionDiscoveryRequest } from '../src/search/public-collection-directory/request';
import type {
  PublicCollectionDiscoveryState,
  PublicCollectionSummary,
} from '../src/search/public-collection-directory/read';
import type { DiscoveryRequest } from '../src/search/discovery';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';
import { resolveNavigation } from '../src/shell/navigation';

const readCalls: (string | null)[] = [];
const readRequests: DiscoveryRequest[] = [];
let readWindow: (cursor: string | null) => Promise<PublicCollectionDiscoveryState> = async () => {
  throw new Error('Unexpected public Collection page request');
};
import * as start from '../.storybook/react-start';
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: { PUBLIC_ORIGIN: 'https://site.test' } }));
mock.module('../src/kernel/client', () => ({
  preparePrivatePage: () => undefined,
  hasKernelOrigin: () => false,
  configuredKernelOrigin: () => undefined,
  acceptLanguage: () => 'en',
  requestLocale: () => 'en',
  kernelClient: () => ({
    subjects: {
      $search: {
        post: async (request: DiscoveryRequest) => {
          const cursor = request.cursor ?? null;
          readCalls.push(cursor);
          readRequests.push(structuredClone(request));
          const page = await readWindow(cursor);
          if (page.status !== 'ready') return { status: 503, error: { detail: 'Search unavailable' } };
          return {
            status: 200,
            data: {
              hits: page.collections.map((collection) => ({
                key: { owner: 'semantic', kind: 'collection', route: 0, id: collection.id },
                summary: {
                  kind: 'subject',
                  value: {
                    id: collection.id,
                    type: 'collection',
                    types: ['collection'],
                    label: { value: collection.title, language: 'en' },
                    creativeWork: false,
                    cover: null,
                  },
                },
                labels: { en: collection.title },
              })),
              kinds: { values: [], next: null },
              next: page.next,
              as_of: page.asOf,
            },
          };
        },
      },
    },
  }),
}));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/collections' });
const canonical = window.document.createElement('link');
canonical.rel = 'canonical';
canonical.href = 'https://site.test/en/collections';
window.document.head.append(canonical);
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  HTMLButtonElement: window.HTMLButtonElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  ShadowRoot: window.ShadowRoot,
  MutationObserver: window.MutationObserver,
  Event: window.Event,
  MouseEvent: window.MouseEvent,
  PointerEvent: window.PointerEvent,
  KeyboardEvent: window.KeyboardEvent,
  FocusEvent: window.FocusEvent,
  FormData: window.FormData,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  scrollTo: () => undefined,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const savedGlobals = new Map(
  Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { readPublicCollectionPage } = await import('../src/search/public-collection-directory/read');
const { Route } = await import('../src/routes/collections/index');
const rootRoute = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet });
const localeRoute = createRoute({ getParentRoute: () => rootRoute, path: '/$locale', component: Outlet });
const directoryRoute = Route.update({
  id: '/collections/',
  path: 'collections/',
  getParentRoute: () => localeRoute,
} as never);
const awayRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/away',
  component: () => createElement('p', null, 'Away'),
});
const routeTree = rootRoute.addChildren([localeRoute.addChildren([directoryRoute]), awayRoute]);
const originalLocale = getLocale();

function ready(title: string, next: string | null, asOf = 'source-a'): PublicCollectionDiscoveryState {
  return { status: 'ready', collections: [{ id: title.toLowerCase(), title }], next, asOf };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function mount(initialEntry: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });
  const router = createRouter({
    routeTree,
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });
  await router.load();
  const host = window.document.createElement('main');
  window.document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(QueryClientProvider, { client }, createElement(RouterProvider, { router }))),
  );
  return {
    host,
    router,
    async close() {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    },
  };
}

async function activate(host: HTMLElement, slot: string, keyboard = false) {
  const target = host.querySelector<HTMLElement>(`[data-slot="${slot}"]`)!;
  if (keyboard) target.focus();
  await act(async () => {
    target.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
    await settle();
  });
  return target;
}

function nativeHit(id: string, title: string) {
  return {
    key: { owner: 'semantic', kind: 'collection', route: 0, id },
    summary: {
      kind: 'subject',
      value: {
        id,
        type: 'collection',
        types: ['collection'],
        label: { value: title, language: 'en' },
        creativeWork: false,
        cover: null,
      },
    },
    labels: { en: title },
    descriptions: { en: `${title} description` },
  };
}

test('uses Search collection kind paging and keeps only native public summaries and order', async () => {
  let sent: DiscoveryRequest | undefined;
  const address = {
    presentationKind: 'mixed',
    curator: '00000001-0000-7000-8000-000000000001',
    subject: '00000002-0000-7000-8000-000000000002',
    order: 'popular' as const,
    cursor: 'opaque+/=',
  };
  const result = await readPublicCollectionPage('en', address, async (request) => {
    sent = request;
    return {
      status: 200,
      data: {
        hits: [nativeHit('collection-1', 'First'), nativeHit('collection-2', 'Second')],
        kinds: {
          values: [
            {
              id: 'collection',
              labels: { en: 'Collections' },
              icon: 'collection',
              count: { kind: 'collection', value: 2, exact: true },
            },
          ],
          next: null,
        },
        next: 'next+/=',
        as_of: 'native-checkpoint',
      },
    };
  });

  expect(sent).toMatchObject({
    representation: 'discovery-v1',
    limit: 24,
    cursor: 'opaque+/=',
    filter: { and: [{ kind: { in: ['collection'] } }] },
    collectionDirectory: {
      presentationKind: 'mixed',
      curator: '00000001-0000-7000-8000-000000000001',
      subject: '00000002-0000-7000-8000-000000000002',
      order: 'popular',
    },
  });
  expect(sent?.kindCountLeaf).toBeUndefined();
  expect(sent?.text).toBeUndefined();
  expect(result).toMatchObject({
    status: 'ready',
    collections: [
      { id: 'collection-1', title: 'First', description: 'First description' },
      { id: 'collection-2', title: 'Second', description: 'Second description' },
    ],
    next: 'next+/=',
  });
  expect(result).not.toHaveProperty('kinds');
});

test('rejects a native next cursor that cannot be admitted by the directory route', async () => {
  const result = await readPublicCollectionPage('en', {}, async () => ({
    status: 200,
    data: {
      hits: [],
      kinds: { values: [], next: null },
      next: 'x'.repeat(4865),
      as_of: 'native-checkpoint',
    },
  }));

  expect(result).toEqual({ status: 'unavailable' });
});

test('an empty native continuation stays open and offers its exact next cursor', () => {
  const selection = {
    presentationKind: 'mixed',
    curator: '00000001-0000-7000-8000-000000000001',
    subject: '00000002-0000-7000-8000-000000000002',
    order: 'popular' as const,
  };
  const markup = renderToStaticMarkup(
    createElement(PublicCollectionDiscoveryPage<PublicCollectionSummary>, {
      renderCollection: renderPublicCollection,
      state: { status: 'ready', collections: [], next: 'next+/=', asOf: 'native-checkpoint' },
      locale: 'en',
      selection,
      onSelect: () => undefined,
      onRetry: () => undefined,
    }),
  );

  expect(markup).toContain('There are no Collections on this page');
  expect(markup).toContain(
    `href="/en/collections?presentationKind=mixed&amp;curator=${selection.curator}&amp;subject=${selection.subject}&amp;order=popular&amp;cursor=next%2B%2F%3D"`,
  );
  expect(markup).toContain('name="presentationKind"');
  expect(markup).toContain('value="mixed"');
  expect(markup).toContain('name="curator"');
  expect(markup).toContain('name="subject"');
  expect(markup).toContain('name="order"');
  expect(markup).toContain('More Collections');
  expect(markup).not.toContain('No public Collections are available yet');
});

test('a refused continuation has a localized first-page recovery link', () => {
  const markup = renderToStaticMarkup(
    createElement(PublicCollectionDiscoveryPage<PublicCollectionSummary>, {
      renderCollection: renderPublicCollection,
      state: { status: 'denied' },
      locale: 'en',
      cursor: 'refused-cursor',
      onSelect: () => undefined,
      onRetry: () => undefined,
    }),
  );

  expect(markup).toContain('This Collection page was refused');
  expect(markup).toContain('href="/en/collections"');
  expect(markup).toContain('Start over');
});

test('public Collections discovery is in the anonymous primary navigation slot', () => {
  const entry = resolveNavigation(libraryNavigation, { locale: 'ja', pathname: '/ja/collections' }).find(
    ({ id }) => id === 'library.discover-collections',
  );

  expect(entry).toMatchObject({
    kind: 'navigation',
    group: 'primary',
    href: '/ja/collections',
    current: true,
  });
  expect(entry).not.toHaveProperty('signedIn');
});

test('the localized route pages backward, retries its exact cursor, and retires departed source visits', async () => {
  await setLocale('en', { reload: false });
  readCalls.length = 0;
  const opaque = 'opaque+/=';
  const second = 'window-two';
  const sparse = 'window-sparse';
  const terminal = 'window-terminal';
  const queued = new Map<string | null, (PublicCollectionDiscoveryState | Promise<PublicCollectionDiscoveryState>)[]>();
  const enqueue = (
    cursor: string | null,
    ...pages: (PublicCollectionDiscoveryState | Promise<PublicCollectionDiscoveryState>)[]
  ) => queued.set(cursor, pages);
  enqueue(null, ready('First collection', opaque));
  enqueue(opaque, { status: 'unavailable' }, ready('Second collection', second));
  enqueue(second, ready('Third collection', sparse));
  enqueue(sparse, { status: 'ready', collections: [], next: terminal, asOf: 'source-a' });
  enqueue(terminal, { status: 'ready', collections: [], next: null, asOf: 'source-a' });
  enqueue('direct-later', ready('Direct later', 'source-b'));
  enqueue('source-b', ready('Source B', null, 'source-b'));
  const departure = deferred<PublicCollectionDiscoveryState>();
  enqueue('depart-source', ready('Departure source', 'depart-target'));
  enqueue('depart-target', departure.promise);
  readWindow = async (cursor) => {
    const page = queued.get(cursor)?.shift();
    if (page instanceof Promise) return page;
    if (!page) throw new Error(`Missing public Collection fixture for cursor ${cursor}`);
    return page;
  };

  const view = await mount('/en/collections?keep=%2f&duplicate=a&duplicate=b#directory');
  try {
    expect(view.host.querySelector('a[href="/en/collections/first%20collection"]')).not.toBeNull();
    expect(view.host.querySelector('[data-slot="continuation"]')?.getAttribute('href')).toBe(
      `/en/collections?keep=%2f&duplicate=a&duplicate=b&cursor=${encodeURIComponent(opaque)}#directory`,
    );
    await activate(view.host, 'continuation', true);
    expect(readCalls).toEqual([null, opaque]);
    expect(view.host.textContent).toContain('Public Collections could not be loaded.');
    expect(view.router.history.location.href).toContain(`cursor=${encodeURIComponent(opaque)}`);
    await activate(view.host, 'retry', true);
    expect(view.host.textContent).toContain('Second collection');
    expect(document.activeElement).not.toBe(view.host.querySelector('h1'));
    expect(readCalls.filter((cursor) => cursor === opaque)).toHaveLength(2);

    await activate(view.host, 'continuation', true);
    expect(view.host.textContent).toContain('Third collection');
    expect(document.activeElement).toBe(view.host.querySelector('h1'));
    await activate(view.host, 'continuation');
    expect(view.host.textContent).toContain('There are no Collections on this page');
    expect(view.host.querySelector('[data-slot="continuation"]')).not.toBeNull();
    await activate(view.host, 'continuation');
    expect(view.host.querySelector('[data-slot="previous"]')?.getAttribute('href')).toContain(
      `cursor=${encodeURIComponent(sparse)}`,
    );
    expect(view.host.querySelector('[data-slot="first"]')).not.toBeNull();
    expect(view.host.textContent).toContain('There are no Collections on this page');

    await activate(view.host, 'previous');
    expect(view.router.history.location.href).toContain(`cursor=${encodeURIComponent(sparse)}`);
    await activate(view.host, 'first');
    expect(view.router.history.location.href).toBe('/en/collections?keep=%2f&duplicate=a&duplicate=b#directory');
    expect(view.host.textContent).toContain('First collection');

    view.router.history.push('/en/collections?cursor=direct-later&keep=%2f#direct');
    await act(async () => settle());
    expect(view.host.textContent).toContain('Direct later');
    expect(view.host.querySelector('[data-slot="previous"]')).toBeNull();
    expect(view.host.querySelector('[data-slot="first"]')?.getAttribute('href')).toBe(
      '/en/collections?keep=%2f#direct',
    );
    await activate(view.host, 'continuation');
    expect(view.host.textContent).toContain('Source B');
    expect(view.host.querySelector('[data-slot="previous"]')).toBeNull();
    await activate(view.host, 'first');
    expect(view.router.history.location.href).toBe('/en/collections?keep=%2f#direct');
    expect(view.host.querySelector('[data-slot="previous"]')).toBeNull();

    view.router.history.push('/en/collections?cursor=depart-source');
    await act(async () => settle());
    const oldAction = await activate(view.host, 'continuation', true);
    const oldHeading = view.host.querySelector('h1');
    await act(async () => view.router.navigate({ to: '/away' }));
    departure.resolve(ready('Late departure page', null, 'source-b'));
    await act(async () => settle());
    expect(view.host.textContent).toBe('Away');
    expect(document.activeElement).not.toBe(oldHeading);
    expect(oldAction.isConnected).toBe(false);

    view.router.history.push('/en/collections?cursor=direct-later');
    await act(async () => settle());
    expect(view.host.textContent).toContain('Direct later');
    expect(view.host.querySelector('[data-slot="previous"]')).toBeNull();
  } finally {
    await view.close();
  }
});

test('committing directory filters replaces the cursor and sends the complete selection', async () => {
  await setLocale('en', { reload: false });
  readCalls.length = 0;
  readRequests.length = 0;
  readWindow = async () => ready('Filtered collection', null, 'directory-current');
  const view = await mount(
    '/en/collections?presentationKind=mixed&curator=00000001-0000-7000-8000-000000000001&subject=00000002-0000-7000-8000-000000000002&order=popular&cursor=old-window',
  );
  try {
    expect(readRequests[0]?.collectionDirectory).toEqual({
      presentationKind: 'mixed',
      curator: '00000001-0000-7000-8000-000000000001',
      subject: '00000002-0000-7000-8000-000000000002',
      order: 'popular',
    });
    const form = view.host.querySelector<HTMLFormElement>('[data-slot="public-collection-discovery-filters"]')!;
    (form.elements.namedItem('presentationKind') as HTMLInputElement).value = 'schema:Book';
    (form.elements.namedItem('curator') as HTMLInputElement).value = '00000003-0000-7000-8000-000000000003';
    (form.elements.namedItem('subject') as HTMLInputElement).value = '00000004-0000-7000-8000-000000000004';
    (form.elements.namedItem('order') as HTMLSelectElement).value = 'recent';
    await act(async () => {
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await settle();
    });
    expect(view.router.history.location.href).toBe(
      '/en/collections?presentationKind=schema%3ABook&curator=00000003-0000-7000-8000-000000000003&subject=00000004-0000-7000-8000-000000000004&order=recent',
    );
    expect(readCalls).toEqual(['old-window', null]);
    expect(readRequests.at(-1)?.collectionDirectory).toEqual({
      presentationKind: 'schema:Book',
      curator: '00000003-0000-7000-8000-000000000003',
      subject: '00000004-0000-7000-8000-000000000004',
      order: 'recent',
    });
    expect(view.host.textContent).toContain('Filtered collection');
  } finally {
    await view.close();
  }
});

afterAll(async () => {
  await setLocale(originalLocale, { reload: false });
  mock.restore();
  await window.happyDOM.close();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('the consumer read port makes one bounded read with the exact public address and cancellation', async () => {
  const signal = new AbortController().signal;
  const calls: unknown[] = [];
  const address = { presentationKind: 'mixed', order: 'popular' as const, cursor: 'opaque+/=%25' };
  const refused: PublicCollectionDiscoveryState = { status: 'denied' };
  const options = publicCollectionDiscoveryQueryOptions('ja', address, async (input) => {
    calls.push(input);
    return refused;
  });
  if (typeof options.queryFn !== 'function') throw new Error('Expected the directory read function');
  const result = await options.queryFn({ signal } as never);
  expect(result).toBe(refused);
  expect(calls).toEqual([{ data: { locale: 'ja', ...address }, signal }]);
  expect(options.queryKey).toEqual([
    'public-collection-discovery',
    'anonymous',
    'ja',
    'mixed',
    null,
    null,
    'popular',
    address.cursor,
  ]);
  expect(options.retry).toBe(false);
  expect(options.refetchOnMount).toBe(false);
  expect(options.refetchOnWindowFocus).toBe(false);
});

test('the native adapter retains refusal, preparing and empty as different outcomes without another query', async () => {
  for (const [status, code, expected] of [
    [403, 'forbidden', 'denied'],
    [503, 'index_not_ready', 'not-ready'],
  ] as const) {
    let requests = 0;
    const result = await readPublicCollectionPage('en', { cursor: 'exact+/=' }, async () => {
      requests++;
      return { status, error: { code } };
    });
    expect(result).toEqual({ status: expected });
    expect(requests).toBe(1);
  }
  let requests = 0;
  expect(
    await readPublicCollectionPage('en', {}, async () => {
      requests++;
      return { status: 200, data: { hits: [], kinds: { values: [], next: null }, next: null, as_of: 'empty' } };
    }),
  ).toEqual({ status: 'ready', collections: [], next: null, asOf: 'empty' });
  expect(requests).toBe(1);
});
