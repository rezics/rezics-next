import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomBytes } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { Pool } from 'pg';
import { testDatabase } from '../scripts/database.ts';
import {
  createAuthService,
  WEBSITE_CLIENT_ID,
  type AccessAccount,
  type AuthService,
  type AuthServiceOptions,
  type PublicJwks,
} from '../src/index.ts';
import { trustedAccessPorts } from './support/trusted-access.ts';

const audience = 'https://api.rezics.test';
const password = 'correct horse battery staple';
const account: AccessAccount = {
  accountId: '00000000-0000-7000-8000-123400000151',
  kind: 'actor',
  state: 'pending',
  authnEpoch: 1,
  automated: false,
};
const siteActions = new Map(
  [
    'openid',
    'offline_access',
    'media:complete',
    'x'.repeat(128),
    ...Array.from({ length: 150 }, (_, i) => `item:a${i}`),
  ].map((action, i) => [action, { anonymous: i % 2 === 0 }]),
);
const websiteScopes = [...siteActions.keys()].sort();
// The website's browser login client keeps the reserved completion scope out
// of cookie sessions; the confidential OAuth exchange grants it separately.
const loginScopes = websiteScopes.filter((scope) => scope !== 'media:complete');
let fixture: ReturnType<typeof testDatabase>;
let database: Pool;
let server: ReturnType<typeof Bun.serve>;
let service: AuthService;
let options: AuthServiceOptions;
let clientKey: Awaited<ReturnType<typeof generateKeyPair>>;
let publicJwks: PublicJwks;
let issuer: string;
let callback: string;

beforeAll(async () => {
  fixture = testDatabase();
  database = new Pool({ connectionString: fixture.url });
  server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => service.handler(request) });
  issuer = `http://127.0.0.1:${server.port}`;
  callback = `${issuer}/website/callback`;
  clientKey = await generateKeyPair('ES256', { extractable: true });
  publicJwks = {
    keys: [{ ...(await exportJWK(clientKey.publicKey)), kid: 'scope-client', alg: 'ES256', use: 'sig' }],
  } as PublicJwks;
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'scope-issuer',
    alg: 'ES256',
  };
  options = {
    database,
    issuer,
    audience,
    secret: 'scope-bounds-test-persistent-secret-at-least-32-bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    siteActions,
    trustedAccess: trustedAccessPorts({
      async readFencedAccount(id) {
        return this.readAccount(id);
      },
      async readAccount(id) {
        return id === account.accountId ? account : null;
      },
      async authorizeProvisioning(id) {
        if (id !== account.accountId) throw new Error('Unknown account');
        return { accountId: id };
      },
    }),
  };
  service = await createAuthService(options);
  await service.internal.provisionPassword({
    authorization: account.accountId,
    email: 'scope-person@example.test',
    password,
  });
  account.state = 'active';
}, 30000);

afterAll(async () => {
  await server?.stop(true);
  await database?.end();
  fixture?.close();
});

