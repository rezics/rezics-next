import { setFixtureAccountState } from '../support/native-suspension-driver.ts';
import { afterAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createAuthService, type AuthService } from '@rezics/auth';
import { createAccess } from '../../src/access/index.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { AuthenticationError } from '../../src/request/access.ts';
import type { AuthenticationConfig } from '../../src/access/authenticate.ts';
import { trustedAccessPorts } from '../support/trusted-access.ts';
import { dropTestDatabase } from '../support/drop-test-database.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = new Pool({ connectionString: url });
const audience = 'https://api.rezics.test';
const password = 'correct horse battery staple';
const person = '00000000-0000-7000-8000-123400000001';
const route = 0x1234;
const context = () => ({ pool, deadline: Date.now() + 3000 });
afterAll(() => pool.end());

async function invalid(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(AuthenticationError);
  expect(error).toMatchObject({ status: 401, challenge: 'Bearer error="invalid_token"' });
}

for (const [index, host] of ['127.0.0.1', 'localhost', '[::1]'].entries()) {
  test(`real password JWT verifies through same-origin ${host} HTTP JWKS`, async () => {
    const database = `local_issuer_${process.pid}_${index}`;
    const authUrl = new URL(url);
    authUrl.pathname = `/${database}`;
    let authPool: Pool | undefined;
    let service: AuthService | undefined;
    const requests: string[] = [];
    const server = Bun.serve({
      hostname: host === '[::1]' ? '::1' : '127.0.0.1',
      port: 0,
      fetch(request) {
        requests.push(new URL(request.url).pathname);
        if (!service) throw new Error('Auth not started');
        return service.handler(request);
      },
    });
    let stopping: Promise<void> | undefined;
    const stopServer = () => (stopping ??= Promise.resolve(server.stop(true)));
    const port = server.port!;
    const issuer = `http://${host}:${port}`;
    const post = (path: string, body: unknown, cookie = '', origin = issuer) =>
      fetch(`${issuer}${path}`, {
        method: 'POST',
        headers: { origin, cookie, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const signin = { email: 'local@example.test', password, client_id: 'web', scope: ['read'] };
    try {
      await pool.query(`CREATE DATABASE ${database}`);
      const { migrate } = await import(new URL('../../../auth/scripts/database.ts', import.meta.url).href);
      migrate(authUrl.toString());
      authPool = new Pool({ connectionString: authUrl.toString() });
      const key = {
        ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
        kid: 'local',
      };
      let approved = true;
      service = await createAuthService({
        database: authPool,
        issuer,
        audience,
        secret: 'local-issuer-test-secret-with-at-least-32-bytes',
        signing: { activeKid: 'local', privateKeys: [key] },
        trustedAccess: trustedAccessPorts({
          async readAccount(id) {
            const account = await readAccount(pool, route, id);
            return (
              account && {
                accountId: account.accountId,
                kind: account.kind,
                state: account.state,
                authnEpoch: Number(account.minimumAuthnEpoch),
                automated: false,
                fenced: account.fenced,
              }
            );
          },
          async authorizeProvisioning(reference) {
            if (!approved || reference !== 'approved') throw new Error('No provisioning approval');
            approved = false;
            return { accountId: person };
          },
        }),
      });
      await pool.query(
        `INSERT INTO access.account (route,account_id,kind,state,transaction_id)
        VALUES ($1,$2,'actor','pending',$2)`,
        [route, person],
      );
      await service.internal.registerClient({ clientId: 'web', firstParty: true, scopes: ['read'] });
      await service.internal.provisionPassword({ authorization: 'approved', email: signin.email, password });
      await pool.query("UPDATE access.account SET state='active' WHERE route=$1 AND account_id=$2", [route, person]);
      const response = await post('/signin', signin);
      expect(response.status).toBe(200);
      expect(response.headers.get('set-cookie')).toContain('HttpOnly');
      expect(response.headers.get('set-cookie')).not.toContain('Secure');
      const cookie = response.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      const issued = await post('/token', {}, cookie);
      expect(issued.status).toBe(200);
      const token = ((await issued.json()) as { access_token: string }).access_token;
      expect(decodeJwt(token)).toMatchObject({ iss: issuer, aud: audience, sub: person, amr: ['pwd'] });
      const access = createAccess({ actions: new Map(), auth: service.verifier });
      expect(await access.authenticate(token, context())).toMatchObject({
        accountId: person,
        clientId: 'web',
        authnEpoch: 1,
      });
      const credential = await generateKeyPair('ES256');
      await authPool.query('INSERT INTO auth_public_key (account_id,kid,public_jwk) VALUES ($1,$2,$3)', [
        person,
        'own-key',
        { ...(await exportJWK(credential.publicKey)), alg: 'ES256' },
      ]);
      for (const aud of [
        `http://${host}/token`,
        `http://${host}:${port + 1}/token`,
        `${issuer}/token/`,
        `${issuer}/token`,
      ]) {
        const assertion = await new SignJWT({})
          .setProtectedHeader({ alg: 'ES256', kid: 'own-key' })
          .setIssuer(person)
          .setSubject(person)
          .setAudience(aud)
          .setIssuedAt()
          .setExpirationTime('30s')
          .setJti(crypto.randomUUID())
          .sign(credential.privateKey);
        const response = await post('/signin/key', {
          account_id: person,
          assertion,
          client_id: 'web',
          scope: ['read'],
        });
        expect(response.status).toBe(aud === `${issuer}/token` ? 200 : 401);
      }
      for (const origin of [
        'http://evil.test',
        `http://${host}:${port + 1}`,
        `http://${host}`,
        `${issuer}/`,
        'null',
        '',
      ]) {
        expect((await post('/signin', signin, '', origin)).status).toBe(403);
        expect((await post('/token', {}, cookie, origin)).status).toBe(403);
      }
      expect(
        (
          await fetch(`${issuer}/token`, {
            method: 'POST',
            headers: { host: 'evil.test', origin: issuer, cookie, 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await service.handler(
            new Request('http://evil.test/token', {
              method: 'POST',
              headers: { host: `${host}:${port}`, origin: issuer, cookie, 'content-type': 'application/json' },
              body: '{}',
            }),
          )
        ).status,
      ).toBe(400);
      await stopServer();
      // A second verification succeeds using cached public keys with Auth offline.
      expect(await access.authenticate(token, context())).toMatchObject({ accountId: person });
      expect(requests.filter((path) => path === '/.well-known/jwks.json')).toHaveLength(1);

      let fetches = 0;
      const deny = async (overrides: Partial<AuthenticationConfig>) => {
        await invalid(
          createAccess({
            actions: new Map(),
            auth: {
              ...service!.verifier,
              async fetch() {
                fetches++;
                throw new Error('Invalid origins must not fetch');
              },
              ...overrides,
            },
          }).authenticate(token, context()),
        );
      };
      for (const origin of [
        'http://remote.test',
        'http://192.168.1.1',
        'http://0.0.0.0',
        'http://localhost.example',
        'http://localhost.',
        'http://127.1',
        'http://2130706433',
      ]) {
        await deny({ issuer: origin, jwksUrl: `${origin}/.well-known/jwks.json` });
      }
      for (const jwksUrl of [
        `http://127.0.0.1:${port + 1}/jwks`,
        `https://${host}:${port}/jwks`,
        'http://localhost.example/jwks',
        `${issuer}/jwks?query=1`,
        `${issuer}/jwks?`,
        `${issuer}/jwks#fragment`,
        `${issuer}/jwks#`,
        `${issuer.replace('http://', 'http://user@')}/jwks`,
        `http://2130706433:${port}/jwks`,
      ])
        await deny({ jwksUrl });
      for (const audience of [
        'http://api.rezics.test',
        'http://localhost:4100',
        'http://127.0.0.1:4100',
        'http://[::1]:4100',
      ])
        await deny({ audience });
      expect(fetches).toBe(0);

      // Exact issuer identity is checked even when the public key is trusted.
      const jwks = await service.handler(new Request(`${issuer}/.well-known/jwks.json`));
      const publicKeys = await jwks.text();
      for (const wrongIssuer of [`http://${host}:${port + 1}`, `http://${host}`]) {
        await invalid(
          createAccess({
            actions: new Map(),
            auth: {
              issuer: wrongIssuer,
              audience,
              jwksUrl: `${wrongIssuer}/.well-known/jwks.json`,
              fetch: async () => new Response(publicKeys),
            },
          }).authenticate(token, context()),
        );
      }
      for (const state of ['suspended', 'deleted']) {
        await setFixtureAccountState(pool, person, state);
        await invalid(access.authenticate(token, context()));
      }
      await pool.query("UPDATE access.account SET state='active', authn_fenced=true WHERE route=$1 AND account_id=$2", [
        route,
        person,
      ]);
      await invalid(access.authenticate(token, context()));
      await pool.query(
        'UPDATE access.account SET minimum_authn_epoch=2, authn_fenced=false WHERE route=$1 AND account_id=$2',
        [route, person],
      );
      await invalid(access.authenticate(token, context()));
    } finally {
      await stopServer();
      await authPool?.end();
      await pool.query('DELETE FROM access.account WHERE route=$1 AND account_id=$2', [route, person]);
      await dropTestDatabase(pool, database);
    }
  }, 60_000);
}
