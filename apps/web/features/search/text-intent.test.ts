import { expect, test } from 'bun:test';
import { phraseStatus, searchText } from './state.ts';
import { browseHref, changeBrowse, emptyBrowse, parseBrowseState } from '../discover/browse-state.ts';
import { seedServedTypes } from '../catalogue/type-fixtures.ts';
import { discoverSearchUrl } from './redirect.ts';

test('ordinary terms retain keyword intent and only paired explicit quotes select a phrase', () => {
  expect(searchText(' library  night ')).toEqual({ keywords: 'library night' });
  expect(searchText('"library night"')).toEqual({ phrase: 'library night' });
  expect(searchText('"library night')).toEqual({ keywords: '"library night' });
  expect(searchText('雨')).toEqual({ keywords: '雨' });
  expect(searchText('"雨"')).toEqual({ phrase: '雨' });
  expect(searchText('cafe\u0301 夜')).toEqual({ keywords: 'café 夜' });
});

test('one through eighty Unicode code points are valid and quote-only searches have no text', () => {
  for (const text of ['a', '雨', '𠮷', '𠮷'.repeat(80), 'a'.repeat(80), `"${'𠮷'.repeat(78)}"`]) {
    expect(phraseStatus(text)).toBe('ok');
  }
  for (const text of ['𠮷'.repeat(81), `"${'𠮷'.repeat(79)}"`, `"${'𠮷'.repeat(80)}"`]) {
    expect(phraseStatus(text)).toBe('long');
  }
  expect(phraseStatus('  ')).toBe('empty');
  expect(phraseStatus('""')).toBe('short');
  expect(phraseStatus('" "')).toBe('short');
});

test('keyword/exact edits, shared links, legacy redirects and history retain every active selector', () => {
  seedServedTypes();
  const selected = { ...emptyBrowse, q: 'night library', tab: 'works', language: 'ja',
    scope: { kind: 'realm' as const, realm: '00000000-0000-4000-8000-000000000001' },
    includeTypes: ['https://schema.org/Book'], excludeTypes: ['https://schema.org/Movie'],
    conditions: { include: ['00000000-0000-4000-8000-000000000002'],
      exclude: ['00000000-0000-4000-8000-000000000003'], match: 'any' as const }, personalized: false };
  const history = [selected, changeBrowse({ ...selected, cursor: 'resource-cursor' }, { q: '"night library"' }),
    changeBrowse(selected, { q: '𠮷'.repeat(80) })];
  for (const state of [...history, ...history.toReversed()]) {
    const url = new URL(browseHref(state), 'https://example.test');
    expect(parseBrowseState(Object.fromEntries(url.searchParams))).toEqual(state);
    const legacy = new URL(url);
    legacy.pathname = '/en/search';
    const redirect = discoverSearchUrl(legacy, 'en');
    expect(parseBrowseState(Object.fromEntries(redirect.searchParams))).toEqual(state);
    expect(searchText(redirect.searchParams.get('q')!)).toEqual(searchText(state.q));
  }
});
