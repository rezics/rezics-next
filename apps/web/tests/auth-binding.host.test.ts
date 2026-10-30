import { readSessionToken } from './session-token';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { Pool } from 'pg';
import { createAuthService, type AccessAccount, type AuthService } from '../../../services/auth/src/index.ts';
import { testDatabase } from '../../../services/auth/scripts/database.ts';
import { startDevServer } from './support/dev-server.ts';

const app = join(import.meta.dir, '..');
const timeout = 360_000;
const clientId = 'rezics-website';
const resource = 'https://api.rezics.test';
const mediaScopes = ['media:create', 'media:read_reservation', 'media:read', 'media:complete', 'media:erase'];
const scopes = ['openid', 'offline_access', ...mediaScopes];
const password = 'correct horse battery staple';
const sessionName = '__Host-rezics_session';
const loginName = '__Host-rezics_login';
const people = ['00000000-0000-7000-8000-123400000091', '00000000-0000-7000-8000-123400000092'];
const accounts = new Map<string, AccessAccount>();
const approvals = new Set<string>();
const authCookies = new Map<string, string>();
const clientKey = await generateKeyPair('ES256', { extractable: true });
const privateJwk = { ...(await exportJWK(clientKey.privateKey)), kid: 'website-binding', alg: 'ES256', use: 'sig' };
type Tokens = { access_token: string; refresh_token: string; id_token: string; expires_in: number };
const grants: { form: URLSearchParams; tokens: Tokens }[] = [];
const revocations: { form: URLSearchParams; status: number }[] = [];
const kernelCalls = new Map<string, { token: string | null; subject?: string }>();
let fixture: ReturnType<typeof testDatabase> | undefined;
let pool: Pool | undefined;
let auth: ReturnType<typeof Bun.serve> | undefined;
let kernel: ReturnType<typeof Bun.serve> | undefined;
let service: AuthService;
let issuer: string;
let site: string;
let devServer: Awaited<ReturnType<typeof startDevServer>> | undefined;
let keys: ReturnType<typeof createLocalJWKSet>;
let webState: string | undefined;
let privateDirectory: string | undefined;

beforeAll(async () => {
  fixture = testDatabase();
  pool = new Pool({ connectionString: fixture.url });
  // Observe real handler traffic without replacing any issuer behavior or response.
  auth = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const form =
        request.method === 'POST' && ['/token', '/revoke'].includes(path)
          ? new URLSearchParams(await request.clone().text())
          : undefined;
      const response = await service.handler(request);
      if (form && path === '/token' && response.ok) grants.push({ form, tokens: await response.clone().json() });
      if (form && path === '/revoke') revocations.push({ form, status: response.status });
      return response;
    },
  });
  issuer = `http://127.0.0.1:${auth.port}`;
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'binding-issuer',
    alg: 'ES256',
  };
  service = await createAuthService({
    database: pool,
    issuer,
    audience: resource,
    secret: 'isolated-real-auth-binding-secret-at-least-32-bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: {
      async readAccount(accountId) {
        return accounts.get(accountId) ?? null;
      },
      async authorizeProvisioning(accountId) {
        if (!approvals.delete(accountId)) throw new Error('Missing trusted provisioning approval');
        return { accountId };
      },
      // Access boundary evidence, matching Auth's own logout fixture.
      async invalidateAccount({ accountId, previousEpoch }) {
        const account = accounts.get(accountId)!;
        account.authnEpoch = Math.max(account.authnEpoch, previousEpoch) + 1;
        return { accountId, minimumAuthnEpoch: account.authnEpoch, receiptId: randomUUID() };
      },
    },
  });
  privateDirectory = await mkdtemp(join(tmpdir(), 'web-auth-binding-'));
  webState = join(privateDirectory, 'state');
  await mkdir(webState);
  const viteCache = join(privateDirectory, 'vite-cache');
  await mkdir(viteCache);
  const viteConfig = join(privateDirectory, 'vite.config.ts');
  await writeFile(
    viteConfig,
    `import config from ${JSON.stringify(pathToFileURL(join(app, 'vite.config.ts')).href)};\n` +
      `export default { ...config, cacheDir: ${JSON.stringify(viteCache)} };\n`,
  );
  await service.internal.registerClient({ clientId: 'login', firstParty: true, scopes: ['media:read'] });
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
    const response = await fetch(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email: `${accountId}@example.test`, password, client_id: 'login', scope: ['media:read'] }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .map((line) => line.split(';')[0])
      .join('; ');
    expect(cookie).toContain('session_token=');
    authCookies.set(accountId, cookie);
  }
  const jwks = await fetch(`${issuer}/.well-known/jwks.json`);
  expect(jwks.status).toBe(200);
  keys = createLocalJWKSet(await jwks.json());
  kernel = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const authorization = request.headers.get('authorization');
      const token = authorization?.replace(/^Bearer /, '') ?? null;
      const payload = token
        ? (await jwtVerify(token, keys, { issuer, audience: resource, algorithms: ['ES256'], typ: 'at+jwt' })).payload
        : undefined;
      if (payload) {
        expect(payload.client_id).toBe(clientId);
        expect(payload.aud).toBe(resource);
        for (const scope of mediaScopes) expect(String(payload.scope).split(' ')).toContain(scope);
      }
      kernelCalls.set(new URL(request.url).pathname, { token, subject: payload?.sub });
      return Response.json({ code: 'not_found' }, { status: 404 });
    },
  });
  devServer = await startDevServer({
    cwd: app,
    warmUpPaths: [],
    budgets: { ready: 120_000, firstResponse: 30_000, warmUp: 0 },
    command: ({ port, origin }) => [
      'env',
      `SITE_ORIGINS=${origin}`,
      'bun',
      'run',
      'dev',
      '--config',
      viteConfig,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    env: {
      PUBLIC_ORIGIN: 'https://rezics.com',
      WEB_TEST_STATE_DIR: webState,
      KERNEL_ORIGIN: kernel.url.origin,
      AUTH_ISSUER: issuer,
      WEBSITE_CLIENT_ID: clientId,
      WEBSITE_CLIENT_KEY: JSON.stringify(privateJwk),
      API_RESOURCE: resource,
      WEBSITE_SCOPES: scopes.join(' '),
    },
  });
  site = devServer.origin;
  await service.internal.registerWebsiteClient({
    publicJwks: {
      keys: [{ ...(await exportJWK(clientKey.publicKey)), kid: privateJwk.kid, alg: 'ES256', use: 'sig' }],
    } as Parameters<AuthService['internal']['registerWebsiteClient']>[0]['publicJwks'],
    redirectUris: [`${site}/auth/callback`],
    postLogoutRedirectUris: [`${site}/`],
    scopes,
  });
}, timeout);

