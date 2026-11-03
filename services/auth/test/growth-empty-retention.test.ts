import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk';
import { testDatabase } from '../scripts/database.ts';
import { AUTH_SYSTEM_SCHEMA } from '../src/maintenance.ts';
import {
  AUTH_WORKFLOW_APPLICATION,
  installWorkflowRequestRetention,
  runWorkflowRetentionBatch,
  TERMINAL_WORKFLOW_STATUSES,
} from '../src/retention.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../../kernel/test/support/growth.ts';

const scales = [256, 1024, 4096];
const fixture = testDatabase();
const now = new Date();
const cutoff = now.getTime() - 30 * 86400000;
let db: GrowthDatabase;
let client: DBOSClient;

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

async function reset(growth: GrowthDatabase) {
  await growth.pool.query("DELETE FROM auth_dbos.workflow_status WHERE workflow_uuid LIKE 'retention-empty:%'");
  await growth.pool.query("DELETE FROM auth_workflow_request WHERE workflow_id LIKE 'retention-empty:%'");
}

async function seedRetainedWorkflows(growth: GrowthDatabase, count: number, prefix: string) {
  await growth.pool.query(
    `INSERT INTO auth_dbos.workflow_status
      (workflow_uuid,status,name,authenticated_roles,recovery_attempts,created_at,updated_at,completed_at,application_name)
     SELECT $3||item,CASE WHEN item%2=0 THEN 'SUCCESS' ELSE 'PENDING' END,'retention.growth','[]',0,
       $1::bigint,$1::bigint,CASE WHEN item%2=0 THEN $1::bigint ELSE NULL END,$2
     FROM generate_series(1,$4::integer) item`,
    [now.getTime(), AUTH_WORKFLOW_APPLICATION, prefix, count],
  );
}

async function seedRequestHistory(growth: GrowthDatabase, count: number, prefix: string) {
  await growth.pool.query(
    `INSERT INTO auth_workflow_request (workflow_id,digest,request)
     SELECT $1||item,decode('00','hex'),'{}'::jsonb FROM generate_series(1,$2::integer) item`,
    [prefix, count],
  );
}

function assertMeasuredCost(
  report: Awaited<ReturnType<typeof checkGrowth>>,
  { requests, removedRows }: { requests: boolean; removedRows: number },
) {
  expect(report.samples.map(({ scale }) => scale)).toEqual(scales);
  for (const { scale, cost } of report.samples) {
    expect(cost.statements).toBeGreaterThan(0);
    expect(cost.plans).toBeGreaterThan(0);
    expect(cost.rows).toBeGreaterThanOrEqual(removedRows);
    expect(cost.blocks).toBeGreaterThan(0);
    expect(cost.sharedHit + cost.sharedRead).toBe(cost.blocks);
    expect(Object.values(cost.relations).some(({ identity }) => identity?.name === 'workflow_status')).toBe(true);
    if (requests)
      expect(Object.values(cost.relations).some(({ identity }) => identity?.name === 'auth_workflow_request')).toBe(
        true,
      );
    console.info(
      `Auth retention scale ${scale}: ${JSON.stringify({
        statements: cost.statements,
        examinedRows: cost.rows,
        removedRows,
        bufferHits: cost.sharedHit,
        bufferReads: cost.sharedRead,
      })}`,
    );
  }
}

test('zero-eligible Auth retention examines bounded workflow history and preserves recent requests', async () => {
  const report = await checkGrowth(db, {
    name: 'zero-eligible Auth workflow retention batch',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    // DBOS selects across the configured terminal status keys; each adds at most one owner-key seek.
    indexProbes: TERMINAL_WORKFLOW_STATUSES.length,
    grow: async (growth, scale) => {
      await reset(growth);
      await seedRetainedWorkflows(growth, scale, 'retention-empty:zero:');
      await seedRequestHistory(growth, 256, 'retention-empty:zero:');
    },
    warmup: async () => expect(await runWorkflowRetentionBatch(30, client, now)).toBe(0),
    async operation() {
      expect(await runWorkflowRetentionBatch(30, client, now)).toBe(0);
    },
  });
  assertMeasuredCost(report, { requests: false, removedRows: 0 });
  const workflows = await db.pool.query<{ status: string; count: string }>(
    `SELECT status,count(*)::text AS count FROM auth_dbos.workflow_status
     WHERE workflow_uuid LIKE 'retention-empty:zero:%' GROUP BY status`,
  );
  expect(Object.fromEntries(workflows.rows.map(({ status, count }) => [status, Number(count)]))).toEqual({
    PENDING: scales[2]! / 2,
    SUCCESS: scales[2]! / 2,
  });
  const requests = await db.pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM auth_workflow_request WHERE workflow_id LIKE 'retention-empty:zero:%'",
  );
  expect(Number(requests.rows[0]!.count)).toBe(256);
}, 180000);

