import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { decodeCursor, encodeCursor } from '../../src/tokens/cursor.ts';
import { capture, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 0x2200;
const owner = newId(route),
  other = newId(route);
const keys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(7)]]) };
const credentials = new Map<string, string>();
let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let statements: string[];

// The same seed grows both unrelated statements and their lines, in the caller's route.
async function seed(account: string, count: number) {
  const ids = Array.from({ length: count }, () => newId(route));
  await db.admin.query(
    `INSERT INTO commerce.entitlement(route,entitlement_id,account_id,order_id,offer_id,target_subject_id,granted_at,revision,transaction_id)
     SELECT $1,id,$2,id,id,id,now(),1,id FROM unnest($3::uuid[]) id`,
    [route, account, ids],
  );
  await db.admin.query(
    `INSERT INTO commerce.payout_statement(route,statement_id,creator_account_id,period,currency)
     SELECT $1,id,$2,to_char(date '2000-01-01' + (n::text || ' months')::interval,'YYYY-MM'),'usd'
     FROM unnest($3::uuid[]) WITH ORDINALITY AS ids(id,n)`,
    [route, account, ids],
  );
  await db.admin.query(
    `INSERT INTO commerce.royalty_line(route,balance_transaction_id,creator_account_id,order_id,offer_id,kind,currency,gross_minor,tax_minor,fee_minor,dispute_fee_minor,net_receipts_minor,royalty_basis_points,period,statement_id,recorded_at)
     SELECT $1,'txn_' || replace(id::text,'-',''),$2,id,id,'charge','usd',1,0,0,0,1,9000,'2000-02',$4,now()
     FROM unnest($3::uuid[]) id`,
    [route, account, ids, ids[0]],
  );
  return ids;
}

async function request(path: string, account = owner) {
  return app.handle(
    new Request(`https://kernel.test${path}`, {
      headers: { authorization: `Bearer ${credentials.get(account)!}` },
    }),
  );
}
async function problem(path: string, code: string, account = owner, status = 400) {
  const response = await request(path, account);
  expect(response.status).toBe(status);
  expect((await response.json()).code).toBe(code);
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  const signing = await generateKeyPair('ES256');
  const jwk = { ...(await exportJWK(signing.publicKey)), kid: 'lists', alg: 'ES256' };
  app = createKernel({
    pool: db.pool,
    routeKey: new Uint8Array(32),
    tokens: keys,
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer: 'https://auth.test',
          audience: 'https://kernel.test',
          jwksUrl: 'https://auth.test/jwks',
          fetch: async () => Response.json({ keys: [jwk] }),
        },
      }),
  });
  for (const account of [owner, other]) {
    await db.admin.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [route, account],
    );
    await db.admin.query(
      `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,grant_role,valid,transaction_id)
       VALUES ($1,$2,$2,'commerce.payout.owner','(,)',$2)`,
      [route, account],
    );
    credentials.set(
      account,
      await new SignJWT({
        client_id: 'web',
        scope: 'entitlement:list payout_statement:list payout_statement:read',
        authn_epoch: 1,
        auth_time: Math.floor(Date.now() / 1000),
        amr: ['pwd'],
      })
        .setProtectedHeader({ alg: 'ES256', kid: 'lists', typ: 'at+jwt' })
        .setIssuer('https://auth.test')
        .setAudience('https://kernel.test')
        .setSubject(account)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(signing.privateKey),
    );
  }
  statements = await seed(owner, 101);
  await seed(other, 101);
});
afterAll(async () => {
  await db?.close();
});

const lists = [
  { resource: 'entitlements', operation: 'entitlement.list', path: () => '/v1/entitlements', id: 'id' },
  { resource: 'payoutStatements', operation: 'payout_statement.list', path: () => '/v1/payoutStatements', id: 'id' },
  {
    resource: 'lines',
    operation: 'payout_statement.lines',
    path: () => `/v1/payoutStatements/${statements[0]}/lines`,
    id: 'balanceTransactionId',
  },
] as const;

