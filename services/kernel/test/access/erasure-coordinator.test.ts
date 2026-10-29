import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  acknowledgeErasure,
  ERASURE_PARTICIPANTS,
  readErasureStatus,
  resolveRetention,
  type RetentionException,
} from '../../src/access/index.ts';
import {
  createLifecycleCommands,
  createLifecycleInternals,
  LIFECYCLE_ACTIONS,
  LifecycleDeniedError,
  REGISTRATION_TTL_MS,
} from '../../src/access/lifecycle.ts';
import { advanceErasureCompletion } from '../../src/access/erasure.ts';
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
async function frontierDelivered(accountId: string) {
  // This coordinator fixture has no effects. Model their delivered checkpoint before acknowledging.
  await db.admin.query(`INSERT INTO core.consumer_checkpoint(partition_no,consumer,epoch,position)
    SELECT partition_no,'effects',CASE WHEN position=0 THEN NULL ELSE epoch END,position FROM core.partition
    ON CONFLICT(partition_no,consumer) DO UPDATE SET epoch=excluded.epoch,position=excluded.position`);
  await advanceErasureCompletion({ pool: db.pool, clock: () => completedAt }, accountId);
}
const ack = async (accountId: string, participant: string, outcome: 'erased' | 'none' = 'erased') => {
  if (await status(accountId)) await frontierDelivered(accountId);
  return acknowledgeErasure({ pool: db.pool, clock: () => completedAt }, { accountId, participant, outcome });
};
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
  await frontierDelivered(accountId);
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
    state: 'pending',
    participants: Object.fromEntries(ids.map((id) => [id, { outcome: 'pending', retained: [] }])),
    outstanding: { lateItems: false, effectsFrontier: true },
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
    expect(after?.participants[participant]).toEqual({ outcome, retained: [] });
    expect(after?.state).toBe(index === ids.length - 1 ? 'complete' : 'pending');
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

const retention = (overrides: Partial<RetentionException> = {}): RetentionException => ({
  store: 'moderation',
  fields: ['reporter', 'decision'],
  purpose: 'Appeal evidence',
  expiresAt: new Date(at.getTime() + 1),
  ...overrides,
});
const retain = (accountId: string, retained: readonly RetentionException[], outcome: 'erased' | 'none' = 'erased') =>
  acknowledgeErasure(
    { pool: db.pool, clock: () => completedAt },
    { accountId, participant: 'content', outcome, retained },
  );
const resolve = (accountId: string, store = 'moderation', participant = 'content', now = completedAt) =>
  resolveRetention({ pool: db.pool, clock: () => now }, { accountId, participant, store });

test('erased acknowledgements accept at most 16 bounded named exceptions and none cannot retain data', async () => {
  const { accountId } = await deleted();
  const invalid = [
    Array.from({ length: 17 }, (_, i) => retention({ store: `store_${i}` })),
    [retention({ store: '' })],
    [retention({ store: 'a'.repeat(65) })],
    [retention({ store: 'bad.store' })],
    [retention({ fields: [] })],
    [retention({ fields: Array.from({ length: 33 }, (_, i) => `field_${i}`) })],
    [retention({ fields: ['bad field'] })],
    [retention({ fields: ['a'.repeat(65)] })],
    [retention(), retention()],
    [retention({ purpose: '' })],
    [retention({ purpose: 'a'.repeat(201) })],
    [retention({ expiresAt: at })],
    [retention({ expiresAt: new Date(at.getTime() - 1) })],
    [retention({ expiresAt: new Date(NaN) })],
    [retention({ expiresAt: undefined as unknown as Date })],
    [retention({ expiresAt: null as unknown as Date })],
    [retention({ expiresAt: 'unknown' as unknown as Date })],
  ];
  for (const retained of invalid)
    await expect(retain(accountId, retained)).rejects.toBeInstanceOf(LifecycleDeniedError);
  await expect(retain(accountId, [retention()], 'none')).rejects.toBeInstanceOf(LifecycleDeniedError);
  expect((await status(accountId))?.participants.content).toEqual({ outcome: 'pending', retained: [] });
  const retained = Array.from({ length: 16 }, (_, i) =>
    retention({
      store: `store_${i}`,
      fields: Array.from({ length: 32 }, (_, n) => `${'f'.repeat(60)}_${n}`),
      purpose: 'p'.repeat(200),
    }),
  );
  retained[0] = retention({ store: 's'.repeat(64), fields: ['f'.repeat(64)] });
  await retain(accountId, retained);
  expect((await status(accountId))?.participants.content!.retained).toHaveLength(16);
  const empty = await deleted();
  await retain(empty.accountId, [], 'none');
  expect((await status(empty.accountId))?.participants.content).toEqual({ outcome: 'none', retained: [] });
});

