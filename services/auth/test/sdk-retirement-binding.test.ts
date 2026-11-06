import { expect, test } from 'bun:test';
import { DBOS, DBOSClient } from '@dbos-inc/dbos-sdk';
import { completeCopy, copiesAbsent, eraseCopy } from '../src/erasure-copy.ts';
import { AUTH_SYSTEM_SCHEMA } from '../src/maintenance.ts';
import { authSdkRetirementReadiness, nativeFence, readAuthSdkFence } from '../src/sdk-retirement-fence.ts';
import { failNativeQueries, nativeFixture, runNativeRetentionTick } from './support/erasure-native.ts';

test('default Auth retirement persists the actual SDK fence before physical deletion and preserves living history', async () => {
  const f = await nativeFixture();
  try {
    // These cases consume the producer's actual package after integration. No
    // synthetic native receipt, writer coverage bit or result ACK is installed.
    expect(authSdkRetirementReadiness().ready).toBe(true);
    const person = await f.person('native-fence-binding');
    const survivor = await f.person('native-fence-living');
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
    await runNativeRetentionTick(f.pool, 'z:binding-retention');
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
    await f.close();
  }
}, 180_000);

test('absent SDK retirement capability preserves genuine consumed Auth custody and physical history', async () => {
  const f = await nativeFixture();
  const retirement = Object.getOwnPropertyDescriptor(DBOS, 'retireWorkflow');
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
    // Exercise an actually absent runtime method, without a replacement body or receipt.
    if (!retirement || !Reflect.deleteProperty(DBOS, 'retireWorkflow'))
      throw new Error('Native retirement method cannot be removed for absence case');
    expect(authSdkRetirementReadiness().ready).toBe(false);
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
      sdk_fence_pending: 'auth-sdk-permanent-late-writer-fence-unavailable',
    });
    if (retirement) Object.defineProperty(DBOS, 'retireWorkflow', retirement);
    expect(await f.host.service.internal.retainWorkflowHistory(30)).toBe(1);
    expect(await copiesAbsent(f.pool, original.workflow_id)).toBe(true);
  } finally {
    if (retirement) Object.defineProperty(DBOS, 'retireWorkflow', retirement);
    await f.close();
  }
}, 180_000);

test('lost Auth receipt persistence retries the same native closure without cancelling or losing original custody', async () => {
  const f = await nativeFixture();
  let restore = () => {};
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
    await expect(f.host.service.internal.retainWorkflowHistory(30)).rejects.toThrow(
      'Injected native consumer interruption',
    );
    restore();
    expect(interrupted).toBe(true);
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
    expect(await f.host.service.internal.retainWorkflowHistory(30)).toBe(1);
    expect(await readAuthSdkFence(original.workflow_id)).toEqual(receipt);
    expect(await copiesAbsent(f.pool, original.workflow_id)).toBe(true);
  } finally {
    restore();
    await f.close();
  }
}, 180_000);
