import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState } from 'react';
import recording from '../src/kernel/recorded/definitions-release.json';
import { discoveryExample } from '../src/kernel/fake/search-discovery';
import {
  characterPersonHref,
  characterPersonRequest,
  parseCharacterPersonSearch,
  type CharacterPersonSearch,
} from '../src/search/character-person';
import { readDiscovery, type DiscoveryState } from '../src/search/discovery';
import { characterPersonSelectionMetadata } from '../src/search/character-person-selection/model';
import * as start from '../.storybook/react-start';

const reads: { search: CharacterPersonSearch; signal: AbortSignal; finish(state?: DiscoveryState): void }[] = [];
const ready: DiscoveryState = {
  status: 'ready',
  page: { hits: [], kinds: { values: [], next: null }, next: 'next', as_of: 'cut-one' },
};
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('../src/search/character-person-selection/server', () => ({
  readCharacterPersonSelectionMetadata: async () =>
    characterPersonSelectionMetadata({ ...recording.release, digest: 'release' }),
}));
mock.module('../src/search/character-person-window-server', () => ({
  readCharacterPerson: ({ data, signal }: { data: { search: CharacterPersonSearch }; signal: AbortSignal }) =>
    new Promise((resolve) =>
      reads.push({
        search: data.search,
        signal,
        finish: (discovery = ready) => resolve({ discovery, restarted: false }), // Deliberately ignores cancellation.
      }),
    ),
}));
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://search.test/en/search/characters' });
window.scrollTo = () => undefined;
const globals = {
  window,
  document: window.document,
  Element: window.Element,
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
const { createBrowserHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, defaultParseSearch } =
  await import('@tanstack/react-router');
const { CharacterPersonSearchPage } = await import('../src/search/character-person-search');
const { sessionQuery } = await import('../src/session/query');
const { setLocale, deLocalizeUrl, localizeUrl } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
notifyManager.setScheduler((callback) => callback());
const host = document.createElement('div');
document.body.append(host);
let root: ReturnType<typeof createRoot>;
let client: InstanceType<typeof QueryClient>;
let router: ReturnType<typeof createRouter>;
let pageLocale = 'en';
let refreshRoute = () => {};
let lastNavigationHref: string | undefined;
const originalFetch = globalThis.fetch;
const work = '018f0000-0000-7000-8000-00a000000001';
const role = '018f0000-0000-7000-8000-00a000000003';
const operand = (mode = 'people') =>
  parseCharacterPersonSearch(
    {
      mode,
      name: 'Aki',
      work: [work],
      ...(mode === 'people' ? { role } : {}),
      language: ['ja', 'en'],
      threshold: '2',
      sort: 'relevance',
    },
    'en',
  );
async function finish(state: DiscoveryState = ready) {
  await act(async () => reads.at(-1)!.finish(state));
}
async function navigate(href: string) {
  await act(async () => {
    await router.navigate({ href });
  });
}
async function activateWindow(action: string, duplicate = false) {
  const link = host.querySelector<HTMLAnchorElement>(`[data-window-action="${action}"]`)!;
  await act(async () => {
    link.focus();
    link.click();
    if (duplicate) link.click();
  });
}
async function show(href = characterPersonHref('en', operand().search)) {
  reads.length = 0;
  pageLocale = 'en';
  lastNavigationHref = undefined;
  setLocale('en', { reload: false });
  window.history.replaceState({}, '', href);
  globalThis.fetch = (async (input) => {
    const id = new URL(String(input), 'https://search.test').searchParams.get('id');
    return Response.json({
      state: 'ready',
      id,
      labels: { en: 'Resolved operand' },
      type: id === role ? 'skos:Concept' : 'schema:Book',
      typeLabels: { en: 'Type' },
    });
  }) as typeof fetch;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: work, csrfToken: 'one' });
  const parent = createRootRoute({ component: Outlet });
  const route = createRoute({
    getParentRoute: () => parent,
    path: '/search/characters',
    validateSearch: (raw) => raw,
    component: () => {
      const [, setRevision] = useState(0);
      refreshRoute = () => setRevision((revision) => revision + 1);
      const raw = route.useSearch();
      const parsed = parseCharacterPersonSearch(raw, pageLocale);
      return (
        <CharacterPersonSearchPage
          key={JSON.stringify([pageLocale, parsed.form, parsed.error])}
          locale={pageLocale}
          parsed={parsed}
          principal={work}
        />
      );
    },
  });
  const subject = createRoute({
    getParentRoute: () => parent,
    path: '/subjects/$id/$slug',
    component: () => <p>Native subject</p>,
  });
  router = createRouter({
    routeTree: parent.addChildren([route, subject]),
    history: createBrowserHistory({ window: window as unknown as globalThis.Window }),
    rewrite: { input: ({ url }) => deLocalizeUrl(url).href, output: ({ url }) => localizeUrl(url).href },
    defaultViewTransition: false,
  });
  router.subscribe('onBeforeNavigate', ({ toLocation }) => {
    lastNavigationHref = toLocation.publicHref;
  });
  await router.load();
  root = createRoot(host);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    ),
  );
}
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  client?.clear();
  host.replaceChildren();
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  window.happyDOM.abort();
  mock.restore();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test.each(['people', 'characters'])(
  'one fresh native read preserves %s operands through Continue, Previous, First and browser return',
  async (mode) => {
    const parsed = operand(mode);
    await show(characterPersonHref('en', parsed.search));
    expect(reads).toHaveLength(1);
    await finish();
    const next = host.querySelector<HTMLAnchorElement>('[data-window-action="next"]')!;
    const target = parseCharacterPersonSearch(defaultParseSearch(new URL(next.href).search), 'en');
    expect(target.search).toEqual({ ...parsed.search, cursor: 'next' });
    await activateWindow('next');
    expect(reads).toHaveLength(2);
    await finish({ ...ready, page: { ...ready.page, next: null } });
    expect(host.textContent).toContain(m.search_window_address({}, { locale: 'en' }));
    const previous = host.querySelector<HTMLAnchorElement>('[data-window-action="previous"]');
    expect(previous?.href ?? JSON.stringify({ state: window.history.state, lastNavigationHref })).toBe(
      `https://search.test${characterPersonHref('en', parsed.search)}`,
    );
    await activateWindow('previous');
    expect(reads).toHaveLength(3);
    expect(reads.at(-1)!.search).toEqual(parsed.search);
    await finish();
    const continueAgain = host.querySelector<HTMLAnchorElement>('[data-window-action="next"]')!;
    expect(continueAgain.getAttribute('href')).toBe(characterPersonHref('en', parsed.search, 'next'));
    await activateWindow('next');
    expect(reads).toHaveLength(4);
    await finish({ ...ready, page: { ...ready.page, next: null } });
    const first = host.querySelector<HTMLAnchorElement>('[data-window-action="first"]')!;
    expect(first.getAttribute('href')).toBe(characterPersonHref('en', parsed.search));
    await activateWindow('first');
    expect(reads).toHaveLength(5);
    expect(reads.at(-1)!.search).toEqual(parsed.search);
    const native = await readDiscovery(characterPersonRequest(parsed.search), async () => ({
      status: 200,
      data: { ...discoveryExample, hits: discoveryExample.hits.slice(0, 1) },
    }));
    await finish(native.discovery);
    await navigate(host.querySelector<HTMLAnchorElement>('a[href*="/subjects/"]')!.getAttribute('href')!);
    await act(async () => {
      router.history.back();
      await window.happyDOM.whenAsyncComplete();
    });
    expect(reads).toHaveLength(6);
    expect(host.querySelector('[data-slot="discovery-results"]')).toBeNull();
    expect(reads.at(-1)!.search).toEqual(parsed.search);
    await finish();
  },
);

