import { expect, test } from 'bun:test';
import { parseQueryShare, queryShareUrl } from '../src/search/query-share';
import { searchLoaderDeps } from '../src/search/search-params';
import { discoveryRequest } from '../src/search/search-request';

test('same-origin localized link reopens full text, kinds, languages and Boolean conditions without cursor', () => {
  const filter = { or: [{ type: { in: ['rezics:Book'] } }, { not: { type: { in: ['rezics:Film'] } } }] };
  const params = new URLSearchParams({ q: '"raw phrase" | -other', condition: JSON.stringify(filter), sort: 'rating' });
  params.append('kinds', 'book');
  params.append('language', 'ja');
  params.append('language', 'en');
  const share = parseQueryShare({
    action: 'allowed',
    reason: 'ready',
    document: {
      text: '"raw phrase" | -other',
      filter: JSON.stringify(filter),
      languages: ['ja', 'en'],
      sort: 'rating',
    },
    parameters: params.toString(),
    selections: [],
  });
  const url = new URL(queryShareUrl('https://example.com', 'ja', share)!);
  expect(url.origin).toBe('https://example.com');
  expect(url.pathname).toBe('/ja/search');
  const state = searchLoaderDeps({
    q: url.searchParams.get('q'),
    condition: url.searchParams.get('condition'),
    kinds: url.searchParams.getAll('kinds'),
    sort: url.searchParams.get('sort'),
    language: url.searchParams.getAll('language'),
  });
  const request = discoveryRequest(state, ['fr']);
  expect(request.text).toBe(share.document!.text);
  expect(request.languages).toEqual(['ja', 'en']);
  expect(request.filter).toEqual({ and: [filter, { kind: { in: ['book'] } }] });
  expect(request.cursor).toBeUndefined();
  expect(request.sort).toBe('rating');
  expect(url.searchParams.has('reader')).toBe(false);
});

test('unavailable preparation, malformed references and oversized links preserve recovery without widening', () => {
  expect(parseQueryShare({ document: {} }).action).toBe('unavailable');
  expect(searchLoaderDeps({ filter: '{broken' }).invalidInput?.key).toBe('filter');
  expect(searchLoaderDeps({ q: 'x'.repeat(513) }).invalidInput?.key).toBe('q');
  expect(searchLoaderDeps({ condition: 'x'.repeat(16385) }).invalidInput?.key).toBe('condition');
  const share = parseQueryShare({
    action: 'allowed',
    reason: 'ready',
    document: { text: '', filter: null, languages: [], sort: null },
    parameters: 'q=' + 'x'.repeat(8192),
    selections: [],
  });
  expect(queryShareUrl('https://example.com', 'en', share)).toBeNull();
});
