import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { createAccess } from '../../src/access/index.ts';
import { createNativeEconomyLedger } from '../../src/composition/economy.ts';
import { createNativeEconomySpot, createNativeEconomySpotWork } from '../../src/composition/economy-spot.ts';
import type { SpotQuote, SpotTrade } from '../../src/economy/contract.ts';
import type { SpotAccessPort } from '../../src/economy/spot-routes.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
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
let marketOnlyToken: string;
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
  [sellerToken, readOnlyToken, placeOnlyToken, viewerToken, secondToken, ordinaryToken, marketOnlyToken] =
    await Promise.all([
      sign(seller, scopes),
      sign(viewer, ['spot:read']),
      sign(viewer, ['spot:place']),
      sign(viewer, scopes),
      sign(second, scopes),
      sign(ordinary, scopes),
      sign(viewer, ['market:read']),
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
  expect(hiddenPaths['/v1/economy/spot']).toBeUndefined();
  expect(hiddenPaths['/v1/economy/spot/{instrumentId}']).toBeUndefined();
  expect(hiddenPaths['/v1/economy/spot/{instrumentId}/orders']).toBeUndefined();
  expect(hiddenPaths['/v1/economy/spot/{instrumentId}/trades']).toBeUndefined();
  expect(hiddenPaths['/v1/economy/spot/{instrumentId}/quote']).toBeUndefined();
  expect(hiddenPaths['/v1/economy/spot/{instrumentId}/orders/{orderId}/fills']).toBeUndefined();
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
  const emptyFills = await call(app, `${orderPath}/fills`, sellerToken);
  expect(emptyFills.status).toBe(200);
  expect(await emptyFills.json()).toEqual({ fills: [], next: null });
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
  const fillsPath = `/v1/economy/spot/${instrumentId}/orders/bid/fills`;
  const ownFirst = await call(app, fillsPath, secondToken);
  expect(ownFirst.status).toBe(200);
  expect(ownFirst.headers.get('cache-control')).toBe('private, no-store');
  const ownPage = await ownFirst.json();
  expect(ownPage.fills).toHaveLength(20);
  expect(ownPage.fills.every((fill: { status: string }) => fill.status === 'pending')).toBe(true);
  expect(ownPage.next).toEqual(expect.stringMatching(/^[A-Za-z0-9_-]+$/));

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

  const ownerAfter = await call(app, `${fillsPath}?limit=20&cursor=${ownPage.next}`, secondToken);
  expect(ownerAfter.status).toBe(200);
  const remaining = await ownerAfter.json();
  const allOwner = await call(app, `${fillsPath}?limit=100`, secondToken);
  expect(allOwner.status).toBe(200);
  const allFills = await allOwner.json();
  expect(allFills.fills).toHaveLength(23);
  expect(allFills.next).toBeNull();
  expect(remaining).toEqual({ fills: allFills.fills.slice(20), next: null });
  expect(ownPage.fills.map((fill: { lots: string }) => fill.lots)).toEqual(
    allFills.fills.slice(0, 20).map((fill: { lots: string }) => fill.lots),
  );
  expect((await call(app, `${fillsPath}?limit=101`, secondToken)).status).toBe(400);

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

test('a private order fill page merges both matching roles and exposes only the owner’s settlement and fee', async () => {
  const instrumentId = 'owner-fill-pair';
  const { bookId } = spot;
  const price = 9_007_199_254_740_993n;
  const bidPrice = price + 10n;
  const unitsPerLot = 10_000_000_000_000_000n;
  const makerFeeBps = 1250n;
  const takerFeeBps = 2500n;
  const expectedFee = (p: bigint, bps: bigint, lots: bigint) => (((p * bps + 9999n) / 10_000n) * lots).toString();

  expect(
    await work.provision({
      id: instrumentId,
      ledgerBookId: bookId,
      policyVersion: 1n,
      baseAssetId: 'base',
      quoteAssetId: 'quote',
      baseUnitsPerLot: unitsPerLot,
      quoteUnitsPerPriceTick: 1n,
      makerFeeBps,
      takerFeeBps,
      feeAccountId: crypto.randomUUID(),
    }),
  ).toMatchObject({ kind: 'ok' });
  for (const [accountId, assetId, amount] of [
    [seller, 'base', '200000000000000000'],
    [second, 'quote', '500000000000000000'],
  ] as const) {
    expect(await ledger.issue({ accountId, assetId, amount, operationId: 'owner-fills-opening' })).toMatchObject({
      kind: 'ok',
    });
  }
  async function matchOrder(accountId: string, orderId: string, side: 'buy' | 'sell', p: bigint, lots: bigint) {
    const order = await spot.place({
      accountId,
      instrumentId,
      orderId,
      side,
      price: p,
      lots,
      deadline: Date.now() + 2000,
    });
    if (order.kind !== 'ok') throw new Error(`Placement failed: ${order.kind}`);
    const step = await work.match(instrumentId, order.value.sequence);
    if (step.kind !== 'ok') throw new Error(`Matching failed: ${step.kind}`);
    return step.value;
  }

  expect(await matchOrder(seller, 'early-ask', 'sell', price, 7n)).toMatchObject({ status: 'resting', fillIds: [] });
  const taker = await matchOrder(second, 'one-bid', 'buy', bidPrice, 12n);
  expect(taker).toMatchObject({ status: 'resting', fillIds: [expect.any(String)] });
  const maker = await matchOrder(seller, 'later-ask', 'sell', price, 5n);
  expect(maker).toMatchObject({ status: 'filled', fillIds: [expect.any(String)] });
  const takerFill = taker.fillIds[0]!;
  const makerFill = maker.fillIds[0]!;
  const claim = await work.claimFill(takerFill);
  if (claim.kind !== 'ok') throw new Error(`Claim failed: ${claim.kind}`);
  expect(await work.settleFill(takerFill, claim.value.token)).toEqual({
    kind: 'ok',
    value: { operationId: takerFill },
  });

  const settledAt = '2026-11-21T00:00:00.123457Z';
  await db.admin.query('UPDATE economy.spot_fill SET settled_at = $3 WHERE book_id = $1 AND fill_id = $2', [
    bookId,
    takerFill,
    settledAt,
  ]);
  const path = (orderId: string, instrument = instrumentId) => `/v1/economy/spot/${instrument}/orders/${orderId}/fills`;
  const bid = path('one-bid');
  const pending = {
    price: bidPrice.toString(),
    lots: '5',
    baseUnits: (unitsPerLot * 5n).toString(),
    quoteUnits: (bidPrice * 5n).toString(),
    quoteFeeUnits: expectedFee(bidPrice, makerFeeBps, 5n),
    status: 'pending',
  };
  const settled = {
    price: price.toString(),
    lots: '7',
    baseUnits: (unitsPerLot * 7n).toString(),
    quoteUnits: (price * 7n).toString(),
    quoteFeeUnits: expectedFee(price, takerFeeBps, 7n),
    status: 'settled',
    settledAt,
  };
  const response = await call(app, bid, secondToken);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ fills: [pending, settled], next: null });
  expect(await (await call(app, path('early-ask'), sellerToken)).json()).toEqual({
    fills: [{ ...settled, quoteFeeUnits: expectedFee(price, makerFeeBps, 7n) }],
    next: null,
  });
  expect(await (await call(app, path('later-ask'), sellerToken)).json()).toEqual({
    fills: [{ ...pending, quoteFeeUnits: expectedFee(bidPrice, takerFeeBps, 5n) }],
    next: null,
  });
  expect((await call(app, bid, sellerToken)).status).toBe(404);
  expect((await call(app, path('absent'), secondToken)).status).toBe(404);

  const start = await call(app, `${bid}?limit=1`, secondToken);
  const first = await start.json();
  expect(start.status).toBe(200);
  expect(first).toEqual({ fills: [pending], next: expect.stringMatching(/^[A-Za-z0-9_-]+$/) });
  expect(Buffer.from(first.next, 'base64url').includes(Buffer.from(makerFill))).toBe(false);
  const follow = `?limit=1&cursor=${first.next}`;
  const laterClaim = await work.claimFill(makerFill);
  if (laterClaim.kind !== 'ok') throw new Error(`Claim failed: ${laterClaim.kind}`);
  expect(await work.settleFill(makerFill, laterClaim.value.token)).toMatchObject({ kind: 'ok' });
  await db.admin.query('UPDATE economy.spot_fill SET settled_at = $3 WHERE book_id = $1 AND fill_id = $2', [
    bookId,
    makerFill,
    settledAt,
  ]);
  expect(await (await call(app, `${bid}${follow}`, secondToken)).json()).toEqual({ fills: [settled], next: null });
  expect(await (await call(app, bid, secondToken)).json()).toEqual({
    fills: [{ ...pending, status: 'settled', settledAt }, settled],
    next: null,
  });

  const differentBook = mount(createNativeEconomySpot(db.pool, { bookId: `${bookId}-other`, node: 'b' }));
  for (const mismatch of [
    await call(app, `${bid}${follow}`, sellerToken),
    await call(app, `${path('early-ask')}${follow}`, secondToken),
    await call(app, `${path('one-bid', 'pair')}${follow}`, secondToken),
    await call(differentBook, `${bid}${follow}`, secondToken),
    await call(app, `${bid}?limit=2&cursor=${first.next}`, secondToken),
    await call(app, `${bid}?cursor=invalid`, secondToken),
  ]) {
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ code: 'invalid_cursor' });
  }

  await grant(viewer);
  expect((await call(app, bid, placeOnlyToken)).status).toBe(403);
  expect((await call(app, bid, ordinaryToken)).status).toBe(403);
  expect((await call(closed, bid)).status).toBe(403);
  expect((await call(closed, bid, secondToken)).status).toBe(503);
  const metadata = openApiDocument(app).paths['/v1/economy/spot/{instrumentId}/orders/{orderId}/fills']?.get;
  expect(metadata).toMatchObject({
    operationId: 'spot.read_order_fills',
    'x-exposure': 'gate:economy',
    'x-action': 'spot:read',
    'x-authority-anchor': 'own-account',
    'x-authority-resource-types': ['access.account'],
    security: [{ bearerAuth: [] }],
  });

  await db.admin.query(
    `DELETE FROM access.resource_grant WHERE route = 0 AND resource_id = $1 AND subject_id = $2 AND action = 'gate:economy'`,
    [GLOBAL_CONTEXT.id, second],
  );
  expect((await call(app, `${bid}${follow}`, secondToken)).status).toBe(403);
  await expect(
    spot.readOrderFills({
      accountId: second,
      instrumentId,
      orderId: 'one-bid',
      limit: 1,
      after: null,
      deadline: Date.now() + 2000,
    }),
  ).rejects.toMatchObject({ code: 'platform_closed' });
}, 90_000);

