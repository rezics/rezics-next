import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import {
  createAuthHost,
  createAuthService,
  type AccessAccount,
  type AccountWorkflowPorts,
  type AuthService,
  type AuthServiceOptions,
  type PublicJwks,
  type SessionProof,
} from '../src/index.ts';

const clientId = 'rezics-website';
const audience = 'https://api.rezics.test';
const password = 'correct horse battery staple';
const scopes = ['openid', 'offline_access', 'media:create', 'media:read', 'media:complete'];
const person = '00000000-0000-7000-8000-1234000000a1';
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

const unused = async (): Promise<never> => {
  throw new Error('Pages sign-in must not call Access');
};
const access: AccountWorkflowPorts = {
  registrationTarget: () => {
    throw new Error('Pages sign-in must not call Access');
  },
  reserveHandle: unused,
  createPending: unused,
  claimHandle: unused,
  activate: unused,
  expireRegistration: unused,
  releaseExpiredRegistrationHandle: unused,
  provisioningReference: unused,
  provisioningEvidence: unused,
  raiseFence: unused,
  readAccount: unused,
};

beforeAll(async () => {
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
    kid: 'pages-issuer-signing',
    alg: 'ES256',
  };
  clientKey = await generateKeyPair('ES256', { extractable: true });
  publicJwks = {
    keys: [{ ...(await exportJWK(clientKey.publicKey)), kid: 'pages-client-key', alg: 'ES256', use: 'sig' }],
  } as PublicJwks;
  options = {
    database: pool,
    issuer,
    audience,
    secret: 'pages-signin-better-auth-secret-at-least-32-bytes',
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
}, 30000);

function cookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}
async function sessionIds() {
  const rows = await pool.query<{ id: string }>('SELECT id FROM session WHERE "userId"=$1 ORDER BY id', [person]);
  return rows.rows.map((row) => row.id);
}
async function signIn(body: Record<string, unknown>, session = '') {
  return fetch(`${issuer}/signin`, {
    method: 'POST',
    headers: { origin: issuer, 'content-type': 'application/json', cookie: session },
    body: JSON.stringify({ client_id: 'login', scope: [], ...body }),
  });
}
async function readSignInPage(query: string, session = '') {
  return fetch(`${issuer}/signin/page`, {
    method: 'POST',
    headers: { origin: issuer, 'content-type': 'application/json', cookie: session },
    body: JSON.stringify({ query }),
  });
}
function authorizeQuery(extra: Record<string, string> = {}) {
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const fields = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    state,
    nonce: state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: audience,
    ...extra,
  });
  fields.append('unused', '');
  fields.append('unused', '');
  fields.append('empty', '');
  return { verifier, state, fields };
}
async function authorize(fields: URLSearchParams, session = '') {
  const url = new URL(`${issuer}/authorize`);
  url.search = fields.toString();
  const response = await fetch(url, { headers: { cookie: session }, redirect: 'manual' });
  const location = response.headers.get('location') ?? '';
  return { response, location, target: new URL(location || issuer, issuer) };
}

test('host start registers the login client once and leaves an existing login unchanged', async () => {
  const database = testDatabase();
  const started: Array<{ stop: () => Promise<void> }> = [];
  const pools: Pool[] = [];
  try {
    const product = new Pool({ connectionString: database.url });
    const system = new Pool({ connectionString: database.url, max: 8 });
    pools.push(product, system);
    const signingKey = {
      ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
      kid: 'pages-host-signing',
      alg: 'ES256',
    };
    const hostOptions = {
      issuer: 'https://pages-host.auth.test',
      audience: 'https://api.rezics.test',
      secret: 'pages-host-better-auth-secret-at-least-32-bytes',
      signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
      trustedAccess: trustedAccessPorts({
        readAccount: unused,
        readFencedAccount: unused,
        authorizeProvisioning: unused,
      }),
      access,
      stagingKey: randomBytes(32),
      maintenanceSchedule: '0 0 0 1 1 *',
    };
    await createAuthService({ ...hostOptions, database: product });
    expect((await product.query(`SELECT 1 FROM auth_client WHERE client_id='login'`)).rowCount).toBe(0);
    const host = await createAuthHost({
      ...hostOptions,
      database: product,
      systemDatabasePool: system,
      executorId: 'pages-login-1',
    });
    started.push(host);
    expect((await product.query(`SELECT 1 FROM auth_client WHERE client_id='login'`)).rowCount).toBe(0);
    await Promise.all([host.start(), host.start()]);
    expect(
      (
        await product.query<{ first_party: boolean; scopes: string[] }>(
          `SELECT first_party, scopes FROM auth_client WHERE client_id='login'`,
        )
      ).rows,
    ).toEqual([{ first_party: true, scopes: [] }]);
    await host.stop();

    const product2 = new Pool({ connectionString: database.url });
    const system2 = new Pool({ connectionString: database.url, max: 8 });
    pools.push(product2, system2);
    await product2.query(`UPDATE auth_client SET scopes=$1 WHERE client_id='login'`, [['read']]);
    const again = await createAuthHost({
      ...hostOptions,
      database: product2,
      systemDatabasePool: system2,
      executorId: 'pages-login-2',
    });
    started.push(again);
    await again.start();
    expect(
      (
        await product2.query<{ first_party: boolean; scopes: string[] }>(
          `SELECT first_party, scopes FROM auth_client WHERE client_id='login'`,
        )
      ).rows,
    ).toEqual([{ first_party: true, scopes: ['read'] }]);
  } finally {
    for (const host of started) await host.stop().catch(() => {});
    for (const open of pools) await open.end().catch(() => {});
    database.close();
  }
}, 60000);

