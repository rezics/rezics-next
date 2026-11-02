import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, useState, type ReactNode } from 'react';
import type { SearchPageData } from '../src/search/search';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://search.test/en/search?q=reading' });
let width = 1280;
const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();
const media = {
  get matches() {
    return width >= 1024;
  },
  addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => mediaListeners.add(listener),
  removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
    mediaListeners.delete(listener),
};
Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => media });
const nativeRaf = window.requestAnimationFrame.bind(window);
const nativeCancel = window.cancelAnimationFrame.bind(window);
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
  requestAnimationFrame: nativeRaf,
  cancelAnimationFrame: nativeCancel,
  scrollTo: window.scrollTo.bind(window),
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
const start = await import('../.storybook/react-start');
mock.module('@tanstack/react-start', () => start);
mock.module('@tanstack/react-start/server', () => start);
mock.module('cloudflare:workers', () => ({ env: {} }));
const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { SearchPage } = await import('../src/search/search');
const { HeaderSearchFilterProvider, useHeaderSearchFilterRegion } =
  await import('../src/search/header-search/filter-region');
const { setLocale } = await import('../src/paraglide/runtime.js');
const { m } = await import('../src/paraglide/messages.js');

const pageData = (query: string) =>
  ({
    queryState: { query, facets: {} },
    selectedFacets: {},
    conditionMetadata: { types: { work: { labels: { en: 'Work' }, bases: [], facets: [] } }, properties: {} },
    refinement: {
      key: query,
      properties: [
        {
          property: 'fixture:amount',
          labels: { en: 'Amount' },
          mode: 'range',
          datatype: 'quantity',
          units: ['kg', 'lb'],
        },
      ],
      initial: { status: 'ready', page: { as_of: '2026-11-03T00:00:00Z', facets: [] } },
    },
  }) as unknown as SearchPageData;

function HeaderOpen() {
  const region = useHeaderSearchFilterRegion();
  return (
    <button type="button" data-header-filters onClick={() => region?.open()}>
      Header
    </button>
  );
}

async function queued(run: (flush: () => Promise<void>) => Promise<void>) {
  const frames = new Map<number, FrameRequestCallback>();
  let next = 1;
  const raf = (callback: FrameRequestCallback) => {
    const id = next++;
    frames.set(id, callback);
    return id;
  };
  const cancel = (id: number) => {
    frames.delete(id);
  };
  globalThis.requestAnimationFrame = raf;
  globalThis.cancelAnimationFrame = cancel;
  Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: raf });
  Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: cancel });
  try {
    await run(async () => {
      await act(async () => {
        const callbacks = [...frames.values()];
        frames.clear();
        for (const callback of callbacks) callback(0);
      });
    });
  } finally {
    globalThis.requestAnimationFrame = nativeRaf;
    globalThis.cancelAnimationFrame = nativeCancel;
    Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: nativeRaf });
    Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: nativeCancel });
  }
}

async function mount(screen: () => ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: screen }),
    history: createMemoryHistory({ initialEntries: ['/en/search?q=reading'] }),
  });
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  setLocale('en', { reload: false });
  await router.load();
  await act(async () => root.render(<RouterProvider router={router} />));
  return { host, root };
}

const opener = () => document.querySelector<HTMLButtonElement>('button[aria-controls="search-filters"]')!;
const region = () => document.querySelector<HTMLElement>('[role="region"]');
const closeButton = () =>
  [...(region()?.querySelectorAll('button') ?? [])].find((button) => button.textContent === m.search_close_filters());

afterAll(() => {
  window.happyDOM.abort();
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('Only the current Filters surface transition may restore focus to its surviving owner', async () => {
  let changeQuery: () => void = () => {};
  const { host, root } = await mount(() => {
    const [query, setQuery] = useState('reading');
    changeQuery = () => setQuery('next');
    return (
      <HeaderSearchFilterProvider>
        <button type="button" data-elsewhere>
          Elsewhere
        </button>
        <HeaderOpen />
        <SearchPage query={query} data={pageData(query)} filtersOnly />
      </HeaderSearchFilterProvider>
    );
  });
  const header = () => document.querySelector<HTMLButtonElement>('[data-header-filters]')!;
  const elsewhere = () => document.querySelector<HTMLButtonElement>('[data-elsewhere]')!;
  opener().focus();
  await act(async () => opener().click());
  await queued(async (flush) => {
    await act(async () => closeButton()!.click());
    header().focus();
    await act(async () => header().click());
    await flush();
    expect(region()?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement === header()).toBe(false);
    await act(async () => closeButton()!.click());
    opener().focus();
    await act(async () => opener().click());
    await act(async () => closeButton()!.click());
    await flush();
    expect(document.activeElement === opener()).toBe(true);
  });
  opener().focus();
  await act(async () => opener().click());
  elsewhere().focus();
  expect(document.activeElement === elsewhere()).toBe(true);
  await queued(async (flush) => {
    await act(async () => closeButton()!.click());
    elsewhere().focus();
    await flush();
    expect(document.activeElement === elsewhere()).toBe(true);
    opener().focus();
    await act(async () => opener().click());
    await act(async () => closeButton()!.click());
    await act(async () => changeQuery());
    await flush();
    expect(document.activeElement === opener()).toBe(false);
  });
  opener().focus();
  await act(async () => opener().click());
  await act(async () => root.unmount());
  host.remove();
});

test('Filters keep ordinary desktop and phone focus and drafts across close, reopen and resize', async () => {
  const { host, root } = await mount(() => (
    <HeaderSearchFilterProvider>
      <SearchPage query="reading" data={pageData('reading')} filtersOnly />
    </HeaderSearchFilterProvider>
  ));
  try {
    opener().focus();
    await act(async () => opener().click());
    expect(document.activeElement === region()).toBe(true);
    const language = document.querySelector<HTMLSelectElement>('[data-condition-editor] select')!;
    await act(async () => {
      language.value = 'zh-Hans';
      language.dispatchEvent(new window.Event('change', { bubbles: true }));
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent === m.condition_languages_add())!
        .click();
      [...document.querySelectorAll('button')].find((button) => button.textContent === m.condition_add())!.click();
      const numbers = [...document.querySelectorAll<HTMLInputElement>('input[type="number"]')];
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(numbers[0]!, '4');
      numbers[0]!.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const drafts = () => {
      expect(document.querySelector('input[name="language"]')?.getAttribute('value')).toBe('zh-Hans');
      expect([...document.querySelectorAll('button')].some((button) => button.textContent === m.condition_add())).toBe(
        false,
      );
      expect(document.querySelectorAll<HTMLInputElement>('input[type="number"]')[0]?.value).toBe('4');
    };
    const resize = async (next: number) =>
      act(async () => {
        width = next;
        for (const listener of mediaListeners) listener({} as MediaQueryListEvent);
      });
    await resize(390);
    drafts();
    await resize(1280);
    await act(async () => {
      region()!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.activeElement === opener()).toBe(true);
    opener().focus();
    await act(async () => opener().click());
    drafts();
    await act(async () => closeButton()!.click());
    expect(document.activeElement === opener()).toBe(true);
    await resize(390);
    opener().focus();
    await act(async () => opener().click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(Boolean(dialog?.contains(document.activeElement)) || document.activeElement === opener()).toBe(true);
    await act(async () => {
      [...document.querySelectorAll('button')].find((button) => button.textContent === 'Done')!.click();
    });
    expect(document.activeElement === opener()).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
