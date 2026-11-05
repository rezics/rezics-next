import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HeaderSearch, HeaderSearchView } from '../src/search/header-search/header-search';
import { headerSearchAction, removesHeaderScope } from '../src/search/header-search/authority';
import {
  initialHeaderSearchState,
  reduceHeaderSearchState,
  type HeaderSearchState,
} from '../src/search/header-search/state';
import {
  HEADER_SUGGESTION_LIMIT,
  loadGlobalHeaderSuggestions,
  readHeaderSuggestions,
} from '../src/search/header-search/suggestions';
import type { SearchScope } from '../src/search/header-search/types';
import type { SuggestionResult } from '../src/search/suggestions';
import { searchFormFields } from '../src/search/search-params';
import { m } from '../src/paraglide/messages.js';
import { getLocale, locales, setLocale } from '../src/paraglide/runtime.js';
import { RecentPanel } from '../src/search/recent-panel';
import type { RecentHistory } from '../src/search/recent-history';

const scope: SearchScope = { kind: 'Collection', id: 'reading', name: 'Reading list' };
const result: SuggestionResult = {
  as_of: '2026-10-27T11:31:57.344Z',
  subjects: [
    {
      id: '01a17dfd-5dbf-738a-9405-9dfa9a8ec069',
      type: 'schema:Book',
      labels: { en: 'The Little Prince', 'zh-Hans': '小王子' },
      summary: null,
    },
  ],
  types: { 'schema:Book': { en: 'Book', 'zh-Hans': '图书' } },
};
function present(state: HeaderSearchState, extra: Partial<Parameters<typeof HeaderSearchView>[0]> = {}) {
  return renderToStaticMarkup(
    createElement(HeaderSearchView, { id: 'header', state, locale: 'en', region: null, ...extra }),
  );
}
function inputCount(markup: string) {
  return (markup.match(/<input\b[^>]*role="combobox"/g) ?? []).length;
}

test('Recent omits routine storage copy while retaining history actions and truthful recovery states', () => {
  const history: RecentHistory = {
    entries: [{ id: 'recent', query: 'Kokoro', visitedAt: 1 }],
    persistence: 'local',
    sync: 'local-only',
    remember() {},
    remove() {},
    retry() {},
  };
  const render = (extra: Partial<RecentHistory>) =>
    renderToStaticMarkup(createElement(RecentPanel, { history: { ...history, ...extra }, global: false }));
  for (const persistence of ['local', 'memory'] as const) {
    const markup = render({ persistence });
    expect(markup).not.toContain(m.header_search_history_local());
    expect(markup).not.toContain(m.header_search_history_memory());
    expect(markup).toContain(m.header_search_history());
    expect(markup).toContain('Kokoro');
    expect(markup).toContain(m.header_search_remove_recent({ name: 'Kokoro' }));
  }
  for (const [state, message] of [
    [{ failure: 'conflict' }, m.search_history_conflict()],
    [{ failure: 'unavailable' }, m.search_history_offline()],
    [{ persistence: 'unavailable' }, m.shell_account_unavailable()],
    [{ persistence: 'memory', sync: 'pending' }, m.header_search_history_pending()],
  ] satisfies [Partial<RecentHistory>, string][]) {
    const markup = render(state);
    expect(markup).toContain(message);
    expect(markup).toContain('Kokoro');
    if ('failure' in state) expect(markup).toContain(m.search_history_reload());
  }
});

