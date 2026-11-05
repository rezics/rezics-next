import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { bundledRelease } from '@rezics/definitions/bundled';
import * as start from '../.storybook/react-start';
import type { ReleaseSearchRequest } from '../src/search/release-search';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => ({
  ...start,
  createServerFn: () => {
    const chain = { validator: () => chain, handler: (handler: unknown) => handler };
    return chain;
  },
}));
mock.module('@tanstack/react-start/server', () => start);
const definitions = await import('../src/subject/definitions');
mock.module('../src/subject/definitions', () => ({ ...definitions, refreshRelease: async () => bundledRelease }));
const suggestions = await import('../src/search/suggestions');
mock.module('../src/search/suggestions', () => ({
  ...suggestions,
  readSubjectSuggestions: async () => ({ subjects: [] }),
}));
const kernel = await import('../src/kernel/client');
const reads: { request: ReleaseSearchRequest; resolve: (response: unknown) => void }[] = [];
mock.module('../src/kernel/client', () => ({
  ...kernel,
  kernelClient: () => ({
    subjects: {
      $search: { post: (request: ReleaseSearchRequest) => new Promise((resolve) => reads.push({ request, resolve })) },
    },
  }),
}));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://search.test/en/search/releases' });
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
const { releaseSearchQueryOptions } = await import('../src/search/release-search-query');
const { parseReleaseSearch, releaseSearchHref } = await import('../src/search/release-search');
const { useReleaseWindowQuery } = await import('../src/search/release-window-query');
const { ReleaseSearchPage } = await import('../src/search/release-search-page');
const { browserObservation } = await import('../src/session');
const { sessionQuery } = await import('../src/session/query');
const { GLOBAL, QUESTION } = await import('../src/features/pages/subject-ratings');
const { setLocale } = await import('../src/paraglide/runtime.js');
notifyManager.setScheduler((callback) => callback());
const id = '018f0000-0000-7000-8000-000000000001';
const raw = {
  subtype: 'wd:Q20631656',
  q: 'Edition',
  platform: id,
  releaseLanguage: 'ja, en',
  language: 'fr, ja',
  gte: '2024-02-29',
  lte: '2024-03',
  ageGte: '12',
  ageLte: '18',
  ageUnit: 'http://www.wikidata.org/entity/Q577',
  developer: id,
  publisher: id,
  sort: 'name',
  threshold: '2',
  condition: JSON.stringify({ not: { statement: { property: 'schema:inLanguage', in: ['de'] } } }),
};
const checkpoint = '2026-11-04T00:00:00Z';
function page(next: string | null = 'next', status = 'ready', as_of = checkpoint) {
  const label = { value: 'Current edition', language: 'en' };
  return {
    status,
    next,
    as_of,
    groups:
      status === 'preparing'
        ? []
        : [
            {
              kind: 'release',
              id,
              workLink: 'missing',
              release: {
                id,
                type: 'wd:Q20631656',
                kind: 'wd:Q20631656',
                labels: { en: label.value },
                facts: {},
                base: { id, kind: 'wd:Q20631656', kindLabel: label, title: label, image: null, url: { id, label } },
                summary: {
                  id,
                  type: 'wd:Q20631656',
                  types: ['wd:Q20631656'],
                  label: null,
                  creativeWork: false,
                  cover: null,
                },
                figure: {
                  questionId: QUESTION,
                  populationId: GLOBAL,
                  scale: { min: 0, max: 10, displayStep: 1 },
                  count: 0,
                  state: 'insufficient_data',
                  mean: null,
                  score: null,
                },
              },
            },
          ],
  };
}
const host = document.createElement('main');
document.body.append(host);
let root: ReturnType<typeof createRoot> | undefined;
let client: InstanceType<typeof QueryClient>;
let router: ReturnType<typeof createRouter>;
let navigation: Promise<void> | undefined;
let stopObservation: (() => void) | undefined;
const link = (action: string) => host.querySelector<HTMLAnchorElement>(`[data-window-action="${action}"]`);
async function finish(data = page(), status = 200) {
  await act(async () => {
    reads.at(-1)!.resolve({ status, data, error: status === 409 ? { code: 'search_restart_required' } : undefined });
    await navigation;
    navigation = undefined;
  });
}
async function click(action: string) {
  link(action)!.focus();
  await act(async () => link(action)!.click());
}
async function show(cursor?: string, initial = page()) {
  reads.length = 0;
  setLocale('en', { reload: false });
  const parsed = parseReleaseSearch(raw, bundledRelease, 'en');
  expect(parsed.invalid).toEqual([]);
  window.history.replaceState({}, '', releaseSearchHref('en', parsed.form, cursor));
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'reader', csrfToken: 'one' });
  stopObservation = browserObservation(client).subscribe(() => {});
  const parent = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet });
  const route = createRoute({
    getParentRoute: () => parent,
    path: '/en/search/releases',
    validateSearch: (search) => search,
    loaderDeps: ({ search }) => search,
    loader: ({ deps }) => client.fetchQuery(releaseSearchQueryOptions('en', deps, 'unknown')).then(() => null),
    component: () => {
      const { result, reader } = useReleaseWindowQuery('en', route.useSearch());
      return <ReleaseSearchPage locale="en" reader={reader} {...result} />;
    },
  });
  const destination = createRoute({
    getParentRoute: () => parent,
    path: '/en/subjects/$id/$slug',
    component: () => <p>Native edition</p>,
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
  await finish(initial);
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
  stopObservation?.();
  client?.clear();
  host.replaceChildren();
});
afterAll(() => {
  window.happyDOM.abort();
  mock.restore();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('released group Continue, Previous, First and native open/back each read once with every executed operand', async () => {
  await show();
  expect(reads).toHaveLength(1);
  expect(host.textContent).toContain('Group window 1');
  expect(link('previous')).toBeNull();
  await click('next');
  link('next')?.click();
  expect(reads).toHaveLength(2);
  expect(host.textContent).not.toContain('Current edition');
  await finish(page('third'));
  expect(host.textContent).toContain('Group window 2');
  expect(document.activeElement === host.querySelector('[data-release-group-results]')).toBe(true);
  await click('previous');
  await finish();
  expect(reads).toHaveLength(3);
  expect(reads.at(-1)!.request.cursor).toBeUndefined();
  await click('next');
  await finish(page('third'));
  await click('first');
  await finish();
  expect(reads).toHaveLength(5);
  for (const read of reads)
    expect({ ...read.request, cursor: undefined }).toEqual({ ...reads[0]!.request, cursor: undefined });
  const edition = host.querySelector<HTMLAnchorElement>('a[href*="/subjects/"]')!;
  await act(async () => {
    await router.navigate({ href: edition.getAttribute('href')! });
  });
  expect(host.textContent).toContain('Native edition');
  await act(async () => {
    router.history.back();
    await window.happyDOM.whenAsyncComplete();
  });
  expect(reads).toHaveLength(6);
  expect(host.textContent).not.toContain('Current edition');
  await finish();
  expect(host.textContent).toContain('Group window 1');
  const envelope = JSON.stringify(window.history.state.rezicsSearchWindows);
  expect(envelope).not.toContain('Current edition');
  expect(envelope).not.toContain('csrf');
  await click('next');
  await finish(page(null));
  expect(link('next')).toBeNull();
  expect(
    document.activeElement === host.querySelector('[data-release-group-results]'),
    document.activeElement?.outerHTML.slice(0, 400),
  ).toBe(true);
});

test('direct opaque and preparing addresses stay unnumbered; progress, failure, cycles and restart retain truthful actions', async () => {
  await show('opaque');
  expect(host.textContent).toContain('Current group window');
  expect(link('previous')).toBeNull();
  await click('next');
  await finish(page('next', 'preparing'));
  expect(host.textContent).not.toContain('Current edition');
  await click('retry');
  await finish(page('preparing-progress', 'preparing'));
  expect(host.textContent).not.toContain('Current edition');
  expect(link('previous')!.href).toContain('cursor=opaque');
  await click('retry');
  await finish(page('after-ready'));
  expect(host.textContent).toContain('Current group window');
  expect(link('previous')!.href).toContain('cursor=opaque');
  await click('next');
  await finish(page(), 503);
  expect(host.textContent).not.toContain('Current edition');
  expect(link('previous')!.href).toContain('cursor=preparing-progress');
  await click('previous');
  await finish(page('preparing-progress'));
  expect(link('next')).toBeNull();
  expect(host.textContent).toContain('repeats an earlier group window');
  await click('first');
  await finish();
  await click('next');
  await finish(page(), 409);
  expect(host.textContent).not.toContain('Current edition');
  expect(link('first')).not.toBeNull();
  expect(link('retry')).toBeNull();
});

test('same-principal replacement, A/B/A, checkpoint replacement and moved focus retire pending authority', async () => {
  await show();
  await click('next');
  await act(async () =>
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'reader', csrfToken: 'two' }),
  );
  await finish();
  expect(document.activeElement === host.querySelector('[data-release-group-results]')).toBe(false);
  expect(link('retry')).not.toBeNull();
  expect(host.textContent).not.toContain('Current edition');
  expect(host.querySelector('[data-release-group-windows]')!.getAttribute('aria-busy')).toBeNull();
  await click('retry');
  await finish(page('third'));
  const outside = document.createElement('button');
  document.body.append(outside);
  outside.focus();
  expect(document.activeElement).toBe(outside);
  await act(async () => {
    void router.navigate({
      href: releaseSearchHref('en', parseReleaseSearch({ ...raw, q: 'B' }, bundledRelease, 'en').form),
    });
  });
  await finish();
  await act(async () => {
    void router.navigate({ href: releaseSearchHref('en', parseReleaseSearch(raw, bundledRelease, 'en').form) });
  });
  await finish();
  expect(link('previous')).toBeNull();
  await click('next');
  outside.focus();
  await finish(page(null, 'ready', '2026-11-05T00:00:00Z'));
  expect(document.activeElement).toBe(outside);
  expect(link('next')).toBeNull();
  expect(link('previous')).toBeNull();
  outside.remove();
});
