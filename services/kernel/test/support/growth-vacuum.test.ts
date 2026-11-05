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
  readonly vacuumCount: number;
  readonly analyzeCount: number;
};

type Observation = Statistics & { readonly scale: number; readonly phase: 'warmup' | 'operation' };

const observations: Observation[] = [];
const beforeGrow: Array<{ readonly scale: number; readonly vacuumCount: number; readonly analyzeCount: number }> = [];

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

async function readStatistics(database: GrowthDatabase): Promise<Statistics> {
  const result = await database.admin.query<Statistics>(
    `SELECT c.reltuples::integer AS reltuples,
            c.relpages,
            s.vacuum_count::integer AS "vacuumCount",
            s.analyze_count::integer AS "analyzeCount"
     FROM pg_class AS c
     JOIN pg_stat_user_tables AS s ON s.relid = c.oid
     WHERE c.oid = '${table}'::regclass`,
  );
  return result.rows[0]!;
}

async function observe(database: GrowthDatabase, scale: number, phase: Observation['phase']): Promise<Statistics> {
  // The measured statement: a primary-key lookup of one row, constant in the scale. The observation reads through
  // database.admin and is not captured.
  await withConnection(database.pool, (client) => client.query(`SELECT payload FROM ${table} WHERE id = 1`));
  const statistics = await readStatistics(database);
  observations.push({ scale, phase, ...statistics });
  return statistics;
}

test('every scale is vacuumed and analyzed after grow and before its first run', async () => {
  observations.length = 0;
  beforeGrow.length = 0;
  const database = db!;

  await checkGrowth(database, {
    name: 'growth vacuum statistics',
    bounds: { rows: 'constant', blocks: 'constant', statements: 'constant' },
    grow: async (growthDb, scale, previous) => {
      const statistics = await readStatistics(growthDb);
      beforeGrow.push({ scale, vacuumCount: statistics.vacuumCount, analyzeCount: statistics.analyzeCount });
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
    const baseline = beforeGrow.find(({ scale }) => scale === observation.scale)!;
    expect(observation.reltuples).toBe(rows);
    expect(observation.relpages).toBeGreaterThan(0);
    expect(observation.vacuumCount).toBe(baseline.vacuumCount + 1);
    expect(observation.analyzeCount).toBe(baseline.analyzeCount + 1);
  }
  expect(observations.filter(({ phase }) => phase === 'operation')).toHaveLength(15);
}, 60_000);
