import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { createAccess } from '../../src/access/index.ts';
import { createNativeEconomyLedger } from '../../src/composition/economy.ts';
import { createNativeEconomySpot, createNativeEconomySpotWork } from '../../src/composition/economy-spot.ts';
import type { SpotAccessPort } from '../../src/economy/spot-routes.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { openBroadEconomyAdmission } from './fixtures/broad-admission.ts';

const issuer = 'https://auth.spot.economy.test';
const audience = 'https://api.rezics.test';
const marketPath = '/v1/economy/spot/pair';
const scopes = ['spot:read', 'spot:place', 'spot:cancel'];
const seller = newId(0x6271);
const second = newId(0x6272);
const ordinary = newId(0x6273);
const viewer = newId(0x6274);
const order = { side: 'sell', price: '9007199254740993', lots: '2' };
let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let closed: ReturnType<typeof createKernel>;
let mount: (economySpot?: SpotAccessPort) => ReturnType<typeof createKernel>;
let ledger: ReturnType<typeof createNativeEconomyLedger>;
let spot: SpotAccessPort;
let work: ReturnType<typeof createNativeEconomySpotWork>;
let sellerToken: string;
let readOnlyToken: string;
let placeOnlyToken: string;
let viewerToken: string;
let secondToken: string;
let ordinaryToken: string;
let closeBroadAdmission: (() => Promise<void>) | undefined;

function call(
  kernel: ReturnType<typeof createKernel>,
  path: string,
  token?: string,
  options: { method?: 'GET' | 'POST'; order?: typeof order } = {},
) {
  return kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: options.method ?? 'GET',
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(options.order === undefined
          ? {}
          : {
              'content-type': 'application/json',
              'idempotency-key': JSON.stringify('spot-test-order'),
            }),
      },
      ...(options.order === undefined ? {} : { body: JSON.stringify(options.order) }),
    }),
  );
}

async function grant(accountId: string, action = 'gate:economy') {
  await db.admin.query(
    `INSERT INTO access.resource_grant (route, resource_id, subject_id, subject_kind, action, valid, transaction_id)
     VALUES (0, $1, $2, 'identity', $3, '(,)', $4)`,
    [GLOBAL_CONTEXT.id, accountId, action, Bun.randomUUIDv7()],
  );
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), alg: 'ES256', kid: 'economy-spot-access' };
  const sign = (id: string, actions: string[]) =>
    new SignJWT({
      client_id: 'web',
      authn_epoch: 1,
      scope: actions.join(' '),
      auth_time: Math.floor(Date.now() / 1000),
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: jwk.kid })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(id)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  for (const id of [seller, second, ordinary, viewer]) {
    await db.admin.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [routeOf(id), id],
    );
  }
  [sellerToken, readOnlyToken, placeOnlyToken, viewerToken, secondToken, ordinaryToken] = await Promise.all([
    sign(seller, scopes),
    sign(viewer, ['spot:read']),
    sign(viewer, ['spot:place']),
    sign(viewer, scopes),
    sign(second, scopes),
    sign(ordinary, scopes),
  ]);
  const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(31)]]) };
  mount = (economySpot?: SpotAccessPort) =>
    createKernel({
      pool: db.pool,
      routeKey: new Uint8Array(32),
      tokens,
      ...(economySpot === undefined ? {} : { economySpot }),
      writeRate: {
        async spend() {
          return { allowed: true as const };
        },
      },
      access: (config) =>
        createAccess({
          ...config,
          auth: { issuer, audience, jwksUrl: `${issuer}/jwks`, fetch: async () => Response.json({ keys: [jwk] }) },
        }),
    });
  const bookId = `http:spot-${crypto.randomUUID()}`;
  const config = { bookId, node: 'b' };
  spot = createNativeEconomySpot(db.pool, config);
  work = createNativeEconomySpotWork(db.pool, config);
  ledger = createNativeEconomyLedger(db.pool, bookId);
  for (const id of ['base', 'quote'])
    expect(await ledger.provisionAsset({ id, scale: 0, transferable: true })).toMatchObject({ kind: 'ok' });
  for (const accountId of [seller, second])
    expect(await ledger.issue({ accountId, assetId: 'base', amount: '5', operationId: 'spot-opening' })).toMatchObject({
      kind: 'ok',
    });
  expect(
    await work.provision({
      id: 'pair',
      ledgerBookId: bookId,
      policyVersion: 1n,
      baseAssetId: 'base',
      quoteAssetId: 'quote',
      baseUnitsPerLot: 1n,
      quoteUnitsPerPriceTick: 1n,
      makerFeeBps: 0n,
      takerFeeBps: 0n,
      feeAccountId: crypto.randomUUID(),
    }),
  ).toMatchObject({ kind: 'ok' });
  app = mount(spot);
  closed = mount();
}, 90_000);

