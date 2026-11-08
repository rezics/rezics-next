import { expect, test } from 'bun:test';
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk';
import { completeCopy, copiesAbsent, eraseCopy } from '../src/erasure-copy.ts';
import { AUTH_SYSTEM_SCHEMA } from '../src/maintenance.ts';
import { workflowStatusScanReadiness } from '../src/retention-scan.ts';
import { AUTH_WORKFLOW_RETENTION_COST } from '../src/retention-cost.ts';
import { createAuthRetentionInvocation } from '../src/core/index.ts';
import { runWorkflowRetentionPage } from '../src/retention.ts';
import {
  AUTH_SDK_RETIREMENT,
  AUTH_SDK_RETIREMENT_DISPATCH,
  authSdkFundedReadiness,
  authSdkRetirementReadiness,
  createAuthSdkRetirementInvocation,
  fundAuthSdkRetirementEnvelope,
  nativeFence,
  nativeRetirementWork,
  readAuthSdkFence,
} from '../src/sdk-retirement-fence.ts';
import { failNativeQueries, nativeFixture, runNativeRetentionTick } from './support/erasure-native.ts';

test('Auth funds retirement attempts, waits, backoff and reconciliation before dispatch', async () => {
  const reserved: string[] = [];
  const invocation = createAuthSdkRetirementInvocation();
  expect(invocation.maxAttempts).toBe(1);
  expect(invocation.maxAttempts).toBeLessThanOrEqual(8);
  const tracking = {
    ...invocation,
    async reserve(dispatch: Parameters<typeof invocation.reserve>[0]) {
      reserved.push(dispatch);
      return invocation.reserve(dispatch);
    },
  };
  await fundAuthSdkRetirementEnvelope(tracking);
  expect(reserved).toEqual(['attempt', 'wait', 'backoff', 'reconcile']);
  await tracking.reserve('rollback');
  expect(reserved.at(-1)).toBe('rollback');
  expect(invocation.snapshot().dispatches).toMatchObject({
    'close:attempt': 1,
    'close:reconcile': 1,
    'close:rollback': 1,
  });
  await expect(
    fundAuthSdkRetirementEnvelope({
      deadline: Date.now() - 1,
      maxAttempts: 1,
      reserve: async () => {
        throw new Error('expired envelope must not dispatch');
      },
    }),
  ).rejects.toThrow('Auth SDK retirement deadline has expired');
  expect(AUTH_WORKFLOW_RETENTION_COST.fundedClose.statements).toBeGreaterThan(
    AUTH_SDK_RETIREMENT_DISPATCH.retire.statements,
  );
  const fence = {
    workflowID: 'wf-1',
    generation: '2',
    closureID: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    closedAt: 1,
  };
  expect(nativeRetirementWork(fence, 'wf-1')).toBeNull();
  expect(
    nativeRetirementWork({ fence, attempts: 1, failedWork: { attempts: 1, statements: 4, rows: 2, bytes: 8 } }, 'wf-1'),
  ).toEqual({ fence, attempts: 1, failedWork: [] });
  expect(
    nativeRetirementWork({ fence, attempts: 1, failedWork: [{ attempt: 1, dispatch: 'commit' }] }, 'wf-1'),
  ).toEqual({ fence, attempts: 1, failedWork: [{ attempt: 1, dispatch: 'commit' }] });
});

