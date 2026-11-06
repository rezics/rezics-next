import { testReceiptKeys } from '../support/receipt-keys.ts';
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test';
import { Pool } from 'pg';
import { createAuthHost, type AuthService } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { createAccess } from '../../src/access/index.ts';
import { authoritativeTimeValue } from '../../src/command/command.ts';
import { readAssignment } from '../../src/access/delegation-commands.ts';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { createRegistrationPorts } from '../support/registration-ports.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { bootstrapGovernance } from '../../src/access/bootstrap-governance.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { decodeSession } from '../../src/tokens/session.ts';
import { createAuthDatabase } from '../support/auth-database.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { SESSION_HEADER, actionCatalogue } from '../../src/http/request.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';

const pool = new Pool({ connectionString: 'postgres://kernel.invalid/routes' });
afterAll(() => pool.end());
const app = createKernel({
  pool,
  receiptKeys: testReceiptKeys(),
  routeKey: new Uint8Array(32),
  writeRate: {
    async spend() {
      return { allowed: true };
    },
  },
});

test('the actual mounted kernel catalogue contains the nonanonymous grant administration action', () => {
  expect(actionCatalogue(app).get('access:grant')).toEqual({ anonymous: false });
  for (const [path, operationId] of [
    ['/v1/grants', 'grant.create'],
    ['/v1/grants/$change', 'grant.change'],
    ['/v1/grants/$revoke', 'grant.revoke'],
    ['/v1/roleGrants', 'role_grant.create'],
    ['/v1/roleGrants/$change', 'role_grant.change'],
    ['/v1/roleGrants/$revoke', 'role_grant.revoke'],
  ]) {
    const mounted = app.routes.filter((route) => route.method === 'POST' && route.path === path);
    expect(mounted).toHaveLength(1);
    expect(mounted[0]!.hooks.detail).toMatchObject({
      operationId,
      'x-action': 'access:grant',
      security: [{ bearerAuth: [] }],
      'x-rate-limit': { family: 'write', units: 1 },
    });
  }
});

test('the actual grant HTTP route requires a bearer actor', async () => {
  const response = await app.handle(
    new Request('http://kernel.test/v1/grants', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': '"missing-actor"' },
      body: JSON.stringify({
        resource: PLATFORM_RESOURCE,
        subject: { kind: 'active_accounts' },
        actions: ['subject:create'],
        valid: '(,)',
      }),
    }),
  );
  expect(response.status).toBe(401);
});

// Product proof: actual registration workflows, Auth issuance/JWKS and the
// mounted catalogue supply every capability. No fixture action map or grant SQL.

const issuer = 'https://grant-routes.auth.test';
const audience = 'https://grant-routes.api.test';
const password = 'native grant routes registration password';
const routeKey = new Uint8Array(32).fill(71);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(72)]]) };
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let authName: string;
let authPool: Pool;
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let access: ReturnType<typeof createAccess>;
let grants: ReturnType<typeof createGrantCommands>;
let kernel: ReturnType<typeof createKernel>;
let signingKey: Awaited<ReturnType<typeof exportJWK>> & { kid: string };
let root: { accountId: string; bearer: string };
let grantor: typeof root;
let recipient: typeof root;
let scopes: string[];
let now = Date.now();
let fixedKernelTime = false;
let spends = 0;

async function issue(email: string, scope = scopes, requestedBy?: string) {
  const signed = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'grant-routes-client', scope }),
    }),
  );
  expect(signed.status).toBe(200);
  const cookie = signed.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const response = await service.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      body: JSON.stringify(requestedBy === undefined ? {} : { requested_by: requestedBy }),
    }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}
