import { expect, test } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import { nativeFixture, scopes } from './support/erasure-native.ts';

// These cases use the existing real Auth/Access fixture and producers. The
// existing growth-erasure-native matrix remains the physical-bound proof.
test('fresh native producer coverage retains the producing client owner after a source move and erases that role on a surviving subject', async () => {
  const f = await nativeFixture();
  try {
    const owner = await f.person('role-owner');
    const survivor = await f.person('role-survivor');
    await f.host.service.internal.registerClient({ clientId: 'role-owned', firstParty: true, scopes });
    await f.pool.query('UPDATE auth_client SET "userId"=$1 WHERE client_id=$2', [owner.accountId, 'role-owned']);
    await f.login(survivor, 'role-owned');
    const session = (
      await f.pool.query<{ id: string; erasure_role_version: number; erasure_client_owner_id: string }>(
        'SELECT id,erasure_role_version,erasure_client_owner_id FROM session WHERE "userId"=$1 AND "clientId"=$2',
        [survivor.accountId, 'role-owned'],
      )
    ).rows[0]!;
    expect(session.erasure_role_version).toBe(1);
    expect(session.erasure_client_owner_id).toBe(owner.accountId);
    expect(
      (await f.pool.query('SELECT native_covered FROM auth_copy_coverage WHERE singleton')).rows[0]!.native_covered,
    ).toBe(true);
    await f.pool.query('UPDATE auth_client SET "userId"=$1 WHERE client_id=$2', [survivor.accountId, 'role-owned']);
    expect((await f.delete(owner)).status).toBe(200);
    expect((await f.pool.query('SELECT 1 FROM session WHERE id=$1', [session.id])).rowCount).toBe(0);
    expect((await f.pool.query('SELECT 1 FROM "user" WHERE id=$1', [survivor.accountId])).rowCount).toBe(1);
    expect(
      (await f.pool.query('SELECT "userId" FROM auth_client WHERE client_id=$1', ['role-owned'])).rows[0]!.userId,
    ).toBe(survivor.accountId);
  } finally {
    await f.close();
  }
}, 60_000);

test('deployment refuses a pre-cut writer lease and default recovery keeps opaque historical attribution unknown after expiry', async () => {
  let oldPool: Pool | undefined;
  let oldLease: PoolClient | undefined;
  let oldSnapshot: PoolClient | undefined;
  const f = await nativeFixture({
    async openPool(url) {
      oldPool = new Pool({ connectionString: url });
      oldLease = await oldPool.connect();
      await oldLease.query('BEGIN');
      await oldLease.query(`INSERT INTO verification(id,identifier,value,"expiresAt","createdAt","updatedAt")
        VALUES ('opaque-before-cut','opaque-before-cut','{"userId":"untrusted-payload"}',now()-interval '1 second',now(),now())`);
      await oldLease.query(`INSERT INTO verification(id,identifier,value,"expiresAt","createdAt","updatedAt",erasure_account_id)
        VALUES ('typed-before-cut','typed-before-cut','opaque',now()+interval '1 hour',now(),now(),'typed-before-cut-account')`);
      await oldLease.query('COMMIT');
      await oldLease.query('BEGIN');
      oldSnapshot = await oldPool.connect();
      await oldSnapshot.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await oldSnapshot.query('SELECT armed FROM auth_native_role_deployment WHERE singleton');
      return new Pool({ connectionString: url });
    },
  });
  try {
    await expect(
      oldLease!.query(`INSERT INTO verification(id,identifier,value,"expiresAt","createdAt","updatedAt")
      VALUES ('old-queued','old-queued','opaque',now()+interval '1 hour',now(),now())`),
    ).rejects.toThrow('Auth native role producer version refused');
    await oldLease!.query('ROLLBACK');
    await expect(
      oldSnapshot!.query(`INSERT INTO verification(id,identifier,value,"expiresAt","createdAt","updatedAt")
      VALUES ('old-snapshot','old-snapshot','opaque',now()+interval '1 hour',now(),now())`),
    ).rejects.toMatchObject({ code: '40001' });
    await oldSnapshot!.query('ROLLBACK');
    expect(
      (
        await f.pool.query('SELECT erasure_role_version,erasure_account_id FROM verification WHERE id=$1', [
          'typed-before-cut',
        ])
      ).rows[0],
    ).toEqual({ erasure_role_version: 1, erasure_account_id: 'typed-before-cut-account' });
    // No initiating caller or final participant acknowledgement drives this work.
    for (let i = 0; i < 32; i++) await f.host.service.internal.redriveNativeErasure();
    await f.host.service.internal.pruneExpiredVerifications();
    expect((await f.pool.query('SELECT 1 FROM verification WHERE id=$1', ['opaque-before-cut'])).rowCount).toBe(0);
    expect(
      (await f.pool.query('SELECT reason FROM auth_native_role_unknown WHERE store=$1', ['verification'])).rows.length,
    ).toBeGreaterThan(0);
    expect(
      (await f.pool.query('SELECT native_covered FROM auth_copy_coverage WHERE singleton')).rows[0]!.native_covered,
    ).toBe(false);
    expect(
      (await f.pool.query('SELECT armed,store_index FROM auth_native_role_deployment WHERE singleton')).rows[0],
    ).toEqual({ armed: true, store_index: 27 });
  } finally {
    oldLease?.release();
    oldSnapshot?.release();
    await oldPool?.end();
    await f.close();
  }
}, 60_000);