test('default Auth retirement persists the actual SDK fence before physical deletion and preserves living history', async () => {
  const f = await nativeFixture();
  const retireSdk = DBOSClient.prototype.retireWorkflow;
  try {
    // These cases consume the producer's actual package after integration. No
    // synthetic native receipt, writer coverage bit or result ACK is installed.
    expect(authSdkRetirementReadiness().ready).toBe(true);
    expect(authSdkFundedReadiness().ready).toBe(true);
    expect(workflowStatusScanReadiness().ready).toBe(true);
    const person = await f.person('native-fence-binding');
    const survivor = await f.person('native-fence-living');
    const sibling = await f.person('native-fence-sibling');
    const original = (
      await f.pool.query<{ workflow_id: string; ready: boolean; retired: boolean; result_finished_at: Date }>(
        `SELECT w.workflow_id,w.ready,w.retired,w.result_finished_at
       FROM auth_copy_work w JOIN auth_copy_role r USING(workflow_id)
       WHERE r.account_id=$1 AND w.name='accounts.registration'`,
        [person.accountId],
      )
    ).rows[0]!;
    expect(original).toMatchObject({ ready: true, retired: false, result_finished_at: expect.any(Date) });
    expect(await readAuthSdkFence(original.workflow_id)).toBeNull();
    await f.pool.query('UPDATE auth_dbos.workflow_status SET created_at=$2,completed_at=$2 WHERE workflow_uuid=$1', [
      original.workflow_id,
      Date.now() - 90 * 86400000,
    ]);
    await f.pool.query(
      `UPDATE auth_dbos.workflow_status SET created_at=$2,completed_at=$2
       WHERE workflow_uuid IN (SELECT workflow_id FROM auth_copy_role WHERE account_id=$1)`,
      [sibling.accountId, Date.now() - 90 * 86400000],
    );
    const invocation = createAuthRetentionInvocation({ deadline: Date.now() + 60_000 });
    const retain = f.host.service.internal.retainWorkflowHistory;
    f.host.service.internal.retainWorkflowHistory = (days) => retain(days, invocation);
    let calls = 0;
    DBOSClient.prototype.retireWorkflow = new Proxy(retireSdk, {
      apply(target, receiver, args) {
        expect(args[1]).toBe(invocation);
        calls++;
        return Reflect.apply(target, receiver, args);
      },
    });
    await runNativeRetentionTick(f.pool, 'z:binding-retention');
    expect(calls).toBe(2);
    expect(invocation.snapshot().closures).toHaveLength(2);
    expect(invocation.snapshot().dispatches['close:connect']).toBe(2);
    const receipt = await readAuthSdkFence(original.workflow_id);
    expect(receipt).toMatchObject({ workflowID: original.workflow_id, generation: '2' });
    if (!receipt) throw new Error('Native fence missing');
    const progress = (
      await f.pool.query(
        `SELECT retired,absent,sdk_fence_generation,sdk_fence_closure_id,sdk_fence_closed_at::float8,
       sdk_fence_pending FROM auth_copy_work WHERE workflow_id=$1`,
        [original.workflow_id],
      )
    ).rows[0];
    expect(progress).toEqual({
      retired: true,
      absent: true,
      sdk_fence_generation: receipt.generation,
      sdk_fence_closure_id: receipt.closureID,
      sdk_fence_closed_at: receipt.closedAt,
      sdk_fence_pending: null,
    });
    expect(await copiesAbsent(f.pool, original.workflow_id)).toBe(true);
    expect(await eraseCopy(f.pool, original.workflow_id)).toBe(true);
    expect(await eraseCopy(f.pool, 'unknown-original-sdk-mapping')).toBe(false);
    expect(await readAuthSdkFence('unknown-original-sdk-mapping')).toBeNull();
    // Reconnect independently through the supported client API after execution
    // and deduplication deletion. The native control identity must survive.
    for (let connection = 0; connection < 2; connection++) {
      const sdk = await DBOSClient.create({
        systemDatabaseUrl: f.fixture.url,
        systemDatabaseSchemaName: AUTH_SYSTEM_SCHEMA,
      });
      try {
        expect(nativeFence(await sdk.getWorkflowWriterFence(original.workflow_id), original.workflow_id)).toEqual(
          receipt,
        );
      } finally {
        await sdk.destroy();
      }
    }
    expect(await f.bindings.workflowPorts.readAccount(survivor.accountId)).toMatchObject({
      accountId: survivor.accountId,
      state: 'active',
    });
    const living = (
      await f.pool.query<{ workflow_id: string }>(
        `SELECT w.workflow_id FROM auth_copy_work w JOIN auth_copy_role r USING(workflow_id)
       WHERE r.account_id=$1 AND NOT w.retired AND NOT w.absent`,
        [survivor.accountId],
      )
    ).rows;
    expect(living.length).toBeGreaterThan(0);
    for (const work of living) expect(await copiesAbsent(f.pool, work.workflow_id)).toBe(false);
  } finally {
    DBOSClient.prototype.retireWorkflow = retireSdk;
    await f.close();
  }
}, 180_000);

