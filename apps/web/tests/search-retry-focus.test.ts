import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { discoveryExample } from '../src/kernel/fake/search-discovery';
import type { SearchPageData } from '../src/search/search';
import type { DiscoveryState } from '../src/search/discovery';
import type { SearchRecoveryState } from '../src/search/search-recovery';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://search.test/en/search?q=Mira' });
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
const { SearchPage } = await import('../src/search/search');
const { searchRetryFocusTarget } = await import('../src/search/search-retry-focus');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
const require = createRequire(import.meta.url);
const storybook = createRequire(require.resolve('storybook/test'));
const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
const user = userEvent.setup({ document: window.document });
const host = document.createElement('main');
document.body.append(host);
let root: ReturnType<typeof createRoot>;
const emptyDiscovery: DiscoveryState = {
  status: 'ready',
  page: { hits: [], kinds: { values: [], next: null }, next: null, as_of: discoveryExample.as_of },
};
const readyDiscovery: DiscoveryState = { status: 'ready', page: discoveryExample };

function page(recovery: SearchRecoveryState, discovery?: DiscoveryState, query = 'Mira'): SearchPageData {
  return {
    queryState: { query, facets: {} },
    recovery,
    ...(discovery ? { discovery } : {}),
    hitTypes: {},
    yearProperties: [],
    typeChoices: [],
    groups: [],
    selectedFacets: {},
    selectedFacetLabels: {},
    facetsAvailable: false,
    facetRetry: false,
    facetIndexNotReady: false,
    staleCursorRestarted: false,
    sort: 'relevance',
  };
}

async function show(data: SearchPageData, extra?: { query?: string; session?: string | null }) {
  root ??= createRoot(host);
  const query = extra?.query ?? data.queryState?.query ?? 'Mira';
  await act(async () =>
    root.render(
      createElement(
        'div',
        null,
        createElement('button', { type: 'button', 'data-move-focus': true }, 'Other control'),
        createElement(SearchPage, {
          query,
          data,
          onRetry() {},
          session: extra?.session ?? null,
        }),
      ),
    ),
  );
}

function retry() {
  return [...host.querySelectorAll('button')].find((button) => button.textContent === m.search_facet_retry());
}

function region() {
  return host.querySelector<HTMLElement>('[data-search-results]')!;
}

async function activate(value: HTMLButtonElement) {
  value.focus();
  expect(document.activeElement).toBe(value);
  await act(async () => user.keyboard('{Enter}'));
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

test('keyboard result Retry restores the current region or surviving action without stealing focus', async () => {
  setLocale('en', { reload: false });
  await show(page({ status: 'unavailable' }));
  await activate(retry()!);
  await show(page({ status: 'loading' }));
  expect(host.querySelector('[data-search-recovery="loading"]')).not.toBeNull();
  expect(retry()).toBeUndefined();
  await show(page({ status: 'ready' }, readyDiscovery));
  expect(document.activeElement).toBe(region());
  expect(host.querySelector('[data-slot="discovery-results"]')).not.toBeNull();

  await show(page({ status: 'unavailable' }));
  await activate(retry()!);
  await show(page({ status: 'loading' }));
  await show(page({ status: 'ready' }, emptyDiscovery));
  expect(region().getAttribute('aria-label')).toBe(m.search_results());
  expect(document.activeElement).toBe(region());
  expect(host.textContent).toContain(m.search_no_results());

  await show(page({ status: 'unavailable' }));
  await activate(retry()!);
  await show(page({ status: 'loading' }));
  await show(page({ status: 'unavailable' }));
  expect(document.activeElement).toBe(retry());

  await activate(retry()!);
  await show(page({ status: 'loading' }));
  const elsewhere = host.querySelector<HTMLButtonElement>('[data-move-focus]')!;
  elsewhere.focus();
  await show(page({ status: 'ready' }, readyDiscovery));
  expect(document.activeElement).toBe(elsewhere);
});

test('retired query, session and unmounted retries do not move focus', async () => {
  setLocale('en', { reload: false });
  await show(page({ status: 'unavailable' }), { session: 'one' });
  await activate(retry()!);
  await show(page({ status: 'loading' }), { session: 'one' });
  await show(page({ status: 'ready' }, readyDiscovery, 'Later'), { query: 'Later', session: 'one' });
  expect(document.activeElement).not.toBe(region());

  await show(page({ status: 'unavailable' }), { session: 'one' });
  await activate(retry()!);
  await show(page({ status: 'loading' }), { session: 'one' });
  await show(page({ status: 'ready' }, readyDiscovery), { session: 'two' });
  expect(document.activeElement).not.toBe(region());

  await show(page({ status: 'unavailable' }));
  await activate(retry()!);
  await act(async () => root.unmount());
  root = undefined!;
  expect(host.querySelector('[data-search-results]')).toBeNull();
});

test('a settled retry restores only the same owner while the reader stayed', () => {
  const source = document.createElement('button');
  const retryButton = document.createElement('button');
  const results = document.createElement('section');
  document.body.append(source, retryButton, results);
  const owner = { scope: JSON.stringify({ query: 'Mira', facets: {} }), locale: 'en', session: 'one' };
  const pending = { owner, source, moved: false };
  const args = { pending, current: owner, settled: true, active: source, retry: retryButton, region: results };
  expect(searchRetryFocusTarget(args)).toBe(retryButton);
  expect(searchRetryFocusTarget({ ...args, current: { ...owner, locale: 'zh-Hans' } })).toBeNull();
  expect(searchRetryFocusTarget({ ...args, current: { ...owner, session: 'two' } })).toBeNull();
  expect(searchRetryFocusTarget({ ...args, pending: { ...pending, moved: true } })).toBeNull();
  expect(searchRetryFocusTarget({ ...args, active: results })).toBeNull();
  retryButton.remove();
  expect(searchRetryFocusTarget({ ...args, retry: retryButton })).toBe(results);
  source.remove();
  results.remove();
});
