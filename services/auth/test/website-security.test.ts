import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import {
  createAuthService,
  WEBSITE_CLIENT_ID,
  type AccessAccount,
  type AuthService,
  type AuthServiceOptions,
  type PublicJwks,
} from '../src/index.ts';

const scopes = ['openid', 'offline_access', 'media:create', 'media:read', 'media:complete'];
const audience = 'https://api.rezics.test';
const accounts = new Map<string, AccessAccount>();
const password = 'correct horse battery staple';
let fixture: ReturnType<typeof testDatabase>;
let pool: Pool;
let server: ReturnType<typeof Bun.serve>;
let service: AuthService;
let options: AuthServiceOptions;
let issuer: string;
let callback: string;
let clientKey: Awaited<ReturnType<typeof generateKeyPair>>;
let signingKey: Awaited<ReturnType<typeof generateKeyPair>>;
let publicJwks: PublicJwks;
let person = 100;
let available = true;

beforeAll(async () => {
  fixture = testDatabase();
  pool = new Pool({ connectionString: fixture.url, max: 1 });
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => service.handler(request) });
  issuer = `http://127.0.0.1:${server.port}`;
  callback = `${issuer}/website/callback`;
  clientKey = await generateKeyPair('ES256', { extractable: true });
  signingKey = await generateKeyPair('ES256', { extractable: true });
  publicJwks = {
    keys: [{ ...(await exportJWK(clientKey.publicKey)), kid: 'website-client', alg: 'ES256', use: 'sig' }],
  } as PublicJwks;
  options = {
    database: pool,
    issuer,
    audience,
    secret: 'website-security-test-persistent-secret-32-bytes',
    signing: {
      activeKid: 'issuer',
      privateKeys: [{ ...(await exportJWK(signingKey.privateKey)), kid: 'issuer', alg: 'ES256' }],
    },
    siteActions: new Map(scopes.filter((s) => s.includes(':')).map((s) => [s, { anonymous: false }])),
    trustedAccess: trustedAccessPorts({
      async readFencedAccount(id) {
        return this.readAccount(id);
      },
      async readAccount(id) {
        if (!available) throw new Error('Unavailable');
        return accounts.get(id) ?? null;
      },
      async authorizeProvisioning(id) {
        if (!accounts.has(id)) throw new Error('Unknown owner');
        return { accountId: id };
      },
      async invalidateAccount({ accountId, previousEpoch }) {
        const account = accounts.get(accountId)!;
        account.authnEpoch = Math.max(account.authnEpoch, previousEpoch) + 1;
        return { accountId, minimumAuthnEpoch: account.authnEpoch, receiptId: `floor-${account.authnEpoch}` };
      },
    }),
  };
  service = await createAuthService(options);
  await register();
  await service.internal.registerClient({ clientId: 'login', firstParty: true, scopes: ['media:read'] });
}, 30000);

afterAll(async () => {
  await server?.stop(true);
  await pool?.end();
  fixture?.close();
});