test('private discovery returns installed instruments and seeks only the actor’s exact order history', async () => {
  const bookId = `http:discovery-${crypto.randomUUID()}`;
  const binding = { bookId, node: 'b' };
  const owner = createNativeEconomySpot(db.pool, binding);
  const native = createNativeEconomySpotWork(db.pool, binding);
  const wallet = createNativeEconomyLedger(db.pool, bookId);
  const discovery = mount(owner);
  const otherBook = mount(createNativeEconomySpot(db.pool, { ...binding, bookId: `${bookId}-other` }));
  const catalog = '/v1/economy/spot';
  const ids = Array.from({ length: 22 }, (_, index) => `catalog-${String(index).padStart(2, '0')}`);
  const instrumentId = ids[0]!;
  const orders = `${catalog}/${instrumentId}/orders`;

  await grant(second);
  const empty = await call(discovery, catalog, sellerToken);
  expect(empty.status).toBe(200);
  expect(await empty.json()).toEqual({ instruments: [], next: null });
  expect((await call(discovery, orders, sellerToken)).status).toBe(404);

  for (const id of ['base', 'quote']) {
    expect(await wallet.provisionAsset({ id, scale: 0, transferable: true })).toMatchObject({ kind: 'ok' });
  }
  for (const accountId of [seller, second]) {
    expect(
      await wallet.issue({
        accountId,
        assetId: 'base',
        amount: '50000000000000000',
        operationId: 'discovery-base',
      }),
    ).toMatchObject({ kind: 'ok' });
  }
  const feeAccountId = crypto.randomUUID();
  for (const id of ids.toReversed()) {
    const provisioned = await native.provision({
      id,
      ledgerBookId: bookId,
      policyVersion: 1n,
      baseAssetId: 'base',
      quoteAssetId: 'quote',
      baseUnitsPerLot: 1n,
      quoteUnitsPerPriceTick: 1n,
      makerFeeBps: 0n,
      takerFeeBps: 0n,
      feeAccountId,
    });
    if (provisioned.kind !== 'ok') throw new Error(`Provisioning failed: ${provisioned.kind}`);
  }
  const emptyOrders = await call(discovery, orders, sellerToken);
  expect(emptyOrders.status).toBe(200);
  expect(await emptyOrders.json()).toEqual({ orders: [], next: null });

  const firstList = await call(discovery, catalog, sellerToken);
  expect(firstList.status).toBe(200);
  expect(firstList.headers.get('cache-control')).toBe('private, no-store');
  const firstCatalog = await firstList.json();
  expect(firstCatalog.instruments.map((row: { instrumentId: string }) => row.instrumentId)).toEqual(ids.slice(0, 20));
  expect(firstCatalog.instruments[0]).toEqual(
    await (await call(discovery, `${catalog}/${instrumentId}`, sellerToken)).json(),
  );
  const catalogCursor = `?limit=20&cursor=${firstCatalog.next}`;
  const lastCatalog = await call(discovery, `${catalog}${catalogCursor}`, sellerToken);
  expect(lastCatalog.status).toBe(200);
  const last = await lastCatalog.json();
  expect(last.instruments.map((row: { instrumentId: string }) => row.instrumentId)).toEqual(ids.slice(20));
  expect(last.next).toBeNull();
  expect((await call(discovery, `${catalog}?limit=101`, sellerToken)).status).toBe(400);
  expect((await call(discovery, `${orders}?limit=101`, sellerToken)).status).toBe(400);

  // The first two own orders straddle a decimal digit boundary above Number.MAX_SAFE_INTEGER.
  const earlier = 9_999_999_999_999_999n;
  await db.admin.query('UPDATE economy.spot_instrument SET revision = $3 WHERE book_id = $1 AND instrument_id = $2', [
    bookId,
    instrumentId,
    (earlier - 1n).toString(),
  ]);
  const amount = 9_007_199_254_740_993n;
  async function accept(accountId: string, orderId: string, rest: boolean, terms = { price: amount, lots: 1n }) {
    const accepted = await owner.place({
      accountId,
      instrumentId,
      orderId,
      deadline: Date.now() + 2000,
      side: 'sell',
      ...terms,
    });
    if (accepted.kind !== 'ok') throw new Error(`Order rejected: ${accepted.kind}`);
    if (rest)
      expect(await native.match(instrumentId, accepted.value.sequence)).toMatchObject({
        kind: 'ok',
        value: { status: 'resting' },
      });
    return accepted.value.sequence.toString();
  }
  expect(await accept(seller, 'old-own', true, { price: 1n, lots: amount })).toBe(earlier.toString());
  const foreignSequence = await accept(second, 'foreign', true);
  const newer = await accept(seller, 'new-own', true);
  const firstOrder = await call(discovery, `${orders}?limit=1`, sellerToken);
  expect(firstOrder.status).toBe(200);
  expect(firstOrder.headers.get('cache-control')).toBe('private, no-store');
  const orderPage = await firstOrder.json();
  expect(orderPage).toEqual({
    orders: [
      {
        instrumentId,
        policyVersion: '1',
        orderId: 'new-own',
        sequence: newer,
        price: amount.toString(),
        lots: '1',
        remainingLots: '1',
        side: 'sell',
        status: 'resting',
      },
    ],
    next: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
  });
  expect(orderPage.orders[0]).toEqual(await (await call(discovery, `${orders}/new-own`, sellerToken)).json());

  const late = await accept(seller, 'late-own', false);
  const orderCursor = `?limit=1&cursor=${orderPage.next}`;
  const continued = await call(discovery, `${orders}${orderCursor}`, sellerToken);
  expect(continued.status).toBe(200);
  expect(await continued.json()).toEqual({
    orders: [
      expect.objectContaining({
        orderId: 'old-own',
        sequence: earlier.toString(),
        price: '1',
        lots: amount.toString(),
        remainingLots: amount.toString(),
      }),
    ],
    next: null,
  });
  const restarted = await (await call(discovery, `${orders}?limit=100`, sellerToken)).json();
  expect(restarted.orders.map((row: { orderId: string; sequence: string }) => [row.orderId, row.sequence])).toEqual([
    ['late-own', late],
    ['new-own', newer],
    ['old-own', earlier.toString()],
  ]);
  expect(restarted.next).toBeNull();
  expect(await (await call(discovery, orders, secondToken)).json()).toEqual({
    orders: [expect.objectContaining({ orderId: 'foreign', sequence: foreignSequence })],
    next: null,
  });
  expect(await (await call(discovery, orders, viewerToken)).json()).toEqual({ orders: [], next: null });

  for (const failure of [
    await call(discovery, `${catalog}${catalogCursor}`, secondToken),
    await call(otherBook, `${catalog}${catalogCursor}`, sellerToken),
    await call(discovery, `${catalog}?limit=1&cursor=${firstCatalog.next}`, sellerToken),
    await call(discovery, `${orders}${catalogCursor}`, sellerToken),
    await call(discovery, `${orders}${orderCursor}`, secondToken),
    await call(otherBook, `${orders}${orderCursor}`, sellerToken),
    await call(discovery, `${catalog}/${ids[1]}/orders${orderCursor}`, sellerToken),
    await call(discovery, `${orders}?limit=2&cursor=${orderPage.next}`, sellerToken),
  ]) {
    expect(failure.status).toBe(400);
    expect(await failure.json()).toMatchObject({ code: 'invalid_cursor' });
  }

  for (const path of [catalog, orders]) {
    expect((await call(discovery, path, placeOnlyToken)).status).toBe(403);
    expect((await call(discovery, path, ordinaryToken)).status).toBe(403);
    expect((await call(closed, path)).status).toBe(403);
    expect((await call(closed, path, sellerToken)).status).toBe(503);
  }
  await db.admin.query(
    `DELETE FROM access.resource_grant WHERE route = 0 AND resource_id = $1 AND subject_id = $2 AND action = 'gate:economy'`,
    [GLOBAL_CONTEXT.id, seller],
  );
  expect((await call(discovery, `${catalog}${catalogCursor}`, sellerToken)).status).toBe(403);
  expect((await call(discovery, `${orders}${orderCursor}`, sellerToken)).status).toBe(403);
  const pageScope = { accountId: seller, deadline: Date.now() + 2000, limit: 1, after: null };
  await expect(owner.listInstruments(pageScope)).rejects.toMatchObject({ code: 'platform_closed' });
  await expect(owner.listOwnOrders({ ...pageScope, instrumentId })).rejects.toMatchObject({ code: 'platform_closed' });
}, 90_000);

