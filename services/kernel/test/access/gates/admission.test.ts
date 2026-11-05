import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { Client, Pool } from 'pg';
import { createAuthHost, type AuthService } from '@rezics/auth';
import { decodeJwt, exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose';
import { createAuthDatabase } from '../../support/auth-database.ts';

async function cloneAuthDatabase(): Promise<{ url: string; close(): Promise<void> }> {
  const name = `admission_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  const url = await createAuthDatabase(process.env.DATABASE_URL!, name);
  return {
    url,
    async close() {
      const admin = new URL(process.env.DATABASE_URL!);
      admin.pathname = '/postgres';
      const owner = new Client({ connectionString: admin.toString() });
      await owner.connect();
      try {
        await owner.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await owner.end();
      }
    },
  };
}

await import('reylo/register');
const { createAuthBindings } = await import('../../../src/access/auth-bindings.ts');
const { PLATFORM_RESOURCE } = await import('../../../src/access/bootstrap-governance.ts');
const { createRegistrationPorts } = await import('../../support/registration-ports.ts');
const { createRegistrationProofBindings } = await import('../../../src/access/registration-proof.ts');
const { newId, routeOf } = await import('../../../src/route/route.ts');
const { createPool, withConnection } = await import('../../../src/database/pool.ts');
const { ProblemError } = await import('../../../src/http/problem.ts');
const { createKernel } = await import('../../../src/http/kernel.ts');
const { defineRateLimit } = await import('../../../src/http/rate-limit.ts');
const appModule = await import('../../../src/http/app.ts');
const { createAccess } = await import('../../../src/access/index.ts');
const { deriveAccess } = await import('../../../src/access/derived-access.ts');
const { createGrantCommands } = await import('../../../src/access/grant-commands.ts');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const root = new URL('../../../../../', import.meta.url).pathname;
const issuer = 'https://gate-admission.auth.test';
const audience = 'https://gate-admission.api.test';
const password = 'native platform gate registration password';
const routeKey = new Uint8Array(32).fill(91);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(92)]]) };
const operationAction = 'fixture:create';
const groupAction = 'gate:fixture_group';
const group = 'fixture_group';
const clientScopes = ['access:grant', operationAction, 'exposure:open', 'exposure:close', 'gate:any', groupAction];

type Person = { accountId: string; email: string; bearer: string };
const pool = createPool(databaseUrl);
let authDatabase: Awaited<ReturnType<typeof cloneAuthDatabase>>;
let authPool: Pool;
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let access: ReturnType<typeof createAccess>;
let kernel: ReturnType<typeof createKernel>;
let signingKey: Awaited<ReturnType<typeof exportJWK>> & { kid: string };
let clockTime = new Date();
let domainReads = 0;
let handlerCalls = 0;
let staff: Person;
let ordinary: Person;
let gated: Person;
let principal: Person;

async function issue(email: string, scopes: readonly string[]): Promise<string> {
  const signed = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'gate-admission-client', scope: scopes }),
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
      headers: { origin: issuer, cookie, 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

async function person(name: string, scopes: readonly string[]): Promise<Person> {
  const email = `${name}@gate.test`;
  const result = await host.workflows.register({ key: name, handle: name, email, password });
  return { accountId: result.accountId, email, bearer: await issue(email, scopes) };
}

async function get(path: string, bearer?: string): Promise<{ response: Response; body: Record<string, unknown> }> {
  clockTime = new Date();
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}),
    }),
  );
  const body = (await response.json()) as Record<string, unknown>;
  return { response, body };
}

async function post(
  path: string,
  bearer: string,
  body?: unknown,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  clockTime = new Date();
  const headers: Record<string, string> = {
    authorization: `Bearer ${bearer}`,
    'idempotency-key': JSON.stringify(Bun.randomUUIDv7()),
  };
  const init: RequestInit = { method: 'POST', headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const response = await kernel.handle(new Request(`http://kernel.test${path}`, init));
  const result = (await response.json()) as Record<string, unknown>;
  return { response, body: result };
}

async function grant(bearer: string, accountId: string, action: string): Promise<void> {
  const result = await post('/v1/grants', bearer, {
    resource: PLATFORM_RESOURCE,
    subject: { kind: 'account', id: accountId },
    actions: [action],
    valid: '(,)',
  });
  expect(result.response.status).toBe(201);
}

async function delegatedBearer(actor: Person, principalId: string): Promise<string> {
  const route = routeOf(principalId);
  if (route === null) throw new Error('Expected a routeable principal');
  const requestId = newId(route);
  await pool.query(
    `INSERT INTO access.principal_assignment
       (route, principal_id, creator_principal_id, request_id, assigned_actor_id, valid, transaction_id)
     VALUES ($1, $2, $2, $3, $4, '(,)', $5)`,
    [route, principalId, requestId, actor.accountId, Bun.randomUUIDv7()],
  );
  return new SignJWT({
    ...decodeJwt<Record<string, unknown>>(actor.bearer),
    requested_by: `urn:rezics:request:${principalId}:${requestId}`,
  })
    .setProtectedHeader({ alg: 'ES256', kid: signingKey.kid, typ: 'at+jwt' })
    .sign(await importJWK(signingKey, 'ES256'));
}

beforeAll(async () => {
  const original = appModule.createApp;
  const composition = spyOn(appModule, 'createApp').mockImplementation((dependencies) => {
    const app = original(dependencies);
    const gatedDetail = {
      operationId: 'fixture.gated_read',
      'x-action': operationAction,
      'x-exposure': `gate:${group}`,
      'x-rate-limit': defineRateLimit({ family: 'write', units: 1 }),
      security: [{ bearerAuth: [] }],
    };
    const publicDetail = {
      operationId: 'fixture.public_read',
      'x-action': 'fixture:read',
      'x-exposure': 'public',
      security: [{}],
    };
    app.get('/v1/gated-fixture', { detail: gatedDetail }, async ({ authorize }) => {
      handlerCalls++;
      const check = await authorize(PLATFORM_RESOURCE);
      if (!(await withConnection(pool, (client) => check(client)))) throw new ProblemError('forbidden');
      domainReads++;
      return { value: 'gated' };
    });
    app.get('/v1/public-fixture', { detail: publicDetail }, () => ({ value: 'public' }));
    return app;
  });

  kernel = createKernel({
    pool,
    routeKey,
    tokens,
    clock: () => new Date(clockTime),
    writeRate: {
      async spend() {
        return { allowed: true as const };
      },
    },
    access: (config) => {
      access = createAccess({
        actions: new Map(config.actions),
        auth: {
          issuer,
          audience,
          jwksUrl: `${issuer}/.well-known/jwks.json`,
          fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
        },
      });
      return access;
    },
  });
  composition.mockRestore();

  authDatabase = await cloneAuthDatabase();
  authPool = new Pool({ connectionString: authDatabase.url });
  signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'gate-admission',
  };
  const registration = createRegistrationProofBindings({ pool, referenceKeys: tokens });
  const { ports: registrationPorts } = createRegistrationPorts({
    pool,
    authPool,
    routeKey,
    referenceKeys: tokens,
  });
  host = await createAuthHost({
    database: authPool,
    systemDatabasePool: authPool,
    issuer,
    audience,
    secret: 'gate-admission-auth-persistent-secret-32bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: createAuthBindings({
      pool,
      ...registration,
      verifyPendingIdentity: registration.verifyNativePendingIdentity,
    }),
    access: registrationPorts,
    stagingKey: new Uint8Array(32).fill(93),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'gate-admission-executor',
  });
  service = host.service;
  await service.internal.registerClient({ clientId: 'gate-admission-client', firstParty: true, scopes: clientScopes });
  await host.start();

  staff = await person('gate_platform_staff', clientScopes);
  ordinary = await person('gate_ordinary_account', [operationAction]);
  gated = await person('gate_group_tester', [operationAction]);
  principal = await person('gate_ungranted_principal', [operationAction]);

  const child = Bun.spawn(['bun', 'services/kernel/scripts/bootstrap-governance.ts', '--account', staff.accountId], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: '', stderr: '' });
  await grant(staff.bearer, gated.accountId, groupAction);
  // The native fixture owns this action; platform governance does not include it.
  // Seed staff once through the native command, retaining real account admission
  // and access:grant authorization. Later grants use the ordinary route.
  const fixtureAccess = deriveAccess(access, {
    async authorize(client, actor, action, resource, evidence, time) {
      if (
        actor.kind === 'account' &&
        actor.accountId === staff.accountId &&
        action === operationAction &&
        resource.route === PLATFORM_RESOURCE.route &&
        resource.id === PLATFORM_RESOURCE.id
      )
        return true;
      return access.authorize(client, actor, action, resource, evidence, time);
    },
  });
  const context = { pool, deadline: Date.now() + 20_000 };
  const actor = await access.authenticate(staff.bearer, context);
  const seeded = await createGrantCommands({ pool, access: fixtureAccess, managementAction: 'access:grant' }).create(
    { ...context, actor },
    {
      resource: PLATFORM_RESOURCE,
      subject: { kind: 'account', id: staff.accountId },
      actions: [operationAction],
      valid: '(,)',
      key: Bun.randomUUIDv7(),
    },
  );
  expect(seeded.value).toEqual({
    resource: PLATFORM_RESOURCE,
    subject: { kind: 'account', id: staff.accountId },
    actions: [operationAction],
    valid: '(,)',
  });
}, 90_000);

