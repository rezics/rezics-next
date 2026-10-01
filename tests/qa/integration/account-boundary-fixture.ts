import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { expect } from 'bun:test';
import { getMigrations } from 'better-auth/db/migration';
import { Client, Pool, type PoolConfig } from 'pg';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { accountAuthOptions, createAccountAuth } from '../../../services/account/src/auth.ts';
import { installConsentRefreshFence } from '../../../services/account/src/consent-fence.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccessActingContexts } from '../../../services/main/src/modules/access/contexts.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';

export const CALLBACK = 'http://localhost:3000/auth/callback';

export async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

export function qaEnvironment() {
  const env = Bun.env;
  if (!env.REZICS_QA_RUN_ID || !env.FUSEKI_URL || !env.MAIN_DATA_EPOCH || !env.MAIN_ROUTING_EPOCH
    || !env.MAIN_OBJECT_DIRECTORY || !env.ACCOUNT_SECRET || !env.ACCOUNT_MAIN_RESOURCE
    || !env.ACCESS_DATABASE_URL) {
    throw new Error('Run through an isolated QA tier');
  }
  return { runId: env.REZICS_QA_RUN_ID, fusekiUrl: env.FUSEKI_URL, dataEpoch: env.MAIN_DATA_EPOCH,
    routingEpoch: env.MAIN_ROUTING_EPOCH, objectDirectory: env.MAIN_OBJECT_DIRECTORY,
    secret: env.ACCOUNT_SECRET, resource: env.ACCOUNT_MAIN_RESOURCE,
    accessDatabaseUrl: env.ACCESS_DATABASE_URL };
}

export type Member = { id: string; email: string; password: string; cookie: string };
export type Tokens = { access_token: string; refresh_token?: string };

/** Real Account HTTP on a cloned owner database. `publicOrigin` is the issuer
 * origin clients and Main use; it may be a network hop in front of `port`. */
export async function startAccount(input: { pool: PoolConfig; secret: string; resource: string;
  port?: number; publicOrigin?: string; codeGuardConnections?: number }) {
  const pool = new Pool(input.pool);
  const port = input.port ?? await freePort();
  const local = `http://127.0.0.1:${port}`;
  const base = input.publicOrigin ?? local;
  const operators = new Set<string>();
  const config = { baseURL: base, secret: input.secret, resource: input.resource, pool,
    operatorUserIds: operators };
  const migration = await getMigrations(accountAuthOptions(config));
  expect(migration.unsafeChanges).toEqual([]);
  expect(migration.schemaProblems).toEqual([]);
  await migration.runMigrations();
  await installConsentRefreshFence(pool);
  const auth = createAccountAuth(config);
  const app = createAccountApp(auth, pool, { operatorUserIds: operators,
    ...(input.codeGuardConnections ? { codeGuardConnections: input.codeGuardConnections } : {}) })
    .listen({ hostname: '127.0.0.1', port });
  const post = (path: string, body: unknown, cookie?: string, via = local) =>
    fetch(`${via}${path}`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/json', origin: base, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body) });
  const form = (path: string, body: Record<string, string>, via = local) =>
    fetch(`${via}${path}`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body) });
  const signUp = async (name: string): Promise<Member> => {
    const email = `${name}-${randomUUID()}@example.test`;
    const password = randomBytes(24).toString('base64url');
    const response = await post('/api/auth/sign-up/email', { ...signupPolicyFixture, name, email, password });
    expect(response.status).toBe(200);
    return { id: (await response.json() as { user: { id: string } }).user.id, email, password,
      cookie: response.headers.get('set-cookie')! };
  };
  const operator = await signUp('operator');
  operators.add(operator.id);
  const adminHeaders = new Headers({ cookie: operator.cookie, origin: base });
  const registerClient = (body: NonNullable<Parameters<typeof auth.api.adminCreateOAuthClient>[0]>['body']) =>
    auth.api.adminCreateOAuthClient({ headers: adminHeaders, body });
  const nativeApp = (name: string, scope: string, trusted = false) => registerClient({
    client_name: name, application_type: 'native', redirect_uris: [CALLBACK],
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code'], scope,
    subject_type: 'public', require_pkce: true, ...(trusted ? { skip_consent: true } : {}) });
  const workloadApp = (name: string, scopes: string[]) => registerClient({
    client_name: name, scope: scopes.join(' '), token_endpoint_auth_method: 'client_secret_post',
    grant_types: ['client_credentials'], client_credentials_scopes: scopes });
  /** Authorization code with PKCE; explicit consent when the App is not trusted. */
  const authorize = async (clientId: string, member: Member, scope: string,
    consent = true): Promise<{ code: string; verifier: string } | Response> => {
    const verifier = randomBytes(32).toString('base64url');
    const url = new URL(`${local}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: clientId,
      redirect_uri: CALLBACK, scope, state: randomUUID(), resource: input.resource,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256', ...(consent ? { prompt: 'consent' } : {}) })) {
      url.searchParams.set(key, value);
    }
    const prompt = await fetch(url, { headers: { cookie: member.cookie }, redirect: 'manual' });
    if (prompt.status !== 302) return prompt;
    const target = new URL(prompt.headers.get('location')!, base);
    if (target.pathname === '/consent') {
      const accepted = await post('/api/auth/oauth2/consent',
        { accept: true, oauth_query: target.searchParams.toString() }, member.cookie);
      expect(accepted.status).toBe(200);
      const destination = await accepted.json() as { url: string };
      return { code: new URL(destination.url).searchParams.get('code')!, verifier };
    }
    return { code: target.searchParams.get('code')!, verifier };
  };
  const exchange = (clientId: string, pending: { code: string; verifier: string }) =>
    form('/api/auth/oauth2/token', { grant_type: 'authorization_code', client_id: clientId,
      code: pending.code, redirect_uri: CALLBACK, code_verifier: pending.verifier,
      resource: input.resource });
  const issue = async (clientId: string, member: Member, scope: string, consent = true) => {
    const pending = await authorize(clientId, member, scope, consent);
    if (pending instanceof Response) throw new Error(`authorize failed: ${pending.status}`);
    const response = await exchange(clientId, pending);
    const text = await response.text();
    expect(response.status, text).toBe(200);
    return JSON.parse(text) as Tokens;
  };
  const refresh = (clientId: string, token: string, scope?: string) =>
    form('/api/auth/oauth2/token', { grant_type: 'refresh_token', client_id: clientId,
      refresh_token: token, resource: input.resource, ...(scope ? { scope } : {}) });
  const clientCredentials = (client: { client_id: string; client_secret?: string },
    scope: string) => form('/api/auth/oauth2/token', { grant_type: 'client_credentials',
    client_id: client.client_id, client_secret: client.client_secret!, scope,
    resource: input.resource });
  let stopped = false;
  return { auth, app, pool, base, local, port, issuer: `${base}/api/auth`, operator, operators,
    adminHeaders, signUp, post, form, nativeApp, workloadApp, authorize, exchange, issue, refresh,
    clientCredentials,
    verifierConfig: (client: { client_id: string; client_secret?: string }, via = base) => ({
      issuer: `${base}/api/auth`, audience: input.resource, jwksUrl: `${via}/api/auth/jwks`,
      introspectUrl: `${via}/api/auth/oauth2/introspect`, clientId: client.client_id,
      clientSecret: client.client_secret! }),
    introspect: async (client: { client_id: string; client_secret?: string }, token: string) => {
      const response = await form('/api/auth/oauth2/introspect', { token,
        client_id: client.client_id, client_secret: client.client_secret! });
      expect(response.status).toBe(200);
      return response.json() as Promise<Record<string, unknown>>;
    },
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await app.stop(true);
      await pool.end();
    } };
}
export type AccountOwner = Awaited<ReturnType<typeof startAccount>>;

/** Access principal P for the Account subject, representing each Agent for
 * `work.create`, and each Agent holding its own root `work.create` grant. */
export async function representAgents(accessPool: Pool, issuer: string, subject: string,
  count: number): Promise<{ principalId: string; agents: string[]; representations: string[] }> {
  const principalId = randomUUID();
  const agents = Array.from({ length: count }, () => `https://rezics.com/id/${randomUUID()}`);
  const representations = agents.map(() => randomUUID());
  await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
    VALUES ($1,$2,$3)`, [principalId, issuer, subject]);
  await accessPool.query("INSERT INTO access.scope_gate (id) VALUES ('work:create:root') ON CONFLICT DO NOTHING");
  for (const [index, agent] of agents.entries()) {
    await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1,'agent')", [agent]);
    await accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
      VALUES ($1,$2,$3,'work.create',now() + interval '1 hour')`, [representations[index], principalId, agent]);
    await accessPool.query(`INSERT INTO access.permission_grant
        (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
      VALUES ($1,$2,$2,'work:create:root','work.create',now() + interval '1 hour')`, [randomUUID(), agent]);
  }
  return { principalId, agents, representations };
}

