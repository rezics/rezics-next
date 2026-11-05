import { afterAll, expect, mock, test } from 'bun:test';
import { dirname } from 'node:path';
import { act, createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { m } from '../src/paraglide/messages.js';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';
import { searchLoaderDeps } from '../src/search/search-params';
import { RESOURCE_LANGUAGE_PROPERTY, resourceLanguageRefinement } from '../src/search/language-refinement';
import type { FacetState } from '../src/search/refinement/request';
import { SearchInputRecovery } from '../src/search/search-input-recovery';
import type { SearchPageData } from '../src/search/search';
import { discoveryExample } from '../src/kernel/fake/search-discovery';

mock.module('cloudflare:workers', () => ({ env: {} }));
mock.module('@rezics/ui/bottom-sheet', () => ({
  BottomSheet: ({ children, title }: { children: ReactNode; title: ReactNode }) =>
    createElement(
      'div',
      { role: 'dialog', 'data-slot': 'drawer' },
      createElement('h2', { 'data-slot': 'drawer-title' }, title),
      children,
    ),
}));

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
  removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) =>
    mediaListeners.delete(listener),
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

function resourceLanguagePageData(editing = false): SearchPageData {
  const queryState = searchLoaderDeps({
    q: 'Mira',
    type: 'schema:Book',
    language: ['en'],
    'f.schema:inLanguage': ['pt-BR'],
    ...(editing
      ? {}
      : { condition: JSON.stringify({ not: { statement: { property: RESOURCE_LANGUAGE_PROPERTY, in: ['ja'] } } }) }),
  });
  const properties = [
    {
      property: RESOURCE_LANGUAGE_PROPERTY,
      labels: { en: 'Language' },
      mode: 'values' as const,
      datatype: 'string',
      units: [],
    },
  ];
  const initial: FacetState = {
    status: 'ready',
    page: {
      as_of: '2026-11-03T00:00:00.000Z',
      facets: [
        {
          property: RESOURCE_LANGUAGE_PROPERTY,
          values: [
            { value: 'ja', labels: { ja: '日本語' } },
            { value: 'zh-Hant', labels: { en: 'Traditional Chinese' } },
            { value: 'es-419', labels: { es: 'español' } },
          ],
          next: 'opaque-language-cursor',
        },
      ],
    },
  };
  return {
    ...pageData(editing),
    queryState,
    type: queryState.type,
    condition: queryState.condition,
    discovery: {
      status: 'ready',
      page: {
        hits: [],
        kinds: { values: [], next: null },
        applicability: { type: 'all', statement: 'all' },
        next: null,
        as_of: '2026-11-03T00:00:00.000Z',
      },
    },
    selectedFacets: queryState.facets,
    selectedFacetLabels: {},
    refinement: { key: 'resource-language-test', properties, initial },
    resourceLanguage: resourceLanguageRefinement(
      properties,
      queryState.facets[RESOURCE_LANGUAGE_PROPERTY] ?? [],
      initial,
    ),
  };
}

