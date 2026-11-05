import type { PoolClient } from 'pg';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checkGrowth, openGrowthDatabase, settle, type GrowthDatabase } from './growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const schema = 'growth_load_test';
const table = `${schema}.rows`;
const operation = `SELECT sum(id) FROM ${table}`;
const delayed = `SELECT pg_sleep(0.5), sum(id) FROM ${table}`;

let db: GrowthDatabase | undefined;
let client: PoolClient | undefined;
const delayedQueries: Promise<unknown>[] = [];

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  db.pool.options.max = 1;
  await db.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.admin.query(`CREATE SCHEMA ${schema}`);
  await db.admin.query(`CREATE TABLE ${table} (id integer NOT NULL) WITH (autovacuum_enabled = false)`);
  await db.admin.query(`INSERT INTO ${table} SELECT generate_series(1, 16)`);
  await settle(db, { analyze: true });
  client = await db.pool.connect();
  // Keep the warmup plan enabled so its notice can arrive during a later capture.
  await client.query('SET auto_explain.log_min_duration = 0');
});

afterAll(async () => {
  if (!db) return;
  await Promise.allSettled(delayedQueries);
  client?.release();
  await db.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.close();
});

function scheduleDelayedQuery(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      // Dev disables auto_explain between captures; re-enable it before this query starts.
      void client!.query('SET auto_explain.log_min_duration = 0');
      const query = client!.query(delayed);
      delayedQueries.push(query);
      void query.catch(() => {});
      resolve();
    }, 0);
  });
}

async function waitForDelayedQuery(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await db!.admin.query<{ active: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database() AND state = 'active' AND query = $1
       ) AS active`,
      [delayed],
    );
    if (result.rows[0]?.active) return;
  }
  throw new Error('The delayed query did not start before the next measured capture');
}

test('checkGrowth reports the same rows for an operation whose surrounding timing varies between repetitions', async () => {
  const database = db!;
  const report = await checkGrowth(database, {
    name: 'stable rows under varying query timing',
    scales: [1, 4, 16],
    repetitions: 3,
    warmups: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'constant' },
    async grow() {},
    async warmup(_database, scale) {
      await client!.query(operation);
      if (scale === 1) {
        await scheduleDelayedQuery();
        await waitForDelayedQuery();
      }
    },
    async operation(_database, scale, repetition) {
      await client!.query(operation);
      // Queue delays before the next two runs so the lower median exposes a misattributed plan.
      if (scale === 1 && repetition < 3) scheduleDelayedQuery();
    },
  });

  expect(report.samples.map(({ cost }) => cost.rows)).toEqual([16, 16, 16]);
});
