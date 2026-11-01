import { afterAll, expect, test } from 'bun:test';
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { createWorkClient } from '../../src/work/client.ts';
import {
  lockSdkWorkflowWriterState,
  readSdkWorkflowWriterState,
  retireSdkWorkflowWriters,
} from '../../src/work/sdk-retirement-fence.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
const client = await createWorkClient(databaseUrl, pool);
const ids = new Set<string>();
const options = (workflowID: string) => ({ workflowID, workflowName: 'fixture.work', queueName: 'workflows' });
const id = () => {
  const value = `writer-transaction:${crypto.randomUUID()}`;
  ids.add(value);
  return value;
};
afterAll(async () => {
  await client.deleteWorkflows([...ids], false);
  await client.close();
  await pool.end();
});

test('Actual SDK writer fence has a supported current source-home transaction guard or a proven durable non-revival bridge', async () => {
  const workflowID = id();
  await client.enqueue(options(workflowID), workflowID);
  const live = await readSdkWorkflowWriterState(workflowID, client);
  if (!live) throw new Error('Actual SDK identity was not recorded');
  expect(live.generation).toBe('1');
  expect(live.closureID).toBeNull();
  const contender = await pool.connect();
  try {
    await runCommand(pool, { partition: 0 }, async (tx) => {
      expect(await lockSdkWorkflowWriterState(tx, live, client)).toEqual(live);
      // After the supported call RETURNS, an original SDK enqueue cannot commit past its native guard.
      await contender.query('BEGIN');
      await contender.query("SET LOCAL lock_timeout='50ms'");
      await expect(client.enqueueInTransaction(contender, options(workflowID), workflowID)).rejects.toMatchObject({
        code: '55P03',
      });
      await contender.query('ROLLBACK');
      return noEffect(null);
    });
    // Commit released the original live lock, without retiring or deleting any work.
    await client.enqueue(options(workflowID), workflowID);
    const fence = await retireSdkWorkflowWriters(workflowID, client);
    const closed = await readSdkWorkflowWriterState(workflowID, client);
    if (!closed) throw new Error('Actual SDK closure disappeared');
    expect(closed).toEqual({ ...fence, restoreGeneration: live.restoreGeneration });
    await client.deleteWorkflows([workflowID], false);
    await runCommand(pool, { partition: 0 }, async (tx) => {
      expect(await lockSdkWorkflowWriterState(tx, closed, client)).toEqual(closed);
      await contender.query('BEGIN');
      await expect(
        contender.query('SELECT 1 FROM dbos.workflow_writer_fences WHERE workflow_uuid=$1 FOR UPDATE NOWAIT', [
          workflowID,
        ]),
      ).rejects.toMatchObject({ code: '55P03' });
      await contender.query('ROLLBACK');
      return noEffect(null);
    });
    await contender.query('BEGIN');
    await contender.query('SELECT 1 FROM dbos.workflow_writer_fences WHERE workflow_uuid=$1 FOR UPDATE NOWAIT', [
      workflowID,
    ]);
    await contender.query('ROLLBACK');
    await expect(client.enqueue(options(workflowID), workflowID)).rejects.toThrow('permanently retired');
    await expect(
      runCommand(pool, { partition: 0 }, (tx) => lockSdkWorkflowWriterState(tx, live, client).then(noEffect)),
    ).rejects.toThrow('writer state changed');
  } finally {
    await contender.query('ROLLBACK');
    contender.release();
  }
});

