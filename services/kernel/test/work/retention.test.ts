import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { ConfigError } from '../../src/commerce/config.ts';
import { readWorkflowRetentionConfig, runWorkflowRetentionSweep } from '../../src/work/retention.ts';
import { createWorkClient } from '../../src/work/client.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const database = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const client = await createWorkClient(databaseUrl);
const owned = new Set<string>();

beforeAll(async () => {
  await database.query('SELECT 1');
});

afterAll(async () => {
  if (owned.size > 0) {
    await client.deleteWorkflows([...owned], false);
  }
  await client.close();
  await database.end();
});

function id(label: string): string {
  const value = `retention-test:${label}:${crypto.randomUUID()}`;
  owned.add(value);
  return value;
}

async function enqueue(workflowID: string, delaySeconds?: number): Promise<void> {
  await client.enqueue(
    {
      workflowID,
      workflowName: 'retention.test.workflow',
      queueName: 'workflows',
      ...(delaySeconds === undefined ? {} : { delaySeconds }),
    },
    workflowID,
  );
}

async function setTerminal(workflowID: string, status: string, completedAt: number | null): Promise<void> {
  await database.query(
    `UPDATE dbos.workflow_status
     SET status = $2, completed_at = $3, queue_name = NULL, updated_at = $4
     WHERE workflow_uuid = $1`,
    [workflowID, status, completedAt, completedAt ?? Date.now()],
  );
}

test('the retention period defaults to 30 days and accepts only whole numbers from 7 through 365', () => {
  expect(readWorkflowRetentionConfig({})).toEqual({ retentionDays: 30 });
  expect(readWorkflowRetentionConfig({ KERNEL_WORKFLOW_RETENTION_DAYS: '7' })).toEqual({ retentionDays: 7 });
  expect(readWorkflowRetentionConfig({ KERNEL_WORKFLOW_RETENTION_DAYS: '365' })).toEqual({ retentionDays: 365 });

  for (const value of ['', '6', '366', '7.0', '1e2', ' 30', '30 ', '-1', 'NaN']) {
    expect(() => readWorkflowRetentionConfig({ KERNEL_WORKFLOW_RETENTION_DAYS: value })).toThrow(ConfigError);
    expect(() => readWorkflowRetentionConfig({ KERNEL_WORKFLOW_RETENTION_DAYS: value })).toThrow(
      'KERNEL_WORKFLOW_RETENTION_DAYS',
    );
  }
});

test('the retention sweep deletes terminal workflows completed before the cutoff with every DBOS row they own', async () => {
  const old = Date.now() - 60 * 24 * 60 * 60 * 1000;
  const terminal = [
    ['success', 'SUCCESS'],
    ['error', 'ERROR'],
    ['cancelled', 'CANCELLED'],
    ['exhausted', 'MAX_RECOVERY_ATTEMPTS_EXCEEDED'],
  ] as const;
  const workflowIDs: string[] = [];
  for (const [label, status] of terminal) {
    const workflowID = id(label);
    workflowIDs.push(workflowID);
    await enqueue(workflowID);
    await setTerminal(workflowID, status, old);
    await database.query('INSERT INTO dbos.workflow_output (workflow_uuid, output, error) VALUES ($1, $2, NULL)', [
      workflowID,
      '"output"',
    ]);
    await database.query(
      `INSERT INTO dbos.operation_outputs (workflow_uuid, function_id, function_name, output)
       VALUES ($1, 1, 'retention.test.step', '"step"')`,
      [workflowID],
    );
    await database.query('INSERT INTO dbos.workflow_events (workflow_uuid, key, value) VALUES ($1, $2, $3)', [
      workflowID,
      'event',
      '"value"',
    ]);
    await database.query(
      `INSERT INTO dbos.workflow_events_history (workflow_uuid, function_id, key, value)
       VALUES ($1, 1, 'event', '"history"')`,
      [workflowID],
    );
    await database.query(
      `INSERT INTO dbos.notifications (destination_uuid, topic, message, serialization)
       VALUES ($1, 'retention-test', '"message"', 'portable_json')`,
      [workflowID],
    );
    await database.query(
      `INSERT INTO dbos.streams (workflow_uuid, key, value, "offset", function_id, serialization)
       VALUES ($1, 'retention-test', '"stream"', 0, 1, 'portable_json')`,
      [workflowID],
    );
  }

  for (const [index, workflowID] of workflowIDs.entries()) {
    expect(await client.getWorkflow(workflowID)).toMatchObject({
      status: terminal[index]![1],
      completedAt: old,
    });
  }
  expect(await runWorkflowRetentionSweep(30, client)).toBe(workflowIDs.length);

  for (const workflowID of workflowIDs) {
    for (const table of [
      'workflow_status',
      'workflow_input',
      'workflow_output',
      'operation_outputs',
      'workflow_events',
      'workflow_events_history',
      'notifications',
      'streams',
    ]) {
      const keyColumn = table === 'notifications' ? 'destination_uuid' : 'workflow_uuid';
      const result = await database.query(`SELECT 1 FROM dbos.${table} WHERE ${keyColumn} = $1 LIMIT 1`, [workflowID]);
      expect(result.rowCount, `${table} still owns a row for ${workflowID}`).toBe(0);
    }
  }
});

test('the retention sweep keeps pending, enqueued, delayed and recently completed workflows', async () => {
  const now = Date.now();
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  const pending = id('pending');
  const enqueued = id('enqueued');
  const delayed = id('delayed');
  const recent = id('recent');
  const onCutoff = id('on-cutoff');
  const noCompletedAt = id('missing-completion');

  await enqueue(pending);
  await enqueue(enqueued);
  await enqueue(delayed, 24 * 60 * 60);
  await enqueue(recent);
  await enqueue(onCutoff);
  await enqueue(noCompletedAt);
  await database.query(
    "UPDATE dbos.workflow_status SET status = 'PENDING', queue_name = NULL WHERE workflow_uuid = $1",
    [pending],
  );
  await setTerminal(recent, 'SUCCESS', cutoff + 1000);
  await setTerminal(onCutoff, 'SUCCESS', cutoff);
  await setTerminal(noCompletedAt, 'ERROR', null);

  await runWorkflowRetentionSweep(30, client, new Date(now));

  for (const workflowID of [pending, enqueued, delayed, recent, onCutoff, noCompletedAt]) {
    expect(await client.getWorkflow(workflowID)).toBeDefined();
  }
  expect((await client.getWorkflow(pending))?.status).toBe('PENDING');
  expect((await client.getWorkflow(enqueued))?.status).toBe('ENQUEUED');
  expect((await client.getWorkflow(delayed))?.status).toBe('DELAYED');
  expect((await client.getWorkflow(recent))?.status).toBe('SUCCESS');
  expect((await client.getWorkflow(onCutoff))?.completedAt).toBe(cutoff);
  expect((await client.getWorkflow(noCompletedAt))?.completedAt).toBeUndefined();
});
