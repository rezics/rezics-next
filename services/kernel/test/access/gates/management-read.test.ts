import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { AccountActor } from '../../../src/request/access.ts';
import type { MountedRoute } from '../../../src/http/request.ts';

await import('reylo/register');
const { actorFixture } = await import('../actor-side-fixture.ts');
const { createPool } = await import('../../../src/database/pool.ts');
const { createAccess } = await import('../../../src/access/index.ts');
const { GLOBAL_CONTEXT } = await import('../../../src/access/gates/catalogue.ts');
const { readExposureManagementPage } = await import('../../../src/access/gates/management-read.ts');
const { parseExposure } = await import('../../../src/access/gates/declaration.ts');
const { createKernel } = await import('../../../src/http/kernel.ts');
const { actionCatalogue } = await import('../../../src/http/request.ts');
const { newId, routeOf } = await import('../../../src/route/route.ts');
const appModule = await import('../../../src/http/app.ts');
const governance = (await import('../../../src/access/platform-governance.json')).default;

const pool = createPool(process.env.DATABASE_URL!);
const action = 'exposure:manage_read';
const instant = new Date();
const cursorKeys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(109)]]) };
const groups = ['management_closed', 'management_future', 'management_open', 'management_past'];
let fixture: Awaited<ReturnType<typeof actorFixture>>;
let access: ReturnType<typeof createAccess>;
let kernel: ReturnType<typeof createKernel>;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let delegatedRequest: string;
const issuer = 'https://exposure-management.auth.test';
const audience = 'https://exposure-management.api.test';

async function bearer(accountId: string, scopes = [action], requestedBy?: string): Promise<string> {
  const iat = Math.floor(instant.getTime() / 1000) - 1;
  return new SignJWT({
    client_id: 'exposure-management',
    scope: scopes.join(' '),
    authn_epoch: 1,
    auth_time: iat,
    amr: ['pwd'],
    ...(requestedBy ? { requested_by: requestedBy } : {}),
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'management-key', typ: 'at+jwt' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(accountId)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 300)
    .sign(keys.privateKey);
}

async function grant(subject: string, grantedAction = action, resource = GLOBAL_CONTEXT) {
  await pool.query(
    `INSERT INTO access.resource_grant
      (route, resource_id, subject_id, action, valid, transaction_id)
     VALUES ($1, $2, $3, $4, '(,)', $5)`,
    [resource.route, resource.id, subject, grantedAction, fixture.transactionId],
  );
}

async function response(token?: string, query = '') {
  return kernel.handle(
    new Request(`http://kernel.test/v1/platform/exposure/management${query}`, {
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    }),
  );
}

async function identity(accountId = fixture.actorId, scopes = [action], requestedBy?: string) {
  return access.authenticate(await bearer(accountId, scopes, requestedBy), { pool, deadline: Date.now() + 15_000 });
}

async function nativeRead(
  actor: AccountActor,
  query: { cursor?: string; limit?: number } = {},
  routes: readonly MountedRoute[] = kernel.routes,
) {
  return readExposureManagementPage({ pool, access, clock: () => instant, cursorKeys, routes }, actor, query, {
    deadline: Date.now() + 15_000,
  });
}

beforeAll(async () => {
  fixture = await actorFixture(pool);
  const requestId = newId(routeOf(fixture.principalId)!);
  await pool.query(
    `INSERT INTO access.principal_assignment
      (route, principal_id, creator_principal_id, request_id, assigned_actor_id, valid, transaction_id)
     VALUES ($1, $2, $2, $3, $4, '(,)', $5)`,
    [routeOf(fixture.principalId), fixture.principalId, requestId, fixture.actorId, fixture.transactionId],
  );
  delegatedRequest = `urn:rezics:request:${fixture.principalId}:${requestId}`;
  keys = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'management-key' };
  const original = appModule.createApp;
  const composition = spyOn(appModule, 'createApp').mockImplementation((dependencies) => {
    const app = original(dependencies);
    for (const [index, group] of [...groups, groups[0]!].entries()) {
      const detail = {
        operationId: `fixture.management_${String.fromCharCode(97 + index)}`,
        'x-action': 'fixture:read',
        'x-exposure': `gate:${group}`,
        security: [{ bearerAuth: [] }, {}],
      };
      app.get(`/v1/management-fixture/${index}`, { detail }, () => ({ ok: true }));
    }
    const hidden = { hide: true, 'x-exposure': 'gate:management_hidden' };
    app.get('/v1/management-hidden', { detail: hidden }, () => ({}));
    return app;
  });
  try {
    kernel = createKernel({
      pool,
      routeKey: new Uint8Array(32).fill(113),
      tokens: cursorKeys,
      clock: () => instant,
      access: (config) => {
        access = createAccess({
          ...config,
          auth: { issuer, audience, jwksUrl: `${issuer}/jwks`, fetch: async () => Response.json({ keys: [jwk] }) },
        });
        return access;
      },
    });
  } finally {
    composition.mockRestore();
  }
  const earlier = new Date(instant.getTime() - 60_000).toISOString();
  for (const [group, start, end] of [
    [groups[2], earlier, null],
    [groups[1], new Date(instant.getTime() + 1).toISOString(), null],
    [groups[3], earlier, instant.toISOString()],
    ['management_unmounted', earlier, null],
    ['management_hidden', earlier, null],
  ]) {
    await pool.query(
      `INSERT INTO access.exposure_opening ("group", valid, transaction_id)
       VALUES ($1, tstzrange($2::timestamptz, $3::timestamptz, '[)'), $4)`,
      [group, start, end, fixture.transactionId],
    );
  }
});

