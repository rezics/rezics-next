import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { createAccess } from '../../src/access/index.ts';
import type { EconomyWalletPort } from '../../src/economy/contract.ts';
import { createNativeEconomyLedger } from '../../src/composition/economy.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const sender = newId(0x6201);
const receiver = newId(0x6202);
const ordinary = newId(0x6203);
const missing = newId(0x6204);
const nativeSender = newId(0x6205);
const nativeReceiver = newId(0x6206);
const assetId = 'test-credit';
const walletPath = `/v1/economy/wallets/${assetId}`;
const issuer = 'https://auth.economy.test';
const audience = 'https://api.rezics.test';
const grant = 'gate:economy';
const scopes = ['wallet:read', 'wallet:transfer'];
const calls: Array<{ method: string; input: unknown }> = [];
const economy: EconomyWalletPort = {
  async readBalance(input) {
    calls.push({ method: 'readBalance', input });
    return {
      kind: 'ok',
      value: {
        asset: { id: input.assetId, scale: 0, transferable: true },
        posted: '9007199254740993',
        held: '0',
        restricted: '0',
        available: '9007199254740993',
      },
    };
  },
  async readStatement(input) {
    calls.push({ method: 'readStatement', input });
    return { kind: 'ok', value: { entries: [], next: null } };
  },
  async transfer(input) {
    calls.push({ method: 'transfer', input });
    return { kind: 'ok', value: { operationId: input.operationId } };
  },
};

let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let nativeApp: ReturnType<typeof createKernel>;
let ledger: ReturnType<typeof createNativeEconomyLedger>;
let senderToken: string;
let readOnlyToken: string;
let ordinaryToken: string;
let nativeSenderToken: string;
let nativeReceiverToken: string;

function request(path: string, token?: string, recipientId?: string, kernel = app) {
  return kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: recipientId === undefined ? 'GET' : 'POST',
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(recipientId === undefined
          ? {}
          : {
              'content-type': 'application/json',
              'idempotency-key': JSON.stringify('economy-transfer'),
            }),
      },
      ...(recipientId === undefined ? {} : { body: JSON.stringify({ recipientId, amount: '9007199254740993' }) }),
    }),
  );
}

async function addGrant(accountId: string, action: string, kind = 'identity') {
  await db.admin.query(
    `INSERT INTO access.resource_grant
     (route, resource_id, subject_id, subject_kind, action, valid, transaction_id)
     VALUES (0, $1, $2, $3, $4, '(,)', $5)`,
    [GLOBAL_CONTEXT.id, accountId, kind, action, Bun.randomUUIDv7()],
  );
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), alg: 'ES256', kid: 'economy-access' };
  const sign = (accountId: string, scopes: readonly string[]) =>
    new SignJWT({
      client_id: 'web',
      authn_epoch: 1,
      scope: scopes.join(' '),
      auth_time: Math.floor(Date.now() / 1000),
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: jwk.kid })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(accountId)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
  for (const id of [sender, receiver, ordinary, nativeSender, nativeReceiver]) {
    await db.admin.query(
      "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
      [routeOf(id), id],
    );
  }
  [senderToken, readOnlyToken, ordinaryToken, nativeSenderToken, nativeReceiverToken] = await Promise.all([
    sign(sender, scopes),
    sign(sender, ['wallet:read']),
    sign(ordinary, scopes),
    sign(nativeSender, scopes),
    sign(nativeReceiver, ['wallet:read']),
  ]);
  const mount = (port: EconomyWalletPort) =>
    createKernel({
      pool: db.pool,
      routeKey: new Uint8Array(32),
      economy: port,
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
  app = mount(economy);
  ledger = createNativeEconomyLedger(db.pool, `http:${crypto.randomUUID()}`);
  nativeApp = mount(ledger);
});

afterAll(async () => {
  await db?.close();
});

