import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { publicPhrasePageResult } from '../src/api-contract.ts';
import { resourceSummaryBatch } from '../src/modules/search/summary-contract.ts';
import { decoratePhraseRelation, facetPhraseResults } from '../src/modules/work/search-facets.ts';
import { pageCompletePublicRelation, SearchContinuationRestart } from '../src/modules/work/search-continuation.ts';
import { SearchSnapshotMoved } from '../src/modules/work/search-readiness.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';

const book = 'https://schema.org/Book';
const recipe = 'https://schema.org/Recipe';
const work = (n: number) => `https://rezics.com/id/${String(n).padStart(8, '0')}-4b5a-4c6d-8e7f-9a0b1c2d3e4f`;
const position = { datasetId: 'product' as const, dataEpoch: 'e', sequence: '7' };
const rows = [
  { work: work(1), language: 'en', types: [book, recipe], classification: { sense: work(10) } },
  { work: work(2), language: 'zh-Hans', types: [book] },
  { work: work(3), language: 'en', types: [] },
];

test('phrase facets count the filtered Work population and label unresolved terms as lower bounds', () => {
  const { results, facets } = facetPhraseResults(rows, { includeTypes: [book],
    excludeTypes: [recipe] });
  expect(results.map(row => row.work)).toEqual([work(2)]);
  expect(facets.languages).toEqual({ precision: 'exact', values: [{ value: 'zh-Hans', count: 1 }] });
  expect(facets.terms).toEqual({ precision: 'lower-bound', values: [] });
  expect(facets.types.values.find(row => row.value === book)?.count).toBe(1);
  expect(() => facetPhraseResults(rows, { includeTypes: [book], excludeTypes: [book] })).toThrow();
});

test('typed phrase cards reject a moved Work head before counts or cards are returned', async () => {
  let sequence = '7';
  const env = { fuseki: { query: async () => ({ results: { bindings: rows.flatMap(row =>
    (row.types.length ? row.types : [null]).map(type => ({
      work: { value: row.work }, epoch: { value: 'e' }, sequence: { value: sequence },
      ...(type ? { type: { value: type } } : {}),
    }))) } }) } } as unknown as WorkActivationEnvironment;
  const relation = { resultGrain: 'mainVersion' as const, context: 'main-version-default' as const,
    complete: true as const, population: 10, total: 3, sourcePosition: position,
    indexGeneration: 'index', results: rows.map((row, index) => ({ ...row,
      matchUnit: work(index + 20), mainVersion: work(index + 30), contribution: work(index + 40),
      revision: work(index + 50), selection: work(index + 60), score: 1 })) };
  const decorated = await decoratePhraseRelation(env, relation, { excludeTypes: [recipe] });
  expect(decorated.total).toBe(2);
  expect(decorated.results[0]?.types).toEqual([book]);
  const input = { profile: 'public-main-phrase-page-v1' as const, phrase: 'books', language: null,
    pageSize: 1, excludeTypes: [recipe] };
  const first = pageCompletePublicRelation(input, decorated, 1000);
  expect(Value.Check(publicPhrasePageResult, { ...first, facets: decorated.facets })).toBe(true);
  expect(() => pageCompletePublicRelation({ ...input, excludeTypes: [], continuation: first.next! },
    decorated, 1001)).toThrow(SearchContinuationRestart);
  sequence = '8';
  await expect(decoratePhraseRelation(env, relation, {})).rejects.toBeInstanceOf(SearchSnapshotMoved);
});

test('resource summary batch schema identifies available cards and unavailable resources', () => {
  const response = { profile: 'resource-summary-batch-v1', complete: true,
    summaries: [{ reference: work(1), status: 'available', type: 'work', disclosure: 'public',
      base: 'work', work: work(1),
      address: { prefix: '/w/',key: 'book',suffixSource: 'Book' },
      name: { value: 'Book', language: 'en', direction: 'ltr', basis: 'requested' },
      avatar: { kind: 'fallback', policy: 'avatar-fallback-v1', key: work(1), resourceType: 'work' } },
    { reference: work(2), status: 'unavailable' }],
    generation: { graph: 'e:7', media: null },
    cost: { graphQueries: 1, mediaQueries: 0, accessChecks: 0, accessQueries: 0 } };
  expect(Value.Check(resourceSummaryBatch, response)).toBe(true);
  expect(Value.Check(resourceSummaryBatch, { ...response, summaries: [{ reference: work(2),
    status: 'available' }] })).toBe(false);
});
