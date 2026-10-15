import { enrollOperatorAt } from '../../../services/account/tests/factor-fixture.ts';
import { signupPolicyFixture } from '../../../scripts/dev/signup-policy-fixture.ts';
import { registerTelemetryPeers } from '@rezics/observability/runtime';
import { signIn } from '../../../scripts/lib/oauth-client.ts';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { expect } from 'bun:test';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { accountAuthOptions, createAccountAuth } from '../../../services/account/src/auth.ts';
import { installConsentRefreshFence } from '../../../services/account/src/consent-fence.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';

export const RETAINED_RATING_AUTH_VERSION = 'retained-rating-auth-v1';
interface RetainedRatingUser { id: string; email: string; password: string; cookie: string }
/** Bound to the backup manifest; Account's restored rows remain the sole
 * authority for passwords, OAuth clients, signing keys and login fences. */
export interface RetainedRatingAuth {
  version: typeof RETAINED_RATING_AUTH_VERSION;
  issuer: string;
  base: string;
  resource: string;
  secret: string;
  scopes: string;
  a: RetainedRatingUser;
  b: RetainedRatingUser;
  oauthClientId: string;
  verifierClientId: string;
  verifierClientSecret: string;
}
const redirectUri = 'http://localhost:3000/auth/callback';

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

/** The fixture's one Account pool. Migration, Better Auth's drivers and the live server share it, so a
 * driver's own cleanup must not close it while the listener still answers introspection: `pool.end`
 * does nothing until `closePool` runs. */
function sharedAccountPool(connectionString: string) {
  const pool = new Pool({ connectionString });
  let releasePool = false;
  const endPool = pool.end.bind(pool);
  pool.end = ((callback?: () => void) => {
    if (!releasePool) { callback?.(); return Promise.resolve(); }
    return callback ? endPool(callback) : endPool();
  }) as typeof pool.end;
  return { pool, closePool: async () => { releasePool = true; await endPool(); } };
}

