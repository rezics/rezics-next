import { afterAll, expect, test } from 'bun:test';
import { DBOSClient } from '@dbos-inc/dbos-sdk';
import pg from 'pg';
import { createWorkClient, hasRetainedWorkCopies } from '../../src/work/client.ts';
import { readSdkWorkflowRetirement, retireSdkWorkflowWriters } from '../../src/work/sdk-retirement-fence.ts';
import { fixture } from './support/process.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const database = new pg.Pool({ connectionString: databaseUrl, max: 4 });
// Constructed before retirement; these clients do not own writer admission.
const client = await createWorkClient(databaseUrl);
const owned = new Set<string>();
function id(): string {
  const value = `writer-fence:${crypto.randomUUID()}`;
  owned.add(value);
  return value;
}
const options = (workflowID: string) => ({ workflowID, workflowName: 'fixture.work', queueName: 'workflows' });

afterAll(async () => {
  await client.deleteWorkflows([...owned], false);
  await client.close();
  await database.end();
});

// Actual pinned native family, including non-FK payload tables. No trigger bypass or replacement writer.
const family = [
  [
    'workflow_status',
    'workflow_uuid',
    'status',
    `INSERT INTO dbos.workflow_status (workflow_uuid,status,name) VALUES ($1,'SUCCESS','fixture.work')`,
  ],
  [
    'workflow_input',
    'workflow_uuid',
    'inputs',
    `INSERT INTO dbos.workflow_input (workflow_uuid,inputs) VALUES ($1,'["input"]')
     ON CONFLICT (workflow_uuid) DO UPDATE SET inputs=EXCLUDED.inputs`,
  ],
  [
    'workflow_output',
    'workflow_uuid',
    'output',
    `INSERT INTO dbos.workflow_output (workflow_uuid,output,error) VALUES ($1,'"output"',NULL)`,
  ],
  [
    'operation_outputs',
    'workflow_uuid',
    'output',
    `INSERT INTO dbos.operation_outputs (workflow_uuid,function_id,function_name,output,error)
     VALUES ($1,1,'fixture.step','"step"',NULL)`,
  ],
  [
    'workflow_events',
    'workflow_uuid',
    'value',
    `INSERT INTO dbos.workflow_events (workflow_uuid,key,value) VALUES ($1,'event','"event"')`,
  ],
  [
    'workflow_events_history',
    'workflow_uuid',
    'value',
    `INSERT INTO dbos.workflow_events_history (workflow_uuid,function_id,key,value)
     VALUES ($1,1,'event','"history"')`,
  ],
  [
    'notifications',
    'destination_uuid',
    'message',
    `INSERT INTO dbos.notifications (destination_uuid,message_uuid,topic,message,serialization)
     VALUES ($1,$1||':message','topic','"message"','portable_json')`,
  ],
  [
    'streams',
    'workflow_uuid',
    'value',
    `INSERT INTO dbos.streams (workflow_uuid,key,value,"offset",function_id,serialization)
     VALUES ($1,'stream','"stream"',0,1,'portable_json')`,
  ],
] as const;

test('Permanent SDK writer refusal omits private workflow identity', async () => {
  const accountSuffix = `account:${crypto.randomUUID()}`;
  const workflowID = `writer-fence:${accountSuffix}`;
  owned.add(workflowID);
  await client.enqueue(options(workflowID), workflowID);
  await retireSdkWorkflowWriters(workflowID, client);
  await expect(database.query(family[0][3], [workflowID])).rejects.toSatisfy((error: unknown) => {
    if (!(error instanceof Error) || !('code' in error)) return false;
    const diagnostic = `${String(error)} ${JSON.stringify(error)}`;
    return (
      error.code === 'P0001' &&
      error.message === 'DBOS workflow writer is permanently retired' &&
      !diagnostic.includes(workflowID) &&
      !diagnostic.includes(accountSuffix)
    );
  });
});

