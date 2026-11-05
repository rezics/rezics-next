import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act } from 'react';
import { TrendingSearchesSection, trendingTermRowKeys } from '../src/search/trending-section';

const term = (display: string, query = `"${display}"`) => ({ query, display });

test('a native Trending page with repeated queries keeps independent row identity', async () => {
  const first = [term('Prince'), term('The Little Prince'), term('The Little Prince'), term('Dune')];
  const keys = trendingTermRowKeys(first);
  expect(new Set(keys).size).toBe(first.length);
  expect(trendingTermRowKeys(first.map((row) => ({ ...row })))).toEqual(keys);
  const { Window } = await import(
    Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
  );
  const window = new Window({ url: 'https://site.test/en/search' });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, value });
  const { createRoot } = await import('react-dom/client');
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  const selected: string[] = [];
  const render = (terms: typeof first) =>
    act(async () =>
      root.render(
        <TrendingSearchesSection
          state={{ status: 'ready', page: { trendingSearches: terms, next: null } }}
          onSelect={(query) => selected.push(query)}
        />,
      ),
    );
  const rows = () => [...host.querySelectorAll<HTMLLIElement>('[data-trending-searches] li')];
  try {
    await render(first);
    expect(rows().map((row) => row.textContent)).toEqual(first.map((row) => row.display));
    const original = rows();
    await render(first.map((row) => ({ ...row })));
    expect(rows()).toEqual(original);
    for (const row of rows()) await act(async () => row.querySelector('button')!.click());
    expect(selected).toEqual(first.map((row) => row.query));
    const next = [term('The Little Prince'), term('Neuromancer'), term('The Little Prince')];
    selected.length = 0;
    await render(next);
    expect(rows().map((row) => row.textContent)).toEqual(next.map((row) => row.display));
    for (const row of rows()) await act(async () => row.querySelector('button')!.click());
    expect(selected).toEqual(next.map((row) => row.query));
  } finally {
    await act(async () => root.unmount());
    await window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
