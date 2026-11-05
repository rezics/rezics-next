import { afterAll, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { m } from '../src/paraglide/messages.js';
import { locales } from '../src/paraglide/runtime.js';
import { discoveryExample } from '../src/kernel/fake/search-discovery';
import {
  EmptySearchRecovery,
  emptyRecoveryActionLinks,
  emptyRecoveryAlternativeHref,
} from '../src/search/empty-recovery';
import type { EmptyRecovery } from '../src/search/discovery';
import { searchLoaderDeps, type SearchLoaderDeps } from '../src/search/search-params';
import { SearchResultsRegion, type SearchResultsRegionProps } from '../src/search/search-regions/results';

const { dirname } = await import('node:path');
const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://search.test/en/search?q=prejudise' });
const globals = {
  window, document: window.document, HTMLElement: window.HTMLElement, Node: window.Node,
  requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const { createRoot } = await import('react-dom/client');
const inputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
const edit = (input: HTMLInputElement, value: string) => act(async () => {
  inputSetter.call(input, value);
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
});
const submit = (input: HTMLInputElement) => act(async () => input.form!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })));

afterAll(() => {
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

const realm = '019a1b2c-3d4e-7f00-8a00-5ab1ec700001';
const population = '019a1b2c-3d4e-7f00-8a00-5ab1ec700002';
const state = searchLoaderDeps({
  q: 'prejudise',
  type: 'schema:Book',
  kinds: ['schema:Person', 'catalogue:Atlas'],
  language: ['ja', 'en'],
  sort: 'rating',
  ratingPopulation: population,
  cursor: 'old-cursor+/=',
  filter: JSON.stringify({ and: [{ realm: { id: realm } }, { not: { type: { in: ['schema:Movie'] } } }] }),
  condition: JSON.stringify({ statement: { property: 'schema:inLanguage', in: ['en'] } }),
  'f.schema:genre': ['fiction', 'mystery'],
  'r.schema:datePublished': JSON.stringify({ gte: 1900 }),
});
const labels = {
  typeLabels: { en: 'Book' },
  typeChoices: [{ id: 'schema:Person', labels: { en: 'Person' } }],
  selectedFacetLabels: { 'schema:genre': { fiction: 'Fiction' } },
  groups: [{ property: 'schema:genre', labels: { en: 'Genre' } }],
};
const actions = [
  { kind: 'edit-query' as const },
  { kind: 'remove-type' as const },
  { kind: 'remove-kind' as const, value: 'schema:Person' },
  { kind: 'remove-facet' as const, property: 'schema:genre', value: 'fiction' },
  { kind: 'remove-range' as const, property: 'schema:datePublished' },
];

function stateFromHref(href: string): SearchLoaderDeps {
  const params = new URL(href, 'https://search.test').searchParams;
  const values: Record<string, unknown> = {};
  for (const key of new Set(params.keys())) {
    const items = params.getAll(key);
    values[key] = items.length > 1 ? items : items[0];
  }
  return searchLoaderDeps(values);
}

test('explicit recovery links start a first page and preserve every predicate, scope, population and ordered language', () => {
  const links = emptyRecoveryActionLinks('en', state, actions, labels);
  const byKey = new Map(links.map((link) => [link.key, link]));
  const edited = stateFromHref(byKey.get('edit-query')!.href);
  expect(edited).toMatchObject({ ...state, cursor: undefined });
  expect(byKey.get('edit-query')!.href.endsWith('#empty-recovery-query')).toBe(true);

  const proposed = stateFromHref(emptyRecoveryAlternativeHref('en', state, 'Pride and Prejudice'));
  expect(proposed).toMatchObject({ ...state, query: 'Pride and Prejudice', cursor: undefined });
  const facet = stateFromHref(byKey.get(JSON.stringify(actions[3]))!.href);
  expect(facet).toMatchObject({ ...state, cursor: undefined, facets: { 'schema:genre': ['mystery'] } });
  expect(byKey.get(JSON.stringify(actions[3]))!.href.endsWith('#search-filter-entry')).toBe(true);
  expect(facet.languages).toEqual(['ja', 'en']);
  expect(facet.resourceScope).toEqual(state.resourceScope);
  expect(facet.ratingPopulation).toBe(population);
  expect(facet.condition).toEqual(state.condition);
  expect(facet.ranges).toEqual(state.ranges);
  expect(facet.kinds).toEqual(['schema:Person', 'catalogue:Atlas']);

  const kind = stateFromHref(byKey.get(JSON.stringify(actions[2]))!.href);
  expect(kind.kinds).toEqual(['catalogue:Atlas']);
  expect(kind.facets).toEqual(state.facets);
  const type = stateFromHref(byKey.get('remove-type')!.href);
  expect(type.type).toBeUndefined();
  expect(type.facets).toEqual(state.facets);
  const range = stateFromHref(byKey.get(JSON.stringify(actions[4]))!.href);
  expect(range.ranges).toEqual({});
  expect(range.facets).toEqual(state.facets);
});

test('the mounted empty recovery panel renders its editable query and current actions accessibly in all eight locales', () => {
  for (const locale of locales) {
    const options = { locale };
    const html = renderToStaticMarkup(
      createElement(EmptySearchRecovery, {
        recovery: {
          status: 'ready',
          alternatives: [{ query: 'Pride and Prejudice', label: 'Pride and Prejudice' }],
          actions,
        },
        state,
        locale,
        labels,
      }),
    );
    expect(html).toContain(m.search_empty_recovery_heading({}, options));
    expect(html).toMatch(/aria-labelledby="search-empty-recovery-title-[^"]+"/);
    expect(html).toMatch(/id="empty-recovery-query-[^"]+"/);
    expect(html).toContain('type="search"');
    expect(html).toContain('Pride and Prejudice');
    expect(html).toContain('#search-filter-entry');
    expect(html).toContain(`/${locale}/search`);
    expect(html).not.toContain('Global');
  }

  for (const status of ['preparing', 'unavailable'] as const) {
    const html = renderToStaticMarkup(
      createElement(EmptySearchRecovery, {
        recovery: { status, alternatives: [], actions },
        state,
        locale: 'en',
        labels,
        onRetry() {},
      }),
    );
    expect(html).toContain(
      status === 'preparing' ? m.search_empty_alternatives_preparing() : m.search_empty_alternatives_unavailable(),
    );
    expect(html).toContain(m.search_facet_retry());
    expect(html).not.toContain('Pride and Prejudice');
  }

  const panel = (key: string) => createElement(EmptySearchRecovery, {
    key, recovery: { status: 'ready', alternatives: [], actions }, state, locale: 'en', labels,
  });
  const pair = renderToStaticMarkup(createElement('div', null, panel('a'), panel('b')));
  const ids = [...pair.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
});

function emptyRegionProps(
  executed: SearchLoaderDeps,
  emptyRecovery: EmptyRecovery,
  ownerKey: string,
  onNavigate: (href: string) => void,
  onRetry?: () => PromiseLike<unknown> | void,
  locale = 'en',
): SearchResultsRegionProps {
  const page = { ...discoveryExample, hits: [], next: null, emptyRecovery };
  return {
    query: executed.query,
    locale,
    selectedFacets: executed.facets,
    retryState: executed,
    recoveryOwnerKey: ownerKey,
    onNavigate,
    onRetry,
    data: {
      queryState: executed, discovery: { status: 'ready', page }, recovery: { status: 'ready' },
      typeLabels: labels.typeLabels, typeChoices: labels.typeChoices, selectedFacetLabels: labels.selectedFacetLabels,
      groups: labels.groups.map((group) => ({ ...group, values: [] })),
      hitTypes: {},
      yearProperties: [],
      sort: executed.sort ?? 'relevance',
      facetRetry: false,
      facetIndexNotReady: false,
      staleCursorRestarted: false,
    },
  };
}

test('the mounted result region replaces its owner draft, admits correction, and retires retry completion', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const navigations: string[] = [];
  const navigate = (href: string) => navigations.push(href);
  const first = { ...state, cursor: undefined };
  const recovery = {
    status: 'ready' as const,
    alternatives: [{ query: 'Pride and Prejudice', label: 'Pride and Prejudice' }],
    actions,
  };
  const firstKey = JSON.stringify(['first', 'en', 'reader-one']);
  const second = { ...first, query: 'wrongg', cursor: undefined };
  const secondKey = JSON.stringify(['second', 'en', 'reader-one']);
  const render = (props: SearchResultsRegionProps) => act(async () => root.render(createElement(SearchResultsRegion, props)));
  const input = () => host.querySelector<HTMLInputElement>('input[type="search"]')!;
  try {
    await render(emptyRegionProps(first, recovery, firstKey, navigate));
    await edit(input(), 'stale draft from A');
    await render(emptyRegionProps(first, { ...recovery, alternatives: [] }, firstKey, navigate));
    expect(input().value).toBe(first.query);
    expect(host.textContent).toContain(m.search_empty_no_alternatives());
    const facet = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(
      (link) => link.textContent === m.search_empty_remove_facet({ value: 'Fiction' }),
    )!;
    const removedFacet = stateFromHref(facet.href);
    expect(removedFacet).toMatchObject({ ...first, cursor: undefined, facets: { 'schema:genre': ['mystery'] } });

    const secondProps = emptyRegionProps(second, recovery, secondKey, navigate);
    secondProps.data = { ...secondProps.data!, queryState: { ...second, type: 'schema:Movie', filter: '{"owner":{"id":"unfinished"}}' } };
    await render(secondProps);
    expect(input().value).toBe(second.query);
    await edit(input(), 'x'.repeat(513));
    const apply = host.querySelector<HTMLButtonElement>('[data-query-text-recovery] button[type="submit"]')!;
    apply.focus();
    await submit(input());
    await act(async () => window.happyDOM.waitUntilComplete());
    expect(navigations).toEqual([]);
    expect(input().value).toHaveLength(513);
    expect(host.textContent).toContain(m.search_text_byte_limit({ maximum: 512 }));
    expect(document.activeElement).toBe(input());
    expect([input().selectionStart, input().selectionEnd]).toEqual([512, 513]);

    await edit(input(), 'Pride and Prejudice');
    await submit(input());
    expect(navigations).toHaveLength(1);
    expect(stateFromHref(navigations[0]!)).toMatchObject({ ...second, query: 'Pride and Prejudice', cursor: undefined });

    await edit(input(), 'old locale draft');
    await render(emptyRegionProps(second, recovery, JSON.stringify(['second', 'fr', 'reader-one']), navigate, undefined, 'fr'));
    expect(input().value).toBe(second.query);

    let finishRetry!: () => void;
    const pendingRetry = new Promise<void>((resolve) => (finishRetry = resolve));
    const unavailable = { ...recovery, status: 'unavailable' as const, alternatives: [] };
    const third = { ...second, query: 'current request' };
    const thirdKey = JSON.stringify(['third', 'en', 'reader-one']);
    let retries = 0;
    await render(emptyRegionProps(third, unavailable, thirdKey, navigate, () => (retries++, pendingRetry)));
    const retry = [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === m.search_facet_retry())!;
    await act(async () => { retry.click(); retry.click(); });
    expect(retries).toBe(1);
    expect(retry.disabled).toBe(true);

    const fourthRecovery = { ...recovery, alternatives: [] };
    const fourthKey = JSON.stringify(['third', 'en', 'reader-two']);
    await render(emptyRegionProps(third, fourthRecovery, fourthKey, navigate));
    expect(input().value).toBe('current request');
    await act(async () => finishRetry());
    expect(input().value).toBe('current request');
    expect(host.textContent).not.toContain('Pride and Prejudice');

    const closedProps = emptyRegionProps(third, recovery, fourthKey, navigate);
    closedProps.data = { ...closedProps.data!, recovery: { status: 'closed' } };
    await render(closedProps);
    expect(host.textContent).toContain(m.discovery_closed());
    expect(host.querySelector('[data-query-text-recovery]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});

test('sparse, cursor, incomplete and unavailable result windows never claim a terminal empty population', async () => {
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const executed = { ...state, cursor: undefined };
  const recovery: EmptyRecovery = { status: 'ready', alternatives: [], actions };
  const ownerKey = JSON.stringify(['guard', 'en', null]);
  try {
    const cases = [
      (props: SearchResultsRegionProps) => { props.data!.discovery!.page.next = 'more-results'; },
      (props: SearchResultsRegionProps) => { props.retryState = { ...executed, cursor: 'page-two' }; },
      (props: SearchResultsRegionProps) => { delete props.data!.discovery!.page.emptyRecovery; },
      (props: SearchResultsRegionProps) => { props.data!.recovery = { status: 'unavailable' }; },
    ];
    for (const alter of cases) {
      const props = emptyRegionProps(executed, recovery, ownerKey, () => {});
      alter(props);
      await act(async () => root.render(createElement(SearchResultsRegion, props)));
      expect(host.querySelector('[data-query-text-recovery]')).toBeNull();
    }
    expect(host.textContent).toContain(m.search_reader_results_unavailable());
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
