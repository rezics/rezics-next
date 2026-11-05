import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import type { SearchPageData } from '../src/search/search';
import type { SearchLoaderDeps } from '../src/search/search-params';
import { discoveryExample } from '../src/kernel/fake/search-discovery';
import { readSearchOutcome, searchUnavailablePage } from '../src/search/search-recovery';
import { discoveryRequest } from '../src/search/search-request';

const reads: { params: SearchLoaderDeps; signal?: AbortSignal; finish: (status?: number) => void }[] = [];
mock.module('../src/search/search', () => ({
  readSearch: ({
    data,
    signal,
  }: {
    data: { query: string; cursor?: string; ratingPopulation?: string; facetValues: Record<string, string[]> };
    signal?: AbortSignal;
  }) => {
    const params: SearchLoaderDeps = {
      query: data.query,
      facets: data.facetValues,
      cursor: data.cursor,
      ratingPopulation: data.ratingPopulation,
      type: undefined,
      sort: undefined,
    };
    return new Promise<SearchPageData>((resolve, reject) =>
      reads.push({
        params,
        signal,
        finish: async (status = 200) => {
          try {
            const outcome = await readSearchOutcome(
              discoveryRequest(params, ['en']),
              async () => ({
                status,
                data: { ...discoveryExample, next: params.cursor ? null : 'native-next' },
                error: status === 409 ? { code: 'search_restart_required' } : undefined,
              }),
              signal,
            );
            resolve({ ...searchUnavailablePage(params), ...outcome });
          } catch (error) {
            reject(error);
          }
        },
      }),
    );
  },
}));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://search.test/en/search?q=Mira' });
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
const { createBrowserHistory, createRootRouteWithContext, createRoute, createRouter, Outlet, RouterProvider } =
  await import('@tanstack/react-router');
const { useSearchQuery } = await import('../src/search/use-search-query');
const { searchQueryOptions } = await import('../src/search/search-queries');
const { discoverySearchHref, searchLoaderDeps, searchParams } = await import('../src/search/search-params');
const { useSearchWindow } = await import('../src/search/search-window');
const { SearchResultsRegion } = await import('../src/search/search-regions/results');
const { sessionQuery } = await import('../src/session/query');
const { setLocale } = await import('../src/paraglide/runtime.js');
notifyManager.setScheduler((callback) => callback());
const host = document.createElement('main');
document.body.append(host);
let root: ReturnType<typeof createRoot> | undefined;
let client: InstanceType<typeof QueryClient>;
let router: ReturnType<typeof createRouter>;
let navigation: Promise<void> | undefined;

