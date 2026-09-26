import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { expect } from 'bun:test';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { accountAuthOptions, createAccountAuth } from '../../../services/account/src/auth.ts';
import { installConsentRefreshFence } from '../../../services/account/src/consent-fence.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';

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

/** Real Better Auth owner and OAuth clients on the fixture's isolated database. */
export async function ratingAccount(apps: Record<string, string>) {
  const pool = new Pool({ connectionString: apps.ACCOUNT_DATABASE_URL });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const operators = new Set<string>();
  const config = { baseURL: base, secret: apps.ACCOUNT_SECRET!,
    resource: apps.ACCOUNT_MAIN_RESOURCE!, pool, operatorUserIds: operators };
  await (await getMigrations(accountAuthOptions(config))).runMigrations();
  await installConsentRefreshFence(pool);
  const auth = createAccountAuth(config);
  const account = createAccountApp(auth, pool).listen({ hostname: '127.0.0.1', port });
  try {
    async function signUp(name: string) {
      const email = `rating-${name}-${randomUUID()}@example.test`;
      const password = randomBytes(24).toString('base64url');
      const response = await account.handle(new Request(`${base}/api/auth/sign-up/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ name, email, password }),
      }));
      expect(response.status).toBe(200);
      const body = await response.json() as { user: { id: string } };
      return { id: body.user.id, email, password, cookie: response.headers.get('set-cookie')! };
    }
    const operator = await signUp('operator');
    operators.add(operator.id);
    const headers = new Headers({ cookie: operator.cookie, origin: base });
    const verifierClient = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'Rating verifier', scope: 'work:create space:create rating:configure rating:submit rating:read',
      token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
      client_credentials_scopes: ['work:create', 'space:create', 'rating:configure', 'rating:submit', 'rating:read'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const oauthClient = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'Rating native client', application_type: 'native',
      redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'], scope: 'openid work:create space:create rating:configure rating:submit rating:read',
      skip_consent: true, require_pkce: true } });
    async function tokenFor(user: { email: string; password: string }, scope = 'openid work:create space:create rating:configure rating:submit rating:read') {
      const signIn = await fetch(`${base}/api/auth/sign-in/email`, { method: 'POST',
        headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ email: user.email, password: user.password }) });
      expect(signIn.status).toBe(200);
      const verifier = randomBytes(32).toString('base64url');
      const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
      for (const [key, value] of Object.entries({ response_type: 'code',
        client_id: oauthClient.client_id, redirect_uri: redirectUri, scope,
        state: randomUUID(), resource: apps.ACCOUNT_MAIN_RESOURCE!,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      })) authorize.searchParams.set(key, value);
      const authorized = await fetch(authorize, {
        headers: { cookie: signIn.headers.get('set-cookie')! }, redirect: 'manual' });
      expect(authorized.status).toBe(302);
      const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
      const exchange = await fetch(`${base}/api/auth/oauth2/token`, { method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: oauthClient.client_id,
          code, redirect_uri: redirectUri, code_verifier: verifier, resource: apps.ACCOUNT_MAIN_RESOURCE! }) });
      expect(exchange.status).toBe(200);
      return (await exchange.json() as { access_token: string }).access_token;
    }

    const a = await signUp('a'), b = await signUp('b');
    return { issuer: `${base}/api/auth`, a, b,
      tokenA: await tokenFor(a), tokenB: await tokenFor(b), noScope: await tokenFor(a, 'openid'),
      verifier: new AccountAssertionVerifier({ issuer: `${base}/api/auth`,
        audience: apps.ACCOUNT_MAIN_RESOURCE!, jwksUrl: `${base}/api/auth/jwks`,
        introspectUrl: `${base}/api/auth/oauth2/introspect`,
        clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! }),
      close: async () => { await account.stop(true); await pool.end(); } };
  } catch (error) { await account.stop(true); await pool.end(); throw error; }
}
