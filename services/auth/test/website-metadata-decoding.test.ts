import { expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { AuthServiceOptions, PublicJwks, SessionProof } from '../src/index.ts';
import { websiteRoutes } from '../src/website.ts';
import { trustedAccessPorts } from './support/trusted-access.ts';

const issuer = 'https://auth.test';
const nativeObject = {
  issuer: 'https://native.invalid',
  extra: true,
  token_endpoint_auth_methods_supported: ['client_secret_post'],
};

function routes(native: (request: Request) => Promise<Response>) {
  return websiteRoutes({
    options: {
      issuer,
      audience: 'https://api.test',
      database: {} as Pool,
      secret: 'website-metadata-decoding-secret-32b',
      signing: { activeKid: 'k', privateKeys: [] },
      trustedAccess: trustedAccessPorts({
        readAccount: async () => null,
        authorizeProvisioning: async () => {
          throw new Error('unused');
        },
      }),
    } as unknown as AuthServiceOptions,
    scopeLimit: 16,
    database: {
      query: async () => ({ rows: [{ scopes: ['openid', 'offline_access'] }] }),
    } as unknown as Pool,
    materialize: async () => {},
    native: () => ({
      handler: native,
      api: {
        getSession: async () => null,
      },
    }),
    withIssuance: async (_clientId, run) => run(),
    sessionProof: async () => ({}) as SessionProof,
    getJwks: async () => ({ keys: [] }) as PublicJwks,
  });
}

test('valid discovery metadata stays readable and uses the current issuer endpoints', async () => {
  const website = routes(async () => Response.json(nativeObject));
  const response = await website.handler(new Request(`${issuer}/.well-known/openid-configuration`));
  expect(response?.status).toBe(200);
  expect(await response!.json()).toMatchObject({
    extra: true,
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    revocation_endpoint: `${issuer}/revoke`,
    end_session_endpoint: `${issuer}/logout`,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    token_endpoint_auth_methods_supported: ['private_key_jwt'],
    scopes_supported: ['openid', 'offline_access'],
  });
});

test('non-object discovery JSON keeps the original native body after decoding', async () => {
  for (const body of ['null', '"metadata"', '[1,2]', 'true']) {
    const website = routes(
      async () => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const response = await website.handler(new Request(`${issuer}/.well-known/openid-configuration`));
    expect(response?.status).toBe(200);
    expect(await response!.text()).toBe(body);
  }
});
