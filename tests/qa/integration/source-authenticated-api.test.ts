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
import { OpenLibraryConversionStore }
  from '../../../services/main/src/modules/source/open-library-conversion.ts';
import { SourceIntakeStore } from '../../../services/main/src/modules/source/intake.ts';

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

test('IAM10/LIVE01/LIVE02: real Account scopes and Access principal fence protect staged source APIs', async () => {
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
      const email = `source-${name}-${randomUUID()}@example.test`;
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
    const headers = new Headers({ cookie: operator.cookie, origin: base });
    const verifierClient = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'Source Main verifier', scope: 'source:intake',
      token_endpoint_auth_method: 'client_secret_post', grant_types: ['client_credentials'],
      client_credentials_scopes: ['source:intake'] } });
    const redirectUri = 'http://localhost:3000/auth/callback';
    const allowed = 'openid source:intake source:acquire source:convert source:read';
    const client = await auth.api.adminCreateOAuthClient({ headers, body: {
      client_name: 'Source API client', application_type: 'native',
      redirect_uris: [redirectUri], token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code'], scope: allowed,
      skip_consent: true, require_pkce: true } });
    const member = await signUp('member');
    const principalId = randomUUID();
    await accessPool.query(`INSERT INTO access.principal
      (id, account_issuer, account_subject) VALUES ($1, $2, $3)`,
    [principalId, `${base}/api/auth`, member.id]);
    const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: member.email, password: member.password }),
    });
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get('set-cookie')!;
    const tokenFor = async (scope: string) => {
      const verifier = randomBytes(32).toString('base64url');
      const authorize = new URL(`${base}/api/auth/oauth2/authorize`);
      for (const [key, value] of Object.entries({ response_type: 'code',
        client_id: client.client_id, redirect_uri: redirectUri, scope,
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
    const fullToken = await tokenFor(allowed);
    const readToken = await tokenFor('openid source:read');
    await migrateContent(contentPool);
    const sourceIntake = new SourceIntakeStore(contentPool);
    const fuseki = new FusekiClient(Bun.env.FUSEKI_URL);
    let fetches = 0;
    const app = createMainApp(fuseki, {
      environment: { fuseki,
        lineage: { dataEpoch: Bun.env.MAIN_DATA_EPOCH, routingEpoch: Bun.env.MAIN_ROUTING_EPOCH },
        objectDirectory: '.temp/source-auth-unused' },
      account: new AccountAssertionVerifier({ issuer: `${base}/api/auth`,
        audience: Bun.env.ACCOUNT_MAIN_RESOURCE, jwksUrl: `${base}/api/auth/jwks`,
        introspectUrl: `${base}/api/auth/oauth2/introspect`,
        clientId: verifierClient.client_id, clientSecret: verifierClient.client_secret! }),
      access: new AccessAdmissionRegistry(accessPool), sourceIntake,
      sourceConversions: new OpenLibraryConversionStore(contentPool, sourceIntake),
      openLibraryFetch: (async (url: string) => {
        fetches++;
        const workId = url.split('/').at(-1)!.slice(0, -5);
        return new Response(JSON.stringify({ key: `/works/${workId}`,
          type: { key: '/type/work' }, title: 'Source title', revision: 1 }),
        { headers: { 'content-type': 'application/json' } });
      }) as typeof fetch,
    });
    const call = (method: string, path: string, token: string, body?: object,
      key = `source-${randomUUID()}`) => app.handle(new Request(`http://main.local${path}`, {
      method, headers: { authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }));
    const manual = { profile: 'source-manual-intake-v1', provider: 'example',
      namespace: 'work', externalId: `OL-${randomUUID()}`, sourceRevision: null,
      mediaType: 'application/json', retention: 'retained',
      rawBytesBase64: Buffer.from('{"count":0}').toString('base64'),
      coverage: { scope: 'manual-response-v1', complete: true, omittedFields: [] },
      rightsEvidence: { basis: 'unknown', note: '' } };
    const before = await contentPool.query('SELECT id FROM source.observation WHERE principal_id = $1',
      [principalId]);
    expect((await call('POST', '/v1/sources/intakes', readToken, manual)).status).toBe(401);
    expect((await contentPool.query('SELECT id FROM source.observation WHERE principal_id = $1',
      [principalId])).rowCount).toBe(before.rowCount);
    const staged = await call('POST', '/v1/sources/intakes', fullToken, manual);
    expect(staged.status).toBe(201);
    expect((await call('POST', '/v1/sources/acquisitions/open-library/works',
      readToken, { profile: 'open-library-work-acquisition-v1', workId: 'OL45804W' })).status)
      .toBe(401);
    expect(fetches).toBe(0);
    const acquired = await call('POST', '/v1/sources/acquisitions/open-library/works',
      fullToken, { profile: 'open-library-work-acquisition-v1', workId: 'OL45804W' });
    expect(acquired.status).toBe(201);
    expect(fetches).toBe(1);
    const observationId = (await acquired.json() as { observation: { observation: string } })
      .observation.observation.split('/').at(-1)!;
    expect((await call('POST',
      `/v1/sources/observations/${observationId}/conversions/open-library-work`,
      readToken, { profile: 'open-library-work-map-v1' })).status).toBe(401);
    expect((await contentPool.query('SELECT id FROM source.conversion WHERE principal_id = $1',
      [principalId])).rowCount).toBe(0);
    const converted = await call('POST',
      `/v1/sources/observations/${observationId}/conversions/open-library-work`,
      fullToken, { profile: 'open-library-work-map-v1' });
    expect(converted.status).toBe(201);
    const conversionId = (await converted.json() as { conversion: { conversion: string } })
      .conversion.conversion.split('/').at(-1)!;
    expect((await call('GET', `/v1/sources/observations/${observationId}`, readToken)).status)
      .toBe(200);
    expect((await call('GET', `/v1/sources/conversions/${conversionId}`, readToken)).status)
      .toBe(200);
    await accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [principalId]);
    const beforeDenied = await contentPool.query('SELECT id FROM source.observation WHERE principal_id = $1',
      [principalId]);
    expect((await call('POST', '/v1/sources/intakes', fullToken,
      { ...manual, externalId: `denied-${randomUUID()}` })).status).toBe(403);
    expect((await contentPool.query('SELECT id FROM source.observation WHERE principal_id = $1',
      [principalId])).rowCount)
      .toBe(beforeDenied.rowCount);
    expect((await call('GET', `/v1/sources/observations/${observationId}`, fullToken)).status)
      .toBe(403);
  } finally {
    server.stop();
    await Promise.all([accountPool.end(), accessPool.end(), contentPool.end()]);
  }
});
