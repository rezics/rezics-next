import { afterAll, beforeAll, expect, test } from 'bun:test';
import { acknowledgeErasure, ERASURE_PARTICIPANTS, readErasureStatus } from '../../src/access/index.ts';
import {
  createLifecycleCommands,
  createLifecycleInternals,
  LIFECYCLE_ACTIONS,
  LifecycleDeniedError,
  REGISTRATION_TTL_MS,
} from '../../src/access/lifecycle.ts';
import { createPool } from '../../src/database/pool.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { openGrowthDatabase } from '../support/growth.ts';

let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
const at = new Date();
const completedAt = new Date(at.getTime() + 1000);
const ids = ERASURE_PARTICIPANTS[1];
const key = () => Bun.randomUUIDv7();
const commands = () => createLifecycleCommands({ pool: db.pool, access, clock: () => at });
const ack = (accountId: string, participant: string, outcome: 'erased' | 'none' = 'erased') =>
  acknowledgeErasure({ pool: db.pool, clock: () => completedAt }, { accountId, participant, outcome });
const status = (accountId: string) => readErasureStatus(db.pool, accountId);
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});

async function person(operator: string | null = null) {
  const accountId = newId(0x7351);
  await db.admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,operator_account_id,transaction_id)
     VALUES($1,$2,'actor','active',$3,$2)`,
    [routeOf(accountId), accountId, operator],
  );
  await db.admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     SELECT $1,$2,$2,action,'(,)'::tstzrange,$2
     FROM unnest(ARRAY['account:read','account:update','account:delete','account:manage']) AS action`,
    [routeOf(accountId), accountId],
  );
  return accountId;
}
async function context(accountId: string) {
  const actor = await authenticateAccount(
    access,
    { pool: db.pool, deadline: Date.now() + 10000 },
    {
      accountId,
      clientId: 'erasure-coordinator-test',
      scopes: [...LIFECYCLE_ACTIONS.keys()],
    },
  );
  return { actor, deadline: Date.now() + 10000 };
}
async function deleted() {
  const accountId = await person();
  const tombstone = await commands().tombstone(await context(accountId), { accountId, key: key() });
  return { accountId, tombstone };
}
async function assertRecord(accountId: string, transactionId: string) {
  const rows = await db.admin.query(
    `SELECT e.route,e.version,e.at,a.state,a.transaction_id,e.xmin::text AS erasure_tx,a.xmin::text AS account_tx
     FROM access.erasure e JOIN access.account a USING(route,account_id)
     WHERE e.route=$1 AND e.account_id=$2`,
    [routeOf(accountId), accountId],
  );
  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0]).toMatchObject({
    route: routeOf(accountId),
    version: 1,
    at,
    state: 'deleted',
    transaction_id: transactionId,
  });
  expect(rows.rows[0].erasure_tx).toBe(rows.rows[0].account_tx);
  expect(await status(accountId)).toEqual({
    version: 1,
    at: at.toISOString(),
    participants: Object.fromEntries(ids.map((id) => [id, 'pending'])),
    completedAt: null,
  });
}

test('the versioned participant list is exactly the fixed owner set', () => {
  expect(ids).toEqual([
    'access',
    'auth',
    'library',
    'commerce',
    'content',
    'community',
    'semantic',
    'search',
    'imports',
    'shared-history',
    'delivery',
  ]);
  expect(Object.isFrozen(ERASURE_PARTICIPANTS)).toBe(true);
  expect(Object.isFrozen(ids)).toBe(true);
});

for (const continuation of [false, true]) {
  test(`person tombstone ${continuation ? 'with' : 'without'} continuation records version and T in its own transaction`, async () => {
    const accountId = await person();
    const result = await commands().tombstone(await context(accountId), {
      accountId,
      key: key(),
      ...(continuation
        ? {
            continuation: {
              operationKey: key(),
              operationDigest: 'a'.repeat(64),
              commandKeyPrefix: `wf:${'b'.repeat(64)}`,
            },
          }
        : {}),
    });
    expect(result.partition).toBe(partitionOf(routeOf(accountId)!));
    await assertRecord(accountId, result.transactionId);
  });
}

test('operator-managed and organization tombstones use the same record barrier, including replay', async () => {
  const owner = await person();
  const bot = await person(owner);
  const ctx = await context(owner);
  const request = { accountId: bot, key: key() };
  const result = await commands().tombstone(ctx, request);
  await assertRecord(bot, result.transactionId);
  expect((await commands().tombstone(ctx, request)).replayed).toBe(true);
  await assertRecord(bot, result.transactionId);

  const internal = createLifecycleInternals({
    pool: db.pool,
    routeKey: new Uint8Array(32),
    clock: () => at,
    provisioningEvidence: async () => null,
    recoveryEvidence: async () => null,
  });
  const organizationId = newId(0x7371);
  const hold = await internal.reserveCoordination({
    accountId: owner,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: key(),
  });
  await internal.createOrganization({
    organizationId,
    ownerAccountId: owner,
    ownerReservationId: hold.value.reservationId,
    key: key(),
  });
  const closed = await commands().tombstone(await context(owner), { accountId: organizationId, key: key() });
  await assertRecord(organizationId, closed.transactionId);
});

