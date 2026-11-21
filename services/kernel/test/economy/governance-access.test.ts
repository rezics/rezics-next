import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { createAuthHost, type AuthService } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { bootstrapGovernance, PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createAccess } from '../../src/access/index.ts';
import { AccessUnavailableError } from '../../src/access/unavailable.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createNativeEconomyLedger, createNativeEconomyWallet } from '../../src/composition/economy.ts';
import { createPool, withBoundedReadConnection } from '../../src/database/pool.ts';
import { ProblemError } from '../../src/http/problem-error.ts';
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
const operatorAction = 'exposure:close';
const resourceAction = 'fixture:resource_read';
const resourcePath = '/v1/economy/resource-fixture';
const fixedPaths = ['/v1/economy/global-operator-fixture', '/v1/economy/global-operator-sibling'] as const;
const readScopes = [readScope, 'spot:read', 'market:read'] as const;
const grantScopes = ['access:grant', 'exposure:open', operatorAction, 'gate:any', ...readScopes] as const;
const bookId = 'governance-acceptance';
const assetId = 'points';
const wallets = '/v1/economy/wallets';
const wallet = `${wallets}/${assetId}`;
const statement = `${wallet}/statement?limit=1`;
const publicWallet = `${wallets}/{assetId}`;
const spotInstruments = '/v1/economy/spot';
const spot = `${spotInstruments}/pair`;
const spotOrders = `${spot}/orders`;
const spotFills = `${spotOrders}/order-id/fills`;
const marketListings = '/v1/economy/market/listings';
const marketTrades = '/v1/economy/market/trades';
const market = `${marketTrades}/${'a'.repeat(64)}`;
const unboundEconomyReads = [spotInstruments, spot, spotOrders, spotFills, marketListings, marketTrades, market];
const authName = `economy_auth_${crypto.randomUUID().replaceAll('-', '')}`;

let database: Awaited<ReturnType<typeof openIsolatedEconomyDatabase>>;
let pool: Pool;
let authPool: Pool;
let authCreated = false;
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let kernel: ReturnType<typeof createKernel>;
let nativeAccess: ReturnType<typeof createAccess>;

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
    onAccessReady(access) {
      nativeAccess = access;
    },
    modules: [
      (app) => {
        for (const [index, path] of fixedPaths.entries()) {
          const detail = {
            operationId: index === 0 ? 'fixture.global_operator' : 'fixture.global_operator_sibling',
            'x-exposure': gate,
            'x-action': operatorAction,
            'x-authority-resource-types': ['semantic.context'],
            'x-authority-resource-id': PLATFORM_RESOURCE.id,
            security: [{ bearerAuth: [] }],
          };
          app.get(path, { detail }, async ({ authorize, job }) => {
            const check = await authorize(PLATFORM_RESOURCE);
            if (!(await withBoundedReadConnection(pool, job.deadline, check))) throw new ProblemError('forbidden');
            return { accepted: true };
          });
        }
        const detail = {
          operationId: 'fixture.resource_read',
          'x-exposure': gate,
          'x-action': resourceAction,
          'x-authority-resource-types': ['semantic.context'],
          security: [{ bearerAuth: [] }],
        };
        app.get(`${resourcePath}/:resourceId`, { detail }, () => {
          throw new ProblemError('not_found');
        });
      },
    ],
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
    scopes: [...grantScopes, gate, resourceAction, 'exposure:read'],
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

function directGrant(accountId: string, action: string = gate) {
  return { resource: PLATFORM_RESOURCE, subject: { kind: 'account', id: accountId }, actions: [action], valid: '(,)' };
}

