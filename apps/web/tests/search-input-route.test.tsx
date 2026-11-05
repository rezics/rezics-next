import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { queryOptions } from '@tanstack/react-query';
import { act } from 'react';
import * as start from '../.storybook/react-start';
import type { SearchLoaderDeps } from '../src/search/search-params';
import { searchSessionLifetime } from '../src/search/scoped-search-lifetime';
import { searchUnavailablePage } from '../src/search/search-recovery';
import type { BrowserSession } from '../src/session/browser-state';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);

const reads: SearchLoaderDeps[] = [];
mock.module('../src/search/search-queries', () => ({
  searchQueryOptions: (locale: string, params: SearchLoaderDeps, reader?: string) =>
    queryOptions({
      queryKey: ['search', 'intake-test', searchSessionLifetime(locale, params, reader)],
      queryFn: () => {
        reads.push(params);
        return Promise.resolve(searchUnavailablePage(params));
      },
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
const window = new Window({ url: 'https://search.test/search' });
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

const unavailable = searchUnavailablePage({
  query: '',
  type: undefined,
  facets: {},
  cursor: undefined,
  sort: undefined,
});
const signedOut: BrowserSession = { state: 'signed-out', subject: null, csrfToken: null };
const host = document.createElement('main');
const outside = document.createElement('button');
outside.textContent = 'Outside Search';
document.body.append(host, outside);
let root: ReturnType<typeof createRoot>;

async function mount(path: string) {
  reads.length = 0;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, signedOut);
  const parent = createRootRouteWithContext<{ queryClient: InstanceType<typeof QueryClient> }>()({ component: Outlet });
  Route.update({ id: '/search', path: '/search', getParentRoute: () => parent, head: () => ({}) } as never);
  const router = createRouter({
    routeTree: parent.addChildren([Route]),
    context: { queryClient: client },
    history: createMemoryHistory({ initialEntries: [path] }),
    defaultPendingMs: 0,
    defaultPendingMinMs: 0,
  });
  await router.load();
  root ??= createRoot(host);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await Promise.resolve();
  });
  return router;
}

async function replaceValue(article: Element, value: string) {
  const input = article.querySelector<HTMLTextAreaElement>('textarea')!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  const apply = [...article.querySelectorAll('button')].find(
    (button) => button.textContent === m.search_input_recovery_apply(),
  )!;
  await act(async () => user.click(apply));
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await window.happyDOM.waitUntilComplete();
  });
}

async function removeIssue(key: string) {
  const article = host.querySelector(`[data-search-input-key="${key}"]`)!;
  const button = [...article.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === m.search_input_restart_first_window(),
  )!;
  await act(async () => user.click(button));
  await act(async () => {
    await Promise.resolve();
  });
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined!;
  host.replaceChildren();
  outside.blur();
  setLocale('en', { reload: false });
});