test('failed forward reads hide old rows and keep the admitted Previous address available', async () => {
  await show();
  await finish({ ...ready, page: { ...ready.page, hits: [discoveryExample.hits[0]!], next: 'next' } });
  await activateWindow('next');
  expect(reads).toHaveLength(2);
  await finish({ status: 'unavailable' });
  expect(host.querySelector('[data-character-person-results] [data-slot="discovery-results"]')).toBeNull();
  const previous = host.querySelector<HTMLAnchorElement>('[data-window-action="previous"]');
  expect(previous?.href ?? JSON.stringify({ state: window.history.state, lastNavigationHref })).toBe(
    `https://search.test${characterPersonHref('en', operand().search)}`,
  );
  await activateWindow('previous');
  expect(reads).toHaveLength(3);
  expect(reads.at(-1)!.search).toEqual(operand().search);
  await finish();
});

test('request A/B/A and locale replacement start fresh reads for the current address', async () => {
  const searchA = operand().search;
  const searchB = operand('characters').search;
  await show(characterPersonHref('en', searchA));
  await finish();
  await navigate(characterPersonHref('en', searchB));
  expect(reads).toHaveLength(2);
  expect(reads.at(-1)!.search).toEqual(searchB);
  await finish();
  await act(async () => {
    router.history.back();
    await window.happyDOM.whenAsyncComplete();
  });
  expect(reads).toHaveLength(3);
  expect(reads.at(-1)!.search).toEqual(searchA);
  await finish();

  pageLocale = 'de';
  await act(async () => {
    setLocale('de', { reload: false });
    refreshRoute();
  });
  expect(reads).toHaveLength(4);
  expect(reads.at(-1)!.search).toEqual(searchA);
  await finish();
});

