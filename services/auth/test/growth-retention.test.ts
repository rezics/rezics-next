import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk';
import { testDatabase } from '../scripts/database.ts';
import { AUTH_SYSTEM_SCHEMA } from '../src/maintenance.ts';
import {
  AUTH_WORKFLOW_APPLICATION,
  installWorkflowRequestRetention,
  runWorkflowRetentionBatch,
} from '../src/retention.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../../kernel/test/support/growth.ts';

const fixture = testDatabase();
let db: GrowthDatabase;
let client: DBOSClient;
const now = new Date();
const cutoff = now.getTime() - 30 * 86400000;

beforeAll(async () => {
  await DBOS.migrate(fixture.url, { schemaName: AUTH_SYSTEM_SCHEMA });
  db = await openGrowthDatabase(fixture.url);
  client = await DBOSClient.create({
    systemDatabaseUrl: fixture.url,
    systemDatabaseSchemaName: AUTH_SYSTEM_SCHEMA,
    applicationName: AUTH_WORKFLOW_APPLICATION,
    systemDatabasePool: db.pool,
    logger: { info() {}, debug() {}, warn: console.warn, error: console.error },
  });
  await installWorkflowRequestRetention(db.pool);
});
afterAll(async () => {
  await client.destroy();
  await db.close();
  fixture.close();
});

async function seed(growth: GrowthDatabase, kind: 'full' | 'short', scale: number) {
  await growth.pool.query('DELETE FROM auth_dbos.workflow_status');
  // Six operations per scale: one default warmup and five measured batches.
  // Fixed deep history keeps SDK deletion on primary-key indexes, as in kernel retention.
  // Short cohorts become eligible ten at a time as the test clock advances a millisecond.
  const eligible = kind === 'full' ? 128000 + scale : 60;
  await growth.pool.query(
    `INSERT INTO auth_dbos.workflow_status
      (workflow_uuid,status,name,authenticated_roles,recovery_attempts,created_at,updated_at,completed_at,application_name)
     SELECT 'eligible:'||item,'SUCCESS','retention.growth','[]',0,
       $1::bigint - 86400000 + item,$1::bigint,
       CASE WHEN $2 THEN $1::bigint - 86400000 + item ELSE $1::bigint + (item-1)/10 END,$3
     FROM generate_series(1,$4::integer) item`,
    [cutoff, kind === 'full', AUTH_WORKFLOW_APPLICATION, eligible],
  );
  await growth.pool.query(
    `INSERT INTO auth_dbos.workflow_status
      (workflow_uuid,status,name,authenticated_roles,recovery_attempts,created_at,updated_at,completed_at,application_name)
     SELECT 'retained:'||item,'SUCCESS','retention.growth','[]',0,
       CASE WHEN $5 AND item<=128000 THEN $1::bigint-86400000 ELSE $2::bigint END,
       $2::bigint,$2::bigint,$3 FROM generate_series(1,$4::integer) item`,
    [cutoff, now.getTime(), AUTH_WORKFLOW_APPLICATION, 256000 + scale, kind === 'short'],
  );
  await growth.pool.query(`INSERT INTO auth_workflow_request
    SELECT workflow_uuid,decode('00','hex'),'{}'::jsonb FROM auth_dbos.workflow_status`);
}

async function runRetentionGrowth(kind: 'full' | 'short') {
  const report = await checkGrowth(db, {
    name: `${kind} Auth workflow retention batch`,
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    grow: (growth, scale) => seed(growth, kind, scale),
    async operation(_growth, _scale, repetition) {
      const at = kind === 'full' ? now : new Date(now.getTime() + (repetition % 6) + 1);
      expect(await runWorkflowRetentionBatch(30, client, at)).toBe(kind === 'full' ? 1000 : 10);
    },
  });
  const first = report.samples[0]!.cost;
  expect(first.rows).toBeGreaterThan(0);
  for (const sample of report.samples.slice(1)) {
    expect(sample.cost.rows).toBe(first.rows);
    expect(sample.cost.statements).toBe(first.statements);
  }
}

test('a full Auth retention batch stays constant as workflow and request history grow', async () => {
  await runRetentionGrowth('full');
}, 180000);
test('a short Auth retention batch stays constant as workflow and request history grow', async () => {
  await runRetentionGrowth('short');
}, 180000);
