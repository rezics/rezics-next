import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { migrateContent } from '../../../services/content/src/migrate.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { sourceAcquisitionServices } from '../../../services/main/src/modules/source/acquisition.ts';
import { idOf, FixtureOpenLibrary } from './source-run-harness.ts';

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no Account port'));
      server.close(() => resolvePort(address.port));
    });
  });
}

test('PKG20: real Account scopes and Access admission fence Go source runs', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL || !Bun.env.ACCESS_DATABASE_URL
    || !Bun.env.ACCOUNT_DATABASE_URL || !Bun.env.ACCOUNT_MAIN_RESOURCE || !Bun.env.ACCOUNT_SECRET
    || !Bun.env.FUSEKI_URL || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const operators = new Set<string>();
  const auth = createAccountAuth({ baseURL: base, secret: Bun.env.ACCOUNT_SECRET,
    resource: Bun.env.ACCOUNT_MAIN_RESOURCE, pool: accountPool, operatorUserIds: operators });
  const server = createAccountApp(auth, accountPool).listen({ hostname: '127.0.0.1', port });
  try {
    const signUp = async (name: string) => {
      const email = `go-run-${name}-${randomUUID()}@example.test`;
      const password = randomBytes(24).toString('base64url');
      const response = await fetch(`${base}/api/auth/sign-up/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ name, email, password }),
      });
      expect(response.status).toBe(200);
      return { id: (await response.json() as { user: { id: string } }).user.id,
        email, password, cookie: response.headers.get('set-cookie')! };
    };
    const operator = await signUp('operator');
    operators.add(operator.id);
    const adminHeaders = new Headers({ cookie: operator.cookie, origin: base });
    const verifier = await auth.api.adminCreateOAuthClient({ headers: adminHeaders, body: {
      client_name: 'Go source run verifier', scope: 'source:acquire',
      token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
      client_credentials_scopes: ['source:acquire'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const allowed = 'openid source:acquire source:read';
    const client = await auth.api.adminCreateOAuthClient({ headers: adminHeaders, body: {
      client_name: 'Go source run client', application_type: 'native',
      redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'], scope: allowed,
      skip_consent: true, require_pkce: true } });
    const member = await signUp('member');
    const principalId = randomUUID();
    await accessPool.query(`INSERT INTO access.principal (id, account_issuer, account_subject)
      VALUES ($1, $2, $3)`, [principalId, `${base}/api/auth`, member.id]);
    const signedIn = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: member.email, password: member.password }),
    });
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.get('set-cookie')!;
    const tokenFor = async (scope: string) => {
      const verifier = randomBytes(32).toString('base64url');
      const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
      for (const [key, value] of Object.entries({ response_type: 'code', client_id: client.client_id,
        redirect_uri: redirectUri, scope, state: randomUUID(), resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256' })) authorize.searchParams.set(key, value);
      const authorized = await fetch(authorize, { headers: { cookie }, redirect: 'manual' });
      expect(authorized.status).toBe(302);
      const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
      const exchanged = await fetch(`${base}/api/auth/oauth2/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id,
          code, redirect_uri: redirectUri, code_verifier: verifier, resource: Bun.env.ACCOUNT_MAIN_RESOURCE }),
      });
      expect(exchanged.status).toBe(200);
      return (await exchanged.json() as { access_token: string }).access_token;
    };
    const acquireToken = await tokenFor('openid source:acquire');
    const readToken = await tokenFor('openid source:read');
    await migrateContent(contentPool);
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    const source = new FixtureOpenLibrary();
    source.goProxyResponses.set('example.com/mod/@v/v1.0.0.mod',
      new TextEncoder().encode('module example.com/mod\n\ngo 1.21\n'));
    source.goProxyResponses.set('example.com/mod/@v/list', new TextEncoder().encode('v1.0.0\nv1.1.0\n'));
    source.goProxyResponses.set('example.com/mod/@v/v1.1.0.mod',
      new TextEncoder().encode('module example.com/mod\n\ngo 1.21\n\nretract v1.0.0\n'));
    const main = createMainApp(fuseki, { environment: { fuseki,
      lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
      objectDirectory: `.temp/go-refresh-auth-${randomUUID()}` },
      account: new AccountAssertionVerifier({ issuer: `${base}/api/auth`,
        audience: Bun.env.ACCOUNT_MAIN_RESOURCE, jwksUrl: `${base}/api/auth/jwks`,
        introspectUrl: `${base}/api/auth/oauth2/introspect`, clientId: verifier.client_id,
        clientSecret: verifier.client_secret! }),
      access: new AccessAdmissionRegistry(accessPool),
      sourceAcquisitions: sourceAcquisitionServices(contentPool,
        { fetcher: source.fetch, reserve: async () => undefined }) });
    const requestBody = { profile: 'go-proxy-live-run-v1', mainModule:
      'module example.com/main\n\ngo 1.21\n\nrequire example.com/mod v1.0.0\n' };
    const headers = (token: string, key?: string) => ({ authorization: `Bearer ${token}`,
      'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) });
    const key = `go-auth-${randomUUID()}`;
    const denied = await main.handle(new Request('http://main.local/v1/sources/acquisitions', {
      method: 'POST', headers: headers(readToken, `denied-${key}`), body: JSON.stringify(requestBody) }));
    expect(denied.status).toBe(401);
    expect(source.goProxyRequests).toHaveLength(0);
    expect(source.goProxyRequests).toHaveLength(0);

    const created = await main.handle(new Request('http://main.local/v1/sources/acquisitions', {
      method: 'POST', headers: headers(acquireToken, key), body: JSON.stringify(requestBody) }));
    expect(created.status).toBe(201);
    const result = await created.json() as { run: { run: string; state: string }; resolution: { status: string } };
    expect(result).toMatchObject({ run: { state: 'completed' }, resolution: { status: 'solved' } });
    expect(source.goProxyRequests).toHaveLength(3);
    const read = await main.handle(new Request(`http://main.local/v1/sources/runs/${idOf(result.run.run)}`,
      { headers: headers(readToken) }));
    expect(read.status).toBe(200);

    await accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [principalId]);
    const beforeInactive = source.goProxyRequests.length;
    const inactive = await main.handle(new Request('http://main.local/v1/sources/acquisitions', {
      method: 'POST', headers: headers(acquireToken, `inactive-${key}`), body: JSON.stringify(requestBody) }));
    expect(inactive.status).toBe(403);
    expect(source.goProxyRequests).toHaveLength(beforeInactive);
    const deniedRead = await main.handle(new Request(`http://main.local/v1/sources/runs/${idOf(result.run.run)}`,
      { headers: headers(readToken) }));
    expect(deniedRead.status).toBe(403);
  } finally {
    await server.stop();
    await Promise.all([accountPool.end(), accessPool.end(), contentPool.end()]);
  }
}, 60_000);
