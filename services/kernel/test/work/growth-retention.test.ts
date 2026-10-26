import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createWorkClient } from '../../src/work/client.ts';
import { runWorkflowRetentionBatch } from '../../src/work/retention.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

let db: GrowthDatabase;
let client: Awaited<ReturnType<typeof createWorkClient>>;
const prefix = `retention-growth:${crypto.randomUUID()}:`;

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
     SELECT $1 || $2 || ':' || item::text,
            'SUCCESS', 'retention.growth.fixture', '[]', 0,
            $3 - CASE WHEN $4 THEN 400 ELSE 1 END * 86400000 + item,
            $3 - CASE WHEN $4 THEN 400 ELSE 1 END * 86400000 + item,
            $3 - CASE WHEN $4 THEN 400 ELSE 1 END * 86400000 + item,
            'rezics-kernel'
       FROM generate_series($5 + 1, $5 + $6) AS item`,
    [prefix, kind, now, old, offset, amount],
  );
}

test('one retention batch stays bounded as retained and recent workflow history grow', async () => {
  const report = await checkGrowth(db, {
    name: 'workflow retention batch',
    scales: [1000, 8000, 64000],
    repetitions: 1,
    warmups: 0,
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
      await seed(growth, 'old', added, previous);
      await seed(growth, 'recent', added, previous);
    },
    operation: () => runWorkflowRetentionBatch(30, client),
  });

  expect(report.samples.map((sample) => sample.cost.rows)).toEqual([1000, 1000, 1000]);
  expect(report.samples[1]!.cost.statements).toBe(report.samples[0]!.cost.statements);
  expect(report.samples[2]!.cost.statements).toBe(report.samples[0]!.cost.statements);
});
