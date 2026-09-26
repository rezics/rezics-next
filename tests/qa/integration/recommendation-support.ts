import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { expect } from 'bun:test';
import { Client, Pool, type PoolClient } from 'pg';
import { readEnv } from '../../../scripts/dev/config.ts';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';

// Shared fixtures for the G-058 ranking and graph-layout API tests: isolated
// owner clones, a real Account issuer, retained relay envelopes and SQL meters.

const root = resolve(import.meta.dir, '../../..');
type Owner = 'access' | 'relay' | 'content';

export function requireQa(): string {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId) || !Bun.env.ACCOUNT_DATABASE_URL
    || !Bun.env.ACCOUNT_MAIN_RESOURCE || !Bun.env.FUSEKI_URL || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  return runId;
}

/** Clone migrated owner templates so this file never writes shared QA owners. */
export async function cloneOwners(runId: string, owners: Owner[]): Promise<{
  urls: Record<Owner, string>; close: () => Promise<void>;
}> {
  const stack = join(root, '.temp', 'stack', `rezics-qa-${runId}`);
  const compose = readEnv(join(stack, 'compose.env'));
  const adminUrl = `postgres://postgres:${encodeURIComponent(compose.POSTGRES_PASSWORD!)}@127.0.0.1:${compose.POSTGRES_PORT}/postgres`;
  const suffix = randomBytes(5).toString('hex');
  const urls = {} as Record<Owner, string>;
  const names: string[] = [];
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    for (const owner of owners) {
      const name = `g058_${suffix}_${owner}`;
      await admin.query(`CREATE DATABASE ${name} WITH TEMPLATE ${owner}_tpl`);
      names.push(name);
      const url = new URL(adminUrl);
      url.pathname = `/${name}`;
      urls[owner] = url.toString();
    }
  } finally { await admin.end(); }
  return { urls, close: async () => {
    const cleanup = new Client({ connectionString: adminUrl });
    await cleanup.connect();
    try {
      for (const name of names) await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally { await cleanup.end(); }
  } };
}

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

export interface AccountUser { id: string; email: string; password: string; cookie: string }

