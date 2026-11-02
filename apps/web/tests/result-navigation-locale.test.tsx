import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';
import { ResultKindNavigation } from '../src/search/result-kind-navigation';
import type { SearchLoaderDeps } from '../src/search/search-params';
import { SearchSort } from '../src/search/sort';

const state: SearchLoaderDeps = {
  query: 'Reader',
  type: 'schema:Book',
  facets: { 'schema:genre': ['mystery'] },
  cursor: 'old-hit-cursor',
  sort: 'rating',
  kinds: ['schema:Book', 'catalogue:Manga'],
  languages: ['ja', 'en'],
};

test('search controls use their supplied locale for interface copy and preserve reader inputs', () => {
  const previousLocale = getLocale();
  const locale = 'zh-Hant';
  const messageLocale = { locale: locale as never };
  setLocale('en');
  try {
    const sortHtml = renderToStaticMarkup(
      createElement(SearchSort, {
        sort: 'rating',
        locale,
        query: state.query,
        type: state.type,
        facets: state.facets,
        state,
      }),
    );
    const sortLabel = m.search_sort_label({}, messageLocale);
    expect(m.search_sort_label()).not.toBe(sortLabel);
    expect(sortHtml).toContain(sortLabel);
    expect(sortHtml).toContain(m.search_sort_relevance({}, messageLocale));
    expect(sortHtml).toContain(m.search_sort_rating({}, messageLocale));
    expect(sortHtml).toContain(m.search_reader_rating_help_title({}, messageLocale));
    expect(sortHtml).toContain(m.rating_public_ordering({}, messageLocale));
    expect(sortHtml).toContain(m.search_sort_submit_button({}, messageLocale));
    expect(sortHtml).toContain('action="/zh-Hant/search"');
    expect(sortHtml).toContain(`for="${sortHtml.match(/<select id="([^"]+)"/)![1]}"`);
    expect([...sortHtml.matchAll(/<input\b([^>]*type="hidden"[^>]*)>/g)].map(([, attrs]) => [
      attrs!.match(/\bname="([^"]+)"/)![1],
      attrs!.match(/\bvalue="([^"]*)"/)![1],
    ])).toEqual([
      ['kinds', 'schema:Book'],
      ['kinds', 'catalogue:Manga'],
      ['language', 'ja'],
      ['language', 'en'],
      ['q', 'Reader'],
      ['type', 'schema:Book'],
      ['f.schema:genre', 'mystery'],
    ]);

    const navigationHtml = renderToStaticMarkup(
      createElement(ResultKindNavigation, {
        state,
        locale,
        kinds: {
          values: [
            { id: 'schema:Book', labels: { en: 'Book' }, icon: 'book' },
            { id: 'catalogue:Manga', labels: { en: 'Manga' }, icon: 'book' },
          ],
          next: null,
        },
      }),
    );
    expect(navigationHtml).toContain(`aria-label="${m.search_result_kinds({}, messageLocale)}"`);
    expect(navigationHtml).toContain(`<span lang="${locale}">${m.search_kind_navigation_all({}, messageLocale)}</span>`);
    expect(navigationHtml).toContain('<span lang="en">Book</span>');
    expect(navigationHtml).toContain('<span lang="en">Manga</span>');
    expect(navigationHtml).toContain(m.search_kind_navigation_selected({ kinds: 'Book, Manga' }, messageLocale));
    expect(navigationHtml).toContain(m.search_kind_navigation_more({}, messageLocale));
    expect([...navigationHtml.matchAll(/<a\b[^>]*href="([^"]+)"/g)].map(([, href]) => href!.replaceAll('&amp;', '&'))).toEqual([
      '/zh-Hant/search?type=schema%3ABook&sort=rating&language=ja&language=en&f.schema%3Agenre=mystery&q=Reader',
      '/zh-Hant/search?type=schema%3ABook&sort=rating&kinds=schema%3ABook&language=ja&language=en&f.schema%3Agenre=mystery&q=Reader',
      '/zh-Hant/search?type=schema%3ABook&sort=rating&kinds=catalogue%3AManga&language=ja&language=en&f.schema%3Agenre=mystery&q=Reader',
    ]);
  } finally {
    setLocale(previousLocale);
  }
});
