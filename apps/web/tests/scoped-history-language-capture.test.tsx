import { expect, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, type ReactNode } from 'react';
import type { RecentEntry, RecentHistory } from '../src/search/recent-history';
import type { SearchScope } from '../src/search/header-search/types';
import type { HeaderSuggestionLoader } from '../src/search/header-search/suggestions';
import type { SuggestionResult } from '../src/search/suggestions';

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);

const globalFields: readonly [string, string][] = [
  ['type', 'schema:Book'],
  ['language', 'zh-Hans'],
  ['language', 'fr'],
];
const scoped: SearchScope = {
  kind: 'Library',
  id: 'mine',
  name: 'Library',
  searchAction: '/ja/library?collection=reading&language=ja&language=en',
};
const unlanguaged: SearchScope = {
  kind: 'Library',
  id: 'plain',
  name: 'Library',
  searchAction: '/ja/library?collection=reading',
};
const suggestion: SuggestionResult = {
  as_of: '2026-11-03T00:00:00Z',
  subjects: [
    {
      id: '01a17dfd-5dbf-738a-9405-9dfa9a8ec069',
      type: 'schema:Book',
      labels: { ja: 'Prince' },
      summary: null,
    },
  ],
  types: {},
};

type Remembered = Parameters<RecentHistory['remember']>;

