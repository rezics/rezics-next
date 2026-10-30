import { expect, test } from 'bun:test';
import type { AuthErasureObligation, AuthErasureObligationCursor } from '@rezics/auth-contract';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { createAuthErasureObligationBindings } from '../../src/access/auth-erasure-obligations.ts';
import { createAuthHistoryProofBindings } from '../../src/access/shared-history-auth.ts';
import { createLifecycleCommands, LIFECYCLE_ACTIONS } from '../../src/access/lifecycle.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { openGrowthDatabase } from '../support/growth.ts';

type Fixture = Awaited<ReturnType<typeof openGrowthDatabase>>;
const deadline = () => Date.now() + 10000;
async function person(db: Fixture, route: number) {
  const accountId = newId(route);
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
     VALUES($1,$2,'actor','active',$2)`,
    [route, accountId],
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES($1,$2,$2,'account:delete','(,)'::tstzrange,$2)`,
    [route, accountId],
  );
  return accountId;
}
async function erase(db: Fixture, accountId: string) {
  const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
  const actor = await authenticateAccount(
    access,
    { pool: db.pool, deadline: deadline() },
    {
      accountId,
      clientId: 'auth-obligation-test',
      scopes: [...LIFECYCLE_ACTIONS.keys()],
    },
  );
  return createLifecycleCommands({ pool: db.pool, access }).tombstone(
    { actor, deadline: deadline() },
    { accountId, key: Bun.randomUUIDv7() },
  );
}

