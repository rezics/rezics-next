import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { Pool } from 'pg';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { createNativeEconomyMarketRepair } from '../../src/composition/economy-market-repair.ts';
import { enqueueMarketRepair } from '../../src/economy/storage/market-repair.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { insertRetainedTrades, retainedTrade } from './fixtures/market-trades.ts';

const issuer = 'https://auth.market-repair.test';
const audience = 'https://api.rezics.test';
const operator = newId(0x6533);
const governor = newId(0x6534);
const buyer = newId(0x6535);
const seller = newId(0x6536);
const action = 'market:repair';
const gate = 'gate:economy';
const basePath = '/v1/economy/market/trades';
const documentPath = `${basePath}/{tradeId}:repair`;
const bookId = `repair-access:${crypto.randomUUID()}`;
const itemHomeId = `repair-items:${crypto.randomUUID()}`;
const owner = { bookId, itemHomeId, node: 'b' };
const tradeId = 'a1'.repeat(32);
const otherTradeId = 'b2'.repeat(32);
const foreignBookTrade = 'c3'.repeat(32);
const foreignHomeTrade = 'd4'.repeat(32);
const rolledBackTrade = 'e5'.repeat(32);
const absentTrade = 'f6'.repeat(32);
const marker = 'com.rezics.economy.market.repair_accepted.v1';
let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let mount: (pool?: Pool) => ReturnType<typeof createKernel>;
let governorToken: string;
let repairToken: string;
let readToken: string;

beforeAll(async () => {
  db = await openGrowthDatabase();
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), alg: 'ES256', kid: 'economy-market-repair' };
  const sign = (sub: string, scopes: readonly string[]) =>
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
  for (const id of [operator, governor, buyer, seller]) {
    await db.admin.query(
      "INSERT INTO access.account (route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [routeOf(id), id],
    );
  }
  const at = BigInt(Date.now());
  await insertRetainedTrades(
    db.admin,
    [
      { ...owner, tradeId },
      { ...owner, tradeId: otherTradeId },
      { ...owner, bookId: 'foreign-repair-book', tradeId: foreignBookTrade },
      { ...owner, itemHomeId: 'foreign-repair-home', tradeId: foreignHomeTrade },
      { ...owner, tradeId: rolledBackTrade },
    ].map((binding) => retainedTrade({ ...binding, startedAt: at, buyerId: buyer, sellerId: seller })),
  );
  [governorToken, repairToken, readToken] = await Promise.all([
    sign(governor, ['access:grant', action, 'gate:any']),
    sign(operator, [action]),
    sign(operator, ['market:read']),
  ]);
  mount = (pool = db.pool) =>
    createKernel({
      pool,
      routeKey: new Uint8Array(32),
      economyMarketRepair: createNativeEconomyMarketRepair(pool, owner, async (tx, input) => {
        const accepted = await enqueueMarketRepair(tx, input);
        if (input.tradeId === rolledBackTrade && accepted.kind === 'queued') return { kind: 'invalid_owner_request' };
        return accepted;
      }),
      access: (config) =>
        createAccess({
          ...config,
          auth: { issuer, audience, jwksUrl: `${issuer}/jwks`, fetch: async () => Response.json({ keys: [jwk] }) },
        }),
      writeRate: {
        async spend() {
          return { allowed: true as const };
        },
      },
    });
  app = mount();
  await bootstrapGovernance(db.pool, governor);
}, 90_000);

afterAll(async () => {
  await db?.close();
});

