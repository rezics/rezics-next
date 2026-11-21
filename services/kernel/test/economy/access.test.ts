import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { createAccess } from '../../src/access/index.ts';
import { createNativeEconomyTestFunding } from '../../src/composition/economy-test-funding.ts';
import type { EconomyWalletPort, WalletBalancePage } from '../../src/economy/contract.ts';
import { createNativeEconomyLedger, createNativeEconomyWallet } from '../../src/composition/economy.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { openBroadEconomyAdmission } from './fixtures/broad-admission.ts';

const sender = newId(0x6201);
const receiver = newId(0x6202);
const ordinary = newId(0x6203);
const missing = newId(0x6204);
const nativeSender = newId(0x6205);
const nativeReceiver = newId(0x6206);
const assetId = 'test-credit';
const walletsPath = '/v1/economy/wallets';
const walletPath = `${walletsPath}/${assetId}`;
const bookId = `http:${crypto.randomUUID()}`;
const issuer = 'https://auth.economy.test';
const audience = 'https://api.rezics.test';
const grant = 'gate:economy';
const scopes = ['wallet:read', 'wallet:transfer'];
const calls: Array<{ method: string; input: unknown }> = [];
const economy: EconomyWalletPort = {
  async listBalances(input) {
    calls.push({ method: 'listBalances', input });
    return { kind: 'ok', value: { balances: [], next: null } };
  },
  async readBalance(input) {
    calls.push({ method: 'readBalance', input });
    return {
      kind: 'ok',
      value: {
        asset: { id: input.assetId, scale: 0, transferable: true },
        posted: '9007199254740993',
        held: '0',
        restricted: '0',
        pending: '0',
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
let mount: (port?: EconomyWalletPort) => ReturnType<typeof createKernel>;
let nativeWallet: EconomyWalletPort;
let ledger: ReturnType<typeof createNativeEconomyLedger>;
let senderToken: string;
let readOnlyToken: string;
let ordinaryToken: string;
let nativeSenderToken: string;
let nativeReceiverToken: string;
let nativeTransferOnlyToken: string;
let closeBroadAdmission: (() => Promise<void>) | undefined;

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

async function addGrant(accountId: string, action: string) {
  await db.admin.query(
    `INSERT INTO access.resource_grant
     (route, resource_id, subject_id, subject_kind, action, valid, transaction_id)
     VALUES (0, $1, $2, 'identity', $3, '(,)', $4)`,
    [GLOBAL_CONTEXT.id, accountId, action, Bun.randomUUIDv7()],
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
  [senderToken, readOnlyToken, ordinaryToken, nativeSenderToken, nativeReceiverToken, nativeTransferOnlyToken] =
    await Promise.all([
      sign(sender, scopes),
      sign(sender, ['wallet:read']),
      sign(ordinary, scopes),
      sign(nativeSender, scopes),
      sign(nativeReceiver, ['wallet:read']),
      sign(nativeSender, ['wallet:transfer']),
    ]);
  mount = (port?: EconomyWalletPort) =>
    createKernel({
      pool: db.pool,
      routeKey: new Uint8Array(32),
      ...(port === undefined ? {} : { economy: port }),
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
  ledger = createNativeEconomyLedger(db.pool, bookId);
  nativeWallet = createNativeEconomyWallet(db.pool, { bookId, node: 'b' });
  nativeApp = mount(nativeWallet);
}, 90_000);

afterAll(async () => {
  try {
    await closeBroadAdmission?.();
  } finally {
    await db?.close();
  }
});

test('Economy admission, discovery and replay require the exact current account grant', async () => {
  const economyPaths = Object.entries(openApiDocument(app).paths).filter(([path]) => path.startsWith('/v1/economy/'));
  expect(economyPaths.length).toBeGreaterThan(0);
  for (const [, path] of economyPaths) {
    for (const operation of Object.values(path)) {
      expect(operation).toMatchObject({ 'x-exposure': grant, security: [{ bearerAuth: [] }] });
    }
  }
  await addGrant(ordinary, 'gate:any');
  closeBroadAdmission = await openBroadEconomyAdmission(db.admin);
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
  const hiddenPaths = (await hiddenDocument.json()).paths;
  expect(hiddenPaths['/v1/economy/wallets/{assetId}']).toBeUndefined();
  expect(hiddenPaths[walletsPath]).toBeUndefined();

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
  expect(await balance.json()).toMatchObject({
    posted: '9007199254740993',
    pending: '0',
    available: '9007199254740993',
  });
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
  expect(await receiverWallet.json()).toMatchObject({
    posted: '9007199254740993',
    pending: '0',
    available: '9007199254740993',
  });
  const statement = await request(`${walletPath}/statement`, nativeReceiverToken, undefined, nativeApp);
  expect(statement.status).toBe(200);
  const { entries, next } = await statement.json();
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ kind: 'transfer', postedDelta: '9007199254740993' });
  expect(entries[0].operationId).not.toBe('economy-transfer');
  expect(next).toBeNull();
});

test('signed wallet discovery pages native positions and pending-only assets without exposing other owners or controls', async () => {
  const pendingAsset = 'a-pending';
  const overlapAsset = 'b-dual';
  const promoAsset = 'c-promo';
  const zeroAsset = 'd-drained';
  const zeroPendingAsset = 'e-zero-pending';
  const foreignAsset = 'f-foreign';
  const unknownBalanceAsset = 'g-provisioned';
  const controlAsset = 'h-control';
  const moreAssets = Array.from({ length: 17 }, (_, index) => `w-${index.toString().padStart(2, '0')}`);
  for (const id of [
    pendingAsset,
    overlapAsset,
    zeroAsset,
    zeroPendingAsset,
    foreignAsset,
    unknownBalanceAsset,
    controlAsset,
    ...moreAssets,
  ]) {
    expect(await ledger.provisionAsset({ id, scale: 0, transferable: true })).toMatchObject({ kind: 'ok' });
  }
  for (const [id, accountId, amount] of [
    [overlapAsset, nativeSender, '9007199254740993'],
    [zeroAsset, nativeSender, '5'],
    [foreignAsset, nativeReceiver, '7'],
    ...moreAssets.map((id) => [id, nativeSender, '1'] as const),
  ] as const) {
    expect(
      await ledger.issue({ accountId, assetId: id, amount, operationId: `wallet-list-opening/${id}` }),
    ).toMatchObject({
      kind: 'ok',
    });
  }
  expect(
    await ledger.transfer({
      accountId: nativeSender,
      recipientId: nativeReceiver,
      assetId: zeroAsset,
      amount: '5',
      operationId: 'wallet-list-drain',
    }),
  ).toMatchObject({ kind: 'ok' });
  expect(
    await ledger.reserve({
      accountId: nativeSender,
      assetId: overlapAsset,
      holdId: 'wallet-list-hold',
      operationId: 'wallet-list-reserve',
      amount: '2',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  ).toMatchObject({ kind: 'ok' });

  await db.admin.query(
    'INSERT INTO economy.pending_deposit (book_id, asset_id, wallet_id, units) VALUES ($1, $2, $3, 0)',
    [bookId, zeroPendingAsset, nativeSender],
  );
  await db.admin.query(
    `INSERT INTO economy.position (book_id, asset_id, account_id, account_role, posted)
     VALUES ($1, $2, $3, 'provider_clearing', -500)`,
    [bookId, controlAsset, nativeSender],
  );

  const pending = (id: string) =>
    createNativeEconomyTestFunding(db.pool, {
      bookId,
      assetId: id,
      mode: 'test',
      namespace: `wallet-list:${crypto.randomUUID()}`,
      node: 'b',
    });
  const only = pending(pendingAsset);
  for (const operationId of ['wallet-list-pending-1', 'wallet-list-pending-2']) {
    await only.port.begin({
      accountId: nativeSender,
      amount: '9223372036854775807',
      operationId,
      direction: 'deposit',
      deadline: Date.now() + 5000,
    });
  }
  const both = pending(overlapAsset);
  const { intentId } = await both.port.begin({
    accountId: nativeSender,
    amount: '3',
    operationId: 'wallet-list-overlap',
    direction: 'deposit',
    deadline: Date.now() + 5000,
  });

  const expiry = await db.admin.query<{ at: Date }>("SELECT statement_timestamp() + interval '2 seconds' AS at");
  const endsAt = expiry.rows[0]!.at.toISOString();
  const issuanceSource = 'promotional-campaign';
  const promo = { accountId: nativeSender, assetId: promoAsset, issuanceSource };
  expect(
    await ledger.provisionAssetProgram({
      id: promoAsset,
      scale: 0,
      transferable: false,
      programId: 'wallet-list-promo',
      version: '1',
      issuanceSource,
      supplyCap: '100',
      redeemable: true,
      expiresAt: endsAt,
    }),
  ).toMatchObject({ kind: 'ok' });
  expect(await ledger.enrollAssetProgramRecipient(promo)).toMatchObject({ kind: 'ok' });
  expect(await ledger.issueProgramUnits({ ...promo, amount: '8', sourceReference: 'wallet-list-award' })).toMatchObject(
    { kind: 'ok' },
  );
  await db.admin.query(
    'SELECT pg_sleep(GREATEST(EXTRACT(EPOCH FROM ($1::timestamptz - clock_timestamp())), 0) + 0.02)',
    [endsAt],
  );

  async function page(query = '', token = nativeSenderToken): Promise<WalletBalancePage> {
    const response = await request(`${walletsPath}${query}`, token, undefined, nativeApp);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    return response.json() as Promise<WalletBalancePage>;
  }
  const first = await page('?limit=2');
  expect(first).toEqual({
    balances: [
      {
        asset: { id: pendingAsset, scale: 0, transferable: true },
        posted: '0',
        held: '0',
        restricted: '0',
        pending: '18446744073709551614',
        available: '0',
      },
      {
        asset: { id: overlapAsset, scale: 0, transferable: true },
        posted: '9007199254740993',
        held: '2',
        restricted: '0',
        pending: '3',
        available: '9007199254740991',
      },
    ],
    next: overlapAsset,
  });
  const second = await page(`?limit=2&after=${first.next}`);
  expect(second).toEqual({
    balances: [
      {
        asset: { id: promoAsset, scale: 0, transferable: false },
        posted: '8',
        held: '0',
        restricted: '8',
        pending: '0',
        available: '0',
      },
      {
        asset: { id: zeroAsset, scale: 0, transferable: true },
        posted: '0',
        held: '0',
        restricted: '0',
        pending: '0',
        available: '0',
      },
    ],
    next: zeroAsset,
  });
  for (const view of [...first.balances, ...second.balances]) {
    const point = await request(`${walletsPath}/${view.asset.id}`, nativeSenderToken, undefined, nativeApp);
    expect(point.status).toBe(200);
    expect(await point.json()).toEqual(view);
  }
  const history = await request(`${walletsPath}/${zeroAsset}/statement`, nativeSenderToken, undefined, nativeApp);
  expect(history.status).toBe(200);
  expect((await history.json()).entries.map((entry: { kind: string }) => entry.kind)).toEqual(['transfer', 'issue']);

  const expectedIds = [pendingAsset, overlapAsset, promoAsset, zeroAsset, assetId, ...moreAssets];
  const main = await page();
  expect(main.balances.map((item) => item.asset.id)).toEqual(expectedIds.slice(0, 20));
  expect(main.next).toBe(expectedIds[19]!);
  const tail = await page(`?after=${main.next}`);
  expect(tail.balances.map((item) => item.asset.id)).toEqual(expectedIds.slice(20));
  expect(tail.next).toBeNull();
  expect((await page('?limit=100')).balances.map((item) => item.asset.id)).toEqual(expectedIds);
  expect(await page(`?after=${expectedIds.at(-1)}`)).toEqual({ balances: [], next: null });
  const receiverPage = await page('', nativeReceiverToken);
  expect(receiverPage.balances.map((item) => [item.asset.id, item.posted])).toEqual([
    [zeroAsset, '5'],
    [foreignAsset, '7'],
    [assetId, '9007199254740993'],
  ]);

  expect(await both.dispatch(intentId)).toEqual({ kind: 'ok', value: { kind: 'acknowledged' } });
  const settled = await page(`?after=${pendingAsset}&limit=1`);
  expect(settled.balances).toEqual([
    {
      asset: { id: overlapAsset, scale: 0, transferable: true },
      posted: '9007199254740996',
      held: '2',
      restricted: '0',
      pending: '0',
      available: '9007199254740994',
    },
  ]);
  expect((await request(`${walletsPath}?limit=101`, nativeSenderToken, undefined, nativeApp)).status).toBe(400);
  for (const token of [undefined, ordinaryToken, nativeTransferOnlyToken]) {
    expect((await request(walletsPath, token, undefined, nativeApp)).status).toBe(403);
  }
  const closedApp = mount();
  expect((await request(walletsPath, undefined, undefined, closedApp)).status).toBe(403);
  const unbound = await request(walletsPath, nativeSenderToken, undefined, closedApp);
  expect(unbound.status).toBe(503);
  expect(await unbound.json()).toMatchObject({ code: 'dependency_unavailable' });
  await db.admin.query(
    `DELETE FROM access.resource_grant WHERE route = 0 AND resource_id = $1 AND subject_id = $2 AND action = 'gate:economy'`,
    [GLOBAL_CONTEXT.id, nativeSender],
  );
  expect(
    (await request(`${walletsPath}?limit=1&after=${overlapAsset}`, nativeSenderToken, undefined, nativeApp)).status,
  ).toBe(403);
  await expect(nativeWallet.listBalances({ accountId: nativeSender, limit: 20 })).rejects.toMatchObject({
    code: 'platform_closed',
  });
}, 90_000);
