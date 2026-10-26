import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { processRatingSegmentPage, type RatingSegmentJob } from '../../src/rating/segment-job.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';

const route = 0x3a08;
const voters = [newId(route), newId(route), newId(route), newId(route)];
const realmId = newId(0x6b08);
const id = (ordinal: number) => `00000000-0000-7000-8000-3a08${ordinal.toString(16).padStart(8, '0')}`;
const transitionIds = [id(500001), id(500002), id(500003), id(500004)];
const job = (index: number): RatingSegmentJob => ({
  voterId: voters[index]!,
  realmId,
  direction: 'adding',
  transitionId: transitionIds[index]!,
});
let database: GrowthDatabase;

const population: Population = {
  name: 'rating segment voter votes',
  hotPartition: route >>> 4,
  hotShare: 1,
  rows: ({ ordinal }) => {
    const votes = voters.map((voterId, index) => ({
      route,
      voter_id: voterId,
      question_id: STANDARD_QUESTION_ID,
      target_id: id(ordinal + 1),
      units: ordinal % 21,
      revision: 1,
      changed_at: '2026-10-27T10:00:00.000Z',
      transaction_id: id(100000 + ordinal * 4 + index),
    }));
    return {
      'rating.vote': votes,
      ...(ordinal === 0
        ? {
            'rating.voter_realm': voters.map((voterId, index) => ({
              route,
              voter_id: voterId,
              realm_id: realmId,
              joined_at: '2026-10-27T10:00:00.000Z',
              state: 'adding',
              transition_id: transitionIds[index],
            })),
          }
        : {}),
    };
  },
};

const eligibilityVoters = Array.from({ length: 6 }, () => newId(route));
const eligibilityTransitionIds = eligibilityVoters.map((_, index) => id(600001 + index));
const eligibilityJob = (index: number): RatingSegmentJob => ({
  voterId: eligibilityVoters[index]!,
  eligibility: true,
  direction: 'removing',
  transitionId: eligibilityTransitionIds[index]!,
  populations: [GLOBAL_CONTEXT.id, realmId],
});
const eligibilityPopulation: Population = {
  name: 'rating eligibility voter votes',
  hotPartition: route >>> 4,
  hotShare: 1,
  rows: ({ ordinal }) => ({
    'rating.vote': eligibilityVoters.map((voterId, index) => ({
      route,
      voter_id: voterId,
      question_id: STANDARD_QUESTION_ID,
      target_id: id(ordinal + 1),
      units: ordinal % 21,
      revision: 1,
      changed_at: '2026-10-27T10:00:00.000Z',
      transaction_id: id(200000 + ordinal * 6 + index),
    })),
    ...(ordinal === 0
      ? {
          'rating.voter_realm': eligibilityVoters.map((voterId) => ({
            route,
            voter_id: voterId,
            realm_id: realmId,
            joined_at: '2026-10-27T10:00:00.000Z',
            state: 'counted',
          })),
          'rating.voter_state': eligibilityVoters.map((voterId, index) => ({
            route,
            voter_id: voterId,
            state: 'leaving',
            transition_id: eligibilityTransitionIds[index],
            purge_votes: false,
            populations: [GLOBAL_CONTEXT.id, realmId],
          })),
        }
      : {}),
  }),
};

const rekeyVoters = Array.from({ length: 6 }, () => newId(route));
const rekeyTransitionIds = rekeyVoters.map((_, index) => id(700001 + index));
const rekeyRealmId = newId(0x6b09);
const rekeyAt = '2026-10-27 12:00:00.123456+00';
const rekeyJob = (index: number): RatingSegmentJob =>
  ({
    voterId: rekeyVoters[index]!,
    direction: 'rekey',
    transitionId: rekeyTransitionIds[index]!,
    at: rekeyAt,
    populations: [GLOBAL_CONTEXT.id, rekeyRealmId],
  }) as RatingSegmentJob;
const rekeyPopulation: Population = {
  name: 'rating rekey voter votes',
  hotPartition: route >>> 4,
  hotShare: 1,
  rows: ({ ordinal }) => {
    const votes = rekeyVoters.map((voterId, index) => ({
      route,
      voter_id: voterId,
      question_id: STANDARD_QUESTION_ID,
      target_id: id(20001 + ordinal),
      units: ordinal % 21,
      revision: 1,
      changed_at: rekeyAt,
      transaction_id: id(300000 + ordinal * 6 + index),
    }));
    return {
      'rating.vote': votes,
      ...(ordinal === 0
        ? {
            'rating.voter_realm': rekeyVoters.map((voterId) => ({
              route,
              voter_id: voterId,
              realm_id: rekeyRealmId,
              joined_at: rekeyAt,
              state: 'counted',
            })),
          }
        : {}),
    };
  },
};

async function rekeyPage(db: GrowthDatabase, index: number): Promise<void> {
  const result = await processRatingSegmentPage(db.pool, { ...rekeyJob(index), after: null });
  if (result.eventData.direction !== 'rekey') throw new Error('Expected a re-key page');
  expect(result.eventData.votes).toHaveLength(100);
}

beforeAll(async () => {
  database = await openGrowthDatabase();
});

afterAll(async () => {
  if (database) await database.close();
});

test('segment page has constant rows and statements as voter votes grow', async () => {
  const result = await checkGrowth(database, {
    name: 'rating segment page',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (db, scale, previous) =>
      seed({ pool: db.pool, admin: db.admin }, population, { from: previous, to: scale }),
    operation: async (db, scale) =>
      processRatingSegmentPage(db.pool, {
        ...job(scale === 256 ? 0 : scale === 1024 ? 1 : 2),
        after: null,
      }),
    warmup: async (db) => processRatingSegmentPage(db.pool, { ...job(3), after: null }),
    repetitions: 1,
    warmups: 1,
  });
  expect(result.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
});

test('eligibility page has constant rows and statements as voter votes grow', async () => {
  const result = await checkGrowth(database, {
    name: 'rating eligibility page',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (db, scale, previous) =>
      seed({ pool: db.pool, admin: db.admin }, eligibilityPopulation, { from: previous, to: scale }),
    operation: async (db, scale) =>
      processRatingSegmentPage(db.pool, {
        ...eligibilityJob(scale === 256 ? 0 : scale === 1024 ? 1 : 2),
        after: null,
      }),
    warmup: async (db, scale) =>
      processRatingSegmentPage(db.pool, {
        ...eligibilityJob((scale === 256 ? 0 : scale === 1024 ? 1 : 2) + 3),
        after: null,
      }),
    repetitions: 1,
    warmups: 1,
  });
  expect(result.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
});

test('re-key page has constant rows and statements as voter votes grow', async () => {
  const result = await checkGrowth(database, {
    name: 'rating re-key page',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: async (db, scale, previous) =>
      seed({ pool: db.pool, admin: db.admin }, rekeyPopulation, { from: previous, to: scale }),
    operation: async (db, scale) => rekeyPage(db, scale === 256 ? 0 : scale === 1024 ? 1 : 2),
    warmup: async (db, scale) => rekeyPage(db, (scale === 256 ? 0 : scale === 1024 ? 1 : 2) + 3),
    repetitions: 1,
    warmups: 1,
  });
  expect(result.samples.map(({ scale }) => scale)).toEqual([256, 1024, 4096]);
});
