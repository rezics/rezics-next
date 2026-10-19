import { expect, test } from 'bun:test';
import { readBrowseSuggestions } from './search-recovery-read.ts';
import type { MainClient } from './types.ts';

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
