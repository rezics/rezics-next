import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { m } from '../src/paraglide/messages.js';
import { locales } from '../src/paraglide/runtime.js';
import {
  EmptySearchRecovery,
  emptyRecoveryActionLinks,
  emptyRecoveryAlternativeHref,
} from '../src/search/empty-recovery';
import { searchLoaderDeps, type SearchLoaderDeps } from '../src/search/search-params';

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
  selectedFacetLabels: { 'schema:genre': { fiction: { text: 'Fiction' } } },
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
    expect(html).toContain('aria-labelledby="search-empty-recovery-title"');
    expect(html).toContain('id="empty-recovery-query"');
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
    expect(html).toContain('id="empty-recovery-query"');
    expect(html).toContain(m.search_facet_retry());
    expect(html).not.toContain('Pride and Prejudice');
  }
});