test('absent SDK retirement capability preserves genuine consumed Auth custody and physical history', async () => {
  const f = await nativeFixture();
  const retire = Object.getOwnPropertyDescriptor(DBOSClient.prototype, 'retireWorkflow');
  try {
    const person = await f.person('native-fence-unavailable');
    const original = (
      await f.pool.query<{ workflow_id: string }>(
        `SELECT w.workflow_id,w.ready,w.retired,w.absent,w.source_key,w.result_digest,w.result_finished_at
         FROM auth_copy_work w JOIN auth_copy_role r USING(workflow_id)
         WHERE r.account_id=$1 AND w.name='accounts.registration'`,
        [person.accountId],
      )
    ).rows[0]!;
    expect(await completeCopy(f.pool, original.workflow_id)).toBe(true);
    // Exercise an actually absent funded runtime method, without a replacement body or receipt.
    if (!retire || !Reflect.deleteProperty(DBOSClient.prototype, 'retireWorkflow'))
      throw new Error('Funded retirement method cannot be removed for absence case');
    expect(authSdkFundedReadiness().ready).toBe(false);
    await f.pool.query('UPDATE auth_dbos.workflow_status SET created_at=$2,completed_at=$2 WHERE workflow_uuid=$1', [
      original.workflow_id,
      Date.now() - 90 * 86400000,
    ]);
    expect(await f.host.service.internal.retainWorkflowHistory(30)).toBe(0);
    expect(await eraseCopy(f.pool, original.workflow_id)).toBe(false);
    expect(await copiesAbsent(f.pool, original.workflow_id)).toBe(false);
    expect(await DBOS.getWorkflowWriterFence(original.workflow_id)).toBeNull();
    expect(
      (
        await f.pool.query(
          `SELECT workflow_id,ready,retired,absent,source_key,result_digest,result_finished_at
           FROM auth_copy_work WHERE workflow_id=$1`,
          [original.workflow_id],
        )
      ).rows[0],
    ).toEqual(original);
    expect(
      (
        await f.pool.query(
          `SELECT sdk_fence_generation,sdk_fence_closure_id,sdk_fence_closed_at,sdk_fence_pending
           FROM auth_copy_work WHERE workflow_id=$1`,
          [original.workflow_id],
        )
      ).rows[0],
    ).toEqual({
      sdk_fence_generation: null,
      sdk_fence_closure_id: null,
      sdk_fence_closed_at: null,
      sdk_fence_pending: AUTH_SDK_RETIREMENT.fundedGap,
    });
    if (retire) Object.defineProperty(DBOSClient.prototype, 'retireWorkflow', retire);
    expect(await f.host.service.internal.retainWorkflowHistory(30)).toBe(1);
    expect(await copiesAbsent(f.pool, original.workflow_id)).toBe(true);
  } finally {
    if (retire) Object.defineProperty(DBOSClient.prototype, 'retireWorkflow', retire);
    await f.close();
  }
}, 180_000);

