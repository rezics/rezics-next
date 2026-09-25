import { test, expect } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { AccountAssertionDenied, AccountAssertionVerifier } from '../../main/src/modules/account/verify-assertion.ts';
import { accountAuthOptions, createAccountAuth } from '../src/auth.ts';
import { createAccountApp } from '../src/app.ts';
import { installConsentRefreshFence } from '../src/consent-fence.ts';

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

test('IAM09 partial: withdrawn consent fences old refresh and Main access across clients', async () => {
  const state = join(root, '.temp', `consent-revocation-${randomUUID()}`);
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
    secret: 'consent-revocation-local-secret-32-plus-chars' };
  let app: ReturnType<typeof createAccountApp> | undefined;
  try {
    const migration = await getMigrations(accountAuthOptions(config));
    expect(migration.unsafeChanges).toEqual([]);
    expect(migration.schemaProblems).toEqual([]);
    await migration.runMigrations();
    await installConsentRefreshFence(pool);
    await installConsentRefreshFence(pool);
    const repeat = await getMigrations(accountAuthOptions(config));
    expect(repeat.unsafeChanges).toEqual([]);
    expect(repeat.schemaProblems).toEqual([]);
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
        grant_types: ['authorization_code'], scope: 'openid work:create work:edit offline_access',
        subject_type: 'public', require_pkce: true } });
    const peerClient = await auth.api.adminCreateOAuthClient({ headers: adminHeaders,
      body: { client_name: 'Independent consent RP', application_type: 'native',
        redirect_uris: [callback], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], scope: 'openid work:create offline_access',
        subject_type: 'public', require_pkce: true } });
    const member = await signUp('member');
    const otherMember = await signUp('other-member');
    const verifier = new AccountAssertionVerifier({ issuer: `${baseURL}/api/auth`,
      audience: resource, jwksUrl: `${baseURL}/api/auth/jwks`,
      introspectUrl: `${baseURL}/api/auth/oauth2/introspect`,
      clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! });
    const assertion = (token: string) => new Request(`${resource}/v1/works`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` },
    });
    const introspect = async (token: string) => {
      const response = await fetch(`${baseURL}/api/auth/oauth2/introspect`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, client_id: verifierClient.client_id,
          client_secret: verifierClient.client_secret! }),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<Record<string, unknown>>;
    };
    const issueWithConsent = async (clientId: string, account = member,
      scope = 'openid work:create offline_access') => {
      const pkceVerifier = randomBytes(32).toString('base64url');
      const authorize = new URL(`${baseURL}/api/auth/oauth2/authorize`);
      for (const [key, value] of Object.entries({ response_type: 'code',
        client_id: clientId, redirect_uri: callback,
        scope, prompt: 'consent', state: randomUUID(), resource,
        code_challenge: createHash('sha256').update(pkceVerifier).digest('base64url'),
        code_challenge_method: 'S256' })) authorize.searchParams.set(key, value);
      const prompt = await fetch(authorize, {
        headers: { cookie: account.cookie }, redirect: 'manual' });
      expect(prompt.status).toBe(302);
      const consentURL = new URL(prompt.headers.get('location')!, baseURL);
      expect(consentURL.pathname).toBe('/consent');
      const accepted = await fetch(`${baseURL}/api/auth/oauth2/consent`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/json', cookie: account.cookie, origin: baseURL },
        body: JSON.stringify({ accept: true, oauth_query: consentURL.searchParams.toString() }),
      });
      expect(accepted.status).toBe(200);
      const destination = await accepted.json() as { redirect: boolean; url: string };
      expect(destination.redirect).toBe(true);
      const code = new URL(destination.url).searchParams.get('code');
      expect(code).toBeTruthy();
      const exchange = await fetch(`${baseURL}/api/auth/oauth2/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code',
          client_id: clientId, code: code!, redirect_uri: callback,
          code_verifier: pkceVerifier, resource }),
      });
      expect(exchange.status).toBe(200);
      const tokens = await exchange.json() as { access_token: string; refresh_token: string };
      expect(tokens.refresh_token).toBeTruthy();
      return tokens;
    };
    const consentFor = async (clientId: string, account = member,
      expectedScopes = ['work:create', 'offline_access']) => {
      const response = await fetch(`${baseURL}/api/auth/oauth2/get-consents`, {
        headers: { cookie: account.cookie } });
      expect(response.status).toBe(200);
      const consents = await response.json() as Array<{
        id: string; clientId: string; userId: string; scopes: string[] }>;
      const consent = consents.find(item => item.clientId === clientId);
      expect(consent).toMatchObject({ userId: account.id,
        scopes: expect.arrayContaining(expectedScopes) });
      return consent!.id;
    };
    const generationFor = async (id: string) => {
      const current = await pool.query<{ generation: string }>(
        'SELECT "rezicsGeneration"::text AS generation FROM "oauthConsent" WHERE id = $1', [id]);
      return current.rows[0]?.generation;
    };
    const deleteConsent = (id: string, account = member) =>
      fetch(`${baseURL}/api/auth/oauth2/delete-consent`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        cookie: account.cookie, origin: baseURL },
      body: JSON.stringify({ id }),
    });
    const refresh = (clientId: string, token: string, scope?: string) =>
      fetch(`${baseURL}/api/auth/oauth2/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId,
          refresh_token: token, resource, ...(scope ? { scope } : {}) }),
      });
    const original = await issueWithConsent(consentingClient.client_id);
    const peer = await issueWithConsent(peerClient.client_id);
    const other = await issueWithConsent(consentingClient.client_id, otherMember);
    const firstConsent = await consentFor(consentingClient.client_id);
    const peerConsent = await consentFor(peerClient.client_id);
    const otherConsent = await consentFor(consentingClient.client_id, otherMember);
    expect(firstConsent).not.toBe(peerConsent);
    expect(firstConsent).not.toBe(otherConsent);
    expect((await deleteConsent(otherConsent)).status).toBe(401);
    const firstGeneration = await generationFor(firstConsent);
    expect(firstGeneration).toBeTruthy();
    expect(await introspect(original.access_token)).toMatchObject({
      active: true, sub: member.id, client_id: consentingClient.client_id,
      rezics_auth_mode: 'consent', rezics_consent_id: firstConsent,
      rezics_consent_generation: firstGeneration,
    });
    expect((await verifier.verify(assertion(original.access_token), ['work:create'])).subject)
      .toBe(member.id);
    expect((await verifier.verify(assertion(peer.access_token), ['work:create'])).subject)
      .toBe(member.id);
    expect((await verifier.verify(assertion(other.access_token), ['work:create'])).subject)
      .toBe(otherMember.id);
    const bound = await pool.query<{ rezicsConsentId: string; generation: string }>(
      'SELECT "rezicsConsentId", "rezicsConsentGeneration"::text AS generation FROM "oauthRefreshToken" WHERE "userId" = $1 AND "clientId" = $2',
      [member.id, consentingClient.client_id]);
    expect(bound.rows[0]?.rezicsConsentId).toBe(firstConsent);
    expect(bound.rows[0]?.generation).toBe(firstGeneration);
    const widened = await refresh(consentingClient.client_id, original.refresh_token,
      'work:create work:edit');
    expect(widened.status).toBe(400);
    expect(await widened.json()).toMatchObject({ error: 'invalid_scope' });
    const rotatedResponse = await refresh(consentingClient.client_id, original.refresh_token);
    expect(rotatedResponse.status).toBe(200);
    const rotated = await rotatedResponse.json() as { access_token: string; refresh_token: string };
    expect((await verifier.verify(assertion(rotated.access_token), ['work:create'])).subject)
      .toBe(member.id);
    const family = await pool.query<{ rezicsConsentId: string; generation: string }>(
      'SELECT "rezicsConsentId", "rezicsConsentGeneration"::text AS generation FROM "oauthRefreshToken" WHERE "userId" = $1 AND "clientId" = $2',
      [member.id, consentingClient.client_id]);
    expect(family.rows.length).toBe(2);
    expect(family.rows.every(row => row.rezicsConsentId === firstConsent
      && row.generation === firstGeneration)).toBe(true);

    // The provider's direct update endpoint can widen scopes up to the client
    // registration without a fresh authorization/consent round trip.
    const directUpdate = await fetch(`${baseURL}/api/auth/oauth2/update-consent`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        cookie: member.cookie, origin: baseURL },
      body: JSON.stringify({ id: firstConsent,
        update: { scopes: ['openid', 'work:create', 'work:edit', 'offline_access'] } }),
    });
    expect(directUpdate.status).toBe(403);
    expect(await generationFor(firstConsent)).toBe(firstGeneration);

    // Explicit re-consent mutates the same provider row. Both narrowing and
    // widening must replace its generation, never reactivate an old family.
    const narrowed = await issueWithConsent(consentingClient.client_id, member,
      'openid offline_access');
    expect(await consentFor(consentingClient.client_id, member,
      ['openid', 'offline_access'])).toBe(firstConsent);
    const narrowedScopes = await pool.query<{ scopes: string[] }>(
      'SELECT scopes FROM "oauthConsent" WHERE id = $1', [firstConsent]);
    expect(narrowedScopes.rows[0]?.scopes).not.toContain('work:create');
    const narrowGeneration = await generationFor(firstConsent);
    expect(narrowGeneration).not.toBe(firstGeneration);
    expect(await introspect(original.access_token)).toEqual({ active: false });
    expect(await introspect(rotated.access_token)).toEqual({ active: false });
    expect((await refresh(consentingClient.client_id, rotated.refresh_token)).ok).toBe(false);
    expect(await introspect(narrowed.access_token)).toMatchObject({
      active: true, rezics_consent_generation: narrowGeneration,
    });
    await expect(verifier.verify(assertion(narrowed.access_token), ['work:create']))
      .rejects.toBeInstanceOf(AccountAssertionDenied);

    const widenedConsent = await issueWithConsent(consentingClient.client_id);
    expect(await consentFor(consentingClient.client_id)).toBe(firstConsent);
    const wideGeneration = await generationFor(firstConsent);
    expect(wideGeneration).not.toBe(narrowGeneration);
    expect(wideGeneration).not.toBe(firstGeneration);
    expect(await introspect(original.access_token)).toEqual({ active: false });
    expect(await introspect(rotated.access_token)).toEqual({ active: false });
    expect(await introspect(narrowed.access_token)).toEqual({ active: false });
    expect((await refresh(consentingClient.client_id, narrowed.refresh_token)).ok).toBe(false);
    expect((await refresh(consentingClient.client_id, rotated.refresh_token)).ok).toBe(false);
    expect((await verifier.verify(assertion(widenedConsent.access_token), ['work:create'])).subject)
      .toBe(member.id);

    expect((await deleteConsent(firstConsent)).status).toBe(200);
    expect((await pool.query('SELECT id FROM "oauthConsent" WHERE id = $1',
      [firstConsent])).rowCount).toBe(0);
    expect(await introspect(original.access_token)).toEqual({ active: false });
    await expect(verifier.verify(assertion(original.access_token), ['work:create']))
      .rejects.toBeInstanceOf(AccountAssertionDenied);
    await expect(verifier.verify(assertion(rotated.access_token), ['work:create']))
      .rejects.toBeInstanceOf(AccountAssertionDenied);
    await expect(verifier.verify(assertion(widenedConsent.access_token), ['work:create']))
      .rejects.toBeInstanceOf(AccountAssertionDenied);
    expect((await verifier.verify(assertion(peer.access_token), ['work:create'])).subject)
      .toBe(member.id);
    expect((await verifier.verify(assertion(other.access_token), ['work:create'])).subject)
      .toBe(otherMember.id);
    expect((await refresh(consentingClient.client_id, original.refresh_token)).ok).toBe(false);
    expect((await refresh(consentingClient.client_id, rotated.refresh_token)).ok).toBe(false);
    expect((await refresh(consentingClient.client_id, widenedConsent.refresh_token)).ok).toBe(false);
    expect((await refresh(peerClient.client_id, peer.refresh_token)).status).toBe(200);

    // New consent has a new basis. The old family's refresh cannot inherit it.
    const renewed = await issueWithConsent(consentingClient.client_id);
    const secondConsent = await consentFor(consentingClient.client_id);
    expect(secondConsent).not.toBe(firstConsent);
    expect((await verifier.verify(assertion(renewed.access_token), ['work:create'])).subject)
      .toBe(member.id);
    expect((await refresh(consentingClient.client_id, rotated.refresh_token)).ok).toBe(false);

    // Either a concurrent refresh commits first and is fenced by the later
    // delete, or the delete commits first and the refresh fails closed.
    const [deleted, racingRefresh] = await Promise.all([
      deleteConsent(secondConsent), refresh(consentingClient.client_id, renewed.refresh_token),
    ]);
    expect(deleted.status).toBe(200);
    if (racingRefresh.ok) {
      const raced = await racingRefresh.json() as { access_token: string; refresh_token: string };
      await expect(verifier.verify(assertion(raced.access_token), ['work:create']))
        .rejects.toBeInstanceOf(AccountAssertionDenied);
      expect((await refresh(consentingClient.client_id, raced.refresh_token)).ok).toBe(false);
    }
    await expect(verifier.verify(assertion(renewed.access_token), ['work:create']))
      .rejects.toBeInstanceOf(AccountAssertionDenied);
  } finally {
    await app?.stop();
    await pool.end();
    execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { cwd: state });
    rmSync(state, { recursive: true, force: true });
  }
}, 120_000);