function applicabilityPageData(
  kinds: string[],
  applicability: { type: 'all' | 'partial' | 'none'; statement: 'all' | 'partial' | 'none' },
  selected = false,
  collectionHit = false,
): SearchPageData {
  const queryState = searchLoaderDeps({
    q: 'Mira',
    kinds,
    ...(selected ? { type: 'schema:Book', 'f.schema:author': ['writer-1'] } : {}),
  });
  const page = structuredClone(discoveryExample);
  page.kinds = {
    values: [
      { id: 'collection', labels: { en: 'Collection' }, icon: 'collection' },
      { id: 'schema:Book', labels: { en: 'Book' }, icon: 'book' },
    ],
    next: null,
  };
  page.applicability = applicability;
  if (collectionHit) {
    const id = crypto.randomUUID();
    const title = 'Current public collection';
    page.hits = [
      {
        key: { owner: 'library', kind: 'collection', route: 0, id },
        summary: {
          kind: 'collection',
          value: {
            id,
            title,
            description: null,
            card: {
              kind: 'collection',
              id,
              destination: `/collections/${id}`,
              title,
              description: null,
              visibility: 'public',
              revision: 1,
              sourceGeneration: '1',
              presentationKind: null,
              presentationKindSource: 'mixed',
              cover: null,
              coverSource: 'none',
              curator: { state: 'unavailable', reason: 'withheld' },
              preview: { state: 'empty' },
              membershipKind: 'dynamic',
              outputGeneration: '1',
            },
          },
        },
      },
    ];
  } else page.hits = [];
  return {
    ...pageData(),
    queryState,
    type: queryState.type,
    condition: queryState.condition,
    typeLabels: { en: 'Book' },
    selectedFacets: queryState.facets,
    discovery: { status: 'ready', page },
    refinement: {
      key: 'search-applicability',
      properties: [
        { property: 'type', labels: {}, mode: 'types', datatype: 'type', units: [] },
        { property: 'schema:author', labels: { en: 'Author' }, mode: 'values', datatype: 'wikibase-item', units: [] },
      ],
      initial: {
        status: 'ready',
        page: {
          as_of: page.as_of,
          facets: [{ property: 'schema:author', values: [{ value: 'writer-1', labels: { en: 'Writer' } }], next: null }],
        },
      },
    },
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
    const revert = renderToStaticMarkup(
      createElement(SearchPage, { query: 'Mira', data: pageData(true), locale: 'en' }),
    );
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

test('the live Search filter renders a separate resource-language refinement with current labels and removable absent values', () => {
  const html = renderToStaticMarkup(
    createElement(SearchPage, { query: 'Mira', data: resourceLanguagePageData(), locale: 'en' }),
  );
  const en = options.en;
  const selectedSummary = m.search_constraint_identity_filter(
    { number: '2', label: `${m.search_resource_language({}, en)}: pt-BR` },
    en,
  );
  const date = new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(new Date('2026-11-03T00:00:00.000Z'));
  expect(html).toContain(m.search_resource_language({}, en));
  expect(html).toContain(m.search_resource_language_help({}, en));
  expect(html).toContain(m.search_resource_language_current({ date }, en));
  expect(html).toContain(m.condition_languages_label({}, en));
  expect(html).toContain('日本語');
  expect(html).toContain('lang="ja"');
  expect(html).toContain('name="f.schema:inLanguage"');
  expect(html).toMatch(/<input\b(?=[^>]*name="f\.schema:inLanguage")(?=[^>]*value="pt-BR")(?=[^>]*checked="")[^>]*>/);
  expect(html).toContain(`aria-label="${m.refinement_remove({ value: selectedSummary }, en)}"`);
  expect(html).toContain(m.search_resource_language_clear({}, en));
  expect(html).toContain(m.refinement_more_values({}, en));
  expect(html).not.toContain('count=');
});

test('resource-language refusal, preparation, unavailable and missing-release states keep selected values repairable', () => {
  const stateMessages = [
    [{ status: 'refused', httpStatus: 403, code: 'forbidden' } as const, m.refinement_refused({}, options.en)],
    [
      { status: 'preparing', httpStatus: 202, code: 'index_not_ready' } as const,
      m.search_reader_facets_not_ready({}, options.en),
    ],
    [{ status: 'unavailable', code: 'transport_error' } as const, m.search_reader_facets_unavailable({}, options.en)],
  ] as const;
  for (const [state, message] of stateMessages) {
    const data = resourceLanguagePageData();
    data.refinement = { ...data.refinement!, initial: state };
    data.resourceLanguage = resourceLanguageRefinement(
      data.refinement.properties,
      data.selectedFacets[RESOURCE_LANGUAGE_PROPERTY] ?? [],
      state,
    );
    const html = renderToStaticMarkup(createElement(SearchPage, { query: 'Mira', data, locale: 'en' }));
    expect(html).toContain(message);
    expect(html).toMatch(/<input\b(?=[^>]*name="f\.schema:inLanguage")(?=[^>]*value="pt-BR")(?=[^>]*checked="")[^>]*>/);
  }

  const stale = resourceLanguagePageData();
  stale.refinement = undefined;
  stale.resourceLanguage = resourceLanguageRefinement(
    [],
    stale.selectedFacets[RESOURCE_LANGUAGE_PROPERTY] ?? [],
    { status: 'unavailable', code: 'release_unavailable' },
    false,
  );
  const staleHtml = renderToStaticMarkup(createElement(SearchPage, { query: 'Mira', data: stale, locale: 'en' }));
  expect(staleHtml).toContain(m.search_resource_language_metadata_unavailable({}, options.en));
  expect(staleHtml).toContain(m.search_resource_language_clear({}, options.en));

  const missing = resourceLanguagePageData();
  const refused = { status: 'refused', httpStatus: 404, code: 'property_not_applicable' } as const;
  missing.refinement = { ...missing.refinement!, properties: [], initial: refused };
  missing.resourceLanguage = resourceLanguageRefinement(
    [],
    missing.selectedFacets[RESOURCE_LANGUAGE_PROPERTY] ?? [],
    refused,
  );
  const missingHtml = renderToStaticMarkup(createElement(SearchPage, { query: 'Mira', data: missing, locale: 'en' }));
  expect(missingHtml).toContain(m.search_resource_language_not_applicable({}, options.en));
  expect(missingHtml).toContain(m.search_resource_language_clear({}, options.en));
});

test('owner-only, mixed and catalogue populations retain predicates while exposing only applicable refinements', () => {
  const owner = applicabilityPageData(['collection'], { type: 'none', statement: 'none' }, false, true);
  const ownerHtml = renderToStaticMarkup(createElement(SearchPage, { query: 'Mira', data: owner, locale: 'en' }));
  expect(ownerHtml).toContain('Current public collection');
  expect(ownerHtml).toContain(`href="/en/collections/`);
  expect(ownerHtml).toContain('name="q" value="Mira"');
  expect(ownerHtml).toContain('name="kinds"');
  expect(ownerHtml).toContain(m.search_refinement_owner_only({}, options.en));
  expect(ownerHtml).not.toContain('name="type"');
  expect(ownerHtml).not.toContain('name="f.schema:author"');
  expect(ownerHtml).not.toContain('Author');

  const retained = applicabilityPageData(['collection'], { type: 'none', statement: 'none' }, true);
  const retainedHtml = renderToStaticMarkup(createElement(SearchPage, { query: 'Mira', data: retained, locale: 'en' }));
  expect(retainedHtml).toContain('name="type" value="schema:Book"');
  expect(retainedHtml).toContain('name="f.schema:author" value="writer-1"');
  expect(retainedHtml).toContain(m.search_refinement_not_applicable({}, options.en));

  for (const [kinds, applicability] of [
    [['collection', 'schema:Book'], { type: 'partial', statement: 'partial' }],
    [['schema:Book'], { type: 'all', statement: 'all' }],
  ] as const) {
    const data = applicabilityPageData([...kinds], applicability, true);
    const html = renderToStaticMarkup(createElement(SearchPage, { query: 'Mira', data, locale: 'en' }));
    expect(html).toContain(m.search_subject_type({}, options.en));
    expect(html).toContain('name="type"');
    expect(html).toContain('name="f.schema:author"');
    expect(html).toContain('writer-1');
    if (applicability.type === 'partial') expect(html).toContain(m.search_refinement_partial({}, options.en));
    else expect(html).not.toContain(m.search_refinement_partial({}, options.en));
  }
});

test('mobile Filters heading follows the supplied locale while ambient English differs', async () => {
  const route = createRootRoute({
    component: () =>
      createElement(
        HeaderSearchFilterProvider,
        null,
        createElement(SearchPage, { query: 'Mira', data: resourceLanguagePageData(true), locale: 'zh-Hans' }),
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
  width = 390;
  let root: ReturnType<typeof createRoot> | undefined;
  try {
    await router.load();
    root = createRoot(host);
    await act(async () => root!.render(createElement(RouterProvider, { router })));
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-controls="search-filters"]')!.click());
    await act(async () => Promise.resolve());
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
    expect(mobile?.textContent).toContain(m.search_resource_language({}, zh));
    expect(mobile?.textContent).not.toContain(m.search_filters({}, options.en));
    expect(mobile?.querySelector('input[name="q"]')?.getAttribute('value')).toBe('Mira');
  } finally {
    if (root) await act(async () => root!.unmount());
    host.remove();
    width = 1280;
    setLocale(ambient, { reload: false });
  }
});
