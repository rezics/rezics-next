import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { withConnection } from '../../src/database/pool.ts';
import { capture, openGrowthDatabase, settle, type GrowthDatabase } from './growth-capture.ts';
import { costOf } from './growth-cost.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const schema = 'growth_determinism_test';
const rows = `${schema}.parallel_rows`;
const inner = `${schema}.hash_rows`;
const blockerRows = `${schema}.blocker_rows`;
const workload = `
  SELECT count(*)
  FROM ${rows} AS outer_rows
  JOIN ${inner} AS hash_rows USING (id)
`;
const blocker = `SELECT sum(hashtextextended(repeat(payload, 128), 1)) FROM ${blockerRows}`;

let db: GrowthDatabase | undefined;
let blockers: pg.Pool | undefined;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  blockers = new pg.Pool({ connectionString: databaseUrl, max: 8 });
  await db.admin.query(`CREATE SCHEMA ${schema}`);
  await db.admin.query(`CREATE TABLE ${rows} (id integer NOT NULL)
    WITH (autovacuum_enabled = false)`);
  await db.admin.query(`CREATE TABLE ${inner} (id integer NOT NULL)
    WITH (autovacuum_enabled = false)`);
  await db.admin.query(`CREATE TABLE ${blockerRows} (id integer NOT NULL, payload text NOT NULL)
    WITH (autovacuum_enabled = false)`);
  await db.admin.query(`
    INSERT INTO ${rows} (id)
    SELECT id FROM generate_series(1, 160000) AS id
  `);
  await db.admin.query(`
    INSERT INTO ${inner} (id)
    SELECT id FROM generate_series(1, 24000) AS id
  `);
  await db.admin.query(`
    INSERT INTO ${blockerRows} (id, payload)
    SELECT id, repeat('blocker-row-', 40) FROM generate_series(1, 160000) AS id
  `);
  await db.admin.query(`ALTER TABLE ${rows} SET (parallel_workers = 2)`);
  await db.admin.query(`ALTER TABLE ${blockerRows} SET (parallel_workers = 2)`);
  await settle(db, { analyze: true });
});

afterAll(async () => {
  if (!db) return;
  if (blockers) await blockers.end();
  await db.admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await db.close();
});

function plannedParallelWorkers(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, entry) => sum + plannedParallelWorkers(entry), 0);
  if (typeof value !== 'object' || value === null) return 0;
  const node = value as Record<string, unknown>;
  const here = typeof node['Workers Planned'] === 'number' ? node['Workers Planned'] : 0;
  const children = Array.isArray(node.Plans)
    ? node.Plans.reduce((sum, entry) => sum + plannedParallelWorkers(entry), 0)
    : 0;
  return here + children + plannedParallelWorkers(node.Plan);
}

function launchedParallelWorkers(value: unknown): number {
  if (Array.isArray(value)) return value.reduce((sum, entry) => sum + launchedParallelWorkers(entry), 0);
  if (typeof value !== 'object' || value === null) return 0;
  const node = value as Record<string, unknown>;
  const here = typeof node['Workers Launched'] === 'number' ? node['Workers Launched'] : 0;
  const children = Array.isArray(node.Plans)
    ? node.Plans.reduce((sum, entry) => sum + launchedParallelWorkers(entry), 0)
    : 0;
  return here + children + launchedParallelWorkers(node.Plan);
}

function planSummary(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(planSummary);
  if (typeof value !== 'object' || value === null) return [];
  const node = value as Record<string, unknown>;
  const current =
    typeof node['Node Type'] === 'string'
      ? [
          {
            node: node['Node Type'],
            relation: node['Relation Name'],
            loops: node['Actual Loops'],
            rows: node['Actual Rows'],
            blocks:
              (typeof node['Shared Hit Blocks'] === 'number' ? node['Shared Hit Blocks'] : 0) +
              (typeof node['Shared Read Blocks'] === 'number' ? node['Shared Read Blocks'] : 0),
            workersPlanned: node['Workers Planned'],
            workersLaunched: node['Workers Launched'],
          },
        ]
      : [];
  return [...current, ...(Array.isArray(node.Plans) ? node.Plans.flatMap(planSummary) : []), ...planSummary(node.Plan)];
}

async function waitForParallelQueries(database: GrowthDatabase, minimum: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await database.admin.query<{ count: number }>(
      `SELECT count(*)::integer AS count
       FROM pg_stat_activity
       WHERE datname = current_database()
         AND backend_type = 'client backend'
         AND state = 'active'
         AND query LIKE 'SELECT sum(hashtextextended%blocker_rows%'`,
    );
    if ((result.rows[0]?.count ?? 0) >= minimum) return;
    await Bun.sleep(10);
  }
  throw new Error(`Expected ${minimum} active parallel query sessions`);
}

async function runWorkload(database: GrowthDatabase) {
  return withConnection(database.pool, async (client) => {
    const measured = await capture(database, async () => {
      // A non-parallel-aware Hash below Gather is built independently by each participant on the base settings.
      await client.query('SET enable_parallel_hash = off');
      await client.query('SET enable_mergejoin = off');
      return (await client.query(workload)).rows[0];
    });
    return measured;
  });
}

test('a capture under concurrent parallel queries reports the same rows and blocks as alone', async () => {
  const database = db!;
  const blockerPool = blockers!;
  await database.admin.query('SET enable_parallel_hash = off');
  await database.admin.query('SET enable_mergejoin = off');
  const plan = await database.admin.query(`EXPLAIN (FORMAT JSON) ${workload}`);
  expect(plannedParallelWorkers(plan.rows[0]?.['QUERY PLAN'])).toBeGreaterThanOrEqual(2);
  const blockerPlan = await database.admin.query(`EXPLAIN (FORMAT JSON) ${blocker}`);
  expect(plannedParallelWorkers(blockerPlan.rows[0]?.['QUERY PLAN'])).toBeGreaterThanOrEqual(2);

  // Prime visibility and cache state before either captured run so the serial pinned plan starts from the same pages.
  await database.admin.query(workload);
  const alone = await runWorkload(database);
  const aloneCost = costOf(alone.capture);
  const activeQueries = Array.from({ length: 4 }, () => blockerPool.query(blocker));
  try {
    await waitForParallelQueries(database, 4);
    const underLoad = await runWorkload(database);
    const underLoadCost = costOf(underLoad.capture);
    console.info(
      `growth determinism evidence: ${JSON.stringify({
        alone: {
          rows: aloneCost.rows,
          blocks: aloneCost.blocks,
          workersLaunched: launchedParallelWorkers(alone.capture.plans),
          plan: planSummary(alone.capture.plans),
        },
        underLoad: {
          rows: underLoadCost.rows,
          blocks: underLoadCost.blocks,
          workersLaunched: launchedParallelWorkers(underLoad.capture.plans),
          plan: planSummary(underLoad.capture.plans),
        },
      })}`,
    );
    expect({ rows: underLoadCost.rows, blocks: underLoadCost.blocks }).toEqual({
      rows: aloneCost.rows,
      blocks: aloneCost.blocks,
    });
  } finally {
    await Promise.allSettled(activeQueries);
  }
});
