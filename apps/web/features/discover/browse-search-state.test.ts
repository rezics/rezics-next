import { beforeEach, expect, test } from 'bun:test';
import { seedServedTypes } from '../catalogue/type-fixtures.ts';
import { browseCategories } from '../catalogue/registry.ts';
import { browseSearchFields, browseHref, browseQuery, changeBrowse, emptyBrowse, parseBrowseState } from './browse-state.ts';
import { chapterProgress, chapterSearchState } from './chapter-text-read.ts';
import { readBrowse, readBrowseScan, BROWSE_SCAN_PAGES } from './browse-read.ts';
import { BrowseReadError, discoveryApi, type ListPage } from './api.ts';
import { browserMainApi } from '../api/browser.ts';
import { searchText } from '../search/state.ts';
import type { SearchHit, SearchResultPage } from '../search/types.ts';

beforeEach(seedServedTypes);
const topic = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const book = 'https://schema.org/Book';

test('query edits retain every selector, including refused and repeated selectors, while dropping traversal', () => {
  const params = new URLSearchParams({ q: 'old', tab: 'works', lang: 'ja', include: book, ci: topic,
    ce: other, cm: 'any', scope: 'realm', realm: topic, personalization: 'off', cursor: 'opaque', section: 'popular',
    unsupported: 'retain this refusal' });
  params.append('lang', 'ko');
  const edited = new URLSearchParams(browseSearchFields(params));
  edited.set('q', 'new');
  for (const [key] of params) {
    if (['q', 'cursor', 'section'].includes(key)) continue;
    expect(edited.getAll(key)).toEqual(params.getAll(key));
  }
  expect(edited.has('cursor')).toBe(false);
  expect(edited.has('section')).toBe(false);
});

test('shared exact and Unicode keyword edits round-trip all active conditions and reset only traversal', () => {
  const original = { ...emptyBrowse, q: '  読書　 夜  ', tab: 'works', language: 'ja', includeTypes: [book],
    conditions: { include: [topic], exclude: [other], match: 'any' as const },
    scope: { kind: 'realm' as const, realm: topic }, cursor: 'opaque:+/%?=&雪', personalized: false };
  const parsed = parseBrowseState(Object.fromEntries(new URL(browseHref(original), 'https://example.test').searchParams));
  expect(parsed?.q).toBe('読書 夜');
  expect(parsed).not.toBeNull();
  if (!parsed) throw new Error('Expected a valid selection');
  const next = changeBrowse(parsed, { q: '"夜の図書館"' });
  const restored = parseBrowseState(Object.fromEntries(new URL(browseHref(next), 'https://example.test').searchParams));
  expect(restored).toEqual(next);
  expect(next).toEqual({ ...parsed, q: '"夜の図書館"', cursor: null, section: null });
  expect(browseQuery(next)).toMatchObject({ q: '"夜の図書館"', context: { realm: `https://rezics.com/id/${topic}` } });
  expect(parseBrowseState({ q: '雨' })?.q).toBe('雨');
  expect(parseBrowseState({ q: '𠮷'.repeat(80) })?.q).toBe('𠮷'.repeat(80));
  expect(parseBrowseState({ q: '𠮷'.repeat(81) })).toBeNull();
  const continued = { ...next, cursor: 'opaque:+/%?=&雪' };
  expect(parseBrowseState(Object.fromEntries(new URL(browseHref(continued), 'https://example.test').searchParams)))
    .toEqual(continued);
});

test('chapters retain Work filters and never appear in a different resource destination', () => {
  const state = { ...emptyBrowse, q: 'night library', language: 'ja', includeTypes: [book],
    conditions: { include: [topic], exclude: [], match: 'all' as const }, cursor: 'resource-only' };
  expect(chapterSearchState(state)).toMatchObject({ phrase: state.q, language: 'ja', includeTypes: [book],
    concepts: state.conditions });
  for (const tab of browseCategories().filter(category => category.id !== 'works')) {
    expect(chapterSearchState({ ...state, tab: tab.id })).toBeNull();
  }
});

test('the resource request carries the same literal keyword/exact intent as chapters with all selection and cursor values', async () => {
  const requests: unknown[] = [];
  const main = browserMainApi('https://story.invalid', { anonymous: true,
    fetcher: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(await new Request(input, init).json());
      return Response.json({ result: { profile: 'resource-list-v1', items: [], nextCursor: null, complete: true,
        count: { value: 0, kind: 'exact' }, stale: false,
        sourcePosition: { datasetId: 'product', dataEpoch: 'fixture', sequence: '1' } } });
    }, { preconnect: fetch.preconnect }) });
  const api = discoveryApi(main, 'ja');
  const selected = { ...emptyBrowse, tab: 'works', language: 'ja', includeTypes: [book],
    conditions: { include: [topic], exclude: [other], match: 'any' as const },
    scope: { kind: 'realm' as const, realm: topic }, cursor: 'opaque:+/%?=&雪' };
  for (const q of ['night library', '"night library"', '雨', '𠮷'.repeat(80), 'cafe\u0301　夜']) {
    const query = browseQuery({ ...selected, q });
    await api.resources(query);
    const text = searchText(q);
    expect(requests.at(-1)).toEqual({ ...query,
      ...('keywords' in text ? { q: text.keywords, matchMode: 'keywords' } : { q: text.phrase, matchMode: 'phrase' }) });
    expect(chapterSearchState({ ...selected, q })?.phrase).toBe(q);
  }
  const unsearched = browseQuery({ ...selected, q: '' });
  await api.resources(unsearched);
  expect(requests.at(-1)).toEqual(unsearched);
});

