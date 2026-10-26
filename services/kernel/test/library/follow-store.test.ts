import { afterAll, expect, test } from 'bun:test';
import pg, { type Pool, type PoolClient } from 'pg';
import * as store from '../../src/library/follow-store.ts';
import {
  assertGrowth,
  measure,
  openGrowthDatabase,
  type GrowthDatabase,
  type GrowthSample,
} from '../support/growth.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());

const route = 0x1234;
const id = (n: number, r = route) =>
  `00000000-0000-7000-8000-${r.toString(16).padStart(4, '0')}${n.toString(16).padStart(8, '0')}`;
const time = '2026-10-26T12:00:00.000Z';
let transactionNumber = 1;

async function inTransaction<T>(database: Pool, body: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database.connect();
  try {
    await client.query('BEGIN');
    return await body(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

function apply(
  client: PoolClient,
  accountId: string,
  targetId: string,
  intent: 'implied' | 'follow' | 'unfollow',
  reason: 'explicit' | 'library' | 'membership' = 'explicit',
  at = time,
) {
  return store.applyFollow(client, route, {
    accountId,
    targetId,
    targetType: 'subject',
    intent,
    reason,
    transactionId: id(700_000 + transactionNumber++),
    time: at,
  });
}

test('a follow is unique for a follower and target and is stored in the follower route', async () => {
  await inTransaction(pool, async (client) => {
    const firstAccount = id(1);
    const secondAccount = id(2);
    const targetId = id(3, 0x5678);

    expect(await apply(client, firstAccount, targetId, 'follow')).toBe(true);
    expect(await apply(client, firstAccount, targetId, 'follow')).toBe(false);
    expect(await apply(client, secondAccount, targetId, 'implied', 'membership')).toBe(true);

    const rows = await client.query(
      `SELECT route, account_id, target_id FROM library.follow
       WHERE target_id = $1 ORDER BY account_id`,
      [targetId],
    );
    expect(rows.rows).toEqual([
      { route, account_id: firstAccount, target_id: targetId },
      { route, account_id: secondAccount, target_id: targetId },
    ]);
    expect(await store.readFollow(client, route, firstAccount, targetId)).toMatchObject({
      accountId: firstAccount,
      targetId,
      targetType: 'subject',
      state: 'following',
      reason: 'explicit',
    });
    expect(await store.readFollow(client, route + 1, firstAccount, targetId)).toBeNull();
    await client.query('SAVEPOINT wrong_route');
    await expect(apply(client, id(4, route + 1), id(5), 'follow')).rejects.toThrow();
    await client.query('ROLLBACK TO SAVEPOINT wrong_route');
    await client.query('SAVEPOINT target_type_mismatch');
    await expect(
      store.applyFollow(client, route, {
        accountId: firstAccount,
        targetId,
        targetType: 'collection',
        intent: 'implied',
        reason: 'library',
        transactionId: id(700_100),
        time,
      }),
    ).rejects.toThrow();
    await client.query('ROLLBACK TO SAVEPOINT target_type_mismatch');
    expect(
      await client.query('SELECT count(*)::int AS count FROM library.follow WHERE target_id = $1', [targetId]),
    ).toMatchObject({ rows: [{ count: 2 }] });
  });
});

test('all follow intents preserve explicit unfollows and only explicit intent changes state', async () => {
  await inTransaction(pool, async (client) => {
    const accountId = id(10);
    const cases = [
      {
        initial: 'none',
        intent: 'implied',
        reason: 'library',
        changed: true,
        state: 'following',
        storedReason: 'library',
      },
      {
        initial: 'following',
        intent: 'implied',
        reason: 'membership',
        changed: false,
        state: 'following',
        storedReason: 'library',
      },
      {
        initial: 'unfollowed',
        intent: 'implied',
        reason: 'library',
        changed: false,
        state: 'unfollowed',
        storedReason: 'explicit',
      },
      {
        initial: 'none',
        intent: 'follow',
        reason: 'explicit',
        changed: true,
        state: 'following',
        storedReason: 'explicit',
      },
      {
        initial: 'following',
        intent: 'follow',
        reason: 'explicit',
        changed: true,
        state: 'following',
        storedReason: 'explicit',
      },
      {
        initial: 'unfollowed',
        intent: 'follow',
        reason: 'explicit',
        changed: true,
        state: 'following',
        storedReason: 'explicit',
      },
      {
        initial: 'none',
        intent: 'unfollow',
        reason: 'explicit',
        changed: true,
        state: 'unfollowed',
        storedReason: 'explicit',
      },
      {
        initial: 'following',
        intent: 'unfollow',
        reason: 'explicit',
        changed: true,
        state: 'unfollowed',
        storedReason: 'explicit',
      },
      {
        initial: 'unfollowed',
        intent: 'unfollow',
        reason: 'explicit',
        changed: false,
        state: 'unfollowed',
        storedReason: 'explicit',
      },
    ] as const;

    for (const [index, item] of cases.entries()) {
      const targetId = id(100 + index);
      if (item.initial === 'following') await apply(client, accountId, targetId, 'implied', 'library');
      if (item.initial === 'unfollowed') await apply(client, accountId, targetId, 'unfollow');
      const before = await store.readFollow(client, route, accountId, targetId);

      expect(await apply(client, accountId, targetId, item.intent, item.reason, '2026-10-26T12:01:00.000Z')).toBe(
        item.changed,
      );

      const after = await store.readFollow(client, route, accountId, targetId);
      expect(after).toMatchObject({ state: item.state, reason: item.storedReason });
      if (item.intent === 'implied' && before) expect(after).toEqual(before);
    }

    const explicitlyUnfollowed = id(200);
    expect(await apply(client, accountId, explicitlyUnfollowed, 'unfollow')).toBe(true);
    const beforeImplied = await store.readFollow(client, route, accountId, explicitlyUnfollowed);
    expect(
      await apply(client, accountId, explicitlyUnfollowed, 'implied', 'membership', '2026-10-27T12:00:00.000Z'),
    ).toBe(false);
    expect(await store.readFollow(client, route, accountId, explicitlyUnfollowed)).toEqual(beforeImplied);
  });
});

test('follow pages use a stable updated-at keyset and keep follower rows private', async () => {
  await inTransaction(pool, async (client) => {
    const accountId = id(20);
    const otherAccountId = id(21);
    const targets = [id(301), id(302), id(303), id(304), id(305)];
    const timestamps = [
      '2026-10-25T12:00:00.000Z',
      '2026-10-26T12:00:00.000Z',
      '2026-10-26T12:00:00.000Z',
      '2026-10-27T12:00:00.000Z',
      '2026-10-24T12:00:00.000Z',
    ];
    for (let index = 0; index < targets.length; index++)
      await apply(client, accountId, targets[index]!, 'follow', 'explicit', timestamps[index]!);
    await apply(client, accountId, id(306), 'unfollow');
    await apply(client, otherAccountId, id(307), 'follow');

    const first = await store.pageFollows(client, route, accountId, { after: null, limit: 2 });
    const second = await store.pageFollows(client, route, accountId, {
      after: { updatedAt: first.at(-1)!.updatedAt, targetId: first.at(-1)!.targetId },
      limit: 2,
    });
    const third = await store.pageFollows(client, route, accountId, {
      after: { updatedAt: second.at(-1)!.updatedAt, targetId: second.at(-1)!.targetId },
      limit: 2,
    });

    expect([first, second, third].map((page) => page.map((follow) => follow.targetId))).toEqual([
      [targets[3]!, targets[1]!],
      [targets[2]!, targets[0]!],
      [targets[4]!],
    ]);
    expect(
      [...first, ...second, ...third].every((follow) => follow.accountId === accountId && follow.state === 'following'),
    ).toBe(true);
    expect(await store.pageFollows(client, route, otherAccountId, { after: null, limit: 10 })).toMatchObject([
      { accountId: otherAccountId, targetId: id(307) },
    ]);
    expect(await store.pageFollows(client, route + 1, accountId, { after: null, limit: 10 })).toEqual([]);
  });
});

async function seedUnrelatedFollowers(database: GrowthDatabase, from: number, to: number): Promise<void> {
  if (to > from) {
    await database.admin.query(
      `INSERT INTO library.follow
       (route, account_id, target_id, target_type, state, reason, created_at, updated_at, transaction_id)
       SELECT $1,
              ('10000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n), 8, '0'))::uuid,
              ('20000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n), 8, '0'))::uuid,
              'subject', 'following', 'explicit', $4::timestamptz, $4::timestamptz,
              ('30000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || lpad(to_hex(n), 8, '0'))::uuid
       FROM generate_series($2::int + 1, $3::int) AS n`,
      [route, from, to, time],
    );
  }
  await database.admin.query('ANALYZE library.follow');
}

test('apply and page statement counts and examined rows stay constant as unrelated follows grow', async () => {
  const database = await openGrowthDatabase();
  const applySamples: GrowthSample[] = [];
  const pageSamples: GrowthSample[] = [];
  const pageAccountId = id(900_000);
  const pageTargetId = id(900_001);
  try {
    await database.admin.query(
      `INSERT INTO library.follow
       (route, account_id, target_id, target_type, state, reason, created_at, updated_at, transaction_id)
       VALUES ($1, $2, $3, 'subject', 'following', 'explicit', $4, $4, $5)`,
      [route, pageAccountId, pageTargetId, time, id(900_002)],
    );

    let previous = 0;
    for (const scale of [256, 1_024, 4_096]) {
      await seedUnrelatedFollowers(database, previous, scale);
      const applyMeasured = await measure(database, () =>
        inTransaction(database.pool, (client) =>
          store.applyFollow(client, route, {
            accountId: id(800_000),
            targetId: id(810_000 + scale),
            targetType: 'subject',
            intent: 'follow',
            reason: 'explicit',
            transactionId: id(820_000 + scale),
            time,
          }),
        ),
      );
      expect(applyMeasured.value).toBe(true);
      expect(applyMeasured.cost.statements).toBe(1);
      expect(applyMeasured.cost.plans).toBe(1);
      applySamples.push({ scale, cost: applyMeasured.cost });

      const pageMeasured = await measure(database, () =>
        inTransaction(database.pool, (client) =>
          store.pageFollows(client, route, pageAccountId, { after: null, limit: 1 }),
        ),
      );
      expect(pageMeasured.value).toHaveLength(1);
      expect(pageMeasured.cost.statements).toBe(1);
      expect(pageMeasured.cost.plans).toBe(1);
      pageSamples.push({ scale, cost: pageMeasured.cost });
      previous = scale;
    }

    const touchedRows = (samples: GrowthSample[]) =>
      samples.map((sample) => sample.cost.relations?.['library.follow']?.rows ?? 0);
    expect(touchedRows(applySamples)).toEqual([1, 1, 1]);
    expect(touchedRows(pageSamples)).toEqual([1, 1, 1]);
    expect(applySamples.map((sample) => sample.cost.statements)).toEqual([1, 1, 1]);
    expect(pageSamples.map((sample) => sample.cost.statements)).toEqual([1, 1, 1]);
    expect(applySamples.every((sample) => sample.cost.relations?.['library.follow']?.sequentialScans === 0)).toBe(true);
    expect(pageSamples.every((sample) => sample.cost.relations?.['library.follow']?.sequentialScans === 0)).toBe(true);
    const growthRows = (samples: GrowthSample[]): GrowthSample[] =>
      samples.map((sample) => ({
        scale: sample.scale,
        cost: { ...sample.cost, rows: sample.cost.relations?.['library.follow']?.rows ?? 0 },
      }));
    assertGrowth(growthRows(applySamples), { rows: 'constant', blocks: 'logarithmic', statements: 'constant' });
    assertGrowth(growthRows(pageSamples), { rows: 'constant', blocks: 'logarithmic', statements: 'constant' });
  } finally {
    await database.admin.query('DELETE FROM library.follow WHERE route = $1', [route]);
    await database.close();
  }
});
