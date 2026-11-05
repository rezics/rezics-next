import { expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HeaderSearchView } from '../src/search/header-search/header-search';
import { initialHeaderSearchState, reduceHeaderSearchState } from '../src/search/header-search/state';
import { loadGlobalHeaderSuggestions } from '../src/search/header-search/suggestions';
import {
  readSubjectSuggestions,
  suggestionResponse,
  validateSuggestQuery,
  type SuggestionResult,
} from '../src/search/suggestions';
import {
  nextSuggestion,
  startTypeahead,
  suggestionErrorState,
  suggestionFailure,
  validSuggestionText,
} from '../src/search/typeahead';
import { requestLanguages } from '../src/kernel/languages';
import { subjectHref } from '../src/subject/subject-href';
import { viewerCredential } from '../src/session/request';
import type { SessionEnv } from '../src/session/client';
import { problem } from '../src/media/kernel';
import { searchFormFields } from '../src/search/search-params';

const native = {
  as_of: '2026-10-31T00:00:00.000Z',
  subjects: [
    { id: '01a17dfd-5dbf-738a-9405-9dfa9a8ec069', type: 'schema:Book', labels: { 'zh-Hans': '小王子' }, summary: null },
  ],
};
const result: SuggestionResult = { ...native, types: { 'schema:Book': { 'zh-Hans': '图书' } } };

function present(state: Parameters<typeof HeaderSearchView>[0]['state']) {
  return renderToStaticMarkup(
    createElement(HeaderSearchView, {
      id: 'search',
      state,
      locale: 'zh-Hans',
      region: null,
      inputProps: { onChange() {} },
    }),
  );
}

test('the visible shell Search consumes its typed native suggestion operation and current labels without counts, permission or per-hit reads', async () => {
  const calls: { url: URL; signal: AbortSignal | null | undefined }[] = [];
  let current = native;
  const client = createKernelClient('http://kernel.local', {
    fetch: async (url, init) => {
      calls.push({ url: new URL(String(url)), signal: init?.signal });
      return Response.json(current);
    },
  });
  const query = { q: '小王', limit: 8, languages: requestLanguages('zh-Hans') };
  const controller = new AbortController();
  const first = await readSubjectSuggestions(client, query, null, controller.signal);
  let state = reduceHeaderSearchState(initialHeaderSearchState(undefined, query.q), { type: 'open-phone' });
  state = reduceHeaderSearchState(state, {
    type: 'suggestions',
    state: 'ready',
    result: { ...first, types: result.types },
  });
  state = reduceHeaderSearchState(state, { type: 'active', index: 0 });
  const html = present(state);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url.pathname).toBe('/v1/subjects:suggest');
  expect(calls[0]!.url.searchParams.get('q')).toBe(query.q);
  expect(calls[0]!.url.searchParams.get('limit')).toBe('8');
  expect(calls[0]!.url.searchParams.getAll('languages')).toEqual(query.languages);
  expect(calls[0]!.signal).toBe(controller.signal);
  expect(html.match(/role="combobox"/g)).toHaveLength(1);
  expect(html).toContain('aria-activedescendant="search-option-0"');
  expect(html).toContain('id="search-option-0" role="option" aria-selected="true"');
  expect(html).toContain(subjectHref({ id: result.subjects[0]!.id, label: '小王子' }, 'zh-Hans').href);
  expect(html).toContain('lang="zh-Hans"');
  expect(html).toContain('图书');
  expect(html).not.toMatch(/Trending|followers|permission|Ask|0 results/);
  // The phone's existing shell slot composes actions before the suggestions, with no second form.
  expect(html.indexOf('type="submit"')).toBeLessThan(html.indexOf('role="listbox"'));
  expect(html).toContain('bg-popover');
  state = reduceHeaderSearchState(state, { type: 'invalidate' });
  expect(present(state)).not.toContain('role="option"');
  current = { ...native, subjects: [], as_of: '2026-10-31T00:00:01.000Z' };
  const second = await readSubjectSuggestions(client, query, null, controller.signal);
  expect(second.subjects).toEqual([]);
  expect(second.as_of).toBe(current.as_of);
  expect(calls).toHaveLength(2);
});

