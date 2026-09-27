import { describe, expect, test } from 'bun:test';
import type { MainClient } from '../features/discover/types.ts';
import { readSearchPage, readSummaries, searchRequest } from '../features/search/read.ts';
import { searchPagesOptions } from '../features/search/query.ts';
import { normalizeLanguage, parseSearchState, phraseStatus, searchHref } from '../features/search/state.ts';
import { searchFailureOf, type SearchResultPage } from '../features/search/types.ts';

const realm = '3f0e1c2d-4b5a-4c6d-8e7f-9a0b1c2d3e4f';
const term = '0b1c2d3e-4f5a-4b6c-8d7e-8f9a0b1c2d3e';
const iri = (id: string) => `https://rezics.com/id/${id}`;
const global = { phrase: 'Pride', scope: { kind: 'global' as const }, language: null, term: null };

describe('search URL state', () => {
  test('query, scope, language and term round-trip through the address', () => {
    const parsed = parseSearchState({ q: '  《西游记》  取经 ', scope: 'realm', realm, lang: 'ZH-Hans', term });
    expect(parsed).toEqual({ ok: true, state: { phrase: '《西游记》 取经', scope: { kind: 'realm', realm },
      language: 'zh-Hans', term } });
    const href = searchHref(parsed.ok ? parsed.state : global);
    expect(href).toBe(`/search?${new URLSearchParams({ q: '《西游记》 取经' })}&scope=realm&realm=${realm}&lang=zh-Hans&term=${term}`);
    expect(parseSearchState(Object.fromEntries(new URL(href, 'http://x').searchParams))).toEqual(parsed);
    expect(searchHref(global)).toBe('/search?q=Pride');
    const selected = { ...global, includeTypes: ['book', 'recipe'] as Array<'book' | 'recipe'>,
      excludeTypes: ['document'] as Array<'document'> };
    const selectedHref = searchHref(selected);
    expect(parseSearchState(Object.fromEntries(new URL(selectedHref, 'http://x').searchParams)))
      .toEqual({ ok: true, state: selected });
  });

  test('Mine and malformed selections are named, never searched as Global', () => {
    expect(parseSearchState({ q: 'Pride', scope: 'mine' })).toEqual({ ok: false, reason: 'mine', phrase: 'Pride' });
    for (const params of [{ scope: 'realm' }, { scope: 'global', realm }, { lang: 'english!' }, { term: 'fantasy' },
      { q: ['a', 'b'] }, { lang: ['en', 'ja'] },
      { scope: ['global', 'realm'], realm }, { include: 'book,book' },
      { include: 'book', exclude: 'book' }, { exclude: 'unknown' }]) {
      expect(parseSearchState({ q: 'Pride', ...params }).ok).toBe(false);
    }
    expect(normalizeLanguage('EN')).toBe('en');
    expect(normalizeLanguage('zh-Hans')).toBe('zh-Hans');
    expect(normalizeLanguage('en-x')).toBeNull();
  });

  test('phrase bounds count characters, not UTF-16 units', () => {
    expect(phraseStatus('')).toBe('empty');
    expect(phraseStatus('西')).toBe('short');
    expect(phraseStatus('西游')).toBe('ok');
    expect(phraseStatus('𠀀'.repeat(80))).toBe('ok');
    expect(phraseStatus('a'.repeat(81))).toBe('long');
  });
});

describe('search requests', () => {
  test('the page cache separates acting readers on the same index basis', () => {
    const first = { indexGeneration: 'g1', sequence: '47' } as SearchResultPage;
    const load = async () => ({ ok: true as const, page: first });
    const anonymous = searchPagesOptions(global, 'en', undefined, first, load).queryKey;
    const alice = searchPagesOptions(global, 'en', 'agent:alice', first, load).queryKey;
    const bob = searchPagesOptions(global, 'en', 'agent:bob', first, load).queryKey;
    expect(new Set([JSON.stringify(anonymous), JSON.stringify(alice), JSON.stringify(bob)]).size).toBe(3);
  });

  test('each scope and term selects its Main phrase profile', () => {
    expect(searchRequest(global)).toEqual({ profile: 'public-main-phrase-page-v1', phrase: 'Pride', language: null,
      pageSize: 10 });
    expect(searchRequest({ ...global, language: 'en', term })).toEqual({ profile: 'public-main-classified-phrase-page-v1',
      phrase: 'Pride', language: 'en', sense: iri(term), pageSize: 10 });
    const context = { kind: 'realm-local', id: iri(realm) };
    expect(searchRequest({ ...global, scope: { kind: 'realm', realm } })).toMatchObject({
      profile: 'public-realm-phrase-page-v1', context });
    expect(searchRequest({ ...global, scope: { kind: 'realm', realm }, term })).toMatchObject({
      profile: 'public-realm-classified-phrase-page-v1', context, sense: iri(term) });
    expect(searchRequest({ ...global, includeTypes: ['book'], excludeTypes: ['recipe'] })).toMatchObject({
      includeTypes: ['https://schema.org/Book'], excludeTypes: ['https://schema.org/Recipe'] });
  });

  test('expired or moved continuations restart; over-budget phrases are named', () => {
    expect(searchFailureOf(409, 'search_restart_required')).toBe('restart');
    expect(searchFailureOf(422, 'invalid_search_continuation')).toBe('restart');
    expect(searchFailureOf(422, 'query_budget_exceeded')).toBe('budget');
    expect(searchFailureOf(404, 'realm_unavailable')).toBe('missing');
    expect(searchFailureOf(503, 'search_index_unavailable')).toBe('unavailable');
  });
});