afterAll(() => {
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('the mounted Search route retains multiple errors and a protected filter through correction, Back and reload', async () => {
  setLocale('en', { reload: false });
  const params = new URLSearchParams();
  params.append('language', 'ja');
  params.append('language', 'bad_tag');
  params.append('language', 'zh-Hant');
  params.append('kinds', 'schema:Book');
  params.append('kinds', 'catalogue:Atlas');
  params.append('f.schema:genre', 'mystery');
  params.append('f.schema:genre', 'mystery');
  params.set('sort', 'popular');
  params.set('cursor', 'opaque'.repeat(900));
  params.set('condition', '{bad json');
  params.set(
    'filter',
    JSON.stringify({
      and: [
        { realm: { id: '018f0000-0000-7000-8000-00a000000001' } },
        { statement: { property: 'schema:genre', in: ['fantasy'] } },
      ],
    }),
  );
  const initial = `/search?${params.toString()}`;
  let router = await mount(initial);
  expect(reads).toHaveLength(0);
  expect(host.textContent).toContain('Language preferences');
  expect(host.textContent).toContain('Order');
  expect(host.textContent).toContain('Condition');
  expect(host.textContent).not.toContain('Protected filter');
  expect(router.state.location.search.filter).toEqual({
    and: [
      { realm: { id: '018f0000-0000-7000-8000-00a000000001' } },
      { statement: { property: 'schema:genre', in: ['fantasy'] } },
    ],
  });
  expect(document.activeElement).not.toBe(host.querySelector('[data-search-input-first] textarea'));

  const languageIssue = host.querySelector('[data-search-input-key="language"][data-search-input-occurrence="1"]')!;
  await replaceValue(languageIssue, 'fr');
  expect(reads).toHaveLength(0);
  expect(router.state.location.search.language).toEqual(['ja', 'fr', 'zh-Hant']);
  expect(router.state.location.search.kinds).toEqual(['schema:Book', 'catalogue:Atlas']);
  expect(router.state.location.search['f.schema:genre']).toEqual(['mystery', 'mystery']);
  expect(router.state.location.search.filter).toEqual({
    and: [
      { realm: { id: '018f0000-0000-7000-8000-00a000000001' } },
      { statement: { property: 'schema:genre', in: ['fantasy'] } },
    ],
  });
  const firstRemainingInput = host.querySelector('[data-search-input-first] textarea');
  expect(document.activeElement === firstRemainingInput).toBe(true);
  expect(router.state.location.search.cursor).toBeUndefined();

  router.history.back();
  await act(async () => {
    await router.load();
    await Promise.resolve();
  });
  const returnedLanguage = host.querySelector('[data-search-input-key="language"][data-search-input-occurrence="1"] textarea')!;
  expect(returnedLanguage.value).toBe('bad_tag');
  expect(document.activeElement !== returnedLanguage).toBe(true);
  expect(reads).toHaveLength(0);

  await removeIssue('cursor');
  const languageAgain = host.querySelector('[data-search-input-key="language"][data-search-input-occurrence="1"]')!;
  await replaceValue(languageAgain, 'zh-CN');
  const orderIssue = host.querySelector('[data-search-input-key="sort"]')!;
  await replaceValue(orderIssue, 'rating');
  const conditionIssue = host.querySelector('[data-search-input-key="condition"]')!;
  await replaceValue(conditionIssue, JSON.stringify({ statement: { property: 'schema:genre', in: ['mystery'] } }));
  expect(host.querySelector('[data-search-input-recovery]')).toBeNull();
  expect(reads).toHaveLength(1);
  expect(reads[0]?.languages).toEqual(['ja', 'zh-CN', 'zh-Hant']);
  expect(reads[0]?.kinds).toEqual(['schema:Book', 'catalogue:Atlas']);
  expect(reads[0]?.facets['schema:genre']).toEqual(['mystery', 'mystery']);
  expect(reads[0]?.resourceScope).toEqual({ kind: 'realm', id: '018f0000-0000-7000-8000-00a000000001' });

  const repairedAddress = router.state.location.publicHref;
  await act(async () => root!.unmount());
  root = undefined!;
  host.replaceChildren();
  router = await mount(repairedAddress);
  expect(reads).toHaveLength(1);
  expect(host.querySelector('[data-search-input-recovery]')).toBeNull();
});

test('over-budget visits hide the submitted payload and offer only an explicit request restart', async () => {
  setLocale('en', { reload: false });
  const payload = 'payload-secret-'.repeat(9000);
  await mount(`/search?q=${encodeURIComponent(payload)}`);
  expect(reads).toHaveLength(0);
  expect(host.textContent).toContain('longer than Search can safely inspect');
  expect(host.textContent).not.toContain('payload-secret');
  const restart = host.querySelector<HTMLButtonElement>('[data-search-input-restart]')!;
  await act(async () => user.click(restart));
  await act(async () => {
    await Promise.resolve();
  });
  expect(reads).toHaveLength(1);
  expect(host.querySelector('[data-search-input-recovery]')).toBeNull();
});
