import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createHash, randomBytes } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import * as authModule from '../src/index.ts';
import type { AccessAccount, AuthService, AuthServiceOptions, PublicJwks } from '../src/index.ts';
import { testDatabase } from '../scripts/database.ts';

const clientId = 'rezics-website';
const audience = 'https://api.rezics.test';
const password = 'correct horse battery staple';
const scopes = ['openid', 'offline_access', 'media:create', 'media:read', 'media:complete'];
const people = ['00000000-0000-7000-8000-123400000081', '00000000-0000-7000-8000-123400000082'];
const accounts = new Map<string, AccessAccount>();
const approvals = new Set<string>();
const invalidations: string[] = [];
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
      // Boundary fixture for the Access-first floor; production binds Access.
      async invalidateAccount({ accountId, previousEpoch }) {
        const account = accounts.get(accountId)!;
        invalidations.push(accountId);
        account.authnEpoch = Math.max(account.authnEpoch, previousEpoch) + 1;
        return {
          accountId,
          minimumAuthnEpoch: account.authnEpoch,
          receiptId: `floor-${accountId}-${account.authnEpoch}`,
        };
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

async function signIn(accountId: string) {
  const account: AccessAccount = { accountId, kind: 'actor', state: 'pending', authnEpoch: 1, automated: false };
  accounts.set(accountId, account);
  approvals.add(accountId);
  await service.internal.provisionPassword({ authorization: accountId, email: `${accountId}@example.test`, password });
  account.state = 'active';
  const login = await fetch(`${issuer}/signin`, {
    method: 'POST',
    headers: { origin: issuer, 'content-type': 'application/json' },
    body: JSON.stringify({ email: `${accountId}@example.test`, password, client_id: 'login', scope: ['media:read'] }),
  });
  expect(login.status).toBe(200);
  return login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

async function issue(cookie: string) {
  const verifier = randomBytes(48).toString('base64url');
  const authorize = new URL(`${issuer}/authorize`);
  authorize.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    state: randomBytes(24).toString('base64url'),
    nonce: randomBytes(24).toString('base64url'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: audience,
  }).toString();
  const authorization = await fetch(authorize, { headers: { cookie }, redirect: 'manual' });
  const code = new URL(authorization.headers.get('location')!).searchParams.get('code')!;
  const exchange = await token({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  expect(exchange.status).toBe(200);
  return { authorize, issued: await exchange.json() };
}

function logout(fields: Record<string, string>) {
  const url = new URL(`${issuer}/logout`);
  url.search = new URLSearchParams(fields).toString();
  return url;
}

async function sessionStatus(cookie: string) {
  return (await fetch(`${issuer}/session`, { headers: { cookie } })).status;
}

async function nativeSessions(accountId: string) {
  return Number((await pool.query('SELECT count(*) FROM session WHERE "userId"=$1', [accountId])).rows[0].count);
}

test('revocation and RP-initiated logout end real Auth authority and redirect only to registered URIs', async () => {
  service = await authModule.createAuthService(options);
  await registerWebsite();
  await service.internal.registerClient({ clientId: 'login', firstParty: true, scopes: ['media:read'] });
  const [first, second] = people as [string, string];
  const firstCookie = await signIn(first);
  const secondCookie = await signIn(second);
  const { authorize, issued } = await issue(firstCookie);
  const other = await issue(secondCookie);

  // RFC 7009 revocation runs the Access floor before success and ends the family.
  const revoke = await fetch(`${issuer}/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: await assertion(),
      resource: audience,
      token: issued.refresh_token,
    }),
  });
  expect(revoke.status).toBe(200);
  expect(invalidations).toEqual([first]);
  expect((await token({ grant_type: 'refresh_token', refresh_token: issued.refresh_token })).status).toBe(400);
  // The raised floor already denies the old session's authority.
  expect(await sessionStatus(firstCookie)).toBe(401);

  // A different person's hint, or none, never ends the current session silently.
  for (const fields of [
    { id_token_hint: issued.id_token, post_logout_redirect_uri: `${issuer}/`, state: 'cross' },
    { client_id: clientId, post_logout_redirect_uri: `${issuer}/` },
  ]) {
    const response = await fetch(logout(fields), { headers: { cookie: secondCookie }, redirect: 'manual' });
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  }
  expect(await sessionStatus(secondCookie)).toBe(200);
  // Forged hints and unregistered redirects are refused without redirecting.
  const forged = `${issued.id_token.slice(0, -4)}AAAA`;
  for (const fields of [
    { id_token_hint: forged, post_logout_redirect_uri: `${issuer}/` },
    { id_token_hint: issued.id_token, post_logout_redirect_uri: 'https://elsewhere.test/' },
    { id_token_hint: other.issued.id_token, client_id: 'login', post_logout_redirect_uri: `${issuer}/` },
  ]) {
    const response = await fetch(logout(fields), { headers: { cookie: firstCookie }, redirect: 'manual' });
    expect(response.status).toBe(400);
    expect(response.headers.get('location')).toBeNull();
  }
  // Refused requests end no native session.
  expect(await nativeSessions(first)).toBe(1);
  expect(await nativeSessions(second)).toBe(1);

  // A matching hint ends the real Better Auth session, echoing state only to the
  // exactly registered URI, and clears the issuer session cookie.
  const ended = await fetch(
    logout({
      id_token_hint: issued.id_token,
      client_id: clientId,
      post_logout_redirect_uri: `${issuer}/`,
      state: 'done',
    }),
    { headers: { cookie: firstCookie }, redirect: 'manual' },
  );
  expect(ended.status).toBe(302);
  expect(ended.headers.get('location')).toBe(`${issuer}/?state=done`);
  expect(ended.headers.getSetCookie().some((value) => /session_token=;.*Max-Age=0/.test(value))).toBe(true);
  expect(invalidations).toEqual([first, first]);
  expect(await nativeSessions(first)).toBe(0);
  // The old issuer session cannot be silently reused for a new code.
  const again = await fetch(authorize, { headers: { cookie: firstCookie }, redirect: 'manual' });
  expect(again.headers.get('location')?.startsWith('/login?')).toBe(true);
  expect(new URL(again.headers.get('location')!, issuer).searchParams.has('code')).toBe(false);
  expect(await sessionStatus(secondCookie)).toBe(200);
  expect(await nativeSessions(second)).toBe(1);
}, 30000);
