import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { GLOBAL_CONTEXT } from '../../src/access/gates/catalogue.ts';
import { createAccess } from '../../src/access/index.ts';
import {
  createNativeEconomyTestFunding,
  readEconomyTestFundingConfig,
} from '../../src/composition/economy-test-funding.ts';
import { createNativeEconomyLedger } from '../../src/composition/economy.ts';
import { createFundingLedgerBinder } from '../../src/economy/storage/funding-ledger.ts';
import { createFundingStore } from '../../src/economy/storage/funding-store.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { readConfig } from '../../src/server.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const issuer = 'https://auth.test-funding.test';
const audience = 'https://api.rezics.test';
const accountId = newId(0x6a51);
const other = newId(0x6a52);
const ordinary = newId(0x6a53);
const bookId = `http-funding:${crypto.randomUUID()}`;
const assetId = 'synthetic-credit';
const namespace = `test-rail:${crypto.randomUUID()}`;
const path = '/v1/economy/test-funding/intents';
const clientScope = 'wallet:test_funding';
const config = { bookId, node: 'b', assetId, namespace, mode: 'test' as const };
let token: (account: string, scope?: string) => Promise<string>;
let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let closedApp: ReturnType<typeof createKernel>;
let native: ReturnType<typeof createNativeEconomyTestFunding>;
let ledger: ReturnType<typeof createNativeEconomyLedger>;

beforeAll(async () => {
  db = await openGrowthDatabase();
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), alg: 'ES256', kid: 'economy-test-funding-access' };
  token = (sub, scope = clientScope) =>
    new SignJWT({
      client_id: 'web',
      authn_epoch: 1,
      scope,
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

  for (const id of [accountId, other, ordinary]) {
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
  native = createNativeEconomyTestFunding(db.pool, config);
  ledger = createNativeEconomyLedger(db.pool, bookId);
  const mount = (port?: typeof native.port) =>
    createKernel({
      pool: db.pool,
      routeKey: new Uint8Array(32),
      ...(port === undefined ? {} : { economyTestFunding: port }),
      writeRate: {
        async spend() {
          return { allowed: true as const };
        },
      },
      access: (accessConfig) =>
        createAccess({
          ...accessConfig,
          auth: { issuer, audience, jwksUrl: `${issuer}/jwks`, fetch: async () => Response.json({ keys: [jwk] }) },
        }),
    });
  app = mount(native.port);
  closedApp = mount();
  expect(await ledger.provisionAsset({ id: assetId, scale: 0, transferable: true })).toMatchObject({ kind: 'ok' });
}, 90_000);

afterAll(async () => {
  await db?.close();
});

function request(address: string, bearer?: string, command?: { key: string; body: object }, kernel = app) {
  return kernel.handle(
    new Request(`http://kernel.test${address}`, {
      method: command ? 'POST' : 'GET',
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(command ? { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(command.key) } : {}),
      },
      ...(command ? { body: JSON.stringify(command.body) } : {}),
    }),
  );
}

const command = (key: string, direction: 'deposit' | 'withdrawal', amount: string) => ({
  key,
  body: { direction, amount },
});

