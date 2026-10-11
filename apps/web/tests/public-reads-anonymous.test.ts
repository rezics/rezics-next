import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { browserMainApi } from '../features/api/browser.ts';
import { readSetupFirstPost } from '../features/communities/setup-first-post.ts';
import { conceptWorksLoader } from '../features/concept/browser.ts';
import type { ConceptState } from '../features/concept/state.ts';
import { readPublicRealmChoices } from '../features/discover/browser.ts';
import { bffDiscovery, discoveryPagesOptions } from '../features/discover/query.ts';
import type { DiscoverState } from '../features/discover/state.ts';
import { topicLoader } from '../features/discover/topic-picker.tsx';
import type { DiscoveryPage } from '../features/discover/types.ts';
import { readBrowserTypeahead } from '../features/search/browser.ts';
import { bffSearchFallback } from '../features/search/fallback.ts';
import { bffSearch, searchPagesOptions } from '../features/search/query.ts';
import type { SearchState } from '../features/search/state.ts';
import type { SearchContinuation, SearchResultPage } from '../features/search/types.ts';
import { readPublicationYears } from '../features/zones/catalogue-facts.ts';

const id = '00000000-0000-4000-8000-000000000001';
const actor = `https://rezics.com/id/${id}`;
const concept: ConceptState = { concept: id, scope: { kind: 'global' }, include: [], exclude: [], match: 'all' };
const filtered: DiscoverState = { scope: { kind: 'global' }, context: null, type: null, term: null,
  conditions: { include: [id], exclude: [], match: 'all' } };
const search: SearchState = { phrase: 'Pride', scope: { kind: 'global' }, language: null, term: null };
const continuation: SearchContinuation = { queryDigest: 'a'.repeat(64), resultDigest: 'b'.repeat(64),
  sourcePosition: { datasetId: 'product', dataEpoch: 'epoch', sequence: '47' },
  indexGeneration: 'generation', nextOffset: 1, expiresAt: 0 };
type Call = { url: URL; init: RequestInit; body: Record<string, unknown> | null };
let calls: Call[];
let restore: () => void;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');

beforeEach(() => {
  calls = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { origin: 'https://web.example', href: 'https://web.example/en/discover' },
  } });
  const transport = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(
    async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      calls.push({ url, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
      if (url.pathname.endsWith('/discovery/concepts')) return Response.json({
        profile: 'concept-search-v1', items: [], count: { value: 0, kind: 'exact' },
        complete: true, nextCursor: null,
      });
      if (url.pathname.endsWith('/query') && calls.at(-1)!.body?.query) return Response.json({ result: {
        profile: 'template-result-v1', query: 'https://rezics.com/query/work-publication-years',
        items: [], nextCursor: null,
      } });
      if (url.pathname.endsWith('/query')) return Response.json({ result: {
        // Phrase results cause the actual loader to construct its delegated summary read.
        profile: 'public-concept-set-phrase-v1', results: [{ matchUnit: actor, work: actor,
          mainVersion: actor, types: [], matchedField: 'title', matchedText: 'Pride', language: 'en',
          title: { value: 'Pride', language: 'en' } }], total: 1, population: 1,
        sourcePosition: { sequence: '47' }, indexGeneration: 'generation', next: null,
      } });
      if (url.pathname.endsWith('/summaries')) return Response.json({ summaries: [] });
      return Response.json({ items: [], nextCursor: null, complete: true });
    }, { preconnect: globalThis.fetch.preconnect },
  ));
  restore = () => transport.mockRestore();
});

