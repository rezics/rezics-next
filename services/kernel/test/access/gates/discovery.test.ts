import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { Client, Pool } from 'pg';
import { createAuthHost, type AuthService } from '@rezics/auth';
import { decodeJwt, exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose';
import { createAuthDatabase } from '../../support/auth-database.ts';

async function cloneAuthDatabase(): Promise<{ url: string; close(): Promise<void> }> {
  const name = `discovery_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
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
const { PLATFORM_RESOURCE } = await import('../../../src/access/bootstrap-governance.ts');
const { createAuthBindings } = await import('../../../src/access/auth-bindings.ts');
const { createRegistrationPorts } = await import('../../support/registration-ports.ts');
const { createRegistrationProofBindings } = await import('../../../src/access/registration-proof.ts');
const { createAccess, visibleOperations } = await import('../../../src/access/index.ts');
const { newId, routeOf } = await import('../../../src/route/route.ts');
const { createPool } = await import('../../../src/database/pool.ts');
const { createKernel } = await import('../../../src/http/kernel.ts');
const appModule = await import('../../../src/http/app.ts');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const root = new URL('../../../../../', import.meta.url).pathname;
const tag = Array.from(crypto.getRandomValues(new Uint8Array(6)), (byte) => String.fromCharCode(97 + (byte % 26))).join(
  '',
);
const issuer = `https://gate-discovery-${tag}.auth.test`;
const audience = `https://gate-discovery-${tag}.api.test`;
const password = 'native platform gate registration password';
const routeKey = new Uint8Array(32).fill(94);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(95)]]) };
const group = 'fixture_group';
const groupAction = `gate:${group}`;
const fixtureAction = 'fixture:read';
const clientScopes = ['access:grant', 'exposure:open', 'exposure:close', 'gate:any', fixtureAction];
const fixtures = [
  { method: 'GET', path: '/v1/public-fixture', operationId: 'fixture.public_read', exposure: 'public' },
  { method: 'GET', path: '/v1/gated-fixture', operationId: 'fixture.gated_read', exposure: `gate:${group}` },
] as const;

type Person = { accountId: string; email: string; bearer: string };
type Contract = {
  paths: Record<string, Record<string, { operationId?: string }>>;
  components: unknown;
};
const pool = createPool(databaseUrl);
let authDatabase: Awaited<ReturnType<typeof cloneAuthDatabase>>;
let authPool: Pool;
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let access: ReturnType<typeof createAccess>;
let kernel: ReturnType<typeof createKernel>;
let signingKey: Awaited<ReturnType<typeof exportJWK>> & { kid: string };
let clockTime = new Date('2026-06-01T12:00:00.000Z');
let staff: Person;
let ordinary: Person;
let gated: Person;
let principal: Person;
let bootstrapped = false;

function operationIds(document: Contract): string[] {
  const ids: string[] = [];
  for (const operations of Object.values(document.paths)) {
    for (const operation of Object.values(operations)) {
      if (typeof operation.operationId === 'string') ids.push(operation.operationId);
    }
  }
  return ids.sort();
}

function mountedOperations(): { operationId: string; exposure: string }[] {
  const operations: { operationId: string; exposure: string }[] = [];
  for (const route of kernel.routes) {
    const detail = route.hooks?.detail as Record<string, unknown> | undefined;
    if (!detail || detail.hide === true) continue;
    if (typeof detail.operationId !== 'string' || typeof detail['x-exposure'] !== 'string') continue;
    operations.push({ operationId: detail.operationId, exposure: detail['x-exposure'] });
  }
  return operations;
}

async function issue(email: string, scopes: readonly string[]): Promise<string> {
  const signed = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'gate-discovery-client', scope: scopes }),
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
  const email = `${name}@discovery.test`;
  const result = await host.workflows.register({ key: name, handle: name, email, password });
  return { accountId: result.accountId, email, bearer: await issue(email, scopes) };
}

async function get(path: string, bearer?: string): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}),
    }),
  );
  const body = (await response.json()) as Record<string, unknown>;
  return { response, body };
}

async function documentFor(bearer?: string): Promise<{ response: Response; document: Contract }> {
  const response = await kernel.handle(
    new Request('http://kernel.test/v1/openapi.json', {
      ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}),
    }),
  );
  const document = (await response.json()) as Contract;
  return { response, document };
}

