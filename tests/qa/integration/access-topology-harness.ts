import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { expect } from 'bun:test';
import { Pool } from 'pg';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccessActingContexts } from '../../../services/main/src/modules/access/contexts.ts';
import { AccessGrants } from '../../../services/main/src/modules/access/grants.ts';
import { AccessGroups } from '../../../services/main/src/modules/access/groups.ts';
import { AccessRepresentations } from '../../../services/main/src/modules/access/representations.ts';
import { AccessRoles } from '../../../services/main/src/modules/access/roles.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { cloneQaAccountAccessDatabases } from '../support/databases.ts';

const root = resolve(import.meta.dir, '../../..');
const scopes = 'openid access:manage access:approve access:grant access:represent '
  + 'access:representation-manage access:role work:create';

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no Account test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

export interface AuthorityUser { name: string; accountId: string; principalId: string; token: string }
export type AuthorityHarness = Awaited<ReturnType<typeof startAuthorityHarness>>;

/** Real Account OAuth, Main routes and cloned Account/Access owners for the
 * G-047 authority-control API tests. Authority facts outside the tested
 * operation are seeded directly as owner rows, as the other Access fixtures do. */
export async function startAuthorityHarness(label: string) {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH
    || !Bun.env.MAIN_ROUTING_EPOCH || !Bun.env.ACCOUNT_MAIN_RESOURCE) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const state = join(root, '.temp', `${label}-${randomUUID()}`);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const databases = await cloneQaAccountAccessDatabases(Bun.env.REZICS_QA_RUN_ID);
  const accountPool = new Pool({ connectionString: databases.urls.account });
  const accessPool = new Pool({ connectionString: databases.urls.access, max: 8 });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const operators = new Set<string>();
  const auth = createAccountAuth({ baseURL: base, secret: Bun.env.ACCOUNT_SECRET!,
    resource: Bun.env.ACCOUNT_MAIN_RESOURCE, pool: accountPool, operatorUserIds: operators });
  const account = createAccountApp(auth, accountPool).listen({ hostname: '127.0.0.1', port });
  const signUp = async (name: string) => {
    const email = `${label}-${randomUUID()}@example.test`;
    const password = randomBytes(24).toString('base64url');
    const response = await account.handle(new Request(`${base}/api/auth/sign-up/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ name, email, password }) }));
    expect(response.status).toBe(200);
    const body = await response.json() as { user: { id: string } };
    return { id: body.user.id, email, password, cookie: response.headers.get('set-cookie')! };
  };
  const operator = await signUp('operator');
  operators.add(operator.id);
  const headers = new Headers({ cookie: operator.cookie, origin: base });
  const verifierClient = await auth.api.adminCreateOAuthClient({ headers, body: {
    client_name: `${label} verifier`, scope: 'access:grant',
    token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
    client_credentials_scopes: ['access:grant'] } });
  const redirectUri = 'http://localhost:3000/auth/callback';
  const client = await auth.api.adminCreateOAuthClient({ headers, body: {
    client_name: `${label} native client`, application_type: 'native',
    redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'], scope: scopes, skip_consent: true, require_pkce: true } });
  const tokenFor = async (user: { email: string; password: string }, scope: string) => {
    const signIn = await fetch(`${base}/api/auth/sign-in/email`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: user.email, password: user.password }) });
    expect(signIn.status).toBe(200);
    const verifier = randomBytes(32).toString('base64url');
    const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({ response_type: 'code',
      client_id: client.client_id, redirect_uri: redirectUri, scope, state: randomUUID(),
      resource: Bun.env.ACCOUNT_MAIN_RESOURCE!,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256' })) authorize.searchParams.set(key, value);
    const authorized = await fetch(authorize, {
      headers: { cookie: signIn.headers.get('set-cookie')! }, redirect: 'manual' });
    expect(authorized.status).toBe(302);
    const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
    const exchange = await fetch(`${base}/api/auth/oauth2/token`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id,
        code, redirect_uri: redirectUri, code_verifier: verifier,
        resource: Bun.env.ACCOUNT_MAIN_RESOURCE! }) });
    expect(exchange.status).toBe(200);
    return (await exchange.json() as { access_token: string }).access_token;
  };
  const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
  const grants = new AccessGrants(accessPool);
  const main = createMainApp(fuseki, { environment: { fuseki,
    lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
    objectDirectory: join(state, 'objects') },
  account: new AccountAssertionVerifier({ issuer: `${base}/api/auth`,
    audience: Bun.env.ACCOUNT_MAIN_RESOURCE, jwksUrl: `${base}/api/auth/jwks`,
    introspectUrl: `${base}/api/auth/oauth2/introspect`,
    clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! }),
  access: new AccessAdmissionRegistry(accessPool), actingContexts: new AccessActingContexts(accessPool),
  grants, groups: new AccessGroups(accessPool), roles: new AccessRoles(accessPool),
  representations: new AccessRepresentations(accessPool) });
  await accessPool.query(`INSERT INTO access.scope_gate (id) VALUES ('work:create:root')
    ON CONFLICT DO NOTHING`);

  const harness = {
    accessPool, grants,
    async user(name: string, scope = scopes, admitted = true): Promise<AuthorityUser> {
      const account = await signUp(name);
      const principalId = randomUUID();
      if (admitted) {
        await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
          VALUES ($1,$2,$3)`, [principalId, `${base}/api/auth`, account.id]);
      }
      return { name, accountId: account.id, principalId, token: await tokenFor(account, scope) };
    },
    async principalOf(user: AuthorityUser): Promise<string> {
      return (await accessPool.query<{ id: string }>(`SELECT id FROM access.principal
        WHERE account_issuer = $1 AND account_subject = $2`,
      [`${base}/api/auth`, user.accountId])).rows[0]!.id;
    },
    async agent(): Promise<string> {
      const id = `https://rezics.com/id/${randomUUID()}`;
      await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')", [id]);
      return id;
    },
    async mandate(principalId: string, subject: string, action: string,
      options: { maxPathEdges?: number; until?: string } = {}): Promise<string> {
      const id = randomUUID();
      await accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id,
        action, valid_until, max_path_edges) VALUES ($1,$2,$3,$4,
          CASE WHEN $5 = 'infinity' THEN 'infinity'::timestamptz ELSE now() + $5::interval END, $6)`,
      [id, principalId, subject, action, options.until ?? '2 hours', options.maxPathEdges ?? 0]);
      return id;
    },
    async grant(issuer: string, recipient: string, action: string, until = '2 hours'): Promise<string> {
      const id = randomUUID();
      await accessPool.query(`INSERT INTO access.permission_grant (id, issuer_subject,
        recipient_subject, scope_id, action, valid_until)
        VALUES ($1,$2,$3,'work:create:root',$4, now() + $5::interval)`,
      [id, issuer, recipient, action, until]);
      return id;
    },
    async epoch(scope = 'work:create:root'): Promise<string> {
      return (await accessPool.query<{ authority_epoch: string }>(
        'SELECT authority_epoch FROM access.scope_gate WHERE id = $1', [scope])).rows[0]!.authority_epoch;
    },
    request(method: string, path: string, token: string, body?: object,
      key = `${label}-${randomUUID()}`): Promise<Response> {
      return main.handle(new Request(`http://main.local${path}`, { method,
        headers: { authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) }));
    },
    /** Sends a request and returns status plus JSON body. */
    async call<T = Record<string, unknown>>(method: string, path: string, token: string,
      body?: object, key?: string): Promise<{ status: number; body: T }> {
      const response = await harness.request(method, path, token, body, key);
      return { status: response.status, body: await response.json() as T };
    },
    async close(): Promise<void> {
      await account.stop();
      await Promise.all([accountPool.end(), accessPool.end()]);
      await databases.close();
      rmSync(state, { recursive: true, force: true });
    },
  };
  return harness;
}
