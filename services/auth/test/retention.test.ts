import { afterAll, beforeAll, expect, test } from 'bun:test';
import { DBOS } from '@dbos-inc/dbos-sdk';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import { createAuthHost, type AuthHostOptions } from '../src/host.ts';
import type { AuthService } from '../src/index.ts';
import { AUTH_SYSTEM_SCHEMA, registerAuthMaintenance } from '../src/maintenance.ts';
import {
  AUTH_WORKFLOW_APPLICATION,
  installWorkflowRequestRetention,
  readWorkflowRetentionConfig,
  runWorkflowRetentionSweep,
  TERMINAL_WORKFLOW_STATUSES,
  WORKFLOW_RETENTION_SCHEDULE,
  WorkflowRetentionConfigurationError,
  type WorkflowRetentionSdk,
} from '../src/retention.ts';

const day = 86400000;
const now = new Date();
const cutoff = now.getTime() - 30 * day;
const fixture = testDatabase();
const pool = new Pool({ connectionString: fixture.url });
let maintenance: ReturnType<typeof registerAuthMaintenance>;

beforeAll(async () => {
  maintenance = registerAuthMaintenance({} as AuthService);
  DBOS.setConfig({
    name: AUTH_WORKFLOW_APPLICATION,
    systemDatabaseUrl: fixture.url,
    systemDatabaseSchemaName: AUTH_SYSTEM_SCHEMA,
    logLevel: 'warn',
  });
  await DBOS.launch();
  await installWorkflowRequestRetention(pool);
  await maintenance.start('0 0 1 1 *');
});
afterAll(async () => {
  await DBOS.shutdown({ deregister: true });
  await pool.end();
  fixture.close();
});

async function seed(id: string, status: string, completedAt: number | null, application = AUTH_WORKFLOW_APPLICATION) {
  await pool.query(
    `INSERT INTO auth_dbos.workflow_status
      (workflow_uuid,status,name,authenticated_roles,recovery_attempts,created_at,updated_at,completed_at,application_name)
     VALUES ($1,$2,'retention.fixture','[]',0,$3,$3,$4,$5)`,
    [id, status, cutoff - day, completedAt, application],
  );
  await pool.query('INSERT INTO auth_workflow_request VALUES ($1,$2,$3)', [id, Buffer.from('digest'), { id }]);
}

test('Auth retention validates its independent configuration before constructing or launching a host', async () => {
  expect(readWorkflowRetentionConfig({})).toEqual({ retentionDays: 30 });
  for (const value of ['7', '365', '030'])
    expect(readWorkflowRetentionConfig({ AUTH_WORKFLOW_RETENTION_DAYS: value }).retentionDays).toBe(Number(value));
  const previous = process.env.AUTH_WORKFLOW_RETENTION_DAYS;
  try {
    for (const value of ['', '6', '366', '7.0', '1e2', ' 30', '30 ', '-1', 'NaN', '9999999999999999999']) {
      expect(() => readWorkflowRetentionConfig({ AUTH_WORKFLOW_RETENTION_DAYS: value })).toThrow(
        WorkflowRetentionConfigurationError,
      );
      process.env.AUTH_WORKFLOW_RETENTION_DAYS = value;
      await expect(createAuthHost({} as AuthHostOptions)).rejects.toThrow('AUTH_WORKFLOW_RETENTION_DAYS');
    }
  } finally {
    if (previous === undefined) delete process.env.AUTH_WORKFLOW_RETENTION_DAYS;
    else process.env.AUTH_WORKFLOW_RETENTION_DAYS = previous;
  }
});