test('SDK transaction guard refuses independent pools, wrong native identity, restore and closure generations', async () => {
  const workflowID = id();
  const otherID = id();
  await client.enqueue(options(workflowID), workflowID);
  await client.enqueue(options(otherID), otherID);
  await retireSdkWorkflowWriters(workflowID, client);
  const closed = await readSdkWorkflowWriterState(workflowID, client);
  if (!closed) throw new Error('Actual SDK closure disappeared');
  const independent = await DBOSClient.create({ systemDatabaseUrl: databaseUrl });
  try {
    await expect(
      runCommand(pool, { partition: 0 }, (tx) => lockSdkWorkflowWriterState(tx, closed, independent).then(noEffect)),
    ).rejects.toThrow('same native transaction pool');
  } finally {
    await independent.destroy();
  }
  for (const changed of [
    { ...closed, workflowID: otherID },
    { ...closed, workflowID: id() },
    { ...closed, closureID: crypto.randomUUID() },
    { ...closed, closedAt: closed.closedAt! + 1 },
    { ...closed, restoreGeneration: crypto.randomUUID() },
  ]) {
    await expect(
      runCommand(pool, { partition: 0 }, (tx) => lockSdkWorkflowWriterState(tx, changed, client).then(noEffect)),
    ).rejects.toThrow(/writer (state|restore generation) changed/);
  }
  // Exercise a native restore-domain advance inside a transaction that is rolled back.
  // The same native lock/check body is used by the owner restore operation.
  const restoring = await pool.connect();
  try {
    await restoring.query('BEGIN');
    const next = crypto.randomUUID();
    await restoring.query(
      `UPDATE dbos.workflow_writer_fence_domain SET revision=revision+1,restore_generation=$1 WHERE singleton`,
      [next],
    );
    await expect(client.checkWorkflowWriterStateInTransaction(restoring, pool, closed)).rejects.toThrow(
      'restore generation changed',
    );
  } finally {
    await restoring.query('ROLLBACK');
    restoring.release();
  }
  expect(await readSdkWorkflowWriterState(workflowID, client)).toEqual(closed);
  expect(() => lockSdkWorkflowWriterState({ query: pool.query.bind(pool) }, closed, client)).toThrow(
    'No authorized live command transaction',
  );
});

test('Bounded original SDK maintenance funds each dispatch once, rolls back refusals and preserves exact permanent writer custody', async () => {
  const { maintainSdkWorkflowOnce, SDK_MAINTENANCE_DISPATCH } = await import('../../src/work/sdk-retirement-fence.ts');
  const workflowID = id();
  await client.enqueue(options(workflowID), workflowID);
  const live = (await readSdkWorkflowWriterState(workflowID, client))!;
  const charged: unknown[] = [];
  const refused = new Error('Fixture refuses the owner retirement dispatch');
  await expect(
    maintainSdkWorkflowOnce(pool, client, live, 'retire', Date.now() + 5000, async (cost) => {
      charged.push(cost);
      if (cost === SDK_MAINTENANCE_DISPATCH.retire) throw refused;
    }),
  ).rejects.toBe(refused);
  expect(charged).toEqual(
    ['rollback', 'begin', 'settings', 'lock', 'retire'].map(
      (key) => SDK_MAINTENANCE_DISPATCH[key as keyof typeof SDK_MAINTENANCE_DISPATCH],
    ),
  );
  expect(await readSdkWorkflowWriterState(workflowID, client)).toEqual(live);
  const closed = await maintainSdkWorkflowOnce(pool, client, live, 'retire', Date.now() + 5000, async () => {});
  expect(closed?.generation).toBe('2');
  const current = (await readSdkWorkflowWriterState(workflowID, client))!;
  const deletion: unknown[] = [];
  await maintainSdkWorkflowOnce(pool, client, current, 'delete', Date.now() + 5000, async (cost) => {
    deletion.push(cost);
  });
  expect(deletion).toEqual(
    [
      'rollback',
      'begin',
      'settings',
      'lock',
      'delete-workflow_input',
      'delete-workflow_output',
      'delete-operation_outputs',
      'delete-workflow_status',
      'commit',
    ].map((key) => SDK_MAINTENANCE_DISPATCH[key as keyof typeof SDK_MAINTENANCE_DISPATCH]),
  );
  expect(await readSdkWorkflowWriterState(workflowID, client)).toEqual(current);
  await expect(client.enqueue(options(workflowID), workflowID)).rejects.toThrow('permanently retired');
  await expect(
    maintainSdkWorkflowOnce(
      pool,
      client,
      { ...current, restoreGeneration: crypto.randomUUID() },
      'delete',
      Date.now() + 5000,
      async () => {},
    ),
  ).rejects.toThrow('restore generation changed');
});
