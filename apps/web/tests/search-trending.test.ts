import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readTrendingSearches, trendingResponse, validTrendingPage, type TrendingPage } from '../src/search/trending';
import { TrendingSearchesSection } from '../src/search/trending-section';
import { HeaderSearchView } from '../src/search/header-search/header-search';
import { initialHeaderSearchState, reduceHeaderSearchState } from '../src/search/header-search/state';
import { m } from '../src/paraglide/messages.js';

const page: TrendingPage = {
  trendingSearches: [{ query: '"The Little Prince"', display: 'The Little Prince' }],
  next: null,
};
test('real typed endpoint carries current credentials/language and no public counts or permission', async () => {
  const calls: Request[] = [];
  const client = createKernelClient('https://kernel.test', {
    fetch: async (input, init) => {
      calls.push(new Request(input, init));
      return Response.json(page);
    },
  });
  const signal = new AbortController().signal;
  expect(await readTrendingSearches(client, 'en', 'Bearer current', signal)).toEqual(page);
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0]!.url).pathname).toBe('/v1/trendingSearches');
  expect(new URL(calls[0]!.url).searchParams.get('limit')).toBe('10');
  expect(calls[0]!.headers.get('authorization')).toBe('Bearer current');
  expect(validTrendingPage(page)).toBe(true);
  expect(validTrendingPage({ ...page, trendingSearches: [{ ...page.trendingSearches[0], count: 10 }] })).toBe(false);
  const markup = renderToStaticMarkup(createElement(TrendingSearchesSection, { state: { status: 'ready', page } }));
  expect(markup).toContain('The Little Prince');
  expect(markup).not.toContain('count');
  expect(markup).not.toContain('permission');
});
test('unavailable current owner evidence never becomes empty success or anonymous retry', async () => {
  let calls = 0;
  const client = createKernelClient('https://kernel.test', {
    fetch: async () => {
      calls++;
      return Response.json({ code: 'semantic_not_ready' }, { status: 503 });
    },
  });
  await expect(readTrendingSearches(client, 'en', 'Bearer current', new AbortController().signal)).rejects.toThrow(
    'semantic_not_ready',
  );
  expect(calls).toBe(1);
  const response = await trendingResponse(
    new Request('https://site.test/api/search/trending?language=en'),
    {},
    async () => {
      throw new Error('unavailable');
    },
  );
  expect(response.status).toBe(502);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});
test('shared full screen Search frame retains Recent, and trends have localized honest states', () => {
  const state = reduceHeaderSearchState(initialHeaderSearchState(), { type: 'open-phone' });
  const markup = renderToStaticMarkup(
    createElement(HeaderSearchView, { id: 'trends', state, locale: 'en', region: null }),
  );
  expect(markup).toContain(m.header_search_recent());
  expect(markup).toContain('data-trending-searches');
  expect(markup.match(/role="combobox"/g) ?? []).toHaveLength(1);
  for (const status of ['loading', 'preparing', 'unavailable'] as const) {
    const content = renderToStaticMarkup(createElement(TrendingSearchesSection, { state: { status } }));
    expect(content).toContain('role="status"');
    expect(content).not.toContain('The Little Prince');
  }
  expect(
    renderToStaticMarkup(
      createElement(TrendingSearchesSection, {
        state: { status: 'ready', page: { trendingSearches: [], next: null } },
      }),
    ),
  ).toContain(m.trending_empty());
});
