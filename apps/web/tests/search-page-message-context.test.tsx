import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';
import { searchLoaderDeps } from '../src/search/search-params';
import { SearchInputRecovery } from '../src/search/search-input-recovery';
import type { SearchPageData } from '../src/search/search';

mock.module('cloudflare:workers', () => ({ env: {} }));

const { Window } = await import(
  Bun.resolveSync('happy-dom', dirname(Bun.resolveSync('@puckeditor/core', import.meta.dir)))
);
const window = new Window({ url: 'https://search.test/ja/search?q=Mira' });
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
window.scrollTo = () => undefined;
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
  scrollTo: window.scrollTo,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const previousGlobals = new Map(
  Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
);
for (const [key, value] of Object.entries(globals))
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });

const { createRoot } = await import('react-dom/client');
const { createMemoryHistory, createRootRoute, createRouter, RouterProvider } = await import('@tanstack/react-router');
const { SearchPage } = await import('../src/search/search');
const { HeaderSearchFilterProvider } = await import('../src/search/header-search/filter-region');

const options = { en: { locale: 'en' as const }, 'zh-Hans': { locale: 'zh-Hans' as const } };

function pageData(editing = false): SearchPageData {
  const queryState = searchLoaderDeps({
    q: 'Mira',
    type: 'schema:Book',
    language: ['ja'],
    'f.schema:genre': ['mystery'],
    ...(editing ? {} : { condition: JSON.stringify({ type: { in: ['schema:Book'] } }) }),
  });
  return {
    queryState,
    type: queryState.type,
    typeLabels: { en: 'Book', 'zh-Hans': '书' },
    condition: { type: { in: ['schema:Book'] } },
    hitTypes: {},
    yearProperties: [],
    typeChoices: [],
    groups: [],
    selectedFacets: queryState.facets,
    selectedFacetLabels: {},
    facetsAvailable: true,
    facetRetry: true,
    facetIndexNotReady: false,
    staleCursorRestarted: true,
    sort: 'relevance',
    result: { subjects: [], next: null, as_of: '2026-11-03T00:00:00.000Z' },
  };
}

function pageMarkup(locale: 'en' | 'zh-Hans') {
  return renderToStaticMarkup(createElement(SearchPage, { query: 'Mira', data: pageData(), locale }));
}

function recoveryMarkup(locale: 'en' | 'zh-Hans') {
  return renderToStaticMarkup(
    createElement(SearchInputRecovery, {
      parameter: 'condition',
      value: '{"and":[]}',
      locale,
      onApply() {},
      onRemove() {},
    }),
  );
}

function expectPageLocale(html: string, locale: 'en' | 'zh-Hans') {
  const opt = options[locale];
  const other = options[locale === 'en' ? 'zh-Hans' : 'en'];
  const typeLabel = locale === 'en' ? 'Book' : '书';
  const typeText = `${m.search_subject_type({}, opt)}: ${typeLabel}`;
  const filter = m.search_constraint_identity_filter(
    { number: new Intl.NumberFormat(locale).format(1), label: typeText },
    opt,
  );
  expect(html).toContain(m.search_heading({}, opt));
  expect(html).toContain(m.search_filters({}, opt));
  expect(html).toContain(`<h2 class="font-medium">${m.search_filters({}, opt)}</h2>`);
  expect(html).toContain(m.search_close_filters({}, opt));
  expect(html).toContain(m.search_apply({}, opt));
  expect(html).toContain(m.search_no_results({}, opt));
  expect(html).toContain(m.search_reader_facets_unavailable({}, opt));
  expect(html).toContain(m.search_stale_cursor_restarted({}, opt));
  expect(html).toContain(m.search_constraint_identity_value_unavailable({}, opt));
  expect(html).toContain(`aria-label="${m.refinement_remove({ value: filter }, opt)}"`);
  expect(html).toContain(typeLabel);
  expect(html).toContain(`action="/${locale}/search"`);
  expect(html).toContain('name="q" value="Mira"');
  expect(html).toContain('name="language" value="ja"');
  expect(html).toContain(`/${locale}/search?`);
  expect(html).not.toContain(m.search_filters({}, other));
  expect(html).not.toContain(m.search_no_results({}, other));
}

