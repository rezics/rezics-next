import { afterAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { readBatch, type Envelope } from '../../src/events/log.ts';
import type { CommandTransaction } from '../../src/command/command.ts';
import { shareAccount } from '../../src/access/account-share.ts';
import { lifecycleExecutor } from '../../src/access/lifecycle-20261025094010-command.ts';
import {
  createLifecycleCommands,
  createLifecycleInternals,
  LIFECYCLE_ACTIONS,
  LifecycleDeniedError,
} from '../../src/access/lifecycle.ts';
import { createOrganizationCloseRunner } from '../../src/access/organization-close-work.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';

const pool = createPool(process.env.DATABASE_URL!);
// Separate pools bypass the process-local command gate: the race must reach PostgreSQL's row lock.
const ownerPool = createPool(process.env.DATABASE_URL!);
afterAll(async () => {
  await pool.end();
  await ownerPool.end();
});
const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
const commands = createLifecycleCommands({ pool, access });
const internal = createLifecycleInternals({
  pool,
  routeKey: new Uint8Array(32),
  provisioningEvidence: async () => null,
  recoveryEvidence: async () => null,
});
const key = () => Bun.randomUUIDv7();
const eventType = 'com.rezics.access.account-tombstoned.v1';

async function person(operator: string | null = null) {
  const id = newId(0x7351);
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,operator_account_id,transaction_id)
     VALUES($1,$2,'actor','active',$3,$2)`,
    [routeOf(id), id, operator],
  );
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     SELECT $1,$2,$2,action,'(,)'::tstzrange,$2
     FROM unnest(ARRAY['account:read','account:update','account:delete','account:manage']) AS action`,
    [routeOf(id), id],
  );
  return id;
}
async function context(id: string) {
  const actor = await authenticateAccount(
    access,
    { pool, deadline: Date.now() + 10000 },
    { accountId: id, clientId: 'erasure-consumer-test', scopes: [...LIFECYCLE_ACTIONS.keys()] },
  );
  return { actor, deadline: Date.now() + 10000 };
}
async function assertBarrier(
  accountId: string,
  outcome: { partition: number; epoch: number; position: bigint; transactionId: string },
) {
  const consumer = `erasure_${key().replaceAll('-', '')}`;
  await pool.query('INSERT INTO core.consumer_checkpoint(partition_no,consumer,position,epoch) VALUES($1,$2,$3,$4)', [
    outcome.partition,
    consumer,
    String(outcome.position - 1n),
    outcome.position === 1n ? null : outcome.epoch,
  ]);
  const envelopes: Envelope[] = [];
  const result = await readBatch(pool, {
    consumer,
    partition: outcome.partition,
    envelopes: 1,
    apply: async (batch) => {
      envelopes.push(...batch);
    },
  });
  expect(result.status).toBe('read');
  expect(envelopes).toHaveLength(1);
  expect(envelopes[0]!.position).toBe(outcome.position);
  const tombstones = envelopes[0]!.events.filter((event) => event.type === eventType);
  expect(tombstones).toHaveLength(1);
  expect(tombstones[0]).toMatchObject({ subject: accountId, data: { accountId } });
  const barrier = await pool.query(
    `SELECT state, transaction_id FROM access.account WHERE route=$1 AND account_id=$2`,
    [routeOf(accountId), accountId],
  );
  expect(barrier.rows[0]).toEqual({ state: 'deleted', transaction_id: outcome.transactionId });
  const receipt = await pool.query('SELECT transaction_id FROM core.receipt WHERE partition_no=$1 AND position=$2', [
    outcome.partition,
    String(outcome.position),
  ]);
  expect(receipt.rows).toEqual([{ transaction_id: outcome.transactionId }]);
  const all = await pool.query('SELECT count(*)::int AS n FROM core.outbox WHERE type=$1 AND subject=$2', [
    eventType,
    accountId,
  ]);
  expect(all.rows[0].n).toBe(1);
}

for (const withContinuation of [true, false]) {
  test(`person deletion ${withContinuation ? 'with a committed continuation' : 'without a continuation'} emits exactly one tombstone in its barrier envelope`, async () => {
    const accountId = await person();
    const request = {
      accountId,
      key: key(),
      ...(withContinuation
        ? {
            continuation: {
              operationKey: key(),
              operationDigest: 'a'.repeat(64),
              commandKeyPrefix: `wf:${'b'.repeat(64)}`,
            },
          }
        : {}),
    };
    const ctx = await context(accountId);
    const outcome = await commands.tombstone(ctx, request);
    await expect(commands.tombstone(ctx, request)).rejects.toBeInstanceOf(LifecycleDeniedError);
    if (withContinuation) {
      const continuation = await pool.query(
        'SELECT barrier_transaction_id FROM access.committed_continuation WHERE route=$1 AND account_id=$2',
        [routeOf(accountId), accountId],
      );
      expect(continuation.rows).toEqual([{ barrier_transaction_id: outcome.transactionId }]);
    }
    await assertBarrier(accountId, outcome);
  });
}

