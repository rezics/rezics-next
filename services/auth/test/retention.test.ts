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
  runWorkflowRetentionBatch,
  runWorkflowRetentionPage,
  runWorkflowRetentionSweep,
  TERMINAL_WORKFLOW_STATUSES,
  WORKFLOW_RETENTION_SCHEDULE,
  WorkflowRetentionConfigurationError,
} from '../src/retention.ts';

const day = 86400000;
const now = new Date();
const cutoff = now.getTime() - 30 * day;
const fixture = testDatabase();
const pool = new Pool({ connectionString: fixture.url });
let maintenance: ReturnType<typeof registerAuthMaintenance>;
const unclassified = async () => false;

beforeAll(async () => {
  maintenance = registerAuthMaintenance({
    internal: {
      retainWorkflowHistory: (days: number) => runWorkflowRetentionBatch(pool, days, DBOS, now, unclassified),
    },
  } as AuthService);
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

async function reset() {
  await pool.query('DELETE FROM auth_dbos.workflow_status');
  await pool.query('DELETE FROM auth_workflow_request');
  await pool.query('UPDATE auth_workflow_retention SET cutoff=NULL,through_key=NULL,after_key=NULL');
}
async function seed(
  id: string,
  status: string,
  completedAt: number | null,
  application = AUTH_WORKFLOW_APPLICATION,
  name = 'auth.maintenance.tick',
) {
  await pool.query(
    `INSERT INTO auth_dbos.workflow_status
      (workflow_uuid,status,name,authenticated_roles,recovery_attempts,created_at,updated_at,completed_at,application_name)
     VALUES ($1,$2,$6,'[]',0,$3,$3,$4,$5)`,
    [id, status, cutoff - day, completedAt, application, name],
  );
  await pool.query('INSERT INTO auth_workflow_request(workflow_id,digest,request) VALUES ($1,$2,$3)', [
    id,
    Buffer.from('digest'),
    { id },
  ]);
}
const page = (at = now, retire = unclassified) => runWorkflowRetentionPage(pool, 30, DBOS, at, retire);

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
  await reset();
  const old = TERMINAL_WORKFLOW_STATUSES.map((status) => `old:${status}`);
  for (const [i, status] of TERMINAL_WORKFLOW_STATUSES.entries()) await seed(old[i]!, status, cutoff - day);
  for (const status of ['PENDING', 'ENQUEUED', 'DELAYED']) await seed(`kept:${status}`, status, null);
  await seed('kept:recent', 'SUCCESS', now.getTime());
  await seed('kept:missing-completion', 'ERROR', null);
  await seed('kept:other-application', 'SUCCESS', cutoff - day, 'another-application');
  await seed('kept:unknown-custody', 'SUCCESS', cutoff - day, AUTH_WORKFLOW_APPLICATION, 'accounts.registration');
  const schedules = await DBOS.listSchedules();
  expect(schedules.find((schedule) => schedule.scheduleName === WORKFLOW_RETENTION_SCHEDULE)).toMatchObject({
    schedule: '*/10 * * * *',
    automaticBackfill: false,
    cronTimezone: 'UTC',
    queueName: 'auth-maintenance',
  });
  await (await DBOS.triggerSchedule(WORKFLOW_RETENTION_SCHEDULE)).getResult();
  for (const table of ['auth_dbos.workflow_status', 'auth_workflow_request']) {
    const column = table.includes('workflow_status') ? 'workflow_uuid' : 'workflow_id';
    expect((await pool.query(`SELECT 1 FROM ${table} WHERE ${column}=ANY($1)`, [old])).rowCount).toBe(
      table.includes('workflow_status') ? 0 : old.length,
    );
    expect((await pool.query(`SELECT 1 FROM ${table} WHERE ${column} LIKE 'kept:%'`)).rowCount).toBe(7);
  }
});

test('unclassified request custody survives SDK rollback and strict cutoff rows remain', async () => {
  await reset();
  await seed('cutoff:exact', 'SUCCESS', cutoff);
  await seed('rollback:old', 'SUCCESS', cutoff - day);
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');
    await connection.query("DELETE FROM auth_dbos.workflow_status WHERE workflow_uuid='rollback:old'");
    expect(
      (await connection.query("SELECT 1 FROM auth_workflow_request WHERE workflow_id='rollback:old'")).rowCount,
    ).toBe(1);
    await connection.query('ROLLBACK');
    expect((await pool.query("SELECT 1 FROM auth_workflow_request WHERE workflow_id='rollback:old'")).rowCount).toBe(1);
  } finally {
    connection.release();
  }
  expect(await runWorkflowRetentionSweep(pool, 30, DBOS, now, unclassified)).toBe(1);
  expect((await pool.query("SELECT 1 FROM auth_workflow_request WHERE workflow_id='cutoff:exact'")).rowCount).toBe(1);
});

