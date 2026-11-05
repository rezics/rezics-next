import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { createPublicRatingSource } from '../../src/rating/public-rating-source.ts';
import { STANDARD_QUESTION_ID } from '../../src/rating/votes.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 0x4321;
const partition = partitionOf(route);
const priorEpochRoute = routeOf(GLOBAL_CONTEXT.id)!;
let database: GrowthDatabase;

beforeAll(async () => {
  database = await openGrowthDatabase();
});

afterAll(async () => {
  await database?.close();
});

function queryText(query: unknown): string {
  if (typeof query === 'string') return query;
  if (typeof query === 'object' && query !== null && 'text' in query && typeof query.text === 'string')
    return query.text;
  return '';
}

function poolMutatingBetweenSnapshotReads(pool: Pool, mutate: () => Promise<void>, statements: string[]): Pool {
  return {
    async connect() {
      const client = await pool.connect();
      const query = client.query.bind(client);
      let mutated = false;
      client.query = (async (...args: unknown[]) => {
        const sql = queryText(args[0]);
        statements.push(sql);
        const result = await Reflect.apply(query, client, args);
        if (!mutated && /\b(?:core\.partition|rating\.public_figure)\b/i.test(sql)) {
          mutated = true;
          await mutate();
        }
        return result;
      }) as typeof client.query;
      return client;
    },
  } as unknown as Pool;
}

test("read returns the Global standard question's current figures for at most 256 anchored subjects with the partition position from the same repeatable-read snapshot", async () => {
  const subjectIds = Array.from({ length: 256 }, () => newId(route));
  const firstSubjectId = subjectIds[0]!;
  const zeroCountSubjectId = subjectIds.at(-1)!;
  await database.admin.query('UPDATE core.partition SET position = 10 WHERE partition_no = $1', [partition]);
  await database.admin.query(
    `INSERT INTO rating.public_figure
       (route, question_id, population_id, subject_id, count, mean, score, m, c, prior_epoch, revision, as_of, position)
     SELECT $1, $2, $3, requested.subject_id,
            CASE WHEN requested.subject_id = $4::uuid THEN 0 ELSE 5 END,
            CASE WHEN requested.subject_id = $4::uuid THEN NULL ELSE 6.5 END,
            NULL, NULL, NULL, NULL, 1, '2026-10-28T10:00:00Z', 4
     FROM unnest($5::uuid[]) AS requested(subject_id)`,
    [route, STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id, zeroCountSubjectId, subjectIds],
  );

  const statements: string[] = [];
  const pool = poolMutatingBetweenSnapshotReads(
    database.pool,
    async () => {
      await database.admin.query('UPDATE core.partition SET position = 11 WHERE partition_no = $1', [partition]);
      await database.admin.query(
        `UPDATE rating.public_figure
         SET mean = 8, revision = 2
         WHERE route = $1 AND question_id = $2 AND population_id = $3 AND subject_id = $4`,
        [route, STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id, firstSubjectId],
      );
    },
    statements,
  );
  const source = createPublicRatingSource(pool);
  const snapshot = await source.read(partition, subjectIds);

  expect(snapshot.partition).toBe(partition);
  expect(snapshot.position).toBe(10n);
  expect(snapshot.figures.size).toBe(255);
  expect(snapshot.figures.get(firstSubjectId)).toEqual({
    questionId: STANDARD_QUESTION_ID,
    populationId: GLOBAL_CONTEXT.id,
    subjectId: firstSubjectId,
    count: 5,
    mean: 6.5,
    score: null,
    priorEpoch: null,
    revision: '1',
    asOf: '2026-10-28T10:00:00.000Z',
  });
  expect(snapshot.figures.has(zeroCountSubjectId)).toBe(false);
  expect(statements[0]?.toUpperCase()).toContain('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  expect(statements.filter((sql) => /\b(?:core\.partition|rating\.public_figure)\b/i.test(sql))).toHaveLength(2);
  expect(statements.at(-1)?.toUpperCase()).toBe('COMMIT');

  const countBeforeInvalidRead = statements.length;
  await expect(source.read(partition, [...subjectIds, newId(route)])).rejects.toBeInstanceOf(RangeError);
  expect(statements).toHaveLength(countBeforeInvalidRead);
});

test('epoch returns the current prior epoch, null below 50 counted votes, and never reuses an epoch number', async () => {
  const source = createPublicRatingSource(database.pool);
  expect(await source.epoch()).toEqual({
    questionId: STANDARD_QUESTION_ID,
    populationId: GLOBAL_CONTEXT.id,
    priorEpoch: null,
  });

  await database.admin.query(
    `INSERT INTO rating.population_prior_epoch
       (route, question_id, population_id, epoch, generation, start_count, m, c)
     VALUES ($1, $2, $3, 1, 1, 50, 5, 10)`,
    [priorEpochRoute, STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id],
  );
  expect(await source.epoch()).toEqual({
    questionId: STANDARD_QUESTION_ID,
    populationId: GLOBAL_CONTEXT.id,
    priorEpoch: 1,
  });

  await database.admin.query(
    `UPDATE rating.population_prior_epoch
     SET generation = 2, start_count = NULL, m = NULL, c = NULL
     WHERE route = $1 AND question_id = $2 AND population_id = $3`,
    [priorEpochRoute, STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id],
  );
  expect(await source.epoch()).toEqual({
    questionId: STANDARD_QUESTION_ID,
    populationId: GLOBAL_CONTEXT.id,
    priorEpoch: null,
  });

  await database.admin.query(
    `UPDATE rating.population_prior_epoch
     SET epoch = 2, generation = 3, start_count = 100, m = 5, c = 10
     WHERE route = $1 AND question_id = $2 AND population_id = $3`,
    [priorEpochRoute, STANDARD_QUESTION_ID, GLOBAL_CONTEXT.id],
  );
  expect(await source.epoch()).toEqual({
    questionId: STANDARD_QUESTION_ID,
    populationId: GLOBAL_CONTEXT.id,
    priorEpoch: 2,
  });
});

test('a subject with no votes is absent from the snapshot and a wrong-partition id is refused', async () => {
  const subjectId = newId(route);
  const source = createPublicRatingSource(database.pool);
  const snapshot = await source.read(partition, [subjectId]);

  expect(snapshot.figures.has(subjectId)).toBe(false);
  await expect(source.read(partition + 1, [subjectId])).rejects.toBeInstanceOf(RangeError);
});
