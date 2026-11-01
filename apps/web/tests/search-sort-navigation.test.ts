import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as v from 'valibot';
import { searchLoaderDeps, searchParams, type SearchLoaderDeps } from '../src/search/search-params';
import { searchSortHref, SearchSort } from '../src/search/sort';
import { m } from '../src/paraglide/messages.js';

const state: SearchLoaderDeps = {
  query: '  "Mira" | 星 -old + / =  ',
  type: 'schema:Book',
  kinds: ['schema:Book', 'catalogue:Atlas'],
  languages: ['ja', 'en'],
  filter: ' {"not":{"type":{"in":["schema:Movie"]}}} ',
  condition: { statement: { property: 'schema:author', in: ['mira'] } },
  ranges: { 'schema:datePublished': { gte: 1900, lte: 2026 } },
  facets: { 'schema:genre': ['fiction', 'science + / ='], 'schema:keywords': ['星'] },
  cursor: '+/='.repeat(1621) + 'x',
  sort: undefined,
};

function restored(href: string) {
  const url = new URL(href, 'https://rezics.local');
  const search: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const values = url.searchParams.getAll(key);
    search[key] = values.length === 1 ? values[0]! : values;
  }
  return { url, state: searchLoaderDeps(v.parse(searchParams, search)) };
}

test('changing Search sort preserves the complete submitted query and filters and drops only the old hit cursor', () => {
  const original = structuredClone(state);
  for (const locale of ['en', 'zh-Hant']) {
    const rating = restored(searchSortHref(locale, state, 'rating'));
    expect(rating.url.pathname).toBe(`/${locale}/search`);
    expect(rating.url.searchParams.has('cursor')).toBe(false);
    expect(rating.state).toEqual({ ...state, cursor: undefined, sort: 'rating' });
    expect(rating.url.searchParams.get('filter')).toBe(state.filter!);
    expect(rating.url.searchParams.getAll('kinds')).toEqual(state.kinds!);
    expect(rating.url.searchParams.getAll('language')).toEqual(state.languages!);

    const relevance = restored(searchSortHref(locale, { ...rating.state, cursor: 'new-hits+/=' }, 'relevance'));
    expect(relevance.url.searchParams.has('sort')).toBe(false);
    expect(relevance.url.searchParams.has('cursor')).toBe(false);
    expect(relevance.state).toEqual({ ...state, cursor: undefined });
  }
  expect(state).toEqual(original);
});

test('sort keeps an ordinary localized GET form with all supported inputs and no hit cursor', () => {
  const html = renderToStaticMarkup(
    createElement(SearchSort, {
      sort: 'rating',
      locale: 'zh-Hant',
      query: state.query,
      type: state.type,
      facets: state.facets,
      state,
    }),
  );
  expect(html).toMatch(/<form\b[^>]*method="get"/);
  expect(html).toMatch(/<form\b[^>]*action="\/zh-Hant\/search"/);
  const ratingHelp = html.match(/<details\b[^>]*>[\s\S]*?<\/details>/)?.[0];
  expect(ratingHelp).toBeDefined();
  expect(ratingHelp).not.toMatch(/\sopen(?:=|\s|>)/);
  expect(ratingHelp).toContain(m.search_reader_rating_help_title({}, { locale: 'zh-Hant' as never }));
  expect(ratingHelp).toContain(m.rating_public_ordering({}, { locale: 'zh-Hant' as never }));
  for (const name of [
    'q',
    'type',
    'sort',
    'kinds',
    'language',
    'filter',
    'condition',
    'r.schema:datePublished',
    'f.schema:genre',
    'f.schema:keywords',
  ])
    expect(html).toContain(`name="${name}"`);
  expect(html).not.toContain('name="cursor"');
});

test('relevance remains the default on an otherwise empty search', () => {
  const empty: SearchLoaderDeps = { query: '', type: undefined, facets: {}, cursor: 'old', sort: 'rating' };
  expect(searchSortHref('en', empty, 'relevance')).toBe('/en/search');
  expect(searchSortHref('en', { ...empty, sort: undefined }, 'rating')).toBe('/en/search?sort=rating');
});
