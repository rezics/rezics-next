import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import * as authModule from '../src/index.ts';
import type { AccessAccount, AuthService, AuthServiceOptions, PublicJwks } from '../src/index.ts';
import { testDatabase } from '../scripts/database.ts';

const clientId = 'rezics-website';
const audience = 'https://api.rezics.test';
const password = 'correct horse battery staple';
const scopes = ['openid', 'offline_access', 'media:create', 'media:read', 'media:complete'];
const people = ['00000000-0000-7000-8000-123400000091', '00000000-0000-7000-8000-123400000092'];
const accounts = new Map<string, AccessAccount>();
const approvals = new Set<string>();
let fixture: ReturnType<typeof testDatabase>;
let pool: Pool;
let server: ReturnType<typeof Bun.serve>;
let service: AuthService;
let options: AuthServiceOptions;
let clientKey: Awaited<ReturnType<typeof generateKeyPair>>;
let publicJwks: PublicJwks;
let issuer: string;
let redirectUri: string;

beforeAll(async () => {
  // This issuer owns its database, including its persisted signing-key order.
  fixture = testDatabase();
  pool = new Pool({ connectionString: fixture.url });
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => service.handler(request),
  });
  issuer = `http://127.0.0.1:${server.port}`;
  redirectUri = `${issuer}/website/callback`;
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'website-issuer-signing',
    alg: 'ES256',
  };
  clientKey = await generateKeyPair('ES256', { extractable: true });
  publicJwks = {
    keys: [{ ...(await exportJWK(clientKey.publicKey)), kid: 'website-client-key', alg: 'ES256', use: 'sig' }],
  } as PublicJwks;
  options = {
    database: pool,
    issuer,
    audience,
    secret: 'isolated-website-issuer-secret-at-least-32-bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: trustedAccessPorts({
      async readFencedAccount(id) {
        return this.readAccount(id);
      },
      async readAccount(accountId) {
        return accounts.get(accountId) ?? null;
      },
      async authorizeProvisioning(accountId) {
        if (!approvals.delete(accountId)) throw new Error('Missing trusted provisioning approval');
        return { accountId };
      },
    }),
  };
}, 30000);

afterAll(async () => {
  await server?.stop(true);
  await pool?.end();
  fixture?.close();
});

async function registerWebsite() {
  expect(Reflect.get(authModule, 'WEBSITE_CLIENT_ID')).toBe(clientId);
  const register = Reflect.get(service.internal, 'registerWebsiteClient') as
    | ((input: {
        publicJwks: PublicJwks;
        redirectUris: string[];
        postLogoutRedirectUris: string[];
        scopes: string[];
      }) => Promise<void>)
    | undefined;
  expect(typeof register).toBe('function');
  await register!({ publicJwks, redirectUris: [redirectUri], postLogoutRedirectUris: [`${issuer}/`], scopes });
}

async function assertion() {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: 'website-client-key' })
    .setIssuer(clientId)
    .setSubject(clientId)
    .setAudience(issuer)
    .setIssuedAt(now)
    .setExpirationTime(now + 120)
    .setJti(randomBytes(24).toString('base64url'))
    .sign(clientKey.privateKey);
}