test('the signed quote follows resting prices and only the exact latest settled trade', async () => {
  const instrumentId = 'quote-pair';
  const { bookId } = spot;
  const root = `/v1/economy/spot/${instrumentId}`;
  const path = `${root}/quote`;
  const center = 9_007_199_254_741_093n;
  const deepBid = center - 20n;
  const bestBid = center - 10n;
  const bestAsk = center + 10n;
  const deepAsk = center + 20n;
  const baseUnits = 9_007_199_254_740_995n;
  await grant(seller);
  expect(
    await work.provision({
      id: instrumentId,
      ledgerBookId: bookId,
      policyVersion: 1n,
      baseAssetId: 'base',
      quoteAssetId: 'quote',
      baseUnitsPerLot: baseUnits,
      quoteUnitsPerPriceTick: 1n,
      makerFeeBps: 0n,
      takerFeeBps: 0n,
      feeAccountId: crypto.randomUUID(),
    }),
  ).toMatchObject({ kind: 'ok' });
  for (const [accountId, assetId] of [
    [seller, 'base'],
    [second, 'quote'],
  ] as const) {
    expect(
      await ledger.issue({ accountId, assetId, amount: '100000000000000000', operationId: 'quote-opening' }),
    ).toMatchObject({ kind: 'ok' });
  }

  let revision = 0n;
  async function expectQuote(bestBid: bigint | null, bestAsk: bigint | null, latestTrade: SpotTrade | null) {
    const response = await call(app, path, readOnlyToken);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const expected = {
      revision: revision.toString(),
      bestBid: bestBid?.toString() ?? null,
      bestAsk: bestAsk?.toString() ?? null,
      latestTrade,
    } satisfies SpotQuote;
    expect(await response.json()).toEqual(expected);
  }
  await expectQuote(null, null, null);
  expect((await call(app, '/v1/economy/spot/missing-quote/quote', readOnlyToken)).status).toBe(404);

  revision = 9_007_199_254_740_993n;
  await db.admin.query('UPDATE economy.spot_instrument SET revision = $3 WHERE book_id = $1 AND instrument_id = $2', [
    bookId,
    instrumentId,
    revision.toString(),
  ]);

  async function place(accountId: string, orderId: string, side: 'buy' | 'sell', price: bigint) {
    const accepted = await spot.place({
      accountId,
      instrumentId,
      orderId,
      side,
      price,
      lots: 1n,
      deadline: Date.now() + 2000,
    });
    if (accepted.kind !== 'ok') throw new Error(`Placement failed: ${accepted.kind}`);
    expect(accepted.value.sequence).toBe(++revision);
  }

  async function match(status: 'resting' | 'filled') {
    const matched = await work.match(instrumentId, revision);
    if (matched.kind !== 'ok') throw new Error(`Matching failed: ${matched.kind}`);
    expect(matched.value.status).toBe(status);
    expect(matched.value.revision).toBe(++revision);
    return matched.value.fillIds;
  }

  async function settle(fillId: string, price: bigint, settledAt: string) {
    const claim = await work.claimFill(fillId);
    if (claim.kind !== 'ok') throw new Error(`Claim failed: ${claim.kind}`);
    expect(await work.settleFill(fillId, claim.value.token)).toEqual({ kind: 'ok', value: { operationId: fillId } });
    await db.admin.query('UPDATE economy.spot_fill SET settled_at = $3 WHERE book_id = $1 AND fill_id = $2', [
      bookId,
      fillId,
      settledAt,
    ]);
    return {
      price: price.toString(),
      lots: '1',
      baseUnits: baseUnits.toString(),
      quoteUnits: price.toString(),
      settledAt,
    };
  }

  await place(second, 'deep-bid', 'buy', deepBid);
  await expectQuote(null, null, null);
  await match('resting');
  await place(second, 'best-bid', 'buy', bestBid);
  await match('resting');
  await expectQuote(bestBid, null, null);
  await place(seller, 'deep-ask', 'sell', deepAsk);
  await match('resting');
  await place(seller, 'best-ask', 'sell', bestAsk);
  await match('resting');
  await expectQuote(bestBid, bestAsk, null);

  await place(second, 'cross-ask', 'buy', bestAsk);
  await expectQuote(bestBid, bestAsk, null);
  const [buyFill] = await match('filled');
  await expectQuote(bestBid, deepAsk, null);
  const older = await settle(buyFill!, bestAsk, '2026-11-21T00:00:00.123456Z');
  await expectQuote(bestBid, deepAsk, older);

  await place(seller, 'cross-bid', 'sell', bestBid);
  const [sellFill] = await match('filled');
  await expectQuote(deepBid, deepAsk, older);
  const latest = await settle(sellFill!, bestBid, '2026-11-21T00:00:00.123457Z');
  await expectQuote(deepBid, deepAsk, latest);
  const feed = await call(app, `${root}/trades?limit=1`, readOnlyToken);
  expect(feed.status).toBe(200);
  expect((await feed.json()).trades).toEqual([latest]);

  for (const token of [placeOnlyToken, marketOnlyToken, ordinaryToken]) {
    expect((await call(app, path, token)).status).toBe(403);
  }
  expect((await call(closed, path)).status).toBe(403);
  expect((await call(closed, path, readOnlyToken)).status).toBe(503);
  expect(openApiDocument(app).paths['/v1/economy/spot/{instrumentId}/quote']?.get).toMatchObject({
    operationId: 'spot.read_quote',
    'x-exposure': 'gate:economy',
    'x-action': 'spot:read',
    'x-authority-anchor': 'own-account',
    'x-authority-resource-types': ['access.account'],
    security: [{ bearerAuth: [] }],
  });
  await db.admin.query(
    `DELETE FROM access.resource_grant WHERE route = 0 AND resource_id = $1 AND subject_id = $2 AND action = 'gate:economy'`,
    [GLOBAL_CONTEXT.id, viewer],
  );
  expect((await call(app, path, readOnlyToken)).status).toBe(403);
  await expect(spot.readQuote({ accountId: viewer, instrumentId, deadline: Date.now() + 2000 })).rejects.toMatchObject({
    code: 'platform_closed',
  });
}, 90_000);
