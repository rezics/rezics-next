import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { EVENT_TYPES } from '../../src/events/catalogue.ts';
import { applyRatingChanges } from '../../src/rating/aggregate-effect.ts';
import {
  drainPublicFigures,
  pagePublicFigures,
  readPublicFigures,
  type PublicFigure,
} from '../../src/rating/public-figure.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 0x4321;
const figureEvent = 'com.rezics.rating.public_figure.changed.v1';
const at = '2026-10-27T10:00:00.000Z';
let database: GrowthDatabase;

function change(input: {
  targetId: string;
  populationId: string;
  units: number;
  voterId?: string;
  ordinal: number;
  questionId?: string;
}) {
  return {
    voterId: input.voterId ?? newId(route),
    countingKey: input.ordinal.toString(16).padStart(2, '0').padEnd(64, '0'),
    questionId: input.questionId ?? STANDARD_QUESTION_ID,
    populationId: input.populationId,
    targetId: input.targetId,
    units: input.units,
    revision: 1,
    at,
  };
}

async function figureEvents(targetId: string): Promise<PublicFigure[]> {
  const result = await database.admin.query<{ data: unknown }>(
    `SELECT data FROM core.outbox WHERE type = $1 AND subject = $2 ORDER BY position, event_seq`,
    [figureEvent, targetId],
  );
  return result.rows.map(({ data }) => data as PublicFigure);
}

beforeAll(async () => {
  database = await openGrowthDatabase();
});

afterAll(async () => {
  await database?.close();
});

test('a vote change publishes one figure event for each affected population, with mean only at or above the threshold', async () => {
  expect(EVENT_TYPES[figureEvent]).toBeDefined();
  const targetId = newId(route);
  const realmId = newId(0x5321);
  const populations = [GLOBAL_CONTEXT.id, realmId];
  const firstBatch = Array.from({ length: 4 }, (_, index) =>
    populations.map((populationId) =>
      change({ targetId, populationId, units: index * 2, ordinal: index * 2 + (populationId === realmId ? 100 : 1) }),
    ),
  ).flat();
  await applyRatingChanges(database.pool, firstBatch);

  const partition = partitionOf(routeOf(targetId)!);
  expect(await drainPublicFigures(database.pool, partition)).toBe(2);
  const firstEvents = await figureEvents(targetId);
  expect(firstEvents).toHaveLength(2);
  expect(firstEvents.map((event) => event.populationId).sort()).toEqual([...populations].sort());
  for (const event of firstEvents) {
    expect(event).toMatchObject({ questionId: STANDARD_QUESTION_ID, subjectId: targetId, count: 4, mean: null });
    expect(event.score).toBeNull();
    expect(event.priorEpoch).toBeNull();
    expect(event.m).toBeNull();
    expect(event.C).toBeNull();
  }

  await applyRatingChanges(
    database.pool,
    populations.map((populationId, index) => change({ targetId, populationId, units: 8, ordinal: 200 + index })),
  );
  expect(await drainPublicFigures(database.pool, partition)).toBe(2);
  const events = await figureEvents(targetId);
  expect(events).toHaveLength(4);
  for (const event of events.slice(2)) {
    expect(event).toMatchObject({ count: 5, mean: 2, score: null, priorEpoch: null });
  }
});

test('many votes on one subject coalesce into one figure event per drain with an increasing revision', async () => {
  const targetId = newId(route);
  const populationId = GLOBAL_CONTEXT.id;
  const voters = Array.from({ length: 20 }, (_, ordinal) =>
    change({ targetId, populationId, units: ordinal % 21, ordinal: ordinal + 1 }),
  );
  await applyRatingChanges(database.pool, voters);
  const partition = partitionOf(routeOf(targetId)!);
  expect(await drainPublicFigures(database.pool, partition)).toBe(1);

  await applyRatingChanges(
    database.pool,
    Array.from({ length: 10 }, (_, ordinal) => change({ targetId, populationId, units: 6, ordinal: 50 + ordinal })),
  );
  expect(await drainPublicFigures(database.pool, partition)).toBe(1);

  const events = await figureEvents(targetId);
  expect(events).toHaveLength(2);
  expect(events.map((event) => event.revision)).toEqual(['1', '2']);
  expect(events.map((event) => event.count)).toEqual([20, 30]);
  expect(await drainPublicFigures(database.pool, partition)).toBe(0);
});

test('readPublicFigures and pagePublicFigures return the same current figures the events carried, in one statement per call', async () => {
  const targetId = newId(route);
  const populationId = GLOBAL_CONTEXT.id;
  await applyRatingChanges(
    database.pool,
    Array.from({ length: 7 }, (_, ordinal) => change({ targetId, populationId, units: 10, ordinal: ordinal + 1 })),
  );
  const partition = partitionOf(routeOf(targetId)!);
  expect(await drainPublicFigures(database.pool, partition)).toBe(1);
  const event = (await figureEvents(targetId))[0]!;
  expect(event).toBeDefined();

  let statements = 0;
  const client = {
    query(...args: Parameters<GrowthDatabase['pool']['query']>) {
      statements += 1;
      return database.pool.query(...args);
    },
  } as GrowthDatabase['pool'];
  const requested = { partition, questionId: STANDARD_QUESTION_ID, populationId, subjectIds: [targetId] };
  const figures = await readPublicFigures(client, requested);
  expect(statements).toBe(1);
  expect(figures).toEqual([event]);

  statements = 0;
  const page = await pagePublicFigures(client, {
    partition,
    questionId: STANDARD_QUESTION_ID,
    populationId,
    after: null,
    limit: 500,
  });
  expect(statements).toBe(1);
  expect(page.filter(({ subjectId }) => subjectId === targetId)).toEqual([event]);
});

test('Realm-defined questions do not publish public figures', async () => {
  const targetId = newId(route);
  const populationId = GLOBAL_CONTEXT.id;
  const realmQuestionId = newId(route);
  await database.admin.query(
    `INSERT INTO rating.question
       (id, owner_id, revision, label, grain, minimum_units, maximum_units, step_units)
     VALUES ($1, $2, 1, 'Realm question', 'work', 0, 20, 1)`,
    [realmQuestionId, newId(route)],
  );
  await applyRatingChanges(database.pool, [
    change({ targetId, populationId, units: 10, ordinal: 1, questionId: realmQuestionId }),
  ]);
  expect(await drainPublicFigures(database.pool, partitionOf(routeOf(targetId)!))).toBe(0);
  expect(await figureEvents(targetId)).toEqual([]);
});