test('the phone trigger name keeps its exact visible localized brand, query or scope text with a separate localized shortcut description', () => {
  const previousLocale = getLocale();
  try {
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      let state = initialHeaderSearchState();
      const named = (label: string, keyboardShortcut = false) => {
        const markup = present(state, { locale, keyboardShortcut });
        const trigger = markup.match(/<button\b[^>]*class="header-search-trigger[^>]*>[\s\S]*?<\/button>/)?.[0];
        expect(trigger).toBeDefined();
        expect(trigger).toContain('type="button"');
        const triggerName = keyboardShortcut ? `${label} Ctrl/⌘ K` : label;
        const expectedName = renderToStaticMarkup(createElement('button', { 'aria-label': triggerName }));
        const attributeValue = (element: string, name: string) =>
          element.match(new RegExp(`\\b${name}="([^"]*)"`, 'u'))?.[1];
        expect(attributeValue(trigger, 'aria-label')).toBe(attributeValue(expectedName, 'aria-label'));
        expect(trigger).not.toContain('aria-labelledby=');
        expect(trigger).toContain(renderToStaticMarkup(createElement('span', { className: 'truncate' }, label)));
        const input = markup.match(/<input\b(?=[^>]*role="combobox")[^>]*>/)?.[0];
        expect(input).toBeDefined();
        expect(input).toContain(`aria-label="${m.search_label()}"`);
        if (keyboardShortcut) {
          expect(trigger).toContain('>Ctrl/⌘ K</kbd>');
          expect(trigger).toContain('aria-describedby="header-keyboard-help"');
          expect(trigger).toContain('aria-keyshortcuts="Control+k Meta+k"');
          expect(markup).toContain(
            `id="header-keyboard-help" class="sr-only">${m.header_search_keyboard_help()}</span>`,
          );
        } else {
          expect(trigger).not.toContain('aria-describedby=');
        }
        expect(trigger).toContain('<svg aria-hidden="true"');
        expect(inputCount(markup)).toBe(1);
      };
      named(m.header_search_global());
      named(m.header_search_global(), true);
      state = reduceHeaderSearchState(state, { type: 'sync-scope', scope });
      named(m.header_search_in_scope({ scope: scope.name }));
      named(m.header_search_in_scope({ scope: scope.name }), true);
      state = reduceHeaderSearchState(state, { type: 'open-phone' });
      state = reduceHeaderSearchState(state, { type: 'query', query: 'Prince & fox' });
      named('Prince & fox', true);
      state = reduceHeaderSearchState(state, { type: 'escape' });
      named('Prince & fox');
      named('Prince & fox', true);
      const quotedQuery = `Prince "the fox" & reader's book`;
      state = reduceHeaderSearchState(state, { type: 'query', query: quotedQuery });
      named(quotedQuery);
      named(quotedQuery, true);
      state = reduceHeaderSearchState(state, { type: 'query', query: '' });
      named(m.header_search_in_scope({ scope: scope.name }));
      named(m.header_search_in_scope({ scope: scope.name }), true);
      state = reduceHeaderSearchState(state, { type: 'remove-scope' });
      named(m.header_search_global());
      named(m.header_search_global(), true);
    }
  } finally {
    setLocale(previousLocale, { reload: false });
  }
});