function link(action: string) {
  return host.querySelector<HTMLAnchorElement>(`[data-window-action="${action}"]`)!;
}
async function finish(status = 200) {
  await act(async () => {
    reads.at(-1)!.finish(status);
    await navigation;
    navigation = undefined;
  });
}
async function click(action: string) {
  const anchor = link(action);
  anchor.focus();
  await act(async () => anchor.click());
}
async function show(search = '/en/search?q=Mira') {
  reads.length = 0;
  window.history.replaceState({}, '', search);
  setLocale('en', { reload: false });
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
  const parent = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet });
  const route = createRoute({
    getParentRoute: () => parent,
    path: '/en/search',
    validateSearch: searchParams,
    loaderDeps: ({ search }) => searchLoaderDeps(search),
    loader: ({ deps }) => client.fetchQuery(searchQueryOptions('en', deps)),
    component: () => {
      const params = route.useLoaderDeps();
      const { data } = useSearchQuery('en', params);
      const navigation = useSearchWindow({
        cursor: params.cursor,
        href: (cursor) => discoverySearchHref('en', { ...params, cursor }),
        locale: 'en',
        session: 'anonymous',
        ready: data.recovery?.status === 'ready',
        settled: data.recovery?.status !== 'loading',
        recoverable: data.recovery?.status === 'unavailable',
        checkpoint: data.discovery?.status === 'ready' ? data.discovery.page.as_of : undefined,
      });
      return (
        <SearchResultsRegion
          query={params.query}
          selectedFacets={params.facets}
          locale="en"
          data={data}
          windowNavigation={navigation}
        />
      );
    },
  });
  const destination = createRoute({
    getParentRoute: () => parent,
    path: '/en/subjects/$id/$slug',
    component: () => <p>Native subject</p>,
  });
  router = createRouter({
    routeTree: parent.addChildren([route, destination]),
    context: { queryClient: client },
    history: createBrowserHistory({ window: window as unknown as globalThis.Window }),
    defaultPendingMs: 0,
    defaultPendingMinMs: 0,
    defaultViewTransition: false,
  });
  const navigate = router.navigate.bind(router);
  router.navigate = (options) => {
    navigation = navigate(options);
    return navigation;
  };
  const loading = router.load();
  await act(async () => {
    await Promise.resolve();
  });
  await finish();
  await loading;
  root = createRoot(host);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  client?.clear();
  host.replaceChildren();
});
afterAll(() => {
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test.each([undefined, crypto.randomUUID()])(
  'forward, return and native open/back re-read one address (rating basis %s)',
  async (ratingPopulation) => {
    await show('/en/search?q=Mira' + (ratingPopulation ? `&ratingPopulation=${ratingPopulation}` : ''));
    expect(reads).toHaveLength(1);
    expect(host.textContent).toContain('Window 1');
    await click('next');
    expect(reads).toHaveLength(2);
    await finish();
    expect(host.textContent).toContain('Window 2');
    expect(document.activeElement).toBe(host.querySelector('[data-search-results]'));
    await click('previous');
    await finish();
    expect(reads).toHaveLength(3);
    expect(reads.at(-1)!.params.cursor).toBeUndefined();
    expect(reads.at(-1)!.params.ratingPopulation).toBe(ratingPopulation);
    expect(host.textContent).toContain('Window 1');
    expect(host.querySelector('[data-search-window-current]')!.textContent).toContain('Mira');
    const subject = host.querySelector<HTMLAnchorElement>('a[href*="/subjects/"]')!;
    await act(async () => {
      await router.navigate({ href: subject.getAttribute('href')! });
    });
    expect(host.textContent).toContain('Native subject');
    await act(async () => {
      router.history.back();
      await window.happyDOM.whenAsyncComplete();
    });
    expect(reads).toHaveLength(4);
    expect(host.textContent).not.toContain('Mira Reading Room');
    await finish();
    expect(host.textContent).toContain('Mira Reading Room');
    expect(host.textContent).toContain('Window 1');
  },
);

test('restart is explicit, duplicate activation is bounded and reader replacement retires pending focus', async () => {
  await show();
  await click('next');
  link('next')?.click();
  expect(reads).toHaveLength(2);
  await finish(503);
  expect(reads).toHaveLength(2);
  expect(host.textContent).not.toContain('Mira Reading Room');
  expect(link('previous').href).not.toContain('cursor=');
  await click('previous');
  await finish();
  await click('next');
  await finish(409);
  expect(reads).toHaveLength(4);
  expect(host.querySelector('[data-search-recovery="restart"]')).not.toBeNull();
  expect(host.textContent).not.toContain('Mira Reading Room');
  expect(link('first').href).not.toContain('cursor=');
  await click('first');
  await finish();
  await click('next');
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'replacement', csrfToken: 'new' });
  });
  await finish();
  expect(document.activeElement).not.toBe(host.querySelector('[data-search-results]'));
});

test('a superseded query and a moved focus cannot publish a pending window or regain focus', async () => {
  await show();
  await click('next');
  const abandoned = reads.at(-1)!;
  await act(async () => {
    void router.navigate({ href: '/en/search?q=Atlas' });
  });
  const replacement = reads.at(-1)!;
  expect(replacement.params.query).toBe('Atlas');
  expect(abandoned.signal?.aborted).toBe(true);
  await act(async () => {
    abandoned.finish();
  });
  expect(host.textContent).not.toContain('Mira Reading Room');
  await finish();
  expect(host.querySelector('[data-search-window-current]')!.textContent).toContain('Atlas');
  expect(link('previous')).toBeNull();
  await click('next');
  const outside = document.createElement('button');
  document.body.append(outside);
  outside.focus();
  await finish();
  expect(document.activeElement).toBe(outside);
  outside.remove();
});