/** Real Better Auth owner and OAuth clients on the fixture's isolated database. */
export async function ratingAccount(apps: Record<string, string>,
  scopes = 'openid work:create work:edit work:read space:create rating:configure rating:submit rating:read',
  deletionFence?: (issuer: string, subject: string) => Promise<void>) {
  const { pool, closePool } = sharedAccountPool(apps.ACCOUNT_DATABASE_URL!);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const operators = new Set<string>();
  const config = { baseURL: base, secret: apps.ACCOUNT_SECRET!,
    resource: apps.ACCOUNT_MAIN_RESOURCE!, pool, operatorUserIds: operators,
    ...(deletionFence ? { accessDeletionFence: (subject: string) => deletionFence(`${base}/api/auth`, subject) } : {}) };
  await (await getMigrations(accountAuthOptions(config))).runMigrations();
  await installConsentRefreshFence(pool);
  const auth = createAccountAuth(config);
  const account = createAccountApp(auth, pool).listen({ hostname: '127.0.0.1', port });
  let unregisterTelemetryPeers = () => {};
  let stopped = false;
  const stop = async () => { if (!stopped) { stopped = true;
    try { await account.stop(true); } finally { unregisterTelemetryPeers(); } } };
  try {
    unregisterTelemetryPeers = registerTelemetryPeers({ ...apps, ACCOUNT_ORIGIN: base,
      ACCOUNT_JWKS_URL: `${base}/api/auth/jwks`, ACCOUNT_INTROSPECT_URL: `${base}/api/auth/oauth2/introspect` });
    async function signUp(name: string) {
      const email = `rating-${name}-${randomUUID()}@example.test`;
      const password = randomBytes(24).toString('base64url');
      const response = await account.handle(new Request(`${base}/api/auth/sign-up/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ ...signupPolicyFixture, name, email, password }),
      }));
      expect(response.status).toBe(200);
      const body = await response.json() as { user: { id: string } };
      return { id: body.user.id, email, password, cookie: response.headers.get('set-cookie')! };
    }
    const operator = await signUp('operator');
    operators.add(operator.id);
    await enrollOperatorAt(pool, apps.ACCOUNT_SECRET!, base, operator);
    // A QA project can create several fixtures against one Account database.
    // The deployment bootstrap runs once, so each fixture grants its own operator.
    await pool.query("INSERT INTO rezics_account_operator (user_id, role) VALUES ($1, 'owner') ON CONFLICT DO NOTHING",
      [operator.id]);
    const headers = new Headers({ cookie: operator.cookie, origin: base });
    const verifierClient = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'Rating verifier', scope: 'work:create work:edit work:read space:create rating:configure rating:submit rating:read',
      token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
      client_credentials_scopes: ['work:create', 'work:edit', 'work:read', 'space:create',
        'rating:configure', 'rating:submit', 'rating:read'] } });
    const oauthClient = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'Rating native client', application_type: 'native',
      redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'], scope: scopes,
      skip_consent: true, require_pkce: true } });
    async function tokenFor(user: { email: string; password: string }, scope = scopes) {
      const signedIn = await fetch(`${base}/api/auth/sign-in/email`, { method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ email: user.email, password: user.password }) });
      expect(signedIn.status).toBe(200);
      return (await signIn({
        account: base, clientId: oauthClient.client_id, redirectUri, scope,
        resource: apps.ACCOUNT_MAIN_RESOURCE!,
      }, signedIn.headers.get('set-cookie')!)).accessToken;
    }

    const a = await signUp('a'), b = await signUp('b');
    const retainedAuth: RetainedRatingAuth = { version: RETAINED_RATING_AUTH_VERSION,
      issuer: `${base}/api/auth`, base, resource: apps.ACCOUNT_MAIN_RESOURCE!,
      secret: apps.ACCOUNT_SECRET!, scopes, a: { ...a }, b: { ...b },
      oauthClientId: oauthClient.client_id, verifierClientId: verifierClient.client_id,
      verifierClientSecret: verifierClient.client_secret! };
    return { issuer: `${base}/api/auth`, a, b, tokenFor,
      retainedAuth,
      expireSessions: async (id: string) => { await pool.query('DELETE FROM session WHERE "userId" = $1', [id]); },
      stop,
      tokenA: await tokenFor(a), tokenB: await tokenFor(b), noScope: await tokenFor(a, 'openid'),
      verifier: new AccountAssertionVerifier({ issuer: `${base}/api/auth`,
        audience: apps.ACCOUNT_MAIN_RESOURCE!, jwksUrl: `${base}/api/auth/jwks`,
        introspectUrl: `${base}/api/auth/oauth2/introspect`,
        clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! }),
      close: async () => { try { await stop(); } finally { await closePool(); } } };
  } catch (error) { try { await stop(); } finally { await closePool(); } throw error; }
}

/** Reopen the retained Account authority on an isolated restored database.
 * Never migrate, create identities or grant clients while consuming a source. */
export async function restoreRatingAccount(snapshot: RetainedRatingAuth, accountDatabaseUrl: string) {
  if (snapshot.version !== RETAINED_RATING_AUTH_VERSION || snapshot.issuer !== `${snapshot.base}/api/auth`) {
    throw new Error('retained Account authentication snapshot is incompatible');
  }
  const { pool, closePool } = sharedAccountPool(accountDatabaseUrl);
  let stop = async () => {};
  try {
    const port = await freePort();
    const service = `http://127.0.0.1:${port}`;
    const auth = createAccountAuth({ baseURL: snapshot.base, secret: snapshot.secret,
      resource: snapshot.resource, pool, operatorUserIds: new Set<string>() });
    const account = createAccountApp(auth, pool).listen({ hostname: '127.0.0.1', port });
    let unregisterTelemetryPeers = () => {};
    let stopped = false;
    stop = async () => { if (!stopped) { stopped = true;
      try { await account.stop(true); } finally { unregisterTelemetryPeers(); } } };
    unregisterTelemetryPeers = registerTelemetryPeers({ ACCOUNT_DATABASE_URL: accountDatabaseUrl,
      ACCOUNT_ORIGIN: service, ACCOUNT_JWKS_URL: `${service}/api/auth/jwks`,
      ACCOUNT_INTROSPECT_URL: `${service}/api/auth/oauth2/introspect` });
    async function tokenFor(user: { email: string; password: string }, scope = snapshot.scopes) {
      // Preserve the retained issuer's trusted Origin even though the isolated
      // socket has a new port; Account still enforces the actual login policy.
      const signedIn = await account.handle(new Request(`${snapshot.base}/api/auth/sign-in/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: snapshot.base },
        body: JSON.stringify({ email: user.email, password: user.password }),
      }));
      expect(signedIn.status).toBe(200);
      return (await signIn({ account: snapshot.base, service,
        clientId: snapshot.oauthClientId, redirectUri, scope, resource: snapshot.resource,
      }, signedIn.headers.get('set-cookie')!)).accessToken;
    }
    const retainedAuth: RetainedRatingAuth = { ...snapshot, a: { ...snapshot.a }, b: { ...snapshot.b } };
    const a = { ...snapshot.a }, b = { ...snapshot.b };
    return { issuer: snapshot.issuer, a, b, tokenFor, retainedAuth,
      expireSessions: async (id: string) => { await pool.query('DELETE FROM session WHERE "userId" = $1', [id]); },
      stop, tokenA: await tokenFor(a), tokenB: await tokenFor(b), noScope: await tokenFor(a, 'openid'),
      verifier: new AccountAssertionVerifier({ issuer: snapshot.issuer, audience: snapshot.resource,
        jwksUrl: `${service}/api/auth/jwks`, introspectUrl: `${service}/api/auth/oauth2/introspect`,
        clientId: snapshot.verifierClientId, clientSecret: snapshot.verifierClientSecret }),
      close: async () => { try { await stop(); } finally { await closePool(); } } };
  } catch (error) { try { await stop(); } finally { await closePool(); } throw error; }
}
