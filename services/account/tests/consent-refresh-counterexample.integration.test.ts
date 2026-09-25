import { test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { AccountAssertionVerifier } from '../../main/src/modules/account/verify-assertion.ts';
import { accountAuthOptions, createAccountAuth } from '../src/auth.ts';
import { createAccountApp } from '../src/app.ts';

const root = resolve(import.meta.dir, '../../..');

async function freePort(): Promise<number> {
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

/** Diagnostic of the pinned provider. Passing proves the IAM09 gap exists; it
 * does not qualify consent revocation. Keep it outside the QA acceptance map. */
test('Provider 1.7.5 counterexample: deleted consent leaves refresh and Main access usable', async () => {
  const state = join(root, '.temp', `consent-refresh-counterexample-${randomUUID()}`);
  const data = join(state, 'pgdata');
  const socket = join(root, '.temp', 'pg-sock');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  mkdirSync(socket, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state });
  const pgPort = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${pgPort} -k ${socket}`, '-w', 'start'], { cwd: state });
  const pool = new Pool({ host: '127.0.0.1', port: pgPort,
    user: process.env.USER, database: 'postgres' });
  const accountPort = await freePort();
  const baseURL = `http://127.0.0.1:${accountPort}`;
  const resource = 'https://main.rezics.test';
  const operators = new Set<string>();
  const config = { baseURL, resource, pool, operatorUserIds: operators,
    secret: 'consent-refresh-counterexample-secret-32-plus-chars' };
  let app: ReturnType<typeof createAccountApp> | undefined;
  try {
    const migration = await getMigrations(accountAuthOptions(config));
    expect(migration.unsafeChanges).toEqual([]);
    expect(migration.schemaProblems).toEqual([]);
    await migration.runMigrations();
    const auth = createAccountAuth(config);
    app = createAccountApp(auth, pool).listen({ hostname: '127.0.0.1', port: accountPort });
    const signUp = async (name: string) => {
      const email = `${name}-${randomUUID()}@example.test`;
      const password = randomBytes(24).toString('base64url');
      const response = await fetch(`${baseURL}/api/auth/sign-up/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: baseURL },
        body: JSON.stringify({ name, email, password }),
      });
      expect(response.status).toBe(200);
      return { id: (await response.json() as { user: { id: string } }).user.id,
        cookie: response.headers.get('set-cookie')! };
    };
    const operator = await signUp('operator');
    operators.add(operator.id);
    const adminHeaders = new Headers({ cookie: operator.cookie, origin: baseURL });
    const verifierClient = await auth.api.adminCreateOAuthClient({ headers: adminHeaders,
      body: { client_name: 'Main verifier', scope: 'work:create',
        token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
        client_credentials_scopes: ['work:create'] } });
    const callback = 'http://localhost:3000/auth/callback';
    const consentingClient = await auth.api.adminCreateOAuthClient({ headers: adminHeaders,
      body: { client_name: 'Explicit consent RP', application_type: 'native',
        redirect_uris: [callback], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], scope: 'openid work:create offline_access',
        require_pkce: true } });
    const member = await signUp('member');
    const pkceVerifier = randomBytes(32).toString('base64url');
    const authorize = new URL(`${baseURL}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({ response_type: 'code',
      client_id: consentingClient.client_id, redirect_uri: callback,
      scope: 'openid work:create offline_access', state: randomUUID(), resource,
      code_challenge: createHash('sha256').update(pkceVerifier).digest('base64url'),
      code_challenge_method: 'S256' })) authorize.searchParams.set(key, value);
    const consentPrompt = await fetch(authorize, {
      headers: { cookie: member.cookie }, redirect: 'manual' });
    expect(consentPrompt.status).toBe(302);
    const consentURL = new URL(consentPrompt.headers.get('location')!, baseURL);
    expect(consentURL.pathname).toBe('/consent');
    const accepted = await fetch(`${baseURL}/api/auth/oauth2/consent`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/json', cookie: member.cookie, origin: baseURL },
      body: JSON.stringify({ accept: true, oauth_query: consentURL.searchParams.toString() }),
    });
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json() as { redirect: boolean; url: string };
    expect(acceptedBody.redirect).toBe(true);
    const code = new URL(acceptedBody.url).searchParams.get('code');
    expect(code).toBeTruthy();
    const exchange = await fetch(`${baseURL}/api/auth/oauth2/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code',
        client_id: consentingClient.client_id, code: code!, redirect_uri: callback,
        code_verifier: pkceVerifier, resource }),
    });
    expect(exchange.status).toBe(200);
    const original = await exchange.json() as { access_token: string; refresh_token: string };
    expect(original.refresh_token).toBeTruthy();
    const consentsResponse = await fetch(`${baseURL}/api/auth/oauth2/get-consents`, {
      headers: { cookie: member.cookie } });
    expect(consentsResponse.status).toBe(200);
    const consents = await consentsResponse.json() as Array<{
      id: string; clientId: string; userId: string; scopes: string[] }>;
    const consent = consents.find(item => item.clientId === consentingClient.client_id);
    expect(consent).toMatchObject({ userId: member.id,
      scopes: expect.arrayContaining(['work:create', 'offline_access']) });
    const deleted = await fetch(`${baseURL}/api/auth/oauth2/delete-consent`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        cookie: member.cookie, origin: baseURL },
      body: JSON.stringify({ id: consent!.id }),
    });
    expect(deleted.status).toBe(200);
    const remaining = await pool.query(
      'SELECT id FROM "oauthConsent" WHERE id = $1', [consent!.id]);
    expect(remaining.rowCount).toBe(0);
    const stillLive = await pool.query<{ revoked: Date | null }>(
      'SELECT revoked FROM "oauthRefreshToken" WHERE "userId" = $1 AND "clientId" = $2',
      [member.id, consentingClient.client_id]);
    expect(stillLive.rows).toHaveLength(1);
    expect(stillLive.rows[0]?.revoked).toBeNull();
    const widened = await fetch(`${baseURL}/api/auth/oauth2/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token',
        client_id: consentingClient.client_id, refresh_token: original.refresh_token,
        scope: 'work:create work:edit', resource }),
    });
    expect(widened.status).toBe(400);
    expect(await widened.json()).toMatchObject({ error: 'invalid_scope' });
    const refresh = await fetch(`${baseURL}/api/auth/oauth2/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token',
        client_id: consentingClient.client_id, refresh_token: original.refresh_token,
        resource }),
    });
    expect(refresh.status).toBe(200);
    const renewed = await refresh.json() as { access_token: string; refresh_token: string };
    expect(renewed.access_token).toBeTruthy();
    expect(renewed.refresh_token).toBeTruthy();
    const verifier = new AccountAssertionVerifier({ issuer: `${baseURL}/api/auth`,
      audience: resource, jwksUrl: `${baseURL}/api/auth/jwks`,
      introspectUrl: `${baseURL}/api/auth/oauth2/introspect`,
      clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! });
    const principal = await verifier.verify(new Request(`${resource}/v1/works`, {
      method: 'POST', headers: { authorization: `Bearer ${renewed.access_token}` },
    }), ['work:create']);
    expect(principal.subject).toBe(member.id);
  } finally {
    await app?.stop();
    await pool.end();
    execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state });
    rmSync(state, { recursive: true, force: true });
  }
}, 120_000);