test('signed test funding is private, exact on replay, and becomes spendable only through native work', async () => {
  const ownerToken = await token(accountId);
  const otherToken = await token(other);
  const ordinaryToken = await token(ordinary);
  const walletOnly = await token(accountId, 'wallet:transfer');
  const amount = '9007199254740993';
  const deposit = command('deposit-one', 'deposit', amount);
  const paths = Object.entries(openApiDocument(app).paths).filter(([name]) => name.startsWith(path));
  expect(Object.keys(openApiDocument(closedApp).paths).filter((name) => name.startsWith(path))).toEqual([]);
  expect(paths).toHaveLength(2);
  for (const [, item] of paths)
    for (const operation of Object.values(item)) {
      expect(operation).toMatchObject({
        'x-exposure': 'gate:economy',
        'x-action': clientScope,
        security: [{ bearerAuth: [] }],
      });
    }
  expect((await request(path, undefined, deposit)).status).toBe(403);
  expect((await request(path, ordinaryToken, deposit)).status).toBe(403);
  expect((await request(path, walletOnly, deposit)).status).toBe(403);
  expect((await request(path, ownerToken, deposit, closedApp)).status).toBe(404);
  expect((await request(path, ownerToken, { ...deposit, body: { ...deposit.body, mode: 'live' } })).status).toBe(400);

  const [first, second] = await Promise.all([request(path, ownerToken, deposit), request(path, ownerToken, deposit)]);
  expect([first.status, second.status]).toEqual([200, 200]);
  const { intentId } = (await first.json()) as { intentId: string };
  expect(await second.json()).toEqual({ intentId });
  const receiptPath = `${path}/${intentId}`;
  expect((await request(receiptPath, ownerToken, undefined, closedApp)).status).toBe(404);
  expect((await request(path, ownerToken, command(deposit.key, 'withdrawal', amount))).status).toBe(422);
  expect((await request(receiptPath, otherToken)).status).toBe(404);
  expect((await request(receiptPath, ordinaryToken)).status).toBe(403);
  const submitted = await request(receiptPath, ownerToken);
  expect(submitted.headers.get('cache-control')).toBe('private, no-store');
  expect(await submitted.json()).toEqual({
    intentId,
    assetId,
    direction: 'deposit',
    amount,
    phase: 'submitted',
    reversedAmount: '0',
  });
  expect(await ledger.readBalance({ accountId, assetId })).toMatchObject({
    kind: 'ok',
    value: { posted: '0', pending: amount, available: '0' },
  });
  expect(await native.dispatch(intentId)).toEqual({ kind: 'ok', value: { kind: 'acknowledged' } });
  expect(await (await request(receiptPath, ownerToken)).json()).toMatchObject({ phase: 'confirmed', amount });
  expect(await (await request(path, ownerToken, deposit)).json()).toEqual({ intentId });
  expect(await ledger.readBalance({ accountId, assetId })).toMatchObject({
    kind: 'ok',
    value: { posted: amount, pending: '0', available: amount },
  });

  const tooMuch = await request(path, ownerToken, command('too-much', 'withdrawal', '9007199254740994'));
  expect(tooMuch.status).toBe(409);
  const withdrawal = await request(path, ownerToken, command('withdraw-one', 'withdrawal', '30'));
  expect(withdrawal.status).toBe(200);
  const withdrawalId = ((await withdrawal.json()) as { intentId: string }).intentId;
  expect(await ledger.readBalance({ accountId, assetId })).toMatchObject({
    kind: 'ok',
    value: { posted: amount, held: '30' },
  });
  expect(await native.dispatch(withdrawalId)).toEqual({ kind: 'ok', value: { kind: 'acknowledged' } });
  expect(await (await request(`${path}/${withdrawalId}`, ownerToken)).json()).toMatchObject({
    phase: 'confirmed',
    direction: 'withdrawal',
    amount: '30',
  });
  expect(await ledger.readBalance({ accountId, assetId })).toMatchObject({
    kind: 'ok',
    value: { posted: '9007199254740963', pending: '0', held: '0' },
  });
  const { rows } = await db.admin.query(
    'SELECT count(*)::int AS n FROM economy.funding_intent WHERE book_id=$1 AND wallet_id=$2',
    [bookId, accountId],
  );
  expect(rows[0]).toEqual({ n: 2 });
  await db.admin.query(
    "DELETE FROM access.resource_grant WHERE route=0 AND resource_id=$1 AND subject_id=$2 AND action='gate:economy'",
    [GLOBAL_CONTEXT.id, accountId],
  );
  expect((await request(receiptPath, ownerToken)).status).toBe(403);
  expect((await request(path, ownerToken, deposit)).status).toBe(403);
});