afterAll(async () => {
  try {
    await closeBroadAdmission?.();
  } finally {
    await db?.close();
  }
});

test('spot instrument and order routes require a direct grant, matching client scope, and installed native book', async () => {
  await grant(ordinary, 'gate:any');
  closeBroadAdmission = await openBroadEconomyAdmission(db.admin);
  for (const token of [undefined, ordinaryToken]) {
    expect((await call(closed, marketPath, token)).status).toBe(403);
    expect((await call(app, marketPath, token)).status).toBe(403);
    expect((await call(app, `${marketPath}/orders`, token, { method: 'POST', order })).status).toBe(403);
  }
  const hidden = await call(app, '/v1/openapi.json', ordinaryToken);
  expect(hidden.status).toBe(200);
  const hiddenPaths = (await hidden.json()).paths;
  expect(hiddenPaths['/v1/economy/spot/{instrumentId}']).toBeUndefined();
  expect(hiddenPaths['/v1/economy/spot/{instrumentId}/trades']).toBeUndefined();
  await grant(viewer);
  const unbound = await call(closed, marketPath, viewerToken);
  expect(unbound.status).toBe(503);
  expect(await unbound.json()).toMatchObject({ code: 'dependency_unavailable' });
  const instrument = await call(app, marketPath, viewerToken);
  expect(instrument.status).toBe(200);
  expect(instrument.headers.get('cache-control')).toBe('private, no-store');
  expect(await instrument.json()).toEqual({
    instrumentId: 'pair',
    baseAssetId: 'base',
    quoteAssetId: 'quote',
    baseUnitsPerLot: '1',
    quoteUnitsPerPriceTick: '1',
    makerFeeBps: '0',
    takerFeeBps: '0',
    policyVersion: '1',
    revision: '0',
  });
  expect((await call(app, `${marketPath}/orders`, readOnlyToken, { method: 'POST', order })).status).toBe(403);
});

test('native order identity, private reads, and cancellation remain exact through replay and grant revocation', async () => {
  await grant(second);
  await grant(seller);
  const placePath = `${marketPath}/orders`;
  const placed = await call(app, placePath, sellerToken, { method: 'POST', order });
  expect(placed.status).toBe(200);
  const receipt = await placed.json();
  expect(receipt).toEqual({ orderId: expect.stringMatching(/^[0-9a-f]{64}$/), sequence: '1' });
  const orderPath = `${placePath}/${receipt.orderId}`;
  const replay = await call(app, placePath, sellerToken, { method: 'POST', order });
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(receipt);
  const changed = await call(app, placePath, sellerToken, { method: 'POST', order: { ...order, lots: '3' } });
  expect(changed.status).toBe(422);
  expect(await changed.json()).toMatchObject({ code: 'idempotency_conflict' });
  const owned = await call(app, orderPath, sellerToken);
  expect(owned.status).toBe(200);
  expect(await owned.json()).toMatchObject({
    ...order,
    orderId: receipt.orderId,
    status: 'matching',
    remainingLots: '2',
  });
  const wrongOwner = await call(app, orderPath, secondToken);
  expect(wrongOwner.status).toBe(404);
  expect(await wrongOwner.json()).toMatchObject({ code: 'not_found' });
  expect((await call(app, `${orderPath}/cancel`, secondToken, { method: 'POST' })).status).toBe(404);
  expect(await ledger.readBalance({ accountId: seller, assetId: 'base' })).toMatchObject({
    kind: 'ok',
    value: { held: '2', available: '3' },
  });
  expect(await work.readyMatches()).toEqual({ kind: 'ok', value: [{ instrumentId: 'pair', revision: 1n }] });
  expect(await work.match('pair', 1n)).toMatchObject({ kind: 'ok', value: { status: 'resting' } });
  const cancel = await call(app, `${orderPath}/cancel`, sellerToken, { method: 'POST' });
  expect(cancel.status).toBe(200);
  expect(await cancel.json()).toEqual(receipt);
  const cancelled = await call(app, orderPath, sellerToken);
  expect(cancelled.status).toBe(200);
  expect(await cancelled.json()).toMatchObject({ status: 'cancelled' });
  const cancelReplay = await call(app, `${orderPath}/cancel`, sellerToken, { method: 'POST' });
  expect(cancelReplay.status).toBe(200);
  expect(await cancelReplay.json()).toEqual(receipt);
  expect(await ledger.readBalance({ accountId: seller, assetId: 'base' })).toMatchObject({
    kind: 'ok',
    value: { held: '0', available: '5' },
  });

  const another = await call(app, placePath, secondToken, { method: 'POST', order });
  expect(another.status).toBe(200);
  expect((await another.json()).orderId).not.toBe(receipt.orderId);
  await db.admin.query(
    `DELETE FROM access.resource_grant WHERE route = 0 AND resource_id = $1 AND subject_id = $2 AND action = 'gate:economy'`,
    [GLOBAL_CONTEXT.id, seller],
  );
  expect((await call(app, orderPath, sellerToken)).status).toBe(403);
  expect((await call(app, placePath, sellerToken, { method: 'POST', order })).status).toBe(403);
  expect((await call(app, `${orderPath}/cancel`, sellerToken, { method: 'POST' })).status).toBe(403);
  await expect(
    spot.readOrder({
      accountId: seller,
      deadline: Date.now() + 2000,
      instrumentId: 'pair',
      orderId: receipt.orderId,
    }),
  ).rejects.toMatchObject({ code: 'platform_closed' });
});

