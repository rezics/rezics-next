import { expect, test } from 'bun:test';
import type { AuthErasureLiveReceiver } from '@rezics/auth-contract';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { createAuthErasureLiveBindings } from '../../src/access/auth-erasure-live.ts';
import { createAuthErasureObligationBindings } from '../../src/access/auth-erasure-obligations.ts';
import { createLifecycleCommands, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { newId } from '../../src/route/route.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { openGrowthDatabase } from '../support/growth.ts';

type Fixture = Awaited<ReturnType<typeof openGrowthDatabase>>;
const deadline = () => Date.now() + 10000;
async function person(db: Fixture, route = 0) {
  const id = newId(route);
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
    VALUES($1,$2,'actor','active',$2)`,
    [route, id],
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES($1,$2,$2,'account:delete','(,)'::tstzrange,$2)`,
    [route, id],
  );
  return id;
}
async function erase(db: Fixture, accountId: string, key = Bun.randomUUIDv7()) {
  const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
  const actor = await authenticateAccount(
    access,
    { pool: db.pool, deadline: deadline() },
    {
      accountId,
      clientId: 'auth-live-test',
      scopes: [...LIFECYCLE_ACTIONS.keys()],
    },
  );
  return createLifecycleCommands({ pool: db.pool, access }).tombstone(
    { actor, deadline: deadline() },
    { accountId, key },
  );
}
async function cut(db: Fixture, partitions = 1): Promise<AuthErasureLiveReceiver> {
  const finite = createAuthErasureObligationBindings(db.pool);
  const cutId = crypto.randomUUID();
  await finite.startAuthErasureObligationCut({ cutId, deadline: deadline() });
  for (let partition = 0; partition < partitions; partition++) {
    let cursor = { partition, afterOrdinal: '0' };
    for (;;) {
      const page = await finite.pageAuthErasureObligations({ cutId, cursor, deadline: deadline() });
      expect(['page', 'partition-end']).toContain(page.state);
      if (page.state === 'partition-end') break;
      cursor = page.next!;
    }
  }
  return {
    cutId,
    authGeneration: 'restored-auth-generation',
    databaseIdentity: 'verified-auth-database',
    inventoryEntry: 'auth-primary',
    inventoryVersion: 'inventory-v1',
  };
}

