import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
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
let accessFailureAt = Infinity;
let accessReads = 0;

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
        if (++accessReads >= accessFailureAt) throw new Error('Access unavailable: private detail');
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

async function refused(response: Response, code: string, status = 400) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.has('location')).toBe(false);
  expect(await response.json()).toEqual({ error: code });
}
const refreshFields = (token = 'unknown') => fields({ grant_type: 'refresh_token', refresh_token: token });

test('malformed token requests return invalid_request with no details', async () => {
  for (const change of [
    (body: URLSearchParams) => body.append('resource', audience),
    (body: URLSearchParams) => body.set('unknown', 'private'),
    (body: URLSearchParams) => body.set('refresh_token', 'x'.repeat(8193)),
    (body: URLSearchParams) => body.set('client_assertion', 'x'.repeat(17000)),
    (body: URLSearchParams) => body.delete('grant_type'),
    (body: URLSearchParams) => body.delete('refresh_token'),
    (body: URLSearchParams) => body.delete('resource'),
  ]) {
    const body = await refreshFields();
    change(body);
    await refused(await post('/token', body), 'invalid_request');
  }
  await refused(await post('/token', await refreshFields(), { 'content-type': 'text/plain' }), 'invalid_request');
  for (const name of ['code', 'redirect_uri', 'code_verifier']) {
    const body = await fields({
      grant_type: 'authorization_code',
      code: 'unknown',
      redirect_uri: callback,
      code_verifier: randomBytes(48).toString('base64url'),
    });
    body.delete(name);
    await refused(await post('/token', body), 'invalid_request');
  }
});

test('failed and replayed client authentication returns 401 invalid_client', async () => {
  for (const change of [
    (body: URLSearchParams) => body.delete('client_assertion'),
    (body: URLSearchParams) => body.set('client_assertion', 'private.invalid.assertion'),
    (body: URLSearchParams) => body.set('client_assertion_type', 'wrong'),
    (body: URLSearchParams) => body.set('client_id', 'unknown'),
  ]) {
    const body = await refreshFields();
    change(body);
    await refused(await post('/token', body), 'invalid_client', 401);
  }
  const { cookie } = await login();
  const code = await grant(cookie);
  const body = await fields({
    grant_type: 'authorization_code',
    code: code.code,
    code_verifier: code.verifier,
    redirect_uri: callback,
  });
  expect((await post('/token', body)).status).toBe(200);
  await refused(await post('/token', body), 'invalid_client', 401);
});

test('unknown, expired, revoked and rotated refresh grants return invalid_grant', async () => {
  await refused(await refresh('unknown'), 'invalid_grant');
  const { cookie } = await login();
  const expired = await issue(cookie);
  await pool.query('UPDATE "oauthRefreshToken" SET "expiresAt"=now()-interval \'1 second\' WHERE token=$1', [
    createHash('sha256').update(expired.refresh_token).digest('base64url'),
  ]);
  await refused(await refresh(expired.refresh_token), 'invalid_grant');
  const issued = await issue(cookie);
  const rotation = await refresh(issued.refresh_token);
  expect(rotation.status).toBe(200);
  const rotated = await rotation.json();
  await refused(await refresh(issued.refresh_token), 'invalid_grant');
  await refused(await refresh(rotated.refresh_token), 'invalid_grant');
});

test('unknown, expired, replayed, PKCE and redirect-mismatched codes return invalid_grant', async () => {
  await refused(await exchange('unknown', randomBytes(48).toString('base64url')), 'invalid_grant');
  const { cookie } = await login();
  const expired = await grant(cookie);
  await pool.query('UPDATE verification SET "expiresAt"=now()-interval \'1 second\' WHERE identifier=$1', [
    createHash('sha256').update(expired.code).digest('base64url'),
  ]);
  await refused(await exchange(expired.code, expired.verifier), 'invalid_grant');
  const badPkce = await grant(cookie);
  await refused(await exchange(badPkce.code, randomBytes(48).toString('base64url')), 'invalid_grant');
  const mismatch = await grant(cookie);
  await refused(
    await post(
      '/token',
      await fields({
        grant_type: 'authorization_code',
        code: mismatch.code,
        code_verifier: mismatch.verifier,
        redirect_uri: `${callback}/wrong`,
      }),
    ),
    'invalid_grant',
  );
  const code = await grant(cookie);
  expect((await exchange(code.code, code.verifier)).status).toBe(200);
  await refused(await exchange(code.code, code.verifier), 'invalid_grant');
});

