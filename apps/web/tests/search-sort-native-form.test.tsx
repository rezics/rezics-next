import { expect, test } from 'bun:test';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as v from 'valibot';
import { searchLoaderDeps, searchParams } from '../src/search/search-params';
import { SearchSort } from '../src/search/sort';

const props = { locale: 'en', query: 'Reader', type: undefined, facets: {}, state: { query: 'Reader', type: undefined, facets: {}, cursor: 'old', sort: undefined } };

test('native sort submission uses a supported value and independently labeled selectors', () => {
  const html = renderToStaticMarkup(
    createElement(
      Fragment,
      null,
      createElement(SearchSort, { ...props, sort: 'relevance' }),
      createElement(SearchSort, { ...props, sort: 'rating' }),
    ),
  );
  const selects = [...html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)];
  expect(selects).toHaveLength(2);
  const ids = selects.map(([, attributes]) => attributes!.match(/\bid="([^"]+)"/)![1]!);
  expect(new Set(ids).size).toBe(2);
  ids.forEach((id) => expect(html).toContain(`for="${id}"`));
  expect(selects[0]![1]).toContain('name="sort"');
  expect(selects[0]![2]).toMatch(/<option value="" selected=""/);
  expect(selects[1]![2]).toMatch(/<option value="rating" selected=""/);
  expect(html).toContain('type="submit"');
  expect(searchLoaderDeps(v.parse(searchParams, { sort: '' })).sort).toBeUndefined();
});

test('disabled sorting cannot submit a new order', () => {
  const html = renderToStaticMarkup(createElement(SearchSort, { ...props, sort: 'rating', disabled: true }));
  const select = html.match(/<select\b[^>]*>/)![0];
  expect(select).toContain('disabled=""');
  expect(select).not.toContain('name="sort"');
  expect(html).toMatch(/<button\b[^>]*disabled=""/);
  expect(html).toContain('type="hidden" name="sort" value="rating"');
});