afterAll(() => {
  window.happyDOM.abort();
  for (const [key, descriptor] of previousGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('Search page chrome and malformed-input recovery follow the page locale against the opposite ambient language', () => {
  const previous = getLocale();
  setLocale('ja', { reload: false });
  try {
    expectPageLocale(pageMarkup('en'), 'en');
    expectPageLocale(pageMarkup('zh-Hans'), 'zh-Hans');
    const revert = renderToStaticMarkup(createElement(SearchPage, { query: 'Mira', data: pageData(true), locale: 'en' }));
    expect(revert).toContain(m.search_filter_revert_action({}, options.en));
    expect(revert).not.toContain(m.search_filter_revert_action({}, options['zh-Hans']));

    const englishRecovery = recoveryMarkup('en');
    const chineseRecovery = recoveryMarkup('zh-Hans');
    expect(englishRecovery).toContain(m.search_input_recovery_title({}, options.en));
    expect(englishRecovery).toContain(m.search_input_recovery_apply({}, options.en));
    expect(englishRecovery).toContain(m.search_input_recovery_remove({}, options.en));
    expect(englishRecovery).toContain('condition');
    expect(englishRecovery).toContain('{&quot;and&quot;:[]}');
    expect(englishRecovery).not.toContain(m.search_input_recovery_title({}, options['zh-Hans']));
    expect(chineseRecovery).toContain(m.search_input_recovery_title({}, options['zh-Hans']));
    expect(chineseRecovery).toContain(m.search_input_recovery_apply({}, options['zh-Hans']));
    expect(chineseRecovery).toContain(m.search_input_recovery_remove({}, options['zh-Hans']));
    expect(chineseRecovery).toContain('{&quot;and&quot;:[]}');
    expect(chineseRecovery).not.toContain(m.search_input_recovery_title({}, options.en));

    const both = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(SearchPage, { query: 'Mira', data: pageData(), locale: 'en' }),
        createElement(SearchPage, { query: 'Mira', data: pageData(), locale: 'zh-Hans' }),
        createElement(SearchInputRecovery, {
          parameter: 'condition',
          value: '{"and":[]}',
          locale: 'en',
          onApply() {},
          onRemove() {},
        }),
        createElement(SearchInputRecovery, {
          parameter: 'condition',
          value: '{"and":[]}',
          locale: 'zh-Hans',
          onApply() {},
          onRemove() {},
        }),
      ),
    );
    expect(both).toContain(m.search_filters({}, options.en));
    expect(both).toContain(m.search_filters({}, options['zh-Hans']));
    expect(both).toContain(m.search_input_recovery_apply({}, options.en));
    expect(both).toContain(m.search_input_recovery_apply({}, options['zh-Hans']));
    expect(both).toContain(m.search_heading({}, options.en));
    expect(both).toContain(m.search_heading({}, options['zh-Hans']));
  } finally {
    setLocale(previous, { reload: false });
  }
});

test('mobile Filters heading follows the supplied locale while ambient English differs', async () => {
  const route = createRootRoute({
    component: () =>
      createElement(
        HeaderSearchFilterProvider,
        null,
        createElement(SearchPage, { query: 'Mira', data: pageData(true), locale: 'zh-Hans' }),
      ),
  });
  const router = createRouter({
    routeTree: route,
    history: createMemoryHistory({ initialEntries: ['/zh-Hans/search?q=Mira'] }),
  });
  const host = document.createElement('main');
  document.body.append(host);
  const ambient = getLocale();
  setLocale('en', { reload: false });
  let root: ReturnType<typeof createRoot> | undefined;
  try {
    await router.load();
    root = createRoot(host);
    await act(async () => root!.render(createElement(RouterProvider, { router })));
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-controls="search-filters"]')!.click());
    await act(async () => {
      width = 390;
      for (const listener of mediaListeners) listener({} as MediaQueryListEvent);
    });
    const zh = options['zh-Hans'];
    const mobile = document.querySelector('form#search-filters');
    const heading =
      document.querySelector('[data-slot="drawer-title"]')?.textContent ??
      mobile?.closest('[data-slot="drawer"]')?.textContent ??
      '';
    expect(mobile).not.toBeNull();
    expect(heading).toContain(m.search_filters({}, zh));
    expect(mobile?.textContent).toContain(m.search_filter_revert_action({}, zh));
    expect(mobile?.textContent).toContain(m.search_apply({}, zh));
    expect(mobile?.textContent).not.toContain(m.search_filters({}, options.en));
    expect(mobile?.querySelector('input[name="q"]')?.getAttribute('value')).toBe('Mira');
  } finally {
    if (root) await act(async () => root!.unmount());
    host.remove();
    width = 1280;
    setLocale(ambient, { reload: false });
  }
});