test('checkpoint changes retire prior Previous history and focus recovery', async () => {
  await show();
  await finish({ ...ready, page: { ...ready.page, as_of: 'cut-one' } });
  await activateWindow('next', true);
  expect(reads).toHaveLength(2);
  await finish({ status: 'ready', page: { ...ready.page, as_of: 'cut-two', next: null } });
  expect(host.querySelector('[data-window-action="previous"]')).toBeNull();
  expect(host.querySelector('[data-window-action="first"]')).not.toBeNull();
  expect(document.activeElement).not.toBe(host.querySelector('[data-character-person-results]'));
});

test('focus remains with the reader after focus moves during an activated navigation', async () => {
  await show();
  await finish();
  const elsewhere = host.querySelector<HTMLInputElement>('input[name="name"]')!;
  await activateWindow('next');
  expect(reads).toHaveLength(2);
  elsewhere.focus();
  await finish();
  expect(document.activeElement).toBe(elsewhere);
});

test('opaque sparse, terminal, preparing, failed and restart windows stay distinct and retry deduplicates', async () => {
  await show(characterPersonHref('en', operand().search, 'opaque'));
  await finish();
  expect(host.textContent).toContain(m.character_person_page_empty({}, { locale: 'en' }));
  expect(host.textContent).not.toContain(m.search_no_results({}, { locale: 'en' }));
  expect(host.querySelector('[data-window-action="previous"]')).toBeNull();
  for (const status of ['preparing', 'unavailable', 'restart'] as const) {
    await navigate(characterPersonHref('en', operand().search, status));
    await finish({ status });
    const restart = host.querySelector<HTMLAnchorElement>('[data-discovery-restart]');
    expect(!!restart).toBe(status === 'restart');
    expect(host.querySelector('[data-character-person-results]')!.getAttribute('data-search-recovery')).toBe(status);
    if (status !== 'restart') {
      const retry = host.querySelector<HTMLButtonElement>('[data-character-person-results] button')!;
      const before = reads.length;
      await act(async () => {
        retry.click();
        retry.click();
      });
      expect(reads).toHaveLength(before + 1);
      expect(reads.at(-1)!.search.cursor).toBe(status);
      await finish({ status: 'ready', page: { ...ready.page, next: null } });
      expect(host.textContent).toContain(m.search_no_results({}, { locale: 'en' }));
    }
  }
});

test('equal-principal replacement aborts the old read and ignores its late completion', async () => {
  await show();
  const old = reads[0]!;
  await act(async () =>
    client.setQueryData(sessionQuery.queryKey, { state: 'signed-in', subject: work, csrfToken: 'two' }),
  );
  expect(old.signal.aborted).toBe(true);
  expect(reads).toHaveLength(2);
  await act(async () => old.finish({ status: 'denied' }));
  expect(host.querySelector('[data-search-recovery="denied"]')).toBeNull();
  await finish();
  expect(host.querySelector('[data-window-action="next"]')).not.toBeNull();
});