function register(scopes: string[], target = service) {
  return target.internal.registerWebsiteClient({
    publicJwks,
    redirectUris: [callback],
    postLogoutRedirectUris: [`${issuer}/`],
    scopes,
  });
}
function request(path: string, body?: unknown, cookie = '', target = service) {
  return target.handler(
    new Request(`${issuer}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
function signin(scope: string[], target = service, clientId = 'scope-login') {
  return request('/signin', { email: 'scope-person@example.test', password, client_id: clientId, scope }, '', target);
}
function cookie(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}
async function token(fields: Record<string, string>) {
  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: 'scope-client' })
    .setIssuer(WEBSITE_CLIENT_ID)
    .setSubject(WEBSITE_CLIENT_ID)
    .setAudience(issuer)
    .setIssuedAt()
    .setExpirationTime('2m')
    .setJti(randomBytes(24).toString('base64url'))
    .sign(clientKey.privateKey);
  return fetch(`${issuer}/token`, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: WEBSITE_CLIENT_ID,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
      resource: audience,
      ...fields,
    }),
  });
}

test('individual scope length and character rules stay unchanged at both validation boundaries', async () => {
  for (const invalid of [
    '',
    'x'.repeat(129),
    'has space',
    'has"quote',
    'has\\slash',
    'has\nnewline',
    'nonascii-é',
    42,
  ]) {
    await expect(register(['openid', 'offline_access', 'media:complete', invalid] as string[])).rejects.toThrow(
      'invalid_request',
    );
    await expect(
      service.internal.registerClient({ clientId: 'malformed', firstParty: true, scopes: [invalid] as string[] }),
    ).rejects.toThrow();
  }
  await service.internal.registerClient({
    clientId: 'characters',
    firstParty: true,
    scopes: ['x'.repeat(128), '!#[]~'],
  });
});

test('all mounted actions, including anonymous actions, survive website registration, session proofs and tokens', async () => {
  expect(siteActions.size).toBeGreaterThanOrEqual(150);
  // Check initial registration too, before the additive-update guard exists.
  await expect(register(['openid', 'offline_access', 'media:complete', 'unmounted'])).rejects.toThrow(
    'invalid_request',
  );
  for (const required of ['openid', 'offline_access', 'media:complete'])
    await expect(
      register(['openid', 'offline_access', 'media:complete'].filter((scope) => scope !== required)),
    ).rejects.toThrow('invalid_request');
  // Website registration bounds the deduplicated list, unlike cookie inputs.
  await register([...websiteScopes, ...websiteScopes]);
  const registered = (await database.query('SELECT scopes FROM auth_client WHERE client_id=$1', [WEBSITE_CLIENT_ID]))
    .rows[0];
  expect(registered.scopes).toEqual(websiteScopes);
  await service.internal.registerClient({ clientId: 'scope-login', firstParty: true, scopes: loginScopes });
  const login = await signin([...loginScopes, loginScopes[0]!]);
  expect(login.status).toBe(200);
  expect((await login.json()).scope).toEqual(loginScopes);
  const sessionCookie = cookie(login);
  const session = await request('/session', undefined, sessionCookie);
  expect(session.status).toBe(200);
  expect((await session.json()).scope).toEqual(loginScopes);
  const keys = createLocalJWKSet(await (await fetch(service.verifier.jwksUrl)).json());
  const cookieToken = await request('/token', {}, sessionCookie);
  expect(cookieToken.status).toBe(200);
  const cookieClaims = await jwtVerify((await cookieToken.json()).access_token, keys, {
    issuer,
    audience,
    typ: 'at+jwt',
  });
  expect(String(cookieClaims.payload.scope).split(' ')).toEqual(loginScopes);

  await service.internal.registerClient({ clientId: 'scope-external', firstParty: false, scopes: loginScopes });
  const consent = await request('/consent', { client_id: 'scope-external', scope: loginScopes }, sessionCookie);
  expect(consent.status).toBe(200);
  const external = await signin(loginScopes, service, 'scope-external');
  expect(external.status).toBe(200);
  expect((await external.json()).scope).toEqual(loginScopes);
  expect(
    (await request('/consent', { client_id: 'scope-external', scope: ['unregistered'] }, sessionCookie)).status,
  ).toBe(400);

  const verifier = randomBytes(48).toString('base64url');
  const authorize = new URL(`${issuer}/authorize`);
  authorize.search = new URLSearchParams({
    client_id: WEBSITE_CLIENT_ID,
    redirect_uri: callback,
    response_type: 'code',
    scope: websiteScopes.join(' '),
    state: 'scope-state',
    nonce: 'scope-nonce',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: audience,
  }).toString();
  const authorization = await fetch(authorize, { headers: { cookie: sessionCookie }, redirect: 'manual' });
  expect(authorization.status).toBe(302);
  const code = new URL(authorization.headers.get('location')!).searchParams.get('code');
  expect(code).toBeTruthy();
  const exchange = await token({
    grant_type: 'authorization_code',
    code: code!,
    code_verifier: verifier,
    redirect_uri: callback,
  });
  expect(exchange.status).toBe(200);
  const issued = await exchange.json();
  const claims = await jwtVerify(issued.access_token, keys, { issuer, audience, typ: 'at+jwt' });
  expect(String(claims.payload.scope).split(' ').sort()).toEqual(websiteScopes);
  const id = await jwtVerify(issued.id_token, keys, { issuer, audience: WEBSITE_CLIENT_ID });
  expect(id.payload).toMatchObject({ sub: account.accountId, nonce: 'scope-nonce' });
  const expanded = await token({
    grant_type: 'refresh_token',
    refresh_token: issued.refresh_token,
    scope: [...websiteScopes, 'unmounted'].join(' '),
  });
  expect(expanded.status).toBe(400);
  expect(await expanded.json()).toEqual({ error: 'invalid_scope' });
  const refresh = await token({ grant_type: 'refresh_token', refresh_token: issued.refresh_token });
  expect(refresh.status).toBe(200);
  const refreshed = await jwtVerify((await refresh.json()).access_token, keys, { issuer, audience, typ: 'at+jwt' });
  expect(String(refreshed.payload.scope).split(' ').sort()).toEqual(websiteScopes);
}, 30000);

test('one past the known set is refused and membership and required protocol scopes remain enforced', async () => {
  await expect(register([...websiteScopes, 'unmounted'])).rejects.toThrow('invalid_request');
  // Below the bound, an unknown action still fails catalogue membership.
  await expect(register(['openid', 'offline_access', 'media:complete', 'unmounted'])).rejects.toThrow(
    'invalid_request',
  );
  for (const required of ['openid', 'offline_access', 'media:complete'])
    await expect(register(websiteScopes.filter((scope) => scope !== required))).rejects.toThrow('invalid_request');
  // The service bounds raw entries, even when deduplication would fit.
  const tooMany = [...loginScopes, loginScopes[0]!, loginScopes[0]!];
  expect(tooMany).toHaveLength(websiteScopes.length + 1);
  expect((await signin(tooMany)).status).toBe(400);
  await expect(
    service.internal.registerClient({ clientId: 'oversized', firstParty: true, scopes: tooMany }),
  ).rejects.toThrow();
  expect((await signin(['unregistered'])).status).toBe(401);
  await expect(
    service.internal.registerClient({ clientId: 'reserved', firstParty: true, scopes: ['media:complete'] }),
  ).rejects.toThrow();
});

test('an empty mounted catalogue uses the protocol union and the bound is fixed at service creation', async () => {
  const actions = new Map<string, { anonymous: boolean }>();
  const empty = await createAuthService({ ...options, siteActions: actions });
  actions.set('later', { anonymous: true });
  await empty.internal.registerClient({ clientId: 'empty-catalogue', firstParty: true, scopes: ['a', 'b', 'c'] });
  await expect(
    empty.internal.registerClient({ clientId: 'empty-overflow', firstParty: true, scopes: ['a', 'b', 'c', 'd'] }),
  ).rejects.toThrow();
  // media:complete remains required to be mounted at website registration.
  await expect(register(['openid', 'offline_access', 'media:complete'], empty)).rejects.toThrow('invalid_request');
});

test('without a mounted catalogue both bounds accept 1000 entries and refuse 1001', async () => {
  const { siteActions: _siteActions, ...fallbackOptions } = options;
  const fallback = await createAuthService(fallbackOptions);
  const scopes = Array.from({ length: 1000 }, (_, i) => `s${i}`);
  await fallback.internal.registerClient({ clientId: 'fallback', firstParty: true, scopes });
  const login = await signin(scopes, fallback, 'fallback');
  expect(login.status).toBe(200);
  expect((await login.json()).scope).toHaveLength(1000);
  const session = await request('/session', undefined, cookie(login), fallback);
  expect(session.status).toBe(200);
  expect((await session.json()).scope).toHaveLength(1000);
  const website = [...websiteScopes, ...scopes.slice(0, 1000 - websiteScopes.length)];
  await register(website, fallback);
  await expect(register([...website, 'overflow'], fallback)).rejects.toThrow('invalid_request');
  await expect(
    fallback.internal.registerClient({
      clientId: 'fallback-overflow',
      firstParty: true,
      scopes: [...scopes, 'overflow'],
    }),
  ).rejects.toThrow();
  expect((await signin([...scopes, 'overflow'], fallback, 'fallback')).status).toBe(400);
  // A fallback instance must not change another service's bound.
  await expect(
    service.internal.registerClient({ clientId: 'isolated-overflow', firstParty: true, scopes }),
  ).rejects.toThrow();
});
