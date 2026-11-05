import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { hasResultSearchIntent } from '../src/search/search-intent';
import { isRealmDiscoverySearch } from '../src/search/realm-discovery-loader';
import { discoverySearchHref, searchLoaderDeps, searchParams } from '../src/search/search-params';
import { discoveryRequest } from '../src/search/search-request';
import { readSearchOutcome } from '../src/search/search-recovery';

test('empty/default controls browse Realms; every explicit result predicate starts search', () => {
  for (const input of [{}, { q: '', sort: '', language: [], kinds: [] }]) {
    const state = searchLoaderDeps(v.parse(searchParams, input));
    expect(hasResultSearchIntent(state)).toBe(false);
    expect(isRealmDiscoverySearch(state)).toBe(true);
  }
  for (const input of [
    { sort: 'rating' },
    { language: ['ja', 'en'] },
    { q: ' ' },
    { type: 'schema:Book' },
    { cursor: 'opaque' },
    { kinds: ['account'] },
    { filter: '{}' },
    { condition: '{"type":{"in":["schema:Book"]}}' },
    { 'f.schema:genre': ['fiction'] },
    { 'r.schema:wordCount': '{"gte":10}' },
  ]) {
    const state = searchLoaderDeps(v.parse(searchParams, input));
    expect(hasResultSearchIntent(state)).toBe(true);
    expect(isRealmDiscoverySearch(state)).toBe(false);
  }
});

test('empty-text controls retain bounded native requests, ordered languages and recovery through continuation', async () => {
  for (const input of [{ sort: 'rating' }, { language: ['ja', 'zh-Hant', 'en'] }]) {
    const state = searchLoaderDeps(v.parse(searchParams, input));
    const request = discoveryRequest(state, ['en']);
    expect(request).toMatchObject({ limit: 100, languages: state.languages ?? ['en'] });
    expect(request.text).toBeUndefined();
    expect(request.sort).toBe(state.sort);
    const href = new URL(discoverySearchHref('en', { ...state, cursor: 'next+/=' }), 'https://rezics.test');
    const continued = searchLoaderDeps({
      ...Object.fromEntries(href.searchParams),
      ...(state.languages ? { language: href.searchParams.getAll('language') } : {}),
    });
    expect(discoveryRequest(continued, ['en'])).toEqual({ ...request, cursor: 'next+/=' });
    expect(isRealmDiscoverySearch({ ...continued, sort: undefined, languages: undefined, cursor: undefined })).toBe(
      true,
    );
    for (const [status, code, recovery] of [
      [403, 'platform_closed', 'closed'],
      [403, 'forbidden', 'denied'],
      [503, 'index_not_ready', 'index-not-ready'],
      [503, 'unavailable', 'unavailable'],
      [422, 'invalid_request', 'invalid'],
    ] as const) {
      let reads = 0;
      const outcome = await readSearchOutcome(request, async () => {
        reads++;
        return { status, error: { value: { code } } };
      });
      expect(reads).toBe(1);
      expect(outcome.recovery.status).toBe(recovery);
    }
    const empty = await readSearchOutcome(request, async () => ({
      status: 200,
      data: { hits: [], kinds: { values: [], next: null }, next: null, as_of: '2026-10-31T00:00:00Z' },
    }));
    expect(empty.recovery.status).toBe('ready');
    expect(empty.discovery).toMatchObject({ status: 'ready', page: { hits: [] } });
  }
});