async function post(
  path: string,
  bearer: string,
  body?: unknown,
): Promise<{ response: Response; body: Record<string, unknown> }> {
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
  expect(result.response.status, JSON.stringify(result.body)).toBe(201);
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

async function viewerFor(bearer?: string) {
  if (!bearer) return { kind: 'anonymous' as const };
  return access.authenticate(bearer, { pool, deadline: Date.now() + 15_000 });
}

async function discovered(bearer?: string) {
  const served = await documentFor(bearer);
  const viewer = await viewerFor(bearer);
  const visible = await visibleOperations({
    viewer,
    pool,
    access,
    routes: kernel.routes,
    deadline: Date.now() + 15_000,
    clock: () => new Date(clockTime),
  });
  return { served, visible };
}

beforeAll(async () => {
  const original = appModule.createApp;
  const composition = spyOn(appModule, 'createApp').mockImplementation((dependencies) => {
    const app = original(dependencies);
    const security = [{ bearerAuth: [] }, {}];
    const gatedDetail = {
      operationId: 'fixture.gated_read',
      'x-action': fixtureAction,
      'x-exposure': `gate:${group}`,
      security,
    };
    const publicDetail = {
      operationId: 'fixture.public_read',
      'x-action': fixtureAction,
      'x-exposure': 'public',
      security,
    };
    app.get('/v1/gated-fixture', { detail: gatedDetail }, () => ({ value: 'gated' }));
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
    kid: 'gate-discovery',
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
    secret: 'gate-discovery-auth-persistent-secret-32bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: createAuthBindings({
      pool,
      ...registration,
      verifyPendingIdentity: registration.verifyNativePendingIdentity,
    }),
    access: registrationPorts,
    stagingKey: new Uint8Array(32).fill(96),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'gate-discovery-executor',
  });
  service = host.service;
  await service.internal.registerClient({ clientId: 'gate-discovery-client', firstParty: true, scopes: clientScopes });
  await host.start();

  staff = await person(`d${tag}staff`, clientScopes);
  ordinary = await person(`d${tag}ordinary`, [fixtureAction]);
  gated = await person(`d${tag}tester`, [fixtureAction]);
  principal = await person(`d${tag}principal`, [fixtureAction]);

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
  bootstrapped = true;
  await grant(staff.bearer, gated.accountId, groupAction);
  const closed = await post(`/v1/platform/exposure/${group}:close`, staff.bearer);
  expect(closed.response.status).toBe(200);
}, 120_000);

afterAll(async () => {
  if (bootstrapped && staff) {
    await pool.query('DELETE FROM access.resource_role_grant WHERE subject_id = $1 AND grant_role = $2', [
      staff.accountId,
      'platform.governance',
    ]);
    await pool.query('DELETE FROM access.governance_bootstrap WHERE account_id = $1', [staff.accountId]);
  }
  await host?.stop();
  if (!host) await authPool?.end();
  await authDatabase?.close();
  await pool.end();
}, 60_000);

test('anonymous callers and ordinary accounts receive only the public contract', async () => {
  const closed = mountedOperations().filter((operation) => operation.exposure.startsWith('gate:'));
  expect(closed.some((operation) => operation.operationId === 'fixture.gated_read')).toBe(true);
  expect(closed.some((operation) => operation.exposure === 'gate:personal_library')).toBe(true);
  expect(closed.some((operation) => operation.exposure === 'gate:reading_progress')).toBe(true);

  for (const bearer of [undefined, ordinary.bearer]) {
    const { served, visible } = await discovered(bearer);
    expect(served.response.status).toBe(200);
    expect(served.response.headers.get('cache-control')).toBe('no-store');
    const ids = operationIds(served.document);
    expect(ids).toEqual(visible.map((operation) => operation.operationId).sort());
    expect(ids).toContain('fixture.public_read');
    expect(ids).toContain('openapi.read');
    for (const operation of closed) expect(ids).not.toContain(operation.operationId);
  }
});

test('a gated tester sees the operations of the gates it holds', async () => {
  const { served, visible } = await discovered(gated.bearer);
  const ids = operationIds(served.document);
  expect(ids).toEqual(visible.map((operation) => operation.operationId).sort());
  expect(ids).toContain('fixture.gated_read');
  expect(ids).toContain('fixture.public_read');
  for (const operation of mountedOperations()) {
    const held = operation.exposure === 'public' || operation.exposure === `gate:${group}`;
    expect(ids.includes(operation.operationId)).toBe(held);
  }
});