test('acknowledgement exceptions are immutable, order independent, and repeated acknowledgement is a no-op', async () => {
  const { accountId } = await deleted();
  const first = retention();
  const second = retention({ store: 'bans' });
  const original = await retain(accountId, [first, second]);
  const before = await status(accountId);
  expect((await retain(accountId, [second, { ...first, fields: [...first.fields].reverse() }])).position).toBe(
    original.position,
  );
  for (const changed of [
    [],
    [first],
    [first, retention({ store: 'other' })],
    [retention({ fields: ['decision'] }), second],
    [retention({ purpose: 'Other purpose' }), second],
    [retention({ expiresAt: new Date(at.getTime() + 2) }), second],
  ]) {
    await expect(retain(accountId, changed)).rejects.toBeInstanceOf(LifecycleDeniedError);
  }
  expect(await status(accountId)).toEqual(before);
  await expect(
    db.admin.query(
      `UPDATE access.erasure_acknowledgement SET retained='[]'::jsonb
    WHERE route=$1 AND account_id=$2 AND participant='content'`,
      [routeOf(accountId), accountId],
    ),
  ).rejects.toThrow('immutable');
});

test('status distinguishes pending, retention outstanding and complete without changing active cleanup completion', async () => {
  const { accountId } = await deleted();
  const future = retention({ store: 'bans', expiresAt: new Date('2100-01-01T00:00:00Z') });
  await retain(accountId, [retention(), future]);
  let read = await status(accountId);
  expect(read?.state).toBe('pending');
  expect(read?.completedAt).toBeNull();
  expect(read?.participants.content).toEqual({
    outcome: 'erased',
    retained: [
      {
        ...future,
        fields: ['decision', 'reporter'],
        expiresAt: future.expiresAt.toISOString(),
        resolvedAt: null,
        overdue: false,
      },
      {
        ...retention(),
        fields: ['decision', 'reporter'],
        expiresAt: retention().expiresAt.toISOString(),
        resolvedAt: null,
        overdue: true,
      },
    ],
  });
  for (const participant of ids.filter((id) => id !== 'content')) await ack(accountId, participant, 'none');
  read = await status(accountId);
  expect(read?.state).toBe('retention-outstanding');
  expect(read?.completedAt).toBe(completedAt.toISOString());
  await resolve(accountId);
  expect((await status(accountId))?.state).toBe('retention-outstanding');
  await resolve(accountId, 'bans', 'content', future.expiresAt);
  read = await status(accountId);
  expect(read?.state).toBe('complete');
  expect(read?.completedAt).toBe(completedAt.toISOString());
  expect(read?.participants.content!.retained.map((entry) => [entry.resolvedAt, entry.overdue])).toEqual([
    [future.expiresAt.toISOString(), false],
    [completedAt.toISOString(), false],
  ]);
});

