import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { createAccess } from '../../src/access/index.ts';
import { createNativeEconomyMarket, readEconomyMarketConfig } from '../../src/composition/economy-market.ts';
import { createNativeEconomyLedger } from '../../src/composition/economy.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const issuer = 'https://auth.market.test';
const audience = 'https://api.rezics.test';
const seller = newId(0x6531);
const buyer = newId(0x6532);
const viewer = newId(0x6533);
const ordinary = newId(0x6534);
const feeAccountId = crypto.randomUUID();
const bookId = `http-market:${crypto.randomUUID()}`;
const itemHomeId = `http-items:${crypto.randomUUID()}`;
const marketScope = ['market:read', 'market:list', 'market:buy', 'market:cancel'];
const base = '/v1/economy/market';
const assetId = 'test-market-credit';
const price = '9007199254740993';
let signer: (account: string, scopes: readonly string[]) => Promise<string>;
let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let closedApp: ReturnType<typeof createKernel>;
let native: ReturnType<typeof createNativeEconomyMarket>;
let ledger: ReturnType<typeof createNativeEconomyLedger>;

async function grant(account: string, action = 'gate:economy') {
  await db.admin.query(
    `INSERT INTO access.resource_grant (route, resource_id, subject_id, subject_kind, action, valid, transaction_id)
     VALUES (0, $1, $2, 'identity', $3, '(,)', $2)`,
    [GLOBAL_CONTEXT.id, account, action],
  );
}

async function revoke(account: string) {
  await db.admin.query(
    "DELETE FROM access.resource_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2 AND action='gate:economy'",
    [GLOBAL_CONTEXT.id, account],
  );
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), alg: 'ES256', kid: 'economy-market-access' };
  signer = (sub, scopes) =>
    new SignJWT({
      client_id: 'web',
      authn_epoch: 1,
      scope: scopes.join(' '),
      auth_time: Math.floor(Date.now() / 1000),
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);

  for (const id of [seller, buyer, viewer, ordinary]) {
    await db.admin.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [routeOf(id), id],
    );
  }
  for (const account of [seller, buyer, viewer]) await grant(account);
  await grant(ordinary, 'gate:any');
  native = createNativeEconomyMarket(db.pool, {
    bookId,
    node: 'b',
    itemHomeId,
    feeAccountId,
    feeBps: 2500n,
    policyVersion: 12n,
  });
  ledger = createNativeEconomyLedger(db.pool, bookId);
  const mount = (market?: typeof native.port) =>
    createKernel({
      pool: db.pool,
      routeKey: new Uint8Array(32),
      ...(market === undefined ? {} : { economyMarket: market }),
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
  app = mount(native.port);
  closedApp = mount();
  expect(await ledger.provisionAsset({ id: assetId, scale: 0, transferable: true })).toMatchObject({ kind: 'ok' });
  expect(
    await ledger.issue({ accountId: buyer, assetId, amount: '9007199254741093', operationId: 'issue' }),
  ).toMatchObject({ kind: 'ok' });
});

afterAll(async () => {
  await db?.close();
});

async function request(path: string, token?: string, command?: { key: string; body: object }, kernel = app) {
  return kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: command ? 'POST' : 'GET',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(command ? { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(command.key) } : {}),
      },
      ...(command ? { body: JSON.stringify(command.body) } : {}),
    }),
  );
}

const listingCommand = (itemId: string, key: string, amount = price) => ({
  key,
  body: { itemId, generation: '1', assetId, amount },
});
const operation = (key: string, revision = '0') => ({ key, body: { revision } });

