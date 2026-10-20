import { expect, test } from 'bun:test';
import { direction } from '@rezics/main/language';
import { readBrowseSuggestions } from './search-recovery-read.ts';
import type { MainClient } from './types.ts';
import type { TypeaheadItem } from '../search/suggest.ts';

test('related-name preview is bounded and keeps an unavailable dependency distinct from no suggestions', async () => {
  const calls: unknown[] = [];
  const main = { v1: { search: { typeahead: { async get(input: unknown) {
    calls.push(input);
    return { data: null, error: { status: 503, value: { code: 'search_unavailable' } } };
  } } } } } as unknown as MainClient;
  expect(await readBrowseSuggestions(main, 'prejudise', 'ja')).toEqual({ ok: false, failure: 'unavailable' });
  expect(calls).toEqual([{ query: { prefix: 'pre', language: 'ja' } }, { query: { prefix: 'pr', language: 'ja' } }]);
});

test('unsupported suggestions stay unsupported and do not manufacture an alternative', async () => {
  const main = { v1: { search: { typeahead: { async get() {
    return { data: null, error: { status: 400, value: { code: 'unsupported_query_shape' } } };
  } } } } } as unknown as MainClient;
  expect(await readBrowseSuggestions(main, '雨夜', 'zh-Hans')).toEqual({ ok: false, failure: 'unsupported' });
});

test('disclosed near titles and credited names become distinct bounded alternatives', async () => {
  const item: TypeaheadItem = { work: 'https://rezics.com/id/00000000-0000-4000-8000-000000000001',
    mainVersion: 'https://rezics.com/id/00000000-0000-4000-8000-000000000002',
    title: { value: 'Pride and Prejudice', language: 'en', direction: direction('en', 'Pride and Prejudice'), basis: 'requested' },
    cover: { kind: 'fallback', policy: 'avatar-fallback-v1', key: 'book', resourceType: 'work' },
    types: ['https://schema.org/Book'], authors: [], matchedField: 'title', matchedText: 'Pride and Prejudice',
    matchedLanguage: 'en' };
  const main = { v1: { search: { typeahead: { async get() {
    return { error: null, data: { profile: 'public-work-typeahead-v1', hasMore: true,
      sourcePosition: { dataEpoch: 'test', sequence: '1' }, items: [item,
        { ...item, matchedField: 'credit', matchedText: 'Prejudice Reading Circle' }] } };
  } } } } } as unknown as MainClient;
  expect(await readBrowseSuggestions(main, 'prejudise', 'en')).toEqual({ ok: true,
    suggestions: [{ kind: 'work', item }, { kind: 'name', name: 'Prejudice Reading Circle', language: 'en' }] });
});
