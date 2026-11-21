import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createAuthHost, type AuthService } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createNativeEconomyLedger, createNativeEconomyWallet } from '../../src/composition/economy.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { createAuthDatabase } from '../support/auth-database.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { createRegistrationPorts } from '../support/registration-ports.ts';
import { openIsolatedEconomyDatabase } from './fixtures/isolated-database.ts';

const issuer = 'https://economy-governance.auth.test';
const audience = 'https://economy-governance.api.test';
const clientId = 'economy-governance-client';
const password = 'native Economy governance fixture password';
const routeKey = new Uint8Array(32).fill(81);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(82)]]) };
const readScope = 'wallet:read';
const gate = 'gate:economy';
const grantScopes = ['access:grant', 'gate:any', readScope] as const;
const bookId = 'governance-acceptance';
const assetId = 'points';
const wallet = `/v1/economy/wallets/${assetId}`;
const statement = `${wallet}/statement?limit=1`;
const publicWallet = '/v1/economy/wallets/{assetId}';
const authName = `economy_auth_${crypto.randomUUID().replaceAll('-', '')}`;

let database: Awaited<ReturnType<typeof openIsolatedEconomyDatabase>>;
let pool: Pool;
let authPool: Pool;
let authCreated = false;
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let kernel: ReturnType<typeof createKernel>;

beforeAll(async () => {
  database = await openIsolatedEconomyDatabase();
  pool = createPool(database.url);
  authPool = new Pool({ connectionString: await createAuthDatabase(database.url, authName) });
  authCreated = true;
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'economy-governance',
  };
  kernel = createKernel({
    pool,
    routeKey,
    tokens,
    receiptKeys: testReceiptKeys(),
    economy: createNativeEconomyWallet(pool, { bookId, node: 'b' }),
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: (input, init) => service.handler(new Request(input, init)),
        },
      }),
    writeRate: createWriteRateLimiter({ secret: 'economy-governance-fixture-write-rate-secret' }),
    ratePeer: () => '127.0.0.1',
  });
  const registration = createRegistrationProofBindings({ pool, referenceKeys: tokens });
  const { ports } = createRegistrationPorts({ pool, authPool, routeKey, referenceKeys: tokens });
  host = await createAuthHost({
    database: authPool,
    systemDatabasePool: authPool,
    issuer,
    audience,
    secret: 'economy-governance-fixture-auth-secret',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: createAuthBindings({
      pool,
      ...registration,
      verifyPendingIdentity: registration.verifyNativePendingIdentity,
    }),
    access: ports,
    stagingKey: new Uint8Array(32).fill(83),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'economy-governance',
  });
  service = host.service;
  await service.internal.registerClient({
    clientId,
    firstParty: true,
    scopes: [...grantScopes, gate, 'exposure:read'],
  });
  await host.start();
}, 90_000);

afterAll(async () => {
  try {
    if (host) await host.stop();
    else await authPool?.end();
  } finally {
    try {
      if (authCreated) await dropTestDatabase(database.admin, authName);
    } finally {
      try {
        await pool?.end();
      } finally {
        await database?.close();
      }
    }
  }
});

async function issue(email: string, scope: readonly string[]) {
  const signin = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: clientId, scope }),
    }),
  );
  expect(signin.status).toBe(200);
  const cookie = signin.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const token = await service.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { origin: issuer, cookie, 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  expect(token.status).toBe(200);
  return ((await token.json()) as { access_token: string }).access_token;
}

async function person(name: string, scope: readonly string[]) {
  const email = `${name}@economy.test`;
  const result = await host.workflows.register({ key: name, handle: name, email, password });
  return { accountId: result.accountId, email, bearer: await issue(email, scope) };
}

function call(path: string, bearer?: string, payload?: object) {
  const headers = new Headers();
  if (bearer) headers.set('authorization', `Bearer ${bearer}`);
  if (payload) {
    headers.set('content-type', 'application/json');
    headers.set('idempotency-key', JSON.stringify(crypto.randomUUID()));
  }
  return kernel.handle(
    new Request(`${audience}${path}`, {
      method: payload ? 'POST' : 'GET',
      headers,
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    }),
  );
}

