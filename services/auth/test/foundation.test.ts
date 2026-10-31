import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, type AccessAccount, type AuthService, type AuthServiceOptions } from '../src/index.ts';

const issuer = 'https://auth.example.test';
const audience = 'https://api.rezics.test';
const password = 'correct horse battery staple';
const accounts = new Map<string, AccessAccount>();
const approvals = new Map<string, string>();
let unavailable = false;
let pool: Pool;
let service: AuthService;
let options: AuthServiceOptions;
let fixture: ReturnType<typeof testDatabase> | undefined;
let privateJwk: Awaited<ReturnType<typeof exportJWK>>;

beforeAll(async () => {
  const url = process.env.AUTH_TEST_DATABASE_URL ?? (fixture = testDatabase()).url;
  pool = new Pool({ connectionString: url });
  const key = await generateKeyPair('ES256', { extractable: true });
  privateJwk = { ...(await exportJWK(key.privateKey)), kid: 'fixture-signing-key', alg: 'ES256' };
  options = {
    database: pool,
    issuer,
    audience,
    secret: 'test-only-better-auth-secret-with-at-least-32-bytes',
    signing: { activeKid: 'fixture-signing-key', privateKeys: [privateJwk] },
    trustedAccess: trustedAccessPorts({
      async readFencedAccount(id) {
        return this.readAccount(id);
      },
      async readAccount(id) {
        if (unavailable) throw new Error('Access unavailable');
        return accounts.get(id) ?? null;
      },
      async invalidateAccount({ accountId, previousEpoch }) {
        if (unavailable) throw new Error('Access unavailable');
        const account = accounts.get(accountId);
        if (!account || account.authnEpoch !== previousEpoch) throw new Error('Stale Access evidence');
        account.authnEpoch++;
        return {
          receiptId: `foundation-floor-${accountId}-${account.authnEpoch}`,
          accountId,
          minimumAuthnEpoch: account.authnEpoch,
        };
      },
      async authorizeProvisioning(reference) {
        const accountId = approvals.get(reference);
        if (!accountId) throw new Error('No approved Access command');
        approvals.delete(reference);
        return { accountId };
      },
    }),
  };
  service = await createAuthService(options);
  await service.internal.registerClient({ clientId: 'web', firstParty: true, scopes: ['read', 'write'] });
  await service.internal.registerClient({ clientId: 'external', firstParty: false, scopes: ['read', 'write'] });
}, 30000);

afterAll(async () => {
  await pool?.end();
  fixture?.close();
});

