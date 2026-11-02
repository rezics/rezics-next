import { afterAll, afterEach, expect, mock, test } from 'bun:test';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { discoveryExample } from '../src/kernel/fake/search-discovery';
import type { SearchPageData } from '../src/search/search';
import type { SearchLoaderDeps } from '../src/search/search-params';
import { searchRetryOwnerCurrent, type SearchRetryOwner } from '../src/search/search-retry-focus';

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
const { setLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');
const require = createRequire(import.meta.url);
const storybook = createRequire(require.resolve('storybook/test'));
const { default: userEvent } = await import(storybook.resolve('@testing-library/user-event'));
const user = userEvent.setup({ document: window.document });
const host = document.createElement('main');
document.body.append(host);
let root: ReturnType<typeof createRoot>;

function owner(state: SearchLoaderDeps, locale = 'en', session: string | null = 'one'): SearchRetryOwner {
  return { scope: JSON.stringify(state), locale, session };
}

const results: SearchLoaderDeps = { query: 'Mira', type: undefined, facets: {}, cursor: undefined, sort: undefined };
const empty: SearchLoaderDeps = { query: '', type: undefined, facets: {}, cursor: undefined, sort: undefined };
const replacements: SearchLoaderDeps[] = [
  { ...results, type: 'schema:Book' },
  { ...results, kinds: ['work'] },
  { ...results, facets: { type: ['schema:Book'] } },
  { ...results, ranges: { 'schema:datePublished': { gte: 1900 } } },
  { ...results, languages: ['ja', 'en'] },
  { ...results, condition: { type: { in: ['schema:Book'] } } },
  { ...results, sort: 'rating' },
  { ...results, cursor: 'page-2' },
];

function page(queryState: SearchLoaderDeps, status: 'unavailable' | 'loading' | 'ready'): SearchPageData {
  return {
    queryState,
    recovery: { status },
    ...(status === 'ready'
      ? {
          discovery: {
            status: 'ready',
            page: { hits: [], kinds: { values: [], next: null }, next: null, as_of: discoveryExample.as_of },
          },
        }
      : {}),
    hitTypes: {},
    yearProperties: [],
    typeChoices: [],
    groups: [],
    selectedFacets: queryState.facets,
    selectedFacetLabels: {},
    facetsAvailable: false,
    facetRetry: false,
    facetIndexNotReady: false,
    staleCursorRestarted: false,
    sort: queryState.sort === 'rating' ? 'rating' : 'relevance',
  };
}

async function show(data: SearchPageData) {
  root ??= createRoot(host);
  await act(async () =>
    root.render(
      createElement(SearchPage, {
        query: data.queryState?.query ?? 'Mira',
        data,
        onRetry() {},
        session: null,
      }),
    ),
  );
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

test('canonical committed scope stays the same owner; Type, kinds, facets, ranges, languages, condition, sort, cursor or Realm does not', () => {
  const pending = owner(results);
  expect(searchRetryOwnerCurrent(pending, owner({ ...results }))).toBe(true);
  for (const state of replacements) expect(searchRetryOwnerCurrent(pending, owner(state))).toBe(false);
  expect(
    searchRetryOwnerCurrent(
      owner({ ...results, languages: ['ja', 'en'] }),
      owner({ ...results, languages: ['en', 'ja'] }),
    ),
  ).toBe(false);
  expect(searchRetryOwnerCurrent(owner(empty), owner({ ...empty, type: 'schema:Book' }))).toBe(false);
});

test('a same-query sort replacement during loading does not recover the old Retry focus', async () => {
  setLocale('en', { reload: false });
  await show(page(results, 'unavailable'));
  const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === m.search_facet_retry())!;
  retry.focus();
  expect(document.activeElement).toBe(retry);
  await act(async () => user.keyboard('{Enter}'));
  await show(page(results, 'loading'));
  await show(page({ ...results, sort: 'rating' }, 'ready'));
  expect(document.activeElement).not.toBe(host.querySelector('[data-search-results]'));
});