test('Trusted Auth restore reconciliation discovers exact committed Access erasure obligations absent from an old Auth snapshot using native bounded partition-led sealed feed and exact immutable source floor without scanning living accounts or acknowledging cleanup', async () => {
  const db = await openGrowthDatabase();
  try {
    const accountId = await person(db, 0);
    const living = await person(db, 16);
    const native = await erase(db, accountId);
    const ports = createAuthBindings({ pool: db.pool, ...createAuthHistoryProofBindings(db.pool) });
    const original = await ports.readAuthErasureObligation({ accountId, deadline: deadline() });
    expect(original.state).toBe('ready');
    if (original.state !== 'ready') throw new Error('Missing native obligation');
    expect(original.obligation).toMatchObject({
      route: 0,
      accountId,
      version: 1,
      receiptId: native.value.receiptId,
      minimumAuthnEpoch: native.value.minimumAuthnEpoch,
    });
    expect(original.obligation.at).toBe((await ports.readAuthErasureBarrier(accountId))!.at);
    expect(await ports.readAuthErasureSource({ accountId, receiptId: native.value.receiptId })).toBeNull();
    // Later native floors cannot relabel the original tombstone floor.
    await db.admin.query(
      'UPDATE access.account SET minimum_authn_epoch=minimum_authn_epoch+7 WHERE route=0 AND account_id=$1',
      [accountId],
    );
    expect(await ports.readAuthErasureObligation({ accountId, deadline: deadline() })).toEqual(original);
    expect(await ports.readAuthErasureObligation({ accountId: living, deadline: deadline() })).toEqual({
      state: 'absent',
    });
    const cutId = crypto.randomUUID();
    const initial = await ports.startAuthErasureObligationCut({ cutId, deadline: deadline() });
    expect(await ports.startAuthErasureObligationCut({ cutId, deadline: deadline() })).toEqual(initial);
    expect((await ports.verifyAuthErasureObligationCut({ cutId, partition: 0, deadline: deadline() })).state).toBe(
      'pending',
    );
    let cursor: AuthErasureObligationCursor | null = { partition: 0, afterOrdinal: '0' };
    const recovered: AuthErasureObligation[] = [];
    while (cursor) {
      const page = await ports.pageAuthErasureObligations({ cutId, cursor, deadline: deadline() });
      expect(page.obligations.length).toBeLessThanOrEqual(48);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(65536);
      expect(page.pending).toEqual([]);
      expect(page.state).toBe('partition-end');
      recovered.push(...page.obligations);
      if (page.next) expect(page.next.partition).toBe(cursor.partition + 1);
      cursor = page.next;
    }
    expect(recovered).toEqual([original.obligation]);
    expect(await ports.verifyAuthErasureObligationCut({ cutId, partition: 0, deadline: deadline() })).toMatchObject({
      state: 'current',
      highWater: original.obligation.ordinal,
      sourceEpoch: 1,
      sourceOwner: 'b',
    });
    // Cut exhaustion is not an ACK or a history/native cleanup proof.
    expect(
      (
        await db.admin.query('SELECT 1 FROM access.erasure_acknowledgement WHERE route=0 AND account_id=$1', [
          accountId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (await db.admin.query('SELECT 1 FROM access.auth_history_proof WHERE route=0 AND account_id=$1', [accountId]))
        .rowCount,
    ).toBe(0);
    const later = await person(db, 0);
    await erase(db, later);
    expect((await ports.verifyAuthErasureObligationCut({ cutId, partition: 0, deadline: deadline() })).state).toBe(
      'pending',
    );
    const replay = await ports.pageAuthErasureObligations({
      cutId,
      cursor: { partition: 0, afterOrdinal: '0' },
      deadline: deadline(),
    });
    expect(replay.obligations).toEqual([original.obligation]);
    const laterPoint = await ports.readAuthErasureObligation({ accountId: later, deadline: deadline() });
    expect(laterPoint.state).toBe('ready');
    if (laterPoint.state === 'ready')
      expect(BigInt(laterPoint.obligation.ordinal)).toBeGreaterThan(BigInt(original.obligation.ordinal));
    await expect(
      ports.pageAuthErasureObligations({ cutId, cursor: { partition: 0, afterOrdinal: '999' }, deadline: deadline() }),
    ).rejects.toThrow();
    await expect(ports.readAuthErasureObligation({ accountId, deadline: Date.now() - 1 })).rejects.toThrow();
    await db.admin.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=0');
    expect((await ports.verifyAuthErasureObligationCut({ cutId, partition: 0, deadline: deadline() })).state).toBe(
      'pending',
    );
    expect(await ports.readAuthErasureObligation({ accountId, deadline: deadline() })).toMatchObject({
      state: 'pending',
      reason: 'source-unavailable',
    });
  } finally {
    await db.close();
  }
}, 120000);

test('historical bootstrap drains at most 48 native roots and retains exact missing original floors as pending', async () => {
  const db = await openGrowthDatabase();
  try {
    // Simulate genuine rows committed before feed installation, preserving native
    // tombstone receipts. Only the new producer is disabled in this isolated fixture.
    await db.admin.query('ALTER TABLE access.erasure DISABLE TRIGGER auth_erasure_producer');
    const ids: string[] = [];
    try {
      for (let i = 0; i < 49; i++) {
        const id = await person(db, 0);
        await erase(db, id);
        ids.push(id);
      }
    } finally {
      await db.admin.query('ALTER TABLE access.erasure ENABLE TRIGGER auth_erasure_producer');
    }
    // An old floor can be recovered only from its retained native tombstone
    // receipt, never this unrelated later current floor.
    await db.admin.query('UPDATE access.account SET minimum_authn_epoch=99 WHERE route=0');
    const ports = createAuthErasureObligationBindings(db.pool);
    const cutId = crypto.randomUUID();
    await ports.startAuthErasureObligationCut({ cutId, deadline: deadline() });
    const cursor = { partition: 0, afterOrdinal: '0' };
    const first = await ports.pageAuthErasureObligations({ cutId, cursor, deadline: deadline() });
    expect(first).toMatchObject({ state: 'initializing', next: cursor, obligations: [] });
    expect((await db.admin.query('SELECT 1 FROM access.auth_erasure_obligation WHERE partition_no=0')).rowCount).toBe(
      48,
    );
    const page = await ports.pageAuthErasureObligations({ cutId, cursor, deadline: deadline() });
    expect(page.obligations).toHaveLength(48);
    expect(page.obligations.every((o) => o.minimumAuthnEpoch === '2')).toBe(true);
    expect(page.state).toBe('page');
    const tail = await ports.pageAuthErasureObligations({ cutId, cursor: page.next!, deadline: deadline() });
    expect(tail.obligations).toHaveLength(1);
    expect(new Set([...page.obligations, ...tail.obligations].map((o) => o.accountId))).toEqual(new Set(ids));
    const missing = await person(db, 16);
    const client = await db.admin.connect();
    try {
      await client.query('BEGIN');
      await client.query('ALTER TABLE access.erasure DISABLE TRIGGER auth_erasure_producer');
      await client.query(
        "UPDATE access.account SET state='deleted',authn_fenced=true,minimum_authn_epoch=123 WHERE route=16 AND account_id=$1",
        [missing],
      );
      await client.query('INSERT INTO access.erasure(route,account_id,version,at) VALUES(16,$1,1,clock_timestamp())', [
        missing,
      ]);
      await client.query('ALTER TABLE access.erasure ENABLE TRIGGER auth_erasure_producer');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const pending = await ports.pageAuthErasureObligations({ cutId, cursor: tail.next!, deadline: deadline() });
    expect(pending).toMatchObject({
      state: 'pending',
      obligations: [],
      cut: { sealedPartitions: 1 },
      pending: [{ accountId: missing, reason: 'original-floor-unavailable' }],
    });
    expect(await ports.readAuthErasureObligation({ accountId: missing, deadline: deadline() })).toMatchObject({
      state: 'pending',
      reason: 'original-floor-unavailable',
    });
    expect((await ports.verifyAuthErasureObligationCut({ cutId, partition: 1, deadline: deadline() })).state).toBe(
      'pending',
    );
    await expect(
      db.admin.query(
        'UPDATE access.auth_erasure_obligation SET minimum_authn_epoch=123 WHERE route=16 AND account_id=$1',
        [missing],
      ),
    ).rejects.toThrow();
  } finally {
    await db.close();
  }
}, 120000);