function call(path: string, token?: string, body?: object, key = crypto.randomUUID(), kernel = app) {
  return kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(key) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

const repairPath = (id: string) => `${basePath}/${id}:repair`;

async function grant(requestedAction: string, revoke = false) {
  const response = await call(revoke ? '/v1/grants:revoke' : '/v1/grants', governorToken, {
    resource: PLATFORM_RESOURCE,
    subject: { kind: 'account', id: operator },
    actions: [requestedAction],
    valid: '(,)',
  });
  expect(response.status, await response.text()).toBe(revoke ? 200 : 201);
}

async function discover(token: string, visible: boolean) {
  const document = await call('/v1/openapi.json', token);
  expect(document.status).toBe(200);
  const operation = (await document.json()).paths[documentPath]?.post;
  if (visible)
    expect(operation).toMatchObject({
      operationId: 'market.repair_trade',
      'x-exposure': gate,
      'x-action': action,
      'x-authority-resource-id': PLATFORM_RESOURCE.id,
    });
  else expect(operation).toBeUndefined();
}

test('native market repair requires both grants, reauthorizes receipts and commits one private queued job', async () => {
  const key = crypto.randomUUID();
  const denied = async (token: string | undefined, code: string) => {
    const response = await call(repairPath(tradeId), token, {}, key);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code });
  };
  await denied(undefined, 'platform_closed');
  await denied(repairToken, 'platform_closed');
  await discover(repairToken, false);
  await grant(action);
  await denied(repairToken, 'platform_closed');
  await grant('gate:any');
  await denied(repairToken, 'platform_closed');
  await discover(repairToken, false);

  await grant(action, true);
  await grant(gate);
  await denied(repairToken, 'forbidden');
  await discover(repairToken, false);
  await grant(action);
  await denied(readToken, 'platform_closed');
  await discover(readToken, false);
  await discover(repairToken, true);

  for (const id of [absentTrade, foreignBookTrade, foreignHomeTrade]) {
    const response = await call(repairPath(id), repairToken, {});
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'not_found' });
  }
  expect((await call(repairPath(tradeId), repairToken, { itemHomeId: 'forged' })).status).toBe(400);
  const failed = await call(repairPath(rolledBackTrade), repairToken, {});
  expect(failed.status).toBe(503);
  expect(await failed.json()).toMatchObject({ code: 'dependency_unavailable' });
  const empty = await db.admin.query('SELECT count(*)::int AS n FROM economy.market_repair_request WHERE book_id=$1', [
    bookId,
  ]);
  expect(empty.rows[0]).toEqual({ n: 0 });

  const accepted = await call(repairPath(tradeId), repairToken, {}, key);
  expect(accepted.status).toBe(202);
  expect(accepted.headers.get('cache-control')).toBe('private, no-store');
  expect(await accepted.json()).toEqual({ reconciliation: 'queued' });
  const restarted = mount(db.openPool());
  const replayed = await call(repairPath(tradeId), repairToken, {}, key, restarted);
  expect(replayed.status).toBe(202);
  expect(await replayed.json()).toEqual({ reconciliation: 'queued' });
  const conflict = await call(repairPath(otherTradeId), repairToken, {}, key, restarted);
  expect(conflict.status).toBe(422);
  expect(await conflict.json()).toMatchObject({ code: 'idempotency_conflict' });

  await grant(action, true);
  await denied(repairToken, 'forbidden');
  await discover(repairToken, false);
  await grant(action);
  await grant(gate, true);
  await denied(repairToken, 'platform_closed');
  await discover(repairToken, false);

  const queue = await db.admin.query(
    `SELECT request.book_id AS "bookId", request.node, request.item_home_id AS "itemHomeId",
            request.trade_id AS "tradeId", request.attempts, request.finished_at AS "finishedAt",
            receipt.principal_id AS principal, receipt.response, event.type, event.subject, event.data
     FROM economy.market_repair_request AS request
     JOIN core.receipt AS receipt USING (transaction_id)
     JOIN core.outbox AS event USING (partition_no, position)
     WHERE request.book_id=$1`,
    [bookId],
  );
  expect(queue.rows).toEqual([
    {
      ...owner,
      tradeId,
      attempts: 0,
      finishedAt: null,
      principal: operator,
      response: { reconciliation: 'queued' },
      type: marker,
      subject: null,
      data: {},
    },
  ]);
  const receiptCount = await db.admin.query(
    "SELECT count(*)::int AS n FROM core.receipt WHERE principal_id=$1 AND command_kind='economy.market.repair'",
    [operator],
  );
  expect(receiptCount.rows[0]).toEqual({ n: 1 });
}, 120_000);