test('pages sign in with the login client resumes authorization and replaces the presented session', async () => {
  service = await createAuthService(options);
  expect((await pool.query(`SELECT 1 FROM auth_client WHERE client_id='login'`)).rowCount).toBe(0);
  await service.internal.registerWebsiteClient({
    publicJwks,
    redirectUris: [redirectUri],
    postLogoutRedirectUris: [`${issuer}/`],
    scopes,
  });
  await service.internal.registerClient({ clientId: 'login', firstParty: true, scopes: [] });
  const account: AccessAccount = {
    accountId: person,
    kind: 'actor',
    state: 'pending',
    authnEpoch: 1,
    automated: false,
  };
  accounts.set(person, account);
  approvals.add(person);
  await service.internal.provisionPassword({ authorization: person, email: `${person}@example.test`, password });
  account.state = 'active';

  const signedOut = authorizeQuery({ prompt: 'login', max_age: '3600' });
  const anonymous = await authorize(signedOut.fields);
  expect([302, 303]).toContain(anonymous.response.status);
  expect(anonymous.target.pathname).toBe('/login');

  const first = await signIn({ email: `${person}@example.test`, password });
  expect(first.status).toBe(200);
  const firstCookie = cookie(first);
  const page = await readSignInPage(
    'client_id=rezics-website&scope=media%3Aread&prompt=login&sig=old&exp=1',
    firstCookie,
  );
  expect(page.status).toBe(200);
  expect(await page.json()).toEqual({
    methods: { password: true, passkey: true },
    viewer: { kind: 'signed-in', account_id: person, email: `${person}@example.test` },
    continuation: { href: '/authorize?client_id=rezics-website&scope=media%3Aread', requires_sign_in: true },
  });
  const anonymousPage = await readSignInPage('');
  expect((await anonymousPage.json()).viewer).toEqual({ kind: 'signed-out' });
  const enumeratingPage = await fetch(`${issuer}/signin/page`, {
    method: 'POST',
    headers: { origin: issuer, 'content-type': 'application/json' },
    body: JSON.stringify({ query: '', email: `${person}@example.test` }),
  });
  expect(enumeratingPage.status).toBe(400);
  const firstSessions = await sessionIds();
  expect(firstSessions).toHaveLength(1);

  const stepUpQuery = authorizeQuery({ prompt: 'login', max_age: '3600' });
  const stepUp = await authorize(stepUpQuery.fields, firstCookie);
  expect([302, 303]).toContain(stepUp.response.status);
  expect(stepUp.target.pathname).toBe('/step-up');
  expect(stepUp.target.searchParams.get('max_age')).toBe('3600');
  expect(stepUp.target.searchParams.get('prompt')).toContain('login');
  expect(stepUp.target.searchParams.has('sig')).toBe(true);
  expect(stepUp.target.searchParams.has('exp')).toBe(true);

  const aged = Math.floor(Date.now() / 1000) - 10000;
  await pool.query('UPDATE session SET "authTime"=$1 WHERE id=$2', [aged, firstSessions[0]]);
  const replaced = await signIn({ email: `${person}@example.test`, password }, firstCookie);
  expect(replaced.status).toBe(200);
  const replacedProof = (await replaced.json()) as SessionProof;
  expect(replacedProof.auth_time).toBeGreaterThan(aged);
  expect(replacedProof.amr).toEqual(['pwd']);
  const replacedCookie = cookie(replaced);
  const retiredPage = await readSignInPage('', firstCookie);
  expect(retiredPage.status).toBe(200);
  expect((await retiredPage.json()).viewer).toEqual({ kind: 'signed-out' });
  expect((await readSignInPage('', replacedCookie)).status).toBe(200);
  const replacedSessions = await sessionIds();
  expect(replacedSessions).toEqual([expect.any(String)]);
  expect(replacedSessions).not.toContain(firstSessions[0]);

  const resume = new URLSearchParams(stepUp.target.search);
  resume.delete('sig');
  resume.delete('exp');
  resume.delete('prompt');
  expect(resume.get('max_age')).toBe('3600');
  resume.append('unused', '');
  resume.append('unused', '');
  resume.append('empty', '');
  const resumed = await authorize(resume, replacedCookie);
  expect([302, 303]).toContain(resumed.response.status);
  expect(`${resumed.target.origin}${resumed.target.pathname}`).toBe(redirectUri);
  expect(resumed.target.searchParams.get('state')).toBe(stepUpQuery.state);
  const code = resumed.target.searchParams.get('code');
  expect(code).toBeTruthy();

  const now = Math.floor(Date.now() / 1000);
  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: 'pages-client-key' })
    .setIssuer(clientId)
    .setSubject(clientId)
    .setAudience(issuer)
    .setIssuedAt(now)
    .setExpirationTime(now + 120)
    .setJti(randomBytes(24).toString('base64url'))
    .sign(clientKey.privateKey);
  const exchange = await fetch(`${issuer}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      redirect_uri: redirectUri,
      code_verifier: stepUpQuery.verifier,
      client_id: clientId,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
      resource: audience,
    }),
  });
  expect(exchange.status).toBe(200);
  const issued = (await exchange.json()) as { id_token: string };
  const keys = createLocalJWKSet(await (await fetch(`${issuer}/.well-known/jwks.json`)).json());
  const id = await jwtVerify(issued.id_token, keys, { issuer, audience: clientId, algorithms: ['ES256'] });
  expect(id.payload.amr).toEqual(['pwd']);
  expect(Math.abs(Number(id.payload.auth_time) - replacedProof.auth_time)).toBeLessThanOrEqual(1);
  expect(Number(id.payload.auth_time)).toBeGreaterThan(aged);

  const staleAuthTime = Math.floor(Date.now() / 1000) - 120;
  await pool.query('UPDATE session SET "authTime"=$1 WHERE id=$2', [staleAuthTime, replacedSessions[0]]);
  const stale = await authorize(authorizeQuery({ max_age: '60' }).fields, replacedCookie);
  expect([302, 303]).toContain(stale.response.status);
  expect(stale.target.pathname).toBe('/step-up');
  expect(stale.target.searchParams.get('max_age')).toBe('60');
  expect(stale.target.searchParams.has('prompt')).toBe(true);

  const byAccount = await signIn({ account_id: person, password }, replacedCookie);
  expect(byAccount.status).toBe(200);
  const accountSessions = await sessionIds();
  expect(accountSessions).toHaveLength(1);
  expect(accountSessions).not.toContain(replacedSessions[0]);
  const accountCookie = cookie(byAccount);

  const rejected = await signIn(
    { email: `${person}@example.test`, password: 'wrong horse battery staple' },
    accountCookie,
  );
  expect(rejected.status).toBeGreaterThanOrEqual(400);
  expect(await sessionIds()).toEqual(accountSessions);

  const ignored = await signIn({ email: `${person}@example.test`, password }, 'session_token=missing');
  expect(ignored.status).toBe(200);
  const kept = await sessionIds();
  const [previous] = accountSessions;
  if (!previous) throw new Error('Expected the replacement session');
  expect(kept).toContain(previous);
  expect(kept).toHaveLength(2);

  const repeated = authorizeQuery();
  repeated.fields.append('client_id', clientId);
  const denied = await authorize(repeated.fields, accountCookie);
  expect(denied.response.status).toBe(400);
  expect(id.payload.sub).toBe(person);
}, 30000);
