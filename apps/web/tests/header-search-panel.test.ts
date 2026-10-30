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
      subjects: Array.from({ length: 40 }, (_, index) => ({ ...result.subjects[0]!, id: `subject-${index}` })),
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
    expect(oversized.subjects).toHaveLength(40);
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