test('raw pages pass pending consumers and cutoff ties, resume the fixed horizon and revisit recovered custody', async () => {
  await reset();
  await pool.query(
    `INSERT INTO auth_dbos.workflow_status
     (workflow_uuid,status,name,created_at,completed_at,application_name)
     SELECT 'a:'||lpad(i::text,5,'0'),'SUCCESS','accounts.registration',$1,$2,$3
     FROM generate_series(1,1000) i`,
    [cutoff - day, cutoff - 1, AUTH_WORKFLOW_APPLICATION],
  );
  await seed('b:eligible', 'SUCCESS', cutoff - 1);
  await seed('c:tie', 'SUCCESS', cutoff);
  await seed('d:recent', 'SUCCESS', now.getTime());
  await seed('e:creation-tie', 'SUCCESS', cutoff - 1);
  await pool.query("UPDATE auth_dbos.workflow_status SET created_at=$1 WHERE workflow_uuid='e:creation-tie'", [cutoff]);
  const first = await page();
  expect(first).toEqual({ cutoff, examined: 1000, eligible: 1000, retired: 0, pending: 1000, done: false });
  expect((await pool.query('SELECT cutoff::float8,after_key FROM auth_workflow_retention')).rows[0]).toEqual({
    cutoff,
    after_key: 'a:01000',
  });
  // Neither a later clock nor a new, lexically later workflow changes this sweep.
  await seed('z:new', 'SUCCESS', cutoff - 1);
  expect(await page(new Date(now.getTime() + 2 * day))).toMatchObject({ cutoff, examined: 4, retired: 1, done: true });
  expect(
    (await pool.query("SELECT 1 FROM auth_dbos.workflow_status WHERE workflow_uuid IN ('c:tie','z:new')")).rowCount,
  ).toBe(2);
  const recovered: string[] = [];
  const next = await page(now, async (id) => {
    recovered.push(id);
    await DBOS.deleteWorkflows([id], false);
    return true;
  });
  expect(next).toMatchObject({ examined: 1000, retired: 1000, pending: 0, done: false });
  expect(new Set(recovered).size).toBe(1000);
  expect(await page()).toMatchObject({ retired: 1, done: true });
});

test('a lost deletion reply preserves cutoff and replays while retaining unclassified request bindings', async () => {
  await reset();
  await seed('a:delete', 'SUCCESS', cutoff - 1);
  await seed('b:delete', 'SUCCESS', cutoff - 1);
  let failed = false;
  await expect(
    runWorkflowRetentionPage(
      pool,
      30,
      {
        async deleteWorkflows(ids, children) {
          await DBOS.deleteWorkflows(ids, children);
          failed = true;
          throw new Error('lost native delete reply');
        },
      },
      now,
      unclassified,
    ),
  ).rejects.toThrow('lost native delete reply');
  expect(failed).toBe(true);
  expect((await pool.query('SELECT cutoff::float8,after_key FROM auth_workflow_retention')).rows[0]).toEqual({
    cutoff,
    after_key: null,
  });
  expect(await page(new Date(now.getTime() + day))).toMatchObject({ cutoff, retired: 0, done: true });
  expect(
    (await pool.query("SELECT 1 FROM auth_workflow_request WHERE workflow_id IN ('a:delete','b:delete')")).rowCount,
  ).toBe(2);
});

test('sixty raw batches leave a durable continuation even when every consumer is pending', async () => {
  await reset();
  await pool.query(
    `INSERT INTO auth_dbos.workflow_status
    (workflow_uuid,status,name,created_at,completed_at,application_name)
    SELECT 'a:'||lpad(i::text,5,'0'),'SUCCESS','accounts.registration',$1,$1,$2
    FROM generate_series(1,60000) i`,
    [cutoff - 1, AUTH_WORKFLOW_APPLICATION],
  );
  await seed('b:later', 'SUCCESS', cutoff - 1);
  expect(await runWorkflowRetentionSweep(pool, 30, DBOS, now, unclassified)).toBe(0);
  expect((await pool.query('SELECT cutoff::float8,after_key FROM auth_workflow_retention')).rows[0]).toEqual({
    cutoff,
    after_key: 'a:60000',
  });
  expect(await page(new Date(now.getTime() + day))).toMatchObject({ cutoff, examined: 1, retired: 1, done: true });
});

test('fully drained native history repeats empty pages without retaining a stale horizon', async () => {
  await reset();
  await seed('a:last', 'SUCCESS', cutoff - 1);
  expect(await page()).toMatchObject({ examined: 1, retired: 1, done: true });
  for (let tick = 1; tick <= 3; tick++) {
    expect(await page(new Date(now.getTime() + tick * day))).toEqual({
      cutoff: cutoff + tick * day,
      examined: 0,
      eligible: 0,
      retired: 0,
      pending: 0,
      done: true,
    });
    expect((await pool.query('SELECT cutoff,through_key,after_key FROM auth_workflow_retention')).rows[0]).toEqual({
      cutoff: null,
      through_key: null,
      after_key: null,
    });
  }
});