async function mount(options: {
  scope?: SearchScope;
  initialQuery?: string;
  onNavigate?: (href: string) => void;
  entries?: readonly RecentEntry[];
  loadScopedSuggestions?: HeaderSuggestionLoader;
}) {
  const window = new Window({ url: 'https://site.test/ja/search', width: 1200, height: 800 });
  const globals = {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLFormElement: window.HTMLFormElement,
    Element: window.Element,
    Node: window.Node,
    MutationObserver: window.MutationObserver,
    ResizeObserver: window.ResizeObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    matchMedia: window.matchMedia.bind(window),
    FormData: window.FormData,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import('react-dom/client');
  const { HeaderSearch } = await import('../src/search/header-search/header-search');
  const remembered: Remembered[] = [];
  const history: RecentHistory = {
    entries: options.entries ?? [],
    persistence: 'memory',
    sync: 'local-only',
    remember(...args) {
      remembered.push(args);
    },
    remove() {},
  };
  const host = window.document.createElement('div');
  window.document.body.append(host);
  const root = createRoot(host as unknown as HTMLElement);
  await act(async () =>
    root.render(
      createElement(HeaderSearch, {
        locale: 'ja',
        scope: options.scope,
        initialQuery: options.initialQuery,
        fields: globalFields,
        history,
        onNavigate: options.onNavigate,
        loadSuggestions: async () => ({ as_of: suggestion.as_of, subjects: [], types: {} }),
        loadScopedSuggestions: options.loadScopedSuggestions,
      }) as ReactNode,
    ),
  );
  const input = host.querySelector<HTMLInputElement>('[role="combobox"]')!;
  const form = input.form!;
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  return {
    window,
    host,
    form,
    input,
    remembered,
    async type(query: string) {
      await act(async () => {
        setValue.call(input, query);
        input.dispatchEvent(new window.Event('input', { bubbles: true }));
      });
    },
    async submit() {
      const event = new window.Event('submit', { bubbles: true, cancelable: true });
      await act(async () => void form.dispatchEvent(event));
      return event;
    },
    hidden() {
      return [...form.querySelectorAll('input[type="hidden"]')].map((control) => [
        (control as HTMLInputElement).name,
        (control as HTMLInputElement).value,
      ]);
    },
    nativeDestination() {
      const url = new URL(form.getAttribute('action') ?? '', window.location.origin);
      url.search = new URLSearchParams(new window.FormData(form) as never).toString();
      return `${url.pathname}${url.search}`;
    },
    async cleanup() {
      await act(async () => root.unmount());
      await window.happyDOM.abort();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

test('Remembered scoped queries retain the ordered language controls used by the scoped action, independent of unrelated global form fields, and resume those same preferences', async () => {
  const navigated: string[] = [];
  const intercepted = await mount({ scope: scoped, onNavigate: (href) => navigated.push(href) });
  expect(intercepted.form.getAttribute('action')).toBe('/ja/library');
  expect(intercepted.hidden()).toEqual([
    ['collection', 'reading'],
    ['language', 'ja'],
    ['language', 'en'],
  ]);
  await intercepted.type('Prince');
  const interceptedSubmit = await intercepted.submit();
  expect(interceptedSubmit.defaultPrevented).toBe(true);
  expect(intercepted.remembered).toEqual([['Prince', scoped, ['ja', 'en']]]);
  expect(navigated).toEqual(['/ja/library?collection=reading&language=ja&language=en&q=Prince']);
  await intercepted.cleanup();

  const native = await mount({ scope: scoped });
  expect(native.hidden()).toEqual([
    ['collection', 'reading'],
    ['language', 'ja'],
    ['language', 'en'],
  ]);
  await native.type('Prince');
  const nativeSubmit = await native.submit();
  expect(nativeSubmit.defaultPrevented).toBe(false);
  expect(native.remembered).toEqual([['Prince', scoped, ['ja', 'en']]]);
  expect(native.nativeDestination()).toBe('/ja/library?collection=reading&language=ja&language=en&q=Prince');
  await native.cleanup();

  const globalNav: string[] = [];
  const global = await mount({ onNavigate: (href) => globalNav.push(href) });
  expect(global.form.getAttribute('action')).toBe('/ja/search');
  expect(global.hidden()).toEqual([...globalFields]);
  await global.type('Prince');
  await global.submit();
  expect(global.remembered).toEqual([['Prince', undefined, ['zh-Hans', 'fr']]]);
  expect(globalNav).toEqual(['/ja/search?type=schema%3ABook&language=zh-Hans&language=fr&q=Prince']);
  await global.cleanup();

  const plainNav: string[] = [];
  const plain = await mount({ scope: unlanguaged, onNavigate: (href) => plainNav.push(href) });
  expect(plain.hidden()).toEqual([['collection', 'reading']]);
  await plain.type('Prince');
  await plain.submit();
  expect(plain.remembered).toEqual([['Prince', unlanguaged, undefined]]);
  expect(plainNav).toEqual(['/ja/library?collection=reading&q=Prince']);
  await plain.cleanup();

  const resumedNav: string[] = [];
  const resumed: RecentEntry = {
    id: 'scoped-ja-en',
    query: 'Prince',
    languages: ['ja', 'en'],
    scope: scoped,
    visitedAt: 1,
  };
  const recent = await mount({
    entries: [resumed],
    onNavigate: (href) => resumedNav.push(href),
  });
  await act(async () => recent.input.focus());
  const select = [...recent.host.querySelectorAll('button')].find((button) => button.textContent?.includes('Prince'))!;
  await act(async () => select.click());
  expect(recent.remembered).toEqual([['Prince', scoped, ['ja', 'en']]]);
  expect(resumedNav).toEqual(['/ja/library?collection=reading&q=Prince&language=ja&language=en']);
  await recent.cleanup();
});

test('scoped suggestion selection remembers the action languages used by that submission', async () => {
  const navigated: string[] = [];
  const loadScopedSuggestions: HeaderSuggestionLoader = async () => suggestion;
  const page = await mount({
    scope: scoped,
    initialQuery: 'Prince',
    onNavigate: (href) => navigated.push(href),
    loadScopedSuggestions,
  });
  await act(async () => page.input.focus());
  await act(async () => new Promise((resolve) => setTimeout(resolve, 230)));
  const link = page.host.querySelector('[role="option"] a')!;
  await act(async () =>
    link.dispatchEvent(new page.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })),
  );
  expect(page.remembered).toEqual([['Prince', scoped, ['ja', 'en']]]);
  expect(navigated).toEqual(['/ja/subjects/01a17dfd-5dbf-738a-9405-9dfa9a8ec069/prince']);
  await page.cleanup();
});