test('Access-invalidated accounts return invalid_grant', async () => {
  for (const change of [
    (account: AccessAccount) => account.authnEpoch++,
    (account: AccessAccount) => account.authnEpoch--,
    (account: AccessAccount) => (account.fenced = true),
    (account: AccessAccount) => (account.state = 'pending'),
  ]) {
    const { id, cookie } = await login();
    const issued = await issue(cookie);
    change(accounts.get(id)!);
    await refused(await refresh(issued.refresh_token), 'invalid_grant');
  }
});

test('unsupported grants, expanded scopes and other resources have distinct refusal codes', async () => {
  await refused(await post('/token', await fields({ grant_type: 'client_credentials' })), 'unsupported_grant_type');
  const { cookie } = await login();
  const issued = await issue(cookie);
  for (const scope of ['unknown:action', 'media:create']) {
    // First narrow a grant so even a registered scope can be beyond its grant.
    const response = await post(
      '/token',
      await fields({
        grant_type: 'refresh_token',
        refresh_token: issued.refresh_token,
        scope: 'openid offline_access media:read',
      }),
    );
    expect(response.status).toBe(200);
    const narrowed = await response.json();
    await refused(
      await post('/token', await fields({ grant_type: 'refresh_token', refresh_token: narrowed.refresh_token, scope })),
      'invalid_scope',
    );
    issued.refresh_token = narrowed.refresh_token;
  }
  const body = await refreshFields(issued.refresh_token);
  body.set('resource', `${audience}/`);
  await refused(await post('/token', body), 'invalid_target');
});

test('database and Access failures during refresh return 503 without private details', async () => {
  const { cookie } = await login();
  const issued = await issue(cookie);
  const query = spyOn(pool, 'query').mockImplementationOnce(() => {
    throw new Error('Database private detail');
  });
  try {
    await refused(await refresh(issued.refresh_token), 'temporarily_unavailable', 503);
  } finally {
    query.mockRestore();
  }
  // Both preflight and native issuance rechecks must keep transient failures 5xx.
  for (const reads of [1, 2]) {
    accessFailureAt = accessReads + reads;
    try {
      await refused(await refresh(issued.refresh_token), 'temporarily_unavailable', 503);
    } finally {
      accessFailureAt = Infinity;
    }
  }
});

test('a database issuance exception returns 503 and never a protocol refusal', async () => {
  const { cookie } = await login();
  const issued = await issue(cookie);
  await pool.query(`CREATE FUNCTION fail_website_issuance() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'private issuance database detail'; END $$`);
  await pool.query(`CREATE TRIGGER fail_website_issuance BEFORE INSERT ON "oauthRefreshToken"
    FOR EACH ROW EXECUTE FUNCTION fail_website_issuance()`);
  try {
    await refused(await refresh(issued.refresh_token), 'temporarily_unavailable', 503);
  } finally {
    await pool.query('DROP TRIGGER fail_website_issuance ON "oauthRefreshToken"');
    await pool.query('DROP FUNCTION fail_website_issuance()');
  }
});

test('a request reader failure returns 503 and non-token dependency failures do too', async () => {
  const response = await service.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new ReadableStream({
        pull() {
          throw new Error('private reader failure');
        },
      }),
    }),
  );
  await refused(response, 'temporarily_unavailable', 503);
  const query = spyOn(pool, 'query').mockImplementationOnce(() => {
    throw new Error('private database failure');
  });
  try {
    await refused(await service.handler(new Request(`${issuer}/logout`)), 'temporarily_unavailable', 503);
  } finally {
    query.mockRestore();
  }
});
