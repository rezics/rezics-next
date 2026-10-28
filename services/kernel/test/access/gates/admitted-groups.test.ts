import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

await import('reylo/register');
const { actorFixture } = await import('../actor-side-fixture.ts');
const { createPool } = await import('../../../src/database/pool.ts');
const { createAccess, visibleOperations } = await import('../../../src/access/index.ts');
const { GLOBAL_CONTEXT } = await import('../../../src/access/gates/catalogue.ts');
const { parseExposure } = await import('../../../src/access/gates/declaration.ts');
const { newId, routeOf } = await import('../../../src/route/route.ts');
const { createKernel } = await import('../../../src/http/kernel.ts');
const { actionCatalogue } = await import('../../../src/http/request.ts');
const appModule = await import('../../../src/http/app.ts');

const pool = createPool(process.env.DATABASE_URL!);
const instant = new Date();
let now = new Date(instant);
const groups = {
  a: 'admitted_open_a',
  z: 'admitted_open_z',
  secret: 'admitted_secret',
  future: 'admitted_future',
  past: 'admitted_past',
};
const opened = [groups.a, groups.z];
const issuer = 'https://admitted.auth.test';
const audience = 'https://admitted.api.test';
let fixture: Awaited<ReturnType<typeof actorFixture>>;
let access: ReturnType<typeof createAccess>;
let kernel: ReturnType<typeof createKernel>;
let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let ordinaryId: string;
let delegatedRequest: string;

async function bearer(
  accountId: string,
  requestedBy?: string,
  scopes = ['exposure:read', 'fixture:read'],
): Promise<string> {
  const iat = Math.floor(instant.getTime() / 1000) - 1;
  return new SignJWT({
    client_id: 'admitted-groups',
    scope: scopes.join(' '),
    authn_epoch: 1,
    auth_time: iat,
    amr: ['pwd'],
    ...(requestedBy ? { requested_by: requestedBy } : {}),
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'admitted-key', typ: 'at+jwt' })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(accountId)
    .setIssuedAt(iat)
    .setExpirationTime(iat + 300)
    .sign(keys.privateKey);
}

async function grant(accountId: string, action: string, resource = GLOBAL_CONTEXT): Promise<void> {
  await pool.query(
    `INSERT INTO access.resource_grant
       (route, resource_id, subject_id, action, valid, transaction_id)
     VALUES ($1, $2, $3, $4, '(,)', $5)`,
    [resource.route, resource.id, accountId, action, fixture.transactionId],
  );
}

function mountedGroups(): string[] {
  return [
    ...new Set(
      kernel.routes.flatMap((route) => {
        if (route.hooks?.detail?.hide === true) return [];
        const exposure = parseExposure(route.hooks?.detail);
        return exposure.kind === 'gate' ? [exposure.group] : [];
      }),
    ),
  ].sort();
}

async function read(token?: string): Promise<string[]> {
  const response = await kernel.handle(
    new Request('http://kernel.test/v1/platform/exposure', {
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    }),
  );
  const text = await response.text();
  expect(response.status, text).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = JSON.parse(text) as { admitted: string[] };
  expect(Object.keys(body)).toEqual(['admitted']);
  expect(body.admitted).toEqual([...new Set(body.admitted)].sort());
  const viewer = token
    ? await access.authenticate(token, { pool, deadline: Date.now() + 15_000 })
    : { kind: 'anonymous' as const };
  const visible = await visibleOperations({
    viewer,
    pool,
    access,
    routes: kernel.routes,
    deadline: Date.now() + 15_000,
    clock: () => new Date(now),
  });
  const visibleGroups = visible.flatMap((operation) =>
    operation.exposure.startsWith('gate:') ? [operation.exposure.slice(5)] : [],
  );
  expect(body.admitted).toEqual([...new Set(visibleGroups)].sort());
  for (const group of mountedGroups().filter((group) => !body.admitted.includes(group))) {
    expect(text).not.toContain(group);
  }
  return body.admitted;
}

