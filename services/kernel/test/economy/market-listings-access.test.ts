import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { createAccess } from '../../src/access/index.ts';
import { createNativeEconomyMarket } from '../../src/composition/economy-market.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { encodeListCursor, type ListCursorBinding } from '../../src/tokens/list-cursor.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import {
  insertRetainedListings,
  insertRetainedTrades,
  retainedListing,
  retainedTrade,
} from './fixtures/market-trades.ts';

const issuer = 'https://market-offers.auth.test';
const audience = 'https://market-offers.api.test';
const seller = newId(0x6540);
const reader = newId(0x6541);
const otherReader = newId(0x6542);
const ordinary = newId(0x6543);
const bookId = `market-offers:${crypto.randomUUID()}`;
const itemHomeId = `market-items:${crypto.randomUUID()}`;
const keys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(33)]]) };
const path = '/v1/economy/market/listings';
let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let unbound: ReturnType<typeof createKernel>;
let sign: (account: string, scope?: string) => Promise<string>;

beforeAll(async () => {
  db = await openGrowthDatabase();
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), alg: 'ES256', kid: 'market-offers' };
  sign = (sub, scope = 'market:read') =>
    new SignJWT({ client_id: 'web', authn_epoch: 1, scope, auth_time: Math.floor(Date.now() / 1000), amr: ['pwd'] })
      .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  for (const id of [seller, reader, otherReader, ordinary]) {
    await db.admin.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [routeOf(id), id],
    );
    await db.admin.query(
      `INSERT INTO access.resource_grant (route, resource_id, subject_id, subject_kind, action, valid, transaction_id)
       VALUES (0, $1, $2, 'identity', $3, '(,)', $2)`,
      [GLOBAL_CONTEXT.id, id, id === ordinary ? 'gate:any' : 'gate:economy'],
    );
  }
  const market = createNativeEconomyMarket(db.pool, {
    bookId,
    itemHomeId,
    node: 'b',
    feeAccountId: crypto.randomUUID(),
    feeBps: 2500n,
    policyVersion: 12n,
  }).port;
  const mount = (binding?: typeof market) =>
    createKernel({
      pool: db.pool,
      routeKey: new Uint8Array(32),
      tokens: keys,
      ...(binding === undefined ? {} : { economyMarket: binding }),
      access: (config) =>
        createAccess({
          ...config,
          auth: { issuer, audience, jwksUrl: `${issuer}/jwks`, fetch: async () => Response.json({ keys: [jwk] }) },
        }),
    });
  app = mount(market);
  unbound = mount();
}, 90_000);

afterAll(() => db?.close());

function request(address: string, token?: string, kernel = app) {
  return kernel.handle(
    new Request(`${audience}${address}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }),
  );
}

test('only admitted readers page open offers by expiry without seeing seller or reservation identity', async () => {
  const bearer = await sign(reader);
  const other = await sign(otherReader);
  const { rows } = await db.admin.query<{ now: string }>(
    'SELECT floor(extract(epoch FROM statement_timestamp()) * 1000)::bigint::text AS now',
  );
  const now = BigInt(rows[0]!.now);
  const future = now + 600_000n;
  const expiresLate = 9007199254740993n;
  const offers = [
    ['1', future],
    ['2', future],
    ['3', expiresLate],
  ] as const;
  const offer = (digit: string, expiresAt: bigint, override: Partial<Parameters<typeof retainedListing>[0]> = {}) =>
    retainedListing({ bookId, itemHomeId, sellerId: seller, listingId: digit.repeat(64), expiresAt, ...override });
  await insertRetainedListings(db.admin, [
    ...offers.map(([digit, expiresAt]) => offer(digit, expiresAt)),
    offer('0', now - 1n),
    offer('4', future - 1n, { cancelled: true }),
    offer('5', future - 10n, { itemHomeId: 'different-home' }),
    offer('6', future - 10n, { bookId: 'different-book' }),
  ]);
  await insertRetainedTrades(db.admin, [
    retainedTrade({
      bookId,
      itemHomeId,
      buyerId: reader,
      sellerId: seller,
      tradeId: '7'.repeat(64),
      startedAt: future,
    }),
  ]);
  const expected = offers.map(([digit, expiresAt]) => ({
    listingId: digit.repeat(64),
    itemId: `item-${digit.repeat(16)}`,
    generation: '1',
    assetId: 'test-market-credit',
    amount: '9007199254740993',
    expiresAt: expiresAt.toString(),
    revision: '0',
    status: 'open',
  }));
  expect(openApiDocument(app).paths[path]).toMatchObject({
    get: { operationId: 'market.read_listings', 'x-action': 'market:read', 'x-exposure': 'gate:economy' },
    post: { operationId: 'market.list', 'x-action': 'market:list' },
  });
  for (const token of [undefined, await sign(ordinary), await sign(reader, 'market:list')]) {
    const closed = await request(path, token);
    expect(closed.status).toBe(403);
  }
  expect((await request(path, bearer, unbound)).status).toBe(503);
  expect((await request(`${path}?limit=101`, bearer)).status).toBe(400);
  expect(await (await request(`${path}?limit=100`, other)).json()).toEqual({ listings: expected, next: null });
  expect(await (await request(`${path}/${expected[0]!.listingId}`, bearer)).json()).toEqual(expected[0]);
  // Existing exact reads can still see the retained open row after it leaves discovery.
  expect(await (await request(`${path}/${'0'.repeat(64)}`, bearer)).json()).toMatchObject({
    status: 'open',
    expiresAt: (now - 1n).toString(),
  });

  const address = (cursor: string | null, limit = 1) =>
    `${path}?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
  let next: string | null = null;
  let original = '';
  for (const listing of expected) {
    const response = await request(address(next), bearer);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const page = (await response.json()) as { listings: unknown[]; next: string | null };
    expect(page.listings).toEqual([listing]);
    next = page.next;
    if (!original && next) original = next;
  }
  expect(next).toBeNull();
  expect(original).not.toBe('');

  const nativeBinding: ListCursorBinding = {
    route: `GET ${path}`,
    viewer: reader,
    query: { bookId, itemHomeId, limit: 1 },
  };
  const foreignBindings = [
    { ...nativeBinding, query: { ...nativeBinding.query, bookId: 'different-book' } },
    { ...nativeBinding, query: { ...nativeBinding.query, itemHomeId: 'different-home' } },
    { ...nativeBinding, route: 'GET /v1/economy/market/trades' },
  ];
  const rejected = [await request(address(original), other), await request(address(original, 2), bearer)];
  for (const binding of foreignBindings) {
    const cursor = await encodeListCursor(
      keys,
      binding,
      { epoch: 1, after: [future.toString(), expected[0]!.listingId] },
      new Date(),
    );
    rejected.push(await request(address(cursor), bearer));
  }
  for (const response of rejected) {
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_cursor' });
  }
  await db.admin.query(
    "DELETE FROM access.resource_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2 AND action='gate:economy'",
    [GLOBAL_CONTEXT.id, reader],
  );
  expect((await request(address(original), bearer)).status).toBe(403);
  expect(await (await request(path, other)).json()).toEqual({ listings: expected, next: null });
});