afterAll(async () => {
  await devServer?.stop();
  await kernel?.stop(true);
  await auth?.stop(true);
  await pool?.end();
  fixture?.close();
  if (privateDirectory) await rm(privateDirectory, { recursive: true, force: true });
});

function cookie(response: Response, name: string) {
  const line = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  expect(line).toBeDefined();
  expect(line!).toMatch(/;\s*HttpOnly\b/i);
  expect(line!).toMatch(/;\s*Secure\b/i);
  expect(line!).toMatch(/;\s*SameSite=Lax\b/i);
  expect(line!).toMatch(/;\s*Path=\/(;|$)/i);
  expect(line!).not.toMatch(/;\s*Domain=/i);
  return line!.split(';')[0]!;
}

async function signIn(accountId: string) {
  const start = await fetch(`${site}/auth/sign-in?return_to=/ja`, { redirect: 'manual' });
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.get('location')!);
  expect(`${authorize.origin}${authorize.pathname}`).toBe(`${issuer}/authorize`);
  expect(authorize.searchParams.get('redirect_uri')).toBe(`${site}/auth/callback`);
  expect(authorize.searchParams.get('resource')).toBe(resource);
  expect(authorize.searchParams.get('scope')!.split(' ').sort()).toEqual([...scopes].sort());
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  const authorization = await fetch(authorize, {
    redirect: 'manual',
    headers: { cookie: authCookies.get(accountId)! },
  });
  expect([302, 303]).toContain(authorization.status);
  const callback = new URL(authorization.headers.get('location')!);
  expect(`${callback.origin}${callback.pathname}`).toBe(`${site}/auth/callback`);
  expect(callback.searchParams.get('code')).toBeTruthy();
  expect(callback.searchParams.get('state')).toBe(authorize.searchParams.get('state'));
  expect(callback.searchParams.has('access_token')).toBe(false);
  const before = grants.length;
  const response = await fetch(callback, { redirect: 'manual', headers: { cookie: cookie(start, loginName) } });
  expect(response.status).toBe(303);
  expect(response.headers.get('location')).toBe('/ja');
  expect(grants.length).toBe(before + 1);
  const grant = grants.at(-1)!;
  expect(grant.form.get('grant_type')).toBe('authorization_code');
  expect(grant.form.get('resource')).toBe(resource);
  const session = cookie(response, sessionName);
  expect(session.slice(sessionName.length + 1)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const page = await fetch(`${site}/en`, { headers: { cookie: session } });
  expect(page.status).toBe(200);
  const csrfToken = await readSessionToken(site, session);
  expect(csrfToken).toBeDefined();
  const visible = `${start.headers.getSetCookie()}\n${callback}\n${response.headers.getSetCookie()}\n${await response.text()}`;
  for (const token of [grant.tokens.access_token, grant.tokens.refresh_token, grant.tokens.id_token]) {
    expect(token).toBeTruthy();
    expect(visible).not.toContain(token);
  }
  return { session, csrfToken: csrfToken!, authorize, tokens: grant.tokens };
}

