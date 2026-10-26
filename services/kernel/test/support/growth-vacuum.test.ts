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
  readonly vacuumCount: number;
  readonly analyzeCount: number;
};

type Observation = Statistics & { readonly scale: number; readonly phase: 'warmup' | 'operation' };

const observations: Observation[] = [];
const beforeGrow: Array<{ readonly scale: number; readonly vacuumCount: number; readonly analyzeCount: number }> = [];
const horizonEvidence: string[] = [];

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
  const result = await withConnection(database.pool, (client) =>
    client.query<Statistics>(
      `SELECT c.reltuples::integer AS reltuples,
              c.relpages,
              c.relallvisible,
              s.vacuum_count::integer AS "vacuumCount",
              s.analyze_count::integer AS "analyzeCount"
       FROM pg_class AS c
       JOIN pg_stat_user_tables AS s ON s.relid = c.oid
       WHERE c.oid = '${table}'::regclass`,
    ),
  );
  return result.rows[0]!;
}

function oneLine(value: unknown): string {
  return String(value ?? '<null>')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

async function recordHorizonHolders(database: GrowthDatabase, observation: Observation): Promise<void> {
  const activity = await database.admin.query<{
    backendType: string | null;
    state: string | null;
    xactStart: Date | null;
    queryText: string | null;
  }>(`SELECT backend_type AS "backendType",
             state,
             xact_start AS "xactStart",
             left(query, 80) AS "queryText"
      FROM pg_stat_activity
      WHERE datname = current_database() AND backend_xmin IS NOT NULL
      ORDER BY pid`);
  for (const holder of activity.rows) {
    horizonEvidence.push(
      `scale=${observation.scale} pg_stat_activity backend_type=${oneLine(holder.backendType)} state=${oneLine(
        holder.state,
      )} xact_start=${oneLine(holder.xactStart)} query=${oneLine(holder.queryText)}`,
    );
  }

  const slots = await database.admin.query<{ slotName: string; xmin: string | null }>(
    `SELECT slot_name AS "slotName", xmin::text
     FROM pg_replication_slots
     WHERE xmin IS NOT NULL
     ORDER BY slot_name`,
  );
  for (const holder of slots.rows) {
    horizonEvidence.push(
      `scale=${observation.scale} pg_replication_slots slot=${oneLine(holder.slotName)} xmin=${oneLine(holder.xmin)}`,
    );
  }

  const prepared = await database.admin.query<{
    transaction: string;
    gid: string;
    prepared: Date;
  }>(
    `SELECT transaction::text, gid, prepared
     FROM pg_prepared_xacts
     WHERE database = current_database()
     ORDER BY gid`,
  );
  for (const holder of prepared.rows) {
    horizonEvidence.push(
      `scale=${observation.scale} pg_prepared_xacts transaction=${oneLine(holder.transaction)} gid=${oneLine(
        holder.gid,
      )} prepared=${oneLine(holder.prepared)}`,
    );
  }
}

async function observe(database: GrowthDatabase, scale: number, phase: Observation['phase']): Promise<Statistics> {
  const statistics = await readStatistics(database);
  observations.push({ scale, phase, ...statistics });
  if (phase === 'warmup' && statistics.relallvisible < statistics.relpages) {
    await recordHorizonHolders(database, { scale, phase, ...statistics });
  }
  return statistics;
}

test('every scale is vacuumed and analyzed after grow and before its first run', async () => {
  observations.length = 0;
  beforeGrow.length = 0;
  horizonEvidence.length = 0;
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
  for (const line of horizonEvidence) console.info(`growth vacuum evidence: ${line}`);
}, 60_000);
