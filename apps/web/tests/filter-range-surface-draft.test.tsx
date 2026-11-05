import { expect, test } from 'bun:test';
import { act, useState } from 'react';
import { dirname } from 'node:path';
import type { SearchPageData } from '../src/search/search';
import recording from '../src/kernel/recorded/definitions-release.json';
import { conditionMetadata } from '../src/search/condition-editor-model';
import { m } from '../src/paraglide/messages.js';

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
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: () => media,
});
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
  FormData: window.FormData,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });

const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { SearchPage } = await import('../src/search/search');
const { HeaderSearchFilterProvider } = await import('../src/search/header-search/filter-region');
const { setLocale } = await import('../src/paraglide/runtime.js');

test('range drafts survive Filters remounts and reset to the next committed range', async () => {
  type Committed = {
    query: string;
    ranges: Record<string, { gte?: number; lte?: number; unit?: string }>;
  };
  let changeCommitted: () => void = () => {};
  const screen = () => {
    const [committed, setCommitted] = useState<Committed>({
      query: 'reading',
      ranges: {},
    });
    changeCommitted = () =>
      setCommitted({
        query: 'new search',
        ranges: { 'fixture:amount': { gte: 20, unit: 'lb' } },
      });
    const data = {
      queryState: {
        query: committed.query,
        facets: {},
        ranges: committed.ranges,
      },
      ranges: committed.ranges,
      selectedFacets: {},
      refinement: {
        key: committed.query,
        properties: [
          {
            property: 'fixture:amount',
            labels: { en: 'Amount' },
            mode: 'range',
            datatype: 'quantity',
            units: ['kg', 'lb'],
          },
        ],
        initial: {
          status: 'ready',
          page: { as_of: '2026-11-03T00:00:00Z', facets: [] },
        },
      },
    } as unknown as SearchPageData;
    return (
      <HeaderSearchFilterProvider>
        <SearchPage query={committed.query} data={data} filtersOnly />
      </HeaderSearchFilterProvider>
    );
  };
  const route = createRootRoute({ component: screen });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ['/en/search?q=reading'] }),
  });
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

test('mounted criteria reserve IME keys, then Apply ordered labels without changing executed operands', async () => {
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value,
    });
  const committed = {
    query: 'exact 日本語',
    type: 'schema:Book',
    kinds: ['subject'],
    facets: { 'schema:inLanguage': ['ja'] },
    languages: ['en'],
    cursor: 'obsolete',
    sort: 'rating' as const,
    ranges: { 'schema:numberOfPages': { gte: 20 } },
    condition: { type: { in: ['schema:Book'] } },
  };
  let locale = 'en';
  const data = {
    queryState: committed,
    condition: committed.condition,
    ranges: committed.ranges,
    type: committed.type,
    sort: committed.sort,
    selectedFacets: committed.facets,
    conditionMetadata: conditionMetadata(recording.release),
    discovery: {
      status: 'ready',
      page: {
        kinds: { values: [] },
        applicability: { type: 'all', statement: 'all' },
      },
    },
  } as unknown as SearchPageData;
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  const render = () =>
    root.render(<SearchPage query={committed.query} data={data} filtersOnly initiallyOpen locale={locale} />);
  const key = (input: HTMLInputElement, name: string, extra = {}) =>
    input.dispatchEvent(
      new window.KeyboardEvent('keydown', {
        key: name,
        bubbles: true,
        cancelable: true,
        ...extra,
      }),
    );
  const compose = (input: HTMLInputElement, phase: string) =>
    input.dispatchEvent(new window.CompositionEvent(phase, { bubbles: true }));
  const fill = (input: HTMLInputElement, text: string) => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  try {
    for (const nextWidth of [1280, 390]) {
      width = nextWidth;
      await act(async () => render());
      await act(async () => {
        for (const listener of mediaListeners) listener({} as MediaQueryListEvent);
      });
      let input = document.querySelector<HTMLInputElement>('input[id$="-custom"]')!;
      const form = input.form!;
      const submit = () => form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      const languages = () => [...form.querySelectorAll('ol li code')].map((node) => node.textContent);
      await act(async () => {
        input.focus();
        fill(input, 'pt-B');
        input.setSelectionRange(2, 4);
        compose(input, 'compositionstart');
        for (const extra of [{}, { isComposing: true }, { keyCode: 229 }]) {
          key(input, 'Enter', extra);
          key(input, 'Escape', extra);
          expect(submit()).toBe(false);
        }
      });
      expect(input.isConnected).toBe(true);
      expect(document.activeElement).toBe(input);
      expect([input.value, input.selectionStart, input.selectionEnd]).toEqual(['pt-B', 2, 4]);
      expect(languages()).toEqual(['en']);
      expect(form.querySelector('[role="alert"]')).toBeNull();
      await act(async () => {
        fill(input, 'PT-br');
        compose(input, 'compositionend');
        expect(submit()).toBe(false); // Candidate key is still down after compositionend.
        input.dispatchEvent(new window.KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
        for (const extra of [{ isComposing: true }, { keyCode: 229 }]) {
          key(input, 'Enter', extra);
          key(input, 'Escape', extra);
          expect(submit()).toBe(false);
          expect(input.value).toBe('PT-br');
        }
        key(input, 'Enter');
      });
      expect(languages()).toEqual(['en', 'pt-BR']);
      await act(async () =>
        form
          .querySelector<HTMLButtonElement>(
            `button[aria-label="${m.condition_languages_move_up({ language: 'pt-BR' }, { locale: 'en' })}"]`,
          )!
          .click(),
      );
      expect(languages()).toEqual(['pt-BR', 'en']);
      const request = new window.FormData(form as never);
      expect(request.get('q')).toBe(committed.query);
      expect(request.getAll('language')).toEqual(['pt-BR', 'en']);
      expect(request.get('f.schema:inLanguage')).toBe('ja');
      expect(request.get('condition')).toBe(JSON.stringify(committed.condition));
      expect(request.get('r.schema:numberOfPages')).toBe(JSON.stringify(committed.ranges['schema:numberOfPages']));
      expect(request.get('cursor')).toBeNull();
      expect(request.get('type')).toBe(committed.type);
      expect(request.get('sort')).toBe('rating');
      expect(request.getAll('kinds')).toEqual(['subject']);
      await act(async () => {
        expect(submit()).toBe(true);
      });
      await act(async () => {
        input.focus();
        fill(input, 'not a tag');
        key(input, 'Enter');
      });
      expect(form.querySelector('[role="alert"]')?.textContent).toContain(
        m.condition_languages_invalid({}, { locale: 'en' }),
      );
      expect(document.activeElement).toBe(input);
      await act(async () => {
        compose(input, 'compositionstart');
        locale = 'zh-Hans';
        render();
      });
      expect(input.isConnected).toBe(false);
      input = document.querySelector<HTMLInputElement>('input[id$="-custom"]')!;
      expect(input.value).toBe('');
      expect([...input.form!.querySelectorAll('ol li code')].map((node) => node.textContent)).toEqual(['en']);
      await act(async () => {
        locale = 'en';
        render();
      });
    }
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