for (const list of lists) {
  test(`${list.resource}: default 20, maximum 100, bounded limits and complete signed keyset paging`, async () => {
    for (const [query, count] of [
      ['', 20],
      ['?limit=100', 100],
    ] as const) {
      const response = await request(list.path() + query);
      expect(response.status).toBe(200);
      const page = await response.json();
      expect(Object.keys(page).sort()).toEqual([list.resource, 'next'].sort());
      expect(page[list.resource]).toHaveLength(count);
      expect(page.next).toBeString();
    }
    for (const limit of [0, 101]) await problem(`${list.path()}?limit=${limit}`, 'invalid_request');
    const seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const response = await request(`${list.path()}?limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(response.status).toBe(200);
      const page = await response.json();
      for (const row of page[list.resource]) {
        expect(seen.has(row[list.id])).toBe(false);
        seen.add(row[list.id]);
      }
      cursor = page.next;
      expect(cursor === null || typeof cursor === 'string').toBe(true);
      if (cursor !== null) {
        const parameters =
          list.resource === 'lines' ? { accountId: owner, statementId: statements[0]! } : { accountId: owner };
        const decoded = decodeCursor(keys, { operation: list.operation, parameters }, cursor);
        expect(decoded.ok).toBe(true);
        if (decoded.ok) expect(decoded.after).toEqual([page[list.resource].at(-1)[list.id]]);
      }
    } while (cursor !== null);
    expect(seen.size).toBe(101);
  });

  test(`${list.resource}: rejects raw, malformed, tampered, foreign-account and foreign-operation cursors`, async () => {
    const page = await (await request(`${list.path()}?limit=1`)).json();
    expect(page.next).toBeString();
    const token: string = page.next;
    for (const invalid of [
      page[list.resource][0][list.id],
      'malformed',
      `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}`,
    ])
      await problem(`${list.path()}?cursor=${encodeURIComponent(invalid)}`, 'invalid_cursor');
    await problem(`${list.path()}?cursor=${encodeURIComponent(token)}`, 'invalid_cursor', other);
    for (const destination of lists.filter((candidate) => candidate !== list))
      await problem(`${destination.path()}?cursor=${encodeURIComponent(token)}`, 'invalid_cursor');
    if (list.resource === 'lines')
      await problem(
        `/v1/payoutStatements/${statements[1]}/lines?cursor=${encodeURIComponent(token)}`,
        'invalid_cursor',
      );
  });

  test(`${list.resource}: stale epochs and signed invalid key shapes are rejected`, async () => {
    const parameters =
      list.resource === 'lines' ? { accountId: owner, statementId: statements[0]! } : { accountId: owner };
    const binding = { operation: list.operation, parameters };
    const page = await (await request(`${list.path()}?limit=1`)).json();
    expect(page.next).toBeString();
    const decoded = decodeCursor(keys, binding, page.next);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) throw new Error('Expected a signed cursor');
    for (const after of [[], [123], ['invalid'], [newId(0x3300)], ['one', 'two']]) {
      const token = encodeCursor(keys, binding, { epoch: decoded.epoch, after });
      await problem(`${list.path()}?cursor=${encodeURIComponent(token)}`, 'invalid_cursor');
    }
    await db.admin.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [partitionOf(route)]);
    try {
      await problem(`${list.path()}?cursor=${encodeURIComponent(page.next)}`, 'stale_cursor', owner, 409);
    } finally {
      await db.admin.query('UPDATE core.partition SET epoch=epoch-1 WHERE partition_no=$1', [partitionOf(route)]);
    }
  });
}

test('one seed at three scales: each page has constant statements and one bounded keyset read in a read-only snapshot', async () => {
  const counts: number[][] = [];
  for (const scale of [1, 8, 64]) {
    await seed(newId(route), scale);
    const perList: number[] = [];
    for (const list of lists) {
      const result = await capture(db, () => request(`${list.path()}?limit=1`));
      expect(result.value.status).toBe(200);
      const sql = result.capture.statements;
      const begin = sql.findIndex((text) => /BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/i.test(text));
      const commit = sql.findIndex((text, index) => index > begin && /^COMMIT$/i.test(text));
      expect(begin).toBeGreaterThanOrEqual(0);
      expect(commit).toBeGreaterThan(begin);
      const pages = sql.filter((text) => /FROM commerce\./.test(text) && /LIMIT/.test(text));
      expect(pages).toHaveLength(1);
      expect(sql.indexOf(pages[0]!)).toBeGreaterThan(begin);
      expect(sql.indexOf(pages[0]!)).toBeLessThan(commit);
      expect(pages[0]).toMatch(/ORDER BY/);
      perList.push(sql.length);
    }
    counts.push(perList);
  }
  expect(counts[1]).toEqual(counts[0]);
  expect(counts[2]).toEqual(counts[0]);
});