function actor(id: string, state: AccessAccount['state'] = 'pending', automated = false) {
  const account: AccessAccount = { accountId: id, kind: 'actor', state, authnEpoch: 1, automated };
  accounts.set(id, account);
  return account;
}
async function provision(id: string, automated = false, state: AccessAccount['state'] = 'pending') {
  actor(id, state, automated);
  approvals.set(`approved-${id}`, id);
  const result = await service.internal.provisionPassword({
    authorization: `approved-${id}`,
    email: `${id}@example.test`,
    password,
  });
  expect(result).toEqual({ accountId: id });
}
function request(path: string, body?: unknown, cookie = '', target = service) {
  return target.handler(
    new Request(`${issuer}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', origin: issuer, cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function signin(id: string, extra: Record<string, unknown> = {}, target = service) {
  return request(
    '/signin',
    { email: `${id}@example.test`, password, client_id: 'web', scope: ['read'], ...extra },
    '',
    target,
  );
}
function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}
async function login(id: string, extra: Record<string, unknown> = {}, target = service) {
  const response = await signin(id, extra, target);
  expect(response.status).toBe(200);
  const cookie = cookies(response);
  expect(cookie).toContain('session_token=');
  expect(cookie).not.toContain('session_data=');
  return cookie;
}
async function token(cookie: string, target = service) {
  const response = await request('/token', {}, cookie, target);
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}
async function denied(response: Response) {
  expect(response.status).toBeGreaterThanOrEqual(400);
  expect(cookies(response)).not.toContain('session_token=');
}

test('trusted pending provisioning uses Access ID in real Better Auth credentials and persistent sessions', async () => {
  await provision('person');
  await denied(await signin('person'));
  accounts.get('person')!.state = 'active';
  const cookie = await login('person');
  const response = await request('/session', undefined, cookie);
  expect(response.status).toBe(200);
  const proof = await response.json();
  expect(proof).toMatchObject({
    account_id: 'person',
    client_id: 'web',
    scope: ['read'],
    authn_epoch: 1,
    amr: ['pwd'],
  });
  const user = await pool.query('SELECT id, name, image FROM "user" WHERE email=$1', ['person@example.test']);
  expect(user.rows).toEqual([{ id: 'person', name: '', image: null }]);
  const owner = await pool.query(
    'SELECT "userId", "accountId", "providerId", password FROM account WHERE "userId"=$1',
    ['person'],
  );
  expect(owner.rows[0]).toMatchObject({ userId: 'person', accountId: 'person', providerId: 'credential' });
  expect(owner.rows[0].password).not.toBe(password);
  expect((await pool.query('SELECT "userId" FROM session WHERE "userId"=$1', ['person'])).rows.length).toBe(1);
  const reloaded = await createAuthService(options);
  expect(await (await request('/session', undefined, cookie, reloaded)).json()).toEqual(proof);
  expect(decodeJwt(await token(cookie, reloaded)).sub).toBe('person');
});

test('raw Better Auth signup, signin, recovery and arbitrary routes cannot bypass trusted boundaries', async () => {
  const before = await pool.query('SELECT count(*) FROM "user"');
  for (const path of [
    '/api/auth/sign-up/email',
    '/api/auth/sign-in/email',
    '/api/auth/get-session',
    '/api/auth/request-password-reset',
    '/provision',
    '/internal/authorize',
  ]) {
    await denied(
      await request(path, {
        name: 'intruder',
        email: 'intruder@example.test',
        password,
        account_id: 'victim',
        state: 'active',
      }),
    );
  }
  expect((await pool.query('SELECT count(*) FROM "user"')).rows).toEqual(before.rows);
  await expect(
    service.internal.provisionPassword({ authorization: 'forged', email: 'intruder@example.test', password }),
  ).rejects.toThrow();
});

test('wrong password, credential swapping, missing identity and all inactive states fail closed', async () => {
  await provision('other');
  accounts.get('other')!.state = 'active';
  await denied(await signin('person', { password: 'wrong password' }));
  await denied(await signin('person', { account_id: 'other' }));
  await denied(await signin('unknown'));
  const cookie = await login('other');
  for (const state of ['pending', 'suspended', 'deleted'] as const) {
    accounts.get('other')!.state = state;
    await denied(await signin('other'));
    await denied(await request('/session', undefined, cookie));
    await denied(await request('/token', {}, cookie));
  }
  accounts.delete('other');
  await denied(await signin('other'));
  await denied(await request('/token', {}, cookie));
  accounts.set('other', { accountId: 'other', kind: 'organization', state: 'active', authnEpoch: 1, automated: false });
  await denied(await signin('other'));
  await denied(await request('/session', undefined, cookie));
  await denied(await request('/token', {}, cookie));
  unavailable = true;
  try {
    await denied(await signin('person'));
    await denied(await request('/session', undefined, await loginWithoutAccess()));
  } finally {
    unavailable = false;
  }
  async function loginWithoutAccess() {
    return cookie;
  }
});

test('Correct-password suspended sign-in returns existing native ACCOUNT_SUSPENDED code and creates no session', async () => {
  await provision('suspended-human');
  accounts.get('suspended-human')!.state = 'suspended';
  const before = await pool.query('SELECT count(*) FROM session');

  const suspended = await signin('suspended-human');
  expect(suspended.status).toBe(403);
  expect(await suspended.json()).toEqual({ error: 'account_suspended', code: 'ACCOUNT_SUSPENDED' });
  expect(suspended.headers.getSetCookie()).toEqual([]);
  expect(suspended.headers.has('authorization')).toBe(false);
  expect((await pool.query('SELECT count(*) FROM session')).rows).toEqual(before.rows);

  const wrongPassword = await signin('suspended-human', { password: 'wrong password' });
  expect(wrongPassword.status).toBe(401);
  expect(await wrongPassword.json()).toEqual({ error: 'authentication_denied' });
  expect(wrongPassword.headers.getSetCookie()).toEqual([]);
  expect(wrongPassword.headers.has('authorization')).toBe(false);
  expect((await pool.query('SELECT count(*) FROM session')).rows).toEqual(before.rows);
});

test('automated actors use only their own real password credentials and have no recovery-email route', async () => {
  await provision('robot', true);
  accounts.get('robot')!.state = 'active';
  actor('credentialless', 'active', true);
  const personCookie = await login('person');
  const robotCookie = await login('robot');
  expect(decodeJwt(await token(robotCookie)).sub).toBe('robot');
  expect(decodeJwt(await token(personCookie)).sub).toBe('person');
  await denied(await signin('credentialless'));
  await denied(await signin('robot', { account_id: 'person' }));
  await denied(await request('/request-password-reset', { email: 'robot@example.test' }));
  accounts.set('organization', {
    accountId: 'organization',
    kind: 'organization',
    state: 'pending',
    authnEpoch: 1,
    automated: false,
  });
  approvals.set('organization-grant', 'organization');
  await expect(
    service.internal.provisionPassword({ authorization: 'organization-grant', email: 'org@example.test', password }),
  ).rejects.toThrow();
  expect((await pool.query('SELECT id FROM "user" WHERE id=$1', ['organization'])).rowCount).toBe(0);
});

test('Better Auth revocation persists across service and database connection restarts, without cookie caching', async () => {
  const cookie = await login('person');
  await service.internal.revokeSessions('person');
  await denied(await request('/session', undefined, cookie));
  await denied(await request('/token', {}, cookie));
  const restartedPool = new Pool({ connectionString: pool.options.connectionString });
  try {
    const restarted = await createAuthService({ ...options, database: restartedPool });
    await denied(await request('/session', undefined, cookie, restarted));
    const fresh = await login('person', {}, restarted);
    expect((await (await request('/session', undefined, fresh, restarted)).json()).account_id).toBe('person');
  } finally {
    await restartedPool.end();
  }
});

test('registered clients and explicit consent persist; token input cannot change session-bound client or scope', async () => {
  await provision('consent-person');
  accounts.get('consent-person')!.state = 'active';
  await denied(await signin('consent-person', { client_id: 'unknown' }));
  await denied(await signin('consent-person', { client_id: 'external' }));
  const web = await login('consent-person');
  expect(decodeJwt(await token(web)).scope).toBe('read');
  expect((await request('/consent', { client_id: 'external', scope: ['read'] }, web)).status).toBe(200);
  const reloaded = await createAuthService(options);
  const external = await login('consent-person', { client_id: 'external' }, reloaded);
  const proof = decodeJwt(await token(external, reloaded));
  expect(proof.client_id).toBe('external');
  expect(proof.scope).toBe('read');
  await denied(await signin('consent-person', { client_id: 'external', scope: ['read', 'write'] }));
  await denied(await signin('consent-person', { scope: ['unregistered'] }));
  for (const injection of [
    { scope: ['write'] },
    { client_id: 'web' },
    { auth_time: 0 },
    { amr: ['hwk'] },
    { authn_epoch: 999 },
    { sub: 'other' },
  ]) {
    await denied(await request('/token', injection, external));
  }
  expect((await request('/consent', { client_id: 'external', scope: [] }, web)).status).toBe(200);
  await denied(await request('/token', {}, external));
});

test('tokens verify with public JWKS, exact approved claims and five-minute lifetime; standard JOSE rejects invalid tokens', async () => {
  const cookie = await login('person');
  const jwt = await token(cookie);
  const response = await request('/.well-known/jwks.json');
  expect(response.status).toBe(200);
  const jwks = await response.json();
  const keys = createLocalJWKSet(jwks);
  const { payload } = await jwtVerify(jwt, keys, { issuer, audience, algorithms: ['ES256'] });
  expect(Object.keys(payload).sort()).toEqual(
    ['iss', 'aud', 'sub', 'client_id', 'scope', 'authn_epoch', 'iat', 'exp', 'auth_time', 'amr'].sort(),
  );
  expect(payload).toMatchObject({
    iss: issuer,
    aud: audience,
    sub: 'person',
    client_id: 'web',
    scope: 'read',
    authn_epoch: 1,
    amr: ['pwd'],
  });
  expect(payload.exp! - payload.iat!).toBe(300);
  const session = await (await request('/session', undefined, cookie)).json();
  expect(payload.auth_time).toBe(session.auth_time);
  expect(payload.auth_time as number).toBeLessThanOrEqual(payload.iat!);
  expect(service.verifier).toEqual({
    issuer,
    audience,
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    algorithms: ['ES256'],
    accessTokenLifetimeSeconds: 300,
  });
  expect(jwks.keys[0]).toMatchObject({ kid: 'fixture-signing-key', kty: 'EC', alg: 'ES256', use: 'sig' });
  for (const key of jwks.keys)
    for (const secret of ['d', 'p', 'q', 'dp', 'dq', 'qi', 'k']) expect(key[secret]).toBeUndefined();
  const { privateKey } = await generateKeyPair('ES256');
  for (const [overrides, kid] of [
    [{}, 'fixture-signing-key'],
    [{ iss: 'https://evil.test' }, 'fixture-signing-key'],
    [{ aud: 'other-api' }, 'fixture-signing-key'],
    [{ exp: 1 }, 'fixture-signing-key'],
    [{}, 'unknown-key'],
  ] as const) {
    const forged = await new SignJWT({ ...payload, ...overrides })
      .setProtectedHeader({ alg: 'ES256', kid })
      .sign(privateKey);
    await expect(jwtVerify(forged, keys, { issuer, audience })).rejects.toThrow();
  }
  await expect(jwtVerify(jwt, keys, { issuer: 'wrong', audience })).rejects.toThrow();
  await expect(jwtVerify(jwt, keys, { issuer, audience: 'wrong' })).rejects.toThrow();
  await expect(
    jwtVerify(jwt, keys, { issuer, audience, currentDate: new Date((payload.exp! + 1) * 1000) }),
  ).rejects.toThrow();
  const serialized = JSON.stringify({ jwks, session });
  for (const secret of ['example.test', 'password', 'email', 'privateKey', privateJwk.d!])
    expect(serialized).not.toContain(secret);
});

test('epoch is installed only at authenticated establishment; state/floor failures and unproved delegation reject', async () => {
  const cookie = await login('person');
  accounts.get('person')!.authnEpoch = 2;
  await denied(await request('/token', {}, cookie));
  await denied(await request('/session', undefined, cookie));
  await denied(await request('/token', { authn_epoch: 2 }, cookie));
  const fresh = await login('person');
  expect(decodeJwt(await token(fresh)).authn_epoch).toBe(2);
  unavailable = true;
  try {
    await denied(await request('/token', {}, fresh));
  } finally {
    unavailable = false;
  }
  for (const injection of [
    { requested_by: 'person' },
    { requested_by: 'person', assignment_proof: 'forged' },
    { act: { sub: 'person' } },
    { principal: 'person' },
    { state: 'active' },
    { operator_account_id: 'person' },
    { authn_epoch: 100 },
  ]) {
    await denied(await signin('robot', injection));
    await denied(await request('/token', injection, fresh));
  }
});

test('signing injection is required, survives restart and never publishes private material', async () => {
  await expect(createAuthService({ ...options, signing: { activeKid: 'absent', privateKeys: [] } })).rejects.toThrow();
  const cookie = await login('person');
  const first = await token(cookie);
  const restarted = await createAuthService(options);
  const jwks = await (await request('/.well-known/jwks.json', undefined, '', restarted)).json();
  await expect(jwtVerify(first, createLocalJWKSet(jwks), { issuer, audience })).resolves.toBeDefined();
  const second = await token(cookie, restarted);
  await expect(jwtVerify(second, createLocalJWKSet(jwks), { issuer, audience })).resolves.toBeDefined();
  expect(await (await request('/session', undefined, cookie)).text()).not.toContain(privateJwk.d!);
});