async function token(fields: Record<string, string>) {
  return fetch(`${issuer}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: await assertion(),
      resource: audience,
      ...fields,
    }),
  });
}

test('website first authorization materializes standing consent before code issuance and refresh preserves uploader proof', async () => {
  service = await authModule.createAuthService(options);
  await registerWebsite();
  const discoveryResponse = await fetch(`${issuer}/.well-known/openid-configuration`);
  expect(discoveryResponse.status).toBe(200);
  expect(await discoveryResponse.json()).toMatchObject({
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    revocation_endpoint: `${issuer}/revoke`,
    end_session_endpoint: `${issuer}/logout`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    response_types_supported: ['code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['private_key_jwt'],
    token_endpoint_auth_signing_alg_values_supported: ['ES256'],
  });
  await service.internal.registerClient({ clientId: 'login', firstParty: true, scopes: ['media:read'] });
  const keys = createLocalJWKSet(await (await fetch(`${issuer}/.well-known/jwks.json`)).json());
  for (const accountId of people) {
    const account: AccessAccount = { accountId, kind: 'actor', state: 'pending', authnEpoch: 1, automated: false };
    accounts.set(accountId, account);
    approvals.add(accountId);
    await service.internal.provisionPassword({
      authorization: accountId,
      email: `${accountId}@example.test`,
      password,
    });
    account.state = 'active';
    const login = await fetch(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${accountId}@example.test`, password, client_id: 'login', scope: ['media:read'] }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    expect(cookie).toContain('session_token=');
    const verifier = randomBytes(48).toString('base64url');
    const state = randomBytes(24).toString('base64url');
    const authorize = new URL(`${issuer}/authorize`);
    authorize.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scopes.join(' '),
      state,
      nonce: state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      resource: audience,
    }).toString();
    expect(
      (await pool.query('SELECT scopes FROM auth_consent WHERE account_id=$1 AND client_id=$2', [accountId, clientId]))
        .rowCount,
    ).toBe(0);
    const authorization = await fetch(authorize, { headers: { cookie }, redirect: 'manual' });
    expect(
      (await pool.query('SELECT scopes FROM auth_consent WHERE account_id=$1 AND client_id=$2', [accountId, clientId]))
        .rows[0]?.scopes,
    ).toEqual(expect.arrayContaining(scopes));
    expect([302, 303]).toContain(authorization.status);
    const location = new URL(authorization.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe(redirectUri);
    expect(location.searchParams.get('state')).toBe(state);
    expect(location.searchParams.has('access_token')).toBe(false);
    const code = location.searchParams.get('code');
    expect(code).toBeTruthy();
    const exchange = await token({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    expect(exchange.status).toBe(200);
    const issued = await exchange.json();
    expect(issued).toMatchObject({ token_type: 'Bearer', expires_in: 300 });
    const access = await jwtVerify(issued.access_token, keys, {
      issuer,
      audience,
      algorithms: ['ES256'],
      typ: 'at+jwt',
    });
    expect(access.payload).toMatchObject({ sub: accountId, client_id: clientId, authn_epoch: 1, amr: ['pwd'] });
    expect(new Set(String(access.payload.scope).split(' '))).toContain('media:complete');
    const id = await jwtVerify(issued.id_token, keys, { issuer, audience: clientId, algorithms: ['ES256'] });
    expect(id.payload).toMatchObject({ sub: accountId, nonce: state });
    expect(id.payload.sid).toBeTruthy();
    await expect(jwtVerify(issued.id_token, keys, { issuer, audience, typ: 'at+jwt' })).rejects.toThrow();
    expect(typeof issued.refresh_token).toBe('string');
    const refresh = await token({ grant_type: 'refresh_token', refresh_token: issued.refresh_token });
    expect(refresh.status).toBe(200);
    const rotated = await refresh.json();
    expect(rotated.refresh_token).not.toBe(issued.refresh_token);
    const refreshed = await jwtVerify(rotated.access_token, keys, { issuer, audience, typ: 'at+jwt' });
    expect(refreshed.payload).toMatchObject({
      sub: accountId,
      client_id: clientId,
      authn_epoch: 1,
      auth_time: access.payload.auth_time,
    });
    const replay = await token({ grant_type: 'refresh_token', refresh_token: issued.refresh_token });
    expect(replay.status).toBeGreaterThanOrEqual(400);
    const revoked = await token({ grant_type: 'refresh_token', refresh_token: rotated.refresh_token });
    expect(revoked.status).toBeGreaterThanOrEqual(400);
  }
}, 30000);

test('every generic client registration refuses the website-only completion scope', async () => {
  service = await authModule.createAuthService(options);
  for (const firstParty of [true, false]) {
    await expect(
      service.internal.registerClient({ clientId: `other-${firstParty}`, firstParty, scopes: ['media:complete'] }),
    ).rejects.toThrow();
  }
});