afterEach(() => {
  restore();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

function transportIs(credentials: RequestCredentials) {
  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) expect(call.init.credentials).toBe(credentials);
}

for (const signedIn of [false, true]) {
  const credentials = signedIn ? 'same-origin' : 'omit';
  test(`Concept Works first page and continuation keep session transport when signedIn=${signedIn}`, async () => {
    const load = conceptWorksLoader(signedIn);
    await load(concept, 'en');
    await load(concept, 'en', 'concept-next');
    transportIs('same-origin');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toMatchObject({ page: { continuation: 'concept-next' } });
  });

  test(`Discover Works first page and continuation use ${credentials}`, async () => {
    const load = bffDiscovery(signedIn);
    await load({ scope: 'global', sort: 'recent', limit: 12 });
    await load({ scope: 'global', sort: 'recent', limit: 12, cursor: 'works-next' });
    transportIs(credentials);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url.searchParams.get('cursor')).toBe('works-next');
  });

  test(`Filtered Discover first page and continuation use ${credentials}`, async () => {
    const load = bffDiscovery(signedIn, filtered);
    await load({ scope: 'global', sort: 'recent' });
    await load({ scope: 'global', sort: 'recent', cursor: 'filter-next' });
    transportIs(credentials);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body).toMatchObject({ page: { continuation: 'filter-next' } });
  });

  test(`Phrase results and delegated summaries keep ${credentials} across pages`, async () => {
    const load = bffSearch(search, 'en', undefined, signedIn);
    expect((await load(undefined)).ok).toBe(true);
    expect((await load(continuation)).ok).toBe(true);
    transportIs(credentials);
    expect(calls.map(call => call.url.pathname)).toEqual([
      '/api/main/v1/query', '/api/main/v1/resources/summaries',
      '/api/main/v1/query', '/api/main/v1/resources/summaries',
    ]);
    expect(calls[2]!.body).toMatchObject({ page: { continuation } });
  });

  test(`General typeahead keeps session transport when signedIn=${signedIn}`, async () => {
    await readBrowserTypeahead('Pride', 'en', signedIn);
    transportIs('same-origin');
    expect(calls[0]!.url.searchParams.get('prefix')).toBe('Pride');
  });

  test(`Topic picker first page and continuation keep session transport when signedIn=${signedIn}`, async () => {
    const load = topicLoader('en', undefined, undefined, signedIn);
    await load({ q: 'Fantasy', cursor: null });
    await load({ q: 'Fantasy', cursor: 'topics-next' });
    transportIs('same-origin');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.url.searchParams.get('cursor')).toBe('topics-next');
  });
}

test('Composer community directory is public on every page; its Work picker keeps the session', async () => {
  await readPublicRealmChoices('Book');
  await readPublicRealmChoices('Book', 'realms-next');
  transportIs('omit');
  expect(calls[1]!.url.searchParams.get('cursor')).toBe('realms-next');
  calls = [];
  await readBrowserTypeahead('Pride');
  transportIs('same-origin');
});

test('Empty search fallback constructs every suggestion, rating-context and Work request anonymously', async () => {
  await bffSearchFallback('Pride', 'en');
  transportIs('omit');
  expect(calls.some(call => call.url.pathname.endsWith('/typeahead'))).toBe(true);
  expect(calls.some(call => call.url.pathname.endsWith('/rating-contexts'))).toBe(true);
  expect(calls.some(call => call.url.pathname.endsWith('/works'))).toBe(true);
});

test('Mine and the creator checklist retain their session and acting subject', async () => {
  await bffDiscovery(false)({ scope: 'mine', sort: 'recent', actingSubject: actor });
  await readSetupFirstPost(browserMainApi(), actor, actor);
  transportIs('same-origin');
  expect(calls).toHaveLength(2);
  for (const call of calls) expect(call.url.searchParams.get('actingSubject')).toBe(actor);
});

test('Filtered Mine retains session transport on first and continuation pages', async () => {
  const load = bffDiscovery(false, { ...filtered, scope: { kind: 'mine' } });
  await load({ scope: 'mine', sort: 'recent', actingSubject: actor });
  await load({ scope: 'mine', sort: 'recent', actingSubject: actor, cursor: 'mine-next' });
  transportIs('same-origin');
  expect(calls).toHaveLength(2);
  for (const call of calls) expect(call.body).toMatchObject({ scope: { kind: 'mine' }, actingSubject: actor });
  expect(calls[1]!.body).toMatchObject({ page: { continuation: 'mine-next' } });
});

test('Publication-year facets and their continuation use an anonymous server reader', async () => {
  expect((await readPublicationYears({ fromYear: 2020 })).ok).toBe(true);
  expect((await readPublicationYears({ fromYear: 2020 }, 'years-next')).ok).toBe(true);
  expect(calls).toHaveLength(2);
  for (const call of calls) {
    const headers = new Headers(call.init.headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
  }
  expect(calls[1]!.body).toMatchObject({ cursor: 'years-next' });
});

test('Paging caches separate public and viewer lists even when neither has a selected Agent', () => {
  const firstDiscovery = { sourcePosition: { dataEpoch: 'epoch', sequence: '47' } } as DiscoveryPage;
  const firstSearch = { indexGeneration: 'generation', sequence: '47' } as SearchResultPage;
  const discoveryKey = (signedIn: boolean) => discoveryPagesOptions(
    { scope: 'global', sort: 'recent' }, firstDiscovery, bffDiscovery(signedIn), signedIn).queryKey;
  const searchKey = (signedIn: boolean) => searchPagesOptions(search, 'en', undefined,
    firstSearch, bffSearch(search, 'en', undefined, signedIn), signedIn).queryKey;
  expect(discoveryKey(false)).not.toEqual(discoveryKey(true));
  expect(searchKey(false)).not.toEqual(searchKey(true));
});