test('Native Access live Auth obligation handoff', async () => {
  const db = await openGrowthDatabase();
  try {
    const original = await person(db);
    const native = await erase(db, original);
    const receiver = await cut(db);
    const ports = createAuthBindings({ pool: db.pool, authErasureLiveReceiver: receiver });
    const request = { partition: 0, deadline: deadline() };
    expect(await ports.verifyAuthErasureLivePartition(request)).toMatchObject({
      state: 'pending',
      reason: 'receiver-unavailable',
    });
    const between = await person(db);
    await erase(db, between);
    const racing = await person(db);
    // Either native lock order must cover the confirmation, with no cut/tail gap.
    const [armed] = await Promise.all([
      ports.armAuthErasureLivePartition({ partition: 0, deadline: deadline() }),
      erase(db, racing),
    ]);
    expect(armed).toMatchObject({ state: 'armed', receiver, highWater: '1', sourceEpoch: 1, sourceOwner: 'b' });
    const tailIds = [between, racing];
    for (let i = 0; i < 47; i++) {
      const id = await person(db);
      await erase(db, id);
      tailIds.push(id);
    }
    // A fresh producer closure models receiver retry/restart: no new subscription
    // identity, changed original arm frontier, consumed cursor or source ACK.
    const restarted = createAuthErasureLiveBindings(db.pool, { ...receiver });
    const again = await restarted.armAuthErasureLivePartition({ partition: 0, deadline: deadline() });
    expect(again).toMatchObject({ state: 'armed', armHighWater: armed.armHighWater, enrolledThrough: '50' });
    const first = await restarted.readAuthErasureLivePage({
      cursor: { partition: 0, afterOrdinal: '1' },
      deadline: deadline(),
    });
    expect(first.state).toBe('page');
    expect(first.obligations).toHaveLength(48);
    expect(first.pending).toEqual([]);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(65536);
    expect(first.obligations.every((o) => Buffer.byteLength(JSON.stringify(o)) <= 1024)).toBe(true);
    const last = await restarted.readAuthErasureLivePage({ cursor: first.next, deadline: deadline() });
    expect(last.state).toBe('tail-end');
    expect(new Set([...first.obligations, ...last.obligations].map((o) => o.accountId))).toEqual(new Set(tailIds));
    expect(await restarted.readAuthErasureLivePage({ cursor: first.cursor, deadline: deadline() })).toEqual(first);
    const end = await restarted.readAuthErasureLivePage({ cursor: last.next, deadline: deadline() });
    expect(end).toMatchObject({ state: 'tail-end', obligations: [], next: last.next });
    const later = await person(db);
    await erase(db, later);
    const advanced = await restarted.readAuthErasureLivePage({ cursor: end.next, deadline: deadline() });
    expect(advanced.obligations.map((o) => o.accountId)).toEqual([later]);
    expect(await restarted.verifyAuthErasureLivePartition({ partition: 0, deadline: deadline() })).toMatchObject({
      state: 'current',
      highWater: '1',
      enrolledThrough: '51',
    });
    // Original finite cut and original tombstone tuple never become a live ACK.
    const finite = createAuthErasureObligationBindings(db.pool);
    const replay = await finite.pageAuthErasureObligations({
      cutId: receiver.cutId,
      cursor: { partition: 0, afterOrdinal: '0' },
      deadline: deadline(),
    });
    expect(replay.obligations).toMatchObject([
      {
        accountId: original,
        receiptId: native.value.receiptId,
        minimumAuthnEpoch: native.value.minimumAuthnEpoch,
        version: 1,
        ordinal: '1',
      },
    ]);
    expect(
      (await finite.verifyAuthErasureObligationCut({ cutId: receiver.cutId, partition: 0, deadline: deadline() }))
        .state,
    ).toBe('pending');
    expect((await db.admin.query('SELECT 1 FROM access.erasure_acknowledgement WHERE route=0')).rowCount).toBe(0);
    expect((await db.admin.query('SELECT 1 FROM access.auth_history_proof WHERE route=0')).rowCount).toBe(0);
    expect((await db.admin.query('SELECT 1 FROM access.auth_erasure_obligation WHERE partition_no=0')).rowCount).toBe(
      51,
    );
    for (const changed of [
      { authGeneration: 'other' },
      { databaseIdentity: 'other' },
      { inventoryEntry: 'other' },
      { inventoryVersion: 'other' },
    ]) {
      const invalid = createAuthErasureLiveBindings(db.pool, { ...receiver, ...changed });
      await expect(invalid.armAuthErasureLivePartition({ partition: 0, deadline: deadline() })).rejects.toThrow(
        'binding changed',
      );
      await expect(invalid.verifyAuthErasureLivePartition({ partition: 0, deadline: deadline() })).rejects.toThrow(
        'binding changed',
      );
    }
    await expect(
      restarted.readAuthErasureLivePage({ cursor: { partition: 0, afterOrdinal: '0' }, deadline: deadline() }),
    ).rejects.toThrow();
    await expect(
      restarted.readAuthErasureLivePage({ cursor: { partition: 0, afterOrdinal: '999' }, deadline: deadline() }),
    ).rejects.toThrow();
    await expect(
      restarted.verifyAuthErasureLivePartition({ partition: 0, deadline: Date.now() - 1 }),
    ).rejects.toThrow();
    await expect(db.admin.query('DELETE FROM access.auth_erasure_live_subscription')).rejects.toThrow();
    await expect(
      db.admin.query("UPDATE access.auth_erasure_live_receiver SET auth_generation='other'"),
    ).rejects.toThrow();
    await expect(db.admin.query('UPDATE access.auth_erasure_live_partition SET enrolled_through=0')).rejects.toThrow();
  } finally {
    await db.close();
  }
}, 120000);