test('the signed trade feed only exposes settled amounts and seeks across native time and identity ties', async () => {
  const instrumentId = 'trade-pair';
  const path = `/v1/economy/spot/${instrumentId}/trades`;
  const { bookId } = spot;
  const scope = (accountId: string) => ({ accountId, instrumentId, deadline: Date.now() + 10_000 });
  const price = 9_007_199_254_740_993n;
  const unitsPerLot = 10_000_000_000_000_000n;
  await grant(seller);
  expect(
    await work.provision({
      id: instrumentId,
      ledgerBookId: bookId,
      policyVersion: 1n,
      baseAssetId: 'base',
      quoteAssetId: 'quote',
      baseUnitsPerLot: unitsPerLot,
      quoteUnitsPerPriceTick: 1n,
      makerFeeBps: 0n,
      takerFeeBps: 0n,
      feeAccountId: crypto.randomUUID(),
    }),
  ).toMatchObject({ kind: 'ok' });

  for (const [accountId, assetId, amount] of [
    [seller, 'base', '3000000000000000000'],
    [second, 'quote', '6000000000000000000'],
  ] as const) {
    expect(await ledger.issue({ accountId, assetId, amount, operationId: 'feed-opening' })).toMatchObject({
      kind: 'ok',
    });
  }
  for (let lots = 1n; lots <= 23n; lots++) {
    const ask = await spot.place({ ...scope(seller), orderId: `ask-${lots}`, side: 'sell', price, lots });
    if (ask.kind !== 'ok') throw new Error(`Ask placement failed: ${ask.kind}`);
    expect(await work.match(instrumentId, 2n * lots - 1n)).toMatchObject({ kind: 'ok', value: { status: 'resting' } });
  }
  expect(await spot.place({ ...scope(second), orderId: 'bid', side: 'buy', price, lots: 276n })).toMatchObject({
    kind: 'ok',
  });
  const matched = await work.match(instrumentId, 47n);
  if (matched.kind !== 'ok') throw new Error(`Matching failed: ${matched.kind}`);
  expect(matched.value.status).toBe('filled');
  expect(matched.value.fillIds).toHaveLength(23);

  const pending = await call(app, path, readOnlyToken);
  expect(pending.status).toBe(200);
  expect(pending.headers.get('cache-control')).toBe('private, no-store');
  expect(await pending.json()).toEqual({ trades: [], next: null });
  const [unsettled, ...settled] = matched.value.fillIds;
  if (!unsettled) throw new Error('Expected a pending native fill');
  for (const fillId of settled) {
    const claim = await work.claimFill(fillId);
    if (claim.kind !== 'ok') throw new Error(`Claim failed: ${claim.kind}`);
    expect(await work.settleFill(fillId, claim.value.token)).toEqual({ kind: 'ok', value: { operationId: fillId } });
  }
  expect(await work.readyFills()).toEqual({ kind: 'ok', value: [unsettled] });
  const full = await call(app, `${path}?limit=100`, readOnlyToken);
  expect(full.status).toBe(200);
  const initial = await full.json();
  expect(initial.trades).toHaveLength(22);
  expect(initial.next).toBeNull();
  expect(initial.trades.find((trade: { lots: string }) => trade.lots === '23')).toEqual({
    price: price.toString(),
    lots: '23',
    baseUnits: (23n * unitsPerLot).toString(),
    quoteUnits: (23n * price).toString(),
    settledAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
  });

  // Freeze the native timestamps after settlement so one default page ends a microsecond above the next page,
  // while every trade inside either group has an equal timestamp.
  const low = '2026-11-21T00:00:00.123456Z';
  const high = '2026-11-21T00:00:00.123457Z';
  const byFill = await db.admin.query<{ fill_id: string; lots: string }>(
    `SELECT fill_id, lots::text FROM economy.spot_fill
     WHERE book_id = $1 AND instrument_id = $2 AND settled_at IS NOT NULL ORDER BY fill_id DESC`,
    [bookId, instrumentId],
  );
  const older = byFill.rows.slice(0, 2);
  const newer = byFill.rows.slice(2);
  await db.admin.query(
    `UPDATE economy.spot_fill SET settled_at = CASE WHEN fill_id = ANY($3::text[]) THEN $4::timestamptz ELSE $5::timestamptz END
     WHERE book_id = $1 AND instrument_id = $2 AND settled_at IS NOT NULL`,
    [bookId, instrumentId, older.map((row) => row.fill_id), low, high],
  );
  const first = await call(app, path, readOnlyToken);
  expect(first.status).toBe(200);
  const page = await first.json();
  expect(page.trades.map((trade: { lots: string; settledAt: string }) => [trade.lots, trade.settledAt])).toEqual(
    newer.map((row) => [row.lots, high]),
  );
  expect(page.next).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]+$/));
  expect(Buffer.from(page.next, 'base64url').includes(Buffer.from(newer.at(-1)!.fill_id))).toBe(false);
  const follow = await call(app, `${path}?limit=20&cursor=${page.next}`, viewerToken);
  expect(follow.status).toBe(200);
  const last = await follow.json();
  expect(last.trades.map((trade: { lots: string; settledAt: string }) => [trade.lots, trade.settledAt])).toEqual(
    older.map((row) => [row.lots, low]),
  );
  expect(last.next).toBeNull();

  const one = await call(app, `${path}?limit=1`, readOnlyToken);
  const firstTie = await one.json();
  expect(one.status).toBe(200);
  expect(firstTie.trades[0]).toMatchObject({ lots: newer[0]!.lots, settledAt: high });
  const two = await call(app, `${path}?limit=1&cursor=${firstTie.next}`, readOnlyToken);
  expect(two.status).toBe(200);
  expect((await two.json()).trades).toEqual([expect.objectContaining({ lots: newer[1]!.lots, settledAt: high })]);

  const cursor = `?cursor=${page.next}`;
  const otherBook = mount(createNativeEconomySpot(db.pool, { bookId: `${bookId}-other`, node: 'b' }));
  for (const response of [
    await call(app, `${path}${cursor}`, secondToken),
    await call(app, `${marketPath}/trades${cursor}`, readOnlyToken),
    await call(otherBook, `${path}${cursor}`, readOnlyToken),
    await call(app, `${path}${cursor}&limit=1`, readOnlyToken),
    await call(app, `${path}?cursor=invalid`, readOnlyToken),
  ]) {
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'invalid_cursor' });
  }
  expect((await call(app, `${path}?limit=101`, readOnlyToken)).status).toBe(400);
  expect((await call(app, '/v1/economy/spot/absent/trades', readOnlyToken)).status).toBe(404);
  expect((await call(app, path, placeOnlyToken)).status).toBe(403);
  expect((await call(app, path, ordinaryToken)).status).toBe(403);
  expect((await call(closed, path)).status).toBe(403);
  expect((await call(closed, path, readOnlyToken)).status).toBe(503);

  await db.admin.query(
    `DELETE FROM access.resource_grant WHERE route = 0 AND resource_id = $1 AND subject_id = $2 AND action = 'gate:economy'`,
    [GLOBAL_CONTEXT.id, viewer],
  );
  expect((await call(app, `${path}${cursor}`, readOnlyToken)).status).toBe(403);
  await expect(spot.readTrades({ ...scope(viewer), limit: 20, after: null })).rejects.toMatchObject({
    code: 'platform_closed',
  });
}, 90_000);
