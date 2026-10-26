import { afterAll, beforeAll, expect, test } from 'bun:test';
import { withConnection } from '../../src/database/pool.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from './growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const schema = 'growth_vacuum_test';
const table = `${schema}.records`;
const rowsPerScale = 512;
let db: GrowthDatabase | undefined;

type Statistics = {
  readonly reltuples: number;
  readonly relpages: number;
  readonly relallvisible: number;
};

type Observation = Statistics & { readonly scale: number; readonly phase: 'warmup' | 'operation' };

const observations: Observation[] = [];

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  await db.admin.query(`CREATE SCHEMA ${schema}`);
  await db.admin.query(`CREATE TABLE ${table} (
    id integer PRIMARY KEY,
    payload text NOT NULL
  ) WITH (autovacuum_enabled = false)`);
});

afterAll(async () => {
  if (!db) return;
  await db.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.close();
});

async function observe(database: GrowthDatabase, scale: number, phase: Observation['phase']): Promise<Statistics> {
  const result = await withConnection(database.pool, (client) =>
    client.query<Statistics>(
      `SELECT reltuples::integer AS reltuples, relpages, relallvisible
       FROM pg_class
       WHERE oid = '${table}'::regclass`,
    ),
  );
  const statistics = result.rows[0]!;
  observations.push({ scale, phase, ...statistics });
  return statistics;
}

test('every scale is vacuumed and analyzed after grow and before its first run', async () => {
  observations.length = 0;
  const database = db!;

  await checkGrowth(database, {
    name: 'growth vacuum statistics',
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    grow: async (growthDb, scale, previous) => {
      const from = previous * rowsPerScale + 1;
      const to = scale * rowsPerScale;
      await growthDb.admin.query(
        `INSERT INTO ${table} (id, payload)
         SELECT id, 'seeded' FROM generate_series($1::integer, $2::integer) AS id`,
        [from, to],
      );
    },
    warmup: async (growthDb, scale) => observe(growthDb, scale, 'warmup'),
    operation: async (growthDb, scale) => observe(growthDb, scale, 'operation'),
  });

  const firstRuns = observations.filter(({ phase }) => phase === 'warmup');
  expect(firstRuns).toHaveLength(3);
  for (const observation of firstRuns) {
    const rows = observation.scale * rowsPerScale;
    expect(observation.reltuples).toBe(rows);
    expect(observation.relpages).toBeGreaterThan(0);
    expect(observation.relallvisible).toBe(observation.relpages);
  }
  expect(observations.filter(({ phase }) => phase === 'operation')).toHaveLength(15);
}, 60_000);