test('prefix admission uses the actual Unicode, language and limit bounds without truncation or query expansion', async () => {
  const base = { q: 'a', limit: 8, languages: ['ja', 'en'] };
  expect(validSuggestionText('😀'.repeat(64))).toBe(true);
  expect(validSuggestionText('😀'.repeat(65))).toBe(false);
  expect(validSuggestionText('界'.repeat(65))).toBe(false);
  expect(validateSuggestQuery({ ...base, q: '  title & author  ', limit: 10 }).q).toBe('  title & author  ');
  let calls = 0;
  const client = createKernelClient('http://kernel.local', {
    fetch: async () => {
      calls++;
      return Response.json(native);
    },
  });
  for (const query of [
    { ...base, q: '' },
    { ...base, q: '界'.repeat(65) },
    { ...base, q: '😀'.repeat(65) },
    ...[0, 11, 1.5].map((limit) => ({ ...base, limit })),
    ...[[], ['en', 'en'], ['not_a_language'], Array(9).fill('en')].map((languages) => ({ ...base, languages })),
  ])
    await expect(readSubjectSuggestions(client, query, null, new AbortController().signal)).rejects.toHaveProperty(
      'problem.status',
      400,
    );
  expect(calls).toBe(0);
  await readSubjectSuggestions(client, { ...base, limit: 10 }, null, new AbortController().signal);
  expect(calls).toBe(1);
});

function sessionEnv(status: 'active' | 'absent' | 'unavailable'): Partial<SessionEnv> {
  return {
    AUTH_ISSUER: 'https://auth.local',
    API_RESOURCE: 'https://kernel.local',
    WEBSITE_SCOPES: 'subject:read',
    WEBSITE_CLIENT_ID: 'web',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName: (value: string) => value,
      get: () => ({
        credential: async () => ({ status, accessToken: 'server-only', subject: 'reader', csrfToken: 'csrf' }),
      }),
    } as unknown as SessionEnv['SESSIONS'],
  };
}

