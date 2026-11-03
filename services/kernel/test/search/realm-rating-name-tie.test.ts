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
};
const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(19)]]) };
const binding = {
  operation: 'subjects.search.realm_rating',
  principal: 'anonymous',
  request: { sort: 'rating' },
};

test('Search preserves the producer name tie when UUID order points the other way', async () => {
  const source = createFakeSource();
  const older = id(1);
  const newer = id(2);
  source.put({
    id: older,
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
    id: newer,
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
      id: newer,
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
        subjectId: newer,
        count: 5,
        mean: 5,
        score: 8,
        priorEpoch: 17,
        revision: '3',
        asOf: context.asOf,
      },
      sort: [8, 'Alpha', newer],
    },
    {
      id: older,
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
        subjectId: older,
        count: 5,
        mean: 5,
        score: 8,
        priorEpoch: 17,
        revision: '3',
        asOf: context.asOf,
      },
      sort: [8, 'Zeta', older],
    },
  ];
  const ratings: RealmRatingSource = {
    async observe() {
      return structuredClone(context);
    },
    async read(_input, _observed, request) {
      const start = request.after ? hits.findIndex((hit) => hit.id === request.after!.at(-1)) + 1 : 0;
      const snapshot = await source.read(10, []);
      return {
        context: structuredClone(context),
        hits: hits.slice(start, start + request.size).map((hit) => ({ ...hit, position: snapshot.position })),
      };
    },
  };

  const page = await readRealmRatingOrder({
    ratings,
    source,
    query,
    cursors: ring,
    binding,
    limit: 2,
    now: 1000,
  });
  expect(older.localeCompare(newer)).toBeLessThan(0);
  expect(page.subjects.map(({ id: subjectId }) => subjectId)).toEqual([newer, older]);
  expect(page.next).toBeNull();
  await page.finalize();
});