test('shortcut trigger text has an explicit rendered separator across locale, scope, query and expansion states', () => {
  const previousLocale = getLocale();
  try {
    for (const locale of locales) {
      setLocale(locale, { reload: false });
      const global = initialHeaderSearchState();
      const scoped = initialHeaderSearchState(scope);
      const queried = initialHeaderSearchState(undefined, 'A visible draft');
      const states = [
        global,
        reduceHeaderSearchState(global, { type: 'focus' }),
        scoped,
        reduceHeaderSearchState(scoped, { type: 'focus' }),
        queried,
      ];

      for (const state of states) {
        const markup = present(state, { locale, keyboardShortcut: true });
        const trigger = markup.match(/<button\b[^>]*class="header-search-trigger[^>]*>[\s\S]*?<\/button>/)?.[0];
        const label =
          state.query ||
          (state.scope ? m.header_search_in_scope({ scope: state.scope.name }) : m.header_search_global());
        expect(trigger).toBeDefined();
        expect(trigger).toContain(`aria-label="${label} Ctrl/⌘ K"`);
        expect(trigger).toContain('</span> <kbd');
        expect(trigger).toContain('aria-describedby="header-keyboard-help"');
      }
    }
  } finally {
    setLocale(previousLocale, { reload: false });
  }
});

test('the single input keeps its search purpose name and associates shortcut help and expanded status descriptions', () => {
  const input = (markup: string) => markup.match(/<input\b(?=[^>]*role="combobox")[^>]*>/)?.[0] ?? '';
  const shortcut = { keyboardShortcut: true };

  const globalRest = present(initialHeaderSearchState(), shortcut);
  expect(input(globalRest)).toContain(`aria-label="${m.search_label()}"`);
  expect(input(globalRest)).toContain(`placeholder="${m.header_search_global()}"`);
  expect(input(globalRest)).toContain('aria-describedby="header-keyboard-help"');
  expect(globalRest).toContain(m.header_search_keyboard_help());

  let globalExpanded = reduceHeaderSearchState(initialHeaderSearchState(), { type: 'focus' });
  globalExpanded = reduceHeaderSearchState(globalExpanded, { type: 'suggestions', state: 'loading' });
  const loading = present(globalExpanded, shortcut);
  expect(input(loading)).toContain(`aria-label="${m.search_label()}"`);
  expect(input(loading)).toContain(`placeholder="${m.header_search_global()}"`);
  expect(input(loading)).toContain('aria-describedby="header-keyboard-help header-status"');
  expect(loading).toContain(`id="header-status" role="status"`);
  expect(loading).toContain(m.header_search_loading());
  expect(inputCount(loading)).toBe(1);

  let scoped = reduceHeaderSearchState(initialHeaderSearchState(scope), { type: 'focus' });
  scoped = reduceHeaderSearchState(scoped, { type: 'query', query: 'Prince & fox' });
  const scopedExpanded = present(scoped, { ...shortcut, locale: 'en' });
  expect(input(scopedExpanded)).toContain(`aria-label="${m.search_label()}"`);
  expect(input(scopedExpanded)).toContain(`placeholder="${m.header_search_in_scope({ scope: scope.name })}"`);
  expect(input(scopedExpanded)).toContain('aria-describedby="header-keyboard-help header-status"');
  expect(scopedExpanded).toContain(m.header_search_scope_unavailable());
  expect(inputCount(scopedExpanded)).toBe(1);

  const collapsed = reduceHeaderSearchState(scoped, { type: 'escape' });
  const scopedCollapsed = present(collapsed, shortcut);
  expect(input(scopedCollapsed)).toContain(`aria-label="${m.search_label()}"`);
  expect(input(scopedCollapsed)).toContain(`placeholder="${m.header_search_in_scope({ scope: scope.name })}"`);
  expect(inputCount(scopedCollapsed)).toBe(1);

  const phone = reduceHeaderSearchState(initialHeaderSearchState(undefined, 'Prince'), { type: 'open-phone' });
  const phoneSheet = present(phone, shortcut);
  expect(phoneSheet).toContain('role="dialog" aria-modal="true"');
  expect(input(phoneSheet)).toContain(`aria-label="${m.search_label()}"`);
  expect(input(phoneSheet)).toContain('aria-describedby="header-keyboard-help"');
  expect(inputCount(phoneSheet)).toBe(1);
});

test('one actual query surface renders and transitions through scoped expanded and failure states without a duplicate input or authority widening', async () => {
  let state = initialHeaderSearchState(scope);
  expect(inputCount(present(state))).toBe(1);
  expect(headerSearchAction('en', state.scope)).toBeUndefined();
  state = reduceHeaderSearchState(state, { type: 'focus' });
  expect(state.expanded).toBe(true);
  expect(present(state)).toContain(m.header_search_scope_unavailable());
  state = reduceHeaderSearchState(state, { type: 'query', query: 'Prince' });
  const scopedMarkup = present(state);
  expect(inputCount(scopedMarkup)).toBe(1);
  expect(scopedMarkup).not.toContain('name="q"');
  expect(headerSearchAction('en', state.scope)).toBeUndefined();
  // Backspace with text cannot widen authority.
  expect(removesHeaderScope('Backspace', state.query, state.scope)).toBe(false);
  state = reduceHeaderSearchState(state, { type: 'query', query: '' });
  expect(removesHeaderScope('Backspace', state.query, state.scope)).toBe(true);
  state = reduceHeaderSearchState(state, { type: 'remove-scope' });
  expect(headerSearchAction('en', state.scope)).toBe('/en/search');
  state = reduceHeaderSearchState(state, { type: 'query', query: 'Prince' });
  expect(state.suggestions).toBe('loading');
  expect(present(state)).toContain(m.header_search_loading());
  const error = new Error('Suggestion service unavailable');
  try {
    await readHeaderSuggestions(
      async () => {
        throw error;
      },
      state.query,
      'en',
      new AbortController().signal,
    );
  } catch (caught) {
    expect(caught).toBe(error);
    state = reduceHeaderSearchState(state, { type: 'suggestions', state: 'error' });
  }
  const failed = present(state);
  expect(inputCount(failed)).toBe(1);
  expect(failed).toContain(m.search_suggestions_failed());
  expect(failed).toContain('value="Prince"');
  expect(failed).toContain('action="/en/search"');
  expect(failed).not.toContain('role="option"');
  state = reduceHeaderSearchState(state, { type: 'escape' });
  expect(state.expanded).toBe(false);
  expect(state.query).toBe('Prince');
  expect(inputCount(present(state))).toBe(1);
});

describe('bounded suggestion boundary', () => {
  test('keeps the original eight-item cap without per-item operations', async () => {
    let calls = 0;
    const oversized = {
      ...result,
      subjects: Array.from({ length: 10 }, (_, index) => ({
        ...result.subjects[0]!,
        id: `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
      })),
    };
    const limited = await readHeaderSuggestions(
      async (query, locale, signal) => {
        calls++;
        expect(query).toBe('Prince');
        expect(locale).toBe('zh-Hans');
        expect(signal.aborted).toBe(false);
        return oversized;
      },
      'Prince',
      'zh-Hans',
      new AbortController().signal,
    );
    expect(limited.subjects).toHaveLength(HEADER_SUGGESTION_LIMIT);
    expect(calls).toBe(1);
    expect(oversized.subjects).toHaveLength(10);
    let state = reduceHeaderSearchState(initialHeaderSearchState(), {
      type: 'suggestions',
      state: 'ready',
      result: limited,
    });
    for (const event of [{ type: 'focus' }, { type: 'outside' }, { type: 'open-phone' }, { type: 'escape' }] as const)
      state = reduceHeaderSearchState(state, event);
    expect(calls).toBe(1);
    expect(state.result?.subjects).toHaveLength(8);
  });
  test('rejects a late response even when its producer ignores abort', async () => {
    const controller = new AbortController();
    let finish!: (value: SuggestionResult) => void;
    const late = readHeaderSuggestions(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      'old',
      'en',
      controller.signal,
    );
    controller.abort();
    finish(result);
    await expect(late).rejects.toHaveProperty('name', 'AbortError');
    const current = await readHeaderSuggestions(async () => result, 'new', 'en', new AbortController().signal);
    expect(current.subjects).toEqual(result.subjects);
  });
  test('never sends a scoped query to the global suggestion operation', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    const requests: { url: string; signal: AbortSignal | null | undefined }[] = [];
    globalThis.fetch = (async (url, options) => {
      requests.push({ url: String(url), signal: options?.signal });
      calls++;
      return Response.json(result);
    }) as typeof fetch;
    try {
      await expect(loadGlobalHeaderSuggestions('Prince', 'en', new AbortController().signal, scope)).rejects.toThrow(
        'Scoped suggestions are unavailable',
      );
      expect(calls).toBe(0);
      const controller = new AbortController();
      await readHeaderSuggestions(loadGlobalHeaderSuggestions, 'Prince & fox', 'zh-Hans', controller.signal);
      expect(calls).toBe(1);
      expect(requests).toEqual([
        { url: '/api/search/suggestions?q=Prince%20%26%20fox&locale=zh-Hans', signal: controller.signal },
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

test('retains named facet values and sort, while dropping the cursor on a changed query', () => {
  const fields = searchFormFields({
    q: 'old',
    type: 'schema:Book',
    sort: 'rating',
    cursor: 'old-page',
    'f.schema:genre': ['fable', 'novel'],
    unsupported: 'ignored',
  });
  expect(fields).toEqual([
    ['type', 'schema:Book'],
    ['sort', 'rating'],
    ['f.schema:genre', 'fable'],
    ['f.schema:genre', 'novel'],
  ]);
  const markup = present(initialHeaderSearchState(undefined, 'Prince'), { fields, locale: 'zh-Hans' });
  expect(markup).toContain('method="get" action="/zh-Hans/search"');
  expect(markup).toContain('name="f.schema:genre" value="fable"');
  expect(markup).not.toContain('name="cursor"');
  expect(markup).not.toContain('name="unsupported"');
});

test('the real controller server-renders one native GET query input and no extra action', () => {
  const markup = renderToStaticMarkup(createElement(HeaderSearch, { locale: 'en', slots: { ask: null } }));
  expect(inputCount(markup)).toBe(1);
  expect(markup).toContain('name="q"');
  expect(markup).toContain('method="get" action="/en/search"');
  expect(markup).not.toContain('aria-label="Ask"');
  expect(markup).not.toContain('disabled=""');
});

test('ready suggestions keep localized canonical targets and each member type frame', () => {
  const mixed: SuggestionResult = {
    ...result,
    subjects: [...result.subjects, { id: 'person', type: 'schema:Person', labels: { en: 'Reader' }, summary: null }],
  };
  let state = reduceHeaderSearchState(initialHeaderSearchState(), { type: 'focus' });
  state = reduceHeaderSearchState(state, { type: 'suggestions', state: 'ready', result: mixed });
  state = reduceHeaderSearchState(state, { type: 'active', index: 0 });
  const markup = present(state, { locale: 'zh-Hans' });
  expect(inputCount(markup)).toBe(1);
  expect(markup).toContain('/zh-Hans/subjects/01a17dfd-5dbf-738a-9405-9dfa9a8ec069/');
  expect(markup).toContain('lang="zh-Hans"');
  expect(markup).toContain('aria-activedescendant="header-option-0"');
  expect(markup).toContain('aria-selected="true"');
  expect(markup).toContain('data-ratio="5:7"');
  expect(markup).toContain('data-ratio="3:4"');
});

test('phone sheet and unavailable filters preserve the same input and query', () => {
  let state = initialHeaderSearchState(undefined, 'Prince');
  state = reduceHeaderSearchState(state, { type: 'open-phone' });
  const markup = present(state);
  expect(inputCount(markup)).toBe(1);
  expect(markup).toContain('role="dialog" aria-modal="true"');
  expect(markup).toContain(m.header_search_filters_unavailable());
  state = reduceHeaderSearchState(state, { type: 'outside' });
  expect(state.phoneSheet).toBe(false);
  expect(state.query).toBe('Prince');
});

// These exercise the shipped presenter and bounded history boundary without starting a service.
test('empty phone composer exposes Recent and a real filter button without invented discovery or a screen focus ring', () => {
  const state = reduceHeaderSearchState(initialHeaderSearchState(), { type: 'open-phone' });
  const markup = present(state, { region: { activeCount: 2, open() {} } });
  expect(inputCount(markup)).toBe(1);
  expect(markup).toContain('data-search-composer');
  expect(markup).toContain(m.header_search_recent());
  expect(markup).toContain(m.header_search_history());
  expect(markup).toContain(m.search_filters());
  expect(markup).not.toContain(m.header_search_trending_searches());
  expect(markup).not.toContain(m.header_search_trending_communities());
  expect(markup).not.toContain(m.header_search_popular_realms());
  expect(markup).not.toContain('focus-within:border-ring');
  expect(markup.indexOf(m.search_filters())).toBeLessThan(markup.indexOf(m.header_search_recent()));
});

test('recent history is bounded and isolated per account and guest, rejects corrupt scopes and preserves native scoped authority', async () => {
  const { recentBucket, readRecentHistory, rememberRecent, writeRecentHistory, RECENT_HISTORY_LIMIT } =
    await import('../src/search/recent-history');
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const alice = recentBucket('signed-in', 'alice')!;
  const bob = recentBucket('signed-in', 'bob')!;
  const guest = recentBucket('signed-out')!;
  expect(recentBucket('unknown', 'alice')).toBeNull();
  expect(recentBucket('unavailable', 'alice')).toBeNull();
  expect(recentBucket('signed-in')).toBeNull();
  let entries = rememberRecent([], 'Private query', scope, 1);
  writeRecentHistory(storage, alice, entries);
  expect(readRecentHistory(storage, bob)).toEqual([]);
  expect(readRecentHistory(storage, guest)).toEqual([]);
  expect(readRecentHistory(storage, alice)[0]?.scope).toEqual(scope);
  // A remembered name never creates search authority.
  expect(headerSearchAction('en', readRecentHistory(storage, alice)[0]?.scope)).toBeUndefined();
  for (let i = 0; i < 50; i++) entries = rememberRecent(entries, `query ${i}`, undefined, i + 2);
  expect(entries).toHaveLength(RECENT_HISTORY_LIMIT);
  entries = rememberRecent(entries, 'query 49');
  expect(entries).toHaveLength(RECENT_HISTORY_LIMIT);
  const removed = entries[0]!.id;
  writeRecentHistory(
    storage,
    alice,
    entries.filter((entry) => entry.id !== removed),
  );
  expect(readRecentHistory(storage, alice).some((entry) => entry.id === removed)).toBe(false);
  const key = [...values.keys()][0]!;
  values.set(
    key,
    JSON.stringify([{ query: 'hidden', visitedAt: 1, scope: { kind: 'unsupported', name: 'Old scope' } }]),
  );
  expect(readRecentHistory(storage, alice)).toEqual([]);
});

test('phone Create consumes shared contextual creation links without exposing navigation leaves or private entries', async () => {
  const { NavigationProvider } = await import('../src/shell/navigation-view');
  const { PhoneCreationLinks } = await import('../src/shell/phone-navigation');
  const { getLocale } = await import('../src/paraglide/runtime.js');
  const locale = getLocale();
  const render = (pathname: string) =>
    renderToStaticMarkup(
      createElement(NavigationProvider, {
        contributions: [
          {
            id: 'fixture.creation',
            kind: 'creation',
            group: 'create',
            order: 0,
            label: 'Contextual creation',
            href: ({ pathname }) => (pathname === '/context' ? '/context/new' : null),
          },
          {
            id: 'fixture.private',
            kind: 'creation',
            group: 'create',
            order: 1,
            label: 'Private creation',
            href: '/private/new',
            signedIn: true,
            operation: 'collection.create',
          },
        ],
        children: createElement(PhoneCreationLinks, { actions: [], pathname, session: 'signed-out' }),
      }),
    );
  const supported = render(`/${locale}/context`);
  expect(supported).toContain(`href="/${locale}/context/new"`);
  expect(supported).toContain('Contextual creation');
  expect(supported).not.toContain('/private/new');
  expect(supported).not.toContain(`href="/${locale}/search"`);
  expect(render('/other')).not.toContain('/context/new');
});

test('phone composer keeps shared failure recovery and never points at a missing suggestion', () => {
  let state = reduceHeaderSearchState(initialHeaderSearchState(undefined, 'Prince'), { type: 'open-phone' });
  state = reduceHeaderSearchState(state, { type: 'suggestions', state: 'ready', result });
  state = reduceHeaderSearchState(state, { type: 'active', index: 0 });
  expect(present(state)).toContain('aria-activedescendant="header-option-0"');
  state = reduceHeaderSearchState(state, { type: 'suggestions', state: 'unavailable' });
  const failed = present(state, { onRetry() {} });
  expect(inputCount(failed)).toBe(1);
  expect(failed).toContain(m.search_suggestions_unavailable());
  expect(failed).toContain(m.search_facet_retry());
  expect(failed).not.toContain('aria-activedescendant=');
  expect(failed).not.toContain('role="option"');
  expect(failed).toContain('value="Prince"');
});

test('recent history round-trips native query text without trimming its meaning', async () => {
  const { rememberRecent, readRecentHistory, writeRecentHistory } = await import('../src/search/recent-history');
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const query = '  Prince  ';
  let entries = rememberRecent([], query);
  entries = rememberRecent(entries, 'Prince');
  expect(entries).toHaveLength(2);
  writeRecentHistory(storage, 'account:reader', entries);
  expect(readRecentHistory(storage, 'account:reader').map((entry) => entry.query)).toEqual(['Prince', query]);
  expect(rememberRecent([], '   ')).toEqual([]);
});

test('the sole phone discovery placement reuses the strict Search Realm reader while preserving lifecycle and request bounds', async () => {
  const { RealmDiscoverySection } = await import('../src/community/realm-discovery');
  const source = await Bun.file(new URL('../src/search/realm-discovery-section.tsx', import.meta.url)).text();
  expect(source).toContain("from '../community/realm-discovery'");
  expect(source).toContain('readRealmDiscovery, type RealmDiscoveryWindow');
  expect(source).not.toContain('createServerFn');
  expect(source).not.toContain('loadRealmDiscovery(');
  expect(source).not.toContain('.realms.discovery.get');
  expect(source).not.toContain('realmDiscoveryProducer');

  let calls = 0;
  const markup = present(reduceHeaderSearchState(initialHeaderSearchState(), { type: 'open-phone' }), {
    locale: 'zh-Hant',
    loadRealmDiscovery: async () => {
      calls++;
      return { kind: 'unavailable' };
    },
  });
  const original = renderToStaticMarkup(
    createElement(RealmDiscoverySection, { sort: 'trending', state: { kind: 'loading' }, locale: 'zh-Hant' }),
  );
  expect(markup).toContain(original);
  expect(markup.match(/data-slot="realm-discovery"/gu) ?? []).toHaveLength(1);
  expect(markup).not.toContain('data-realm-discovery-producer');
  expect(calls).toBe(0);
});

test('the existing global empty-query phone search surface composes the sole native Realm discovery section with one explicit bounded shared-loader request per page while preserving scope Recent filters focus and navigation', async () => {
  const { createSearchRealmDiscoveryPage } = await import('../src/search/realm-discovery-section');
  type State = import('../src/search/realm-discovery-section').RealmDiscoveryState;
  type Request = import('../src/search/realm-discovery-section').SearchRealmDiscoveryRequest;
  type Page = Exclude<State, { kind: 'loading' }>;
  const requests: Request[] = [];
  const completions: ((state: Page) => void)[] = [];
  const states: State[] = [];
  const load = (input: Request) => {
    requests.push(input);
    return new Promise<Page>((resolve) => completions.push(resolve));
  };
  const page = createSearchRealmDiscoveryPage(load, 'zh-Hans', (state) => states.push(state));
  // Constructing the controller or rendering the rest shell does not read discovery.
  expect(requests).toEqual([]);
  expect(present(initialHeaderSearchState(), { loadRealmDiscovery: load })).not.toContain(
    'data-search-realm-discovery',
  );
  const expanded = reduceHeaderSearchState(initialHeaderSearchState(), { type: 'open-phone' });
  const markup = present(expanded, {
    loadRealmDiscovery: load,
    region: { activeCount: 2, open() {} },
    discovery: { popularRealms: [{ id: 'legacy', name: 'Legacy card', description: '', href: '/invented' }] },
  });
  expect(inputCount(markup)).toBe(1);
  expect(markup.match(/data-search-realm-discovery/g) ?? []).toHaveLength(1);
  expect(markup).toContain(m.header_search_recent());
  expect(markup).toContain(m.header_search_history());
  expect(markup).toContain(m.header_search_trending_searches());
  expect(markup).toContain(m.search_filters());
  expect(markup).not.toContain('Legacy card');
  expect(markup).not.toContain('/invented');
  expect(markup.indexOf(m.search_filters())).toBeLessThan(markup.indexOf(m.header_search_recent()));
  expect(requests).toEqual([]);
  for (const hidden of [
    reduceHeaderSearchState(expanded, { type: 'escape' }),
    reduceHeaderSearchState(expanded, { type: 'query', query: 'Prince' }),
    reduceHeaderSearchState(expanded, { type: 'sync-scope', scope }),
  ])
    expect(present(hidden, { loadRealmDiscovery: load })).not.toContain('data-search-realm-discovery');
  expect(present(expanded)).toContain('method="get" action="/en/search"');

  const first = page.start();
  void page.start();
  void page.next();
  void page.retry();
  expect(requests).toEqual([{ locale: 'zh-Hans', sort: 'trending', limit: 20 }]);
  const card = { realmId: 'native-realm', spaceId: 'native-space', name: 'Native', description: '', avatar: null };
  const cursor = 'opaque/native+cursor?sort=trending';
  completions[0]!({ kind: 'ready', realms: [card], next: cursor });
  await first;
  expect(states.at(-1)).toEqual({ kind: 'ready', realms: [card], next: cursor });
  expect(requests).toHaveLength(1);

  const second = page.next();
  void page.next();
  expect(states.at(-1)).toEqual({ kind: 'ready', realms: [card], next: cursor });
  expect(requests[1]).toEqual({ locale: 'zh-Hans', sort: 'trending', cursor, limit: 20 });
  completions[1]!({ kind: 'unavailable' });
  await second;
  expect(states.at(-1)).toEqual({ kind: 'ready', realms: [card], next: cursor });
  const retry = page.retry();
  void page.retry();
  expect(requests[2]).toEqual(requests[1]);
  completions[2]!({ kind: 'ready', realms: [], next: 'empty-with-next' });
  await retry;
  expect(states.at(-1)).toEqual({ kind: 'ready', realms: [card], next: 'empty-with-next' });
  // A sparse page retains its exact continuation and the accumulated public cards.
  await Promise.resolve();
  expect(requests).toHaveLength(3);
  const last = page.next();
  expect(requests[3]).toEqual({ locale: 'zh-Hans', sort: 'trending', cursor: 'empty-with-next', limit: 20 });
  completions[3]!({ kind: 'ready', realms: [], next: null });
  await last;
  void page.next();
  expect(states.at(-1)).toEqual({ kind: 'ready', realms: [card], next: null });
  expect(requests).toHaveLength(4);
  page.dispose();
});

test('Realm discovery disposal fences late success and failure across dismissal, scope, query, navigation and locale changes', async () => {
  const { createSearchRealmDiscoveryPage } = await import('../src/search/realm-discovery-section');
  type State = import('../src/search/realm-discovery-section').RealmDiscoveryState;
  type Page = Exclude<State, { kind: 'loading' }>;
  for (const change of ['dismiss', 'scope', 'query', 'navigate', 'locale']) {
    for (const failure of [false, true]) {
      const states: State[] = [];
      const deferred = Promise.withResolvers<Page>();
      let calls = 0;
      const page = createSearchRealmDiscoveryPage(
        async () => {
          calls++;
          return deferred.promise;
        },
        'en',
        (state) => states.push(state),
      );
      const request = page.start();
      page.dispose();
      if (failure) deferred.reject(new Error(change));
      else deferred.resolve({ kind: 'ready', realms: [], next: 'stale' });
      await request;
      void page.start();
      void page.next();
      void page.retry();
      expect(calls).toBe(1);
      expect(states).toEqual([{ kind: 'loading' }]);
    }
  }
  const closed: State[] = [];
  const page = createSearchRealmDiscoveryPage(
    async () => ({ kind: 'closed' }),
    'en',
    (state) => closed.push(state),
  );
  await page.start();
  void page.retry();
  expect(closed).toEqual([{ kind: 'loading' }, { kind: 'closed' }]);
});
