import { randomBytes } from 'node:crypto';
import { spyOn } from 'bun:test';
import { Client, Pool, type PoolClient } from 'pg';
import { createAuthHost, type AuthService } from '@rezics/auth';
import { decodeJwt, exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose';
import { GLOBAL_CONTEXT_ID } from '../../../../../specs/platform-gates-driver.ts';
import type {
  Account,
  Exposure,
  GrowthAxis,
  HttpMethod,
  GrantEffect,
  MountedRoute,
  Operation,
  PlatformGateGrowthFixture,
  PlatformGatesDriver,
  PlatformGatesFixture,
  StoredGrant,
  Viewer,
} from '../../../../../specs/platform-gates-driver.ts';
import type { GrowthDatabase, Population } from '../../support/growth.ts';
import { createAuthDatabase } from '../../support/auth-database.ts';

await import('reylo/register');

const { createAuthBindings } = await import('../../../src/access/auth-bindings.ts');
const { bootstrapGovernance, PLATFORM_RESOURCE } = await import('../../../src/access/bootstrap-governance.ts');
const { createRegistrationPorts } = await import('../../support/registration-ports.ts');
const { createRegistrationProofBindings } = await import('../../../src/access/registration-proof.ts');
const { resourceRoleCatalogue } = await import('../../../src/access/resource-roles.ts');
const { newId, routeOf } = await import('../../../src/route/route.ts');
const { createPool, withConnection } = await import('../../../src/database/pool.ts');
const { ProblemError } = await import('../../../src/http/problem.ts');
const { createKernel } = await import('../../../src/http/kernel.ts');
const { createAccess, visibleOperations: productVisibleOperations } = await import('../../../src/access/index.ts');
const { customMethodPath } = await import('../../../src/http/custom-method.ts');
const appModule = await import('../../../src/http/app.ts');
const { actorFixture } = await import('../actor-side-fixture.ts');
const { openGrowthDatabase, seed: seedGrowthData } = await import('../../support/growth.ts');

const password = 'native platform gates fixture password';
const FIXTURE_GROUP = 'spec_fixture';
const FIXTURE_TABLES = new Map<string, string>();

type FixtureRoute = {
  readonly path: string;
  readonly operationId: string;
  readonly action: string;
  readonly exposure: Exposure;
  readonly table: string;
  readonly public: boolean;
};

type RecordValue = Record<string, unknown>;
type AccountRecord = Account & { readonly email: string };

let latestFixtureTime = Date.now();

function nextFixtureTime(): Date {
  latestFixtureTime = Math.max(Date.now(), latestFixtureTime + 1_000);
  return new Date(latestFixtureTime);
}

function alpha(index: number): string {
  let value = index;
  let result = '';
  do {
    result = String.fromCharCode(97 + (value % 26)) + result;
    value = Math.floor(value / 26);
  } while (value > 0);
  return result;
}

function tag(): string {
  return Array.from(randomBytes(10), (byte) => String.fromCharCode(97 + (byte % 26))).join('');
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mountedRoute(route: { method: string; path: string; hooks?: { detail?: unknown } }): MountedRoute {
  const detail = isRecord(route.hooks?.detail) ? route.hooks.detail : undefined;
  const exposure = detail?.['x-exposure'];
  return {
    id: `${route.method.toUpperCase()} ${route.path}`,
    hidden: detail?.hide === true,
    ...(typeof exposure === 'string' ? { exposure } : {}),
  };
}

function routeDetails(
  routes: readonly { method: string; path: string; hooks?: { detail?: unknown } }[],
  operationId: string,
) {
  const route = routes.find((candidate) => {
    const detail = candidate.hooks?.detail;
    return isRecord(detail) && detail.operationId === operationId;
  });
  if (!route) throw new Error(`Mounted fixture route ${operationId} was not found`);
  const detail = route.hooks?.detail;
  if (!isRecord(detail)) throw new Error(`Mounted fixture route ${operationId} has no detail`);
  return { route, detail };
}

function operationOf(
  routes: readonly { method: string; path: string; hooks?: { detail?: unknown } }[],
  operationId: string,
): Operation {
  const { route, detail } = routeDetails(routes, operationId);
  const method = route.method.toUpperCase() as HttpMethod;
  const action = detail['x-action'];
  const exposure = detail['x-exposure'];
  if (typeof action !== 'string' || typeof exposure !== 'string') {
    throw new Error(`Mounted fixture route ${operationId} is missing its action or exposure`);
  }
  const publicPath = customMethodPath(route.path).replace(/:([A-Za-z][A-Za-z0-9_]*)/g, '{$1}');
  return {
    id: operationId,
    method,
    path: route.path,
    openApiPath: publicPath,
    action,
    exposure: exposure as Exposure,
  };
}

function createFixtureRoutes(
  fixtureTag: string,
  tableNames: readonly string[],
  productionGroups: readonly string[],
): FixtureRoute[] {
  const routes: FixtureRoute[] = [
    {
      path: `/v1/platform-gate-fixture/${fixtureTag}/public`,
      operationId: `fixture_${fixtureTag}.public_read`,
      action: `gate:read_fixture_${fixtureTag}_public`,
      exposure: 'public',
      table: tableNames[0]!,
      public: true,
    },
    {
      path: `/v1/platform-gate-fixture/${fixtureTag}/spec`,
      operationId: `fixture_${fixtureTag}.spec_read`,
      action: `gate:read_fixture_${fixtureTag}_spec`,
      exposure: `gate:${FIXTURE_GROUP}`,
      table: tableNames[1]!,
      public: false,
    },
  ];
  productionGroups.forEach((group, index) => {
    routes.push({
      path: `/v1/platform-gate-fixture/${fixtureTag}/${group}`,
      operationId: `fixture_${fixtureTag}.production_read_${alpha(index)}`,
      action: `gate:read_fixture_${fixtureTag}_production_${alpha(index)}`,
      exposure: `gate:${group}`,
      table: tableNames[index + 2]!,
      public: false,
    });
  });
  return routes;
}

function instrumentFixtureReads(pool: Pool, counts: Record<string, number>): void {
  pool.on('connect', (client) => {
    const query = client.query.bind(client) as PoolClient['query'];
    client.query = ((...args: Parameters<PoolClient['query']>) => {
      const statement: unknown = args[0];
      const text =
        typeof statement === 'string'
          ? statement
          : typeof statement === 'object' &&
              statement !== null &&
              'text' in statement &&
              typeof (statement as { text?: unknown }).text === 'string'
            ? (statement as { text: string }).text
            : '';
      if (/^\s*SELECT\b/i.test(text)) {
        for (const [table, operationId] of FIXTURE_TABLES) {
          if (text.includes(table)) counts[operationId] = (counts[operationId] ?? 0) + 1;
        }
      }
      return query(...args);
    }) as PoolClient['query'];
  });
}

function tableSql(table: string): string {
  return `"${table.split('.')[0]}"."${table.split('.')[1]}"`;
}

export async function createPlatformGatesDriver(): Promise<PlatformGatesDriver> {
  const fixtureTime = nextFixtureTime();
  const fixtureTag = tag();
  const schema = `platform_gates_${fixtureTag}`;
  const routeKey = new Uint8Array(32).fill(117);
  const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(118)]]) };
  const issuer = `https://platform-gates-${fixtureTag}.auth.test`;
  const audience = `https://platform-gates-${fixtureTag}.api.test`;
  const clientId = `platform-gates-${fixtureTag}`;
  const signingKid = `platform-gates-${fixtureTag}`;

  let pool: Pool | undefined;
  let authName: string | undefined;
  let authPool: Pool | undefined;
  let host: Awaited<ReturnType<typeof createAuthHost>> | undefined;
  let service: AuthService | undefined;
  let kernel: ReturnType<typeof createKernel> | undefined;
  let productionKernel: ReturnType<typeof createKernel> | undefined;
  let access: ReturnType<typeof createAccess> | undefined;
  let signingKey: (Awaited<ReturnType<typeof exportJWK>> & { kid: string }) | undefined;
  let fixture: PlatformGatesFixture | undefined;
  let schemaCreated = false;
  let seeded = false;
  let closed = false;
  let clockTime = fixtureTime;
  const readCounts: Record<string, number> = {};
  const routes: FixtureRoute[] = [];
  let fixtureDescriptors: Operation[] = [];
  let productionDescriptors: MountedRoute[] = [];
  let closedDescriptors: Operation[] = [];
  let nativeScopes: string[] = [];

  function tick(): void {
    clockTime = nextFixtureTime();
  }

  function nativeService(): AuthService {
    if (!service) throw new Error('Platform gates Auth service was not initialized');
    return service;
  }

  function liveKernel(): ReturnType<typeof createKernel> {
    if (!kernel) throw new Error('Platform gates kernel was not initialized');
    return kernel;
  }

  function livePool(): Pool {
    if (!pool) throw new Error('Platform gates database pool was not initialized');
    return pool;
  }

  function liveAccess(): ReturnType<typeof createAccess> {
    if (!access) throw new Error('Platform gates Access instance was not initialized');
    return access;
  }

  function currentFixture(): PlatformGatesFixture {
    if (!fixture) throw new Error('Platform gates fixture was not seeded');
    return fixture;
  }

  async function openAt(group: string, at: Date): Promise<boolean> {
    const result = await livePool().query<{ open: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM access.exposure_opening
         WHERE "group" = $1 AND valid @> $2::timestamptz
       ) AS open`,
      [group, at.toISOString()],
    );
    return result.rows[0]?.open === true;
  }

  function kernelDependencies(withAuth: boolean) {
    return {
      pool: livePool(),
      routeKey,
      tokens,
      clock: () => new Date(clockTime),
      writeRate: {
        async spend() {
          return { allowed: true as const };
        },
      },
      access: (config: { actions: ReadonlyMap<string, { anonymous: boolean }> }) => {
        const configured = {
          actions: new Map(config.actions),
          ...(withAuth
            ? {
                auth: {
                  issuer,
                  audience,
                  jwksUrl: `${issuer}/.well-known/jwks.json`,
                  fetch: async () => nativeService().handler(new Request(`${issuer}/.well-known/jwks.json`)),
                },
              }
            : {}),
        };
        const created = createAccess(configured);
        if (withAuth) access = created;
        return created;
      },
    };
  }

  function buildKernel(withAuth: boolean, extraRoutes: readonly FixtureRoute[] = []) {
    const original = appModule.createApp;
    const composition = spyOn(appModule, 'createApp').mockImplementation((dependencies) => {
      const app = original(dependencies);
      for (const route of extraRoutes) {
        const detail = {
          operationId: route.operationId,
          'x-action': route.action,
          'x-exposure': route.exposure,
          security: route.public ? [{}, { bearerAuth: [] }] : [{ bearerAuth: [] }],
        };
        app.get(route.path, { detail }, async ({ actor, authorize }) => {
          if (!route.public && actor.kind === 'account') {
            const check = await authorize(PLATFORM_RESOURCE);
            const allowed = await withConnection(livePool(), (client) => check(client));
            if (!allowed) throw new ProblemError('forbidden');
          }
          const result = await withConnection(livePool(), (client) =>
            client.query<{ payload: RecordValue }>(`SELECT payload FROM ${tableSql(route.table)} WHERE id = 1`),
          );
          if (!result.rows[0]) throw new Error(`Missing fixture row for ${route.operationId}`);
          return result.rows[0].payload;
        });
      }
      return app;
    });
    try {
      return createKernel(kernelDependencies(withAuth));
    } finally {
      composition.mockRestore();
    }
  }

  async function initialize(): Promise<void> {
    if (kernel) return;
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
    pool = createPool(databaseUrl);
    instrumentFixtureReads(pool, readCounts);
    await pool.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;

    productionKernel = createKernel(kernelDependencies(false));
    productionDescriptors = productionKernel.routes.map(mountedRoute);
    const productionGroups: string[] = [];
    for (const route of productionKernel.routes) {
      const detail = route.hooks?.detail;
      if (!isRecord(detail) || detail.hide === true) continue;
      const exposure = detail['x-exposure'];
      if (typeof exposure !== 'string' || !exposure.startsWith('gate:')) continue;
      const group = exposure.slice('gate:'.length);
      if (group === FIXTURE_GROUP || productionGroups.includes(group)) continue;
      if (!(await openAt(group, fixtureTime))) productionGroups.push(group);
    }

    const tableCount = productionGroups.length + 2;
    const tables = Array.from({ length: tableCount }, (_, index) => `${schema}.route_${alpha(index)}`);
    for (const table of tables) {
      await pool.query(`CREATE TABLE ${tableSql(table)} (id integer PRIMARY KEY, payload jsonb NOT NULL)`);
      await pool.query(`INSERT INTO ${tableSql(table)} (id, payload) VALUES (1, '{"ok":true}'::jsonb)`);
    }

    routes.push(...createFixtureRoutes(fixtureTag, tables, productionGroups));
    for (const route of routes) FIXTURE_TABLES.set(tableSql(route.table), route.operationId);

    kernel = buildKernel(true, routes);
    const publicOperation = operationOf(kernel.routes, routes[0]!.operationId);
    const gatedOperation = operationOf(kernel.routes, routes[1]!.operationId);
    const otherClosed = routes.slice(2).map((route) => operationOf(kernel!.routes, route.operationId));
    closedDescriptors = [gatedOperation, ...otherClosed];
    fixtureDescriptors = [publicOperation, ...closedDescriptors];
    fixture = {
      accounts: {} as PlatformGatesFixture['accounts'],
      publicOperation,
      gatedOperation,
      closedOperations: closedDescriptors,
      operations: fixtureDescriptors,
    };
  }

  async function issue(email: string, scopes: readonly string[]): Promise<string> {
    const signed = await nativeService().handler(
      new Request(`${issuer}/signin`, {
        method: 'POST',
        headers: { origin: issuer, 'content-type': 'application/json' },
        body: JSON.stringify({ email, password, client_id: clientId, scope: scopes }),
      }),
    );
    if (signed.status !== 200) throw new Error(`Native Auth sign-in failed with ${signed.status}`);
    const cookie = signed.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const response = await nativeService().handler(
      new Request(`${issuer}/token`, {
        method: 'POST',
        headers: { origin: issuer, cookie, 'content-type': 'application/json' },
        body: '{}',
      }),
    );
    if (response.status !== 200) throw new Error(`Native Auth token exchange failed with ${response.status}`);
    return ((await response.json()) as { access_token: string }).access_token;
  }

  async function registerAccount(name: string, scopes: readonly string[]): Promise<AccountRecord> {
    if (!host) throw new Error('Platform gates Auth host was not initialized');
    const email = `${name}@platform-gates.test`;
    const registration = await host.workflows.register({ key: name, handle: name, email, password });
    return { id: registration.accountId, bearer: await issue(email, scopes), email };
  }

  async function delegatedBearer(actor: AccountRecord, principalId: string): Promise<string> {
    const route = routeOf(principalId);
    if (route === null || !signingKey) throw new Error('Expected a routeable principal and native signing key');
    const requestId = newId(route);
    await livePool().query(
      `INSERT INTO access.principal_assignment
         (route, principal_id, creator_principal_id, request_id, assigned_actor_id, valid, transaction_id)
       VALUES ($1, $2, $2, $3, $4, '(,)', $5)`,
      [route, principalId, requestId, actor.id, Bun.randomUUIDv7()],
    );
    return new SignJWT({
      ...decodeJwt<Record<string, unknown>>(actor.bearer),
      requested_by: `urn:rezics:request:${principalId}:${requestId}`,
    })
      .setProtectedHeader({ alg: 'ES256', kid: signingKid, typ: 'at+jwt' })
      .sign(await importJWK(signingKey, 'ES256'));
  }

  async function bootstrapStaff(accountId: string): Promise<void> {
    // Bootstrapping is deployment-only authority; its own pool keeps it outside the fixture's statement counting.
    const bootstrapPool = createPool(process.env.DATABASE_URL!);
    try {
      await bootstrapGovernance(bootstrapPool, accountId);
    } catch (error) {
      throw new Error(
        `Platform governance bootstrap failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      await bootstrapPool.end();
    }
  }

  async function dropAuthDatabase(name: string): Promise<void> {
    const url = new URL(process.env.DATABASE_URL!);
    url.pathname = '/postgres';
    const owner = new Client({ connectionString: url.toString() });
    await owner.connect();
    try {
      await owner.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    } finally {
      await owner.end();
    }
  }

  async function request(viewer: Viewer, method: HttpMethod, path: string, body?: unknown): Promise<Response> {
    tick();
    const headers: Record<string, string> = {};
    if (viewer.kind === 'account') headers.authorization = `Bearer ${viewer.account.bearer}`;
    if (viewer.kind === 'invalid-bearer') headers.authorization = `Bearer ${viewer.bearer}`;
    if (method !== 'GET') headers['idempotency-key'] = JSON.stringify(Bun.randomUUIDv7());
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await liveKernel().handle(new Request(`http://kernel.test${path}`, init));
    if (response.status >= 500 && process.env.PLATFORM_GATES_TRACE === '1') {
      console.error(`Platform gates fixture returned ${response.status}: ${await response.clone().text()}`);
    }
    return response;
  }

  async function grant(grantor: Account, recipient: Account, action: string, effect: GrantEffect): Promise<Response> {
    const body = {
      resource: PLATFORM_RESOURCE,
      subject: { kind: 'account', id: recipient.id },
      actions: [action],
      valid: '(,)',
    };
    const path = effect === 'allow' ? '/v1/grants' : '/v1/grants:revoke';
    return request({ kind: 'account', account: grantor }, 'POST', path, body);
  }

  async function grantsFor(accountId: string): Promise<readonly StoredGrant[]> {
    const at = clockTime.toISOString();
    const direct = await livePool().query<{
      transaction_id: string;
      action: string;
      valid: string;
      active: boolean;
    }>(
      `SELECT transaction_id::text, action, valid::text, valid @> $3::timestamptz AS active
       FROM access.resource_grant
       WHERE route = 0 AND resource_id = $1::uuid AND subject_kind = 'identity' AND subject_id = $2::uuid
       ORDER BY transaction_id, action, valid::text`,
      [GLOBAL_CONTEXT_ID, accountId, at],
    );
    const roleRows = await livePool().query<{
      transaction_id: string;
      grant_role: string;
      valid: string;
      active: boolean;
    }>(
      `SELECT transaction_id::text, grant_role, valid::text, valid @> $3::timestamptz AS active
       FROM access.resource_role_grant
       WHERE route = 0 AND resource_id = $1::uuid AND subject_kind = 'identity' AND subject_id = $2::uuid
       ORDER BY transaction_id, grant_role, valid::text`,
      [GLOBAL_CONTEXT_ID, accountId, at],
    );
    const roleActions = resourceRoleCatalogue(liveAccess())?.roles;
    const rows: StoredGrant[] = direct.rows.map((row) => ({
      id: `${row.transaction_id}:${row.action}:${row.valid}`,
      subjectAccountId: accountId,
      resourceId: GLOBAL_CONTEXT_ID,
      actions: [row.action],
      effect: 'allow',
      active: row.active,
    }));
    for (const row of roleRows.rows) {
      const actions = roleActions?.get(row.grant_role);
      if (!actions) continue;
      rows.push({
        id: `${row.transaction_id}:${row.grant_role}:${row.valid}`,
        subjectAccountId: accountId,
        resourceId: GLOBAL_CONTEXT_ID,
        actions,
        effect: 'allow',
        active: row.active,
      });
    }
    return rows;
  }

  async function fixtureDomainReadCount(operationId: string): Promise<number> {
    return readCounts[operationId] ?? 0;
  }

  async function exposureOpenAt(group: string): Promise<boolean> {
    return openAt(group, clockTime);
  }

  async function productionRoutes(): Promise<readonly MountedRoute[]> {
    return productionDescriptors;
  }

  async function visibleOperations(viewer: Viewer): Promise<readonly Operation[]> {
    if (!access) await request({ kind: 'anonymous' }, 'GET', '/v1/openapi.json');
    let actor;
    if (viewer.kind === 'anonymous') actor = { kind: 'anonymous' as const };
    else {
      const bearer = viewer.kind === 'account' ? viewer.account.bearer : viewer.bearer;
      actor = await liveAccess().authenticate(bearer, {
        pool: livePool(),
        deadline: Date.now() + 15_000,
      });
    }
    const visible = await productVisibleOperations({
      viewer: actor,
      pool: livePool(),
      access: liveAccess(),
      routes: liveKernel().routes,
      deadline: Date.now() + 15_000,
      clock: () => new Date(clockTime),
    });
    return visible.flatMap((candidate) => {
      const operation = fixtureDescriptors.find(
        (item) =>
          item.id === candidate.operationId &&
          item.method === candidate.method &&
          item.path === candidate.path &&
          item.action === candidate.action &&
          item.exposure === candidate.exposure,
      );
      return operation ? [operation] : [];
    });
  }

  async function buildWithRoute(route: { readonly exposure?: unknown }): Promise<void> {
    const original = appModule.createApp;
    const composition = spyOn(appModule, 'createApp').mockImplementation((dependencies) => {
      const app = original(dependencies);
      const detail: Record<string, unknown> = {
        operationId: 'fixture.declaration_probe',
        'x-action': 'fixture:declaration_probe',
        security: [{}],
      };
      if (Object.hasOwn(route, 'exposure')) detail['x-exposure'] = route.exposure;
      app.get('/v1/platform-gate-declaration-probe', { detail }, () => ({ ok: true }));
      return app;
    });
    try {
      createKernel(kernelDependencies(false));
    } finally {
      composition.mockRestore();
    }
  }

  async function seed(): Promise<PlatformGatesFixture> {
    if (seeded) throw new Error('Platform gates fixture can only be seeded once');
    await initialize();

    const name = `platform_gates_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
    authName = name;
    authPool = new Pool({ connectionString: await createAuthDatabase(process.env.DATABASE_URL!, name) });
    const privateKey = await generateKeyPair('ES256', { extractable: true });
    signingKey = { ...(await exportJWK(privateKey.privateKey)), kid: signingKid };
    const registration = createRegistrationProofBindings({ pool: livePool(), referenceKeys: tokens });
    const { ports: registrationPorts } = createRegistrationPorts({
      pool: livePool(),
      authPool,
      routeKey,
      referenceKeys: tokens,
    });
    host = await createAuthHost({
      database: authPool,
      systemDatabasePool: authPool,
      issuer,
      audience,
      secret: `platform-gates-auth-${fixtureTag}-persistent-secret-32bytes`,
      signing: { activeKid: signingKid, privateKeys: [signingKey] },
      trustedAccess: createAuthBindings({
        pool: livePool(),
        ...registration,
        verifyPendingIdentity: registration.verifyNativePendingIdentity,
      }),
      access: registrationPorts,
      stagingKey: new Uint8Array(32).fill(119),
      maintenanceSchedule: '0 0 1 1 *',
      executorId: `platform-gates-${fixtureTag}`,
    });
    service = host.service;

    const publicAction = routes[0]!.action;
    nativeScopes = [
      'access:grant',
      'exposure:open',
      'exposure:close',
      'openapi:read',
      'gate:any',
      `gate:${FIXTURE_GROUP}`,
      ...routes.slice(2).map((route) => route.exposure.slice('gate:'.length)),
      publicAction,
      ...routes.slice(1).map((route) => route.action),
    ];
    nativeScopes = [...nativeScopes].filter((scope, index) => nativeScopes.indexOf(scope) === index);
    await host.service.internal.registerClient({ clientId, firstParty: true, scopes: nativeScopes });
    await host.start();

    const staff = await registerAccount(`${fixtureTag}_staff`, nativeScopes);
    const ordinary = await registerAccount(`${fixtureTag}_ordinary`, nativeScopes);
    const testerActor = await registerAccount(`${fixtureTag}_tester`, nativeScopes);
    const testerPrincipal = await registerAccount(`${fixtureTag}_principal`, nativeScopes);
    const recipient = await registerAccount(`${fixtureTag}_recipient`, nativeScopes);
    const tester: AccountRecord = {
      ...testerActor,
      bearer: await delegatedBearer(testerActor, testerPrincipal.id),
      principalId: testerPrincipal.id,
    };
    const state = currentFixture();
    fixture = {
      ...state,
      accounts: {
        ordinary,
        tester,
        testerPrincipal,
        staff,
        recipient,
      },
    };

    await bootstrapStaff(staff.id);
    for (const account of [staff, ordinary, tester, testerPrincipal, recipient]) {
      for (const route of routes) {
        const response = await grant(staff, account, route.action, 'allow');
        if (response.status !== 201) {
          throw new Error(`Could not seed ${route.action} permission for ${account.id}: ${response.status}`);
        }
      }
    }

    seeded = true;
    return fixture;
  }

  async function growthFixture(axis: GrowthAxis): Promise<PlatformGateGrowthFixture> {
    const database: GrowthDatabase = await openGrowthDatabase();
    const growthTag = tag();
    const growthSchema = `gate_growth_${growthTag}`;
    let growthSchemaCreated = false;
    let growthKernel: ReturnType<typeof createKernel> | undefined;
    let token = '';
    let actorId = '';
    const unrelatedAccountIds: string[] = [];
    const rowsPerScaleUnit = 2_000;
    const growthTime = nextFixtureTime();
    const growthRouteKey = new Uint8Array(32).fill(121);
    const growthIssuer = `https://gate-growth-${growthTag}.auth.test`;
    const growthAudience = `https://gate-growth-${growthTag}.api.test`;
    const growthAction = 'fixture:read';
    const growthOperationId = `fixture_${growthTag}.growth_read`;
    const growthPath = `/v1/platform-gate-growth/${growthTag}`;

    try {
      const base = await actorFixture(database.pool, database.admin);
      actorId = base.actorId;
      const accountRoute = routeOf(actorId);
      if (accountRoute === null) throw new Error('Growth fixture actor must have a route');
      await database.admin.query(`CREATE SCHEMA "${growthSchema}"`);
      growthSchemaCreated = true;
      const domainTable = `${growthSchema}.closed_target`;
      await database.admin.query(
        `CREATE TABLE ${tableSql(domainTable)} (id integer PRIMARY KEY, payload jsonb NOT NULL)`,
      );
      await database.admin.query(`INSERT INTO ${tableSql(domainTable)} (id, payload) VALUES (1, '{"ok":true}'::jsonb)`);

      const population: Population = {
        name: `platform gate unrelated accounts ${growthTag}`,
        hotPartition: accountRoute >>> 4,
        hotShare: 1,
        rows(placement) {
          const id = newId(placement.route);
          unrelatedAccountIds[placement.ordinal] = id;
          return {
            'access.account': [
              {
                route: placement.route,
                account_id: id,
                kind: 'actor',
                state: 'active',
                transaction_id: Bun.randomUUIDv7(),
              },
            ],
          };
        },
      };
      await seedGrowthData({ pool: database.pool, admin: database.admin }, population, {
        from: 0,
        to: 64 * rowsPerScaleUnit,
      });
      const grants: Population = {
        name: `platform gate unrelated grants ${growthTag}`,
        hotPartition: 0,
        rows({ ordinal }) {
          const id = unrelatedAccountIds[ordinal];
          if (!id) throw new Error('Growth account seed is incomplete');
          return {
            'access.resource_grant': [
              {
                route: 0,
                resource_id: GLOBAL_CONTEXT_ID,
                subject_id: id,
                action: 'gate:unrelated',
                valid: '(,)',
                transaction_id: Bun.randomUUIDv7(),
              },
            ],
          };
        },
      };
      const openings: Population = {
        name: `platform gate unrelated openings ${growthTag}`,
        hotPartition: 0,
        rows({ ordinal }) {
          return {
            'access.exposure_opening': [
              {
                group: `other_${growthTag}_${alpha(ordinal)}`,
                valid: ordinal % 2 === 0 ? '[2000-01-01,2001-01-01)' : '[2000-01-01,)',
                transaction_id: Bun.randomUUIDv7(),
              },
            ],
          };
        },
      };
      // Keep the non-growing relation large enough for selective probes at the first scale too.
      await seedGrowthData(database, axis === 'unrelated-grants' ? openings : grants, {
        from: 0,
        to: rowsPerScaleUnit,
      });

      await database.admin.query(
        `INSERT INTO access.resource_grant
           (route, resource_id, subject_id, action, valid, transaction_id)
         VALUES (0, $1::uuid, $2::uuid, $3, '(,)', $4::uuid)`,
        [GLOBAL_CONTEXT_ID, actorId, growthAction, base.transactionId],
      );

      const keys = await generateKeyPair('ES256');
      const keySet = {
        keys: [
          {
            ...(await exportJWK(keys.publicKey)),
            kid: `growth-${growthTag}`,
            alg: 'ES256',
            use: 'sig',
          },
        ],
      };
      const now = Math.floor(Date.now() / 1000);
      token = await new SignJWT({
        iss: growthIssuer,
        aud: growthAudience,
        sub: actorId,
        client_id: `growth-${growthTag}`,
        scope: growthAction,
        authn_epoch: 1,
        iat: now,
        exp: now + 300,
        auth_time: now,
        amr: ['pwd'],
      })
        .setProtectedHeader({ alg: 'ES256', typ: 'at+jwt', kid: `growth-${growthTag}` })
        .sign(keys.privateKey);

      const original = appModule.createApp;
      const composition = spyOn(appModule, 'createApp').mockImplementation((dependencies) => {
        const app = original(dependencies);
        const detail = {
          operationId: growthOperationId,
          'x-action': growthAction,
          'x-exposure': `gate:${FIXTURE_GROUP}`,
          security: [{ bearerAuth: [] }],
        };
        app.get(growthPath, { detail }, async ({ authorize }) => {
          const check = await authorize(PLATFORM_RESOURCE);
          const allowed = await withConnection(database.pool, (client) => check(client));
          if (!allowed) throw new ProblemError('forbidden');
          const result = await withConnection(database.pool, (client) =>
            client.query(`SELECT payload FROM ${tableSql(domainTable)} WHERE id = 1`),
          );
          return (result.rows[0] as { payload: RecordValue }).payload;
        });
        return app;
      });
      let currentAccess: ReturnType<typeof createAccess> | undefined;
      try {
        growthKernel = createKernel({
          pool: database.pool,
          routeKey: growthRouteKey,
          clock: () => new Date(growthTime),
          writeRate: {
            async spend() {
              return { allowed: true as const };
            },
          },
          access: (config) => {
            currentAccess = createAccess({
              actions: new Map(config.actions),
              auth: {
                issuer: growthIssuer,
                audience: growthAudience,
                jwksUrl: `${growthIssuer}/jwks`,
                async fetch() {
                  return Response.json(keySet);
                },
              },
            });
            return currentAccess;
          },
        });
      } finally {
        composition.mockRestore();
      }
      if (
        (
          await database.admin.query<{ open: boolean }>(
            `SELECT EXISTS (SELECT 1 FROM access.exposure_opening WHERE "group" = $1 AND valid @> $2::timestamptz) AS open`,
            [FIXTURE_GROUP, growthTime.toISOString()],
          )
        ).rows[0]?.open
      ) {
        throw new Error('The fixed growth target must be closed at its fixture time');
      }

      return {
        database,
        async grow(scale, previous) {
          await seedGrowthData(database, axis === 'unrelated-grants' ? grants : openings, {
            from: previous * rowsPerScaleUnit,
            to: scale * rowsPerScaleUnit,
          });
        },
        async request(_repetition) {
          return growthKernel!.handle(
            new Request(`http://kernel.test${growthPath}`, {
              headers: { authorization: `Bearer ${token}` },
            }),
          );
        },
        async close() {
          try {
            if (growthSchemaCreated) await database.admin.query(`DROP SCHEMA IF EXISTS "${growthSchema}" CASCADE`);
          } finally {
            await database.close();
          }
        },
      };
    } catch (error) {
      try {
        if (growthSchemaCreated) await database.admin.query(`DROP SCHEMA IF EXISTS "${growthSchema}" CASCADE`);
      } finally {
        await database.close();
      }
      throw error;
    }
  }

  async function close(): Promise<void> {
    if (closed) return;
    let failure: unknown;
    const seededFixture = fixture;
    if (seededFixture && kernel && service) {
      for (const operation of seededFixture.closedOperations) {
        const group = operation.exposure.slice('gate:'.length);
        try {
          await request(
            { kind: 'account', account: seededFixture.accounts.staff },
            'POST',
            `/v1/platform/exposure/${group}:close`,
          );
        } catch (error) {
          failure ??= error;
        }
      }
    }
    if (pool && seededFixture?.accounts.staff) {
      try {
        await pool.query(
          `DELETE FROM access.resource_role_grant
           WHERE route = 0 AND resource_id = $1::uuid AND subject_kind = 'identity'
             AND subject_id = $2::uuid AND grant_role = 'platform.governance'`,
          [GLOBAL_CONTEXT_ID, seededFixture.accounts.staff.id],
        );
        await pool.query(
          `DELETE FROM access.governance_bootstrap WHERE route = 0 AND resource_id = $1::uuid AND account_id = $2::uuid`,
          [GLOBAL_CONTEXT_ID, seededFixture.accounts.staff.id],
        );
      } catch (error) {
        failure ??= error;
      }
    }
    if (pool && schemaCreated) {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } catch (error) {
        failure ??= error;
      }
    }
    if (host) {
      try {
        await host.stop();
      } catch (error) {
        failure ??= error;
      }
    } else if (authPool) {
      try {
        await authPool.end();
      } catch (error) {
        failure ??= error;
      }
    }
    if (authName) {
      try {
        await dropAuthDatabase(authName);
      } catch (error) {
        failure ??= error;
      }
    }
    if (pool) {
      try {
        await pool.end();
      } catch (error) {
        failure ??= error;
      }
    }
    closed = true;
    for (const route of routes) FIXTURE_TABLES.delete(tableSql(route.table));
    if (failure) throw failure;
  }

  return {
    seed,
    close,
    buildWithRoute,
    productionRoutes,
    request,
    grant,
    grantsFor,
    fixtureDomainReadCount,
    exposureOpenAt,
    visibleOperations,
    growthFixture,
  };
}
