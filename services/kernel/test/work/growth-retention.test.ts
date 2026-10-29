import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createWorkClient } from '../../src/work/client.ts';
import { runWorkflowRetentionBatch } from '../../src/work/retention.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

let db: GrowthDatabase;
let client: Awaited<ReturnType<typeof createWorkClient>>;
const prefix = `retention-growth:${crypto.randomUUID()}:`;
const dayMs = 24 * 60 * 60 * 1000;
// Fixed-width keys keep primary-key probes local; this depth preserves the indexed full-batch plan.
const historySize = 49_152;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  client = await createWorkClient(databaseUrl, db.pool);
});

afterAll(async () => {
  await db.admin.query('DELETE FROM dbos.workflow_status WHERE workflow_uuid LIKE $1', [`${prefix}%`]);
  await client.close();
  await db.close();
});

async function seed(db: GrowthDatabase, kind: 'old' | 'recent', amount: number, offset: number): Promise<void> {
  if (amount === 0) return;
  const now = Date.now();
  const old = kind === 'old';
  await db.pool.query(
    `INSERT INTO dbos.workflow_status (
       workflow_uuid, status, name, authenticated_roles, recovery_attempts,
       created_at, updated_at, completed_at, application_name
     )
     SELECT $1 || $2 || ':' || lpad(item::text, 6, '0'),
            'SUCCESS', 'retention.growth.fixture', '[]', 0,
            $3::bigint - CASE WHEN $4 THEN 400 ELSE 1 END::bigint * 86400000 + item,
            $3::bigint - CASE WHEN $4 THEN 400 ELSE 1 END::bigint * 86400000 + item,
            $3::bigint - CASE WHEN $4 THEN 400 ELSE 1 END::bigint * 86400000 + item,
            'rezics-kernel'
       FROM generate_series($5 + 1, $5 + $6) AS item`,
    [prefix, kind, now, old, offset, amount],
  );
}

async function seedShortBatch(
  db: GrowthDatabase,
  kind: 'short-eligible' | 'short-long-lived' | 'short-recent',
  amount: number,
  offset: number,
): Promise<void> {
  if (amount === 0) return;
  const now = Date.now();
  const createdAt =
    kind === 'short-eligible' ? now - 401 * dayMs : kind === 'short-long-lived' ? now - 400 * dayMs : now - dayMs;
  const completedAt = kind === 'short-eligible' ? now - 400 * dayMs : now - dayMs;
  await db.pool.query(
    `INSERT INTO dbos.workflow_status (
       workflow_uuid, status, name, authenticated_roles, recovery_attempts,
       created_at, updated_at, completed_at, application_name
     )
     SELECT $1 || $2 || ':' || lpad(item::text, 6, '0'),
            'SUCCESS', 'retention.growth.fixture', '[]', 0,
            $3::bigint + item, $4::bigint + item, $5::bigint + item, 'rezics-kernel'
       FROM generate_series($6 + 1, $6 + $7) AS item`,
    [prefix, kind, createdAt, completedAt, completedAt, offset, amount],
  );
}

async function warmRetentionBatch(growth: GrowthDatabase, expected: number): Promise<void> {
  const eligible = await growth.admin.query(
    `SELECT * FROM dbos.workflow_status
      WHERE workflow_uuid LIKE $1 AND completed_at < $2
      ORDER BY created_at LIMIT 1000`,
    [`${prefix}%`, Date.now() - 30 * dayMs],
  );
  expect(eligible.rows).toHaveLength(expected);
  expect(await runWorkflowRetentionBatch(30, client)).toBe(expected);
  await growth.admin.query(
    `INSERT INTO dbos.workflow_status
     SELECT * FROM jsonb_populate_recordset(NULL::dbos.workflow_status, $1::jsonb)`,
    [JSON.stringify(eligible.rows)],
  );
}

test('a short retention batch stays bounded as retained workflow history grows', async () => {
  const report = await checkGrowth(db, {
    name: 'short workflow retention batch',
    rule: 'series',
    scales: [64, 512, 4096],
    repetitions: 1,
    warmup: (growth) => warmRetentionBatch(growth, 10),
    bounds: {
      statements: 'constant',
      rows: 'constant',
      blocks: 'logarithmic',
    },
    slack: {
      rows: { absolute: 10, relative: 0 },
      blocks: { absolute: 24, relative: 0 },
    },
    async grow(growth, scale, previous) {
      // Reinsert the same ten eligible rows after the previous measurement deleted them.
      await seedShortBatch(growth, 'short-eligible', 10, 0);
      if (previous === 0) {
        // The old rows are long-lived, not eligible.
        await seedShortBatch(growth, 'short-long-lived', historySize, 0);
        await seedShortBatch(growth, 'short-recent', historySize, 0);
      }
      await seedShortBatch(growth, 'short-recent', scale - previous, historySize + previous);
    },
    async operation() {
      expect(await runWorkflowRetentionBatch(30, client)).toBe(10);
    },
  });

  expect(report.samples[1]!.cost.rows).toBe(report.samples[0]!.cost.rows);
  expect(report.samples[2]!.cost.rows).toBe(report.samples[0]!.cost.rows);
  expect(report.samples[0]!.cost.rows).toBeGreaterThan(0);
  expect(report.samples[1]!.cost.statements).toBe(report.samples[0]!.cost.statements);
  expect(report.samples[2]!.cost.statements).toBe(report.samples[0]!.cost.statements);

  await db.admin.query('DELETE FROM dbos.workflow_status WHERE workflow_uuid LIKE $1', [`${prefix}short-%`]);
});

test('one retention batch stays bounded as retained and recent workflow history grow', async () => {
  // A fixed deep history keeps the planner on the ordered index path while the measured populations grow.
  await seed(db, 'old', historySize, 0);
  await seed(db, 'recent', historySize, 0);

  const report = await checkGrowth(db, {
    name: 'workflow retention batch',
    rule: 'series',
    scales: [64, 512, 4096],
    repetitions: 1,
    warmup: (growth) => warmRetentionBatch(growth, 1000),
    bounds: {
      statements: 'constant',
      rows: 'constant',
      blocks: 'logarithmic',
    },
    slack: {
      rows: { absolute: 10, relative: 0 },
      blocks: { absolute: 24, relative: 0 },
    },
    async grow(growth, scale, previous) {
      const added = scale - previous;
      const offset = historySize + previous;
      await seed(growth, 'old', added, offset);
      await seed(growth, 'recent', added, offset);
    },
    async operation() {
      expect(await runWorkflowRetentionBatch(30, client)).toBe(1000);
    },
  });

  expect(report.samples[1]!.cost.rows).toBe(report.samples[0]!.cost.rows);
  expect(report.samples[2]!.cost.rows).toBe(report.samples[0]!.cost.rows);
  expect(report.samples[0]!.cost.rows).toBeGreaterThan(0);
  expect(report.samples[1]!.cost.statements).toBe(report.samples[0]!.cost.statements);
  expect(report.samples[2]!.cost.statements).toBe(report.samples[0]!.cost.statements);
});
