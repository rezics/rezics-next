import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
import { signIn } from '../../../scripts/lib/oauth-client.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { expect } from 'bun:test';
import { Pool, type PoolClient } from 'pg';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

// Shared fixtures for the G-058 ranking and graph-layout API tests: isolated
// owner clones, a real Account issuer, retained relay envelopes and SQL meters.

export function requireQa(): string {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId || !/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId) || !Bun.env.ACCOUNT_DATABASE_URL
    || !Bun.env.ACCOUNT_MAIN_RESOURCE || !Bun.env.FUSEKI_URL || !Bun.env.ACCESS_DATABASE_URL) {
    throw new Error('Run through the isolated QA integration tier');
  }
  return runId;
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
  // Operator bootstrap is once per database, not once per issuer. Each issuer
  // needs its own owner so an earlier file cannot consume its bootstrap or fence it.
  const owners = await cloneQaOwnerDatabases(requireQa(), ['account'], 'privileged');
  const accountPool = new Pool({ connectionString: owners.urls.account });
  let account: ReturnType<typeof createAccountApp> | undefined;
  try {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const operators = new Set<string>();
    const auth = createAccountAuth({ baseURL: base, secret: Bun.env.ACCOUNT_SECRET!,
      resource: Bun.env.ACCOUNT_MAIN_RESOURCE!, pool: accountPool, operatorUserIds: operators });
    const app = createAccountApp(auth, accountPool).listen({ hostname: '127.0.0.1', port });
    account = app;
    const signUp = async (name: string): Promise<AccountUser> => {
      const email = `g058-${name}-${randomUUID()}@example.test`;
      const password = randomBytes(24).toString('base64url');
      const response = await app.handle(new Request(`${base}/api/auth/sign-up/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ ...signupPolicyFixture, name, email, password }),
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
      const signedIn = await fetch(`${base}/api/auth/sign-in/email`, { method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ email: user.email, password: user.password }) });
      expect(signedIn.status).toBe(200);
      return (await signIn({
        account: base, clientId: client.client_id, redirectUri, scope: requested,
        resource: Bun.env.ACCOUNT_MAIN_RESOURCE!,
      }, signedIn.headers.get('set-cookie')!)).accessToken;
    };
    const verifier = new AccountAssertionVerifier({ issuer: `${base}/api/auth`,
      audience: Bun.env.ACCOUNT_MAIN_RESOURCE!, jwksUrl: `${base}/api/auth/jwks`,
      introspectUrl: `${base}/api/auth/oauth2/introspect`,
      clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! });
    return { issuer: `${base}/api/auth`, signUp, tokenFor, verifier,
      close: async () => { await app.stop(); await accountPool.end(); await owners.close(); } };
  } catch (error) {
    await account?.stop();
    await accountPool.end();
    await owners.close();
    throw error;
  }
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
  contributorPrincipalId?: string;
}

/** Bulk-retain one relay batch of rating observation envelopes, as the relay handoff writes them. */
export async function retainBatch(relay: Pool, dataEpoch: string, sequence: number,
  signals: RatingSignal[], attribution: { access: Pool; principalId: string; actingSubject: string },
  type = 'com.rezics.rating.observation-changed.v1'): Promise<void> {
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
  await attribution.access.query(`INSERT INTO access.scope_gate (id)
    VALUES ('rating:observe:fixture') ON CONFLICT DO NOTHING`);
  await attribution.access.query(`INSERT INTO access.admission
    (id, principal_id, acting_subject, scope_id, action, idempotency_key, request_digest,
      authority_epoch, expires_at, state, graph_receipt, graph_outcome, graph_data_epoch,
      graph_sequence, sealed_at)
    SELECT (item->>'admissionId')::uuid, (item->>'principalId')::uuid, $2,
      'rating:observe:fixture', 'rating.observation.set', item->>'admissionId', repeat('0', 64),
      1, now() + interval '1 hour', 'sealed', item->>'receipt', 'succeeded', $3, $4::text, now()
    FROM jsonb_array_elements($1::jsonb) item`, [JSON.stringify(envelopes.map((envelope, index) => ({
      admissionId: envelope.data.receipt.admissionId,
      principalId: signals[index]!.contributorPrincipalId ?? attribution.principalId,
      receipt: envelope.data.receipt.id }))), attribution.actingSubject, dataEpoch, String(sequence)]);
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