test("an automated account deleted by its operator's manager emits exactly one tombstone in its barrier envelope", async () => {
  const operator = await person();
  const manager = await person();
  const accountId = await person(operator);
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES($1,$2,$3,'account:manage','(,)',$3)`,
    [routeOf(operator), operator, manager],
  );
  const ctx = await context(manager);
  const request = { accountId, key: key() };
  const outcome = await commands.tombstone(ctx, request);
  expect((await commands.tombstone(ctx, request)).replayed).toBe(true);
  await assertBarrier(accountId, outcome);
});

test('organization close emits exactly one tombstone in its barrier envelope before bounded cleanup', async () => {
  const owner = await person();
  const accountId = newId(0x7371);
  const reservation = await internal.reserveCoordination({
    accountId: owner,
    relatedAccountId: accountId,
    purpose: 'membership',
    key: key(),
  });
  await internal.createOrganization({
    organizationId: accountId,
    ownerAccountId: owner,
    ownerReservationId: reservation.value.reservationId,
    key: key(),
  });
  const ctx = await context(owner);
  const request = { accountId, key: key() };
  const outcome = await commands.tombstone(ctx, request);
  await assertBarrier(accountId, outcome);
  const runner = createOrganizationCloseRunner({ pool });
  await runner.continueCommitted(accountId);
  await runner.continueCommitted(accountId);
  expect((await commands.tombstone(ctx, request)).replayed).toBe(true);
  await assertBarrier(accountId, outcome);
});

function ownerCommand(accountId: string, body: (tx: CommandTransaction, transactionId: string) => Promise<void>) {
  return lifecycleExecutor(ownerPool)(
    {
      route: routeOf(accountId)!,
      id: accountId,
      kind: 'account-updated',
      key: key(),
      input: {},
      deadline: Date.now() + 10000,
    },
    async (tx, transactionId) => {
      await body(tx, transactionId);
      return { accountId };
    },
  );
}

test('shareAccount returns active and refuses pending, suspended, fenced, deleted and unknown accounts', async () => {
  const accountId = await person();
  await ownerCommand(accountId, async (tx) => {
    expect(await shareAccount(tx, accountId)).toBe('active');
  });
  for (const [state, fenced] of [
    ['pending', false],
    ['suspended', false],
    ['active', true],
    ['deleted', true],
  ] as const) {
    await pool.query('UPDATE access.account SET state=$3, authn_fenced=$4 WHERE route=$1 AND account_id=$2', [
      routeOf(accountId),
      accountId,
      state,
      fenced,
    ]);
    await expect(
      ownerCommand(accountId, async (tx) => {
        await shareAccount(tx, accountId);
      }),
    ).rejects.toBeInstanceOf(LifecycleDeniedError);
  }
  for (const missing of [newId(0x7351), 'invalid']) {
    await expect(
      ownerCommand(accountId, async (tx) => {
        await shareAccount(tx, missing);
      }),
    ).rejects.toBeInstanceOf(LifecycleDeniedError);
  }
});

test('shareAccount refuses use outside a live command transaction', async () => {
  await expect(shareAccount(pool, await person())).rejects.toBeInstanceOf(LifecycleDeniedError);
});

test('shareAccount serializes account deletion with the owner command commit', async () => {
  await pool.query('CREATE TABLE erasure_consumer_data(account_id uuid PRIMARY KEY, transaction_id uuid NOT NULL)');
  const accountId = await person();
  const ctx = await context(accountId);
  const held = Promise.withResolvers<number>();
  const release = Promise.withResolvers<void>();
  const writing = ownerCommand(accountId, async (tx, transactionId) => {
    expect(await shareAccount(tx, accountId)).toBe('active');
    await tx.query('INSERT INTO erasure_consumer_data VALUES($1,$2)', [accountId, transactionId]);
    const backend = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    held.resolve(backend.rows[0]!.pid);
    await release.promise;
  });
  void writing.catch(held.reject);
  let deletion: ReturnType<typeof commands.tombstone> | undefined;
  try {
    const holder = await held.promise;
    deletion = commands.tombstone(ctx, { accountId, key: key() });
    void deletion.catch(() => {});
    let blocked = false;
    const deadline = Date.now() + 2000;
    while (!blocked && Date.now() < deadline) {
      const locks = await pool.query<{ blocked: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
         WHERE $1 = ANY(pg_blocking_pids(pid)) AND query LIKE '%access.account%' AND query LIKE '%FOR UPDATE%') AS blocked`,
        [holder],
      );
      blocked = locks.rows[0]!.blocked;
      if (!blocked) await Bun.sleep(5);
    }
    expect(blocked).toBe(true);
    expect((await pool.query('SELECT * FROM erasure_consumer_data')).rows).toEqual([]);
    release.resolve();
    const written = await writing;
    const deleted = await deletion;
    // A consumer starting from the barrier sees the racing command's committed data.
    expect(
      (await pool.query('SELECT transaction_id FROM erasure_consumer_data WHERE account_id=$1', [accountId])).rows,
    ).toEqual([{ transaction_id: written.transactionId }]);
    await assertBarrier(accountId, deleted);
  } finally {
    release.resolve();
    await Promise.allSettled([writing, deletion]);
  }
});

test('a command calling shareAccount after deletion committed sees deleted and refuses', async () => {
  const accountId = await person();
  await commands.tombstone(await context(accountId), { accountId, key: key() });
  let state: string | undefined;
  let created = false;
  await expect(
    ownerCommand(accountId, async (tx) => {
      const row = await tx.query('SELECT state FROM access.account WHERE route=$1 AND account_id=$2', [
        routeOf(accountId),
        accountId,
      ]);
      state = row.rows[0].state;
      await shareAccount(tx, accountId);
      created = true;
    }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  expect(state).toBe('deleted');
  expect(created).toBe(false);
});
