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
let ledger: ReturnType<typeof createNativeEconomyLedger>;
let spot: SpotAccessPort;
let work: ReturnType<typeof createNativeEconomySpotWork>;
let sellerToken: string;
let readOnlyToken: string;
let viewerToken: string;
let secondToken: string;
let ordinaryToken: string;

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

async function grant(accountId: string, action = 'gate:economy', kind = 'identity') {
  await db.admin.query(
    `INSERT INTO access.resource_grant (route, resource_id, subject_id, subject_kind, action, valid, transaction_id)
     VALUES (0, $1, $2, $3, $4, '(,)', $5)`,
    [GLOBAL_CONTEXT.id, accountId, kind, action, Bun.randomUUIDv7()],
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
  [sellerToken, readOnlyToken, viewerToken, secondToken, ordinaryToken] = await Promise.all([
    sign(seller, scopes),
    sign(viewer, ['spot:read']),
    sign(viewer, scopes),
    sign(second, scopes),
    sign(ordinary, scopes),
  ]);
  const mount = (economySpot?: SpotAccessPort) =>
    createKernel({
      pool: db.pool,
      routeKey: new Uint8Array(32),
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
  await db?.close();
});

test('spot instrument and order routes require a direct grant, matching client scope, and installed native book', async () => {
  await grant(ordinary, 'gate:any');
  await grant('00000000-0000-0000-0000-000000000000', 'gate:economy', 'active_accounts');
  await db.admin.query(
    `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
     VALUES ('economy', tstzrange(statement_timestamp() - interval '1 second', NULL, '[)'), $1)`,
    [Bun.randomUUIDv7()],
  );
  for (const token of [undefined, ordinaryToken]) {
    expect((await call(closed, marketPath, token)).status).toBe(403);
    expect((await call(app, marketPath, token)).status).toBe(403);
    expect((await call(app, `${marketPath}/orders`, token, { method: 'POST', order })).status).toBe(403);
  }
  const hidden = await call(app, '/v1/openapi.json', ordinaryToken);
  expect(hidden.status).toBe(200);
  expect((await hidden.json()).paths['/v1/economy/spot/{instrumentId}']).toBeUndefined();
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
