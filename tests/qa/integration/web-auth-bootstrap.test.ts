import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, test } from 'bun:test';
import { Pool } from 'pg';
import { bootstrapWebAuth } from '../../../scripts/dev/web-auth-bootstrap.ts';
import { readEnv } from '../../../scripts/dev/config.ts';
import { createAccountAuth } from '../../../services/account/src/auth.ts';
import { createAccountApp } from '../../../services/account/src/app.ts';
import { createMainApp } from '../../../services/main/src/app.ts';
import { AccessAdmissionRegistry } from '../../../services/main/src/modules/access/admission.ts';
import { AccountAssertionVerifier } from '../../../services/main/src/modules/account/verify-assertion.ts';
import { FusekiClient } from '../../../services/main/src/infrastructure/fuseki.ts';

const root = resolve(import.meta.dir, '../../..');

test('IAM01/WORK01: QA-only PKCE member creates Work through its Access representation', async () => {
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Run through the isolated QA integration tier');
  const result = await bootstrapWebAuth({ runId,
    redirectUris: ['http://localhost:3000/auth/callback',
      'http://127.0.0.1:3003/auth/callback'] });
  expect(statSync(result.privateConfigPath).mode & 0o777).toBe(0o600);
  expect(statSync(result.runtimeEnvPath).mode & 0o777).toBe(0o600);
  const publicConfig = JSON.parse(readFileSync(result.publicConfigPath, 'utf8')) as {
    issuer: string; authorizationEndpoint: string; tokenEndpoint: string;
    resource: string; clientId: string; applicationType: string;
    redirectUris: string[]; actingSubject: string;
  };
  const privateConfig = JSON.parse(readFileSync(result.privateConfigPath, 'utf8')) as {
    operator: { id: string }; member: { id: string; email: string; password: string };
    mainClient: { id: string; secret: string };
  };
  const runtime = readEnv(result.runtimeEnvPath);
  expect(runtime.ACCOUNT_MAIN_CLIENT_ID).toBe(privateConfig.mainClient.id);
  expect(runtime.ACCOUNT_MAIN_CLIENT_SECRET).toBe(privateConfig.mainClient.secret);
  expect(runtime.ACCOUNT_OPERATOR_USER_IDS).toBe(privateConfig.operator.id);
  expect(publicConfig.clientId).toBe(result.clientId);
  expect(publicConfig.applicationType).toBe('native');
  expect(publicConfig.redirectUris).toEqual(['http://localhost:3000/auth/callback',
    'http://127.0.0.1:3003/auth/callback']);
  expect(JSON.stringify(publicConfig)).not.toContain(privateConfig.mainClient.secret);
  expect(publicConfig.actingSubject).toBe(result.actingSubject);
  const accountPool = new Pool({ connectionString: runtime.ACCOUNT_DATABASE_URL });
  const accessPool = new Pool({ connectionString: runtime.ACCESS_DATABASE_URL });
  const account = createAccountApp(createAccountAuth({
    baseURL: runtime.ACCOUNT_BASE_URL!, secret: runtime.ACCOUNT_SECRET!,
    resource: runtime.ACCOUNT_MAIN_RESOURCE!, pool: accountPool,
    operatorUserIds: new Set([privateConfig.operator.id]),
  }), accountPool).listen({ hostname: '127.0.0.1', port: Number(runtime.ACCOUNT_PORT) });
  try {
    const base = runtime.ACCOUNT_BASE_URL!;
    const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ email: privateConfig.member.email,
        password: privateConfig.member.password }),
    });
    expect(signIn.status).toBe(200);
    const cookie = signIn.headers.get('set-cookie');
    expect(cookie).toBeTruthy();
    const verifier = randomBytes(32).toString('base64url');
    const redirectUri = publicConfig.redirectUris[0]!;
    const authorize = new URL(publicConfig.authorizationEndpoint);
    for (const [key, value] of Object.entries({ response_type: 'code',
      client_id: publicConfig.clientId, redirect_uri: redirectUri,
      scope: 'openid work:create', state: randomUUID(), resource: publicConfig.resource,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    })) authorize.searchParams.set(key, value);
    const authorization = await fetch(authorize, { headers: { cookie: cookie! },
      redirect: 'manual' });
    expect(authorization.status).toBe(302);
    const location = new URL(authorization.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(redirectUri);
    expect(location.searchParams.get('state')).toBe(authorize.searchParams.get('state'));
    const wranglerAuthorize = new URL(authorize);
    wranglerAuthorize.searchParams.set('redirect_uri', publicConfig.redirectUris[1]!);
    wranglerAuthorize.searchParams.set('state', randomUUID());
    const wranglerAuthorization = await fetch(wranglerAuthorize, {
      headers: { cookie: cookie! }, redirect: 'manual' });
    expect(wranglerAuthorization.status).toBe(302);
    const wranglerLocation = new URL(wranglerAuthorization.headers.get('location')!);
    expect(wranglerLocation.origin + wranglerLocation.pathname)
      .toBe(publicConfig.redirectUris[1]!);
    expect(wranglerLocation.searchParams.get('state'))
      .toBe(wranglerAuthorize.searchParams.get('state'));
    const exchange = await fetch(publicConfig.tokenEndpoint, { method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code',
        client_id: publicConfig.clientId, code: location.searchParams.get('code')!,
        redirect_uri: redirectUri, code_verifier: verifier,
        resource: publicConfig.resource }),
    });
    expect(exchange.status).toBe(200);
    const token = (await exchange.json() as { access_token: string }).access_token;
    const fuseki = new FusekiClient(runtime.FUSEKI_URL!);
    const main = createMainApp(fuseki, {
      environment: { fuseki, lineage: { dataEpoch: runtime.MAIN_DATA_EPOCH!,
        routingEpoch: runtime.MAIN_ROUTING_EPOCH! },
      objectDirectory: runtime.MAIN_OBJECT_DIRECTORY! },
      account: new AccountAssertionVerifier({ issuer: publicConfig.issuer,
        audience: publicConfig.resource, jwksUrl: `${base}/api/auth/jwks`,
        introspectUrl: `${base}/api/auth/oauth2/introspect`,
        clientId: privateConfig.mainClient.id, clientSecret: privateConfig.mainClient.secret }),
      access: new AccessAdmissionRegistry(accessPool),
    });
    const denied = await main.handle(new Request('http://localhost/v1/works', {
      method: 'POST', headers: { authorization: `Bearer ${token}`,
        'content-type': 'application/json', 'idempotency-key': `web-auth-denied-${randomUUID()}` },
      body: JSON.stringify({ profile: 'metadata-only-v1', title: 'Denied local Work',
        actingSubject: `https://rezics.com/id/${randomUUID()}` }),
    }));
    expect(denied.status).toBe(403);
    const work = await main.handle(new Request('http://localhost/v1/works', {
      method: 'POST', headers: { authorization: `Bearer ${token}`,
        'content-type': 'application/json', 'idempotency-key': `web-auth-${randomUUID()}` },
      body: JSON.stringify({ profile: 'metadata-only-v1', title: 'Local web auth Work',
        actingSubject: result.actingSubject }),
    }));
    expect(work.status).toBe(201);
    expect((await work.json() as { work?: string }).work).toMatch(/^https:\/\/rezics\.com\/id\//);
  } finally {
    await account.stop();
    await accountPool.end();
    await accessPool.end();
    rmSync(dirname(result.publicConfigPath), { recursive: true });
  }
}, 120_000);
