import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { useTrendingSearches, validTrendingPage } from '../src/search/trending';
import { TrendingSearchesSection } from '../src/search/trending-section';
import { m } from '../src/paraglide/messages.js';

const quote = (display: string) => `"${display.replace(/[\\"]/g, '\\$&')}"`;
const page = (...displays: string[]) => ({
  next: null,
  trendingSearches: displays.map((display) => ({ query: quote(display), display })),
});

test('native Trending pages keep quoted pairs, repeats and empty data, and reject foreign or malformed envelopes', () => {
  const escaped = 'a "quote" \\ path';
  const cjk = '你'.repeat(85);
  expect(validTrendingPage(page())).toBe(true);
  expect(validTrendingPage(page(escaped, 'Prince', escaped))).toBe(true);
  expect(validTrendingPage(page(cjk))).toBe(true);
  expect(validTrendingPage(page('a'.repeat(256)))).toBe(true);
  expect(validTrendingPage({ next: null, trendingSearches: [{ query: 'unrelated', display: 'shown' }] })).toBe(false);
  expect(validTrendingPage({ next: null, trendingSearches: [{ query: `"${escaped}"`, display: escaped }] })).toBe(
    false,
  );
  expect(validTrendingPage(page('你'.repeat(86)))).toBe(false);
  expect(validTrendingPage({ ...page('ok'), next: 'x' })).toBe(false);
  expect(validTrendingPage({ ...page('ok'), extra: 1 })).toBe(false);
  expect(
    validTrendingPage({
      next: null,
      trendingSearches: [...page('Prince').trendingSearches, { query: 'unrelated', display: 'shown' }],
    }),
  ).toBe(false);
  expect(validTrendingPage(page(...Array.from({ length: 11 }, () => 'a')))).toBe(false);
});

function Harness({ onSelect }: { onSelect: (query: string) => void }) {
  const { state, retry } = useTrendingSearches('en', 'reader', () => () => {});
  return createElement(TrendingSearchesSection, { state, onSelect, onRetry: retry });
}

test('a malformed Trending page is unavailable as a whole and cannot call onSelect', async () => {
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/search' });
  const pending: ((response: Response) => void)[] = [];
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: () => new Promise<Response>((resolve) => pending.push(resolve)),
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const selected: string[] = [];
  const settle = (body: unknown) => act(async () => pending.at(-1)!(Response.json(body)));
  const rows = () => [...host.querySelectorAll('[data-trending-searches] li')];
  try {
    await act(async () => root.render(createElement(Harness, { onSelect: (query: string) => selected.push(query) })));
    await settle({
      next: null,
      trendingSearches: [...page('Prince').trendingSearches, { query: 'unrelated', display: 'shown' }],
    });
    expect(host.textContent).toContain(m.trending_unavailable());
    expect(host.querySelector('li button')).toBeNull();
    expect(selected).toEqual([]);
    await act(async () =>
      [...host.querySelectorAll('button')]
        .find((button) => button.textContent === m.search_facet_retry())!
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true })),
    );
    await settle(page('Prince', 'Dune', 'Prince'));
    expect(rows().map((row) => row.textContent)).toEqual(['Prince', 'Dune', 'Prince']);
    for (const row of rows())
      await act(async () =>
        row.querySelector('button')!.dispatchEvent(new window.MouseEvent('click', { bubbles: true })),
      );
    expect(selected).toEqual(['"Prince"', '"Dune"', '"Prince"']);
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
