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

const idFor = (index: number) => `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`;
const row = (index: number): SuggestionResult['subjects'][number] => ({
  id: idFor(index),
  type: 'schema:Book',
  labels: { en: `Book ${index}`, 'zh-Hans': '小王子' },
  summary: index === 0 ? { id: idFor(0), type: 'schema:Book', types: ['schema:Book'], label: null, creativeWork: true, cover: null } : null,
  ...(index === 0 ? { facts: { 'schema:datePublished': [{ kind: 'time' as const, year: 1943 }] } } : {}),
});
const page = (subjects: SuggestionResult['subjects']): SuggestionResult => ({
  as_of: '2026-10-31T00:00:00.000Z',
  subjects,
  types: { 'schema:Book': { en: 'Book', 'zh-Hans': '图书' } },
});
const render = (state: Parameters<typeof HeaderSearchView>[0]['state']) =>
  renderToStaticMarkup(createElement(HeaderSearchView, { id: 'search', state, locale: 'en', region: null, inputProps: { onChange() {} } }));

test('malformed pages become the recoverable error and a healthy retry renders suggestions', async () => {
  const responses = [
    Response.json({ ...page([]), subjects: null }),
    Response.json({ ...page([]), subjects: [{ id: idFor(0), type: 'schema:Book', labels: { en: 4 }, summary: null }] }),
    Response.json(page([row(0)])),
  ];
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return responses.shift()!;
  }) as typeof fetch;
  try {
    let state = reduceHeaderSearchState(initialHeaderSearchState(undefined, 'Book'), { type: 'focus' });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await readHeaderSuggestions(loadGlobalHeaderSuggestions, 'Book', 'en', new AbortController().signal);
      } catch (error) {
        expect(suggestionErrorState(error)).toBe('error');
        state = reduceHeaderSearchState(state, { type: 'suggestions', state: 'error' });
      }
      expect(render(state)).toContain(m.search_suggestions_failed());
    }
    const healthy = await readHeaderSuggestions(loadGlobalHeaderSuggestions, 'Book', 'en', new AbortController().signal);
    expect(healthy.subjects[0]?.labels).toEqual(row(0).labels);
    state = reduceHeaderSearchState(state, { type: 'suggestions', state: 'ready', result: healthy });
    expect(render(state)).toContain(subjectHref({ id: idFor(0), label: 'Book 0' }, 'en').href);
    expect(calls).toBe(3);
  } finally {
    globalThis.fetch = original;
  }
});

test('empty and populated native pages preserve metadata and the eight-item browser cap', async () => {
  const responses = [Response.json(page([])), Response.json(page(Array.from({ length: 10 }, (_, index) => row(index))))];
  const original = globalThis.fetch;
  globalThis.fetch = (async () => responses.shift()!) as typeof fetch;
  try {
    expect((await loadGlobalHeaderSuggestions('Book', 'en', new AbortController().signal)).subjects).toEqual([]);
    const populated = await readHeaderSuggestions(loadGlobalHeaderSuggestions, 'Book', 'en', new AbortController().signal);
    expect(populated.subjects).toHaveLength(8);
    expect(populated.subjects[0]).toEqual(row(0));
    let state = reduceHeaderSearchState(initialHeaderSearchState(undefined, 'Book'), { type: 'focus' });
    state = reduceHeaderSearchState(state, { type: 'suggestions', state: 'ready', result: populated });
    expect(render(state)).toContain('Book 0');
    expect(render(state)).toContain('图书');
  } finally {
    globalThis.fetch = original;
  }
});
