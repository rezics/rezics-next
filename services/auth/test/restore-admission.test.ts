import { expect, test } from 'bun:test';
import { nativeFixture } from './support/erasure-native.ts';

// Uses the existing native composition. It deliberately supplies no invented
// physical-owner inventory, incarnation, custody receipt or readiness callback.
test('missing original physical owner keeps current receiving closure unavailable without widening Auth', async () => {
  const f = await nativeFixture();
  try {
    const deleted = await f.person('receiving-owner-unavailable');
    expect((await f.delete(deleted)).status).toBe(200);
    const ports = f.bindings.trustedAccess;
    const barrier = await ports.readAuthErasureBarrier!(deleted.accountId);
    expect(barrier).not.toBeNull();
    if (!barrier) throw new Error('Missing genuine native deletion barrier');
    const route = f.routeOf(deleted.accountId)!;
    const partition = Math.floor(route / 16);
    // Use the genuine bounded Source initialization, never fabricate its lineage.
    expect(
      (await f.kernel.query('SELECT access.initialize_auth_erasure_partition($1) AS ready', [partition])).rows[0]
        ?.ready,
    ).toBe(true);
    const registration = await ports.registerAuthReceivingClosure!({ barrier, deadline: Date.now() + 5000 });
    expect(registration).toEqual({ state: 'pending', reason: 'physical-owner-unavailable' });
    const { prepareCurrentAuthReceivingClosure, readAuthHistoryCompletion } =
      await import('../../kernel/src/access/shared-history-auth.ts');
    expect(
      await prepareCurrentAuthReceivingClosure({ pool: f.kernel }, barrier, { deadline: Date.now() + 5000 }),
    ).toBeNull();
    expect(await readAuthHistoryCompletion(f.kernel, barrier)).toBe(false);
    // A genuine historical barrier publication is deliberately insufficient.
    await f.kernel.query(
      `INSERT INTO access.auth_history_proof(route,account_id,phase,version,at)
      VALUES($1,$2,'copies-erased',$3,$4) ON CONFLICT DO NOTHING`,
      [route, deleted.accountId, barrier.version, barrier.at],
    );
    const { readHistoricalAuthHistoryCompletion, verifyCurrentAuthReceivingClosure } =
      await import('../../kernel/src/access/shared-history-auth.ts');
    expect(await readHistoricalAuthHistoryCompletion(f.kernel, barrier)).toBe(true);
    expect(await readAuthHistoryCompletion(f.kernel, barrier)).toBe(false);
    expect(
      await ports.invalidateAuthReceivingClosure!({
        partition,
        restoreGeneration: 'replacement',
        deadline: Date.now() + 5000,
      }),
    ).toBe(true);
    const control = (
      await f.kernel.query(
        `SELECT revision::text,state,database_identity,receiving_incarnation,
      restore_generation,owner_installation,writer_fence FROM access.auth_receiving_control WHERE partition_no=$1`,
        [partition],
      )
    ).rows[0];
    expect(control).toEqual({
      revision: '2',
      state: 'quarantined',
      database_identity: null,
      receiving_incarnation: null,
      restore_generation: null,
      owner_installation: null,
      writer_fence: null,
    });
    expect(
      await ports.invalidateAuthReceivingClosure!({
        partition,
        restoreGeneration: 'replacement',
        deadline: Date.now() + 5000,
      }),
    ).toBe(true);
    expect(
      (
        await f.kernel.query('SELECT revision::text FROM access.auth_receiving_control WHERE partition_no=$1', [
          partition,
        ])
      ).rows[0]?.revision,
    ).toBe('2');
    expect(
      await ports.readAuthReceivingControl!({
        partition,
        restoreGeneration: 'replacement',
        deadline: Date.now() + 5000,
      }),
    ).toBeNull();
    expect(
      await prepareCurrentAuthReceivingClosure({ pool: f.kernel }, barrier, { deadline: Date.now() + 5000 }),
    ).toBeNull();
    const tx = await f.kernel.connect();
    try {
      await tx.query('BEGIN');
      expect(
        await verifyCurrentAuthReceivingClosure(
          tx,
          barrier,
          {} as import('@rezics/auth-contract').CurrentAuthReceivingClosure,
        ),
      ).toBe(false);
    } finally {
      await tx.query('ROLLBACK');
      tx.release();
    }
    // Registration cannot promote itself, assert custody, or install a receipt.
    await expect(
      f.kernel.query(
        "UPDATE access.auth_receiving_control SET revision=revision+1,state='active' WHERE partition_no=$1",
        [partition],
      ),
    ).rejects.toThrow('Auth original physical-owner installation unavailable');
    await expect(
      f.kernel.query(
        `UPDATE access.auth_receiving_obligation SET custody_revision=2,physical_closure='untrusted',receiving_closure='untrusted'
       WHERE route=$1 AND account_id=$2`,
        [route, deleted.accountId],
      ),
    ).rejects.toThrow('Auth original physical receiving custody operation unavailable');
    await expect(
      f.kernel.query(
        `INSERT INTO access.auth_receiving_closure(route,account_id,control_revision,version,at,native_obligation_id,
       closure_receipt_id,physical_closure,receiving_closure)
       VALUES($1,$2,2,$3,$4,1,gen_random_uuid(),'untrusted','untrusted')`,
        [route, deleted.accountId, barrier.version, barrier.at],
      ),
    ).rejects.toThrow('Auth current receiving closure unavailable');
    const native = (
      await f.pool.query<{ id: string }>('SELECT id::text FROM auth_erasure WHERE account_id=$1', [deleted.accountId])
    ).rows[0];
    if (!native) throw new Error('Missing actual Auth obligation');
    expect(
      await ports.publishAuthReceivingClosure!({ barrier, nativeObligationId: native.id, deadline: Date.now() + 5000 }),
    ).toBe(false);
    // An actual ordinary sign-in retains its existing permissions. Receiving
    // unavailability cannot install a deployment-wide authentication fence.
    const living = await f.person('receiving-living');
    expect((await f.login(living)).accountId).toBe(living.accountId);
    expect(await ports.readAuthErasureBarrier!(deleted.accountId)).toEqual(barrier);
  } finally {
    await f.close();
  }
}, 120_000);

