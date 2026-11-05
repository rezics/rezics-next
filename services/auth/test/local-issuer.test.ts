import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import { testDatabase } from '../scripts/database.ts';
import { createAuthService, type AuthServiceOptions } from '../src/index.ts';

let fixture: ReturnType<typeof testDatabase> | undefined;
let pool: Pool;
let options: AuthServiceOptions;

beforeAll(async () => {
  // This suite never shares signing-key storage with the foundation suites.
  fixture = testDatabase();
  pool = new Pool({ connectionString: fixture.url });
  const key = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'local',
  };
  options = {
    database: pool,
    issuer: 'https://auth.rezics.test',
    audience: 'https://api.rezics.test',
    secret: 'local-issuer-test-secret-with-at-least-32-bytes',
    signing: { activeKid: 'local', privateKeys: [key] },
    trustedAccess: trustedAccessPorts({
      async readFencedAccount(id) {
        return this.readAccount(id);
      },
      async readAccount() {
        return null;
      },
      async authorizeProvisioning() {
        throw new Error('No provisioning approval');
      },
    }),
  };
}, 60_000);

afterAll(async () => {
  await pool?.end();
  fixture?.close();
});

test('only canonical exact loopback HTTP issuer origins are permitted', async () => {
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    for (const port of ['', ':43210']) {
      const issuer = `http://${host}${port}`;
      expect((await createAuthService({ ...options, issuer })).verifier).toMatchObject({
        issuer,
        audience: 'https://api.rezics.test',
        jwksUrl: `${issuer}/.well-known/jwks.json`,
      });
    }
  }
  for (const issuer of [
    'http://auth.rezics.com',
    'http://192.168.1.1',
    'http://10.0.0.1',
    'http://172.16.0.1',
    'http://0.0.0.0',
    'http://localhost.example',
    'http://localhost.',
    'http://foo.localhost',
    'http://127.0.0.2',
    'http://127.1',
    'http://2130706433',
    'http://0x7f000001',
    'http://0177.0.0.1',
    'http://[::ffff:127.0.0.1]',
    'http://[0:0:0:0:0:0:0:1]',
    'http://LOCALHOST',
    'http://%6cocalhost',
    'http://localhost:80',
    'http://localhost:043210',
    'http://user@localhost',
    'http://localhost@evil.test',
    'http://localhost/',
    'http://localhost/path',
    'http://localhost/..',
    'http://localhost?',
    'http://localhost#',
    'http://localhost?query=1',
    'http://localhost#fragment',
    ' http://localhost',
    'https://auth.rezics.test/',
    'https://user@auth.rezics.test',
  ]) {
    await expect(createAuthService({ ...options, issuer })).rejects.toThrow();
  }
});

test('HTTP issuers never authorize an HTTP API audience, including loopback audiences', async () => {
  for (const issuer of [
    'https://auth.rezics.test',
    'http://127.0.0.1:43210',
    'http://localhost:43210',
    'http://[::1]:43210',
  ]) {
    for (const audience of [
      'http://api.rezics.com',
      'http://api.rezics.test',
      'http://localhost:4100',
      'http://127.0.0.1:4100',
      'http://[::1]:4100',
    ]) {
      await expect(createAuthService({ ...options, issuer, audience })).rejects.toThrow();
    }
  }
  expect((await createAuthService({ ...options, audience: 'https://api.rezics.com' })).verifier.audience).toBe(
    'https://api.rezics.com',
  );
});

test('HTTPS origins retain native secure Better Auth session cookies', async () => {
  let active = false;
  const service = await createAuthService({
    ...options,
    trustedAccess: trustedAccessPorts({
      async readFencedAccount(id) {
        return this.readAccount(id);
      },
      async readAccount() {
        return {
          accountId: 'secure-person',
          kind: 'actor',
          state: active ? 'active' : 'pending',
          authnEpoch: 1,
          automated: false,
        };
      },
      async authorizeProvisioning() {
        return { accountId: 'secure-person' };
      },
    }),
  });
  await service.internal.registerClient({ clientId: 'web', firstParty: true, scopes: [] });
  await service.internal.provisionPassword({
    authorization: 'approved',
    email: 'secure@example.test',
    password: 'correct horse battery staple',
  });
  active = true;
  const response = await service.handler(
    new Request(`${options.issuer}/signin`, {
      method: 'POST',
      headers: { origin: options.issuer, 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'secure@example.test',
        password: 'correct horse battery staple',
        client_id: 'web',
        scope: [],
      }),
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toContain('__Secure-');
  expect(response.headers.get('set-cookie')).toContain('Secure');
});
