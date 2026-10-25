import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { jwt } from 'better-auth/plugins';
import { oauthProvider } from '@better-auth/oauth-provider';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool } from 'pg';
import { betterAuthOptions, credentialOwnerSchema } from '../src/better-auth.ts';
import { createAuthService, type AccessAccount } from '../src/index.ts';
import { testDatabase } from './database.ts';

// Diagnostic only: expose the pinned native provider in its own disposable
// database. Never mount this fixture as an application or log its credentials.
const fixture = testDatabase();
const database = new Pool({ connectionString: fixture.url });
const audience = 'https://api.rezics.test';
const secret = 'native-provider-probe-only-secret-at-least-32-bytes';
const account: AccessAccount = {
  accountId: '00000000-0000-7000-8000-123400000099',
  kind: 'actor',
  state: 'pending',
  authnEpoch: 1,
  automated: false,
};
let handler: (request: Request) => Promise<Response>;
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => handler(request) });
const issuer = `http://127.0.0.1:${server.port}`;
const redirectUri = 'https://website.rezics.test/auth/callback';
const selectedScopes = ['openid', 'offline_access', 'media:read'];

try {
  let issuanceHooks = 0;
  const options = {
    ...betterAuthOptions(database, issuer, secret),
    logger: { disabled: true },
    plugins: [
      credentialOwnerSchema,
      jwt({ jwt: { issuer }, jwks: { keyPairConfig: { alg: 'ES256' as const } } }),
      oauthProvider({
        loginPage: '/signin',
        consentPage: '/consent',
        scopes: selectedScopes,
        resources: [{ identifier: audience, scopes: ['media:read'] }],
        grantTypes: ['authorization_code', 'refresh_token'],
        assertionMaxLifetime: 120,
        accessTokenExpiresIn: 300,
        refreshTokenReuseInterval: 0,
        clientPrivileges: () => true,
        resourcePrivileges: () => true,
        customAccessTokenClaims: () => {
          issuanceHooks++;
          return {};
        },
        customTokenResponseFields: () => {
          issuanceHooks++;
          return {};
        },
      }),
    ],
  };
  // Native migration generation is used only inside this disposable database.
  // No production migration is generated or committed by this diagnostic.
  await (await getMigrations(options)).runMigrations();
  const native = betterAuth(options);
  handler = native.handler;
  const context = await native.$context;
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'probe-issuer',
    alg: 'ES256',
  };
  const service = await createAuthService({
    database,
    issuer,
    audience,
    secret,
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: {
      async readAccount(id) {
        return id === account.accountId ? account : null;
      },
      async authorizeProvisioning() {
        return { accountId: account.accountId };
      },
    },
  });
  await service.internal.registerClient({ clientId: 'probe-login', firstParty: true, scopes: ['media:read'] });
  const password = randomBytes(32).toString('base64url');
  await service.internal.provisionPassword({ authorization: 'fixture', email: 'probe@example.test', password });
  account.state = 'active';
  const login = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'probe@example.test', password, client_id: 'probe-login', scope: ['media:read'] }),
    }),
  );
  assert.equal(login.status, 200, 'real Better Auth password login');
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const clientKey = await generateKeyPair('ES256', { extractable: true });
  const client = await native.api.adminCreateOAuthClient({
    headers: new Headers({ cookie }),
    body: {
      redirect_uris: [redirectUri],
      scope: selectedScopes.join(' '),
      token_endpoint_auth_method: 'private_key_jwt',
      jwks: { keys: [{ ...(await exportJWK(clientKey.publicKey)), kid: 'probe-client', alg: 'ES256', use: 'sig' }] },
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      resources: [audience],
      skip_consent: true,
      require_pkce: true,
      enable_end_session: true,
    },
  });
  async function token(fields: Record<string, string>) {
    const now = Math.floor(Date.now() / 1000);
    // Native 1.7.12 uses the endpoint audience. The website's stricter issuer
    // audience adaptation is orthogonal to this storage/rotation diagnostic.
    const assertion = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: 'probe-client' })
      .setIssuer(client.client_id)
      .setSubject(client.client_id)
      .setAudience(`${issuer}/api/auth/oauth2/token`)
      .setIssuedAt(now)
      .setExpirationTime(now + 120)
      .setJti(randomBytes(24).toString('base64url'))
      .sign(clientKey.privateKey);
    return fetch(`${issuer}/api/auth/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: client.client_id,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: assertion,
        resource: audience,
        ...fields,
      }),
    });
  }
  const verifier = randomBytes(48).toString('base64url');
  const authorize = new URL(`${issuer}/api/auth/oauth2/authorize`);
  authorize.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: selectedScopes.join(' '),
    state: randomBytes(24).toString('base64url'),
    nonce: randomBytes(24).toString('base64url'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: audience,
  }).toString();
  const authorization = await fetch(authorize, { headers: { cookie }, redirect: 'manual' });
  assert.ok([302, 303].includes(authorization.status), 'native authorization redirects');
  const code = new URL(authorization.headers.get('location')!).searchParams.get('code');
  assert.ok(code, 'native authorization returns a code');
  const exchange = await token({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  assert.equal(exchange.status, 200, 'native code exchange');
  const issued = await exchange.json();
  assert.equal(typeof issued.refresh_token, 'string');

  const reachedInsert = Promise.withResolvers<void>();
  const releaseInsert = Promise.withResolvers<void>();
  const originalCreate = context.adapter.create.bind(context.adapter);
  let pause = true;
  context.adapter.create = async (input) => {
    if (input.model === 'oauthRefreshToken' && pause) {
      pause = false;
      reachedInsert.resolve();
      await releaseInsert.promise;
    }
    return originalCreate(input);
  };
  const rotation = token({ grant_type: 'refresh_token', refresh_token: issued.refresh_token });
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      reachedInsert.promise,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Native rotation never reached insertion')), 10000);
      }),
    ]);
    // Rotation has atomically revoked the parent, but has not inserted the child.
    const hooksBeforeReplay = issuanceHooks;
    const replay = await token({ grant_type: 'refresh_token', refresh_token: issued.refresh_token });
    assert.equal(replay.status, 400, 'native replay is detected');
    assert.equal(issuanceHooks, hooksBeforeReplay, 'native replay skips the issuance hooks');
    const afterReplay = await database.query(
      'SELECT count(*)::int AS count FROM "oauthRefreshToken" WHERE "clientId"=$1',
      [client.client_id],
    );
    assert.equal(afterReplay.rows[0].count, 0, 'native replay cleanup completed');
  } finally {
    clearTimeout(deadline);
    releaseInsert.resolve();
  }
  const rotated = await rotation;
  assert.equal(rotated.status, 200, 'concurrent rotation resurrects a child after replay cleanup');
  const child = await rotated.json();
  const survived = await token({ grant_type: 'refresh_token', refresh_token: child.refresh_token });
  assert.equal(survived.status, 200, 'child remains usable after native replay cleanup');
  console.log(
    JSON.stringify({
      provider: '@better-auth/oauth-provider@1.7.12',
      replayStatus: 400,
      refreshRowsImmediatelyAfterReplay: 0,
      concurrentRotationStatus: rotated.status,
      childRefreshAfterReplayStatus: survived.status,
      issuanceHooksDuringReplay: 0,
    }),
  );
} finally {
  await server.stop(true);
  await database.end();
  fixture.close();
}
