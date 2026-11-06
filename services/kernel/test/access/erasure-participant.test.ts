import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createPool } from '../../src/database/pool.ts';
import { readErasureStatus, erasureWorkModule } from '../../src/access/erasure.ts';
import { advanceNativeErasure, NATIVE_ERASURE_GROUPS } from '../../src/access/erasure-native.ts';
import { composeAccessApplication } from '../../src/composition/access.ts';
import { bindExecutionContract } from '../../src/command/execution-contract.ts';
import { KERNEL_WORK_MODULES } from '../support/default-work-modules.ts';
import { createWorkClient } from '../../src/work/client.ts';
import { workExecutionPort } from '../../src/work/selected-runtime.ts';
import { historyExecutionPort } from '../../src/history/application/index.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { nativeFixture, scopes } from './native-account-bindings-fixture.ts';
import { deletePersona, drainEffects } from '../support/account-deletion.ts';
import { configureTestReceiptKeys } from '../support/receipt-keys.ts';
import { workerTestEnv } from '../support/worker-env.ts';
import '../support/native-history-composition.ts';

const pool = createPool(process.env.DATABASE_URL!);
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let child: ReturnType<typeof Bun.spawn> | undefined;
let stdout = '';
let output: Promise<void>;
let errors: Promise<string>;
const key = () => crypto.randomUUID().replaceAll('-', '_');
const handleRoute = (handle: string) => createHash('sha256').update(handle).digest().readUInt16BE(0);
async function start() {
  stdout = '';
  // Use the production default coordinator registration, with other owners kept
  // out of this Access-only acceptance process. No replacement effect or purger.
  child = Bun.spawn(
    [
      process.execPath,
      '--eval',
      `
    import { startWorker, readWorkerConfig } from './src/worker.ts';
    import { erasureWorkModule } from './src/access/erasure.ts';
    await startWorker(readWorkerConfig(process.env), [erasureWorkModule]);
    console.log('native-worker-ready');
  `,
    ],
    {
      cwd: `${import.meta.dir}/../..`,
      env: {
        ...process.env,
        ...workerTestEnv(),
        KERNEL_WORKER_POOL_SIZE: '10',
        KERNEL_EXECUTOR_ID: `native-${key()}`,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  if (!(child.stdout instanceof ReadableStream) || !(child.stderr instanceof ReadableStream))
    throw new Error('Native worker streams unavailable');
  const stream = child.stdout;
  output = (async () => {
    for await (const chunk of stream) stdout += new TextDecoder().decode(chunk);
  })();
  errors = new Response(child.stderr).text();
  const until = Date.now() + 30000;
  while (!stdout.includes('native-worker-ready') && Date.now() < until && child.exitCode === null) await Bun.sleep(10);
  expect(stdout).toContain('native-worker-ready');
}
async function crash() {
  if (!child) return;
  child.kill('SIGKILL');
  await child.exited;
  await output;
  const diagnostics = await errors;
  child = undefined;
  expect(diagnostics).not.toContain('Unhandled');
}
async function progress(accountId: string) {
  return (
    await pool.query<{ progress_id: string; phase: number; page: number; pending: string | null }>(
      'SELECT progress_id,phase,page,pending FROM access.erasure_native_progress WHERE route=$1 AND account_id=$2',
      [routeOf(accountId), accountId],
    )
  ).rows[0];
}
async function accessAcknowledgement(accountId: string) {
  return (
    await pool.query<{ outcome: string }>(
      `SELECT outcome FROM access.erasure_acknowledgement
       WHERE route=$1 AND account_id=$2 AND participant='access'`,
      [routeOf(accountId), accountId],
    )
  ).rows[0];
}
beforeAll(async () => {
  scopes.push('account:read', 'account:update', 'account:delete');
  auth = await nativeFixture(pool);
}, 120000);
afterAll(async () => {
  try {
    await crash();
    await auth?.close();
  } finally {
    await pool.end();
  }
});

test('default registered tombstone effect resumes after process and DBOS loss, retires exact handles without an owner, and leaves missing native/custody work pending', async () => {
  expect(KERNEL_WORK_MODULES.filter((module) => module === erasureWorkModule)).toHaveLength(1);
  const erased = await auth.person(`native_worker_${key()}`);
  const survivor = await auth.person(`native_survivor_${key()}`);
  const oldHandle = (
    await pool.query('SELECT handle FROM access.account WHERE route=$1 AND account_id=$2', [
      routeOf(erased.accountId),
      erased.accountId,
    ])
  ).rows[0].handle as string;
  const newHandle = `native_renamed_${key()}`;
  const operationKey = key();
  const operation = {
    kind: 'rename' as const,
    accountId: erased.accountId,
    handle: newHandle,
    expectedHandle: oldHandle,
    authorization: 'request',
  };
  const approval = await auth
    .approval()
    .approve(erased.bearer, { operationKey, operation }, { pool, deadline: Date.now() + 10000 });
  await auth.host.workflows.renameHandle({
    key: operationKey,
    accountId: erased.accountId,
    handle: newHandle,
    expectedHandle: oldHandle,
    authorization: approval.reference,
  });
  const survivorBefore = (
    await pool.query('SELECT * FROM access.account WHERE route=$1 AND account_id=$2', [
      routeOf(survivor.accountId),
      survivor.accountId,
    ])
  ).rows;
  const deletion = await deletePersona({ pool, auth }, erased);
  const partition = partitionOf(routeOf(erased.accountId)!);
  const eventRow = (
    await pool.query(
      `SELECT epoch,position,event_seq,id,type,subject,data,recorded_at AS time
    FROM core.outbox WHERE partition_no=$1 AND subject=$2 AND type='com.rezics.access.account-tombstoned.v1'
    ORDER BY position DESC LIMIT 1`,
      [partition, erased.accountId],
    )
  ).rows[0];
  expect(eventRow).toBeDefined();
  await start();
  await drainEffects(pool, partition);
  const firstDeadline = Date.now() + 60000;
  while (!(await progress(erased.accountId))?.phase && Date.now() < firstDeadline) await Bun.sleep(10);
  await crash();
  const committed = await progress(erased.accountId);
  expect(committed?.phase).toBeGreaterThan(0);
  const progressId = committed!.progress_id;
  const nativeId = `access-native:${progressId}`;
  const effectId = `fx:${eventRow.epoch}:${partition}:${eventRow.position}:${eventRow.event_seq}:account_erasure_native`;
  const client = await createWorkClient(process.env.DATABASE_URL!, pool);
  configureTestReceiptKeys(pool);
  bindExecutionContract(client, workExecutionPort(), historyExecutionPort);
  try {
    // Supported SDK removal of exactly this test's work. Native state is untouched.
    await client.deleteWorkflows([nativeId, effectId], false);
    expect(await client.getWorkflow(nativeId)).toBeUndefined();
    expect(await progress(erased.accountId)).toEqual(committed);
    // Resume the bounded native inventory independently; the restarted worker
    // below owns the terminal acknowledgement and shared-custody distinction.
    composeAccessApplication();
    const inventoryUntil = Date.now() + 540000;
    while ((await progress(erased.accountId))?.phase !== NATIVE_ERASURE_GROUPS().length) {
      if (Date.now() >= inventoryUntil) throw new Error('Native inventory did not reach completion');
      await advanceNativeErasure(pool, progressId);
    }
    await start();
    // Redeliver the original committed tombstone through the real registered effect.
    await client.enqueue(
      { workflowName: 'effect', workflowID: effectId, workflowIDReusePolicy: 'return-existing', queueName: 'effects' },
      'account_erasure_native',
      {
        specversion: '1.0',
        id: eventRow.id,
        source: `urn:rezics:log:${partition}.${eventRow.epoch}`,
        type: eventRow.type,
        subject: eventRow.subject,
        data: eventRow.data,
        time: new Date(eventRow.time).toISOString(),
        datacontenttype: 'application/json',
        sequence: String(eventRow.position).padStart(19, '0'),
      },
    );
    const deadline = Date.now() + 30000;
    while (!(await accessAcknowledgement(erased.accountId)) && Date.now() < deadline) {
      const status = await client.getWorkflow(nativeId);
      if (status?.status === 'ERROR' || status?.status === 'MAX_RECOVERY_ATTEMPTS_EXCEEDED')
        throw new Error(`Native erasure failed: ${JSON.stringify(status)}`);
      await Bun.sleep(100);
    }
    expect(await progress(erased.accountId)).toEqual({
      progress_id: progressId,
      phase: NATIVE_ERASURE_GROUPS().length,
      page: 0,
      pending: 'shared-history-producer',
    });
    expect(
      (
        await pool.query('SELECT native_complete_at FROM access.erasure_native_progress WHERE progress_id=$1', [
          progressId,
        ])
      ).rows[0]!.native_complete_at,
    ).not.toBeNull();
    for (const handle of [oldHandle, newHandle]) {
      const rows = (
        await pool.query('SELECT * FROM access.handle_claim WHERE route=$1 AND normalized_handle=$2', [
          handleRoute(handle),
          handle,
        ])
      ).rows;
      expect(rows).toEqual([
        {
          route: handleRoute(handle),
          normalized_handle: handle,
          state: 'retired',
          account_id: null,
          expires_at: null,
          reserved_until: null,
          transaction_id: null,
          reservation_id: null,
          hold_operation_id: null,
          hold_expected_handle: null,
          former_until: null,
        },
      ]);
      await expect(
        auth.COMMANDS.internalLifecycle.reserveHandle({ handle, accountId: survivor.accountId, key: key() }),
      ).rejects.toThrow();
      await expect(
        auth.COMMANDS.internalLifecycle.reserveHandle({ handle, accountId: erased.accountId, key: key() }),
      ).rejects.toThrow();
    }
    // Every delivered store/role is independently checked, not inferred from phase.
    expect(
      (
        await pool.query('SELECT 1 FROM access.account_preferences WHERE route=$1 AND account_id=$2', [
          routeOf(erased.accountId),
          erased.accountId,
        ])
      ).rows,
    ).toEqual([]);
    for (const store of ['resource_grant', 'resource_role_grant', 'resource_denial']) {
      expect(
        (await pool.query(`SELECT 1 FROM access.${store} WHERE resource_id=$1 OR subject_id=$1`, [erased.accountId]))
          .rows,
      ).toEqual([]);
    }
    for (const store of ['lifecycle_handle_effect', 'lifecycle_handle_operation']) {
      expect((await pool.query(`SELECT 1 FROM access.${store} WHERE account_id=$1`, [erased.accountId])).rows).toEqual(
        [],
      );
    }
    expect(
      (
        await pool.query('SELECT 1 FROM access.standing_parent_installation WHERE route=$1 AND resource_id=$2', [
          routeOf(erased.accountId),
          erased.accountId,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await pool.query('SELECT * FROM access.account WHERE route=$1 AND account_id=$2', [
          routeOf(survivor.accountId),
          survivor.accountId,
        ])
      ).rows,
    ).toEqual(survivorBefore);
    const inputs = (await pool.query('SELECT inputs FROM dbos.workflow_input WHERE workflow_uuid=$1', [nativeId]))
      .rows[0].inputs;
    expect(JSON.stringify(inputs)).toContain(progressId);
    expect(JSON.stringify(inputs)).not.toContain(erased.accountId);
    const status = await readErasureStatus(pool, erased.accountId);
    expect(status?.at).toBe(deletion.at);
    expect(await accessAcknowledgement(erased.accountId)).toEqual({ outcome: 'erased' });
    expect(status?.participants.access?.outcome).toBe('erased');
    expect(status?.participants['shared-history']?.outcome).toBe('pending');
    expect(status?.completedAt).toBeNull();
    // Local Access completion is durable; shared-history custody remains a separate obligation.
  } finally {
    await client.close();
  }
}, 900000);
