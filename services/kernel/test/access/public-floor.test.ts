import { reinstateAccount, suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createAuthService, type AuthService } from '@rezics/auth';
import { decodeJwt, exportJWK, generateKeyPair, importJWK, SignJWT, type JWK } from 'jose';
import {
  AccessUnavailableError,
  createAccess,
  createResourceAnonymousEligibility,
  createResourcePublicEligibility,
} from '../../src/access/index.ts';
import { readAccount } from '../../src/access/account-data.ts';
import {
  accessCheck,
  actorOf,
  AuthenticationError,
  type AccessClient,
  type Actor,
  type Resource,
} from '../../src/request/access.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new Pool({ connectionString: url, max: 1 });
const authDatabase = `public_floor_auth_${process.pid}`;
const authUrl = new URL(url);
authUrl.pathname = `/${authDatabase}`;
let authPool: Pool;
let service: AuthService;
let signingKey: JWK;
const issuer = 'https://auth.example.test';
const audience = 'https://api.rezics.test';
const password = 'correct horse battery staple';
const person = '00000000-0000-7000-8000-123400000001';
const robot = '00000000-0000-7000-8000-234500000002';
const principal = '00000000-0000-7000-8000-345600000003';
const requestId = '00000000-0000-7000-8000-345600000004';
const resource = { route: 0x4567, id: '00000000-0000-7000-8000-456700000005' };
const parent = { route: 0x4567, id: '00000000-0000-7000-8000-456700000006' };
const read = 'content:read';
const report = 'report:create';
const protectedAction = 'content:update';
const actions = new Map([
  [read, { anonymous: true }],
  [report, { anonymous: true }],
  [protectedAction, { anonymous: false }],
]);
const routeOf = (id: string) => Number.parseInt(id.slice(24, 28), 16);
const context = (deadline = Date.now() + 3000) => ({ pool, deadline });
const anonymous: Actor = { kind: 'anonymous' };
let personToken: string;
let robotToken: string;
let mixedToken: string;
let scopedToken: string;
let access: ReturnType<typeof createAccess>;