async function economyDiscovery(bearer: string | undefined, visible: boolean) {
  const exposure = await call('/v1/platform/exposure', bearer);
  expect(exposure.status).toBe(200);
  const { admitted } = (await exposure.json()) as { admitted: string[] };
  expect(admitted.includes('economy')).toBe(visible);
  const openapi = await call('/v1/openapi.json', bearer);
  expect(openapi.status).toBe(200);
  const { paths } = (await openapi.json()) as { paths: Record<string, unknown> };
  if (visible) {
    for (const [path, action] of [
      [wallets, readScope],
      [publicWallet, readScope],
      [`${publicWallet}/statement`, readScope],
      [spotInstruments, 'spot:read'],
      ['/v1/economy/spot/{instrumentId}', 'spot:read'],
      ['/v1/economy/spot/{instrumentId}/orders', 'spot:read'],
      ['/v1/economy/spot/{instrumentId}/trades', 'spot:read'],
      ['/v1/economy/spot/{instrumentId}/orders/{orderId}/fills', 'spot:read'],
      [marketListings, 'market:read'],
      [marketTrades, 'market:read'],
      [`${marketTrades}/{tradeId}`, 'market:read'],
    ] as const)
      expect(paths[path]).toMatchObject({ get: { 'x-exposure': gate, 'x-action': action } });
    for (const path of [marketListings, '/v1/economy/spot/{instrumentId}/orders'])
      expect(paths[path]).not.toHaveProperty('post');
  } else {
    expect(Object.keys(paths).some((path) => path.startsWith('/v1/economy/'))).toBe(false);
  }
  expect(paths[`${publicWallet}/transfers`]).toBeUndefined();
  expect(paths['/v1/economy/test-funding/intents']).toBeUndefined();
}

async function expectClosed(bearer?: string) {
  for (const path of [wallets, wallet, statement, ...unboundEconomyReads]) {
    const response = await call(path, bearer);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'platform_closed' });
  }
  await economyDiscovery(bearer, false);
}

async function expectOwnWallet(bearer: string, amount: string) {
  const balance = await call(wallet, bearer);
  expect(balance.status).toBe(200);
  expect(balance.headers.get('cache-control')).toBe('private, no-store');
  expect(await balance.json()).toMatchObject({ posted: amount, available: amount, pending: '0' });
  const page = await call(wallets, bearer);
  expect(page.status).toBe(200);
  expect(await page.json()).toMatchObject({
    balances: [{ asset: { id: assetId }, posted: amount, available: amount, pending: '0' }],
    next: null,
  });
  const history = await call(statement, bearer);
  expect(history.status).toBe(200);
  expect(history.headers.get('cache-control')).toBe('private, no-store');
  expect(await history.json()).toMatchObject({
    entries: [
      {
        operationId: expect.stringMatching(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/),
        kind: 'issue',
        postedDelta: amount,
      },
    ],
    next: null,
  });
}

