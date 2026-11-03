import { expect, test } from 'bun:test';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import {
  readRealmRatingOrder,
  type RealmRatingContext,
  type RealmRatingHit,
  type RealmRatingQuery,
  type RealmRatingSource,
} from '../../src/search/realm-rating-order.ts';
import { createFakeSource } from './support/fake-source.ts';

const id = (n: number) => `018f0000-0000-7000-8000-00a0${String(n).padStart(8, '0')}`;
const populationId = id(900);
const context: RealmRatingContext = {
  questionId: STANDARD_QUESTION_ID,
  populationId,
  priorEpoch: 17,
  realm: { authority: 'realm-read-1', revision: 'figures-1' },
  generation: 1,
  asOf: '2026-11-01T00:00:00.000Z',
  questionIdentity: 'standard-question-1',
  questionRevision: 1,
  questionProvenance: 'provenance-1',
  observation: 'observation-1',
  priorGeneration: '17',
  canonicalGeneration: 'canonical-1',
  publicationGeneration: 'publication-1',
  meaningDigest: null,
  searchGeneration: 1,
  priorActive: true,
  priorUpdating: false,
};
const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(19)]]) };
const binding = {
  operation: 'subjects.search.realm_rating',
  principal: 'anonymous',
  request: { sort: 'rating' },
};

function fixture() {
  const source = createFakeSource();
  const zeta = id(2);
  const alpha = id(1);
  source.put({
    id: zeta,
    type: 'schema:Book',
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [{ language: 'en', value: 'Zeta' }],
    aliases: [],
    descriptions: [],
    statements: [],
  });
  source.put({
    id: alpha,
    type: 'schema:Book',
    visibility: 'visible',
    redirect: null,
    securityRevision: 1,
    labels: [{ language: 'en', value: 'Alpha' }],
    aliases: [],
    descriptions: [],
    statements: [],
  });

  const query: RealmRatingQuery = {
    principal: 'anonymous',
    populationId,
    release: undefined,
    meaningDigest: undefined,
    text: undefined,
    filter: undefined,
    deadline: Date.now() + 60_000,
  };
  const hits: RealmRatingHit[] = [
    {
      id: alpha,
      index: 'native-realm',
      partition: 10,
      securityRevision: 1,
      matched: [],
      ratingPhase: 'scored',
      position: 0n,
      threshold: 5,
      figure: {
        questionId: STANDARD_QUESTION_ID,
        populationId,
        subjectId: alpha,
        count: 5,
        mean: 5,
        score: 8,
        priorEpoch: 17,
        revision: '3',
        asOf: context.asOf,
      },
      sort: [8, 'Alpha', alpha],
    },
    {
      id: zeta,
      index: 'native-realm',
      partition: 10,
      securityRevision: 1,
      matched: [],
      ratingPhase: 'scored',
      position: 0n,
      threshold: 5,
      figure: {
        questionId: STANDARD_QUESTION_ID,
        populationId,
        subjectId: zeta,
        count: 5,
        mean: 5,
        score: 8,
        priorEpoch: 17,
        revision: '3',
        asOf: context.asOf,
      },
      sort: [8, 'Zeta', zeta],
    },
  ];
  const ratings: RealmRatingSource = {
    async observe() {
      return structuredClone(context);
    },
    async readScoredFrontiers(_input, _observed, request) {
      const start = request.after ? hits.findIndex((hit) => hit.id === request.after!.at(-1)) + 1 : 0;
      const snapshot = await source.read(10, []);
      return {
        context: structuredClone(context),
        partitions: [
          {
            partition: 10,
            hits: hits.slice(start, start + request.size).map((hit) => ({ ...hit, position: snapshot.position })),
          },
        ],
      };
    },
    async readUnscored() {
      return { context: structuredClone(context), hits: [] };
    },
  };

  const run = (cursor?: string) =>
    readRealmRatingOrder({
      ratings,
      source,
      query,
      cursors: ring,
      binding,
      limit: 1,
      now: 1000,
      ...(cursor ? { cursor } : {}),
    });
  return { run, ratings, hits, alpha, zeta };
}

test('canonical name ties oppose legacy descending UUID order across first, next and final pages', async () => {
  const f = fixture();
  expect(f.alpha.localeCompare(f.zeta)).toBeLessThan(0);
  const first = await f.run();
  expect(first.subjects.map(({ id }) => id)).toEqual([f.alpha]);
  expect(first.next).toBeString();
  await first.finalize();
  const next = await f.run(first.next!);
  expect(next.subjects.map(({ id }) => id)).toEqual([f.zeta]);
  expect(next.next).toBeString();
  await next.finalize();
  const final = await f.run(next.next!);
  expect(final.subjects).toEqual([]);
  expect(final.next).toBeNull();
  await final.finalize();
});

test('an unscored seek cannot disclose a scored tuple from a different partition of the order', async () => {
  const f = fixture();
  f.ratings.readScoredFrontiers = async () => ({ context: structuredClone(context), partitions: [] });
  f.ratings.readUnscored = async () => ({ context: structuredClone(context), hits: f.hits });
  await expect(f.run()).rejects.toMatchObject({ code: 'index_not_ready' });
});