function request(path: string, body?: unknown, cookie = '') {
  return service.handler(
    new Request(`${issuer}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function token(id: string, scopes: string[]) {
  const login = await request('/signin', { email: `${id}@example.test`, password, client_id: 'web', scope: scopes });
  expect(login.status).toBe(200);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const response = await request('/token', {}, cookie);
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

// This is an owning-module fixture, not an Access publication catalogue. Every
// callback reads actual route-anchored resource/container state and revisions.
type Row = { revision: number; published: boolean; disclose: boolean; captcha: boolean; current: boolean };
async function row(client: AccessClient, target: Resource, at?: string): Promise<Row | undefined> {
  const result = await client.query<Row>(
    `SELECT revision, published, disclose, captcha,
    valid @> COALESCE($3::timestamptz, clock_timestamp()) AS current
    FROM public_floor_fixture WHERE route=$1 AND id=$2`,
    [target.route, target.id, at ?? null],
  );
  return result.rows[0];
}
const observedTimes: string[] = [];
function eligibility(action = read, target = resource) {
  const create = action === report ? createResourceAnonymousEligibility : createResourcePublicEligibility;
  return create({
    resource: target,
    action,
    async prepare({ pool: source }) {
      const own = await row(source, target);
      const container = await row(source, parent);
      return own && container ? { own, container } : null;
    },
    async verify({ client, at, evidence }) {
      observedTimes.push(at);
      const own = await row(client, target, at);
      const container = await row(client, parent, at);
      if (!own || !container) throw new Error('Required disclosure evidence unavailable');
      if (!own.disclose || !container.disclose) throw new Error('Domain disclosure denied');
      if (own.revision !== evidence.own.revision || container.revision !== evidence.container.revision) return false;
      if (!own.current || !container.current) return false;
      return action === report ? own.captcha : own.published && container.published;
    },
  });
}
function publicResource(action = read): Resource {
  return { ...resource, anonymousEligibility: eligibility(action) };
}
async function prepare(bearer: string | null, target: Resource = publicResource(), action = read, deadline?: number) {
  const ctx = context(deadline);
  const actor = bearer === null ? anonymous : await access.authenticate(bearer, ctx);
  return accessCheck(access, actor, action, target, ctx);
}
async function allowed(bearer: string | null, target: Resource = publicResource(), action = read) {
  const check = await prepare(bearer, target, action);
  const client = await pool.connect();
  try {
    return await check(client);
  } finally {
    client.release();
  }
}
async function grant(subject = person, action = read) {
  await pool.query(
    `INSERT INTO access.resource_grant
    (route,resource_id,subject_id,action,valid,transaction_id) VALUES ($1,$2,$3,$4,'(,)',$3)`,
    [resource.route, resource.id, subject, action],
  );
}
async function denial(subject: string, action = read) {
  await pool.query(
    `INSERT INTO access.resource_denial
    (route,resource_id,subject_id,action,reason,valid,transaction_id) VALUES ($1,$2,$3,$4,'realm_ban','(,)',$3)`,
    [resource.route, resource.id, subject, action],
  );
}

beforeAll(async () => {
  await pool.query(`CREATE DATABASE ${authDatabase}`);
  const { migrate } = await import(new URL('../../../auth/scripts/database.ts', import.meta.url).href);
  migrate(authUrl.toString());
  authPool = new Pool({ connectionString: authUrl.toString() });
  signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'public-floor-key',
    alg: 'ES256',
  };
  service = await createAuthService({
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
        if (![person, robot].includes(reference)) throw new Error('Unknown provisioning reference');
        return { accountId: reference };
      },
    }),
  });
  await service.internal.registerClient({
    clientId: 'web',
    firstParty: true,
    scopes: [read, report, protectedAction, 'openid', 'offline_access', 'other:read'],
  });
  for (const id of [person, robot, principal]) {
    await pool.query(
      `INSERT INTO access.account
      (route,account_id,kind,state,operator_account_id,transaction_id) VALUES ($1,$2,'actor','pending',$3,$2)`,
      [routeOf(id), id, id === robot ? person : null],
    );
    if (id !== principal)
      await service.internal.provisionPassword({ authorization: id, email: `${id}@example.test`, password });
    await pool.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [routeOf(id), id]);
  }
  personToken = await token(person, []);
  robotToken = await token(robot, []);
  scopedToken = await token(person, [read, report, protectedAction]);
  mixedToken = await token(person, ['openid', 'offline_access', 'other:read', read]);
  access = createAccess({
    actions,
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: (url, init) => service.handler(new Request(url, init)),
    },
  });
  await pool.query(`CREATE TABLE public_floor_fixture
    (route integer, id uuid, revision integer, published boolean, disclose boolean, captcha boolean,
    valid tstzrange, PRIMARY KEY(route,id))`);
}, 30000);

beforeEach(async () => {
  for (const table of ['resource_grant', 'resource_denial', 'principal_assignment'])
    await pool.query(`DELETE FROM access.${table}`);
  await pool.query('DELETE FROM public_floor_fixture');
  for (const target of [resource, parent])
    await pool.query(
      `INSERT INTO public_floor_fixture
    VALUES ($1,$2,1,true,true,false,'(,)')`,
      [target.route, target.id],
    );
  observedTimes.length = 0;
});
afterAll(async () => {
  await authPool?.end();
  await dropTestDatabase(pool, authDatabase);
  await pool.end();
});

test('current public reads give anonymous, authenticated and automated accounts the same floor without grants/scopes', async () => {
  for (const bearer of [null, personToken, robotToken]) expect(await allowed(bearer)).toBe(true);
  expect((await pool.query('SELECT count(*)::int AS n FROM access.resource_grant')).rows[0].n).toBe(0);
  expect((await access.authenticate(personToken, context())).scopes).toEqual([]);
});

test('catalogue admission alone cannot disclose protected content or authorize another protected action', async () => {
  for (const bearer of [null, personToken, robotToken]) expect(await allowed(bearer, resource)).toBe(false);
  await pool.query('UPDATE public_floor_fixture SET published=false WHERE id=$1', [resource.id]);
  for (const bearer of [null, personToken]) expect(await allowed(bearer)).toBe(false);
  await grant();
  expect(await allowed(scopedToken)).toBe(true);
  expect(await allowed(personToken)).toBe(false);
  await pool.query('DELETE FROM access.resource_grant');
  expect(await allowed(scopedToken)).toBe(false);
  expect(await allowed(scopedToken, publicResource(protectedAction), protectedAction)).toBe(false);
});

test('unknown actions, invalid bearer and inactive or fenced accounts cannot acquire the floor', async () => {
  expect(await allowed(null, publicResource('arbitrary:read'), 'arbitrary:read')).toBe(false);
  await expect(
    actorOf(access, new Request(audience, { headers: { authorization: 'Bearer invalid' } }), context()),
  ).rejects.toBeInstanceOf(AuthenticationError);
  for (const update of ['authn_fenced=true', 'minimum_authn_epoch=2']) {
    await pool.query('BEGIN');
    try {
      await pool.query(`UPDATE access.account SET ${update} WHERE route=$1 AND account_id=$2`, [
        routeOf(person),
        person,
      ]);
      await expect(access.authenticate(personToken, context())).rejects.toBeInstanceOf(AuthenticationError);
    } finally {
      await pool.query('ROLLBACK');
    }
  }
  await suspendAccount(pool, person);
  try {
    await expect(access.authenticate(personToken, context())).rejects.toBeInstanceOf(AuthenticationError);
  } finally {
    await reinstateAccount(pool, person);
    personToken = await token(person, []);
    scopedToken = await token(person, [read, report, protectedAction]);
    mixedToken = await token(person, ['openid', 'offline_access', 'other:read', read]);
  }
});

test('missing, forged, copied and wrongly bound eligibility cannot grant publication authority', async () => {
  const trusted = eligibility();
  for (const anonymousEligibility of [{ isPublic: true }, { ...trusted }, JSON.parse(JSON.stringify(trusted))]) {
    expect(await allowed(null, { ...resource, anonymousEligibility })).toBe(false);
    expect(await allowed(personToken, { ...resource, anonymousEligibility })).toBe(false);
  }
  expect(await allowed(null, { ...parent, anonymousEligibility: trusted })).toBe(false);
  expect(await allowed(null, { ...resource, route: 1, anonymousEligibility: trusted })).toBe(false);
  expect(await allowed(null, { ...resource, anonymousEligibility: trusted }, report)).toBe(false);
  await pool.query('DELETE FROM public_floor_fixture WHERE id=$1', [parent.id]);
  expect(await allowed(null)).toBe(false);
  await pool.query('ALTER TABLE public_floor_fixture RENAME TO unavailable_public_floor_fixture');
  try {
    expect(await allowed(personToken)).toBe(false);
  } finally {
    await pool.query('ALTER TABLE unavailable_public_floor_fixture RENAME TO public_floor_fixture');
  }
});

test('resource and container publication, disclosure, revisions and validity are revalidated on each attempt', async () => {
  for (const target of [resource, parent]) {
    for (const update of [
      'published=false',
      'disclose=false',
      'revision=2',
      "valid='[2000-01-01,2001-01-01)'::tstzrange",
    ]) {
      const check = await prepare(personToken);
      expect(await check(pool)).toBe(true);
      await pool.query(`UPDATE public_floor_fixture SET ${update} WHERE id=$1`, [target.id]);
      expect(await check(pool)).toBe(false);
      await pool.query("UPDATE public_floor_fixture SET published=true,disclose=true,revision=1,valid='(,)'", []);
    }
  }
  const check = await prepare(personToken, publicResource(), read, Date.now() + 80);
  expect(await check(pool)).toBe(true);
  await Bun.sleep(100);
  await expect(check(pool)).rejects.toBeInstanceOf(AccessUnavailableError);
});

test('publication callbacks and the one SQL formula use exactly the same authoritative time', async () => {
  const check = await prepare(personToken);
  const client = await pool.connect();
  const checkedTimes: unknown[] = [];
  const traced = {
    query: async (query: string | { text: string; values: unknown[] }, values?: unknown[]) => {
      const statementInput = typeof query === 'string' ? { text: query, values: values ?? [] } : query;
      if (statementInput.text.includes('AS allowed')) {
        const statement = (await import('../../src/access/permission-check.sql')).default;
        checkedTimes.push(statementInput.values[statement.params.indexOf('at')]);
      }
      return client.query(statementInput);
    },
  } as AccessClient;
  try {
    expect(await check(traced)).toBe(true);
  } finally {
    client.release();
  }
  expect(observedTimes).toHaveLength(1);
  expect(checkedTimes).toEqual(observedTimes);
});

test('named actor and principal bans override their floor without banning an unrelated public reader', async () => {
  await denial(person);
  expect(await allowed(personToken)).toBe(false);
  expect(await allowed(null)).toBe(true);
  expect(await allowed(robotToken)).toBe(true);
  await pool.query('DELETE FROM access.resource_denial');
  await pool.query(
    `INSERT INTO access.principal_assignment
    (route,principal_id,request_id,assigned_actor_id,valid,transaction_id,creator_principal_id) VALUES ($1,$2,$3,$4,'(,)',$4,$2)`,
    [routeOf(principal), principal, requestId, person],
  );
  const delegated = await new SignJWT({
    ...decodeJwt<Record<string, unknown>>(personToken),
    requested_by: `urn:rezics:request:${principal}:${requestId}`,
  })
    .setProtectedHeader({ alg: 'ES256', kid: signingKey.kid!, typ: 'at+jwt' })
    .sign(await importJWK(signingKey, 'ES256'));
  expect(await allowed(delegated)).toBe(true);
  await denial(principal);
  expect(await allowed(delegated)).toBe(false);
  expect(await allowed(personToken)).toBe(true);
  expect(await allowed(null)).toBe(true);
  await pool.query('DELETE FROM access.principal_assignment');
  await expect(access.authenticate(delegated, context())).rejects.toBeInstanceOf(AuthenticationError);
});

test('real mixed protocol and other-product scopes do not poison a known grant branch or replace its operands', async () => {
  await pool.query('UPDATE public_floor_fixture SET published=false');
  await grant();
  expect(await allowed(mixedToken, resource)).toBe(true);
  expect(await allowed(personToken, resource)).toBe(false);
  await pool.query('DELETE FROM access.resource_grant');
  expect(await allowed(mixedToken, resource)).toBe(false);
  await grant();
  expect(await allowed(mixedToken, resource, 'other:read')).toBe(false);
  await pool.query(
    `INSERT INTO access.principal_assignment
    (route,principal_id,request_id,assigned_actor_id,valid,transaction_id,creator_principal_id) VALUES ($1,$2,$3,$4,'(,)',$4,$2)`,
    [routeOf(principal), principal, requestId, person],
  );
  const delegated = await new SignJWT({
    ...decodeJwt<Record<string, unknown>>(mixedToken),
    requested_by: `urn:rezics:request:${principal}:${requestId}`,
  })
    .setProtectedHeader({ alg: 'ES256', kid: signingKey.kid!, typ: 'at+jwt' })
    .sign(await importJWK(signingKey, 'ES256'));
  expect(await allowed(delegated, resource)).toBe(false);
  await grant(principal);
  expect(await allowed(delegated, resource)).toBe(true);
});

test('anonymous command eligibility proves its domain prerequisites without making the private report publicly readable', async () => {
  await pool.query('UPDATE public_floor_fixture SET published=false');
  await grant(person, report);
  expect(await allowed(scopedToken, resource, report)).toBe(true);
  expect(await allowed(personToken, resource, report)).toBe(false);
  await pool.query('DELETE FROM access.resource_grant');
  expect(await allowed(scopedToken, resource, report)).toBe(false);
  expect(await allowed(null, publicResource(report), report)).toBe(false);
  await pool.query('UPDATE public_floor_fixture SET captcha=true WHERE id=$1', [resource.id]);
  for (const bearer of [null, personToken, robotToken])
    expect(await allowed(bearer, publicResource(report), report)).toBe(true);
  expect(await allowed(null)).toBe(false);
  expect(await allowed(personToken)).toBe(false);
  await denial(person, report);
  expect(await allowed(personToken, publicResource(report), report)).toBe(false);
  expect(await allowed(null, publicResource(report), report)).toBe(true);
  const stale = await prepare(null, publicResource(report), report);
  await pool.query('UPDATE public_floor_fixture SET captcha=false WHERE id=$1', [resource.id]);
  expect(await stale(pool)).toBe(false);
  await grant(person, report);
  await pool.query('UPDATE public_floor_fixture SET disclose=false WHERE id=$1', [parent.id]);
  expect(await allowed(scopedToken, publicResource(report), report)).toBe(false);
});