async function person(name: string) {
  const result = await host.workflows.register({ key: name, handle: name, email: `${name}@grant.test`, password });
  return { accountId: result.accountId, bearer: await issue(`${name}@grant.test`) };
}
async function call(
  bearer: string,
  path: string,
  body: unknown,
  key = Bun.randomUUIDv7(),
  extra: Record<string, string> = {},
) {
  if (!fixedKernelTime) now = Date.now();
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(key),
        ...extra,
      },
      body: JSON.stringify(body),
    }),
  );
  return { response, value: await response.json() };
}
const inputFor = (accountId: string, actions = ['context:create']) => ({
  resource: PLATFORM_RESOURCE,
  subject: { kind: 'account' as const, id: accountId },
  actions,
  valid: '(,)',
});
const context = async (bearer: string) => {
  if (!fixedKernelTime) now = Date.now();
  const boundary = { pool: db.pool, deadline: Date.now() + 10000 };
  return { ...boundary, actor: await access.authenticate(bearer, boundary) };
};
const effects = async () =>
  (
    await db.admin.query(`SELECT
  (SELECT count(*)::int FROM core.receipt) receipts,
  (SELECT count(*)::int FROM core.outbox) events,
  (SELECT count(*)::int FROM access.resource_grant) grants,
  (SELECT count(*)::int FROM access.resource_role_grant) roles`)
  ).rows;

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  // Context creation reads the active definition release before its grant check.
  await bootstrapRelease(db.pool, bundledRelease);
  const limiter = createWriteRateLimiter({
    secret: 'grant-routes-private-write-rate-secret-32bytes',
    overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 86400 } } }),
  });
  kernel = createKernel({
    pool: db.pool,
    receiptKeys: testReceiptKeys(),
    routeKey,
    tokens,
    clock: () => new Date(now),
    access: (config) =>
      createAccess({
        ...config,
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
        },
      }),
    onAccessReady: (resolved) => {
      access = resolved;
    },
    writeRate: {
      async spend(...args) {
        spends++;
        return limiter.spend(...args);
      },
    },
  });
  const actions = actionCatalogue(kernel);
  // media:complete is reserved to the confidential website client. gate:any is
  // internal to Access and is required to delegate platform.governance.
  scopes = [...new Set([...actions.keys()].filter((scope) => scope !== 'media:complete').concat('gate:any'))];
  authName = `grant_routes_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  authPool = new Pool({ connectionString: await createAuthDatabase(process.env.DATABASE_URL!, authName) });
  signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'grant-routes',
  };
  grants = createGrantCommands({ pool: db.pool, access, managementAction: 'access:grant' });
  // Compose the existing native human registration ports directly. The full
  // account binding also requires unmounted operator-management routes, which
  // belong to a separate module. No action is added to the mounted catalogue.
  const registration = createRegistrationProofBindings({ pool: db.pool, referenceKeys: tokens });
  const { ports: registrationPorts } = createRegistrationPorts({
    pool: db.pool,
    authPool,
    routeKey,
    referenceKeys: tokens,
  });
  host = await createAuthHost({
    database: authPool,
    systemDatabasePool: authPool,
    issuer,
    audience,
    secret: 'grant-routes-auth-persistent-secret-32bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: {
      ...createAuthBindings({
        pool: db.pool,
        ...registration,
        verifyPendingIdentity: registration.verifyNativePendingIdentity,
      }),
      readAssignment: (reference, actorId) => readAssignment(db.pool, reference, actorId),
    },
    access: registrationPorts,
    stagingKey: new Uint8Array(32).fill(73),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'grant-routes-executor',
  });
  service = host.service;
  await service.internal.registerClient({ clientId: 'grant-routes-client', firstParty: true, scopes });
  await host.start();
  root = await person('grant_root');
  grantor = await person('grant_grantor');
  recipient = await person('grant_recipient');
}, 60000);
afterAll(async () => {
  if (host) await host.stop();
  else await authPool?.end();
  if (authName) {
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = '/postgres';
    const owner = new Pool({ connectionString: url.toString(), max: 1 });
    try {
      await owner.query(`DROP DATABASE IF EXISTS "${authName}" WITH (FORCE)`);
    } finally {
      await owner.end();
    }
  }
  await db?.close();
});
afterEach(() => {
  fixedKernelTime = false;
});

test('real operator bootstrap then native binding grant enables HTTP delegation and a real protected action', async () => {
  const input = { ...inputFor(grantor.accountId, ['access:grant', 'context:create']), key: Bun.randomUUIDv7() };
  await expect(grants.create(await context(root.bearer), input)).rejects.toThrow();
  await bootstrapGovernance(db.pool, root.accountId);
  expect((await grants.create(await context(root.bearer), input)).replayed).toBe(false);
  expect((await call(recipient.bearer, '/v1/contexts', { labels: { en: 'Denied' } })).response.status).toBe(403);
  const before = await effects();
  const key = Bun.randomUUIDv7();
  const granted = await call(grantor.bearer, '/v1/grants', inputFor(recipient.accountId), key);
  expect(granted.response.status).toBe(201);
  expect(granted.value).toEqual({ grant: inputFor(recipient.accountId) });
  const session = granted.response.headers.get(SESSION_HEADER)!;
  expect(decodeSession(tokens, `account:${grantor.accountId}`, session)).toHaveLength(1);
  const after = await effects();
  expect(after[0].events).toBe(before[0].events + 1);
  expect((await call(grantor.bearer, '/v1/grants', inputFor(recipient.accountId), key)).value).toEqual(granted.value);
  expect(await effects()).toEqual(after);
  const created = await call(
    recipient.bearer,
    '/v1/contexts',
    { labels: { en: 'Granted context' } },
    Bun.randomUUIDv7(),
    { [SESSION_HEADER]: session },
  );
  expect(created.response.status).toBe(201);
  expect(created.value.context.labels).toEqual({ en: 'Granted context' });
});

test('actor grant, client scope, principal grant and every delegated action independently remain ceilings', async () => {
  const limited = await issue('grant_root@grant.test', ['access:grant']);
  // Auth verifies the actual assignment before issuing the delegated bearer. The
  // principal's missing resource grants remain an independent permission ceiling.
  const requestId = newId(routeOf(recipient.accountId)!);
  await db.admin.query(
    `INSERT INTO access.principal_assignment(route,principal_id,creator_principal_id,request_id,assigned_actor_id,valid,transaction_id)
    VALUES($1,$2,$2,$3,$4,'(,)',$5)`,
    [routeOf(recipient.accountId), recipient.accountId, requestId, root.accountId, Bun.randomUUIDv7()],
  );
  const delegated = await issue(
    'grant_root@grant.test',
    scopes,
    `urn:rezics:request:${recipient.accountId}:${requestId}`,
  );
  for (const [bearer, body] of [
    [recipient.bearer, inputFor(root.accountId)],
    [limited, inputFor(root.accountId)],
    [delegated, inputFor(root.accountId)],
    [root.bearer, inputFor(recipient.accountId, ['context:read'])],
    [root.bearer, inputFor(recipient.accountId, ['missing:action'])],
  ] as const) {
    const before = await effects();
    const result = await call(bearer, '/v1/grants', body);
    expect({ status: result.response.status, body, problem: result.value }).toMatchObject({ status: 403 });
    expect(result.value).not.toHaveProperty('grant');
    expect(await effects()).toEqual(before);
  }
});

test('change checks old actions and role delegation checks the complete resolved role', async () => {
  const before = await effects();
  expect(
    (
      await call(root.bearer, '/v1/grants:change', {
        ...inputFor(recipient.accountId),
        previous: { actions: ['context:read'], valid: '(,)' },
      })
    ).response.status,
  ).toBe(403);
  expect(
    (
      await call(grantor.bearer, '/v1/roleGrants', {
        resource: PLATFORM_RESOURCE,
        subject: { kind: 'active_accounts' },
        role: 'platform.governance',
        valid: '(,)',
      })
    ).response.status,
  ).toBe(403);
  expect(await effects()).toEqual(before);
});

test('removing either management or granted-action authority independently hides an existing receipt', async () => {
  const target = await person('grant_replay_target');
  const body = inputFor(target.accountId);
  const key = Bun.randomUUIDv7();
  expect((await call(grantor.bearer, '/v1/grants', body, key)).response.status).toBe(201);
  for (const action of ['access:grant', 'context:create']) {
    const rights = inputFor(grantor.accountId, [action]);
    expect((await call(root.bearer, '/v1/grants:revoke', rights)).response.status).toBe(200);
    const before = await effects();
    const denied = await call(grantor.bearer, '/v1/grants', body, key);
    expect(denied.response.status).toBe(403);
    expect(denied.value).not.toHaveProperty('grant');
    expect(await effects()).toEqual(before);
    expect((await call(root.bearer, '/v1/grants', rights)).response.status).toBe(201);
  }
});

test('closed bodies fail before rate spend or effects on every direct and role route', async () => {
  for (const path of [
    '/v1/grants',
    '/v1/grants:change',
    '/v1/grants:revoke',
    '/v1/roleGrants',
    '/v1/roleGrants:change',
    '/v1/roleGrants:revoke',
  ]) {
    const base = path.includes('roleGrants')
      ? { resource: PLATFORM_RESOURCE, subject: { kind: 'active_accounts' }, role: 'platform.governance', valid: '(,)' }
      : inputFor(recipient.accountId);
    const body = path.endsWith(':change')
      ? {
          ...base,
          previous: path.includes('roleGrants')
            ? { role: 'platform.governance', valid: '(,)' }
            : { actions: ['context:create'], valid: '(,)' },
        }
      : base;
    for (const field of ['key', 'grantor', 'clientId', 'scope', 'authorization']) {
      const before = await effects();
      const spent = spends;
      expect((await call(root.bearer, path, { ...body, [field]: 'injected' })).response.status).toBe(400);
      expect(spends).toBe(spent);
      expect(await effects()).toEqual(before);
    }
  }
  for (const body of [
    { ...inputFor(recipient.accountId), actions: Array(1001).fill('context:create') },
    { ...inputFor(recipient.accountId), subject: { kind: 'active_accounts', id: recipient.accountId } },
    { ...inputFor(recipient.accountId), resource: { ...PLATFORM_RESOURCE, authorization: true } },
    { ...inputFor(recipient.accountId), subjectId: recipient.accountId, subjectRole: '' },
  ]) {
    const spent = spends;
    expect((await call(root.bearer, '/v1/grants', body)).response.status).toBe(400);
    expect(spends).toBe(spent);
  }
});

test('the public grant schema refuses realm subjects before rate spend or effects', async () => {
  const before = await effects();
  const spent = spends;
  const result = await call(root.bearer, '/v1/grants', {
    ...inputFor(recipient.accountId),
    subject: { kind: 'realm', id: recipient.accountId, role: 'member' },
  });
  expect(result.response.status).toBe(400);
  expect(spends).toBe(spent);
  expect(await effects()).toEqual(before);
});

test('native resource, subject and interval failures return problems without effects', async () => {
  for (const body of [
    { ...inputFor(recipient.accountId), resource: { route: 1, id: PLATFORM_RESOURCE.id } },
    { ...inputFor(recipient.accountId), resource: { route: 0, id: newId(0) } },
    { ...inputFor(recipient.accountId), subject: { kind: 'account', id: '00000000-0000-0000-0000-000000000000' } },
    { ...inputFor(recipient.accountId), valid: 'invalid interval' },
    { ...inputFor(recipient.accountId), valid: '[2031-01-01,2030-01-01)' },
  ]) {
    const before = await effects();
    const result = await call(root.bearer, '/v1/grants', body);
    expect(result.response.status).toBe(403);
    expect(result.value.code).toBe('forbidden');
    expect(await effects()).toEqual(before);
  }
});

test('direct and role change/revoke routes retain native identities and legacy recipient representation', async () => {
  const account = await person('grant_mutations');
  const direct = {
    resource: PLATFORM_RESOURCE,
    subjectId: account.accountId,
    subjectRole: '',
    actions: ['context:create'],
    valid: '(,)',
  };
  expect((await call(root.bearer, '/v1/grants', direct)).response.status).toBe(201);
  const changed = {
    ...direct,
    valid: '[2030-01-01,2031-01-01)',
    previous: { actions: direct.actions, valid: direct.valid },
  };
  expect((await call(root.bearer, '/v1/grants:change', changed)).response.status).toBe(200);
  expect((await call(root.bearer, '/v1/grants:revoke', { ...direct, valid: changed.valid })).response.status).toBe(200);
  const role = {
    resource: PLATFORM_RESOURCE,
    subject: { kind: 'account', id: account.accountId },
    role: 'platform.governance',
    valid: '(,)',
  };
  expect((await call(root.bearer, '/v1/roleGrants', role)).response.status).toBe(201);
  const roleChanged = { ...role, valid: '[2030-01-01,2031-01-01)', previous: { role: role.role, valid: role.valid } };
  expect((await call(root.bearer, '/v1/roleGrants:change', roleChanged)).response.status).toBe(200);
  expect(
    (await call(root.bearer, '/v1/roleGrants:revoke', { ...role, valid: roleChanged.valid })).response.status,
  ).toBe(200);
});

test('the sole trusted clock controls command time and expired or revoked replay cannot disclose a receipt', async () => {
  const timed = await person('grant_timed');
  const target = await person('grant_clock_target');
  now = Date.now();
  fixedKernelTime = true;
  const at = now;
  const valid = `[${new Date(at - 1000).toISOString()},${new Date(at + 1000).toISOString()})`;
  const rights = { ...inputFor(timed.accountId, ['access:grant', 'context:create']), valid };
  expect((await call(root.bearer, '/v1/grants', rights)).response.status).toBe(201);
  const times: string[] = [];
  const authorize = access.authorize.bind(access);
  const observation = spyOn(access, 'authorize').mockImplementation(
    (client, actor, action, resource, evidence, time) => {
      if (time) times.push(authoritativeTimeValue(time));
      return authorize(client, actor, action, resource, evidence, time);
    },
  );
  const key = Bun.randomUUIDv7();
  const body = inputFor(target.accountId);
  expect((await call(timed.bearer, '/v1/grants', body, key)).response.status).toBe(201);
  expect(times).toHaveLength(2);
  expect(times.every((time) => Date.parse(time) === at)).toBe(true);
  observation.mockRestore();
  now = at + 2000;
  const before = await effects();
  const expired = await call(timed.bearer, '/v1/grants', body, key, { 'x-command-time': new Date(at).toISOString() });
  expect(expired.response.status).toBe(403);
  expect(expired.value).not.toHaveProperty('grant');
  expect(await effects()).toEqual(before);
  now = at;
  expect((await call(root.bearer, '/v1/grants:revoke', rights)).response.status).toBe(200);
  const revokedBefore = await effects();
  const revoked = await call(timed.bearer, '/v1/grants', body, key);
  expect(revoked.response.status).toBe(403);
  expect(revoked.value).not.toHaveProperty('grant');
  expect(await effects()).toEqual(revokedBefore);
});