/** Main's protected acting-context boundary over real Access and Account HTTP. */
export function mainWithAccount(env: ReturnType<typeof qaEnvironment>, accessPool: Pool,
  verifier: AccountAssertionVerifier) {
  const fuseki = new FusekiClient(env.fusekiUrl);
  const main = createMainApp(fuseki, {
    environment: { fuseki, lineage: { dataEpoch: env.dataEpoch, routingEpoch: env.routingEpoch },
      objectDirectory: env.objectDirectory },
    account: verifier, access: new AccessAdmissionRegistry(accessPool),
    actingContexts: new AccessActingContexts(accessPool),
  });
  const discover = async (token: string) => {
    const response = await main.handle(new Request('http://main.local/v1/me/acting-contexts?task=work.create',
      { headers: { authorization: `Bearer ${token}` } }));
    return { status: response.status, body: await response.json() as {
      authorityEpoch: string; contexts: Array<{ actingSubject: string; displayName: string | null;
        handle: string | null; kind: 'person' | 'pen-name' | 'organization' | 'service' | null }>; code?: string } };
  };
  const check = async (token: string, actingSubject: string, expectedAuthorityEpoch: string) => {
    const response = await main.handle(new Request('http://main.local/v1/me/acting-context-checks', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ profile: 'work-create-acting-context-check-v1', task: 'work.create',
        actingSubject, expectedAuthorityEpoch }) }));
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  return { main, discover, check };
}

/** Test-only counter of statements sent to one database through node-postgres,
 * which both Better Auth's Kysely adapter and Account's own queries use. */
export function countStatements(database: string) {
  const counts = { calls: 0 };
  const original = Client.prototype.query;
  Client.prototype.query = function (this: Client, ...args: unknown[]) {
    if (this.database === database) counts.calls++;
    return (original as (...values: unknown[]) => unknown).apply(this, args);
  } as typeof Client.prototype.query;
  return { counts, restore: () => { Client.prototype.query = original; } };
}

export function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

export function decodePayload(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'));
}

export function decodeHeader(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString('utf8'));
}