test('the deterministic runtime neither exposes nor claims live work', async () => {
  const store = createFundingStore(
    {
      read: (work) => work(db.pool),
      async transaction(work) {
        const client = await db.pool.connect();
        try {
          await client.query('BEGIN');
          const result = await work(client);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
    },
    bookId,
    createFundingLedgerBinder(bookId),
  );
  const intentId = 'a'.repeat(64);
  expect(
    await store.begin({
      bookId,
      intentId,
      assetId,
      walletId: other,
      direction: 'deposit',
      units: '50',
      provider: { mode: 'live', destinationRef: 'external-destination', namespace },
    }),
  ).toMatchObject({ kind: 'ok', value: { kind: 'created' } });
  expect(await store.prepare(intentId)).toMatchObject({ kind: 'ok', value: { kind: 'queued' } });
  expect(await native.dispatch(intentId)).toEqual({ kind: 'test_rail_ineligible' });
  expect((await request(`${path}/${intentId}`, await token(other))).status).toBe(404);
  const { rows } = await db.admin.query(
    'SELECT active_claim_id FROM economy.funding_dispatch WHERE book_id=$1 AND intent_id=$2',
    [bookId, intentId],
  );
  expect(rows[0]).toEqual({ active_claim_id: null });
  expect(await ledger.readBalance({ accountId: other, assetId })).toMatchObject({ kind: 'ok', value: { posted: '0' } });
});

test('test intake requires development and a complete test rail binding', () => {
  const settings = {
    KERNEL_ECONOMY_TEST_FUNDING_ASSET_ID: assetId,
    KERNEL_ECONOMY_TEST_FUNDING_NAMESPACE: namespace,
    KERNEL_ECONOMY_TEST_FUNDING_MODE: 'test',
  };
  const development = { ...settings, NODE_ENV: 'development' };
  expect(readEconomyTestFundingConfig({})).toBeUndefined();
  expect(readEconomyTestFundingConfig(settings)).toBeUndefined();
  expect(readEconomyTestFundingConfig({ ...settings, NODE_ENV: 'test' })).toBeUndefined();
  expect(readEconomyTestFundingConfig({ ...settings, NODE_ENV: 'production' })).toBeUndefined();
  expect(() => readEconomyTestFundingConfig({ ...development, KERNEL_ECONOMY_TEST_FUNDING_MODE: 'live' })).toThrow();
  expect(() =>
    readEconomyTestFundingConfig({ NODE_ENV: 'development', KERNEL_ECONOMY_TEST_FUNDING_ASSET_ID: assetId }),
  ).toThrow();
  expect(readEconomyTestFundingConfig(development)).toEqual({ assetId, namespace, mode: 'test' });
  const boot = {
    ...settings,
    DATABASE_URL: db.url,
    KERNEL_ROUTE_KEY: Buffer.alloc(32, 31).toString('base64url'),
    KERNEL_SESSION_KEYS: `1:${Buffer.alloc(32, 32).toString('base64url')}`,
    KERNEL_RECEIPT_KEYS: `1:${Buffer.alloc(32, 33).toString('base64url')}`,
    KERNEL_ECONOMY_BOOK_ID: bookId,
    KERNEL_ECONOMY_NODE: config.node,
  };
  expect(readConfig(boot).economyTestFunding).toBeUndefined();
  expect(readConfig({ ...boot, NODE_ENV: 'production' }).economyTestFunding).toBeUndefined();
  expect(readConfig({ ...boot, NODE_ENV: 'development' }).economyTestFunding).toEqual({
    assetId,
    namespace,
    mode: 'test',
  });
});

test('even an explicitly selected promotional asset cannot accept provider funding', async () => {
  const programAsset = 'promotional-only';
  expect(
    await ledger.provisionAssetProgram({
      id: programAsset,
      scale: 0,
      transferable: false,
      programId: 'private-promotions',
      version: '1',
      issuanceSource: 'test-suite',
      supplyCap: '1000',
      redeemable: true,
      expiresAt: null,
    }),
  ).toMatchObject({ kind: 'ok' });
  const ineligible = createNativeEconomyTestFunding(db.pool, { ...config, assetId: programAsset });
  await expect(
    ineligible.port.begin({
      accountId: other,
      deadline: Date.now() + 2000,
      operationId: 'program-deposit',
      direction: 'deposit',
      amount: '1',
    }),
  ).rejects.toMatchObject({ code: 'not_found' });
  const { rows } = await db.admin.query(
    'SELECT count(*)::int AS n FROM economy.funding_intent WHERE book_id=$1 AND asset_id=$2',
    [bookId, programAsset],
  );
  expect(rows[0]).toEqual({ n: 0 });
});