describe('search result hydration', () => {
  const work = iri('00000001-3855-42be-84bb-88da77a5b247');
  const concept = iri('00000701-3855-42be-84bb-88da77a5b247');
  const page = { profile: 'public-realm-classified-phrase-page-v1', resultGrain: 'mainVersion', relationComplete: true,
    population: 42, total: 1, sourcePosition: { datasetId: 'product', dataEpoch: 'e', sequence: '47' },
    indexGeneration: 'g', next: null, context: { kind: 'realm-local', id: iri(realm) }, classificationSense: iri(term),
    facets: { populationBasis: 'all-filters', resultGrain: 'work',
      languages: { precision: 'exact', values: [{ value: 'zh-Hans', count: 1 }] },
      terms: { precision: 'lower-bound', values: [{ value: iri(term), count: 1 }] },
      types: { precision: 'exact', values: [{ value: 'https://schema.org/Book', count: 1 }] } },
    results: [{ matchUnit: 'm', work, mainVersion: 'v', contribution: 'c', revision: 'r', selection: 's',
      language: 'zh-Hans', score: 1, types: ['https://schema.org/Book'], reason: 'realm-adoption', classification: { sense: iri(term), decision: 'd',
        application: null, concept, source: 'local', sourceContext: 'x' } }] };
  const name = (value: string) => ({ value, language: 'zh-Hans', direction: 'ltr', basis: 'requested' });
  const fallback = { kind: 'fallback', policy: 'avatar-fallback-v1', key: 'k', resourceType: 'work' };
  function client(summaries: unknown, seen: unknown[] = []) {
    return { v1: { queries: { page: { post: async () => ({ data: page, error: null }) } },
      resources: { summaries: { post: async (body: unknown) => { seen.push(body);
        return summaries instanceof Error ? { data: null, error: { status: 503, value: {} } }
          : { data: { summaries }, error: null }; } } } } } as unknown as MainClient;
  }

  test('one typed summary batch names Works and concepts; external media URLs are ignored', async () => {
    const seen: unknown[] = [];
    const main = client([{ reference: work, status: 'available', name: name('西游记'), avatar: fallback },
      { reference: concept, status: 'available', name: name('神魔小说'), avatar: { ...fallback, resourceType: 'concept' } }],
    seen);
    const read = await readSearchPage({ search: main, names: main }, { ...global, scope: { kind: 'realm', realm }, term },
      { language: 'zh-CN' });
    expect(seen).toEqual([{ profile: 'resource-summary-batch-v1', resources: [work, concept], language: 'zh-CN' }]);
    expect(read.ok && read.page.titles).toBe(true);
    expect(read.ok && read.page.facets?.terms.precision).toBe('lower-bound');
    expect(read.ok && read.page.hits[0]).toMatchObject({ title: { value: '西游记' }, reasons: { language: 'zh-Hans',
      realm: 'realm-adoption', classification: { source: 'local', conceptName: { value: '神魔小说' } } } });
    const forged = await readSummaries(client([{ reference: work, status: 'available', name: name('x'),
      avatar: { kind: 'image', url: 'https://elsewhere.example/x.png', selection: 's', mediaType: 'image/png',
        width: 1, height: 1, crop: null, basis: { policy: 'p', context: 'c' } } }]), [work], 'en');
    expect(forged?.size).toBe(0);
  });

  test('results stand without names when summaries fail', async () => {
    const main = client(new Error('down'));
    const read = await readSearchPage({ search: main, names: main }, global, { language: 'en' });
    expect(read.ok && read.page.titles).toBe(false);
    expect(read.ok && read.page.hits[0]?.title).toBeNull();
  });
});
