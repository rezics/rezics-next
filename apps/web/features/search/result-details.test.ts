import { expect, test } from 'bun:test';
import { browserMainApi } from '../api/browser.ts';
import { readSearchPage } from './read.ts';
import type { SearchPage } from './types.ts';

const resource = 'https://rezics.com/id/00000000-0000-4000-8000-000000000001';
const revision = 'urn:rezics:content:revision:00000000-0000-4000-8000-000000000002';
const variant = 'urn:rezics:content:variant:00000000-0000-4000-8000-000000000003';
const available: NonNullable<SearchPage['results'][number]['excerpt']> = {
  status: 'available', text: 'The night library sheltered travellers. <strong>雨</strong>', language: 'en',
  resource, revision, variant,
};

test('the typed adapter preserves exact excerpt provenance and each unavailable reason without fabricating text', async () => {
  const excerpts = [available, ...(['unavailable', 'not-matching', 'unsupported-format', 'not-hydrated'] as const)
    .map(reason => ({ status: 'unavailable' as const, reason })), undefined];
  for (const excerpt of excerpts) {
    const page: SearchPage = { profile: 'public-main-phrase-page-v1', context: 'main-version-default',
      resultGrain: 'mainVersion', relationComplete: true, population: 1, total: 1,
      sourcePosition: { datasetId: 'product', dataEpoch: 'fixture', sequence: '12' }, indexGeneration: 'fixture', next: null,
      facets: { populationBasis: 'all-filters', resultGrain: 'work', languages: { precision: 'exact', values: [] },
        terms: { precision: 'lower-bound', values: [] }, types: { precision: 'exact', values: [] } },
      results: [{ matchUnit: 'unit', work: resource, mainVersion: resource, contribution: 'contribution',
        revision, selection: 'selection', language: 'en', score: 1, types: [], matchedField: 'body', excerpt,
        matchedChapter: { post: resource, book: resource, title: 'At the harbour' } }],
    };
    const main = browserMainApi('https://story.invalid', { anonymous: true,
      fetcher: Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        return Response.json(request.url.endsWith('/v1/query') ? { result: page } : { summaries: [] });
      }, { preconnect: fetch.preconnect }) });
    const read = await readSearchPage({ search: main, names: main },
      { phrase: 'night library', scope: { kind: 'global' }, language: null, term: null }, { language: 'en' });
    if (!read.ok) throw new Error('Expected the contract-shaped fixture page');
    expect(read.page.hits[0]?.excerpt).toEqual(excerpt);
    expect(read.page.hits[0]?.reasons.chapter?.href).toContain('/read/00000000-0000-4000-8000-000000000001?language=en');
    expect(read.page.hits[0]?.reasons.matchedText).toBeNull();
  }
});