test('platform staff see every mounted operation', async () => {
  const { served, visible } = await discovered(staff.bearer);
  const ids = operationIds(served.document);
  const mounted = mountedOperations()
    .map((operation) => operation.operationId)
    .sort();
  expect(ids).toEqual(mounted);
  expect(ids).toEqual(visible.map((operation) => operation.operationId).sort());
  expect(served.response.headers.get('cache-control')).toBe('no-store');
});

test('an opened group appears for everyone from T and disappears again at close', async () => {
  // Command T must precede the evidence deadline, which sits a request budget past wall-clock now.
  const opening = new Date(Date.now() - 180_000 - (tag.charCodeAt(0) % 40) * 1000);
  clockTime = new Date(opening);
  let opened = false;
  try {
    const before = await discovered();
    expect(operationIds(before.served.document)).not.toContain('fixture.gated_read');

    const open = await post(`/v1/platform/exposure/${group}:open`, staff.bearer);
    expect(open.response.status, JSON.stringify(open.body)).toBe(200);
    expect(open.body).toMatchObject({ exposure: { group, open: true, changed: true } });
    opened = true;

    for (const bearer of [undefined, ordinary.bearer, gated.bearer]) {
      const view = await discovered(bearer);
      expect(operationIds(view.served.document)).toContain('fixture.gated_read');
      expect(view.visible.some((operation) => operation.operationId === 'fixture.gated_read')).toBe(true);
      const admitted = await get('/v1/gated-fixture', bearer);
      expect(admitted.response.status).toBe(200);
      expect(admitted.body).toEqual({ value: 'gated' });
    }

    clockTime = new Date(opening.getTime() - 1);
    const earlier = await discovered();
    expect(operationIds(earlier.served.document)).not.toContain('fixture.gated_read');
    const earlyAdmission = await get('/v1/gated-fixture');
    expect(earlyAdmission.response.status).toBe(403);
    expect(earlyAdmission.body).toMatchObject({ code: 'platform_closed' });

    clockTime = new Date(opening.getTime() + 1);
    const close = await post(`/v1/platform/exposure/${group}:close`, staff.bearer);
    expect(close.response.status).toBe(200);
    expect(close.body).toMatchObject({ exposure: { group, open: false, changed: true } });
    opened = false;
    const restored = await discovered(ordinary.bearer);
    expect(operationIds(restored.served.document)).not.toContain('fixture.gated_read');
    const closedAgain = await get('/v1/gated-fixture', ordinary.bearer);
    expect(closedAgain.response.status).toBe(403);
    expect(closedAgain.body).toMatchObject({ code: 'platform_closed' });
  } finally {
    if (opened) {
      clockTime = new Date(opening.getTime() + 1);
      await post(`/v1/platform/exposure/${group}:close`, staff.bearer);
    }
    clockTime = new Date('2026-06-01T12:00:00.000Z');
  }
});

test('served OpenAPI and visibleOperations agree with admission on every fixture route', async () => {
  const delegated = await delegatedBearer(gated, principal.accountId);
  const personas: { bearer?: string; name: string }[] = [
    { name: 'anonymous' },
    { name: 'ordinary', bearer: ordinary.bearer },
    { name: 'tester', bearer: gated.bearer },
    { name: 'staff', bearer: staff.bearer },
    { name: 'delegated', bearer: delegated },
  ];

  async function agree(name: string, bearer?: string) {
    const { served, visible } = await discovered(bearer);
    expect(served.response.status).toBe(200);
    const ids = operationIds(served.document);
    expect(ids, name).toEqual(visible.map((operation) => operation.operationId).sort());
    for (const fixture of fixtures) {
      const admission = await get(fixture.path, bearer);
      const listed = ids.includes(fixture.operationId);
      const shown = visible.some((operation) => operation.operationId === fixture.operationId);
      if (admission.response.status === 200) {
        expect(listed, `${name} ${fixture.operationId}`).toBe(true);
        expect(shown, `${name} ${fixture.operationId}`).toBe(true);
      } else {
        expect(admission.response.status, name).toBe(403);
        expect(admission.body, name).toMatchObject({ code: 'platform_closed' });
        expect(listed, `${name} ${fixture.operationId}`).toBe(false);
        expect(shown, `${name} ${fixture.operationId}`).toBe(false);
      }
    }
  }

  for (const persona of personas) await agree(persona.name, persona.bearer);

  await grant(staff.bearer, principal.accountId, groupAction);
  await agree('delegated-with-principal', delegated);

  const invalid = await kernel.handle(
    new Request('http://kernel.test/v1/openapi.json', { headers: { authorization: 'Bearer not-a-token' } }),
  );
  expect(invalid.status).toBe(401);
});