test('Auth retention charges the drain and bounds repeated empty batches as request history grows', async () => {
  let previousControl: string | undefined;
  const controls = new Set<string>();
  const report = await checkGrowth(db, {
    name: 'post-drain repeated-empty Auth workflow retention batches',
    scales,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    // Only the Auth request workflow_id primary-key lookup grows in this scenario.
    indexProbes: 1,
    grow: async (growth, scale) => {
      await reset(growth);
      await seedRetainedWorkflows(growth, 4096, 'retention-empty:post:');
      await seedRequestHistory(growth, scale, 'retention-empty:post:');
    },
    warmup: async () => expect(await runWorkflowRetentionBatch(30, client, now)).toBe(0),
    async prepare(_growth, scale, repetition) {
      if (previousControl !== undefined) {
        const prior = await db.pool.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM auth_dbos.workflow_status
           WHERE workflow_uuid=$1`,
          [previousControl],
        );
        expect(Number(prior.rows[0]!.count)).toBe(0);
        const priorRequest = await db.pool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM auth_workflow_request WHERE workflow_id=$1',
          [previousControl],
        );
        expect(Number(priorRequest.rows[0]!.count)).toBe(0);
      }
      const id = `retention-empty:control:${scale}:${repetition}`;
      previousControl = id;
      controls.add(id);
      await db.pool.query(
        `INSERT INTO auth_dbos.workflow_status
          (workflow_uuid,status,name,authenticated_roles,recovery_attempts,created_at,updated_at,completed_at,application_name)
         VALUES ($1,'SUCCESS','retention.growth','[]',0,$2,$2,$3,$4)`,
        [id, cutoff - 86400000, cutoff - 86400000, AUTH_WORKFLOW_APPLICATION],
      );
      await db.pool.query(
        `INSERT INTO auth_workflow_request (workflow_id,digest,request)
         VALUES ($1,decode('00','hex'),'{}'::jsonb)`,
        [id],
      );
    },
    async operation() {
      expect(await runWorkflowRetentionBatch(30, client, now)).toBe(1);
      for (let batch = 0; batch < 3; batch++) expect(await runWorkflowRetentionBatch(30, client, now)).toBe(0);
    },
  });
  assertMeasuredCost(report, { requests: true, removedRows: 1 });
  const remaining = await db.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM auth_dbos.workflow_status
     WHERE workflow_uuid LIKE 'retention-empty:control:%'`,
  );
  expect(Number(remaining.rows[0]!.count)).toBe(0);
  const requestBindings = await db.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM auth_workflow_request
     WHERE workflow_id LIKE 'retention-empty:control:%'`,
  );
  expect(Number(requestBindings.rows[0]!.count)).toBe(0);
  const retainedWorkflows = await db.pool.query<{ status: string; count: string }>(
    `SELECT status,count(*)::text AS count FROM auth_dbos.workflow_status
     WHERE workflow_uuid LIKE 'retention-empty:post:%' GROUP BY status`,
  );
  expect(Object.fromEntries(retainedWorkflows.rows.map(({ status, count }) => [status, Number(count)]))).toEqual({
    PENDING: 2048,
    SUCCESS: 2048,
  });
  const retainedRequests = await db.pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM auth_workflow_request WHERE workflow_id LIKE 'retention-empty:post:%'",
  );
  expect(Number(retainedRequests.rows[0]!.count)).toBe(scales[2]);
  expect(controls.size).toBeGreaterThan(0);
}, 180000);