test('pending receiving registration rejects an incorrect native Source or barrier before conflict handling', async () => {
  const f = await nativeFixture();
  try {
    const deleted = await f.person('receiving-registration-source');
    expect((await f.delete(deleted)).status).toBe(200);
    const ports = f.bindings.trustedAccess;
    const barrier = await ports.readAuthErasureBarrier!(deleted.accountId);
    if (!barrier) throw new Error('Missing genuine native deletion barrier');
    const route = f.routeOf(deleted.accountId)!;
    const partition = Math.floor(route / 16);
    expect(
      (await f.kernel.query('SELECT access.initialize_auth_erasure_partition($1) AS ready', [partition])).rows[0]
        ?.ready,
    ).toBe(true);
    await expect(
      f.kernel.query(
        `INSERT INTO access.auth_receiving_control(partition_no,source_generation,source_epoch,source_owner)
         SELECT partition_no,generation,source_epoch+1,source_owner FROM access.auth_erasure_source
         WHERE partition_no=$1 ON CONFLICT DO NOTHING`,
        [partition],
      ),
    ).rejects.toThrow('Auth receiving registration Source mismatch');
    expect(await ports.registerAuthReceivingClosure!({ barrier, deadline: Date.now() + 5000 })).toEqual({
      state: 'pending',
      reason: 'physical-owner-unavailable',
    });
    await expect(
      f.kernel.query(
        `INSERT INTO access.auth_receiving_obligation(route,account_id,version,at,partition_no)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [route, deleted.accountId, barrier.version + 1, barrier.at, partition],
      ),
    ).rejects.toThrow('Auth receiving registration barrier mismatch');
    expect(await ports.registerAuthReceivingClosure!({ barrier, deadline: Date.now() + 5000 })).toEqual({
      state: 'pending',
      reason: 'physical-owner-unavailable',
    });
  } finally {
    await f.close();
  }
}, 120_000);