const page = <T>(items: T[], nextCursor: string | null): ListPage<T> => ({ items, nextCursor,
  complete: nextCursor === null, count: { value: items.length, kind: nextCursor === null ? 'exact' : 'at-least' } });
test('empty scans advance opaque continuations to a late match without treating candidate windows as empty catalogues', async () => {
  const calls: (string | null)[] = [];
  const cursors = ['opaque:+/%?=&雪', 'another:token'];
  const scan = await readBrowseScan(async cursor => {
    calls.push(cursor);
    return { ok: true, data: cursor === cursors[1] ? page(['late match'], null)
      : page([], cursor === null ? cursors[0]! : cursors[1]!) };
  }, null);
  expect(calls).toEqual([null, ...cursors]);
  expect(scan).toMatchObject({ checkedPages: 3, result: { ok: true, data: { items: ['late match'], complete: true } } });
});

test('one empty scan action is bounded and retains the next owner cursor', async () => {
  let reads = 0;
  const result = await readBrowseScan(async () => ({ ok: true, data: page([], `opaque-${++reads}`) }), null);
  expect(reads).toBe(BROWSE_SCAN_PAGES);
  expect(reads).toBe(4);
  expect(result).toMatchObject({ checkedPages: BROWSE_SCAN_PAGES, result: { ok: true,
    data: { items: [], complete: false, nextCursor: `opaque-${BROWSE_SCAN_PAGES}` } } });
});

test.each([
  [null, ['opaque:A', 'opaque:B', 'opaque:C', 'opaque:A']],
  ['opaque:start', ['opaque:A', 'opaque:start']],
  ['opaque:action', ['opaque:A', 'opaque:B', 'opaque:C', 'opaque:action']],
] as const)('resource scans refuse opaque cycles, including the fourth page and action boundary: %s', async (cursor, next) => {
  const calls: (string | null)[] = [];
  const scan = await readBrowseScan(async input => {
    calls.push(input);
    return { ok: true, data: page([], next[calls.length - 1]!) };
  }, cursor);
  expect(calls).toEqual([cursor, ...next.slice(0, -1)]);
  expect(scan.result).toMatchObject({ ok: false, failure: 'unavailable' });
  expect(scan.checkedPages).toBe(next.length);
});

test('a resource match does not make a repeated next cursor safe to offer', async () => {
  const scan = await readBrowseScan(async () => ({ ok: true, data: page(['match'], 'opaque:A') }), 'opaque:A');
  expect(scan.result).toMatchObject({ ok: false, failure: 'unavailable' });
  expect(scan.checkedPages).toBe(1);
});

test('exhaustion, backend refusal, temporary failure and a non-progressing cursor remain distinct', async () => {
  const exhausted = await readBrowseScan(async () => ({ ok: true, data: page([], null) }), null);
  expect(exhausted).toMatchObject({ checkedPages: 1, result: { ok: true, data: { complete: true } } });
  for (const [status, code, failure] of [[400, 'unsupported_query_shape', 'unsupported'],
    [503, 'search_unavailable', 'unavailable']] as const) {
    const result = await readBrowseScan(() => readBrowse<ListPage<unknown>>(() => {
      throw new BrowseReadError(status, code, { code });
    }), null);
    expect(result.result).toMatchObject({ ok: false, failure, status, problem: { code } });
  }
  const cycle = await readBrowseScan(async () => ({ ok: true, data: page([], 'same') }), 'same');
  expect(cycle.result.ok).toBe(false);
});

test('chapter progress deduplicates replays and requires the last owner continuation to be exhausted', () => {
  const hit = (unit: string, chapter: boolean): SearchHit => ({ matchUnit: unit, work: unit, mainVersion: unit,
    types: [book], title: null, cover: null, authors: [], rating: null, tagline: null, completion: null,
    reasons: { language: 'ja', field: chapter ? 'body' : 'title', matchedText: null, matchedLanguage: null,
      chapter: chapter ? { title: 'Chapter 1', href: `/read/${unit}` } : null, realm: null, classification: null } });
  const first: SearchResultPage = { hits: [hit('title', false), hit('first', true)], total: 3, titles: false,
    sequence: '47', indexGeneration: 'index', next: { queryDigest: 'a'.repeat(64), resultDigest: 'b'.repeat(64),
      sourcePosition: { datasetId: 'product', dataEpoch: 'test', sequence: '47' }, indexGeneration: 'index',
      nextOffset: 2, expiresAt: 1 } };
  expect(chapterProgress([first])).toMatchObject({ checked: 2, complete: false });
  const progress = chapterProgress([first, { ...first, next: null, hits: [hit('first', true), hit('last', true)] }]);
  expect(progress.hits.map(hit => hit.matchUnit)).toEqual(['first', 'last']);
  expect(progress).toMatchObject({ checked: 3, total: 3, complete: true });
});