test('a failed erasure insert rolls back both the tombstone and event; a fence creates no erasure', async () => {
  const accountId = await person();
  await db.admin.query(`CREATE FUNCTION public.reject_erasure_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'test erasure insert failure'; END; $$`);
  await db.admin.query(`CREATE TRIGGER reject_erasure_insert AFTER INSERT ON access.erasure
    FOR EACH ROW WHEN (NEW.account_id = '${accountId}'::uuid) EXECUTE FUNCTION public.reject_erasure_insert()`);
  try {
    await expect(commands().tombstone(await context(accountId), { accountId, key: key() })).rejects.toThrow(
      'test erasure insert failure',
    );
    expect(await status(accountId)).toBeNull();
    expect(
      (
        await db.admin.query('SELECT state FROM access.account WHERE route=$1 AND account_id=$2', [
          routeOf(accountId),
          accountId,
        ])
      ).rows[0].state,
    ).toBe('active');
    expect((await db.admin.query('SELECT 1 FROM core.outbox WHERE subject=$1', [accountId])).rows).toHaveLength(0);
  } finally {
    await db.admin.query('DROP TRIGGER reject_erasure_insert ON access.erasure');
    await db.admin.query('DROP FUNCTION public.reject_erasure_insert()');
  }
  const internal = createLifecycleInternals({
    pool: db.pool,
    routeKey: new Uint8Array(32),
    provisioningEvidence: async () => null,
    recoveryEvidence: async () => null,
  });
  await internal.raiseFence({ accountId, key: key() });
  expect(await status(accountId)).toBeNull();
});

test('pending registration expiry does not create an erasure obligation', async () => {
  let now = at;
  const internal = createLifecycleInternals({
    pool: db.pool,
    routeKey: new Uint8Array(32),
    clock: () => now,
    provisioningEvidence: async () => null,
    recoveryEvidence: async () => null,
  });
  const accountId = newId(0x7351);
  const handle = `erasure_expiry_${key().slice(0, 8)}`;
  const reservation = await internal.reserveHandle({ accountId, handle, key: key() });
  const reservationId = reservation.value.reservationId;
  await internal.createPending({ accountId, handle, reservationId, key: key() });
  now = new Date(at.getTime() + REGISTRATION_TTL_MS + 1);
  await internal.expireRegistration({ accountId, handle, reservationId, key: key() });
  expect(await status(accountId)).toBeNull();
  await expect(ack(accountId, 'access')).rejects.toBeInstanceOf(LifecycleDeniedError);
});

test('each acknowledgement commits separately in the account partition and completion waits for every recorded participant', async () => {
  const { accountId, tombstone } = await deleted();
  const transactions = new Set([tombstone.transactionId]);
  for (const [index, participant] of ids.entries()) {
    const outcome = index % 2 === 0 ? 'erased' : 'none';
    const before = await status(accountId);
    expect(before?.completedAt).toBeNull();
    const result = await ack(accountId, participant, outcome);
    expect(result.partition).toBe(tombstone.partition);
    expect(transactions.has(result.transactionId)).toBe(false);
    transactions.add(result.transactionId);
    const stored = await db.admin.query(
      `SELECT a.xmin::text AS ack_tx,e.xmin::text AS erasure_tx,
      o.xmin::text AS event_tx,b.principal_id,b.client_id,b.requested_by
      FROM access.erasure_acknowledgement a JOIN access.erasure e USING(route,account_id)
      JOIN editorial.write_basis b ON b.partition_no=$3 AND b.transaction_id=$4
      JOIN core.outbox o ON o.partition_no=b.partition_no AND o.position=b.position
      WHERE a.route=$1 AND a.account_id=$2 AND a.participant=$5`,
      [routeOf(accountId), accountId, result.partition, result.transactionId, participant],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0].ack_tx).toBe(stored.rows[0].event_tx);
    expect(stored.rows[0]).toMatchObject({
      principal_id: '00000000-0000-8000-8000-000000000001',
      client_id: 'internal-access',
      requested_by: null,
    });
    const after = await status(accountId);
    expect(after?.participants[participant]).toBe(outcome);
    expect(after?.completedAt).toBe(index === ids.length - 1 ? completedAt.toISOString() : null);
    if (index === ids.length - 1) expect(stored.rows[0].erasure_tx).toBe(stored.rows[0].ack_tx);
    const duplicate = await ack(accountId, participant, outcome);
    expect(duplicate.position).toBe(result.position);
    expect(await status(accountId)).toEqual(after);
  }
});