test('the normal BFF forwards the server session and invalid credentials fail without an anonymous retry or cached private response', async () => {
  const credentials: (string | null)[] = [];
  const client = createKernelClient('http://kernel.local', {
    fetch: async (_url, init) => {
      const credential = new Headers(init?.headers).get('authorization');
      credentials.push(credential);
      return credential === 'Bearer invalid'
        ? Response.json({ code: 'invalid_credentials' }, { status: 401 })
        : Response.json(native);
    },
  });
  const read = async (q: string, request: Request) => ({
    ...(await readSubjectSuggestions(
      client,
      { q, limit: 8, languages: ['en'] },
      viewerCredential(request),
      request.signal,
    )),
    types: result.types,
  });
  const url = 'https://rezics.local/api/search/suggestions?q=Prince';
  const cookie = { cookie: `__Host-rezics_session=${'a'.repeat(43)}` };
  const signedIn = await suggestionResponse(new Request(url, { headers: cookie }), sessionEnv('active'), read);
  expect(signedIn.status).toBe(200);
  expect(signedIn.headers.get('cache-control')).toBe('private, no-store');
  expect(await signedIn.text()).not.toContain('server-only');
  const denied = await suggestionResponse(new Request(url, { headers: { authorization: 'Bearer invalid' } }), {}, read);
  expect(denied.status).toBe(401);
  expect(await denied.json()).toHaveProperty('code', 'invalid_credentials');
  expect(credentials).toEqual(['Bearer server-only', 'Bearer invalid']);
  for (const status of ['absent', 'unavailable'] as const) {
    const response = await suggestionResponse(new Request(url, { headers: cookie }), sessionEnv(status), read);
    expect(response.status).toBe(status === 'absent' ? 401 : 502);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  }
  expect(credentials).toHaveLength(2);
  const publicRead = await suggestionResponse(new Request(url), {}, read);
  expect(publicRead.status).toBe(200);
  expect(credentials).toEqual(['Bearer server-only', 'Bearer invalid', null]);
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
test('debouncing, retyping and closing fence stale responses even when a producer ignores cancellation', async () => {
  const calls: string[] = [];
  const shown: SuggestionResult[] = [];
  const failures: string[] = [];
  let finish!: (result: SuggestionResult) => void;
  const load = async (q: string) => {
    calls.push(q);
    return q === 'old'
      ? new Promise<SuggestionResult>((resolve) => {
          finish = resolve;
        })
      : result;
  };
  const cancelledBeforeDebounce = startTypeahead(
    load,
    'unused',
    'en',
    undefined,
    (value) => shown.push(value),
    (state) => failures.push(state),
    1,
  );
  cancelledBeforeDebounce();
  const stale = startTypeahead(
    load,
    'old',
    'en',
    undefined,
    (value) => shown.push(value),
    (state) => failures.push(state),
    1,
  );
  await tick();
  stale();
  const latest = startTypeahead(
    load,
    'current',
    'en',
    undefined,
    (value) => shown.push(value),
    (state) => failures.push(state),
    1,
  );
  await tick();
  finish({ ...result, subjects: [] });
  await tick();
  expect(calls).toEqual(['old', 'current']);
  expect(shown).toEqual([result]);
  expect(failures).toEqual([]);
  latest();
  const closed = startTypeahead(
    load,
    'closed',
    'en',
    undefined,
    (value) => shown.push(value),
    (state) => failures.push(state),
    1,
  );
  closed();
  await tick();
  expect(calls).toEqual(['old', 'current']);
});

test('keyboard wrapping and plain GET submission retain current conditions without an old cursor', () => {
  expect(nextSuggestion('ArrowDown', -1, 2)).toBe(0);
  expect(nextSuggestion('ArrowUp', -1, 2)).toBe(1);
  expect(nextSuggestion('ArrowDown', 1, 2)).toBe(0);
  expect(nextSuggestion('ArrowUp', 0, 2)).toBe(1);
  expect(nextSuggestion('ArrowDown', -1, 0)).toBeUndefined();
  let state = reduceHeaderSearchState(initialHeaderSearchState(undefined, 'Prince & fox'), { type: 'open-phone' });
  state = reduceHeaderSearchState(state, { type: 'suggestions', state: 'error' });
  const fields = searchFormFields({ type: 'schema:Book', sort: 'rating', 'f.schema:genre': ['fable'], cursor: 'old' });
  const html = renderToStaticMarkup(
    createElement(HeaderSearchView, {
      id: 'search',
      state,
      fields,
      locale: 'en',
      region: null,
      inputProps: { onChange() {} },
    }),
  );
  expect(html).toMatch(/<form\b[^>]*method="get"/);
  expect(html).toMatch(/<form\b[^>]*action="\/en\/search"/);
  expect(html).toContain('name="q"');
  expect(html).toContain('value="Prince &amp; fox"');
  expect(html).toContain('name="type" value="schema:Book"');
  expect(html).toContain('name="sort" value="rating"');
  expect(html).not.toContain('name="cursor"');
  expect(html).not.toContain('aria-activedescendant');
});

test('genuine empty, loading, closed, preparing, restart, credentials and unavailable states remain distinct and never display stale hits', async () => {
  const states = [
    'empty',
    'loading',
    'error',
    'closed',
    'preparing',
    'restart',
    'credentials',
    'invalid',
    'unavailable',
  ] as const;
  const output = states.map((suggestions) =>
    present({ ...initialHeaderSearchState(undefined, 'Prince'), expanded: true, suggestions, result, activeIndex: 0 }),
  );
  expect(new Set(output).size).toBe(states.length);
  for (const html of output) {
    expect(html).not.toContain('role="option"');
    expect(html).not.toContain('aria-activedescendant');
  }
  expect(suggestionFailure(403, 'platform_closed')).toBe('closed');
  expect(suggestionFailure(409, 'search_restart_required')).toBe('restart');
  expect(suggestionFailure(503, 'index_not_ready')).toBe('preparing');
  expect(suggestionFailure(503)).toBe('unavailable');
  expect(suggestionFailure(401, 'invalid_credentials')).toBe('credentials');
  expect(suggestionErrorState(new TypeError('Network failed'))).toBe('error');
  // Exercise the real browser boundary; a native problem keeps its status instead of becoming an empty list.
  const original = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ code: 'platform_closed' }, { status: 403 })) as typeof fetch;
  try {
    await expect(loadGlobalHeaderSuggestions('Prince', 'en', new AbortController().signal)).rejects.toMatchObject(
      problem(403, 'platform_closed', 'Suggestions failed'),
    );
  } finally {
    globalThis.fetch = original;
  }
});