test('Global governance grants Economy access individually and cannot open its routes platform-wide', async () => {
  const operator = await person('economy_operator', grantScopes);
  const member = await person('economy_member', readScopes);
  const other = await person('economy_other', grantScopes);
  const noWallet = await issue(member.email, ['exposure:read', gate]);
  await bootstrapGovernance(pool, operator.accountId);
  const opening = await call('/v1/platform/exposure/economy:open', operator.bearer, {});
  expect(opening.status).toBe(403);
  expect(await opening.json()).toMatchObject({ code: 'forbidden' });
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

  await economyDiscovery(member.bearer, true);
  await expectOwnWallet(member.bearer, amount);
  for (const path of unboundEconomyReads) {
    const unbound = await call(path, member.bearer);
    expect(unbound.status).toBe(503);
    expect(await unbound.json()).toMatchObject({ code: 'dependency_unavailable' });
  }
  expect((await call(`/v1/economy/test-funding/intents/${'a'.repeat(64)}`, member.bearer)).status).toBe(404);
  expect((await call(wallet, noWallet)).status).toBe(403);
  await economyDiscovery(noWallet, false);
  await expectClosed(other.bearer);
  expect((await call('/v1/grants', operator.bearer, directGrant(other.accountId))).status).toBe(201);
  await expectOwnWallet(other.bearer, '37');

  const revoked = await call('/v1/grants:revoke', operator.bearer, grant);
  expect({ status: revoked.status, body: await revoked.json() }).toMatchObject({ status: 200 });
  await expectClosed(member.bearer);
  await expectOwnWallet(other.bearer, '37');

  const tester = await person('economy_fixed_operator', [operatorAction]);
  const combined = await issue(tester.email, [operatorAction, readScope, resourceAction]);
  const noRepairScope = await issue(tester.email, [readScope]);
  const document = async (bearer?: string) => {
    const response = await call('/v1/openapi.json', bearer);
    expect(response.status).toBe(200);
    return (await response.json()).paths as Record<string, Record<string, { operationId?: string }>>;
  };
  const expectOperatorDiscovery = async (bearer: string, visible: boolean) => {
    const paths = await document(bearer);
    for (const path of fixedPaths) expect(paths[path] !== undefined).toBe(visible);
    expect(
      Object.values(paths)
        .flatMap((methods) => Object.values(methods))
        .some((operation) => operation.operationId === 'exposure.close'),
    ).toBe(true);
    const groups = await call('/v1/platform/exposure', bearer);
    expect(groups.status).toBe(200);
    expect(((await groups.json()) as { admitted: string[] }).admitted.includes('economy')).toBe(visible);
  };
  const assign = async (action: string) => {
    expect((await call('/v1/grants', operator.bearer, directGrant(tester.accountId, action))).status).toBe(201);
  };
  const remove = async (action: string) => {
    expect((await call('/v1/grants:revoke', operator.bearer, directGrant(tester.accountId, action))).status).toBe(200);
  };

  await expectOperatorDiscovery(tester.bearer, false);
  await assign(operatorAction);
  await expectOperatorDiscovery(tester.bearer, false);
  await assign('gate:any');
  await expectOperatorDiscovery(tester.bearer, false);
  expect((await call(fixedPaths[0], tester.bearer)).status).toBe(403);
  await remove(operatorAction);
  await assign(gate);
  await expectOperatorDiscovery(tester.bearer, false);
  expect((await call(fixedPaths[0], tester.bearer)).status).toBe(403);
  const ordinaryPaths = await document(combined);
  expect(ordinaryPaths[publicWallet]).toBeDefined();
  expect(ordinaryPaths[`${resourcePath}/{resourceId}`]).toBeDefined();
  expect(ordinaryPaths[fixedPaths[0]]).toBeUndefined();

  // Observe the real native decisions. Two mounted operations share one Global action per request.
  await assign(operatorAction);
  const prepare = nativeAccess.prepareReadDecisions!.bind(nativeAccess);
  let fixedChecks = 0;
  const probe = spyOn(nativeAccess, 'prepareReadDecisions').mockImplementation(async (input) => {
    const prepared = await prepare(input);
    return {
      ...prepared,
      async decide(...args) {
        if (args[1].action === operatorAction) {
          expect(args[1]).toEqual({
            action: operatorAction,
            resourceType: 'semantic.context',
            ids: [PLATFORM_RESOURCE.id],
          });
          fixedChecks++;
        }
        return prepared.decide(...args);
      },
    };
  });
  try {
    await expectOperatorDiscovery(tester.bearer, true);
    expect(fixedChecks).toBe(2);
  } finally {
    probe.mockRestore();
  }
  expect((await document(noRepairScope))[fixedPaths[0]]).toBeUndefined();
  expect((await call(fixedPaths[0], tester.bearer)).status).toBe(200);

  const outage = spyOn(nativeAccess, 'prepareReadDecisions').mockImplementation(async (input) => {
    if (input.actions.has(operatorAction)) throw new AccessUnavailableError('overloaded');
    return prepare(input);
  });
  try {
    for (const path of ['/v1/openapi.json', '/v1/platform/exposure']) {
      const response = await call(path, tester.bearer);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: 'overloaded' });
    }
  } finally {
    outage.mockRestore();
  }
  await remove(operatorAction);
  await expectOperatorDiscovery(tester.bearer, false);
  expect((await document(combined))[publicWallet]).toBeDefined();
  await assign(operatorAction);
  await remove(gate);
  await expectOperatorDiscovery(tester.bearer, false);
}, 90_000);
