import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { ConfigError } from '../../src/commerce/config.ts';
import {
  readWorkflowRetentionConfig,
  runWorkflowRetentionSweep,
  type WorkflowRetentionSdk,
} from '../../src/work/retention.ts';
import { createWorkClient, enqueueWorkIntent } from '../../src/work/client.ts';
import { WORK_QUEUES } from '../../src/work/queues.ts';
import { readSdkWorkflowRetirement, retireSdkWorkflowWriters } from '../../src/work/sdk-retirement-fence.ts';

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

test('transactional work preserves installed partition, deduplication, priority and delay controls', async () => {
  await client.registerQueue('import', WORK_QUEUES.import);
  const workflowId = id('native-controls');
  const tx = await database.connect();
  try {
    await tx.query('BEGIN');
    await enqueueWorkIntent(client, tx, {
      queue: 'import',
      workflowName: 'retention.test.workflow',
      workflowId,
      input: { accounts: [] },
      queuePartitionKey: 'source-a',
      deduplicationID: workflowId,
      priority: 7,
      delaySeconds: 60,
    });
    await tx.query('COMMIT');
  } finally {
    await tx.query('ROLLBACK');
    tx.release();
  }
  expect(await client.getWorkflow(workflowId)).toMatchObject({
    status: 'DELAYED',
    queuePartitionKey: 'source-a',
    priority: 7,
  });
  expect((await client.listQueues()).find((queue) => queue.name === 'import')?.partitionConcurrency).toBe(1);
  const stored = await database.query(
    'SELECT deduplication_id, delay_until_epoch_ms FROM dbos.workflow_status WHERE workflow_uuid=$1',
    [workflowId],
  );
  expect(stored.rows[0].deduplication_id).toBe(workflowId);
  expect(Number(stored.rows[0].delay_until_epoch_ms)).toBeGreaterThan(Date.now());
});

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
     SET status = $2, completed_at = $3,
         created_at = CASE WHEN $3::bigint IS NULL THEN created_at ELSE $3::bigint - 1 END,
         queue_name = NULL, updated_at = $4
     WHERE workflow_uuid = $1`,
    [workflowID, status, completedAt, completedAt ?? Date.now()],
  );
}

test('the retention period defaults to 30 days and accepts only whole numbers from 7 through 365', () => {
  expect(readWorkflowRetentionConfig({})).toEqual({ retentionDays: 30 });
  expect(readWorkflowRetentionConfig({ KERNEL_WORKFLOW_RETENTION_DAYS: '7' })).toEqual({ retentionDays: 7 });
  expect(readWorkflowRetentionConfig({ KERNEL_WORKFLOW_RETENTION_DAYS: '365' })).toEqual({ retentionDays: 365 });
  expect(readWorkflowRetentionConfig({ KERNEL_WORKFLOW_RETENTION_DAYS: '030' })).toEqual({ retentionDays: 30 });

  for (const value of ['', '6', '366', '7.0', '1e2', ' 30', '30 ', '-1', 'NaN']) {
    expect(() => readWorkflowRetentionConfig({ KERNEL_WORKFLOW_RETENTION_DAYS: value })).toThrow(ConfigError);
    expect(() => readWorkflowRetentionConfig({ KERNEL_WORKFLOW_RETENTION_DAYS: value })).toThrow(
      'KERNEL_WORKFLOW_RETENTION_DAYS',
    );
  }
});

for (const lostResult of [false, true]) {
  test(`the retention sweep deletes terminal workflows completed before the cutoff with every DBOS row they own${lostResult ? ' after a lost deletion result' : ''}`, async () => {
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
    if (lostResult) {
      // Real SDK deletion commits, but the batch cannot return a result to its checkpoint caller.
      const sdk: WorkflowRetentionSdk = {
        listWorkflows: (input) => client.listWorkflows(input),
        async deleteWorkflows(ids, deleteChildren) {
          expect(deleteChildren).toBe(false);
          expect([...ids].sort()).toEqual([...workflowIDs].sort());
          await client.deleteWorkflows(ids, deleteChildren);
          throw new Error('lost deletion result');
        },
      };
      await expect(runWorkflowRetentionSweep(30, sdk)).rejects.toThrow('lost deletion result');
    } else {
      expect(await runWorkflowRetentionSweep(30, client)).toBe(workflowIDs.length);
    }

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
        const result = await database.query(`SELECT 1 FROM dbos.${table} WHERE ${keyColumn} = $1 LIMIT 1`, [
          workflowID,
        ]);
        expect(result.rowCount, `${table} still owns a row for ${workflowID}`).toBe(0);
      }
    }
    // Reselection after an uncheckpointed deletion and ordinary replay both find no remaining work.
    expect(await runWorkflowRetentionSweep(30, client)).toBe(0);
  });
}

test('cancellation precedes writer closure and retention deletes only its terminal execution', async () => {
  const workflowID = id('cancel-before-close');
  const child = id('retained-child');
  const foreign = id('foreign-application');
  for (const value of [workflowID, child, foreign]) await enqueue(value);
  await database.query('UPDATE dbos.workflow_status SET parent_workflow_id = $1 WHERE workflow_uuid = $2', [
    workflowID,
    child,
  ]);
  const old = Date.now() - 60 * 24 * 60 * 60 * 1000;
  await setTerminal(foreign, 'SUCCESS', old);
  await database.query('UPDATE dbos.workflow_status SET application_name = $2 WHERE workflow_uuid = $1', [
    foreign,
    'retention.foreign.fixture',
  ]);

  await client.cancelWorkflow(workflowID);
  expect((await client.getWorkflow(workflowID))?.status).toBe('CANCELLED');
  expect(await readSdkWorkflowRetirement(workflowID, client)).toBeNull();
  expect(
    (await database.query('SELECT 1 FROM dbos.workflow_input WHERE workflow_uuid = $1', [workflowID])).rowCount,
  ).toBe(1);
  await setTerminal(workflowID, 'CANCELLED', old);

  const closure = await retireSdkWorkflowWriters(workflowID, client);
  expect((await client.getWorkflow(workflowID))?.status).toBe('CANCELLED');
  expect(
    (await database.query('SELECT 1 FROM dbos.workflow_input WHERE workflow_uuid = $1', [workflowID])).rowCount,
  ).toBe(1);
  expect(await runWorkflowRetentionSweep(30, client)).toBe(1);
  expect(await client.getWorkflow(workflowID)).toBeUndefined();
  expect(
    (await database.query('SELECT 1 FROM dbos.workflow_input WHERE workflow_uuid = $1', [workflowID])).rowCount,
  ).toBe(0);
  expect(await readSdkWorkflowRetirement(workflowID, client)).toEqual(closure);
  for (const value of [child, foreign]) {
    expect(await client.getWorkflow(value)).toBeDefined();
    expect((await database.query('SELECT 1 FROM dbos.workflow_input WHERE workflow_uuid = $1', [value])).rowCount).toBe(
      1,
    );
  }
  expect((await client.getWorkflow(child))?.status).toBe('ENQUEUED');
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
  await database.query('UPDATE dbos.workflow_status SET created_at = $2 WHERE workflow_uuid = $1', [
    recent,
    cutoff - 1000,
  ]);

  await runWorkflowRetentionSweep(30, client, new Date(now));

  for (const workflowID of [pending, enqueued, delayed, recent, onCutoff, noCompletedAt]) {
    expect(await client.getWorkflow(workflowID)).toBeDefined();
  }
  expect((await client.getWorkflow(pending))?.status).toBe('PENDING');
  expect((await client.getWorkflow(enqueued))?.status).toBe('ENQUEUED');
  expect((await client.getWorkflow(delayed))?.status).toBe('DELAYED');
  expect(await client.getWorkflow(recent)).toMatchObject({ status: 'SUCCESS', createdAt: cutoff - 1000 });
  expect((await client.getWorkflow(onCutoff))?.completedAt).toBe(cutoff);
  expect((await client.getWorkflow(noCompletedAt))?.completedAt).toBeUndefined();
});
