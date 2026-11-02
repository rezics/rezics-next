import { expect, test } from 'bun:test';
import { act, useState } from 'react';
import { dirname } from 'node:path';
import type { SearchPageData } from '../src/search/search';

const { Window } = await import(Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir))));
const window = new Window({ url: 'https://search.test/en/search?q=reading' });
let width = 1280;
const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();
const media = {
  get matches() {
    return width >= 1024;
  },
  addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => mediaListeners.add(listener),
  removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => mediaListeners.delete(listener),
};
Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => media });
const globals = {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  Element: window.Element,
  Node: window.Node,
  Document: window.Document,
  DocumentFragment: window.DocumentFragment,
  MutationObserver: window.MutationObserver,
  ResizeObserver: window.ResizeObserver,
  getComputedStyle: window.getComputedStyle.bind(window),
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { SearchPage } = await import('../src/search/search');
const { HeaderSearchFilterProvider } = await import('../src/search/header-search/filter-region');
const { setLocale } = await import('../src/paraglide/runtime.js');

test('range drafts survive Filters remounts and reset to the next committed range', async () => {
  type Committed = { query: string; ranges: Record<string, { gte?: number; lte?: number; unit?: string }> };
  let changeCommitted: () => void = () => {};
  const screen = () => {
    const [committed, setCommitted] = useState<Committed>({ query: 'reading', ranges: {} });
    changeCommitted = () =>
      setCommitted({ query: 'new search', ranges: { 'fixture:amount': { gte: 20, unit: 'lb' } } });
    const data = {
      queryState: { query: committed.query, facets: {}, ranges: committed.ranges },
      ranges: committed.ranges,
      selectedFacets: {},
      refinement: {
        key: committed.query,
        properties: [
          { property: 'fixture:amount', labels: { en: 'Amount' }, mode: 'range', datatype: 'quantity', units: ['kg', 'lb'] },
        ],
        initial: { status: 'ready', page: { as_of: '2026-11-03T00:00:00Z', facets: [] } },
      },
    } as unknown as SearchPageData;
    return (
      <HeaderSearchFilterProvider>
        <SearchPage query={committed.query} data={data} filtersOnly />
      </HeaderSearchFilterProvider>
    );
  };
  const route = createRootRoute({ component: screen });
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/en/search?q=reading'] }) });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  try {
    setLocale('en', { reload: false });
    await router.load();
    await act(async () => root.render(<RouterProvider router={router} />));
    const opener = document.querySelector<HTMLButtonElement>('button[aria-controls="search-filters"]')!;
    const committedCount = opener.textContent;
    const originalHref = router.state.location.href;
    await act(async () => opener.click());
    const numbers = () => [...document.querySelectorAll<HTMLInputElement>('input[type="number"]')];
    const setNumber = (input: HTMLInputElement, value: string) => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    };
    await act(async () => {
      setNumber(numbers()[0]!, '4');
      setNumber(numbers()[1]!, '');
      const unit = document.querySelector<HTMLSelectElement>('select[id$="-unit"]')!;
      unit.value = 'lb';
      unit.dispatchEvent(new window.Event('change', { bubbles: true }));
    });
    const resize = async (nextWidth: number) =>
      act(async () => {
        width = nextWidth;
        for (const listener of mediaListeners) listener({} as MediaQueryListEvent);
      });
    await resize(390);
    expect(numbers().map((input) => input.value)).toEqual(['4', '']);
    expect(document.querySelector('select[id$="-unit"]')?.value).toBe('lb');
    await resize(1280);
    const region = document.querySelector('[role="region"]')!;
    const buttons = region.querySelectorAll('button');
    await act(async () => buttons[0]!.click());
    await act(async () => opener.click());
    await act(async () => {
      setNumber(numbers()[1]!, '3');
      numbers()[0]!.closest('fieldset')!.querySelector('button[type="button"]')!.click();
    });
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    expect(numbers().map((input) => input.value)).toEqual(['4', '3']);
    expect(router.state.location.href).toBe(originalHref);
    expect(opener.textContent).toBe(committedCount);
    expect(document.querySelector('input[name^="r."]')).toBeNull();
    await act(async () => document.querySelector('[role="region"] button')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-controls="search-filters"]')!.click());
    expect(numbers().map((input) => input.value)).toEqual(['4', '3']);
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
    await act(async () => changeCommitted());
    expect(numbers().map((input) => input.value)).toEqual(['20', '']);
    expect(document.querySelector('select[id$="-unit"]')?.value).toBe('lb');
    expect(document.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    window.happyDOM.abort();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