test('unknown participants, missing erasures and differing outcomes are refused without changing status', async () => {
  const { accountId } = await deleted();
  await ack(accountId, 'access', 'none');
  const before = await status(accountId);
  for (const participant of ['unknown', '__proto__', 'constructor']) {
    await expect(ack(accountId, participant)).rejects.toBeInstanceOf(LifecycleDeniedError);
  }
  await expect(ack(accountId, 'access', 'erased')).rejects.toBeInstanceOf(LifecycleDeniedError);
  expect(await status(accountId)).toEqual(before);
  for (const missing of [await person(), newId(0x7351)]) {
    expect(await status(missing)).toBeNull();
    await expect(ack(missing, 'access')).rejects.toBeInstanceOf(LifecycleDeniedError);
  }
});

test('a failed final acknowledgement rolls back its outcome and completion together', async () => {
  const { accountId } = await deleted();
  for (const participant of ids.slice(0, -1)) await ack(accountId, participant, 'none');
  const before = await status(accountId);
  await db.admin.query(`CREATE FUNCTION public.reject_erasure_event() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'test acknowledgement commit failure'; END; $$`);
  await db.admin.query(`CREATE TRIGGER reject_erasure_event BEFORE INSERT ON core.outbox
    FOR EACH ROW WHEN (NEW.subject = '${accountId}') EXECUTE FUNCTION public.reject_erasure_event()`);
  try {
    await expect(ack(accountId, 'delivery', 'none')).rejects.toThrow('test acknowledgement commit failure');
    expect(await status(accountId)).toEqual(before);
  } finally {
    await db.admin.query('DROP TRIGGER reject_erasure_event ON core.outbox');
    await db.admin.query('DROP FUNCTION public.reject_erasure_event()');
  }
  await ack(accountId, 'delivery', 'none');
  expect((await status(accountId))?.completedAt).toBe(completedAt.toISOString());
});

test('concurrent final acknowledgements complete once and event replay cannot reopen completion after history is removed', async () => {
  const accountId = await person(await person());
  const operator = (
    await db.admin.query('SELECT operator_account_id FROM access.account WHERE route=$1 AND account_id=$2', [
      routeOf(accountId),
      accountId,
    ])
  ).rows[0].operator_account_id;
  const ctx = await context(operator);
  const request = { accountId, key: key() };
  await commands().tombstone(ctx, request);
  for (const id of ids.slice(0, -2)) await ack(accountId, id, 'none');
  const otherPool = createPool(db.url);
  try {
    await Promise.all([
      ack(accountId, ids.at(-2)!, 'none'),
      acknowledgeErasure(
        { pool: otherPool, clock: () => completedAt },
        { accountId, participant: ids.at(-1)!, outcome: 'none' },
      ),
    ]);
  } finally {
    await otherPool.end();
  }
  const before = await status(accountId);
  expect(before?.completedAt).toBe(completedAt.toISOString());
  expect((await commands().tombstone(ctx, request)).replayed).toBe(true);
  // The permanent acknowledgements, rather than a receipt/history cache, decide replay.
  await db.admin.query('DELETE FROM core.receipt WHERE partition_no=$1 AND command_kind=$2', [
    partitionOf(routeOf(accountId)!),
    'access.account-updated',
  ]);
  for (const id of ids) await ack(accountId, id, 'none');
  expect(await status(accountId)).toEqual(before);
  await expect(ack(accountId, 'auth', 'erased')).rejects.toBeInstanceOf(LifecycleDeniedError);
  await expect(
    db.admin.query('UPDATE access.erasure SET completed_at=NULL WHERE route=$1 AND account_id=$2', [
      routeOf(accountId),
      accountId,
    ]),
  ).rejects.toThrow('cannot reopen');
  for (const change of ['version=2', "at=at-interval '1 second'"]) {
    await expect(
      db.admin.query(`UPDATE access.erasure SET ${change} WHERE route=$1 AND account_id=$2`, [
        routeOf(accountId),
        accountId,
      ]),
    ).rejects.toThrow('cannot reopen');
  }
  await expect(
    db.admin.query('DELETE FROM access.erasure_acknowledgement WHERE route=$1 AND account_id=$2', [
      routeOf(accountId),
      accountId,
    ]),
  ).rejects.toThrow('immutable');
  expect(await status(accountId)).toEqual(before);
});
