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
import { GoMvsResolutionStore } from '../../../services/main/src/modules/package/go-mvs.ts';
import { GoProxyCaptureStore } from '../../../services/main/src/modules/package/go-proxy-capture.ts';
import { goPrunedFixtureResponse } from '../fixtures/go-pruned-directives.ts';
import { assertGoPrunedDirectivesApi } from '../fixtures/go-pruned-directives-api.ts';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('no Account port'));
      server.close(() => resolve(address.port));
    });
  });
}

test('PKG05/PKG12/PKG13/IAM10: real Account and Access protect pruned Go directive captures and receipts', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID || !Bun.env.CONTENT_DATABASE_URL
    || !Bun.env.ACCESS_DATABASE_URL || !Bun.env.ACCOUNT_DATABASE_URL
    || !Bun.env.ACCOUNT_MAIN_RESOURCE || !Bun.env.FUSEKI_URL
    || !Bun.env.MAIN_DATA_EPOCH || !Bun.env.MAIN_ROUTING_EPOCH) {
    throw new Error('Run through the isolated QA integration tier');
  }
  const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL });
  const accessPool = new Pool({ connectionString: Bun.env.ACCESS_DATABASE_URL });
  const contentPool = new Pool({ connectionString: Bun.env.CONTENT_DATABASE_URL });
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const operators = new Set<string>();
  const auth = createAccountAuth({ baseURL: base, secret: Bun.env.ACCOUNT_SECRET!,
    resource: Bun.env.ACCOUNT_MAIN_RESOURCE, pool: accountPool, operatorUserIds: operators });
  const server = createAccountApp(auth, accountPool).listen({ hostname: '127.0.0.1', port });
  try {
    const signUp = async (name: string) => {
      const response = await fetch(`${base}/api/auth/sign-up/email`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin: base },
        body: JSON.stringify({ name, email: `go-${name}-${randomUUID()}@example.test`,
          password: randomBytes(24).toString('base64url') }),
      });
      expect(response.status).toBe(200);
      return { id: (await response.json() as { user: { id: string } }).user.id,
        cookie: response.headers.get('set-cookie')! };
    };
    const operator = await signUp('operator');
    operators.add(operator.id);
    const headers = new Headers({ cookie: operator.cookie, origin: base });
    const verifierClient = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'Go Main verifier', scope: 'package:read',
      token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
      client_credentials_scopes: ['package:read'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const client = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'Go captured graph client', application_type: 'native',
      redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'], scope: 'openid package:capture package:resolve package:read',
      skip_consent: true, require_pkce: true } });
    const member = await signUp('member');
    const other = await signUp('other');
    const principalId = randomUUID();
    await accessPool.query(`INSERT INTO access.principal
      (id, account_issuer, account_subject) VALUES ($1,$2,$3),($4,$2,$5)`,
    [principalId, `${base}/api/auth`, member.id, randomUUID(), other.id]);
    const tokenFor = async (scope: string, cookie: string) => {
      const verifier = randomBytes(32).toString('base64url');
      const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
      for (const [key, value] of Object.entries({ response_type: 'code',
        client_id: client.client_id, redirect_uri: redirectUri, scope: `openid ${scope}`,
        state: randomUUID(), resource: Bun.env.ACCOUNT_MAIN_RESOURCE,
        code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        code_challenge_method: 'S256',
      })) authorize.searchParams.set(key, value);
      const authorized = await fetch(authorize, { headers: { cookie }, redirect: 'manual' });
      expect(authorized.status).toBe(302);
      const code = new URL(authorized.headers.get('location')!).searchParams.get('code')!;
      const exchanged = await fetch(`${base}/api/auth/oauth2/token`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code',
          client_id: client.client_id, code, redirect_uri: redirectUri,
          code_verifier: verifier, resource: Bun.env.ACCOUNT_MAIN_RESOURCE }),
      });
      expect(exchanged.status).toBe(200);
      return (await exchanged.json() as { access_token: string }).access_token;
    };
    const tokens = {
      capture: await tokenFor('package:capture', member.cookie),
      resolve: await tokenFor('package:resolve', member.cookie),
      read: await tokenFor('package:read', member.cookie),
      otherResolve: await tokenFor('package:resolve', other.cookie),
      otherRead: await tokenFor('package:read', other.cookie),
    };
    await migrateContent(contentPool);
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    let captureFetches = 0;
    const captures = new GoProxyCaptureStore(contentPool, (async (url: RequestInfo | URL) => {
      captureFetches++;
      const response = goPrunedFixtureResponse(String(url));
      if (!response) throw new Error(`unexpected fixture source ${String(url)}`);
      return response;
    }) as typeof fetch);
    const app = createMainApp(fuseki, {
      environment: { fuseki, lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH,
        routingEpoch: Bun.env.MAIN_ROUTING_EPOCH }, objectDirectory: '.temp/go-pruned-api-unused' },
      account: new AccountAssertionVerifier({ issuer: `${base}/api/auth`,
        audience: Bun.env.ACCOUNT_MAIN_RESOURCE, jwksUrl: `${base}/api/auth/jwks`,
        introspectUrl: `${base}/api/auth/oauth2/introspect`,
        clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! }),
      access: new AccessAdmissionRegistry(accessPool),
      packageCaptures: captures, packageResolutions: new GoMvsResolutionStore(contentPool, captures),
    });
    const call = (method: string, path: string, token: string, body?: object,
      key = `go-api-${randomUUID()}`) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { authorization: `Bearer ${token}`,
        ...(method === 'POST' ? { 'idempotency-key': key } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    const receipt = await assertGoPrunedDirectivesApi(call, tokens, contentPool);
    expect(captureFetches).toBe(18);
    await accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [principalId]);
    expect((await call('POST', '/v1/package-resolutions/from-captures', tokens.resolve,
      receipt.body, receipt.key)).status).toBe(403);
    expect((await call('GET', receipt.readPath, tokens.read)).status).toBe(403);
    expect(captureFetches).toBe(18);
  } finally {
    server.stop();
    await Promise.all([accountPool.end(), accessPool.end(), contentPool.end()]);
  }
});
