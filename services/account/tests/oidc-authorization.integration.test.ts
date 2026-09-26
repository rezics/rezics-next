import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { getMigrations } from 'better-auth/db/migration';
import { Elysia } from 'elysia';
import { Pool } from 'pg';
import { accountAuthOptions, createAccountAuth } from '../src/auth.ts';
import { createAccountApp } from '../src/app.ts';
import { installConsentRefreshFence } from '../src/consent-fence.ts';
import { AccountAssertionDenied, AccountAssertionVerifier }
  from '../../main/src/modules/account/verify-assertion.ts';

const root = resolve(import.meta.dir, '../../..');
const resource = 'https://main.rezics.test';

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

test('IAM02: invalid OIDC requests and callback replay leave Account authority unchanged', async () => {
  const state = join(root, '.temp', `oidc-authorization-${randomUUID()}`);
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
  const clientPort = await freePort();
  const base = `http://127.0.0.1:${accountPort}`;
  const issuer = `${base}/api/auth`;
  const clientBase = `http://127.0.0.1:${clientPort}`;
  const callback = `${clientBase}/callback`;
  const operators = new Set<string>();
  const config = { baseURL: base, resource, pool, operatorUserIds: operators,
    secret: 'oidc-authorization-local-secret-32-plus-chars' };
  let account: ReturnType<typeof createAccountApp> | undefined;
  let client: { stop: () => unknown } | undefined;
  try {
    await (await getMigrations(accountAuthOptions(config))).runMigrations();
    await installConsentRefreshFence(pool);
    const auth = createAccountAuth(config);
    account = createAccountApp(auth, pool).listen({ hostname: '127.0.0.1', port: accountPort });
    const signUp = async (name: string) => {
      const response = await fetch(`${base}/api/auth/sign-up/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ name, email: `${name}-${randomUUID()}@example.test`,
          password: randomBytes(24).toString('base64url') }),
      });
      expect(response.status).toBe(200);
      return { id: (await response.json() as { user: { id: string } }).user.id,
        cookie: response.headers.get('set-cookie')! };
    };
    const operator = await signUp('operator');
    operators.add(operator.id);
    const headers = new Headers({ cookie: operator.cookie, origin: base });
    const rp = await auth.api.adminCreateOAuthClient({ headers,
      body: { client_name: 'Registered IAM02 probe', application_type: 'native',
        redirect_uris: [callback], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], scope: 'openid work:create offline_access',
        subject_type: 'public', require_pkce: true } });
    const introspector = await auth.api.adminCreateOAuthClient({ headers,
      body: { client_name: 'IAM02 introspection', scope: 'work:create',
        token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
        client_credentials_scopes: ['work:create'] } });
    const otherRp = await auth.api.adminCreateOAuthClient({ headers,
      body: { client_name: 'Other IAM02 client', application_type: 'native',
        redirect_uris: [callback], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code'], scope: 'openid work:create offline_access',
        subject_type: 'public', require_pkce: true } });
    const member = await signUp('member');
    const pending = new Map<string, { state: string; verifier: string }>();
    const issued = new Map<string, { access_token: string; refresh_token: string }>();
    client = new Elysia()
      .get('/start', ({ request }) => {
        const id = randomUUID();
        const state = randomBytes(24).toString('base64url');
        const verifier = randomBytes(32).toString('base64url');
        pending.set(id, { state, verifier });
        const url = new URL(`${base}/api/auth/oauth2/authorize`);
        for (const [key, value] of Object.entries({ response_type: 'code',
          client_id: rp.client_id, redirect_uri: callback,
          scope: 'openid work:create offline_access', state, resource,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256' })) url.searchParams.set(key, value);
        if (new URL(request.url).searchParams.has('consent')) url.searchParams.set('prompt', 'consent');
        return new Response(null, { status: 302,
          headers: { location: url.toString(), 'set-cookie': `rp_session=${id}; HttpOnly; SameSite=Lax; Path=/` } });
      })
      .get('/callback', async ({ request }) => {
        const id = /(?:^|;\s*)rp_session=([^;]+)/.exec(request.headers.get('cookie') ?? '')?.[1];
        const transaction = id ? pending.get(id) : undefined;
        const url = new URL(request.url);
        const stateValues = url.searchParams.getAll('state');
        const issuerValues = url.searchParams.getAll('iss');
        const codeValues = url.searchParams.getAll('code');
        if (!transaction || stateValues.length !== 1 || stateValues[0] !== transaction.state
          || issuerValues.length !== 1 || issuerValues[0] !== issuer
          || codeValues.length !== 1 || !codeValues[0]) {
          return Response.json({ error: 'invalid_callback' }, { status: 400 });
        }
        pending.delete(id!);
        const exchange = await fetch(`${base}/api/auth/oauth2/token`, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code',
            client_id: rp.client_id, code: codeValues[0], redirect_uri: callback,
            code_verifier: transaction.verifier, resource }),
        });
        if (exchange.status !== 200) return Response.json({ error: 'token_denied' }, { status: 502 });
        issued.set(id!, await exchange.json() as { access_token: string; refresh_token: string });
        return new Response(null, { status: 204 });
      })
      .listen({ hostname: '127.0.0.1', port: clientPort });
    const start = await fetch(`${clientBase}/start?consent`, { redirect: 'manual' });
    expect(start.status).toBe(302);
    const clientCookie = start.headers.get('set-cookie')!;
    const authorize = new URL(start.headers.get('location')!);
    const authorized = await fetch(authorize, {
      headers: { cookie: member.cookie }, redirect: 'manual' });
    expect(authorized.status).toBe(302);
    const consentURL = new URL(authorized.headers.get('location')!, base);
    expect(consentURL.pathname).toBe('/consent');
    const consent = await fetch(`${base}/api/auth/oauth2/consent`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/json', cookie: member.cookie, origin: base },
      body: JSON.stringify({ accept: true, oauth_query: consentURL.searchParams.toString() }),
    });
    expect(consent.status).toBe(200);
    const location = (await consent.json() as { url: string }).url;
    expect(new URL(location).origin + new URL(location).pathname).toBe(callback);
    const rpSession = /rp_session=([^;]+)/.exec(clientCookie)![1]!;
    const firstVerifier = pending.get(rpSession)!.verifier;
    const firstCode = new URL(location).searchParams.get('code')!;
    const accepted = await fetch(location, { headers: { cookie: clientCookie } });
    expect(accepted.status).toBe(204);
    const tokens = issued.get(rpSession)!;
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.refresh_token).toBeTruthy();
    const introspect = async (value = tokens.access_token) => fetch(`${base}/api/auth/oauth2/introspect`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: value,
        client_id: introspector.client_id, client_secret: introspector.client_secret! }),
    });
    expect(await (await introspect()).json()).toMatchObject({ active: true,
      iss: issuer, sub: member.id, client_id: rp.client_id });
    const session = await fetch(`${base}/api/auth/get-session`, { headers: { cookie: member.cookie } });
    expect((await session.json() as { user: { id: string } }).user.id).toBe(member.id);
    const authority = async () => {
      const tables = ['user', 'account', 'session', 'oauthConsent', 'oauthAccessToken', 'oauthRefreshToken'];
      const digests = await Promise.all(tables.map(async table => {
        const filter = table === 'user' ? 'id = $1' : '"userId" = $1';
        const result = await pool.query<{ digest: string }>(
          `SELECT md5(coalesce(string_agg(md5(to_jsonb(t)::text), ',' ORDER BY t.id), '')) AS digest
           FROM "${table}" t WHERE ${filter}`, [member.id]);
        return [table, result.rows[0]!.digest] as const;
      }));
      return Object.fromEntries(digests);
    };
    const before = await authority();
    const wrongRedirect = new URL(authorize);
    wrongRedirect.searchParams.set('redirect_uri', 'https://unregistered.example.test/callback');
    const rejected = await fetch(wrongRedirect, {
      headers: { cookie: member.cookie }, redirect: 'manual' });
    expect(rejected.status).toBe(302);
    const rejection = new URL(rejected.headers.get('location')!);
    expect(rejection.origin + rejection.pathname).toBe(`${base}/api/auth/error`);
    expect(rejection.searchParams.get('error')).toBe('invalid_redirect');
    expect(rejection.searchParams.has('code')).toBe(false);
    expect(await authority()).toEqual(before);
    expect((await (await introspect()).json() as { active: boolean }).active).toBe(true);

    const token = (params: Record<string, string>) => fetch(`${base}/api/auth/oauth2/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: rp.client_id,
        redirect_uri: callback, resource, ...params }),
    });
    const sessionIsCurrent = async () => {
      const response = await fetch(`${base}/api/auth/get-session`, {
        headers: { cookie: member.cookie } });
      expect(response.status).toBe(200);
      expect((await response.json() as { user: { id: string } }).user.id).toBe(member.id);
    };
    const unchanged = async (attempt: () => Promise<void>) => {
      const state = await authority();
      await attempt();
      expect(await authority()).toEqual(state);
      await sessionIsCurrent();
      expect((await (await introspect()).json() as { active: boolean }).active).toBe(true);
    };
    const authorizeFresh = async () => {
      const fresh = await fetch(`${clientBase}/start`, { redirect: 'manual' });
      expect(fresh.status).toBe(302);
      const cookie = fresh.headers.get('set-cookie')!;
      const requested = new URL(fresh.headers.get('location')!);
      const response = await fetch(requested, {
        headers: { cookie: member.cookie }, redirect: 'manual' });
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get('location')!);
      expect(location.origin + location.pathname).toBe(callback);
      expect(location.searchParams.get('code')).toBeTruthy();
      const id = /rp_session=([^;]+)/.exec(cookie)![1]!;
      return { cookie, location, verifier: pending.get(id)!.verifier };
    };
    const badAuthorize = async (mutate: (url: URL) => void, expectedStatus: number,
      expectedError: string) => {
      const url = new URL(authorize);
      url.searchParams.delete('prompt');
      mutate(url);
      const response = await fetch(url, { headers: { cookie: member.cookie }, redirect: 'manual' });
      expect(response.status).toBe(expectedStatus);
      if (expectedStatus === 302) {
        const target = new URL(response.headers.get('location')!);
        expect(target.searchParams.get('error')).toBe(expectedError);
        expect(target.searchParams.has('code')).toBe(false);
        return target;
      }
      expect((await response.json() as { error: string }).error).toBe(expectedError);
      return null;
    };
    await unchanged(async () => {
      await badAuthorize(url => url.searchParams.delete('state'), 400, 'invalid_request');
      await badAuthorize(url => url.searchParams.append('state', 'attacker'), 400, 'invalid_request');
      await badAuthorize(url => url.searchParams.set('state', ''), 400, 'invalid_request');
    });
    await unchanged(async () => {
      const target = await badAuthorize(url => url.searchParams.set('resource',
        'https://wrong-audience.example.test'), 302, 'invalid_target');
      expect(target!.origin + target!.pathname).toBe(callback);
    });
    await unchanged(async () => {
      for (const redirect of [
        `${callback}.attacker.example.test`,
        `${callback}?next=https://attacker.example.test`,
        'https://unregistered.example.test/callback',
      ]) {
        const target = await badAuthorize(url => url.searchParams.set('redirect_uri', redirect),
          302, 'invalid_redirect');
        expect(target!.origin + target!.pathname).toBe(`${base}/api/auth/error`);
      }
    });
    const verifierConfig = { issuer, audience: resource, jwksUrl: `${base}/api/auth/jwks`,
      introspectUrl: `${base}/api/auth/oauth2/introspect`,
      clientId: introspector.client_id, clientSecret: introspector.client_secret! };
    const assertion = new Request(`${resource}/v1/works`, {
      headers: { authorization: `Bearer ${tokens.access_token}` } });
    expect((await new AccountAssertionVerifier(verifierConfig)
      .verify(assertion, ['work:create'])).subject).toBe(member.id);
    await unchanged(async () => {
      for (const mismatch of [
        { issuer: 'https://wrong-issuer.example.test' },
        { audience: 'https://wrong-audience.example.test' },
      ]) {
        await expect(new AccountAssertionVerifier({ ...verifierConfig, ...mismatch })
          .verify(assertion, ['work:create'])).rejects.toBeInstanceOf(AccountAssertionDenied);
      }
    });

    // The registered client, rather than Account, owns callback state and issuer
    // validation. Every rejected HTTP callback leaves its transaction redeemable.
    const pendingCode = await authorizeFresh();
    await unchanged(async () => {
      const wrongState = new URL(pendingCode.location);
      wrongState.searchParams.set('state', 'attacker-state');
      expect((await fetch(wrongState, { headers: { cookie: pendingCode.cookie } })).status).toBe(400);
      const missingState = new URL(pendingCode.location);
      missingState.searchParams.delete('state');
      expect((await fetch(missingState, { headers: { cookie: pendingCode.cookie } })).status).toBe(400);
      const wrongIssuer = new URL(pendingCode.location);
      wrongIssuer.searchParams.set('iss', 'https://wrong-issuer.example.test');
      expect((await fetch(wrongIssuer, { headers: { cookie: pendingCode.cookie } })).status).toBe(400);
      expect((await fetch(pendingCode.location)).status).toBe(400);
    });
    expect((await fetch(pendingCode.location, {
      headers: { cookie: pendingCode.cookie } })).status).toBe(204);
    await unchanged(async () => {
      expect((await fetch(pendingCode.location, {
        headers: { cookie: pendingCode.cookie } })).status).toBe(400);
    });
    await unchanged(async () => {
      const response = await token({ code: firstCode, code_verifier: firstVerifier });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toBe('invalid_grant');
    });
    const swapped = await authorizeFresh();
    await unchanged(async () => {
      const response = await token({ client_id: otherRp.client_id,
        code: swapped.location.searchParams.get('code')!, code_verifier: swapped.verifier });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toBe('invalid_grant');
    });
    const changedRedirect = await authorizeFresh();
    await unchanged(async () => {
      const response = await token({ code: changedRedirect.location.searchParams.get('code')!,
        code_verifier: changedRedirect.verifier,
        redirect_uri: 'https://unregistered.example.test/callback' });
      expect(response.status).toBe(400);
      expect((await response.json() as { error: string }).error).toBe('invalid_grant');
    });
    const invalidPkce = await authorizeFresh();
    await unchanged(async () => {
      const response = await token({ code: invalidPkce.location.searchParams.get('code')!,
        code_verifier: randomBytes(32).toString('base64url') });
      expect(response.status).toBe(401);
      expect((await response.json() as { error: string }).error).toBe('invalid_request');
    });
    const concurrent = await authorizeFresh();
    const concurrentCode = concurrent.location.searchParams.get('code')!;
    const exchanges = await Promise.all([token({ code: concurrentCode,
      code_verifier: concurrent.verifier }), token({ code: concurrentCode,
      code_verifier: concurrent.verifier })]);
    expect(exchanges.map(response => response.status).sort()).toEqual([200, 400]);
    const succeeded = exchanges.find(response => response.status === 200)!;
    const denied = exchanges.find(response => response.status === 400)!;
    expect((await denied.json() as { error: string }).error).toBe('invalid_grant');
    const concurrentTokens = await succeeded.json() as { access_token: string; refresh_token: string };
    expect((await (await introspect(concurrentTokens.access_token)).json() as { active: boolean }).active)
      .toBe(true);
    expect(concurrentTokens.refresh_token).toBeTruthy();
    const refresh = (value: string) => fetch(`${base}/api/auth/oauth2/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: rp.client_id,
        refresh_token: value, resource }),
    });
    for (const value of [tokens.refresh_token, concurrentTokens.refresh_token]) {
      const response = await refresh(value);
      expect(response.status).toBe(200);
      expect((await response.json() as { access_token: string }).access_token).toBeTruthy();
    }
  } finally {
    await client?.stop();
    await account?.stop();
    await pool.end();
    execFileSync('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop'], { cwd: state });
  }
}, 120_000);