function directGrant(accountId: string) {
  return { resource: PLATFORM_RESOURCE, subject: { kind: 'account', id: accountId }, actions: [gate], valid: '(,)' };
}

async function walletDiscovery(bearer: string | undefined, visible: boolean) {
  const exposure = await call('/v1/platform/exposure', bearer);
  expect(exposure.status).toBe(200);
  const { admitted } = (await exposure.json()) as { admitted: string[] };
  expect(admitted.includes('economy')).toBe(visible);
  const openapi = await call('/v1/openapi.json', bearer);
  expect(openapi.status).toBe(200);
  const { paths } = (await openapi.json()) as { paths: Record<string, unknown> };
  if (visible) {
    for (const path of [publicWallet, `${publicWallet}/statement`])
      expect(paths[path]).toMatchObject({ get: { 'x-exposure': gate, 'x-action': readScope } });
  } else {
    expect(Object.keys(paths).some((path) => path.startsWith('/v1/economy/'))).toBe(false);
  }
  expect(paths[`${publicWallet}/transfers`]).toBeUndefined();
  expect(paths['/v1/economy/test-funding/intents']).toBeUndefined();
}

async function expectClosed(bearer?: string) {
  for (const path of [wallet, statement]) {
    const response = await call(path, bearer);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'platform_closed' });
  }
  await walletDiscovery(bearer, false);
}

async function expectOwnWallet(bearer: string, amount: string, operationId: string) {
  const balance = await call(wallet, bearer);
  expect(balance.status).toBe(200);
  expect(balance.headers.get('cache-control')).toBe('private, no-store');
  expect(await balance.json()).toMatchObject({ posted: amount, available: amount, pending: '0' });
  const history = await call(statement, bearer);
  expect(history.status).toBe(200);
  expect(history.headers.get('cache-control')).toBe('private, no-store');
  expect(await history.json()).toMatchObject({
    entries: [{ operationId, kind: 'issue', postedDelta: amount }],
    next: null,
  });
}

test('Global governance explicitly admits and revokes native wallet access and discovery for an Auth account', async () => {
  const operator = await person('economy_operator', grantScopes);
  const member = await person('economy_member', [readScope]);
  const other = await person('economy_other', grantScopes);
  const noWallet = await issue(member.email, ['exposure:read', gate]);
  await bootstrapGovernance(pool, operator.accountId);
  const ledger = createNativeEconomyLedger(pool, bookId);
  expect(await ledger.provisionAsset({ id: assetId, scale: 0, transferable: true })).toMatchObject({ kind: 'ok' });
  const amount = '9007199254740993';
  expect(
    await ledger.issue({ accountId: member.accountId, assetId, amount, operationId: 'member-opening' }),
  ).toMatchObject({ kind: 'ok' });
  expect(
    await ledger.issue({ accountId: other.accountId, assetId, amount: '37', operationId: 'other-opening' }),
  ).toMatchObject({ kind: 'ok' });

  for (const bearer of [undefined, operator.bearer, member.bearer, other.bearer]) await expectClosed(bearer);
  const grant = directGrant(member.accountId);
  expect((await call('/v1/grants', other.bearer, grant)).status).toBe(403);
  const granted = await call('/v1/grants', operator.bearer, grant);
  expect({ status: granted.status, body: await granted.json() }).toEqual({ status: 201, body: { grant } });

  await walletDiscovery(member.bearer, true);
  await expectOwnWallet(member.bearer, amount, 'member-opening');
  expect((await call(`/v1/economy/test-funding/intents/${'a'.repeat(64)}`, member.bearer)).status).toBe(404);
  expect((await call(wallet, noWallet)).status).toBe(403);
  await walletDiscovery(noWallet, false);
  await expectClosed(other.bearer);
  expect((await call('/v1/grants', operator.bearer, directGrant(other.accountId))).status).toBe(201);
  await expectOwnWallet(other.bearer, '37', 'other-opening');

  const revoked = await call('/v1/grants:revoke', operator.bearer, grant);
  expect({ status: revoked.status, body: await revoked.json() }).toMatchObject({ status: 200 });
  await expectClosed(member.bearer);
  await expectOwnWallet(other.bearer, '37', 'other-opening');
}, 60_000);