test('lost Auth receipt persistence retries the same native closure without cancelling or losing original custody', async () => {
  const f = await nativeFixture();
  let restore = () => {};
  const invocation = createAuthRetentionInvocation({ maxPages: 2, deadline: Date.now() + 60_000 });
  const retain = () =>
    runWorkflowRetentionPage(
      f.pool,
      30,
      DBOS,
      new Date(),
      async (id, received) => {
        expect(received).toBe(invocation);
        await completeCopy(f.pool, id, undefined, received);
        return eraseCopy(f.pool, id, received);
      },
      invocation,
    );
  try {
    expect(authSdkRetirementReadiness().ready).toBe(true);
    const person = await f.person('native-fence-retry');
    const original = (
      await f.pool.query<{ workflow_id: string }>(
        `SELECT w.workflow_id,w.ready,w.retired,w.absent,w.source_key,w.result_digest,w.result_finished_at
       FROM auth_copy_work w JOIN auth_copy_role r USING(workflow_id)
       WHERE r.account_id=$1 AND w.name='accounts.registration'`,
        [person.accountId],
      )
    ).rows[0]!;
    await f.pool.query('UPDATE auth_dbos.workflow_status SET created_at=$2,completed_at=$2 WHERE workflow_uuid=$1', [
      original.workflow_id,
      Date.now() - 90 * 86400000,
    ]);
    let interrupted = false;
    restore = failNativeQueries(f.pool, (sql) => {
      if (interrupted || !sql.includes('SET sdk_fence_generation=')) return false;
      interrupted = true;
      return true;
    });
    await expect(retain()).rejects.toThrow('Injected native consumer interruption');
    restore();
    expect(interrupted).toBe(true);
    const paid = invocation.snapshot();
    expect(paid.closures).toEqual([{ workflowID: original.workflow_id, attempts: 1, failedWork: [], failed: false }]);
    expect(paid.dispatches['close:retire']).toBe(1);
    const receipt = await readAuthSdkFence(original.workflow_id);
    expect(receipt).toMatchObject({ workflowID: original.workflow_id, generation: '2' });
    expect(
      (
        await f.pool.query(
          'SELECT workflow_id,ready,retired,absent,source_key,result_digest,result_finished_at FROM auth_copy_work WHERE workflow_id=$1',
          [original.workflow_id],
        )
      ).rows[0],
    ).toEqual(original);
    expect(await copiesAbsent(f.pool, original.workflow_id)).toBe(false);
    expect((await retain()).retired).toBe(1);
    const replay = invocation.snapshot();
    expect(replay.closures).toHaveLength(2);
    expect(replay.dispatches['close:retire']).toBe(1);
    expect(replay.dispatches['close:reconcile']).toBe(2);
    expect(replay.reserved.statements).toBeGreaterThan(paid.reserved.statements);
    expect(await readAuthSdkFence(original.workflow_id)).toEqual(receipt);
    expect(await copiesAbsent(f.pool, original.workflow_id)).toBe(true);
  } finally {
    restore();
    await f.close();
  }
}, 180_000);

test('lost SDK closure COMMIT reply keeps the paid failed dispatches and converges on the same native identity', async () => {
  const f = await nativeFixture();
  let restore = () => {};
  try {
    const person = await f.person('lost-closure-reply');
    const id = (
      await f.pool.query<{ workflow_id: string }>(
        `SELECT w.workflow_id FROM auth_copy_work w JOIN auth_copy_role r USING(workflow_id)
       WHERE r.account_id=$1 AND w.name='accounts.registration'`,
        [person.accountId],
      )
    ).rows[0]!.workflow_id;
    const invocation = createAuthRetentionInvocation({ deadline: Date.now() + 60_000, maxPages: 2 });
    let retiring = false;
    let lost = false;
    restore = failNativeQueries(
      f.pool,
      (sql) => {
        if (sql.includes('retire_workflow_writers')) retiring = true;
        if (!retiring || lost || sql !== 'COMMIT') return false;
        lost = true;
        return true;
      },
      'after',
    );
    await expect(eraseCopy(f.pool, id, invocation)).rejects.toThrow();
    restore();
    expect(lost).toBe(true);
    const paid = invocation.snapshot();
    expect(paid.closures).toHaveLength(1);
    expect(paid.closures[0]).toMatchObject({
      workflowID: id,
      attempts: 1,
      failed: true,
      failedWork: expect.arrayContaining([
        { attempt: 1, dispatch: 'commit' },
        { attempt: 1, dispatch: 'retire' },
      ]),
    });
    const receipt = await readAuthSdkFence(id);
    expect(receipt).toMatchObject({ workflowID: id, generation: '2' });
    expect(await copiesAbsent(f.pool, id)).toBe(false);
    expect(await eraseCopy(f.pool, id, invocation)).toBe(true);
    expect(await readAuthSdkFence(id)).toEqual(receipt);
    expect(invocation.snapshot()).toMatchObject({ dispatches: { 'close:retire': 1, 'close:reconcile': 2 } });
    expect(invocation.snapshot().closures[0]).toEqual(paid.closures[0]!);
    expect(invocation.snapshot().reserved.statements).toBeGreaterThan(paid.reserved.statements);
  } finally {
    restore();
    await f.close();
  }
}, 180_000);
