import { expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { trustedAccessPorts } from './support/trusted-access.ts';
import { WEBSITE_CLIENT_ID, websiteRoutes } from '../src/website.ts';
import type { AuthServiceOptions, PublicJwks } from '../src/index.ts';

const issuer = 'https://auth.test';
const audience = 'https://api.test';
const assertionType = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const verifier = 'a'.repeat(43);

async function clientKeys() {
  const pair = await generateKeyPair('ES256', { extractable: true });
  const publicJwks = {
    keys: [{ ...(await exportJWK(pair.publicKey)), kid: 'website-client', alg: 'ES256', use: 'sig' }],
  } as PublicJwks;
  return { pair, publicJwks };
}

async function clientAssertion(privateKey: CryptoKey) {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: 'website-client' })
    .setIssuer(WEBSITE_CLIENT_ID)
    .setSubject(WEBSITE_CLIENT_ID)
    .setAudience(issuer)
    .setIssuedAt()
    .setExpirationTime('2m')
    .setJti(randomUUID())
    .sign(privateKey);
}

function routes(native: (request: Request) => Promise<Response>, publicJwks: PublicJwks) {
  const client = {
    scopes: ['openid', 'offline_access', 'media:read'],
    jwks: JSON.stringify(publicJwks),
    redirectUris: [`${issuer}/callback`],
    postLogoutRedirectUris: [`${issuer}/`],
  };
  return websiteRoutes({
    options: {
      database: {} as Pool,
      issuer,
      audience,
      secret: 'website-metadata-test-secret-32-bytes!',
      signing: { activeKid: 'issuer', privateKeys: [] },
      trustedAccess: trustedAccessPorts({
        async readAccount() {
          return null;
        },
        async authorizeProvisioning() {
          throw new Error('unused');
        },
      }),
    } as AuthServiceOptions,
    scopeLimit: 16,
    database: {
      query: async (sql: string) => ({ rows: sql.includes('FROM auth_client') ? [client] : [] }),
    } as Pool,
    materialize: async () => undefined,
    native: () => ({
      handler: native,
      api: {
        async getSession() {
          return null;
        },
      },
    }),
    withIssuance: async (_clientId, run) => run(),
    sessionProof: async () => ({
      account_id: 'unused',
      client_id: WEBSITE_CLIENT_ID,
      scope: ['openid'],
      authn_epoch: 1,
      auth_time: 0,
      amr: ['pwd'],
    }),
    getJwks: async () => ({ keys: [] }),
  });
}

async function posted(
  path: '/token' | '/revoke',
  native: (request: Request) => Promise<Response>,
  fields: Record<string, string>,
) {
  const { pair, publicJwks } = await clientKeys();
  const body = new URLSearchParams({
    client_id: WEBSITE_CLIENT_ID,
    client_assertion_type: assertionType,
    client_assertion: await clientAssertion(pair.privateKey),
    resource: audience,
    ...fields,
  });
  return routes(native, publicJwks).handler(
    new Request(`${issuer}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    }),
  );
}

test('malformed native website metadata uses the protocol projection, not a consumed body', async () => {
  const { publicJwks } = await clientKeys();
  for (const body of ['not-object', null, [issuer]]) {
    const response = await routes(async () => Response.json(body), publicJwks).handler(
      new Request(`${issuer}/.well-known/openid-configuration`),
    );
    expect(response?.status).toBe(503);
    expect(response?.headers.get('cache-control')).toBe('no-store');
    expect(await response?.json()).toEqual({ error: 'temporarily_unavailable' });
  }
});

test('object native website metadata keeps its fields under the website issuer', async () => {
  const { publicJwks } = await clientKeys();
  const response = await routes(
    async () => Response.json({ authorization_endpoint: 'https://native.test/authorize', extra: 'kept' }),
    publicJwks,
  ).handler(new Request(`${issuer}/.well-known/openid-configuration`));
  expect(response?.status).toBe(200);
  const metadata = (await response?.json()) as Record<string, unknown>;
  expect(metadata.issuer).toBe(issuer);
  expect(metadata.authorization_endpoint).toBe(`${issuer}/authorize`);
  expect(metadata.extra).toBe('kept');
  expect(metadata.scopes_supported).toEqual(['openid', 'offline_access', 'media:read']);
});

test('a non-object native token error is temporarily unavailable and a named error stays named', async () => {
  const unknownCode = {
    grant_type: 'authorization_code',
    code: 'unknown-authorization-code',
    redirect_uri: `${issuer}/callback`,
    code_verifier: verifier,
  };
  const malformed = await posted('/token', async () => Response.json('not-an-error', { status: 400 }), unknownCode);
  expect(malformed?.status).toBe(503);
  expect(await malformed?.json()).toEqual({ error: 'temporarily_unavailable' });

  const named = await posted(
    '/token',
    async () => Response.json({ error: 'invalid_grant' }, { status: 400 }),
    unknownCode,
  );
  expect(named?.status).toBe(400);
  expect(await named?.json()).toEqual({ error: 'invalid_grant' });
});

test('revocation without Access invalidation maps native 400s, including non-object JSON, to invalid_request', async () => {
  const unsupported = await posted(
    '/revoke',
    async () => Response.json({ error: 'unsupported_token_type' }, { status: 400 }),
    { token: 'unknown-token' },
  );
  expect(unsupported?.status).toBe(400);
  expect(await unsupported?.json()).toEqual({ error: 'invalid_request' });

  const malformed = await posted('/revoke', async () => Response.json('not-an-error', { status: 400 }), {
    token: 'unknown-token',
  });
  expect(malformed?.status).toBe(400);
  expect(await malformed?.json()).toEqual({ error: 'invalid_request' });
});