test('Economy admission, discovery and replay require the exact current account grant', async () => {
  await addGrant(ordinary, 'gate:any');
  await addGrant('00000000-0000-0000-0000-000000000000', grant, 'active_accounts');
  await db.admin.query(
    `INSERT INTO access.exposure_opening ("group", valid, transaction_id) VALUES ('economy', tstzrange(statement_timestamp() - interval '1 second', NULL, '[)'), $1)`,
    [Bun.randomUUIDv7()],
  );
  for (const token of [undefined, ordinaryToken, senderToken]) {
    for (const [suffix, recipientId] of [
      ['', undefined],
      ['/statement', undefined],
      ['/transfers', receiver],
    ] as const) {
      const denied = await request(`${walletPath}${suffix}`, token, recipientId);
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: 'platform_closed' });
    }
  }
  expect(calls).toEqual([]);
  const hidden = await request('/v1/platform/exposure', ordinaryToken);
  expect(hidden.status).toBe(200);
  expect((await hidden.json()).admitted).not.toContain('economy');
  const hiddenDocument = await request('/v1/openapi.json', ordinaryToken);
  expect(hiddenDocument.status).toBe(200);
  expect((await hiddenDocument.json()).paths['/v1/economy/wallets/{assetId}']).toBeUndefined();

  await addGrant(sender, grant);
  await addGrant(receiver, grant);
  const admitted = await request('/v1/platform/exposure', senderToken);
  expect(admitted.status).toBe(200);
  expect((await admitted.json()).admitted).toContain('economy');
  const visibleDocument = await request('/v1/openapi.json', senderToken);
  expect(visibleDocument.status).toBe(200);
  expect((await visibleDocument.json()).paths['/v1/economy/wallets/{assetId}'].get['x-exposure']).toBe(grant);
  const balance = await request(walletPath, senderToken);
  expect(balance.status).toBe(200);
  expect(balance.headers.get('cache-control')).toBe('private, no-store');
  expect(await balance.json()).toMatchObject({ posted: '9007199254740993', available: '9007199254740993' });
  expect((await request(`${walletPath}/statement?before=8&limit=3`, senderToken)).status).toBe(200);

  const transferPath = `${walletPath}/transfers`;
  expect((await request(transferPath, readOnlyToken, receiver)).status).toBe(403);
  for (const recipientId of [ordinary, missing]) {
    const rejected = await request(transferPath, senderToken, recipientId);
    expect(rejected.status).toBe(404);
    expect(await rejected.json()).toMatchObject({ code: 'not_found' });
  }
  const transferred = await request(transferPath, senderToken, receiver);
  expect(transferred.status).toBe(200);
  expect(await transferred.json()).toEqual({ operationId: 'economy-transfer' });

  await db.admin.query(
    "DELETE FROM access.resource_grant WHERE route = 0 AND resource_id = $1 AND subject_id = $2 AND action = 'gate:economy'",
    [GLOBAL_CONTEXT.id, sender],
  );
  expect((await request(transferPath, senderToken, receiver)).status).toBe(403);
  expect(calls).toEqual([
    { method: 'readBalance', input: { accountId: sender, assetId } },
    { method: 'readStatement', input: { accountId: sender, assetId, before: '8', limit: 3 } },
    {
      method: 'transfer',
      input: {
        accountId: sender,
        assetId,
        recipientId: receiver,
        amount: '9007199254740993',
        operationId: 'economy-transfer',
      },
    },
  ]);
});

test('a private wallet transfer persists exact units and can be replayed through the native API', async () => {
  await addGrant(nativeSender, grant);
  await addGrant(nativeReceiver, grant);
  expect(await ledger.provisionAsset({ id: assetId, scale: 0, transferable: true })).toMatchObject({ kind: 'ok' });
  expect(
    await ledger.issue({
      accountId: nativeSender,
      assetId,
      amount: '9007199254741005',
      operationId: 'opening',
    }),
  ).toMatchObject({ kind: 'ok' });

  const transferPath = `${walletPath}/transfers`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const transfer = await request(transferPath, nativeSenderToken, nativeReceiver, nativeApp);
    expect(transfer.status).toBe(200);
    expect(await transfer.json()).toEqual({ operationId: 'economy-transfer' });
  }
  const senderWallet = await request(walletPath, nativeSenderToken, undefined, nativeApp);
  expect(senderWallet.status).toBe(200);
  expect(await senderWallet.json()).toMatchObject({ posted: '12', available: '12' });
  const receiverWallet = await request(walletPath, nativeReceiverToken, undefined, nativeApp);
  expect(receiverWallet.status).toBe(200);
  expect(await receiverWallet.json()).toMatchObject({ posted: '9007199254740993', available: '9007199254740993' });
  const statement = await request(`${walletPath}/statement`, nativeReceiverToken, undefined, nativeApp);
  expect(statement.status).toBe(200);
  const { entries, next } = await statement.json();
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ kind: 'transfer', postedDelta: '9007199254740993' });
  expect(entries[0].operationId).not.toBe('economy-transfer');
  expect(next).toBeNull();
});
