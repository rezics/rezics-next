import { expect, test } from 'bun:test';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as v from 'valibot';
import { searchParams } from '../src/search/search-params';
import { SearchSort, searchSortHref } from '../src/search/sort';
import { m } from '../src/paraglide/messages.js';

const props = {
  locale: 'en',
  query: 'Reader',
  type: undefined,
  facets: {},
  state: { query: 'Reader', type: undefined, facets: {}, cursor: 'old', sort: undefined },
};

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
  expect(selects).toHaveLength(4);
  const ids = selects.map(([, attributes]) => attributes!.match(/\bid="([^"]+)"/)![1]!);
  expect(new Set(ids).size).toBe(4);
  ids.forEach((id) => expect(html).toContain(`for="${id}"`));
  const sorts = selects.filter(([, attributes]) => attributes!.includes('name="sort"'));
  expect(sorts).toHaveLength(2);
  expect(sorts[0]![1]).toContain('name="sort"');
  expect(sorts[0]![2]).toMatch(/<option value="" selected=""/);
  expect(sorts[1]![2]).toMatch(/<option value="rating" selected=""/);
  expect(html).toContain('type="submit"');
  expect(v.parse(searchParams, { sort: '' }).sort).toBeUndefined();
});

test('disabled sorting cannot submit a new order', () => {
  const html = renderToStaticMarkup(createElement(SearchSort, { ...props, sort: 'rating', disabled: true }));
  const select = html.match(/<select\b[^>]*>/)![0];
  expect(select).toContain('disabled=""');
  expect(select).not.toContain('name="sort"');
  expect(html).toMatch(/<button\b[^>]*disabled=""/);
  expect(html).toContain('type="hidden" name="sort" value="rating"');
});

test('coexisting page locales label and describe the retained Realm choice without changing membership', async () => {
  const population = 'c7a2a3f2-537c-4e72-b12d-8253fb240832';
  const filter = JSON.stringify({ realm: { id: '31476787-efeb-4264-a0e4-4184443d15ee' } });
  for (const locale of ['zh-Hant', 'ja'] as const) {
    const options = { locale };
    const state = { ...props.state, query: 'Steins;Gate', filter, ratingPopulation: population };
    const html = renderToStaticMarkup(
      createElement(SearchSort, {
        ...props,
        locale,
        query: state.query,
        state,
        sort: 'rating',
        ratingPopulation: population,
        ratingReadiness: { status: 'unavailable' },
      }),
    );
    expect(html).toContain(m.search_population_label({}, options));
    expect(html).toContain(m.search_population_global({}, options));
    expect(html).toContain(m.search_population_unavailable({}, options));
    expect(html).toContain(m.search_population_retry({}, options));
    const control = html.match(/<select[^>]*name="ratingPopulation"[^>]*>/)![0];
    const description = control.match(/aria-describedby="([^"]+)"/)![1];
    expect(html).toContain(`id="${description}"`);
    expect(html).toContain(m.search_population_help({}, options));
    expect(html).toContain(`value="${population}" selected=""`);
    const next = new URL(searchSortHref(locale, state, 'rating', population), 'https://search.test');
    expect(next.searchParams.get('filter')).toBe(filter);
    expect(next.searchParams.get('q')).toBe(state.query);
    expect(next.searchParams.get('cursor')).toBeNull();
  }
  const catalogues = await Promise.all(
    ['en', 'de', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'].map((locale) =>
      Bun.file(`${import.meta.dir}/../messages/${locale}.json`).json(),
    ),
  );
  for (const catalogue of catalogues) expect(Object.keys(catalogue).sort()).toEqual(Object.keys(catalogues[0]).sort());
});
