import { afterAll, beforeAll, expect, test } from 'bun:test';
import { withConnection } from '../../src/database/pool.ts';
import { checkGrowth, GrowthBoundError, openGrowthDatabase, type GrowthDatabase } from './growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const schema = 'growth_report_test';
const growing = `${schema}.growing`;
const constant = `${schema}.constant`;
let db: GrowthDatabase | undefined;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await db.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.admin.query(`CREATE SCHEMA ${schema}`);
  await db.admin.query(`CREATE TABLE ${growing} (id integer PRIMARY KEY)`);
  await db.admin.query(`CREATE TABLE ${constant} (id integer PRIMARY KEY)`);
  await db.admin.query(`INSERT INTO ${constant} SELECT generate_series(1, 500)`);
});

afterAll(async () => {
  if (!db) return;
  await db.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.close();
});

test("a growth report keeps every repetition's cost and the size of every relation the operation read at each scale", async () => {
  const database = db!;
  let error: GrowthBoundError | undefined;
  try {
    await checkGrowth(database, {
      name: 'growth report evidence',
      repetitions: 2,
      bounds: { rows: 'constant', blocks: 'linear', statements: 'constant' },
      grow: async (growthDb, scale, previous) => {
        await growthDb.admin.query(`INSERT INTO ${growing} SELECT generate_series($1 + 1, $2)`, [
          previous * 500,
          scale * 500,
        ]);
      },
      operation: (growthDb) =>
        withConnection(growthDb.pool, (client) =>
          client.query(
            `SELECT (SELECT count(*) FROM ${growing}) AS growing,
                    (SELECT count(*) FROM ${constant}) AS constant`,
          ),
        ),
    });
  } catch (caught) {
    if (!(caught instanceof GrowthBoundError)) throw caught;
    error = caught;
  }

  expect(error).toBeInstanceOf(GrowthBoundError);
  const samples = error!.samples;
  expect(samples.map(({ repetitions }) => repetitions?.map(({ rows }) => rows))).toEqual([
    [1000, 1000],
    [4500, 4500],
    [32500, 32500],
  ]);
  expect(samples.map(({ relationSizes }) => relationSizes)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ [growing]: expect.objectContaining({ reltuples: 500, relpages: expect.any(Number) }) }),
      expect.objectContaining({
        [constant]: expect.objectContaining({ reltuples: 500, relpages: expect.any(Number) }),
      }),
    ]),
  );
  expect(samples.map(({ relationSizes }) => relationSizes?.[growing]?.reltuples)).toEqual([500, 4000, 32000]);
  expect(samples.map(({ relationSizes }) => relationSizes?.[constant]?.reltuples)).toEqual([500, 500, 500]);
  expect(error!.message).toContain('rows repetitions by scale: 1 [1000, 1000], 8 [4500, 4500], 64 [32500, 32500]');
  expect(error!.message).toContain(`Relations whose reltuples did not grow: ${constant} (500 to 500)`);
}, 60_000);