/** Real Better Auth issuer with PKCE tokens; the grant API test's fixture pattern. */
export async function startAccount(scope: string) {
  const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const operators = new Set<string>();
  const auth = createAccountAuth({ baseURL: base, secret: Bun.env.ACCOUNT_SECRET!,
    resource: Bun.env.ACCOUNT_MAIN_RESOURCE, pool: accountPool, operatorUserIds: operators });
  const account = createAccountApp(auth, accountPool).listen({ hostname: '127.0.0.1', port });
  const signUp = async (name: string): Promise<AccountUser> => {
    const email = `g058-${name}-${randomUUID()}@example.test`;
    const password = randomBytes(24).toString('base64url');
    const response = await account.handle(new Request(`${base}/api/auth/sign-up/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ name, email, password }),
    }));
    expect(response.status).toBe(200);
    const body = await response.json() as { user: { id: string } };
    return { id: body.user.id, email, password, cookie: response.headers.get('set-cookie')! };
  };
  const operator = await signUp('operator');
  operators.add(operator.id);
  const headers = new Headers({ cookie: operator.cookie, origin: base });
  const verifierClient = await auth.api.adminCreateOAuthClient({ headers, body: {
    client_name: 'G-058 verifier', scope, token_endpoint_auth_method: 'client_secret_post',
    grant_types: ['client_credentials'], client_credentials_scopes: scope.split(' ') } });
  const redirectUri = 'http://localhost:3000/auth/callback';
  const client = await auth.api.adminCreateOAuthClient({ headers, body: {
    client_name: 'G-058 native client', application_type: 'native', redirect_uris: [redirectUri],
    token_endpoint_auth_method: 'none', grant_types: ['authorization_code'],
    scope: `openid ${scope}`, skip_consent: true, require_pkce: true } });
  const tokenFor = async (user: AccountUser, requested: string): Promise<string> => {
    const signIn = await fetch(`${base}/api/auth/sign-in/email`, { method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: user.email, password: user.password }) });
    expect(signIn.status).toBe(200);
    const verifier = randomBytes(32).toString('base64url');
    const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: client.client_id,
      redirect_uri: redirectUri, scope: requested, state: randomUUID(), resource: Bun.env.ACCOUNT_MAIN_RESOURCE!,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256' })) authorize.searchParams.set(key, value);
    const authorized = await fetch(authorize, { headers: { cookie: signIn.headers.get('set-cookie')! },
      redirect: 'manual' });
    expect(authorized.status).toBe(302);
    const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
    const exchange = await fetch(`${base}/api/auth/oauth2/token`, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id, code,
        redirect_uri: redirectUri, code_verifier: verifier, resource: Bun.env.ACCOUNT_MAIN_RESOURCE! }) });
    expect(exchange.status).toBe(200);
    return (await exchange.json() as { access_token: string }).access_token;
  };
  const verifier = new AccountAssertionVerifier({ issuer: `${base}/api/auth`,
    audience: Bun.env.ACCOUNT_MAIN_RESOURCE!, jwksUrl: `${base}/api/auth/jwks`,
    introspectUrl: `${base}/api/auth/oauth2/introspect`,
    clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! });
  return { issuer: `${base}/api/auth`, signUp, tokenFor, verifier,
    close: async () => { await account.stop(); await accountPool.end(); } };
}

/** An active Access principal representing a fresh Agent for `action`, granted on `scope`. */
export async function grantAgent(access: Pool, issuer: string, user: AccountUser, scope: string,
  action: string): Promise<{ principalId: string; agent: string; grantId: string }> {
  const principalId = randomUUID();
  const agent = `https://rezics.com/id/${randomUUID()}`;
  const grantId = randomUUID();
  await access.query(`INSERT INTO access.principal (id, account_issuer, account_subject) VALUES ($1, $2, $3)`,
    [principalId, issuer, user.id]);
  await access.query(`INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent')`, [agent]);
  await access.query('INSERT INTO access.scope_gate (id) VALUES ($1) ON CONFLICT DO NOTHING', [scope]);
  await access.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
    VALUES ($1, $2, $3, $4, now() + interval '1 hour')`, [randomUUID(), principalId, agent, action]);
  await access.query(`INSERT INTO access.permission_grant
    (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
    VALUES ($1, $2, $2, $3, $4, now() + interval '1 hour')`, [grantId, agent, scope, action]);
  return { principalId, agent, grantId };
}

export interface RatingSignal {
  work: string; realm: string; slot: string; observation: string; value: number | null;
  action?: string; outcome?: 'succeeded' | 'cancelled';
}

/** Bulk-retain one relay batch of rating observation envelopes, as the relay handoff writes them. */
export async function retainBatch(relay: Pool, dataEpoch: string, sequence: number,
  signals: RatingSignal[], type = 'com.rezics.rating.observation-changed.v1'): Promise<void> {
  const batchId = `urn:rezics:batch:${randomUUID()}`;
  await relay.query(`INSERT INTO relay.delivered_batch (data_epoch, sequence, batch_id, routing_epoch, event_count)
    VALUES ($1, $2, $3, 'routing-g058', $4)`, [dataEpoch, sequence, batchId, signals.length]);
  if (!signals.length) return;
  const envelopes = signals.map((signal, ordinal) => ({ specversion: '1.0', id: `urn:rezics:event:${randomUUID()}`,
    source: 'https://rezics.com/services/main', type, datacontenttype: 'application/json',
    data: { batchId, sourcePosition: { datasetId: 'product', dataEpoch, sequence: String(sequence) },
      routingEpoch: 'routing-g058', ordinal, receipt: {
        id: `urn:rezics:receipt:${randomUUID()}`, action: signal.action ?? 'rating.observation.set',
        outcome: signal.outcome ?? 'succeeded', admissionId: randomUUID(), requestDigest: '0'.repeat(64),
        authorityEpoch: '1', scope: 'rating:observe:fixture', work: signal.work, realm: signal.realm,
        ratingSlot: signal.slot, ratingObservation: signal.observation,
        ratingAvailability: signal.value === null ? 'withdrawn' : 'available',
        ...(signal.value === null ? {} : { ratingValue: signal.value }) } } }));
  await relay.query(`INSERT INTO relay.delivered_event (source, event_id, data_epoch, sequence, envelope)
    SELECT 'https://rezics.com/services/main', e->>'id', $1, $2, e
    FROM jsonb_array_elements($3::jsonb) e`, [dataEpoch, sequence, JSON.stringify(envelopes)]);
}

export const slotOf = (seed: string) => `urn:rezics:rating-slot:${createHash('sha256').update(seed).digest('hex')}`;
export const nativeId = () => `https://rezics.com/id/${randomUUID()}`;

/** Pool whose checked-out clients and direct queries count executed SQL statements. */
export function meteredPool(pool: Pool): { pool: Pool; count: () => number; reset: () => void } {
  let statements = 0;
  const countQuery = <T extends { query: (...args: never[]) => unknown }>(target: T): T =>
    new Proxy(target, { get(object, key, receiver) {
      const value = Reflect.get(object, key, receiver);
      if (key !== 'query' || typeof value !== 'function') return typeof value === 'function' ? value.bind(object) : value;
      return (...args: unknown[]) => { statements++; return (value as (...a: unknown[]) => unknown).apply(object, args); };
    } });
  const metered = new Proxy(pool, { get(object, key, receiver) {
    if (key === 'connect') {
      return async () => countQuery(await object.connect() as PoolClient);
    }
    if (key === 'query') {
      return (...args: unknown[]) => { statements++; return (object.query as (...a: unknown[]) => unknown).apply(object, args); };
    }
    const value = Reflect.get(object, key, receiver);
    return typeof value === 'function' ? value.bind(object) : value;
  } });
  return { pool: metered, count: () => statements, reset: () => { statements = 0; } };
}
