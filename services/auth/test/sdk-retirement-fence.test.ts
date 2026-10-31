import { expect, test } from 'bun:test';
import { completeCopy, copiesAbsent, eraseCopy } from '../src/erasure-copy.ts';
import { AUTH_SDK_RETIREMENT } from '../src/sdk-retirement-fence.ts';
import { nativeFixture } from './support/erasure-native.ts';

test('Bind permanent native SDK writer fence to existing Auth copy retirement', async () => {
  const f = await nativeFixture();
  try {
    const person = await f.person('sdk-fence');
    const survivor = await f.person('sdk-fence-survivor');
    const copy = (
      await f.pool.query<{
        workflow_id: string;
        ready: boolean;
        retired: boolean;
        absent: boolean;
        source_key: string;
        result_finished_at: Date;
      }>(
        `SELECT w.workflow_id,w.ready,w.retired,w.absent,w.source_key,w.result_finished_at
         FROM auth_copy_work w JOIN auth_copy_role r USING(workflow_id)
         WHERE r.account_id=$1 AND w.name='accounts.registration'`,
        [person.accountId],
      )
    ).rows[0]!;
    expect(copy).toMatchObject({
      ready: true,
      retired: false,
      absent: false,
      result_finished_at: expect.any(Date),
    });
    // The original registration really ran and its caller consumed its result.
    // No manually inserted ready flag, synthetic SDK result or fake ACK.
    expect(await completeCopy(f.pool, copy.workflow_id)).toBe(true);
    expect(AUTH_SDK_RETIREMENT.gap).toBe('auth-sdk-permanent-late-writer-fence-unavailable');
    expect(await eraseCopy(f.pool, copy.workflow_id)).toBe(false);
    expect(await copiesAbsent(f.pool, copy.workflow_id)).toBe(false);
    expect(
      (
        await f.pool.query(
          `SELECT workflow_id,ready,retired,absent,source_key,result_finished_at
           FROM auth_copy_work WHERE workflow_id=$1`,
          [copy.workflow_id],
        )
      ).rows[0],
    ).toEqual(copy);
    expect(await eraseCopy(f.pool, 'unknown-original-sdk-mapping')).toBe(false);
    expect(await f.bindings.workflowPorts.readAccount(survivor.accountId)).toMatchObject({
      accountId: survivor.accountId,
      state: 'active',
    });
    expect(
      (
        await f.pool.query(
          `SELECT 1 FROM auth_copy_work w JOIN auth_copy_role r USING(workflow_id)
           WHERE r.account_id=$1 AND NOT w.retired AND NOT w.absent`,
          [survivor.accountId],
        )
      ).rowCount,
    ).toBeGreaterThan(0);
  } finally {
    await f.close();
  }
}, 180_000);