test('private market uses exact grant and operator policy through the native fixed-price receipt', async () => {
  const sellerToken = await signer(seller, marketScope);
  const buyerToken = await signer(buyer, marketScope);
  const viewerToken = await signer(viewer, marketScope);
  const readOnly = await signer(seller, ['market:read']);
  const ordinaryToken = await signer(ordinary, marketScope);
  const listingRequest = listingCommand('first-item', 'listing');
  expect(await native.custody.register({ itemId: 'first-item', holderId: seller, marketable: true })).toMatchObject({
    kind: 'ok',
  });

  const paths = Object.entries(openApiDocument(app).paths).filter(([path]) => path.startsWith(`${base}/`));
  expect(paths).toHaveLength(5);
  for (const [, path] of paths)
    for (const entry of Object.values(path)) {
      expect(entry).toMatchObject({ 'x-exposure': 'gate:economy', security: [{ bearerAuth: [] }] });
    }
  expect((await request(`${base}/listings`, undefined, listingRequest)).status).toBe(403);
  expect((await request(`${base}/listings`, ordinaryToken, listingRequest)).status).toBe(403);
  expect((await request(`${base}/listings`, readOnly, listingRequest)).status).toBe(403);
  expect((await request(`${base}/listings`, sellerToken, listingRequest, closedApp)).status).toBe(503);
  expect((await request(`${base}/listings`, viewerToken, listingRequest)).status).toBe(404);
  expect(
    (
      await request(`${base}/listings`, sellerToken, {
        ...listingRequest,
        body: { ...listingRequest.body, feeAccountId: viewer },
      })
    ).status,
  ).toBe(400);
  const posted = await request(`${base}/listings`, sellerToken, listingRequest);
  expect(posted.status).toBe(200);
  const { listingId } = (await posted.json()) as { listingId: string };
  expect(await (await request(`${base}/listings`, sellerToken, listingRequest)).json()).toEqual({ listingId });
  expect((await request(`${base}/listings`, sellerToken, listingCommand('first-item', 'listing', '42'))).status).toBe(
    422,
  );
  const listingPath = `${base}/listings/${listingId}`;
  const listed = await request(listingPath, buyerToken);
  expect(listed.status).toBe(200);
  expect(listed.headers.get('cache-control')).toBe('private, no-store');
  expect(await listed.json()).toMatchObject({
    listingId,
    amount: price,
    generation: '1',
    revision: '0',
    status: 'open',
  });

  await revoke(seller);
  expect((await request(`${listingPath}/purchases`, buyerToken, operation('buy'))).status).toBe(404);
  expect((await request(listingPath, sellerToken)).status).toBe(403);
  const unbought = await db.admin.query('SELECT count(*)::int AS n FROM economy.market_trade WHERE book_id=$1', [
    bookId,
  ]);
  expect(unbought.rows[0]).toEqual({ n: 0 });
  await grant(seller);
  const buy = () => request(`${listingPath}/purchases`, buyerToken, operation('buy'));
  const [bought, replayed] = await Promise.all([buy(), buy()]);
  expect([bought.status, replayed.status]).toEqual([200, 200]);
  const { tradeId } = (await bought.json()) as { tradeId: string };
  const replay = await replayed.json();
  expect(replay).toEqual({ tradeId });
  expect((await request(`${listingPath}/purchases`, buyerToken, operation('buy', '1'))).status).toBe(422);
  expect((await request(listingPath, viewerToken)).status).toBe(404);
  expect((await request(`${listingPath}/purchases`, viewerToken, operation('hidden'))).status).toBe(404);
  expect((await request(`${base}/trades/${tradeId}`, viewerToken)).status).toBe(404);
  expect((await request(`${base}/trades/${tradeId}`, ordinaryToken)).status).toBe(403);
  expect((await request(`${base}/trades/${tradeId}`, sellerToken)).status).toBe(200);

  for (let phase = 0; phase < 4; phase++) expect((await native.sweep(8)).retry).toEqual([]);
  expect(await (await request(`${base}/trades/${tradeId}`, buyerToken)).json()).toEqual({
    tradeId,
    listingId,
    status: 'completed',
    assetId,
    amount: price,
    fee: '2251799813685248',
    sellerNet: '6755399441055745',
  });
  expect(await native.custody.readItem('first-item')).toMatchObject({ holderId: buyer, generation: 2n });
  expect(await ledger.readBalance({ accountId: seller, assetId })).toMatchObject({
    kind: 'ok',
    value: { posted: '6755399441055745' },
  });
  expect(await ledger.readBalance({ accountId: feeAccountId, assetId })).toMatchObject({
    kind: 'ok',
    value: { posted: '2251799813685248' },
  });
  const settled = await db.admin.query(
    'SELECT count(*)::int AS n FROM economy.market_funds_receipt WHERE book_id=$1 AND trade_id=$2',
    [bookId, tradeId],
  );
  expect(settled.rows[0]).toEqual({ n: 3 });
  await revoke(buyer);
  expect((await request(`${base}/trades/${tradeId}`, buyerToken)).status).toBe(403);
  expect((await request(`${listingPath}/purchases`, buyerToken, operation('buy'))).status).toBe(403);
});

test('listing cancellation stays with the current seller and replays without another custody release', async () => {
  const sellerToken = await signer(seller, marketScope);
  const viewerToken = await signer(viewer, marketScope);
  expect(await native.custody.register({ itemId: 'second-item', holderId: seller, marketable: true })).toMatchObject({
    kind: 'ok',
  });
  const posted = await request(`${base}/listings`, sellerToken, listingCommand('second-item', 'listing-two', '30'));
  expect(posted.status).toBe(200);
  const { listingId } = (await posted.json()) as { listingId: string };
  const listingPath = `${base}/listings/${listingId}`;
  expect((await request(`${listingPath}/cancel`, viewerToken, operation('cancel'))).status).toBe(404);
  expect(await (await request(`${listingPath}/cancel`, sellerToken, operation('cancel'))).json()).toEqual({
    listingId,
  });
  expect(await (await request(`${listingPath}/cancel`, sellerToken, operation('cancel'))).json()).toEqual({
    listingId,
  });
  expect((await request(`${listingPath}/cancel`, sellerToken, operation('different'))).status).toBe(422);
  expect((await request(listingPath, viewerToken)).status).toBe(404);
  expect((await native.sweep(8)).acknowledged).toEqual([`market:cancel:${listingId}`]);
  expect((await native.sweep(8)).acknowledged).toEqual([]);
  expect(await (await request(listingPath, sellerToken)).json()).toMatchObject({ status: 'cancelled' });
});

test('market configuration has no default and requires complete owner and fee bindings', () => {
  expect(readEconomyMarketConfig({})).toBeUndefined();
  const complete = {
    KERNEL_ECONOMY_MARKET_ITEM_HOME_ID: itemHomeId,
    KERNEL_ECONOMY_MARKET_FEE_ACCOUNT_ID: feeAccountId,
    KERNEL_ECONOMY_MARKET_FEE_BPS: '2500',
    KERNEL_ECONOMY_MARKET_POLICY_VERSION: '12',
  };
  expect(() => readEconomyMarketConfig({ ...complete, KERNEL_ECONOMY_MARKET_FEE_BPS: '10001' })).toThrow();
  expect(() => readEconomyMarketConfig({ KERNEL_ECONOMY_MARKET_ITEM_HOME_ID: itemHomeId })).toThrow();
  expect(readEconomyMarketConfig(complete)).toEqual({ itemHomeId, feeAccountId, feeBps: 2500n, policyVersion: 12n });
});