beforeAll(async () => {
  fixture = await actorFixture(pool);
  ordinaryId = newId(0x1234);
  await fixture.account(ordinaryId);
  const principalRoute = routeOf(fixture.principalId)!;
  const requestId = newId(principalRoute);
  await pool.query(
    `INSERT INTO access.principal_assignment
       (route, principal_id, creator_principal_id, request_id, assigned_actor_id, valid, transaction_id)
     VALUES ($1, $2, $2, $3, $4, '(,)', $5)`,
    [principalRoute, fixture.principalId, requestId, fixture.actorId, fixture.transactionId],
  );
  delegatedRequest = `urn:rezics:request:${fixture.principalId}:${requestId}`;
  keys = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), kid: 'admitted-key' };
  const original = appModule.createApp;
  const composition = spyOn(appModule, 'createApp').mockImplementation((dependencies) => {
    const app = original(dependencies);
    for (const [index, group] of [...Object.values(groups), groups.a].entries()) {
      const detail = {
        operationId: `fixture.${group}_${String.fromCharCode(97 + index)}`,
        'x-action': 'fixture:read',
        'x-exposure': `gate:${group}`,
        security: [{ bearerAuth: [] }, {}],
      };
      app.get(`/v1/admitted-fixture/${group}/${app.routes.length}`, { detail }, () => ({ ok: true }));
    }
    const hidden = { hide: true, 'x-exposure': 'gate:admitted_hidden' };
    app.get(
      '/v1/admitted-hidden',
      {
        detail: hidden,
      },
      () => ({ ok: true }),
    );
    return app;
  });
  try {
    kernel = createKernel({
      pool,
      routeKey: new Uint8Array(32).fill(107),
      clock: () => new Date(now),
      access: (config) => {
        access = createAccess({
          ...config,
          auth: {
            issuer,
            audience,
            jwksUrl: `${issuer}/jwks`,
            fetch: async () => Response.json({ keys: [jwk] }),
          },
        });
        return access;
      },
    });
  } finally {
    composition.mockRestore();
  }
  // The authenticator is lazily composed by the HTTP request stage.
  const earlier = new Date(instant.getTime() - 60_000).toISOString();
  for (const [group, start, end] of [
    [groups.a, instant.toISOString(), null],
    [groups.z, earlier, null],
    [groups.future, new Date(instant.getTime() + 1).toISOString(), null],
    [groups.past, earlier, instant.toISOString()],
    ['admitted_unmounted', earlier, null],
    ['admitted_hidden', earlier, null],
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

test('an anonymous caller sees exactly the mounted groups open at T', async () => {
  expect(await read()).toEqual(opened);
  now = new Date(instant.getTime() - 1);
  try {
    expect(await read()).toEqual([groups.z, groups.past].sort());
  } finally {
    now = new Date(instant);
  }
});

test('an account holding gate:<group> or gate:any on the Global Context also sees that closed group', async () => {
  await grant(fixture.actorId, `gate:${groups.secret}`);
  await grant(fixture.principalId, 'gate:any');
  await grant(ordinaryId, `gate:${groups.secret}`, fixture.resource);
  expect(await read(await bearer(fixture.actorId))).toEqual([...opened, groups.secret].sort());
  expect(await read(await bearer(fixture.actorId, undefined, ['exposure:read']))).toEqual(opened);
  const fixtureGroups = Object.values(groups);
  expect(await read(await bearer(fixture.principalId))).toEqual(fixtureGroups.sort());
  expect(await read(await bearer(ordinaryId))).toEqual(opened);
});

test('a delegated caller sees a closed group only when actor and principal both hold the gate', async () => {
  const token = await bearer(fixture.actorId, delegatedRequest);
  expect(await read(token)).toEqual(opened);
  await grant(fixture.principalId, `gate:${groups.secret}`);
  expect(await read(token)).toEqual([...opened, groups.secret].sort());
  await pool.query('DELETE FROM access.resource_grant WHERE subject_id = $1 AND action = $2', [
    fixture.actorId,
    `gate:${groups.secret}`,
  ]);
  expect(await read(token)).toEqual(opened);
});

test('a closed group nobody admits this caller to is absent and its name never appears in the response', async () => {
  expect(await read(await bearer(ordinaryId))).toEqual(opened);
});

test('the answer agrees with visibleOperations for the same viewer and clock', async () => {
  for (const token of [undefined, await bearer(ordinaryId), await bearer(fixture.principalId)]) await read(token);
});

test('the response is no-store and declares public optional authentication with a read action', async () => {
  await read();
  const route = kernel.routes.find((route) => route.method === 'GET' && route.path === '/v1/platform/exposure');
  expect(route?.hooks?.detail).toMatchObject({
    operationId: 'exposure.read',
    'x-exposure': 'public',
    'x-action': 'exposure:read',
    security: [{ bearerAuth: [] }, {}],
  });
  expect(actionCatalogue(kernel).get('exposure:read')).toMatchObject({ anonymous: true });
  const invalid = await kernel.handle(
    new Request('http://kernel.test/v1/platform/exposure', {
      headers: { authorization: 'Bearer invalid' },
    }),
  );
  expect(invalid.status).toBe(401);
});