afterAll(async () => {
  await host?.stop();
  if (!host) await authPool?.end();
  await authDatabase?.close();
  await pool.end();
}, 60_000);

test('closed gate returns the same platform_closed to anonymous and ordinary accounts before domain reads', async () => {
  const before = { handlerCalls, domainReads };
  const anonymous = await get('/v1/gated-fixture');
  const account = await get('/v1/gated-fixture', ordinary.bearer);
  expect(anonymous.response.status).toBe(403);
  expect(account.response.status).toBe(403);
  expect(anonymous.body).toMatchObject({
    type: 'https://rezics.com/problems/platform_closed',
    status: 403,
    code: 'platform_closed',
  });
  expect(account.body).toMatchObject({
    type: 'https://rezics.com/problems/platform_closed',
    status: 403,
    code: 'platform_closed',
  });
  expect(handlerCalls).toBe(before.handlerCalls);
  expect(domainReads).toBe(before.domainReads);

  const invalid = await get('/v1/gated-fixture', 'not-a-valid-bearer');
  expect(invalid.response.status).toBe(401);
  expect(invalid.body).toMatchObject({ status: 401, code: 'invalid_credentials' });
  expect(invalid.response.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  expect(handlerCalls).toBe(before.handlerCalls);
  expect(domainReads).toBe(before.domainReads);
  const publicRoute = await get('/v1/public-fixture');
  expect(publicRoute.response.status).toBe(200);
  expect(publicRoute.body).toEqual({ value: 'public' });
});

test('a gate grant admits the account but still requires operation authorization and the principal gate', async () => {
  const noOperationGrant = await get('/v1/gated-fixture', gated.bearer);
  expect(noOperationGrant.response.status).toBe(403);
  expect(noOperationGrant.body).toMatchObject({ code: 'forbidden' });
  expect(handlerCalls).toBe(1);
  expect(domainReads).toBe(0);

  const delegated = await delegatedBearer(gated, principal.accountId);
  const noPrincipalGate = await get('/v1/gated-fixture', delegated);
  expect(noPrincipalGate.response.status).toBe(403);
  expect(noPrincipalGate.body).toMatchObject({ code: 'platform_closed' });
  expect(handlerCalls).toBe(1);
  expect(domainReads).toBe(0);

  await grant(staff.bearer, gated.accountId, operationAction);
  const authorized = await get('/v1/gated-fixture', gated.bearer);
  expect(authorized.response.status).toBe(200);
  expect(authorized.body).toEqual({ value: 'gated' });
  expect(domainReads).toBe(1);
});

test('opening is public from T, close restores denial, and gate:any admits platform staff', async () => {
  const open = await post(`/v1/platform/exposure/${group}:open`, staff.bearer);
  const openedAt = clockTime.getTime();
  expect(open.response.status).toBe(200);
  expect(open.body).toMatchObject({ exposure: { group, open: true, changed: true } });
  const openNoop = await post(`/v1/platform/exposure/${group}:open`, staff.bearer);
  expect(openNoop.response.status).toBe(200);
  expect(openNoop.body).toMatchObject({ exposure: { group, open: true, changed: false } });

  const publicWhileOpen = await get('/v1/gated-fixture');
  expect(publicWhileOpen.response.status).toBe(403);
  expect(publicWhileOpen.body).toMatchObject({ code: 'forbidden' });

  const staffRead = await get('/v1/gated-fixture', staff.bearer);
  expect(staffRead.response.status).toBe(200);
  expect(staffRead.body).toEqual({ value: 'gated' });

  const close = await post(`/v1/platform/exposure/${group}:close`, staff.bearer);
  expect(clockTime.getTime()).toBeGreaterThan(openedAt);
  expect(close.response.status).toBe(200);
  expect(close.body).toMatchObject({ exposure: { group, open: false, changed: true } });
  const closedAgain = await get('/v1/gated-fixture');
  expect(closedAgain.response.status).toBe(403);
  expect(closedAgain.body).toMatchObject({ code: 'platform_closed' });
  const closeNoop = await post(`/v1/platform/exposure/${group}:close`, staff.bearer);
  expect(closeNoop.response.status).toBe(200);
  expect(closeNoop.body).toMatchObject({ exposure: { group, open: false, changed: false } });
  const staffGateAny = await get('/v1/gated-fixture', staff.bearer);
  expect(staffGateAny.response.status).toBe(200);
  expect(staffGateAny.body).toEqual({ value: 'gated' });
});