test('owner resolution after expiry is one platform transaction, resolves exactly one store and is idempotent', async () => {
  const { accountId, tombstone } = await deleted();
  await retain(accountId, [retention(), retention({ store: 'bans' })]);
  await expect(resolve(accountId, 'moderation', 'content', at)).rejects.toBeInstanceOf(LifecycleDeniedError);
  const result = await resolve(accountId);
  expect(result.partition).toBe(tombstone.partition);
  expect(result.transactionId).not.toBe(tombstone.transactionId);
  const basis = await db.admin.query(
    `SELECT principal_id,client_id,requested_by FROM editorial.write_basis
    WHERE partition_no=$1 AND transaction_id=$2`,
    [result.partition, result.transactionId],
  );
  expect(basis.rows).toEqual([
    { principal_id: '00000000-0000-8000-8000-000000000001', client_id: 'internal-access', requested_by: null },
  ]);
  const before = await status(accountId);
  expect(before?.participants.content!.retained.map((entry) => entry.resolvedAt)).toEqual([
    null,
    completedAt.toISOString(),
  ]);
  const duplicate = await resolve(accountId, 'moderation', 'content', new Date(completedAt.getTime() + 1000));
  expect(duplicate.position).toBe(result.position);
  expect(await status(accountId)).toEqual(before);
  for (const [target, participant, store] of [
    [accountId, 'unknown', 'moderation'],
    [accountId, 'auth', 'moderation'],
    [accountId, 'content', 'unknown'],
    [await person(), 'content', 'moderation'],
    [newId(0x7351), 'content', 'moderation'],
  ]) {
    await expect(resolve(target!, store!, participant!)).rejects.toBeInstanceOf(LifecycleDeniedError);
  }
  await retain(accountId, [retention(), retention({ store: 'bans' })]);
  expect(await status(accountId)).toEqual(before);
  await expect(
    db.admin.query(
      `UPDATE access.erasure_acknowledgement SET resolutions='{}'::jsonb
    WHERE route=$1 AND account_id=$2 AND participant='content'`,
      [routeOf(accountId), accountId],
    ),
  ).rejects.toThrow('immutable');
});

test('retention resolution rolls back if its event fails and concurrent resolutions preserve both stores', async () => {
  const { accountId } = await deleted();
  await retain(accountId, [retention(), retention({ store: 'bans' })]);
  const before = await status(accountId);
  await db.admin.query(`CREATE FUNCTION public.reject_retention_event() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'test retention commit failure'; END; $$`);
  await db.admin.query(`CREATE TRIGGER reject_retention_event BEFORE INSERT ON core.outbox
    FOR EACH ROW WHEN (NEW.subject = '${accountId}') EXECUTE FUNCTION public.reject_retention_event()`);
  try {
    await expect(resolve(accountId)).rejects.toThrow('test retention commit failure');
    expect(await status(accountId)).toEqual(before);
  } finally {
    await db.admin.query('DROP TRIGGER reject_retention_event ON core.outbox');
    await db.admin.query('DROP FUNCTION public.reject_retention_event()');
  }
  const otherPool = createPool(db.url);
  try {
    await Promise.all([
      resolve(accountId),
      resolveRetention(
        { pool: otherPool, clock: () => completedAt },
        { accountId, participant: 'content', store: 'bans' },
      ),
    ]);
  } finally {
    await otherPool.end();
  }
  expect((await status(accountId))?.participants.content!.retained.map((entry) => entry.resolvedAt)).toEqual([
    completedAt.toISOString(),
    completedAt.toISOString(),
  ]);
});

test('valid store identifiers that name object prototype properties remain unresolved until explicitly resolved', async () => {
  const { accountId } = await deleted();
  await retain(
    accountId,
    ['constructor', '__proto__', 'toString'].map((store) => retention({ store })),
  );
  const before = (await status(accountId))!.participants.content!.retained;
  expect(before).toHaveLength(3);
  expect(before.every((entry) => entry.resolvedAt === null && entry.overdue)).toBe(true);
  await resolve(accountId, '__proto__');
  const after = (await status(accountId))!.participants.content!.retained;
  expect(after.filter((entry) => entry.resolvedAt !== null)).toEqual([
    {
      ...retention({ store: '__proto__' }),
      fields: ['decision', 'reporter'],
      expiresAt: retention().expiresAt.toISOString(),
      resolvedAt: completedAt.toISOString(),
      overdue: false,
    },
  ]);
  expect(after.filter((entry) => entry.resolvedAt === null).map((entry) => entry.store)).toEqual([
    'constructor',
    'toString',
  ]);
});