function register(overrides: Partial<Parameters<AuthService['internal']['registerWebsiteClient']>[0]> = {}) {
  return service.internal.registerWebsiteClient({
    publicJwks,
    redirectUris: [callback],
    postLogoutRedirectUris: [`${issuer}/`],
    scopes,
    ...overrides,
  });
}
async function login() {
  const id = `00000000-0000-7000-8000-${(++person).toString(16).padStart(12, '0')}`;
  const account: AccessAccount = { accountId: id, kind: 'actor', state: 'pending', authnEpoch: 1, automated: false };
  accounts.set(id, account);
  await service.internal.provisionPassword({ authorization: id, email: `${id}@example.test`, password });
  account.state = 'active';
  const response = await fetch(`${issuer}/signin`, {
    method: 'POST',
    headers: { origin: issuer, 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${id}@example.test`, password, client_id: 'login', scope: ['media:read'] }),
  });
  expect(response.status).toBe(200);
  return {
    id,
    cookie: response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; '),
  };
}
function authorization(cookie: string, overrides: Record<string, string | null> = {}) {
  const verifier = randomBytes(48).toString('base64url');
  const url = new URL(`${issuer}/authorize`);
  url.search = new URLSearchParams({
    client_id: WEBSITE_CLIENT_ID,
    redirect_uri: callback,
    response_type: 'code',
    scope: scopes.join(' '),
    state: 'state',
    nonce: 'nonce',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: audience,
  }).toString();
  for (const [key, value] of Object.entries(overrides))
    value === null ? url.searchParams.delete(key) : url.searchParams.set(key, value);
  return { url, verifier, response: () => fetch(url, { headers: { cookie }, redirect: 'manual' }) };
}
async function grant(cookie: string) {
  const auth = authorization(cookie);
  const response = await auth.response();
  if (response.status !== 302) {
    const [body, transitions, dependencies, consent] = await Promise.all([
      response.clone().json() as Promise<{ error?: unknown }>,
      pool.query<{ state: string }>(
        'SELECT state FROM auth_kind_consent_transition WHERE client_id=$1 ORDER BY updated_at DESC LIMIT 3',
        [WEBSITE_CLIENT_ID],
      ),
      pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM auth_kind_consent_dependency WHERE client_id=$1 AND active',
        [WEBSITE_CLIENT_ID],
      ),
      pool.query<{ count: string }>('SELECT count(*)::text AS count FROM auth_consent WHERE client_id=$1', [
        WEBSITE_CLIENT_ID,
      ]),
    ]);
    const code = typeof body.error === 'string' ? body.error : 'absent';
    throw new Error(
      `website authorize expected 302, received ${response.status} (${code}); consent rows=${consent.rows[0]?.count}; transitions=${transitions.rows.map((row) => row.state).join(',')}; active dependencies=${dependencies.rows[0]?.count}`,
    );
  }
  expect(response.status).toBe(302);
  return { code: new URL(response.headers.get('location')!).searchParams.get('code')!, verifier: auth.verifier };
}
async function assertion(overrides: Record<string, unknown> = {}, key = clientKey.privateKey, kid = 'website-client') {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: WEBSITE_CLIENT_ID,
    sub: WEBSITE_CLIENT_ID,
    aud: issuer,
    iat: now,
    exp: now + 120,
    jti: randomBytes(24).toString('base64url'),
    ...overrides,
  })
    .setProtectedHeader({ alg: 'ES256', kid })
    .sign(key);
}
async function fields(values: Record<string, string>, proof = assertion()) {
  return new URLSearchParams({
    client_id: WEBSITE_CLIENT_ID,
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: await proof,
    resource: audience,
    ...values,
  });
}
function post(path: string, body: URLSearchParams, headers: Record<string, string> = {}) {
  return fetch(`${issuer}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body,
    redirect: 'manual',
  });
}
async function exchange(code: string, verifier: string) {
  return post(
    '/token',
    await fields({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: callback }),
  );
}
async function issue(cookie: string) {
  const code = await grant(cookie);
  const response = await exchange(code.code, code.verifier);
  expect(response.status).toBe(200);
  return response.json();
}
async function refresh(token: string) {
  return post('/token', await fields({ grant_type: 'refresh_token', refresh_token: token }));
}

test('registry rejects hostile identities and key material and remains one durable authority', async () => {
  const privateJwk = await exportJWK(clientKey.privateKey);
  for (const key of [
    { ...publicJwks.keys[0], d: privateJwk.d },
    { ...publicJwks.keys[0], kid: '' },
    { ...publicJwks.keys[0], alg: 'HS256' },
    { ...publicJwks.keys[0], use: 'enc' },
    { ...publicJwks.keys[0], x: 'not-a-point' },
  ])
    await expect(register({ publicJwks: { keys: [key] } as PublicJwks })).rejects.toThrow();
  await expect(register({ publicJwks: { keys: [publicJwks.keys[0]!, publicJwks.keys[0]!] } })).rejects.toThrow();
  await expect(register({ scopes: [...scopes, 'unknown:action'] })).rejects.toThrow();
  await expect(register({ redirectUris: [`${callback}#fragment`] })).rejects.toThrow();
  await expect(register({ scopes: scopes.filter((s) => s !== 'media:read') })).rejects.toThrow();
  await expect(
    service.internal.registerClient({ clientId: WEBSITE_CLIENT_ID, firstParty: true, scopes: [] }),
  ).rejects.toThrow();
  await register();
  service = await createAuthService(options);
  const metadata = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json();
  expect(new Set(metadata.scopes_supported)).toEqual(new Set(scopes));
  const row = (await pool.query('SELECT scopes,jwks FROM auth_client WHERE client_id=$1', [WEBSITE_CLIENT_ID])).rows[0];
  expect(new Set(row.scopes)).toEqual(new Set(metadata.scopes_supported));
  expect(JSON.parse(row.jwks).keys[0]).not.toHaveProperty('d');
});

test('authorize refuses unknown redirects, grants, scopes, resource and PKCE before redirecting', async () => {
  const { cookie } = await login();
  for (const change of [
    { redirect_uri: `${callback}/extra` },
    { redirect_uri: 'https://attacker.test/' },
    { client_id: 'unknown' },
    { response_type: 'token' },
    { scope: `${scopes.join(' ')} unknown:action` },
    { state: null },
    { code_challenge_method: 'plain' },
    { code_challenge: null },
    { resource: null },
    { resource: `${audience}/` },
  ]) {
    const response = await authorization(cookie, change).response();
    expect(response.status).toBe(400);
    expect(response.headers.has('location')).toBe(false);
  }
  const duplicate = authorization(cookie);
  duplicate.url.searchParams.append('resource', audience);
  expect((await duplicate.response()).status).toBe(400);
  expect((await fetch(`${issuer}/api/auth/oauth2/authorize`, { headers: { cookie }, redirect: 'manual' })).status).toBe(
    404,
  );
});

test('confidential assertions and PKCE are independent, exact and durably one-use', async () => {
  const { cookie } = await login();
  const code = await grant(cookie);
  const params = {
    grant_type: 'authorization_code',
    code: code.code,
    code_verifier: code.verifier,
    redirect_uri: callback,
  };
  const wrongKey = (await generateKeyPair('ES256')).privateKey;
  const now = Math.floor(Date.now() / 1000);
  for (const proof of [
    assertion({}, wrongKey),
    assertion({}, clientKey.privateKey, 'unknown'),
    assertion({ iss: 'other' }),
    assertion({ sub: 'other' }),
    assertion({ aud: `${issuer}/token` }),
    assertion({ aud: [issuer] }),
    assertion({ iat: now + 60 }),
    assertion({ iat: now - 60, exp: now - 1 }),
    assertion({ iat: now, exp: now + 121 }),
    assertion({ jti: '' }),
  ]) {
    expect((await post('/token', await fields(params, proof))).status).toBe(401);
  }
  const duplicate = await fields(params);
  duplicate.append('client_id', WEBSITE_CLIENT_ID);
  expect((await post('/token', duplicate)).status).toBe(400);
  const missingResource = await fields(params);
  missingResource.delete('resource');
  expect((await post('/token', missingResource)).status).toBe(400);
  expect((await exchange(code.code, randomBytes(48).toString('base64url'))).status).toBe(400);
  // Native PKCE consumes the bad code. A separate valid code proves that a
  // rejected assertion never consumed the code whose PKCE was otherwise valid.
  const valid = await grant(cookie);
  const body = await fields({ ...params, code: valid.code, code_verifier: valid.verifier });
  const [first, second] = await Promise.all([post('/token', body), post('/token', body)]);
  expect([first.status, second.status].sort()).toEqual([200, 401]);
  service = await createAuthService(options);
  expect((await post('/token', body)).status).toBe(401);
});

test('refresh denies expired, expanded, stale account and missing consent evidence', async () => {
  const { id, cookie } = await login();
  const issued = await issue(cookie);
  expect(
    (
      await post(
        '/token',
        await fields({
          grant_type: 'refresh_token',
          refresh_token: issued.refresh_token,
          scope: `${scopes.join(' ')} unknown:action`,
        }),
      )
    ).status,
  ).toBe(400);
  await pool.query('DELETE FROM auth_consent WHERE account_id=$1 AND client_id=$2', [id, WEBSITE_CLIENT_ID]);
  expect((await refresh(issued.refresh_token)).status).toBe(400);
  // A fresh authorization may materialize first-party consent, but never
  // upgrades the epoch authenticated by an older session or refresh token.
  await issue(cookie);
  available = false;
  try {
    expect((await refresh(issued.refresh_token)).status).toBe(503);
  } finally {
    available = true;
  }
  accounts.get(id)!.authnEpoch++;
  expect((await refresh(issued.refresh_token)).status).toBe(400);
  const fresh = await login();
  const expired = await issue(fresh.cookie);
  await pool.query('UPDATE "oauthRefreshToken" SET "expiresAt"=now()-interval \'1 second\' WHERE token=$1', [
    createHash('sha256').update(expired.refresh_token).digest('base64url'),
  ]);
  expect((await refresh(expired.refresh_token)).status).toBe(400);
});

test('revoking an API JWT commits Access invalidation and leaves the old refresh unusable', async () => {
  const { id, cookie } = await login();
  const issued = await issue(cookie);
  const keys = createLocalJWKSet(await (await fetch(`${issuer}/.well-known/jwks.json`)).json());
  const old = await jwtVerify(issued.access_token, keys, { issuer, audience, typ: 'at+jwt' });
  expect(
    (await post('/revoke', await fields({ token: issued.access_token, token_type_hint: 'access_token' }))).status,
  ).toBe(200);
  expect(accounts.get(id)!.authnEpoch).toBeGreaterThan(Number(old.payload.authn_epoch));
  expect((await refresh(issued.refresh_token)).status).toBe(400);
});

test('website refresh revocation validates its resource before invalidating the family', async () => {
  const { id, cookie } = await login(),
    issued = await issue(cookie),
    account = accounts.get(id)!,
    epoch = account.authnEpoch;
  const wrongResource = await fields({
    token: issued.refresh_token,
    token_type_hint: 'refresh_token',
    resource: `${audience}/`,
  });
  expect([...wrongResource.keys()].sort()).toEqual(
    ['client_assertion', 'client_assertion_type', 'client_id', 'resource', 'token', 'token_type_hint'].sort(),
  );
  const refused = await post('/revoke', wrongResource);
  expect([refused.status, await refused.json(), account.authnEpoch]).toEqual([
    400,
    { error: 'invalid_request' },
    epoch,
  ]);
  expect(
    (await post('/revoke', await fields({ token: issued.refresh_token, token_type_hint: 'refresh_token' }))).status,
  ).toBe(200);
  expect(account.authnEpoch).toBeGreaterThan(epoch);
  expect((await refresh(issued.refresh_token)).status).toBe(400);
});

test('browser confirmation uses the public alias and signed cookie before ending the native session', async () => {
  const { cookie } = await login();
  const url = new URL(`${issuer}/logout`);
  url.search = new URLSearchParams({
    client_id: WEBSITE_CLIENT_ID,
    post_logout_redirect_uri: `${issuer}/`,
    state: 'confirmed',
  }).toString();
  const confirmation = await fetch(url, { headers: { cookie, accept: 'text/html' }, redirect: 'manual' });
  expect(confirmation.status).toBe(200);
  expect(await confirmation.text()).toContain(`action="${issuer}/logout/confirm"`);
  expect(confirmation.headers.getSetCookie().every((c) => c.includes('Path=/logout/confirm'))).toBe(true);
  expect((await fetch(`${issuer}/session`, { headers: { cookie } })).status).toBe(200);
  const signed = confirmation.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  const response = await post('/logout/confirm', new URLSearchParams({ action: 'confirm' }), {
    cookie: `${cookie}; ${signed}`,
    origin: issuer,
    accept: 'text/html',
  });
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe(`${issuer}/?state=confirmed`);
  expect((await fetch(`${issuer}/session`, { headers: { cookie } })).status).toBe(401);
});

test('an expired signed hint is accepted only for the exact recent native session', async () => {
  const { cookie } = await login();
  const issued = await issue(cookie);
  const claims = decodeJwt(issued.id_token);
  const expired = await new SignJWT({
    ...claims,
    iat: Math.floor(Date.now() / 1000) - 600,
    exp: Math.floor(Date.now() / 1000) - 300,
  })
    .setProtectedHeader({ alg: 'ES256', kid: 'issuer' })
    .sign(signingKey.privateKey);
  const body = new URLSearchParams({
    id_token_hint: expired,
    client_id: WEBSITE_CLIENT_ID,
    post_logout_redirect_uri: `${issuer}/`,
    state: 'expired-hint',
  });
  const response = await post('/logout', body, { cookie });
  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe(`${issuer}/?state=expired-hint`);
  expect((await post('/logout', body)).status).toBe(302);
  await pool.query("UPDATE auth_recent_oidc_session SET expires_at=now()-interval '1 second' WHERE session_id=$1", [
    claims.sid,
  ]);
  expect((await post('/logout', body)).status).toBe(400);
});

test('simultaneous code redemption and refresh reuse cannot leave a usable branch', async () => {
  const { cookie } = await login();
  const code = await grant(cookie);
  const exchanges = await Promise.all([exchange(code.code, code.verifier), exchange(code.code, code.verifier)]);
  expect(exchanges.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
  expect(exchanges.some((r) => r.status === 400)).toBe(true);
  for (const response of exchanges.filter((r) => r.status === 200))
    expect((await refresh((await response.json()).refresh_token)).status).toBe(400);

  const other = await login();
  const issued = await issue(other.cookie);
  const rotations = await Promise.all([refresh(issued.refresh_token), refresh(issued.refresh_token)]);
  expect(rotations.filter((r) => r.status === 200)).toHaveLength(1);
  expect(rotations.filter((r) => r.status === 400)).toHaveLength(1);
  service = await createAuthService(options);
  for (const response of rotations.filter((r) => r.status === 200))
    expect((await refresh((await response.json()).refresh_token)).status).toBe(400);
});

test('rotation racing revocation and code redemption racing logout cannot revive authority', async () => {
  const person = await login();
  const issued = await issue(person.cookie);
  const [rotation, revocation] = await Promise.all([
    refresh(issued.refresh_token),
    post('/revoke', await fields({ token: issued.refresh_token, token_type_hint: 'refresh_token' })),
  ]);
  expect(revocation.status).toBe(200);
  expect([200, 400]).toContain(rotation.status);
  if (rotation.status === 200) expect((await refresh((await rotation.json()).refresh_token)).status).toBe(400);

  const other = await login();
  const hint = await issue(other.cookie);
  const pending = await grant(other.cookie);
  const [redemption, logout] = await Promise.all([
    exchange(pending.code, pending.verifier),
    post('/logout', new URLSearchParams({ id_token_hint: hint.id_token, client_id: WEBSITE_CLIENT_ID }), {
      cookie: other.cookie,
    }),
  ]);
  expect(logout.status).toBe(200);
  expect([200, 400]).toContain(redemption.status);
  if (redemption.status === 200) expect((await refresh((await redemption.json()).refresh_token)).status).toBe(400);
  expect((await fetch(`${issuer}/session`, { headers: { cookie: other.cookie } })).status).toBe(401);
});