test('retirement waits for the native writer COMMIT and has no global lock', async () => {
  const workflowID = id();
  const otherID = id();
  await client.enqueue(options(workflowID), workflowID);
  const writer = await database.connect();
  const retirementPool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const retiringClient = await DBOSClient.create({
    systemDatabaseUrl: databaseUrl,
    systemDatabasePool: retirementPool,
  });
  let retirement: ReturnType<typeof retireSdkWorkflowWriters> | undefined;
  try {
    const writerPid = (await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const retirementPid = (await retirementPool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await writer.query('BEGIN');
    await writer.query(family[2][3], [workflowID]);
    retirement = retireSdkWorkflowWriters(workflowID, retiringClient);
    // Observe the real native lock wait, never infer closure from a timing delay.
    const deadline = Date.now() + 5_000;
    while (true) {
      const { rows } = await database.query<{ blockers: number[] }>('SELECT pg_blocking_pids($1) AS blockers', [
        retirementPid,
      ]);
      if (rows[0]!.blockers.includes(writerPid)) break;
      if (Date.now() > deadline) throw new Error('Retirement did not serialize with the in-flight native writer');
      await Bun.sleep(10);
    }
    await client.enqueue(options(otherID), otherID);
    const unrelated = await retireSdkWorkflowWriters(otherID, client);
    expect(unrelated.workflowID).toBe(otherID);
    await client.deleteWorkflows([otherID], false);
    await writer.query('COMMIT');
    const receipt = await retirement;
    expect(receipt.workflowID).toBe(workflowID);
    expect(receipt.generation).toBe('2');
    expect(receipt.closureID).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipt.closedAt).toBeGreaterThan(0);
    expect(await readSdkWorkflowRetirement(workflowID, client)).toEqual(receipt);
    expect(await retireSdkWorkflowWriters(workflowID, client)).toEqual(receipt);
    expect(
      (await database.query('SELECT output FROM dbos.workflow_output WHERE workflow_uuid=$1', [workflowID])).rows,
    ).toEqual([{ output: '"output"' }]);
    // Technical closure neither changes workflow status nor purges its retained input/output.
    expect((await client.getWorkflow(workflowID))?.status).toBe('ENQUEUED');
    await client.deleteWorkflows([workflowID], false);
    expect(await readSdkWorkflowRetirement(workflowID, client)).toEqual(receipt);
  } finally {
    await writer.query('ROLLBACK');
    writer.release();
    await retirement?.catch(() => undefined);
    await retiringClient.destroy();
    await retirementPool.end();
  }
}, 30_000);

test('every native family rejects late inserts, updates and restore replay after execution deletion', async () => {
  const workflowID = id();
  const forkID = id();
  await client.enqueue(options(workflowID), workflowID);
  await database.query(`UPDATE dbos.workflow_status SET status='SUCCESS',queue_name=NULL WHERE workflow_uuid=$1`, [
    workflowID,
  ]);
  for (const entry of family.slice(1)) await database.query(entry[3], [workflowID]);
  const before: unknown[] = [];
  for (const [table, key] of family) {
    before.push((await database.query(`SELECT * FROM dbos.${table} WHERE ${key}=$1`, [workflowID])).rows);
  }
  const oldSnapshot = await database.connect();
  const transaction = await database.connect();
  try {
    await oldSnapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await oldSnapshot.query('SELECT * FROM dbos.workflow_writer_fences WHERE workflow_uuid=$1', [workflowID]);
    const receipt = await retireSdkWorkflowWriters(workflowID, client);
    const after: unknown[] = [];
    for (const [table, key, column, insert] of family) {
      after.push((await database.query(`SELECT * FROM dbos.${table} WHERE ${key}=$1`, [workflowID])).rows);
      await expect(database.query(insert, [workflowID])).rejects.toThrow('permanently retired');
      await expect(
        database.query(`UPDATE dbos.${table} SET ${column}=${column} WHERE ${key}=$1`, [workflowID]),
      ).rejects.toThrow('permanently retired');
    }
    expect(after).toEqual(before);
    await expect(client.enqueue(options(workflowID), workflowID)).rejects.toThrow('permanently retired');
    await expect(client.resumeWorkflow(workflowID)).rejects.toThrow('permanently retired');
    await expect(client.rewindWorkflow(workflowID, { startStep: 0 })).rejects.toThrow('permanently retired');
    await expect(client.forkWorkflow(workflowID, 0, { newWorkflowID: forkID })).rejects.toThrow('permanently retired');
    await expect(client.send(workflowID, 'late-message')).rejects.toThrow('permanently retired');
    await transaction.query('BEGIN');
    await expect(client.enqueueInTransaction(transaction, options(workflowID), workflowID)).rejects.toThrow(
      'permanently retired',
    );
    await transaction.query('ROLLBACK');
    await expect(oldSnapshot.query(family[1][3], [workflowID])).rejects.toMatchObject({ code: '40001' });
    await oldSnapshot.query('ROLLBACK');
    // Supported deletion owns physical cleanup; the tombstone is independent of every family below.
    await client.deleteWorkflows([workflowID], false);
    expect(await readSdkWorkflowRetirement(workflowID, client)).toEqual(receipt);
    for (const [table, key, , insert] of family) {
      expect((await database.query(`SELECT 1 FROM dbos.${table} WHERE ${key}=$1`, [workflowID])).rows).toEqual([]);
      await expect(database.query(insert, [workflowID])).rejects.toThrow('permanently retired');
    }
    expect(await hasRetainedWorkCopies(transaction, workflowID)).toBe(false);
    await expect(client.enqueue(options(workflowID), workflowID)).rejects.toThrow('permanently retired');
    // A replay restoring status cannot create a fresh generation from the deleted dedup identity.
    await expect(database.query(family[0][3], [workflowID])).rejects.toThrow('permanently retired');
    await expect(
      database.query('DELETE FROM dbos.workflow_writer_fences WHERE workflow_uuid=$1', [workflowID]),
    ).rejects.toThrow('identity is permanent');
    await expect(
      database.query(
        'UPDATE dbos.workflow_writer_fences SET generation=1,closure_id=NULL,closed_at=NULL WHERE workflow_uuid=$1',
        [workflowID],
      ),
    ).rejects.toThrow('closure is immutable');
    expect(await retireSdkWorkflowWriters(workflowID, client)).toEqual(receipt);
    expect(await readSdkWorkflowRetirement(forkID, client)).toBeNull();
    const absentReceipt = await retireSdkWorkflowWriters(forkID, client);
    await expect(client.enqueue(options(forkID), forkID)).rejects.toThrow('permanently retired');
    expect(await readSdkWorkflowRetirement(forkID, client)).toEqual(absentReceipt);
  } finally {
    await oldSnapshot.query('ROLLBACK');
    await transaction.query('ROLLBACK');
    oldSnapshot.release();
    transaction.release();
  }
}, 30_000);

test('Native SDK permanent workflow writer fence', async () => {
  const workflowID = id();
  const destinationID = id();
  const unrelatedID = id();
  // The existing worker fixture starts and pauses in its ordinary registered native step.
  // Its sendFromStep body and owner check are the original pinned SDK path, unchanged by the patch.
  await client.enqueue(options(destinationID), destinationID);
  await database.query(`UPDATE dbos.workflow_status SET status='SUCCESS',queue_name=NULL WHERE workflow_uuid=$1`, [
    destinationID,
  ]);
  const runtime = fixture('worker');
  try {
    await runtime.until('worker-ready');
    await client.enqueue(options(workflowID), workflowID, destinationID);
    await runtime.until(`started:${workflowID}`);
    const receipt = await retireSdkWorkflowWriters(workflowID, client);
    expect((await client.getWorkflow(workflowID))?.status).toBe('PENDING');
    await runtime.until(`finished:${workflowID}`);
    const unrelated = await client.enqueue(options(unrelatedID), unrelatedID);
    expect(await unrelated.getResult()).toBe(unrelatedID);
    expect(
      (await database.query('SELECT 1 FROM dbos.notifications WHERE destination_uuid=$1', [destinationID])).rows,
    ).toEqual([]);
    expect(
      (await database.query('SELECT 1 FROM dbos.operation_outputs WHERE workflow_uuid=$1', [workflowID])).rows,
    ).toEqual([]);
    expect(
      (await database.query('SELECT 1 FROM dbos.workflow_output WHERE workflow_uuid=$1', [workflowID])).rows,
    ).toEqual([]);
    await client.deleteWorkflows([workflowID], false);
    runtime.child.kill('SIGTERM');
    await runtime.finish();
    expect(await readSdkWorkflowRetirement(workflowID, client)).toEqual(receipt);
    await expect(client.enqueue(options(workflowID), workflowID, destinationID)).rejects.toThrow('permanently retired');
  } finally {
    runtime.child.kill();
  }
}, 120_000);