async function credential(session?: string) {
  const id = randomUUID();
  await fetch(`${site}/media/${id}/original`, { redirect: 'manual', headers: session ? { cookie: session } : {} });
  const call = kernelCalls.get(`/v1/media/${id}:authorizeDownload`);
  expect(call).toBeDefined();
  return call!;
}

test(
  "the site Worker signs people in through Auth's real authorization code flow and keeps their tokens on the server",
  async () => {
    for (const accountId of people) {
      const signed = await signIn(accountId);
      expect(await credential(signed.session)).toEqual({ token: signed.tokens.access_token, subject: accountId });
    }
    expect((await credential()).token).toBeNull();
  },
  timeout,
);

test(
  "the token the Worker sends the kernel is Auth's API token for that person, the website client and the API resource",
  async () => {
    const observed = [];
    for (const accountId of people) {
      const signed = await signIn(accountId);
      const call = await credential(signed.session);
      expect(call.subject).toBe(accountId);
      expect(call.token).toBe(signed.tokens.access_token);
      observed.push(call);
    }
    expect(observed[0]!.subject).not.toBe(observed[1]!.subject);
    expect(observed[0]!.token).not.toBe(observed[1]!.token);
  },
  timeout,
);

test(
  'a refresh through Auth rotates the tokens and keeps the person',
  async () => {
    const signed = await signIn(people[0]!);
    expect((await credential(signed.session)).token).toBe(signed.tokens.access_token);
    // Auth exposes no lifetime option. Wait for the Worker's refresh threshold,
    // keeping the real five-minute token lifetime and the host's clock intact.
    await Bun.sleep(Math.max(0, (signed.tokens.expires_in - 60) * 1000) + 1_100);
    const before = grants.length;
    const refreshed = await credential(signed.session);
    expect(grants.length).toBe(before + 1);
    const rotation = grants.at(-1)!;
    expect(rotation.form.get('grant_type')).toBe('refresh_token');
    expect(rotation.form.get('resource')).toBe(resource);
    expect(rotation.form.get('refresh_token')).toBe(signed.tokens.refresh_token);
    expect(rotation.tokens.refresh_token).not.toBe(signed.tokens.refresh_token);
    expect(refreshed.token).toBe(rotation.tokens.access_token);
    expect(refreshed.token).not.toBe(signed.tokens.access_token);
    expect(refreshed.subject).toBe(people[0]!);
  },
  timeout,
);

test(
  'signing out revokes the refresh token at Auth and ends the Auth session',
  async () => {
    const accountId = people[0]!;
    const signed = await signIn(accountId);
    const response = await fetch(`${site}/auth/sign-out`, {
      method: 'POST',
      redirect: 'manual',
      headers: { cookie: signed.session, origin: site, 'X-CSRF-Token': signed.csrfToken },
    });
    expect(response.status).toBe(303);
    expect(cookie(response, sessionName)).toBe(`${sessionName}=`);
    expect(response.headers.getSetCookie().join(';')).toMatch(/Max-Age=0/i);
    const revoke = revocations.at(-1)!;
    expect(revoke.form.get('token')).toBe(signed.tokens.refresh_token);
    expect(revoke.status).toBe(200);
    expect((await credential(signed.session)).token).toBeNull();
    const logout = new URL(response.headers.get('location')!);
    expect(`${logout.origin}${logout.pathname}`).toBe(`${issuer}/logout`);
    expect(logout.searchParams.get('post_logout_redirect_uri')).toBe(`${site}/`);
    const ended = await fetch(logout, { redirect: 'manual', headers: { cookie: authCookies.get(accountId)! } });
    expect(ended.status).toBe(302);
    expect(ended.headers.get('location')).toBe(`${site}/`);
    expect(ended.headers.getSetCookie().some((line) => /session_token=;.*Max-Age=0/.test(line))).toBe(true);
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: privateJwk.kid })
      .setIssuer(clientId)
      .setSubject(clientId)
      .setAudience(issuer)
      .setIssuedAt(now)
      .setExpirationTime(now + 120)
      .setJti(randomUUID())
      .sign(clientKey.privateKey);
    const refused = await fetch(`${issuer}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
        grant_type: 'refresh_token',
        refresh_token: signed.tokens.refresh_token,
        resource,
      }),
    });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe('invalid_grant');
    const again = await fetch(signed.authorize, {
      redirect: 'manual',
      headers: { cookie: authCookies.get(accountId)! },
    });
    expect(again.status).toBe(302);
    const location = new URL(again.headers.get('location')!, issuer);
    expect(location.pathname).toBe('/login');
    expect(location.searchParams.has('code')).toBe(false);
  },
  timeout,
);
