import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useId } from 'react';
import type { SearchPageData } from '../src/search/search';
import type { SpacePageData } from '../src/community/space';
import { realmCataloguePageSearch } from '../src/community/realm-catalogue-entry';
import type { SearchLoaderDeps } from '../src/search/search-params';
import { realmCatalogueSearchLoaderDeps } from '../src/search/search-params';
import { realmCatalogueWindow } from '../src/search/realm-catalogue-window';
import { searchSessionLifetime } from '../src/search/scoped-search-lifetime';
import { searchPageForRecovery, searchUnavailablePage } from '../src/search/search-recovery';

const realm = '11111111-1111-4111-8111-111111111111';
const reads: { data: Record<string, unknown>; finish: () => void }[] = [];
mock.module('../src/search/search-query-options', () => ({
  searchApplication: {
    queryKey: (locale: string, params: SearchLoaderDeps, reader?: string) => [
      'search',
      'discovery-v1',
      searchSessionLifetime(locale, params, reader),
    ],
    loadingPage: (params: SearchLoaderDeps) =>
      searchPageForRecovery(searchUnavailablePage(params), { status: 'loading' }),
    unavailablePage: (params: SearchLoaderDeps) => searchUnavailablePage(params),
  },
  searchQueryOptions: (locale: string, params: SearchLoaderDeps, reader?: string) => ({
    queryKey: ['search', 'discovery-v1', searchSessionLifetime(locale, params, reader)],
    queryFn: () =>
      new Promise<SearchPageData>((resolve) => {
        const data = {
          query: params.query,
          cursor: params.cursor,
          ratingPopulation: params.ratingPopulation,
          facetValues: params.facets,
        };
        reads.push({
          data,
          finish: () => {
            const queryState = realmCatalogueSearchLoaderDeps({ q: data.query, searchCursor: data.cursor }, realm);
            resolve({ ...searchUnavailablePage(queryState), recovery: { status: 'ready' } });
          },
        });
      }),
  }),
}));
mock.module('../src/search/search', () => ({
  RealmCatalogueSearch: () => {
    const location = useLocation();
    const identity = useId();
    const params = realmCatalogueSearchLoaderDeps(location.search, realm);
    const { data } = useSearchQuery('en', params, '["signed-out"]', {
      pathname: location.pathname,
      cursorParam: 'searchCursor',
      realmId: realm,
    });
    return <output data-identity={identity}>{data.recovery?.status}</output>;
  },
}));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://site.test/en/realms/' + realm });
const globals = {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  scrollTo: window.scrollTo.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { QueryClient, QueryClientProvider, notifyManager } = await import('@tanstack/react-query');
const { createRootRoute, createRoute, createRouter, createMemoryHistory, Outlet, RouterProvider, useLocation } =
  await import('@tanstack/react-router');
const { useSearchQuery } = await import('../src/search/use-search-query');
const { RealmCatalogueCurrent } = await import('../src/community/realm-catalogue-current');
const { sessionQuery } = await import('../src/session/query');
const { setLocale } = await import('../src/paraglide/runtime.js');
notifyManager.setScheduler((callback) => callback());
const page: SpacePageData = {
  space: { id: realm, title: 'Anime', summary: '' },
  realm: {
    id: realm,
    title: 'Anime',
    summary: '',
    visibility: 'public',
    credentialMode: 'anonymous',
    boards: [],
    published: [],
  },
};
let root: ReturnType<typeof createRoot> | undefined;
let client: InstanceType<typeof QueryClient>;
const host = document.createElement('main');
document.body.append(host);
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  client?.clear();
  reads.length = 0;
});
afterAll(() => {
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

for (const path of [`/en/realms/${realm}`, '/en/spaces/anime'])
  test(`direct catalogue entry and continuation stay current at ${path}`, async () => {
    setLocale('en', { reload: false });
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
    const parent = createRootRoute({ component: Outlet });
    const route = createRoute({
      getParentRoute: () => parent,
      path: path.includes('/realms/') ? '/en/realms/$id' : '/en/spaces/$address',
      validateSearch: realmCataloguePageSearch,
      component: () => <RealmCatalogueCurrent page={page} available />,
    });
    const router = createRouter({
      routeTree: parent.addChildren([route]),
      history: createMemoryHistory({ initialEntries: [path] }),
    });
    await router.load();
    root = createRoot(host);
    await act(async () =>
      root!.render(
        <QueryClientProvider client={client}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    );
    expect(reads).toHaveLength(1);
    expect(reads[0]!.data.resourceScope).toEqual({ kind: 'realm', id: realm });
    await act(async () => reads[0]!.finish());
    expect(host.querySelector('output')?.textContent).toBe('ready');
    const identity = host.querySelector('output')?.getAttribute('data-identity');
    await act(async () => router.navigate({ href: `${path}?node=boards&cursor=shelf&searchCursor=works` }));
    expect(reads).toHaveLength(2);
    expect(reads[1]!.data.cursor).toBe('works');
    expect(host.querySelector('output')?.getAttribute('data-identity')).toBe(identity);
    await act(async () => reads[1]!.finish());
    expect(host.querySelector('output')?.textContent).toBe('ready');
  });

test('pending and failed windows keep rows without borrowing aggregates; native concealment retires them', () => {
  const params = realmCatalogueSearchLoaderDeps({}, realm);
  const previous = {
    ...searchUnavailablePage(params),
    result: { subjects: [], next: 'next', as_of: 'cut', kinds: { values: [], next: null } },
  } as SearchPageData;
  for (const status of ['loading', 'unavailable', 'index-not-ready', 'source-not-ready'] as const) {
    const current = { ...searchUnavailablePage(params), recovery: { status } };
    const visible = realmCatalogueWindow(current, previous);
    expect(visible.result?.subjects).toBe(previous.result!.subjects);
    expect(visible.result?.kinds).toBeUndefined();
    expect(visible.result?.next).toBeNull();
    expect(visible.refinement).toBe(current.refinement);
  }
  const concealed = { ...searchUnavailablePage(params), recovery: searchRecoveryFromResponse({ status: 404 }) };
  expect(concealed.recovery.status).toBe('denied');
  expect(realmCatalogueWindow(concealed, previous).result).toBeUndefined();
});
