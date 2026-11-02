import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { m } from '../src/paraglide/messages.js';
import { subjectHref } from '../src/subject/subject-href';
import { HeaderSearchView } from '../src/search/header-search/header-search';
import { initialHeaderSearchState, reduceHeaderSearchState } from '../src/search/header-search/state';
import { loadGlobalHeaderSuggestions, readHeaderSuggestions } from '../src/search/header-search/suggestions';
import type { SuggestionResult } from '../src/search/suggestions';
import { suggestionErrorState } from '../src/search/typeahead';

const id = (index: number) => `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`;
const row = (index: number): SuggestionResult['subjects'][number] => ({
  id: id(index), type: 'schema:Book', labels: { en: `Book ${index}`, 'zh-Hans': '小王子' },
  summary: index === 0 ? { id: id(0), type: 'schema:Book', types: ['schema:Book'], label: null, creativeWork: true, cover: null } : null,
  ...(index === 0 ? { facts: { 'schema:datePublished': [{ kind: 'time' as const, year: 1943 }] } } : {}),
});
const page = (subjects: SuggestionResult['subjects']): SuggestionResult => ({
  as_of: '2026-10-31T00:00:00.000Z', subjects, types: { 'schema:Book': { en: 'Book', 'zh-Hans': '图书' } },
});
const render = (state: Parameters<typeof HeaderSearchView>[0]['state']) => renderToStaticMarkup(
  createElement(HeaderSearchView, { id: 'search', state, locale: 'en', region: null, inputProps: { onChange() {} } }),
);

test('malformed pages recover, while native empty and populated pages keep metadata, navigation and the eight-item cap', async () => {
  const subjects = Array.from({ length: 10 }, (_, index) => row(index));
  const responses = [
    Response.json({ ...page([]), subjects: null }),
    Response.json({ ...page([]), subjects: [{ id: id(0), type: 'schema:Book', labels: { en: 4 }, summary: null }] }),
    Response.json(page([])), Response.json(page(subjects)),
  ];
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return responses.shift()!; }) as typeof fetch;
  try {
    let state = reduceHeaderSearchState(initialHeaderSearchState(undefined, 'Book'), { type: 'focus' });
    for (let attempt = 0; attempt < 2; attempt++) {
      const failure = await readHeaderSuggestions(loadGlobalHeaderSuggestions, 'Book', 'en', new AbortController().signal)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(TypeError);
      expect(suggestionErrorState(failure)).toBe('error');
      state = reduceHeaderSearchState(state, { type: 'suggestions', state: 'error' });
      expect(render(state)).toContain(m.search_suggestions_failed());
    }
    expect((await loadGlobalHeaderSuggestions('Book', 'en', new AbortController().signal)).subjects).toEqual([]);
    const healthy = await readHeaderSuggestions(loadGlobalHeaderSuggestions, 'Book', 'en', new AbortController().signal);
    expect(healthy.subjects).toHaveLength(8);
    expect(healthy.subjects[0]).toEqual(subjects[0]);
    state = reduceHeaderSearchState(state, { type: 'suggestions', state: 'ready', result: healthy });
    expect(render(state)).toContain(subjectHref({ id: id(0), label: 'Book 0' }, 'en').href);
    expect(render(state)).toContain('图书');
    expect(calls).toBe(4);
  } finally {
    globalThis.fetch = original;
  }
});