test('the native scheduled Auth sweep deletes all terminal kinds and their request rows, keeping running and recent work', async () => {
  const old = TERMINAL_WORKFLOW_STATUSES.map((status) => `old:${status}`);
  for (const [i, status] of TERMINAL_WORKFLOW_STATUSES.entries()) await seed(old[i]!, status, cutoff - day);
  for (const status of ['PENDING', 'ENQUEUED', 'DELAYED']) await seed(`kept:${status}`, status, null);
  await seed('kept:recent', 'SUCCESS', Date.now());
  await seed('kept:missing-completion', 'ERROR', null);
  await seed('kept:other-application', 'SUCCESS', cutoff - day, 'another-application');
  const schedules = await DBOS.listSchedules();
  expect(schedules.find((schedule) => schedule.scheduleName === WORKFLOW_RETENTION_SCHEDULE)).toMatchObject({
    schedule: '*/10 * * * *',
    automaticBackfill: false,
    cronTimezone: 'UTC',
    queueName: 'auth-maintenance',
  });
  const handle = await DBOS.triggerSchedule(WORKFLOW_RETENTION_SCHEDULE);
  await handle.getResult();
  for (const table of ['auth_dbos.workflow_status', 'auth_workflow_request']) {
    const column = table.includes('workflow_status') ? 'workflow_uuid' : 'workflow_id';
    expect((await pool.query(`SELECT 1 FROM ${table} WHERE ${column}=ANY($1)`, [old])).rowCount).toBe(0);
    expect((await pool.query(`SELECT 1 FROM ${table} WHERE ${column} LIKE 'kept:%'`)).rowCount).toBe(6);
  }
});

test('request cleanup rolls back with a failed SDK deletion and strict cutoff rows remain', async () => {
  await seed('cutoff:exact', 'SUCCESS', cutoff);
  await seed('rollback:old', 'SUCCESS', cutoff - day);
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    await connection.query("DELETE FROM auth_dbos.workflow_status WHERE workflow_uuid='rollback:old'");
    expect(
      (await connection.query("SELECT 1 FROM auth_workflow_request WHERE workflow_id='rollback:old'")).rowCount,
    ).toBe(0);
    await connection.query('ROLLBACK');
    expect((await pool.query("SELECT 1 FROM auth_workflow_request WHERE workflow_id='rollback:old'")).rowCount).toBe(1);
  } finally {
    connection.release();
  }
  expect(await runWorkflowRetentionSweep(30, DBOS, now)).toBe(1);
  expect((await pool.query("SELECT 1 FROM auth_workflow_request WHERE workflow_id='cutoff:exact'")).rowCount).toBe(1);
});

test('each bounded batch uses one strict completion/end cutoff, omits payloads and descendants, and stops after sixty batches', async () => {
  const retained = (await DBOS.listWorkflows({ workflowIDs: ['cutoff:exact'] }))[0]!;
  const inputs: unknown[] = [];
  const deleted: string[][] = [];
  let size = 1000;
  const sdk: WorkflowRetentionSdk = {
    async listWorkflows(input) {
      inputs.push(input);
      return Array.from({ length: size }, (_, i) => ({
        ...retained,
        workflowID: `batch:${i}`,
        completedAt: cutoff - 1,
      }));
    },
    async deleteWorkflows(ids, children) {
      expect(children).toBe(false);
      deleted.push(ids);
    },
  };
  expect(await runWorkflowRetentionSweep(30, sdk, now)).toBe(60000);
  expect(inputs).toHaveLength(60);
  expect(deleted.every((ids) => ids.length === 1000)).toBe(true);
  for (const input of inputs)
    expect(input).toEqual({
      applicationName: AUTH_WORKFLOW_APPLICATION,
      status: [...TERMINAL_WORKFLOW_STATUSES],
      completedBefore: new Date(cutoff - 1).toISOString(),
      endTime: new Date(cutoff - 1).toISOString(),
      limit: 1000,
      sortDesc: false,
      loadInput: false,
      loadOutput: false,
    });
  size = 10;
  inputs.length = 0;
  expect(await runWorkflowRetentionSweep(30, sdk, now)).toBe(10);
  expect(inputs).toHaveLength(1);
});
