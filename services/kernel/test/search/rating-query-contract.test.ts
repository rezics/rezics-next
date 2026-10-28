import { expect, test } from 'bun:test';
import type { OpenSearch } from '../../src/search/opensearch.ts';
import {
  SEARCH_TEMPLATE,
  searchSubjects,
  type SearchHit,
  type SearchPlan,
  type SearchResult,
} from '../../src/search/query.ts';
import { searchRatingSubjects, type RatingQueryPlan } from '../../src/search/rating-query.ts';
import type { PublicRatingEpoch } from '../../src/search/rating-source.ts';

const id = '00000000-0000-8000-8000-00a000000001';
const rating: PublicRatingEpoch = {
  questionId: id,
  populationId: '00000000-0000-8000-8000-000000000000',
  priorEpoch: 7,
};
const plan: RatingQueryPlan = { rating, size: 2 };

// Compiled by the shared typecheck; no valid request's temporary runtime outcome is frozen here.
function typeContract(hit: SearchHit) {
  const native: RatingQueryPlan = {
    ...plan,
    query: {},
    filter: {},
    boost: 'title',
    overflowProperties: [id],
    ratingPhase: 'scored',
    generation: 1,
    after: [0, null, id],
  };
  const publicPlan: SearchPlan = { ...native, sort: 'rating' };
  const empty: SearchResult = { hits: [], generation: 1, total: { value: 0, relation: 'exact' } };
  const mixed: SearchResult = {
    ...empty,
    hits: [
      { ...hit, ratingPhase: 'scored' },
      { ...hit, ratingPhase: 'unscored' },
    ],
  };
  // @ts-expect-error The native entry point requires rating metadata.
  const missing: RatingQueryPlan = { size: 2 };
  // @ts-expect-error Phases form a closed set.
  const unknownPhase: RatingQueryPlan = { ...native, ratingPhase: 'private' };
  return { publicPlan, empty, mixed, missing, unknownPhase };
}
void typeContract;

test('rating query metadata is admitted explicitly and invalid Global metadata never reaches the engine', async () => {
  let calls = 0;
  const noIO = () => {
    calls++;
    throw new Error('Unexpected engine access');
  };
  const search: OpenSearch = { request: noIO, bulk: noIO };
  const badMetadata: unknown[] = [
    undefined,
    null,
    [],
    'Global',
    {},
    ...['', id, rating.populationId + '\n', '00000000-0000-8000-8000-0000000', 0].map((populationId) => ({
      ...rating,
      populationId,
    })),
    ...['', id + '\n', id.toUpperCase(), '00000000-0000-4000-8000-00a000000001', 7].map((questionId) => ({
      ...rating,
      questionId,
    })),
    ...[undefined, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '7', 7n].map((priorEpoch) => ({
      ...rating,
      priorEpoch,
    })),
  ];
  for (const context of badMetadata) {
    const invalid = { ...plan, rating: context } as RatingQueryPlan;
    await expect(searchRatingSubjects(search, 'test-', invalid, SEARCH_TEMPLATE)).rejects.toBeInstanceOf(TypeError);
    await expect(
      Promise.resolve().then(() => searchSubjects(search, 'test-', { ...invalid, sort: 'rating' })),
    ).rejects.toBeInstanceOf(TypeError);
  }
  const badPlans: unknown[] = [
    ...[0, -1, 201, 1.5, NaN, Infinity, '2', null].map((size) => ({ ...plan, size })),
    ...[0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1', null].map((generation) => ({
      ...plan,
      generation,
    })),
    ...['private', '', null, 0].map((ratingPhase) => ({ ...plan, ratingPhase })),
    { ...plan, rating: { ...rating, priorEpoch: null }, ratingPhase: 'scored' },
    { ...plan, after: ['A', id] },
    ...[null, [], ['A'], [0, 'A', id], ['A', id + '\n'], [false, id], ['x'.repeat(513), id], ['\ud800', id]].map(
      (after) => ({ ...plan, ratingPhase: 'unscored', after }),
    ),
    ...[
      [],
      ['A', id],
      [null, 'A', id],
      [NaN, 'A', id],
      [Infinity, 'A', id],
      [-1, 'A', id],
      [11, 'A', id],
      ['0', 'A', id],
      [0, 1, id],
      [0, 'A', 'bad'],
    ].map((after) => ({ ...plan, ratingPhase: 'scored', after })),
  ];
  for (const invalid of badPlans) {
    const native = invalid as RatingQueryPlan;
    for (const invoke of [
      () => searchRatingSubjects(search, 'test-', native, SEARCH_TEMPLATE),
      () => searchSubjects(search, 'test-', { ...native, sort: 'rating' }),
    ]) {
      const error = await Promise.resolve()
        .then(invoke)
        .catch((error: unknown) => error);
      expect(error instanceof TypeError || error instanceof RangeError).toBe(true);
    }
  }
  expect(calls).toBe(0);
});
