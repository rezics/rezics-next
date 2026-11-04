import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { queryOptions, QueryClient, QueryClientProvider, notifyManager } from '@tanstack/react-query';
import * as start from '../.storybook/react-start';
import type { SearchPageData } from '../src/search/search';
import type { SearchLoaderDeps } from '../src/search/search-params';
import { searchSessionLifetime } from '../src/search/scoped-search-lifetime';
import { qualifiedSearchExample } from '../src/search/work-context/examples';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
const reads: { params: SearchLoaderDeps; resolve: (value: SearchPageData) => void; signal: AbortSignal }[] = [];
mock.module('../src/search/search-queries', () => ({
  searchQueryOptions: (locale: string, params: SearchLoaderDeps, reader?: string) =>
    queryOptions({
      queryKey: ['search', 'discovery-v1', searchSessionLifetime(locale, params, reader)],
      retry: false,
      staleTime: 0,
      refetchOnMount: false,
      queryFn: ({ signal }) =>
        new Promise<SearchPageData>((resolve) => {
          reads.push({ params, resolve, signal });
        }),
    }),
}));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://search.test/en/search?q=Echo' });
window.scrollTo = () => undefined;
const globals = {
  window,
  document: window.document,
  HTMLElement: window.HTMLElement,
  Node: window.Node,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const { useSearchQuery } = await import('../src/search/use-search-query');
const { useDiscoveryPersonalResults } = await import('../src/search/discovery-personal-host');
const { DiscoveryResults } = await import('../src/search/discovery-results');
const { sessionQuery } = await import('../src/session/query');
notifyManager.setScheduler((callback) => callback());
let client: QueryClient;
let root: ReturnType<typeof createRoot> | undefined;
let element: HTMLElement;
let active: ReturnType<typeof useSearchQuery>;
let display: ReturnType<typeof useDiscoveryPersonalResults>;
const params = (query = 'Echo', cursor?: string): SearchLoaderDeps => ({
  query,
  facets: {},
  type: undefined,
  sort: undefined,
  cursor,
});
function Pane({ state }: { state: SearchLoaderDeps }) {
  active = useSearchQuery('en', state);
  display = useDiscoveryPersonalResults({
    source: active.data.discovery,
    publicEntry: active.publicEntry,
    request: {
      representation: 'discovery-v1',
      languages: ['en'],
      text: state.query,
      ...(state.cursor ? { cursor: state.cursor } : {}),
    },
    locale: 'en',
    returnTo: `/en/search?q=${state.query}${state.cursor ? `&cursor=${state.cursor}` : ''}`,
    enabled: true,
  });
  return (
    <div ref={display.regionRef}>{display.state ? <DiscoveryResults state={display.state} locale="en" /> : null}</div>
  );
}
async function show(state: SearchLoaderDeps) {
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <Pane state={state} />
      </QueryClientProvider>,
    );
  });
}
async function settle(index: number, title = 'Echo') {
  const discovery = qualifiedSearchExample();
  for (const hit of discovery.page.hits)
    if (hit.summary.kind === 'subject') {
      hit.summary.value.label = { value: title, language: 'en' };
      if ('labels' in hit) hit.labels = { en: title };
    }
  await act(async () => {
    reads[index]!.resolve({ discovery, queryState: reads[index]!.params, recovery: { status: 'ready' } });
  });
}
function setup() {
  reads.length = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
}
afterEach(async () => {
  await act(async () => root?.unmount());
  client?.clear();
  element?.remove();
});
afterAll(() => {
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  mock.restore();
  window.happyDOM.abort();
});

test('query A/B/A retires delayed responses and selected callbacks, including equal successful replacement', async () => {
  setup();
  await show(params());
  await settle(0);
  const old = display.isCurrent;
  const entry = active.publicEntry;
  const key = ['search', 'discovery-v1', searchSessionLifetime('en', params())];
  await act(async () => {
    client.setQueryData(key, client.getQueryData(key));
  });
  expect(entry.isCurrent()).toBe(false);
  expect(old()).toBe(false);
  await show(params('Other'));
  expect(element.textContent).not.toContain('Mira Chen');
  await show(params());
  await show(params('Third'));
  const delayed = reads.length - 1;
  await show(params('Fourth'));
  expect(reads[delayed]!.signal.aborted).toBe(true);
  await settle(delayed, 'Delayed third query');
  expect(element.textContent).not.toContain('Delayed third query');
  expect(old()).toBe(false);
});

test('pagination exact-cursor recovery retries the failed address while old-reader data stays retired after A/B/A', async () => {
  setup();
  await show(params());
  await settle(0);
  const old = display.isCurrent;
  await show(params('Echo', 'native-next'));
  const cursorRead = reads.length - 1;
  await act(async () => {
    reads[cursorRead]!.resolve({ queryState: reads[cursorRead]!.params, recovery: { status: 'unavailable' } });
  });
  expect(active.data.queryState?.cursor).toBe('native-next');
  await act(async () => active.retry());
  expect(reads.at(-1)!.params.cursor).toBe('native-next');
  await settle(reads.length - 1);
  const before = display.isCurrent;
  await act(async () => {
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: 'reader-b', csrfToken: 'credential-b' });
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-out', subject: null, csrfToken: null });
  });
  expect(before()).toBe(false);
  expect(old()).toBe(false);
  expect(element.querySelector('[data-slot="search-work-context"]')).toBeNull();
});
