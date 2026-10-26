import { afterAll, expect, test } from 'bun:test';
import { createPool, withConnection } from '../src/database/pool.ts';
import { CommandUnavailableError } from '../src/command/command.ts';
import { deriveAccess } from '../src/access/derived-access.ts';
import { readAccount } from '../src/access/account-data.ts';
import { createLifecycleCommands, LifecycleDeniedError, LIFECYCLE_ACTIONS } from '../src/access/lifecycle.ts';
import { newId, partitionOf } from '../src/route/route.ts';
import { admittedAccess, authenticateAccount } from './support/admitted-access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const admin = createPool(url);
afterAll(async () => {
  await pool.end();
  await admin.end();
});
let trace: { body: number; rollback: () => void };
pool.on('connect', (client) => {
  const query = client.query.bind(client);
  client.query = (async (...args: Parameters<typeof query>) => {
    const text = typeof args[0] === 'string' ? args[0] : ((args[0] as { text?: string }).text ?? '');
    if (text.includes('SET display_name =')) trace.body++;
    const result = await query(...args);
    if (text === 'ROLLBACK') trace.rollback();
    return result;
  }) as typeof client.query;
});

async function fixture(route: number) {
  const accountId = newId(route);
  const partition = partitionOf(route);
  await admin.query(
    `INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$3)`,
    [route, accountId, Bun.randomUUIDv7()],
  );
  await admin.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
     VALUES ($1,$2,$2,'account:update','(,)',$3)`,
    [route, accountId, Bun.randomUUIDv7()],
  );
  const account = await withConnection(admin, (tx) => readAccount(tx, route, accountId));
  if (!account) throw new Error('missing account');
  const counts = { prepare: 0, authorize: 0 };
  const root = admittedAccess({ actions: LIFECYCLE_ACTIONS });
  const actor = await authenticateAccount(
    root,
    { pool, deadline: Date.now() + 30_000 },
    { accountId, clientId: 'web', scopes: ['account:update'], requestedBy: null, authnEpoch: 1 },
  );
  const rolledBack = Promise.withResolvers<void>();
  trace = { body: 0, rollback: () => rolledBack.resolve() };
  const commands = createLifecycleCommands({
    pool,
    access: deriveAccess(root, {
      async prepare(...args) {
        counts.prepare++;
        return root.prepare!(...args);
      },
      async authorize(...args) {
        counts.authorize++;
        return root.authorize(...args);
      },
    }),
  });
  const state = (writeState: string, movedTo: string | null = null) =>
    admin.query('UPDATE core.partition SET write_state=$2,moved_to=$3 WHERE partition_no=$1', [
      partition,
      writeState,
      movedTo,
    ]);
  const snapshot = async () =>
    (
      await admin.query(
        `SELECT position::text,
      (SELECT count(*)::int FROM core.receipt WHERE partition_no=$1) AS receipts,
      (SELECT count(*)::int FROM core.outbox WHERE partition_no=$1) AS events,
      (SELECT display_name FROM access.account WHERE route=$2 AND account_id=$3) AS name
     FROM core.partition WHERE partition_no=$1`,
        [partition, route, accountId],
      )
    ).rows[0];
  const started: Promise<unknown>[] = [];
  const start = (deadline = Date.now() + 1800) => {
    const run = commands
      .updateAccount(
        { actor, account, deadline },
        { accountId, key: Bun.randomUUIDv7(), patch: { displayName: 'written' } },
      )
      .then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );
    started.push(run);
    return run;
  };
  const settle = async () => {
    await Promise.all(started);
  };
  await state('fenced');
  return { counts, rolledBack: rolledBack.promise, state, snapshot, start, settle, accountId, route };
}

async function idleBy(deadline: number) {
  while (pool.totalCount !== pool.idleCount) {
    if (Date.now() >= deadline) throw new Error('connections were still held at the command deadline');
    await Bun.sleep(5);
  }
}

test('known fence waits past evidence expiry as availability without repeating authorization or body', async () => {
  const f = await fixture(0xd100);
  const before = await f.snapshot();
  try {
    const deadline = Date.now() + 1400;
    const pending = f.start(deadline);
    await f.rolledBack;
    await idleBy(deadline);
    expect(pool.totalCount).toBe(pool.idleCount);
    const result = await pending;
    expect(result.error).toBeInstanceOf(CommandUnavailableError);
    expect(result.error).toMatchObject({ reason: 'fenced' });
    expect(result.value).toBeNull();
    expect(f.counts).toEqual({ prepare: 1, authorize: 3 });
    expect(trace.body).toBe(1);
    expect(await f.snapshot()).toEqual(before);
  } finally {
    await f.settle();
    await f.state('active');
  }
});

test('known fence reports the moved node without another real attempt', async () => {
  const f = await fixture(0xd110);
  const before = await f.snapshot();
  try {
    const pending = f.start();
    await f.rolledBack;
    await f.state('moved', 'successor-node');
    const result = await pending;
    expect(result.error).toMatchObject({ reason: 'moved', movedTo: 'successor-node' });
    expect(f.counts).toEqual({ prepare: 1, authorize: 3 });
    expect(trace.body).toBe(1);
    expect(await f.snapshot()).toEqual(before);
  } finally {
    await f.settle();
    await f.state('active');
  }
});

test('writable recovery reauthorizes current grants before any receipt or body', async () => {
  const f = await fixture(0xd120);
  const before = await f.snapshot();
  try {
    const pending = f.start();
    await f.rolledBack;
    await admin.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [f.route, f.accountId]);
    await f.state('active');
    const result = await pending;
    expect(result.error).toBeInstanceOf(LifecycleDeniedError);
    expect(result.value).toBeNull();
    expect(f.counts).toEqual({ prepare: 2, authorize: 4 });
    expect(trace.body).toBe(1);
    expect(await f.snapshot()).toEqual(before);
  } finally {
    await f.settle();
    await f.state('active');
  }
});

test('evidence expires during fence wait and refreshes only after becoming writable', async () => {
  const f = await fixture(0xd130);
  const before = await f.snapshot();
  try {
    const pending = f.start();
    await f.rolledBack;
    await Bun.sleep(1050);
    expect(f.counts).toEqual({ prepare: 1, authorize: 3 });
    expect(trace.body).toBe(1);
    await f.state('active');
    const result = await pending;
    expect(result.error).toBeNull();
    expect(result.value?.replayed).toBe(false);
    expect(f.counts).toEqual({ prepare: 2, authorize: 6 });
    expect(trace.body).toBe(2);
    expect(await f.snapshot()).toEqual({
      position: String(BigInt(before.position) + 1n),
      receipts: before.receipts + 1,
      events: before.events + 1,
      name: 'written',
    });
  } finally {
    await f.settle();
    await f.state('active');
  }
});

test('writable recovery executes exactly one effect after the rolled back attempt', async () => {
  const f = await fixture(0xd140);
  const before = await f.snapshot();
  try {
    const pending = f.start();
    await f.rolledBack;
    await f.state('active');
    const result = await pending;
    expect(result.error).toBeNull();
    expect(result.value?.replayed).toBe(false);
    expect(f.counts).toEqual({ prepare: 2, authorize: 6 });
    expect(trace.body).toBe(2);
    expect(await f.snapshot()).toEqual({
      position: String(BigInt(before.position) + 1n),
      receipts: before.receipts + 1,
      events: before.events + 1,
      name: 'written',
    });
  } finally {
    await f.settle();
    await f.state('active');
  }
});