afterAll(async () => {
  await pool.end();
});

describe('Exact current direct Global exposure management authority reads bounded installed groups and genuine temporal opening state without conflating viewer admission with public configuration', () => {
  test('requires the exact nonanonymous scope and direct Global grant for actor and current principal', async () => {
    const mounted = kernel.routes.find((route) => route.path === '/v1/platform/exposure/management');
    expect(mounted?.hooks?.detail).toMatchObject({
      operationId: 'exposure.read_management',
      'x-action': action,
      'x-exposure': 'public',
      security: [{ bearerAuth: [] }],
    });
    expect(actionCatalogue(kernel).get(action)).toMatchObject({ anonymous: false });
    expect(governance.actions).toContain(action);
    expect(governance.globalReach).not.toContain(action);
    expect((await response()).status).toBe(401);
    await grant(fixture.actorId, 'gate:any');
    await grant(fixture.actorId, action, fixture.resource);
    expect((await response(await bearer(fixture.actorId))).status).toBe(403);
    await grant(fixture.actorId);
    expect((await response(await bearer(fixture.actorId, ['exposure:read']))).status).toBe(403);
    expect((await response(await bearer(fixture.actorId, ['exposure:*']))).status).toBe(403);
    expect((await response(await bearer(fixture.actorId))).status).toBe(200);
    expect((await response(await bearer(fixture.actorId, [action], delegatedRequest))).status).toBe(403);
    await grant(fixture.principalId);
    expect((await response(await bearer(fixture.actorId, [action], delegatedRequest))).status).toBe(200);
    const floorActor = newId(0x1234);
    await fixture.account(floorActor);
    await grant(floorActor);
    await pool.query('UPDATE access.account SET minimum_authn_epoch = 2 WHERE account_id = $1', [floorActor]);
    expect((await response(await bearer(floorActor))).status).toBe(401);
    const roleActor = newId(0x1234);
    await fixture.account(roleActor);
    await pool.query(
      `INSERT INTO access.resource_role_grant (route, resource_id, subject_id, grant_role, valid, transaction_id)
       VALUES (0, $1, $2, 'platform.governance', '(,)', $3)`,
      [GLOBAL_CONTEXT.id, roleActor, fixture.transactionId],
    );
    expect((await response(await bearer(roleActor))).status).toBe(200);
  });

  test('reports installed configuration at one actual T independently of admission and returns a private closed page', async () => {
    const result = await response(await bearer(fixture.actorId), '?limit=100');
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    const page = await result.json();
    expect(Object.keys(page).sort()).toEqual(['actions', 'exposureGroups', 'next', 'viewer']);
    expect(page.viewer).toEqual({ accountId: fixture.actorId, clientId: 'exposure-management' });
    expect(Object.keys(page.viewer).sort()).toEqual(['accountId', 'clientId']);
    expect(page.actions).toEqual({ open: false, close: false });
    const installed = [
      ...new Set(
        kernel.routes.flatMap((route) => {
          if (route.hooks?.detail?.hide === true) return [];
          const exposure = parseExposure(route.hooks?.detail);
          return exposure.kind === 'gate' ? [exposure.group] : [];
        }),
      ),
    ].sort();
    expect(page.exposureGroups.map((item: { group: string }) => item.group)).toEqual(installed);
    expect(page.next).toBeNull();
    for (const item of page.exposureGroups) {
      expect(Object.keys(item).sort()).toEqual(['at', 'group', 'open']);
      expect(new Date(item.at).toISOString()).toBe(instant.toISOString());
    }
    expect(
      page.exposureGroups
        .filter((item: { group: string }) => groups.includes(item.group))
        .map((item: { open: boolean }) => item.open),
    ).toEqual([false, false, true, false]);
    const discovery = await kernel.handle(
      new Request('http://kernel.test/v1/platform/exposure', {
        headers: { authorization: `Bearer ${await bearer(fixture.actorId, ['exposure:read', 'fixture:read'])}` },
      }),
    );
    expect((await discovery.json()).admitted).toContain(groups[0]);
    expect((await nativeRead(await identity(), {})).exposureGroups.length).toBe(Math.min(20, installed.length));
  });

  test('returns independent current Global open and close advice and withdraws an action denied during observation', async () => {
    const openOnly = newId(0x1234);
    await fixture.account(openOnly);
    await grant(openOnly);
    await grant(openOnly, 'exposure:open');
    const openActor = await identity(openOnly, [action, 'exposure:open']);
    expect((await nativeRead(openActor)).actions).toEqual({ open: true, close: false });

    const closeOnly = newId(0x1234);
    await fixture.account(closeOnly);
    await grant(closeOnly);
    await grant(closeOnly, 'exposure:close');
    const closeActor = await identity(closeOnly, [action, 'exposure:close']);
    expect((await nativeRead(closeActor)).actions).toEqual({ open: false, close: true });

    const original = access.prepare!.bind(access);
    let openPreparations = 0;
    const interception = spyOn(access, 'prepare').mockImplementation(async (...args) => {
      if (args[1] === 'exposure:open' && ++openPreparations === 2) {
        await pool.query(
          `INSERT INTO access.resource_denial
           (route, resource_id, subject_id, action, reason, valid, transaction_id)
           VALUES (0, $1, $2, 'exposure:open', 'resource', '(,)', $3)`,
          [GLOBAL_CONTEXT.id, openOnly, fixture.transactionId],
        );
      }
      return original(...args);
    });
    try {
      expect((await nativeRead(openActor)).actions).toEqual({ open: false, close: false });
      expect(openPreparations).toBe(2);
    } finally {
      interception.mockRestore();
      await pool.query(
        "DELETE FROM access.resource_denial WHERE resource_id = $1 AND subject_id = $2 AND action = 'exposure:open'",
        [GLOBAL_CONTEXT.id, openOnly],
      );
    }
  });

  test('a failed installed action preparation makes the management read unavailable', async () => {
    await grant(fixture.actorId, 'exposure:open');
    const original = access.prepare!.bind(access);
    const interception = spyOn(access, 'prepare').mockImplementation(async (...args) => {
      if (args[1] === 'exposure:open') throw new Error('action preparation failed');
      return original(...args);
    });
    try {
      const result = await response(await bearer(fixture.actorId, [action, 'exposure:open']));
      expect(result.status).toBe(503);
      expect((await result.json()).code).toBe('dependency_unavailable');
    } finally {
      interception.mockRestore();
    }
  });

  test('rechecks real denials and current assignment before disclosure and distinguishes unavailable reads', async () => {
    const actor = await identity();
    const original = access.prepare!.bind(access);
    let preparations = 0;
    const interception = spyOn(access, 'prepare').mockImplementation(async (...args) => {
      if (args[1] === action && ++preparations === 2) {
        await pool.query(
          `INSERT INTO access.resource_denial
           (route, resource_id, subject_id, action, reason, valid, transaction_id)
           VALUES (0, $1, $2, $3, 'resource', '(,)', $4)`,
          [GLOBAL_CONTEXT.id, fixture.actorId, action, fixture.transactionId],
        );
      }
      return original(...args);
    });
    try {
      await expect(nativeRead(actor)).rejects.toMatchObject({ code: 'forbidden' });
      expect(preparations).toBe(2);
    } finally {
      interception.mockRestore();
      await pool.query(
        'DELETE FROM access.resource_denial WHERE resource_id = $1 AND subject_id = $2 AND action = $3',
        [GLOBAL_CONTEXT.id, fixture.actorId, action],
      );
    }
    await pool.query(
      'UPDATE access.principal_assignment SET valid = tstzrange(NULL, $2::timestamptz) WHERE principal_id = $1',
      [fixture.principalId, instant.toISOString()],
    );
    await expect(nativeRead(await identity(fixture.actorId, [action], delegatedRequest))).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      readExposureManagementPage(
        { pool, access, cursorKeys, routes: kernel.routes },
        actor,
        {},
        { deadline: Date.now() - 1 },
      ),
    ).rejects.toMatchObject({ name: 'AccessUnavailableError', reason: 'deadline' });
    // A real source connection failure stays unknown, even though a missing opening is closed.
    const unavailable = createPool(process.env.DATABASE_URL!);
    await unavailable.end();
    await expect(
      readExposureManagementPage(
        { pool: unavailable, access, cursorKeys, routes: kernel.routes },
        actor,
        {},
        { deadline: Date.now() + 5000 },
      ),
    ).rejects.toMatchObject({ code: 'dependency_unavailable' });
  });

  test('uses bounded signed keysets bound to current viewer, query and frozen mounted declarations', async () => {
    const actor = await identity();
    const routes = [...kernel.routes];
    const page = await nativeRead(actor, { limit: 1 }, routes);
    expect(page.exposureGroups).toHaveLength(1);
    expect(page.next).toBeString();
    const cursor = page.next!;
    const next = await nativeRead(actor, { limit: 1, cursor }, routes);
    expect(next.exposureGroups[0]!.group > page.exposureGroups[0]!.group).toBe(true);
    for (const limit of [0, 101, 1.5])
      await expect(nativeRead(actor, { limit })).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(nativeRead(actor, { limit: 2, cursor }, routes)).rejects.toMatchObject({ code: 'invalid_cursor' });
    await expect(nativeRead(actor, { limit: 1, cursor: `${cursor}x` }, routes)).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
    await expect(nativeRead(await identity(fixture.principalId), { limit: 1, cursor }, routes)).rejects.toMatchObject({
      code: 'invalid_cursor',
    });
    await expect(
      nativeRead({ ...actor, clientId: 'other-client' }, { limit: 1, cursor }, routes),
    ).rejects.toMatchObject({ code: 'forbidden' });
    const changed = routes.map((route) =>
      route.path === '/v1/management-fixture/0'
        ? { ...route, hooks: { detail: { ...route.hooks?.detail, 'x-exposure': 'gate:management_new' } } }
        : route,
    );
    await expect(nativeRead(actor, { limit: 1, cursor }, changed)).rejects.toMatchObject({ code: 'invalid_cursor' });
    // Mutating construction metadata after capture cannot change this catalogue or its cursor meaning.
    routes.push(changed.find((route) => route.path === '/v1/management-fixture/0')!);
    expect((await nativeRead(actor, { limit: 1, cursor }, routes)).exposureGroups).toEqual(next.exposureGroups);
    const later = () => new Date(instant.getTime() + 16 * 60_000);
    await expect(
      readExposureManagementPage(
        { pool, access, cursorKeys, routes, clock: later },
        actor,
        { limit: 1, cursor },
        { deadline: Date.now() + 15_000 },
      ),
    ).rejects.toMatchObject({ code: 'invalid_cursor' });
  });
});
