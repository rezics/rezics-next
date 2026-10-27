import { afterAll, beforeAll, expect, test } from 'bun:test';
import { pageActiveAccounts } from '../../src/access/active-account-page.ts';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { newId } from '../../src/route/route.ts';

const pool = createPool(process.env.DATABASE_URL!);
const zero = { afterRoute: 0, afterAccountId: '00000000-0000-0000-0000-000000000000' };
const expected: { route: number; accountId: string }[] = [];
const excluded: { route: number; accountId: string }[] = [];

beforeAll(async () => {
  await pool.query('TRUNCATE access.account CASCADE');
  const seeds = [];
  let serial = 0;
  // Reverse route insertion also makes UUID order differ from route order.
  for (const route of [65535, 23, 1, 0]) {
    for (let position = 0; position < 33; position++) {
      for (const [state, fenced] of [
        ['pending', false],
        ['active', true],
        ['deleted', false],
        ['suspended', false],
        ['active', false],
      ] as const) {
        const accountId = `${(++serial).toString(16).padStart(8, '0')}-0000-8000-8000-${route.toString(16).padStart(4, '0')}00000000`;
        const row = { route, accountId };
        (state === 'active' && !fenced ? expected : excluded).push(row);
        seeds.push({
          ...row,
          state,
          fenced,
          kind: position % 2 === 0 ? 'actor' : 'organization',
          handle: position % 2 === 0 ? null : `private_${serial}`,
        });
      }
    }
  }
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,authn_fenced,handle,display_name,transaction_id)
     SELECT route,"accountId",kind,state,fenced,handle,'Private display name',"accountId"
     FROM jsonb_to_recordset($1::jsonb)
       AS seed(route integer,"accountId" uuid,kind text,state text,fenced boolean,handle text)`,
    [JSON.stringify(seeds)],
  );
  expected.sort((a, b) => a.route - b.route || a.accountId.localeCompare(b.accountId));
  excluded.sort((a, b) => a.route - b.route || a.accountId.localeCompare(b.accountId));
});

afterAll(() => pool.end());

test('pages return only active unfenced accounts as route and accountId in route then account id order', async () => {
  await withConnection(pool, async (client) => {
    const first = await pageActiveAccounts(client, { ...zero, limit: 100 });
    expect(first).toEqual(expected.slice(0, 100));
    for (const row of first) expect(Object.keys(row).sort()).toEqual(['accountId', 'route']);
    const cursor = expected[32]!;
    expect(
      await pageActiveAccounts(client, {
        afterRoute: cursor.route,
        afterAccountId: cursor.accountId,
        limit: 100,
      }),
    ).toEqual(expected.slice(33, 133));
  });
});

test('a page holds at most the requested limit and never more than 100', async () => {
  await withConnection(pool, async (client) => {
    for (const limit of [1, 2, 17, 99, 100]) {
      const page = await pageActiveAccounts(client, { ...zero, limit });
      expect(page).toEqual(expected.slice(0, limit));
      expect(page.length).toBeLessThanOrEqual(limit);
      expect(page.length).toBeLessThanOrEqual(100);
    }
    for (const limit of [0, -1, 101, 1.5, NaN, Infinity, -Infinity, undefined, null, '10', true]) {
      await expect(pageActiveAccounts(client, { ...zero, limit: limit as number })).rejects.toBeInstanceOf(RangeError);
    }
  });
});

test('pending fenced and deleted accounts never appear and do not stop paging', async () => {
  await withConnection(pool, async (client) => {
    for (const cursor of excluded.filter(({ route }) => route === 0).slice(0, 8)) {
      const remaining = expected.filter(
        (row) => row.route > cursor.route || (row.route === cursor.route && row.accountId > cursor.accountId),
      );
      expect(
        await pageActiveAccounts(client, {
          afterRoute: cursor.route,
          afterAccountId: cursor.accountId,
          limit: 7,
        }),
      ).toEqual(remaining.slice(0, 7));
    }
  });
});

test('concatenated pages from the zero cursor list every active unfenced account exactly once', async () => {
  for (const limit of [1, 7, 100]) {
    const found: typeof expected = [];
    let cursor = zero;
    for (let count = 0; count <= expected.length; count++) {
      // A deployment caller releases its connection between pages.
      const page = await withConnection(pool, (client) => pageActiveAccounts(client, { ...cursor, limit }));
      if (page.length === 0) break;
      expect(page.length).toBeLessThanOrEqual(limit);
      found.push(...page);
      const last = page.at(-1)!;
      cursor = { afterRoute: last.route, afterAccountId: last.accountId };
    }
    expect(found).toEqual(expected);
    expect(new Set(found.map(({ accountId }) => accountId)).size).toBe(expected.length);
    expect(await withConnection(pool, (client) => pageActiveAccounts(client, { ...cursor, limit }))).toEqual([]);
  }
});

test('the pager reads on the caller client and leaves its transaction open', async () => {
  await withConnection(pool, async (client) => {
    const accountId = newId(65535);
    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
         VALUES (65535,$1,'actor','active',$1)`,
        [accountId],
      );
      const page = await pageActiveAccounts(client, {
        afterRoute: 65535,
        afterAccountId: zero.afterAccountId,
        limit: 100,
      });
      expect(page).toContainEqual({ route: 65535, accountId });
    } finally {
      await client.query('ROLLBACK');
    }
    expect(
      (await client.query('SELECT 1 FROM access.account WHERE route=65535 AND account_id=$1', [accountId])).rows,
    ).toEqual([]);
  });
});
