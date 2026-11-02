import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { queryOptions } from '@tanstack/react-query';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import { discoveryExample } from '../src/kernel/fake/search-discovery';
import type { SearchPageData } from '../src/search/search';
import type { SearchLoaderDeps } from '../src/search/search-params';
import { searchUnavailablePage } from '../src/search/search-recovery';
import type { BrowserSession } from '../src/session/browser-state';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);

const reads: { resolve: (value: SearchPageData) => void }[] = [];
mock.module('../src/search/search-queries', () => ({
  searchQueryOptions: (locale: string, params: SearchLoaderDeps) =>
    queryOptions({
      queryKey: ['search', 'discovery-v1', 'anonymous', 'public-global', locale, params],
      queryFn: () =>
        new Promise<SearchPageData>((resolve) => {
          reads.push({ resolve });
        }),
      staleTime: 0,
      retry: false,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    }),
}));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://search.test/search?q=Mira' });
window.scrollTo = () => undefined;
const globals = {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  scrollTo: window.scrollTo,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider, notifyManager } = await import('@tanstack/react-query');
const { createMemoryHistory, createRootRouteWithContext, createRouter, Outlet, RouterProvider } =
  await import('@tanstack/react-router');
const { Route } = await import('../src/routes/search');
const { sessionQuery } = await import('../src/session/query');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
const require = createRequire(import.meta.url);
const storybook = createRequire(require.resolve('storybook/test'));
const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
const user = userEvent.setup({ document: window.document });
notifyManager.setScheduler((callback) => callback());

const state: SearchLoaderDeps = { query: 'Mira', type: undefined, facets: {}, cursor: undefined, sort: undefined };
const unavailable = searchUnavailablePage(state);
const ready: SearchPageData = {
  ...unavailable,
  recovery: { status: 'ready' },
  discovery: {
    status: 'ready',
    page: { hits: [], kinds: { values: [], next: null }, next: null, as_of: discoveryExample.as_of },
  },
};
const viewer = (subject = 'one', csrfToken: string | null = 'csrf'): BrowserSession => ({
  state: 'signed-in',
  subject,
  csrfToken,
});

const host = document.createElement('main');
document.body.append(host);
let root: ReturnType<typeof createRoot>;

function focusedResults() {
  return document.activeElement?.hasAttribute('data-search-results') === true;
}

async function settle(page: SearchPageData) {
  await act(async () => {
    reads.at(-1)!.resolve(page);
  });
}

async function show(session: BrowserSession) {
  reads.length = 0;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, session);
  const parent = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet });
  Route.update({
    id: '/search',
    path: '/search',
    getParentRoute: () => parent,
    head: () => ({}),
  } as never);
  const router = createRouter({
    routeTree: parent.addChildren([Route]),
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: ['/search?q=Mira'] }),
    defaultPendingMs: 0,
    defaultPendingMinMs: 0,
  });
  const loading = router.load();
  await act(async () => {
    await Promise.resolve();
  });
  await settle(unavailable);
  await loading;
  root ??= createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  return client;
}

async function retryCurrent() {
  const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === m.search_facet_retry())!;
  retry.focus();
  expect(document.activeElement).toBe(retry);
  await act(async () => user.keyboard('{Enter}'));
  expect(host.querySelector('[data-search-recovery="loading"]')).not.toBeNull();
}

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = undefined!;
  host.replaceChildren();
  setLocale('en', { reload: false });
});

afterAll(() => {
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('the Search route retires pending Retry focus when the observed session changes', async () => {
  setLocale('en', { reload: false });
  const client = await show(viewer());
  await retryCurrent();
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, viewer('two'));
  });
  await settle(ready);
  expect(focusedResults()).toBe(false);
});

test('stable session observation still recovers current Retry focus', async () => {
  setLocale('en', { reload: false });
  const client = await show(viewer());
  await retryCurrent();
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, viewer('one', 'rotated'));
  });
  await settle(ready);
  expect(focusedResults()).toBe(true);

  await act(async () => root.unmount());
  root = undefined!;
  host.replaceChildren();
  await show(viewer());
  await retryCurrent();
  await settle(ready);
  expect(focusedResults()).toBe(true);
});
