import { test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { accountAuthOptions, createAccountAuth } from '../src/auth.ts';
import { createAccountApp } from '../src/app.ts';
import { AccountAssertionDenied, AccountAssertionVerifier } from '../../main/src/modules/account/verify-assertion.ts';

const root = resolve(import.meta.dir, '../../..');

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no PostgreSQL test port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

test('IAM01/IAM10 partial: Account schema, session and OIDC discovery over HTTP', async () => {
  const state = join(root, '.temp', `account-integration-${Bun.randomUUIDv7()}`);
  const data = join(state, 'pgdata');
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const socketDirectory = join(root, '.temp', 'pg-sock');
  mkdirSync(socketDirectory, { recursive: true, mode: 0o700 });
  execFileSync('initdb', ['-D', data, '-A', 'trust', '--no-instructions'], { cwd: state });
  const postgresPort = await freePort();
  execFileSync('pg_ctl', ['-D', data, '-l', join(state, 'postgres.log'),
    '-o', `-h 127.0.0.1 -p ${postgresPort} -k ${socketDirectory}`, '-w', 'start'], { cwd: state });
  const pool = new Pool({ host: '127.0.0.1', port: postgresPort, user: process.env.USER, database: 'postgres' });
  const accountPort = await freePort();
  const baseURL = `http://127.0.0.1:${accountPort}`;
  const operatorUserIds = new Set<string>();
  const fencedSubjects: string[] = [];
  const unavailableSubjects = new Set<string>();
  const config = { baseURL, secret: 'account-local-integration-secret-value-32',
    resource: 'https://main.rezics.test', pool, operatorUserIds,
    accessDeletionFence: async (subject: string) => {
      if (unavailableSubjects.has(subject)) throw new Error('Access is unavailable');
      fencedSubjects.push(subject);
    } };
  let app: ReturnType<typeof createAccountApp> | undefined;
  try {
    const migration = await getMigrations(accountAuthOptions(config));
    expect(migration.unsafeChanges).toEqual([]);
    expect(migration.schemaProblems).toEqual([]);
    expect(migration.toBeCreated.length).toBeGreaterThan(4);
    await migration.runMigrations();
    const repeat = await getMigrations(accountAuthOptions(config));
    expect(repeat.toBeCreated).toEqual([]);
    expect(repeat.toBeAdded).toEqual([]);
    const auth = createAccountAuth(config);
    app = createAccountApp(auth, pool).listen({ hostname: '127.0.0.1', port: accountPort });
    const live = await fetch(`${baseURL}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'ok' });
    const ready = await fetch(`${baseURL}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: 'ready' });
    const discovery = await fetch(`${baseURL}/api/auth/.well-known/openid-configuration`);
    expect(discovery.status).toBe(200);
    const metadata = await discovery.json() as Record<string, unknown>;
    expect(metadata.issuer).toBe(`${baseURL}/api/auth`);
    expect(metadata.issuer).toBeTruthy();
    expect(metadata.jwks_uri).toBeTruthy();
    const jwks = await fetch(String(metadata.jwks_uri));
    expect(jwks.status).toBe(200);
    const keySet = await jwks.json() as { keys: unknown[] };
    expect(keySet.keys.length).toBeGreaterThan(0);
    const signUp = await fetch(`${baseURL}/api/auth/sign-up/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: baseURL },
      body: JSON.stringify({ name: 'Local Test User', email: 'local@example.test', password: 'correct horse battery staple' }),
    });
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers.get('set-cookie');
    expect(cookie).toBeTruthy();
    const session = await fetch(`${baseURL}/api/auth/get-session`, { headers: { cookie: cookie! } });
    expect(session.status).toBe(200);
    const current = await session.json() as { user?: { email?: string } };
    expect(current.user?.email).toBe('local@example.test');
    const registration = {
      client_name: 'Local Main resource test', scope: 'work:create',
      token_endpoint_auth_method: 'client_secret_post',
      grant_types: ['client_credentials'], client_credentials_scopes: ['work:create'],
    };
    const adminCreate = () => auth.api.adminCreateOAuthClient({
      headers: new Headers({ cookie: cookie!, origin: baseURL }), body: registration,
    });
    await expect(adminCreate()).rejects.toThrow();
    const signUpBody = await signUp.json() as { user?: { id?: string } };
    expect(signUpBody.user?.id).toBeTruthy();
    operatorUserIds.add(signUpBody.user!.id!);
    const client = await adminCreate();
    expect(client.client_id).toBeTruthy();
    expect(client.client_secret).toBeTruthy();
    const clientId = client.client_id;
    const clientSecret = client.client_secret!;
    const tokenResponse = await fetch(`${baseURL}/api/auth/oauth2/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId,
        client_secret: clientSecret, scope: 'work:create', resource: 'https://main.rezics.test' }),
    });
    expect(tokenResponse.status).toBe(200);
    const issued = await tokenResponse.json() as { access_token: string };
    expect(issued.access_token.split('.')).toHaveLength(3);
    const verifier = new AccountAssertionVerifier({ issuer: String(metadata.issuer),
      audience: 'https://main.rezics.test', jwksUrl: String(metadata.jwks_uri),
      introspectUrl: `${baseURL}/api/auth/oauth2/introspect`,
      clientId, clientSecret });
    const verified = await verifier.verify(new Request('https://main.rezics.test/works', {
      method: 'POST', headers: { authorization: `Bearer ${issued.access_token}` },
    }), ['work:create']);
    expect(verified.issuer).toBe(String(metadata.issuer));
    expect(verified.subject).toBeTruthy();

    const callback = 'https://rp.rezics.test/callback';
    const publicClient = await auth.api.adminCreateOAuthClient({
      headers: new Headers({ cookie: cookie!, origin: baseURL }),
      body: { client_name: 'Local public RP', redirect_uris: [callback],
        token_endpoint_auth_method: 'none', grant_types: ['authorization_code'],
        scope: 'openid work:create offline_access', skip_consent: true, require_pkce: true },
    });
    const memberSignUp = await fetch(`${baseURL}/api/auth/sign-up/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: baseURL },
      body: JSON.stringify({ name: 'Member', email: 'member@example.test',
        password: 'correct horse battery staple' }),
    });
    expect(memberSignUp.status).toBe(200);
    const memberCookie = memberSignUp.headers.get('set-cookie')!;
    const memberId = (await memberSignUp.json() as { user: { id: string } }).user.id;
    const pkceVerifier = 'a'.repeat(64);
    const challenge = createHash('sha256').update(pkceVerifier).digest('base64url');
    const authorize = new URL(`${baseURL}/api/auth/oauth2/authorize`);
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: publicClient.client_id,
      redirect_uri: callback, scope: 'openid work:create offline_access', state: 'opaque-state-1',
      code_challenge: challenge, code_challenge_method: 'S256', resource: 'https://main.rezics.test' })) {
      authorize.searchParams.set(key, value);
    }
    const authorization = await fetch(authorize, { headers: { cookie: memberCookie }, redirect: 'manual' });
    expect(authorization.status).toBe(302);
    const destination = new URL(authorization.headers.get('location')!);
    expect(destination.origin + destination.pathname).toBe(callback);
    expect(destination.searchParams.get('state')).toBe('opaque-state-1');
    const code = destination.searchParams.get('code');
    expect(code).toBeTruthy();
    const exchanged = await fetch(`${baseURL}/api/auth/oauth2/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: publicClient.client_id,
        code: code!, redirect_uri: callback, code_verifier: pkceVerifier,
        resource: 'https://main.rezics.test' }),
    });
    expect(exchanged.status).toBe(200);
    const userTokens = await exchanged.json() as { access_token: string;
      id_token: string; refresh_token?: string };
    expect(userTokens.access_token.split('.')).toHaveLength(3);
    expect(userTokens.id_token.split('.')).toHaveLength(3);
    expect(userTokens.refresh_token).toBeTruthy();
    const userRequest = new Request('https://main.rezics.test/works', {
      method: 'POST', headers: { authorization: `Bearer ${userTokens.access_token}` },
    });
    expect((await verifier.verify(userRequest, ['work:create'])).subject).toBe(memberId);
    const signOut = await fetch(`${baseURL}/api/auth/sign-out`, {
      method: 'POST', headers: { cookie: memberCookie, origin: baseURL },
    });
    expect(signOut.status).toBe(200);
    await expect(verifier.verify(userRequest, ['work:create']))
      .rejects.toBeInstanceOf(AccountAssertionDenied);
    const offline = await pool.query<{ revoked: Date | null; scopes: string[] }>(
      'SELECT revoked, scopes FROM "oauthRefreshToken" WHERE "userId" = $1', [memberId]);
    expect(offline.rows).toHaveLength(1);
    expect(offline.rows[0]?.scopes).toContain('offline_access');
    expect(offline.rows[0]?.revoked).toBeNull();
    const signedIn = await fetch(`${baseURL}/api/auth/sign-in/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: baseURL },
      body: JSON.stringify({ email: 'member@example.test', password: 'correct horse battery staple' }),
    });
    expect(signedIn.status).toBe(200);
    const deleteResponse = await fetch(`${baseURL}/api/auth/delete-user`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        cookie: signedIn.headers.get('set-cookie')!, origin: baseURL },
      body: JSON.stringify({ password: 'correct horse battery staple' }),
    });
    expect(deleteResponse.status).toBe(200);
    expect(fencedSubjects).toEqual([memberId]);
    expect((await pool.query('SELECT id FROM "user" WHERE id = $1', [memberId])).rowCount)
      .toBe(0);
    expect((await pool.query('SELECT id FROM "session" WHERE "userId" = $1',
      [memberId])).rowCount).toBe(0);
    expect((await pool.query('SELECT id FROM "account" WHERE "userId" = $1',
      [memberId])).rowCount).toBe(0);
    expect((await pool.query('SELECT id FROM "oauthAccessToken" WHERE "userId" = $1',
      [memberId])).rowCount).toBe(0);
    expect((await pool.query('SELECT id FROM "oauthRefreshToken" WHERE "userId" = $1',
      [memberId])).rowCount).toBe(0);
    await expect(verifier.verify(userRequest, ['work:create']))
      .rejects.toBeInstanceOf(AccountAssertionDenied);
    const operatorDelete = await fetch(`${baseURL}/api/auth/delete-user`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie!, origin: baseURL },
      body: JSON.stringify({ password: 'correct horse battery staple' }),
    });
    expect(operatorDelete.status).toBe(409);
    expect(fencedSubjects).toEqual([memberId]);
    operatorUserIds.delete(signUpBody.user!.id!);
    const clientOwnerDelete = await fetch(`${baseURL}/api/auth/delete-user`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie!, origin: baseURL },
      body: JSON.stringify({ password: 'correct horse battery staple' }),
    });
    expect(clientOwnerDelete.status).toBe(409);
    const blockedSignUp = await fetch(`${baseURL}/api/auth/sign-up/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: baseURL },
      body: JSON.stringify({ name: 'Blocked', email: 'blocked@example.test',
        password: 'correct horse battery staple' }),
    });
    expect(blockedSignUp.status).toBe(200);
    const blockedId = (await blockedSignUp.json() as { user: { id: string } }).user.id;
    unavailableSubjects.add(blockedId);
    const blockedDelete = await fetch(`${baseURL}/api/auth/delete-user`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        cookie: blockedSignUp.headers.get('set-cookie')!, origin: baseURL },
      body: JSON.stringify({ password: 'correct horse battery staple' }),
    });
    expect(blockedDelete.status).toBe(503);
    expect((await pool.query('SELECT id FROM "user" WHERE id = $1', [blockedId])).rowCount)
      .toBe(1);
    expect(fencedSubjects).toEqual([memberId]);
  } finally {
    await app?.stop();
    await pool.end();
    execFileSync('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], { cwd: state });
  }
}, 120_000);
