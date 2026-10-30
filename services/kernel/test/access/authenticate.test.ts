import { suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { decodeJwt, exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from 'jose';
import { createAuthService, type AuthService, type AuthServiceOptions } from '@rezics/auth';
import { AccessUnavailableError, createAccess, createResourcePublicEligibility } from '../../src/access/index.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createDelegationCommands } from '../../src/access/delegation-commands.ts';
import { accessCheck, actorOf, AuthenticationError, type ActionCatalogue } from '../../src/request/access.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const timeout = 60_000;
const pool = new Pool({ connectionString: url, max: 1 });
const authDatabase = `access_auth_${process.pid}`;
const authUrl = new URL(url);
authUrl.pathname = `/${authDatabase}`;
let authPool: Pool;
let service: AuthService;
let options: AuthServiceOptions;
let signingKey: JWK;
const issuer = 'https://auth.example.test';
const audience = 'https://api.rezics.test';
const password = 'correct horse battery staple';
const person = '00000000-0000-7000-8000-123400000001';
const robot = '00000000-0000-7000-8000-234500000002';
const principal = '00000000-0000-7000-8000-345600000003';
const requestId = '00000000-0000-7000-8000-345600000004';
const resource = { route: 0x4567, id: '00000000-0000-7000-8000-456700000005' };
const action = 'subject:read';
const actions: ActionCatalogue = new Map([
  [action, { anonymous: false }],
  ['subject:update', { anonymous: false }],
  ['subject:public', { anonymous: true }],
  ['account:delegate', { anonymous: false }],
]);
const routeOf = (id: string) => Number.parseInt(id.slice(24, 28), 16);
const context = (source = pool, deadline = Date.now() + 3000) => ({ pool: source, deadline });
let personToken: string;
let personCookie: string;
let robotToken: string;

function request(path: string, body?: unknown, cookie = '', target = service) {
  return target.handler(
    new Request(`${issuer}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function login(id: string, clientId = 'web', scopes = [action]) {
  const response = await request('/signin', {
    email: `${id}@example.test`,
    password,
    client_id: clientId,
    scope: scopes,
  });
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}
async function token(cookie: string, target = service) {
  const response = await request('/token', {}, cookie, target);
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}
async function signed(overrides: Record<string, unknown>, kid = signingKey.kid!, key = signingKey) {
  const claims = { ...decodeJwt(personToken), ...overrides };
  for (const [name, value] of Object.entries(claims)) if (value === undefined) delete claims[name];
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'ES256', kid, typ: 'at+jwt' })
    .sign(await importJWK(key, 'ES256'));
}
async function invalid(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(AuthenticationError);
  expect(error).toMatchObject({ status: 401, challenge: 'Bearer error="invalid_token"' });
}

function verifier(catalogue = actions) {
  const fetches: { url: string; headers: Headers }[] = [];
  let offline = false;
  let target: AuthService | undefined;
  const access = createAccess({
    actions: catalogue,
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      async fetch(url, init) {
        fetches.push({ url, headers: new Headers(init.headers) });
        if (offline) throw new Error('JWKS unavailable');
        return (target ?? service).handler(new Request(url, init));
      },
    },
  });
  return {
    access,
    fetches,
    outage(value: boolean) {
      offline = value;
    },
    rotate(value: AuthService) {
      target = value;
    },
  };
}

beforeAll(async () => {
  await pool.query(`CREATE DATABASE ${authDatabase}`);
  const { migrate } = await import(new URL('../../../auth/scripts/database.ts', import.meta.url).href);
  migrate(authUrl.toString());
  authPool = new Pool({ connectionString: authUrl.toString() });
  signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'auth-signing-key',
    alg: 'ES256',
  };
  options = {
    database: authPool,
    issuer,
    audience,
    secret: 'test-only-better-auth-secret-with-at-least-32-bytes',
    signing: { activeKid: signingKey.kid!, privateKeys: [signingKey] },
    trustedAccess: trustedAccessPorts({
      async readAccount(id) {
        const account = await readAccount(pool, routeOf(id), id);
        return (
          account && {
            accountId: account.accountId,
            kind: account.kind,
            state: account.state,
            authnEpoch: Number(account.minimumAuthnEpoch),
            automated: account.operatorAccountId !== null,
          }
        );
      },
      async authorizeProvisioning(reference) {
        // A consumed, internal fixture approval; never obtained from HTTP fields.
        if (!approvals.delete(reference)) throw new Error('No provisioning approval');
        return { accountId: reference };
      },
    }),
  };
  const approvals = new Set([person, robot, principal]);
  service = await createAuthService(options);
  await service.internal.registerClient({
    clientId: 'web',
    firstParty: true,
    scopes: [action, 'subject:update', 'account:delegate'],
  });
  await service.internal.registerClient({ clientId: 'external', firstParty: false, scopes: [action] });
  for (const id of [person, robot]) {
    await pool.query(
      `INSERT INTO access.account
      (route,account_id,kind,state,operator_account_id,transaction_id) VALUES ($1,$2,'actor','pending',$3,$2)`,
      [routeOf(id), id, id === robot ? person : null],
    );
    await service.internal.provisionPassword({ authorization: id, email: `${id}@example.test`, password });
    await pool.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [routeOf(id), id]);
  }
  await pool.query(
    `INSERT INTO access.account (route,account_id,kind,state,transaction_id)
    VALUES ($1,$2,'actor','active',$2)`,
    [routeOf(principal), principal],
  );
  personCookie = await login(person);
  expect((await request('/consent', { client_id: 'external', scope: [action] }, personCookie)).status).toBe(200);
  personToken = await token(await login(person, 'external'));
  robotToken = await token(await login(robot));
  await pool.query(
    `INSERT INTO access.resource_grant
    (route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$3,$4,'(,)',$3)`,
    [resource.route, resource.id, person, action],
  );
}, timeout);

afterAll(async () => {
  await authPool?.end();
  await dropTestDatabase(pool, authDatabase);
  await pool.end();
});

test('kernel Access verifies real Auth JWTs from cached public JWKS', async () => {
  const { access, fetches } = verifier();
  const actor = await actorOf(
    access,
    new Request(audience, {
      method: 'POST',
      headers: { authorization: `Bearer ${personToken}` },
      body: JSON.stringify({ accountId: robot, clientId: 'forged', scopes: ['subject:update'] }),
    }),
    context(),
  );
  expect(actor).toEqual({
    kind: 'account',
    accountId: person,
    clientId: 'external',
    scopes: [action],
    authnEpoch: 1,
    requestedBy: null,
  });
  expect(await access.authenticate(robotToken, context())).toMatchObject({
    accountId: robot,
    clientId: 'web',
    requestedBy: null,
  });
  expect(fetches).toHaveLength(1);
  expect(fetches[0]!.url).toBe(`${issuer}/.well-known/jwks.json`);
  expect(fetches[0]!.headers.has('authorization')).toBe(false);
  expect(fetches[0]!.headers.has('cookie')).toBe(false);
  const response = await request('/.well-known/jwks.json');
  const jwks = await response.json();
  expect(JSON.stringify(jwks)).not.toContain(signingKey.d!);
  expect((await authPool.query('SELECT id FROM "user" ORDER BY id')).rows.map((row) => row.id)).toEqual([
    person,
    robot,
  ]);
  expect((await authPool.query("SELECT to_regclass('access.account') AS account")).rows[0].account).toBeNull();
});

test('cached keys survive outages, a new valid kid refreshes, and unknown keys fail without introspection', async () => {
  const fixture = verifier();
  await fixture.access.authenticate(personToken, context());
  fixture.outage(true);
  await fixture.access.authenticate(personToken, context());
  expect(fixture.fetches).toHaveLength(1);
  await invalid(fixture.access.authenticate(await signed({}, 'unknown'), context()));
  fixture.outage(false);
  const newKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'rotated',
  };
  const rotated = await createAuthService({ ...options, signing: { activeKid: 'rotated', privateKeys: [newKey] } });
  fixture.rotate(rotated);
  const fresh = await token(personCookie, rotated);
  expect(await fixture.access.authenticate(fresh, context())).toMatchObject({ accountId: person });
  const count = fixture.fetches.length;
  await fixture.access.authenticate(fresh, context());
  expect(fixture.fetches).toHaveLength(count);
  await invalid(fixture.access.authenticate(await signed({}, 'never-published'), context()));
  expect(
    fixture.fetches.every(
      (fetch) => fetch.url === `${issuer}/.well-known/jwks.json` && !fetch.headers.has('authorization'),
    ),
  ).toBe(true);
});

test('forged expired revoked and wrong-audience sessions fail closed', async () => {
  const { access } = verifier();
  const now = Math.floor(Date.now() / 1000);
  const badKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: signingKey.kid!,
  };
  await invalid(access.authenticate(await signed({}, signingKey.kid!, badKey), context()));
  for (const claims of [
    { iss: 'https://evil.test' },
    { aud: 'https://other-api.test' },
    { sub: '00000000-0000-7000-8000-ABCD00000001' },
    { sub: false },
    { sub: 'person' },
    { iat: now + 10 },
    { exp: now - 1 },
    { exp: now + 301, iat: now },
    { exp: now, iat: now },
    { iat: 'now' },
    { iat: now - 0.5 },
    { auth_time: now + 1 },
    { auth_time: -1 },
    { auth_time: 'now' },
    { amr: 'pwd' },
    { amr: [] },
    { amr: [false] },
    { amr: [''] },
    { client_id: '' },
    { client_id: 123 },
    { scope: [action] },
    { scope: 'a  b' },
    { authn_epoch: 0 },
    { authn_epoch: -1 },
    { authn_epoch: 1.5 },
    { authn_epoch: '1' },
    { authn_epoch: Number.MAX_SAFE_INTEGER + 1 },
    { act: { sub: principal } },
    ...['iss', 'aud', 'sub', 'client_id', 'scope', 'authn_epoch', 'iat', 'exp', 'auth_time', 'amr'].map((name) => ({
      [name]: undefined,
    })),
  ])
    await invalid(access.authenticate(await signed(claims), context()));
  for (const state of ['pending', 'deleted']) {
    await pool.query('UPDATE access.account SET state=$3 WHERE route=$1 AND account_id=$2', [
      routeOf(person),
      person,
      state,
    ]);
    try {
      await invalid(access.authenticate(personToken, context()));
    } finally {
      await pool.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
        routeOf(person),
        person,
      ]);
    }
  }
  const suspendedId = '00000000-0000-7000-8000-123400000099';
  await pool.query(
    "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)",
    [routeOf(suspendedId), suspendedId],
  );
  const suspendedBearer = await signed({ sub: suspendedId });
  await suspendAccount(pool, suspendedId);
  await invalid(access.authenticate(suspendedBearer, context()));
  await pool.query('UPDATE access.account SET minimum_authn_epoch=2 WHERE route=$1 AND account_id=$2', [
    routeOf(robot),
    robot,
  ]);
  await service.internal.revokeSessions(robot);
  await invalid(access.authenticate(robotToken, context()));
  const fresh = await token(await login(robot));
  expect(await access.authenticate(fresh, context())).toMatchObject({ accountId: robot, authnEpoch: 2 });
  await invalid(actorOf(access, new Request(audience, { headers: { authorization: 'Bearer invalid' } }), context()));
});

test('authenticated requests read actor state and epoch once on its anchor', async () => {
  const { access } = verifier();
  const reads: { text: string; values: unknown[] }[] = [];
  const counted = Object.create(pool) as Pool;
  counted.query = ((query: { text: string; values: unknown[] }) => {
    if (/FROM access.account/.test(query.text)) reads.push(query);
    return pool.query(query);
  }) as Pool['query'];
  const ctx = context(counted);
  const actor = await access.authenticate(personToken, ctx);
  for (let i = 0; i < 3; i++) {
    const check = await accessCheck(access, actor, action, resource, ctx);
    const client = await pool.connect();
    try {
      expect(await check(client)).toBe(true);
    } finally {
      client.release();
    }
  }
  expect(reads).toHaveLength(1);
  expect(reads[0]!.values).toContain(routeOf(person));
  expect(reads[0]!.values).toContain(person);
  expect(reads[0]!.text).toContain('minimum_authn_epoch');
  expect(reads[0]!.text).toContain('state');
  const unavailable = Object.create(pool) as Pool;
  unavailable.query = (() => Promise.reject(new Error('Account dependency unavailable'))) as Pool['query'];
  await invalid(access.authenticate(personToken, context(unavailable)));
  await invalid(access.authenticate(await signed({ sub: '00000000-0000-7000-8000-ffff00000000' }), context()));
});

test('Access authorizes through the one resource permission formula', async () => {
  const { access } = verifier();
  const ctx = context();
  const actor = await access.authenticate(personToken, ctx);
  const check = await accessCheck(access, actor, action, resource, ctx);
  expect(await check(pool)).toBe(true);
  const evidence = await access.prepare!(actor, action, resource, ctx);
  expect(await access.authorize(pool, { ...actor }, action, resource, evidence)).toBe(false);
  expect(await access.authorize(pool, actor, action, resource, {})).toBe(false);
  expect(await access.authorize(pool, actor, 'subject:update', resource, evidence)).toBe(false);
  expect(await access.authorize(pool, actor, action, { ...resource, route: 1 }, evidence)).toBe(false);
  expect(await (await accessCheck(access, { ...actor }, action, resource, ctx))(pool)).toBe(false);
  await pool.query('DELETE FROM access.resource_grant WHERE route=$1 AND subject_id=$2', [resource.route, person]);
  expect(await check(pool)).toBe(false);
  await pool.query(
    `INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,$4,'(,)',$3)`,
    [resource.route, resource.id, person, action],
  );
  expect(await check(pool)).toBe(true);
  const withoutScope = await access.authenticate(await token(await login(person, 'web', [])), ctx);
  expect(await (await accessCheck(access, withoutScope, action, resource, ctx))(pool)).toBe(false);
  const other = verifier();
  expect(await (await accessCheck(other.access, actor, action, resource, ctx))(pool)).toBe(false);
});

test('delegated signed claims require an actual principal-created matching assignment and principal grants', async () => {
  const { access } = verifier();
  const requestedBy = `urn:rezics:request:${principal}:${requestId}`;
  for (const value of [null, false, principal, `${requestedBy}:extra`, requestedBy]) {
    await invalid(access.authenticate(await signed({ requested_by: value }), context()));
  }
  await pool.query("UPDATE access.account SET state='pending' WHERE route=$1 AND account_id=$2", [
    routeOf(principal),
    principal,
  ]);
  await service.internal.provisionPassword({ authorization: principal, email: `${principal}@example.test`, password });
  await pool.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [
    routeOf(principal),
    principal,
  ]);
  await pool.query(
    `INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$2,'account:delegate','(,)',$2)`,
    [routeOf(principal), principal],
  );
  const principalContext = context();
  const principalActor = await access.authenticate(
    await token(await login(principal, 'web', ['account:delegate'])),
    principalContext,
  );
  await createDelegationCommands({ pool, access, action: 'account:delegate' }).create(
    { ...principalContext, actor: principalActor },
    { principalId: principal, requestId, assignedActorId: person, valid: '(,)', key: Bun.randomUUIDv7() },
  );
  await pool.query(
    `INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,$4,'(,)',$3)`,
    [resource.route, resource.id, principal, action],
  );
  let delegated = await signed({ requested_by: requestedBy });
  const ctx = context();
  const actor = await access.authenticate(delegated, ctx);
  expect(actor.requestedBy).toBe(requestedBy);
  const check = await accessCheck(access, actor, action, resource, ctx);
  expect(await check(pool)).toBe(true);
  await pool.query('DELETE FROM access.resource_grant WHERE route=$1 AND subject_id=$2', [resource.route, principal]);
  expect(await check(pool)).toBe(false);
  delegated = await signed({ requested_by: requestedBy, sub: robot, authn_epoch: 2 });
  await invalid(access.authenticate(delegated, context()));
  delegated = await signed({ requested_by: requestedBy });
  await suspendAccount(pool, principal);
  await invalid(access.authenticate(delegated, context()));
});

test('request deadlines and token expiry bound authentication and prepared authority', async () => {
  const { access } = verifier();
  await expect(access.authenticate(personToken, context(pool, Date.now() - 1))).rejects.toBeInstanceOf(
    AccessUnavailableError,
  );
  const delayed = Object.create(pool) as Pool;
  delayed.query = (async (query: Parameters<Pool['query']>[0]) => {
    await Bun.sleep(120);
    return pool.query(query);
  }) as Pool['query'];
  await expect(access.authenticate(personToken, context(delayed, Date.now() + 30))).rejects.toBeInstanceOf(
    AccessUnavailableError,
  );
  const stalled = createAccess({
    actions,
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => {
        await Bun.sleep(120);
        return request('/.well-known/jwks.json');
      },
    },
  });
  const start = Date.now();
  await expect(stalled.authenticate(personToken, context(pool, Date.now() + 30))).rejects.toBeInstanceOf(
    AccessUnavailableError,
  );
  expect(Date.now() - start).toBeLessThan(100);
  const ctx = context(pool, Date.now() + 80);
  const actor = await access.authenticate(personToken, ctx);
  const check = await accessCheck(access, actor, action, resource, ctx);
  expect(await check(pool)).toBe(true);
  await Bun.sleep(100);
  await expect(check(pool)).rejects.toBeInstanceOf(AccessUnavailableError);
  const exp = Math.floor(Date.now() / 1000) + 1;
  const expiring = await access.authenticate(await signed({ exp }), context());
  const expires = await accessCheck(access, expiring, action, resource, context());
  expect(await expires(pool)).toBe(true);
  await Bun.sleep(exp * 1000 - Date.now() + 10);
  expect(await expires(pool)).toBe(false);
});

test('construction is lazy, catalogue ownership is local, and known anonymous routes retain resource denials', async () => {
  const saved = [process.env.AUTH_ISSUER, process.env.AUTH_AUDIENCE, process.env.AUTH_JWKS_URL];
  try {
    delete process.env.AUTH_ISSUER;
    delete process.env.AUTH_AUDIENCE;
    delete process.env.AUTH_JWKS_URL;
    const unconfigured = createAccess({ actions });
    await invalid(unconfigured.authenticate(personToken, context()));
    process.env.AUTH_ISSUER = 'invalid';
    await invalid(createAccess({ actions }).authenticate(personToken, context()));
  } finally {
    for (const [index, name] of ['AUTH_ISSUER', 'AUTH_AUDIENCE', 'AUTH_JWKS_URL'].entries()) {
      if (saved[index] === undefined) delete process.env[name];
      else process.env[name] = saved[index];
    }
  }
  const catalogue = new Map([['subject:public', { anonymous: true }]]);
  const { access } = verifier(catalogue);
  catalogue.set('arbitrary:read', { anonymous: true });
  const noQueries = {
    query() {
      throw new Error('Unknown actions must not query');
    },
  } as unknown as Pool;
  const anonymous = { kind: 'anonymous' as const };
  const eligibleResource = {
    ...resource,
    eligibility: createResourcePublicEligibility({
      resource,
      action: 'subject:public',
      async prepare() {
        return true;
      },
      async verify() {
        return true;
      },
    }),
  };
  expect(await access.authorize(noQueries, anonymous, 'arbitrary:read', resource)).toBe(false);
  expect(await (await accessCheck(access, anonymous, 'arbitrary:read', resource, context(noQueries)))(noQueries)).toBe(
    false,
  );
  const check = await accessCheck(access, anonymous, 'subject:public', eligibleResource, context());
  expect(await check(pool)).toBe(true);
  await pool.query(
    `INSERT INTO access.resource_denial
    (route,resource_id,subject_id,action,reason,valid,transaction_id) VALUES ($1,$2,$3,'subject:public','resource','(,)',$3)`,
    [resource.route, resource.id, person],
  );
  expect(await check(pool)).toBe(true);
  const identified = await access.authenticate(await signed({ scope: 'subject:public' }), context());
  const denied = await accessCheck(access, identified, 'subject:public', eligibleResource, context());
  expect(await denied(pool)).toBe(false);
});
