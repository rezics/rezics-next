import { expect, test } from 'bun:test';
import { phraseStatus, searchText } from './state.ts';
import { browseHref, changeBrowse, emptyBrowse, parseBrowseState } from '../discover/browse-state.ts';
import { seedServedTypes } from '../catalogue/type-fixtures.ts';
import { discoverSearchUrl } from './redirect.ts';
import { searchRequest } from './read.ts';
import { chapterSearchState } from '../discover/chapter-text-read.ts';
import type { SearchContinuation } from './types.ts';
import { browserMainApi } from '../api/browser.ts';
import { readChapterText } from '../discover/chapter-text-read.ts';

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

test('the actual chapter query uses exported keyword/exact alternatives with independent opaque continuation', () => {
  seedServedTypes();
  const browse = { ...emptyBrowse, q: 'library night', language: 'ja', tab: 'works',
    scope: { kind: 'realm' as const, realm: '00000000-0000-4000-8000-000000000001' },
    includeTypes: ['https://schema.org/Book'], excludeTypes: ['https://schema.org/Movie'],
    conditions: { include: ['00000000-0000-4000-8000-000000000002'],
      exclude: ['00000000-0000-4000-8000-000000000003'], match: 'any' as const }, cursor: 'resource-only' };
  const continuation: SearchContinuation = { queryDigest: 'a'.repeat(64), resultDigest: 'b'.repeat(64),
    sourcePosition: { datasetId: 'product', dataEpoch: 'fixture', sequence: '12' },
    indexGeneration: 'fixture', nextOffset: 10, expiresAt: 0 };
  for (const q of ['library night', '雨', 'a', '𠮷'.repeat(80), '"night library"', '"雨"']) {
    const state = chapterSearchState({ ...browse, q });
    if (!state) throw new Error(`Expected a searchable selection for ${q}`);
    const first = searchRequest(state), next = searchRequest(state, continuation);
    expect(first.text).toEqual(searchText(q));
    expect(first.page).toEqual({ size: 10 });
    expect(next.page).toEqual({ size: 10, continuation });
    expect(next).toEqual({ ...first, page: { ...first.page, continuation } });
    expect(first.context).toEqual({ realm: `https://rezics.com/id/${browse.scope.realm}` });
    expect(first.filter).toEqual({ all: [
      { facet: 'type', any: browse.includeTypes }, { facet: 'type', none: browse.excludeTypes },
      { facet: 'language', any: ['ja'] },
      { facet: 'concept', any: browse.conditions.include.map(id => `https://rezics.com/id/${id}`) },
      { facet: 'concept', none: browse.conditions.exclude.map(id => `https://rezics.com/id/${id}`) },
    ] });
  }
});

test('single-character chapter reads reach the typed API and retain an actual unsupported or unavailable response', async () => {
  const requests: unknown[] = [];
  for (const [status, code, failure] of [[400, 'unsupported_query_shape', 'unsupported'],
    [503, 'search_unavailable', 'unavailable']] as const) {
    const fetcher = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(await new Request(input, init).json());
      return Response.json({ code }, { status });
    }, { preconnect: fetch.preconnect });
    const main = browserMainApi('https://story.invalid', { anonymous: true, fetcher });
    const read = await readChapterText(main, { ...emptyBrowse, q: '雨', cursor: 'resource-only' }, 'zh-Hans');
    expect(read).toEqual({ ok: false, failure, status, problem: { code } });
  }
  expect(requests).toEqual(Array.from({ length: 2 }, () => ({ context: 'global', scope: { kind: 'all' },
    text: { keywords: '雨' }, sort: 'relevance', filter: { all: [] }, page: { size: 10 } })));
});