test('live lineage changes remain pending while other partitions and native deletion progress', async () => {
  const db = await openGrowthDatabase();
  try {
    const receiver = await cut(db, 3);
    const live = createAuthErasureLiveBindings(db.pool, receiver);
    await live.armAuthErasureLivePartition({ partition: 1, deadline: deadline() });
    await live.armAuthErasureLivePartition({ partition: 2, deadline: deadline() });
    const lock = await db.pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT partition_no FROM core.partition WHERE partition_no=1 FOR UPDATE');
      // Partition 2 has no dependency on a held partition 1 or a global cut lock.
      expect((await live.verifyAuthErasureLivePartition({ partition: 2, deadline: deadline() })).state).toBe('current');
      const independent = await person(db, 32);
      await erase(db, independent);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
    for (const change of ['epoch=epoch+1', "node='moved-source'"]) {
      await db.admin.query(`UPDATE core.partition SET ${change} WHERE partition_no=1`);
      const later = await person(db, 16);
      await erase(db, later);
      expect(await live.verifyAuthErasureLivePartition({ partition: 1, deadline: deadline() })).toMatchObject({
        state: 'pending',
        reason: 'source-unavailable',
        sourceEpoch: 1,
        sourceOwner: 'b',
      });
      expect(await live.armAuthErasureLivePartition({ partition: 1, deadline: deadline() })).toMatchObject({
        state: 'pending',
        reason: 'source-unavailable',
      });
      expect(
        await live.readAuthErasureLivePage({ cursor: { partition: 1, afterOrdinal: '0' }, deadline: deadline() }),
      ).toMatchObject({ state: 'pending', obligations: [], next: { partition: 1, afterOrdinal: '0' } });
    }
    expect(await live.verifyAuthErasureLivePartition({ partition: 2, deadline: deadline() })).toMatchObject({
      state: 'current',
      enrolledThrough: '1',
    });
    expect(
      (
        await db.admin.query(
          'SELECT lineage_valid,enrolled_through::text FROM access.auth_erasure_live_partition WHERE partition_no=1',
        )
      ).rows[0],
    ).toEqual({ lineage_valid: false, enrolled_through: '2' });
  } finally {
    await db.close();
  }
}, 120000);

test('native rollback cannot advance enrollment and legacy unknown floors stay precisely pending', async () => {
  const db = await openGrowthDatabase();
  try {
    const receiver = await cut(db);
    const live = createAuthErasureLiveBindings(db.pool, receiver);
    const armed = await live.armAuthErasureLivePartition({ partition: 0, deadline: deadline() });
    const baseline = armed.enrolledThrough!;
    const committed = String(BigInt(baseline) + 1n);
    const unknownHead = String(BigInt(baseline) + 2n);
    const id = await person(db);
    const key = Bun.randomUUIDv7();
    await db.admin.query(`CREATE FUNCTION access.reject_live_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'native rollback fixture'; END; $$;
      CREATE TRIGGER zz_reject_live_fixture AFTER INSERT ON access.auth_erasure_obligation
      FOR EACH ROW EXECUTE FUNCTION access.reject_live_fixture()`);
    try {
      await expect(erase(db, id, key)).rejects.toThrow('native rollback fixture');
    } finally {
      await db.admin.query(
        'DROP TRIGGER zz_reject_live_fixture ON access.auth_erasure_obligation; DROP FUNCTION access.reject_live_fixture()',
      );
    }
    expect(await live.verifyAuthErasureLivePartition({ partition: 0, deadline: deadline() })).toMatchObject({
      state: 'current',
      enrolledThrough: baseline,
    });
    expect((await db.admin.query('SELECT 1 FROM access.erasure WHERE route=0 AND account_id=$1', [id])).rowCount).toBe(
      0,
    );
    await erase(db, id, key);
    expect(await live.verifyAuthErasureLivePartition({ partition: 0, deadline: deadline() })).toMatchObject({
      state: 'current',
      enrolledThrough: committed,
    });
    // Historical input only: a tombstone without a native original receipt. No
    // current floor, invented receipt or direct enrollment can repair its provenance.
    const unknown = await person(db);
    await db.admin.query(
      "UPDATE access.account SET state='deleted',authn_fenced=true,minimum_authn_epoch=123 WHERE route=0 AND account_id=$1",
      [unknown],
    );
    await db.admin.query('INSERT INTO access.erasure(route,account_id) VALUES(0,$1)', [unknown]);
    expect(await live.verifyAuthErasureLivePartition({ partition: 0, deadline: deadline() })).toMatchObject({
      state: 'pending',
      reason: 'original-floor-unavailable',
      enrolledThrough: unknownHead,
    });
    const page = await live.readAuthErasureLivePage({
      cursor: { partition: 0, afterOrdinal: committed },
      deadline: deadline(),
    });
    expect(page).toMatchObject({
      state: 'pending',
      obligations: [],
      pending: [{ accountId: unknown, version: 1, reason: 'original-floor-unavailable' }],
      next: { partition: 0, afterOrdinal: committed },
    });
    const otherCut = await cut(db, 0);
    expect(
      await createAuthErasureLiveBindings(db.pool, otherCut).armAuthErasureLivePartition({
        partition: 0,
        deadline: deadline(),
      }),
    ).toMatchObject({ state: 'pending', reason: 'cut-unavailable' });
    await expect(
      db.admin.query('UPDATE access.auth_erasure_obligation SET minimum_authn_epoch=123 WHERE account_id=$1', [
        unknown,
      ]),
    ).rejects.toThrow();
  } finally {
    await db.close();
  }
}, 120000);
