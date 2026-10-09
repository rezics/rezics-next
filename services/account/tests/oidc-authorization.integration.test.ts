import { expect, test } from 'bun:test';
import { signupPolicyFixture } from './account-fixture.ts';
import { postToken, prepareAuthorization } from '../../../scripts/lib/oauth-client.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { getMigrations } from 'better-auth/db/migration';
import { Elysia } from 'elysia';
import { Pool } from 'pg';
import { startPostgresCluster } from '../../../tests/qa/support/postgres-cluster.ts';
import { accountAuthOptions, createAccountAuth } from '../src/auth.ts';
import { createAccountApp } from '../src/app.ts';
import { installConsentRefreshFence } from '../src/consent-fence.ts';
import { AccountAssertionDenied, AccountAssertionVerifier }
  from '../../main/src/modules/account/verify-assertion.ts';

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

type Tokens = { access_token: string; refresh_token: string };

test('IAM02: invalid OIDC requests and swapped two-client exchanges leave pending codes and Account authority unchanged', async () => {
  const cluster = await startPostgresCluster();
  const pool = new Pool({ ...cluster.connection });
  const accountPort = await freePort();
  const base = `http://127.0.0.1:${accountPort}`;
  const issuer = `${base}/api/auth`;
  const operators = new Set<string>();
  const config = { requireEmailVerification: false, baseURL: base, resource, pool, operatorUserIds: operators,
    secret: 'oidc-authorization-local-secret-32-plus-chars' };
  let account: ReturnType<typeof createAccountApp> | undefined;
  const clients: { stop: () => unknown }[] = [];
  try {
    await (await getMigrations(accountAuthOptions(config))).runMigrations();
    await installConsentRefreshFence(pool);
    const auth = createAccountAuth(config);
    account = createAccountApp(auth, pool).listen({ hostname: '127.0.0.1', port: accountPort });
    const signUp = async (name: string) => {
      const response = await fetch(`${base}/api/auth/sign-up/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ ...signupPolicyFixture, name, email: `${name}-${randomUUID()}@example.test`,
          password: randomBytes(24).toString('base64url') }),
      });
      expect(response.status).toBe(200);
      return { id: (await response.json() as { user: { id: string } }).user.id,
        cookie: response.headers.get('set-cookie')! };
    };
    const operator = await signUp('operator');
    operators.add(operator.id);
    const headers = new Headers({ cookie: operator.cookie, origin: base });
    const introspector = await auth.api.adminCreateOAuthClient({ headers,
      body: { client_name: 'IAM02 introspection', scope: 'work:create',
        token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
        client_credentials_scopes: ['work:create'] } });
    const member = await signUp('member');

    // Each registered product is a separate relying party with its own
    // callback, login-transaction store and cookie. It, rather than Account,
    // owns callback state and issuer validation. Native loopback redirects
    // match on any port (RFC 8252 section 7.3), so the path names the product.
    const relyingParty = async (name: string) => {
      const port = await freePort();
      const origin = `http://127.0.0.1:${port}`;
      const callback = `${origin}/${name}/callback`;
      const registration = await auth.api.adminCreateOAuthClient({ headers,
        body: { client_name: `IAM02 ${name}`, application_type: 'native',
          redirect_uris: [callback], token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code'], scope: 'openid work:create agent:create offline_access',
          subject_type: 'public', require_pkce: true } });
      const cookieName = `${name}_session`;
      const pending = new Map<string, { state: string; verifier: string }>();
      const issued = new Map<string, Tokens>();
      clients.push(new Elysia()
        .get('/start', ({ request }) => {
          const id = randomUUID();
          const state = randomBytes(24).toString('base64url');
          const prepared = prepareAuthorization({ account: base, clientId: registration.client_id,
            redirectUri: callback, scope: 'openid work:create agent:create offline_access', resource },
          { state, ...(new URL(request.url).searchParams.has('consent') ? { prompt: 'consent' } : {}) });
          pending.set(id, { state, verifier: prepared.verifier });
          return new Response(null, { status: 302, headers: { location: prepared.url.toString(),
            'set-cookie': `${cookieName}=${id}; HttpOnly; SameSite=Lax; Path=/` } });
        })
        .get(`/${name}/callback`, async ({ request }) => {
          const id = new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`)
            .exec(request.headers.get('cookie') ?? '')?.[1];
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
          const exchange = await postToken({ account: base, clientId: registration.client_id,
            redirectUri: callback, scope: 'openid work:create agent:create offline_access', resource },
          { grant_type: 'authorization_code', client_id: registration.client_id, code: codeValues[0],
            redirect_uri: callback, code_verifier: transaction.verifier, resource });
          if (exchange.status !== 200) return Response.json({ error: 'token_denied' }, { status: 502 });
          issued.set(id!, await exchange.json() as Tokens);
          return new Response(null, { status: 204 });
        })
        .listen({ hostname: '127.0.0.1', port }));
      return { name, callback, clientId: registration.client_id, origin, pending, issued };
    };
    type RelyingParty = Awaited<ReturnType<typeof relyingParty>>;
    const alpha = await relyingParty('alpha');
    const beta = await relyingParty('beta');
    expect(alpha.clientId).not.toBe(beta.clientId);

    const begin = async (rp: RelyingParty, consent = false) => {
      const started = await fetch(`${rp.origin}/start${consent ? '?consent' : ''}`,
        { redirect: 'manual' });
      expect(started.status).toBe(302);
      const cookie = started.headers.get('set-cookie')!.split(';', 1)[0]!;
      const id = cookie.slice(cookie.indexOf('=') + 1);
      return { rp, id, cookie, authorize: new URL(started.headers.get('location')!),
        ...rp.pending.get(id)! };
    };
    const callback = (location: URL, cookie?: string) =>
      fetch(location, cookie ? { headers: { cookie } } : undefined);
    const introspect = async (value: string) => fetch(`${base}/api/auth/oauth2/introspect`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: value,
        client_id: introspector.client_id, client_secret: introspector.client_secret! }),
    }).then(response => response.json() as Promise<Record<string, unknown>>);
    const expectActive = async (tokens: Tokens, rp: RelyingParty) => {
      const current = await introspect(tokens.access_token);
      expect(current).toMatchObject({ active: true,
        iss: issuer, sub: member.id, client_id: rp.clientId });
      expect(current).not.toHaveProperty('rezics_account_name');
      expect(current).not.toHaveProperty('name');
    };

    // The first authorization of each client passes through explicit consent.
    const consented = async (rp: RelyingParty) => {
      const transaction = await begin(rp, true);
      const authorized = await fetch(transaction.authorize, {
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
      const location = new URL((await consent.json() as { url: string }).url);
      expect(location.origin + location.pathname).toBe(rp.callback);
      expect((await callback(location, transaction.cookie)).status).toBe(204);
      const tokens = rp.issued.get(transaction.id)!;
      expect(tokens.access_token).toBeTruthy();
      expect(tokens.refresh_token).toBeTruthy();
      await expectActive(tokens, rp);
      return { ...transaction, code: location.searchParams.get('code')!, tokens };
    };
    const alphaFirst = await consented(alpha);
    const betaFirst = await consented(beta);
    const session = await fetch(`${base}/api/auth/get-session`, { headers: { cookie: member.cookie } });
    expect((await session.json() as { user: { id: string } }).user.id).toBe(member.id);

    // Durable Account authority: the member's credentials, sessions, consents
    // and token families, every registered client, and every pending code with
    // its retained issuance basis.
    const digest = async (table: string, filter = 'true', values: unknown[] = []) =>
      (await pool.query<{ digest: string }>(
        `SELECT md5(coalesce(string_agg(md5(to_jsonb(t)::text), ',' ORDER BY t.id), '')) AS digest
         FROM "${table}" t WHERE ${filter}`, values)).rows[0]!.digest;
    const authority = async () => Object.fromEntries(await Promise.all([
      ...['user', 'account', 'session', 'oauthConsent', 'oauthAccessToken', 'oauthRefreshToken']
        .map(async table => [table,
          await digest(table, table === 'user' ? 'id = $1' : '"userId" = $1', [member.id])] as const),
      ...['oauthClient', 'verification', 'rezics_oauth_code_basis']
        .map(async table => [table, await digest(table)] as const),
    ]));
    const codeId = (code: string) => createHash('sha256').update(code).digest('base64url');
    const pendingCode = async (code: string) => (await pool.query<{ row: string }>(
      `SELECT to_jsonb(v)::text AS row FROM verification v WHERE identifier = $1`,
      [codeId(code)])).rows.map(row => row.row);
    const sessionIsCurrent = async () => {
      const response = await fetch(`${base}/api/auth/get-session`, {
        headers: { cookie: member.cookie } });
      expect(response.status).toBe(200);
      expect((await response.json() as { user: { id: string } }).user.id).toBe(member.id);
    };
    const unchanged = async (attempt: () => Promise<void>) => {
      const before = await authority();
      await attempt();
      expect(await authority()).toEqual(before);
      await sessionIsCurrent();
      await expectActive(alphaFirst.tokens, alpha);
      await expectActive(betaFirst.tokens, beta);
    };

    const badAuthorize = async (start: URL, mutate: (url: URL) => void, expectedStatus: number,
      expectedError: string) => {
      const url = new URL(start);
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
    for (const [owner, other] of [[alpha, beta], [beta, alpha]] as const) {
      const { authorize } = await begin(owner);
      await unchanged(async () => {
        await badAuthorize(authorize, url => url.searchParams.delete('state'), 400, 'invalid_request');
        await badAuthorize(authorize, url => url.searchParams.append('state', 'attacker'),
          400, 'invalid_request');
        await badAuthorize(authorize, url => url.searchParams.set('state', ''), 400, 'invalid_request');
      });
      await unchanged(async () => {
        const target = await badAuthorize(authorize, url => url.searchParams.set('resource',
          'https://wrong-audience.example.test'), 302, 'invalid_target');
        expect(target!.origin + target!.pathname).toBe(owner.callback);
      });
      await unchanged(async () => {
        for (const redirect of [
          other.callback,
          `${owner.callback}.attacker.example.test`,
          `${owner.callback}?next=https://attacker.example.test`,
          'https://unregistered.example.test/callback',
        ]) {
          const target = await badAuthorize(authorize, url => url.searchParams.set('redirect_uri', redirect),
            302, 'invalid_redirect');
          expect(target!.origin + target!.pathname).toBe(`${base}/api/auth/error`);
        }
        // The other client's ID cannot borrow this client's registered redirect.
        const target = await badAuthorize(authorize, url => url.searchParams.set('client_id', other.clientId),
          302, 'invalid_redirect');
        expect(target!.origin + target!.pathname).toBe(`${base}/api/auth/error`);
      });
    }

    const verifierConfig = { issuer, audience: resource, jwksUrl: `${base}/api/auth/jwks`,
      introspectUrl: `${base}/api/auth/oauth2/introspect`,
      clientId: introspector.client_id, clientSecret: introspector.client_secret! };
    for (const tokens of [alphaFirst.tokens, betaFirst.tokens]) {
      const assertion = new Request(`${resource}/v1/works`, {
        headers: { authorization: `Bearer ${tokens.access_token}` } });
      const principal = await new AccountAssertionVerifier(verifierConfig)
        .verify(assertion, ['work:create']);
      expect(principal).toMatchObject({ subject: member.id });
      expect(principal).not.toHaveProperty('accountDisplayName');
      await unchanged(async () => {
        for (const mismatch of [
          { issuer: 'https://wrong-issuer.example.test' },
          { audience: 'https://wrong-audience.example.test' },
        ]) {
          await expect(new AccountAssertionVerifier({ ...verifierConfig, ...mismatch })
            .verify(assertion, ['work:create'])).rejects.toBeInstanceOf(AccountAssertionDenied);
        }
      });
    }

    const authorizeCode = async (rp: RelyingParty) => {
      const transaction = await begin(rp);
      const response = await fetch(transaction.authorize, {
        headers: { cookie: member.cookie }, redirect: 'manual' });
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get('location')!);
      expect(location.origin + location.pathname).toBe(rp.callback);
      const code = location.searchParams.get('code')!;
      expect(code).toBeTruthy();
      return { ...transaction, location, code };
    };
    const token = (params: Record<string, string>) => postToken({ account: base,
      clientId: params.client_id ?? '', redirectUri: params.redirect_uri ?? '', scope: '', resource },
    { grant_type: 'authorization_code', resource, ...params });
    type Pending = Awaited<ReturnType<typeof authorizeCode>>;
    const redeem = (pending: Pending, params: Record<string, string> = {}) => token({
      client_id: pending.rp.clientId, redirect_uri: pending.rp.callback, code: pending.code,
      code_verifier: pending.verifier, ...params });
    const rejected = async (response: Response, status: number, error: string) => {
      expect(response.status).toBe(status);
      expect((await response.json() as { error: string }).error).toBe(error);
    };
    const refresh = (rp: RelyingParty, value: string) => postToken({ account: base, clientId: rp.clientId,
      redirectUri: rp.callback, scope: '', resource }, { grant_type: 'refresh_token', client_id: rp.clientId,
      refresh_token: value, resource });
    const redeemed: [RelyingParty, Tokens][] = [[alpha, alphaFirst.tokens], [beta, betaFirst.tokens]];

    for (const [owner, other] of [[alpha, beta], [beta, alpha]] as const) {
      const held = await authorizeCode(owner);
      const otherHeld = await authorizeCode(other);
      // A valid login transaction at the other product, never sent to Account.
      const otherTransaction = await begin(other);
      const heldRow = await pendingCode(held.code);
      const otherRow = await pendingCode(otherHeld.code);
      expect(heldRow).toHaveLength(1);
      expect(otherRow).toHaveLength(1);
      const withParams = (location: URL, params: Record<string, string | null>) => {
        const url = new URL(location);
        for (const [key, value] of Object.entries(params)) {
          if (value === null) url.searchParams.delete(key);
          else url.searchParams.set(key, value);
        }
        return url;
      };
      const atOther = (location: URL) => {
        const url = new URL(other.callback);
        url.search = location.search;
        return url;
      };
      await unchanged(async () => {
        for (const [location, cookie] of [
          [withParams(held.location, { state: 'attacker-state' }), held.cookie],
          [withParams(held.location, { state: null }), held.cookie],
          [withParams(held.location, { iss: 'https://wrong-issuer.example.test' }), held.cookie],
          [held.location, undefined],
          // Swapped state and cookies between the two registered products.
          [withParams(held.location, { state: otherHeld.state }), held.cookie],
          [held.location, otherHeld.cookie],
          [atOther(held.location), otherHeld.cookie],
          [atOther(held.location), held.cookie],
        ] as const) {
          expect((await callback(location, cookie)).status).toBe(400);
        }
        // Even with a valid transaction at the other product, Account binds
        // this code to its client and denies the other product's exchange.
        expect((await callback(atOther(withParams(held.location, { state: otherTransaction.state })),
          otherTransaction.cookie)).status).toBe(502);
      });
      expect(other.pending.has(otherTransaction.id)).toBe(false);
      expect(await pendingCode(held.code)).toEqual(heldRow);
      await unchanged(async () => {
        await rejected(await redeem(held, { client_id: other.clientId }), 400, 'invalid_grant');
        await rejected(await redeem(held, { client_id: other.clientId,
          redirect_uri: other.callback, code_verifier: otherHeld.verifier }), 400, 'invalid_grant');
        await rejected(await redeem(held, { redirect_uri: other.callback }), 400, 'invalid_grant');
        await rejected(await redeem(held, {
          redirect_uri: 'https://unregistered.example.test/callback' }), 400, 'invalid_grant');
        await rejected(await redeem(held, { code_verifier: otherHeld.verifier }), 401, 'invalid_request');
        await rejected(await redeem(held, {
          code_verifier: randomBytes(32).toString('base64url') }), 401, 'invalid_request');
        await rejected(await redeem(held, { resource: 'https://wrong-audience.example.test' }),
          400, 'invalid_target');
        await rejected(await redeem(held, { client_secret: randomBytes(24).toString('base64url') }),
          400, 'invalid_client');
        await rejected(await redeem(held, { code_verifier: '' }), 400, 'invalid_request');
        // The other product's own pending code is equally bound to it.
        await rejected(await redeem(otherHeld, { client_id: owner.clientId,
          redirect_uri: owner.callback }), 400, 'invalid_grant');
      });
      expect(await pendingCode(held.code)).toEqual(heldRow);
      expect(await pendingCode(otherHeld.code)).toEqual(otherRow);

      // Both legitimate clients still redeem their own pending code once.
      expect((await callback(held.location, held.cookie)).status).toBe(204);
      expect((await callback(otherHeld.location, otherHeld.cookie)).status).toBe(204);
      for (const pending of [held, otherHeld]) {
        const tokens = pending.rp.issued.get(pending.id)!;
        await expectActive(tokens, pending.rp);
        expect(await pendingCode(pending.code)).toEqual([]);
        redeemed.push([pending.rp, tokens]);
      }
      // A redeemed code or callback cannot mint again or disturb the issued family.
      await unchanged(async () => {
        expect((await callback(held.location, held.cookie)).status).toBe(400);
        await rejected(await redeem(held), 400, 'invalid_grant');
        await rejected(await redeem(otherHeld), 400, 'invalid_grant');
        await rejected(await redeem(held, { client_id: other.clientId }), 400, 'invalid_grant');
        await rejected(await token({ client_id: owner.clientId, redirect_uri: owner.callback,
          code: owner === alpha ? alphaFirst.code : betaFirst.code,
          code_verifier: owner === alpha ? alphaFirst.verifier : betaFirst.verifier }),
        400, 'invalid_grant');
      });
    }

    // Serialized concurrent exchanges: a rejected presenter queued ahead of
    // the legitimate client restores the code before the client's exchange.
    const lockHolder = await pool.connect();
    try {
      const contested = await authorizeCode(alpha);
      const contestedRow = await pendingCode(contested.code);
      await lockHolder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))',
        [codeId(contested.code)]);
      const waiting = async (count: number) => {
        for (let attempt = 0; attempt < 200; attempt++) {
          const waiters = await pool.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`);
          if (waiters.rows[0]!.count === count) return;
          await Bun.sleep(10);
        }
        throw new Error(`advisory lock waiters did not reach ${count}`);
      };
      const before = await authority();
      const attacker = redeem(contested, { client_id: beta.clientId });
      await waiting(1);
      const wrongVerifier = redeem(contested, { code_verifier: randomBytes(32).toString('base64url') });
      await waiting(2);
      const legitimate = redeem(contested);
      await waiting(3);
      await lockHolder.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))',
        [codeId(contested.code)]);
      await rejected(await attacker, 400, 'invalid_grant');
      await rejected(await wrongVerifier, 401, 'invalid_request');
      const legitimateResponse = await legitimate;
      expect(legitimateResponse.status).toBe(200);
      const contestedTokens = await legitimateResponse.json() as Tokens;
      await expectActive(contestedTokens, alpha);
      redeemed.push([alpha, contestedTokens]);
      expect(contestedRow).toHaveLength(1);
      expect(await pendingCode(contested.code)).toEqual([]);
      const after = await authority();
      for (const table of ['user', 'account', 'session', 'oauthConsent', 'oauthClient']) {
        expect(after[table]).toBe(before[table]!);
      }
    } finally {
      lockHolder.release();
    }

    // Two legitimate presentations race: exactly one mints tokens.
    const concurrent = await authorizeCode(alpha);
    const exchanges = await Promise.all([redeem(concurrent), redeem(concurrent)]);
    expect(exchanges.map(response => response.status).sort()).toEqual([200, 400]);
    await rejected(exchanges.find(response => response.status === 400)!, 400, 'invalid_grant');
    const concurrentTokens = await exchanges.find(response => response.status === 200)!
      .json() as Tokens;
    await expectActive(concurrentTokens, alpha);
    redeemed.push([alpha, concurrentTokens]);

    const refreshTokens = await pool.query<{ clientId: string; count: number }>(
      `SELECT "clientId", count(*)::int AS count FROM "oauthRefreshToken"
       WHERE "userId" = $1 GROUP BY "clientId"`, [member.id]);
    expect(Object.fromEntries(refreshTokens.rows.map(row => [row.clientId, row.count])))
      .toEqual({ [alpha.clientId]: 5, [beta.clientId]: 3 });
    for (const [rp, tokens] of redeemed) {
      const response = await refresh(rp, tokens.refresh_token);
      expect(response.status).toBe(200);
      expect((await response.json() as { access_token: string }).access_token).toBeTruthy();
    }
  } finally {
    try {
      await Promise.all(clients.map(client => client.stop()));
      await account?.stop();
      await pool.end();
    } finally { cluster.remove(); }
  }
}, 120_000);
