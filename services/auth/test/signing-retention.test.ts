import { trustedAccessPorts } from './support/trusted-access.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import { createLocalJWKSet, decodeProtectedHeader, exportJWK, generateKeyPair, jwtVerify, type JWK } from 'jose';
import { migrate, schemaDump, testDatabase } from '../scripts/database.ts';
import { createAuthService, type AuthService, type AuthServiceOptions } from '../src/index.ts';

let fixture: ReturnType<typeof testDatabase>;
let pool: Pool;
let first: AuthService;
let second: AuthService;
let options: AuthServiceOptions;
let keys: JWK[];
const issuer = 'https://retention.auth.test';
const audience = 'https://api.retention.test';
let cookie: string;

beforeAll(async () => {
  fixture = testDatabase();
  pool = new Pool({ connectionString: fixture.url });
  keys = await Promise.all(
    ['a', 'b', 'c', 'd'].map(async (kid) => ({
      ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
      kid,
    })),
  );
  let active = false;
  options = {
    database: pool,
    issuer,
    audience,
    secret: 'retention-fixture-secret-at-least-32-characters',
    signing: { activeKid: 'a', privateKeys: [keys[0]!] },
    trustedAccess: trustedAccessPorts({
      async readFencedAccount(id) {
        return this.readAccount(id);
      },
      async readAccount() {
        return {
          accountId: 'person',
          kind: 'actor',
          state: active ? 'active' : 'pending',
          authnEpoch: 1,
          automated: false,
        };
      },
      async authorizeProvisioning() {
        return { accountId: 'person' };
      },
    }),
  };
  first = await createAuthService(options);
  second = await createAuthService({ ...options, signing: { activeKid: 'a', privateKeys: [] } });
  await first.internal.registerClient({ clientId: 'web', firstParty: true, scopes: ['read'] });
  await first.internal.provisionPassword({
    authorization: 'approved',
    email: 'person@retention.test',
    password: 'correct horse battery staple',
  });
  active = true;
  const login = await request(first, '/signin', {
    email: 'person@retention.test',
    password: 'correct horse battery staple',
    client_id: 'web',
    scope: ['read'],
  });
  expect(login.status).toBe(200);
  cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}, 60_000);

afterAll(async () => {
  await pool?.end();
  fixture?.close();
});

function request(service: AuthService, path: string, body?: unknown) {
  return service.handler(
    new Request(`${issuer}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', origin: issuer, cookie: cookie ?? '' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}
async function issue(service: AuthService) {
  const response = await request(service, '/token', {});
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.expires_in).toBe(300);
  return body.access_token as string;
}
async function jwks(service: AuthService) {
  const response = await request(service, '/.well-known/jwks.json');
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.keys.length).toBeLessThanOrEqual(3);
  for (const key of result.keys) expect(Object.keys(key).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);
  return result;
}

test('two native instances coordinate issuance, next promotion, retention, stale restart and concurrent CAS', async () => {
  const old = await issue(first);
  const oldClaims = (
    await jwtVerify(old, createLocalJWKSet(await jwks(second)), { issuer, audience, algorithms: ['ES256'] })
  ).payload;
  expect(oldClaims.exp! - oldClaims.iat!).toBe(300);
  let state = await first.internal.signing.status();
  state = await first.internal.signing.stage({ expectedGeneration: state.generation, key: keys[1]! });
  expect((await jwks(second)).keys.map((key: JWK) => key.kid).sort()).toEqual(['a', 'b']);
  state = await second.internal.signing.rotate({ expectedGeneration: state.generation, kid: 'b' });
  expect(state).toMatchObject({ current: 'b', next: null, retiring: 'a' });
  const rotatedAt = Date.now();
  const retention = await pool.query('SELECT retain_until FROM auth_signing_key WHERE kid=$1', ['a']);
  // 300s access/ID maximum + 300s recent-expired hint horizon + 30s verifier cache + 60s clock allowance.
  expect(new Date(retention.rows[0].retain_until).getTime()).toBeGreaterThanOrEqual(rotatedAt + 689_000);
  for (const service of [first, second]) {
    expect(decodeProtectedHeader(await issue(service))).toMatchObject({ alg: 'ES256', kid: 'b', typ: 'at+jwt' });
    await jwtVerify(old, createLocalJWKSet(await jwks(service)), { issuer, audience, algorithms: ['ES256'] });
    await jwtVerify(old, createLocalJWKSet(await jwks(service)), {
      issuer,
      audience,
      algorithms: ['ES256'],
      currentDate: new Date((oldClaims.exp! - 1) * 1000),
    });
    await expect(
      jwtVerify(old, createLocalJWKSet(await jwks(service)), {
        issuer,
        audience,
        algorithms: ['ES256'],
        currentDate: new Date((oldClaims.exp! + 1) * 1000),
      }),
    ).rejects.toMatchObject({ code: 'ERR_JWT_EXPIRED' });
  }
  await expect(first.internal.signing.prune({ expectedGeneration: state.generation })).rejects.toMatchObject({
    code: 'signing_rotation_pending',
  });
  state = await first.internal.signing.stage({ expectedGeneration: state.generation, key: keys[2]! });
  expect((await jwks(second)).keys).toHaveLength(3);
  await expect(
    second.internal.signing.rotate({ expectedGeneration: state.generation, kid: 'c' }),
  ).rejects.toMatchObject({ code: 'signing_rotation_pending' });
  await expect(
    first.internal.signing.stage({ expectedGeneration: state.generation, key: keys[3]! }),
  ).rejects.toMatchObject({ code: 'signing_rotation_pending' });
  const restarted = await createAuthService(options);
  expect(decodeProtectedHeader(await issue(restarted)).kid).toBe('b');
  await expect(
    createAuthService({ ...options, signing: { activeKid: 'a', privateKeys: [{ ...keys[3], kid: 'a' }] } }),
  ).rejects.toThrow(/immutable/);
  // Advance only the durable retirement deadline, avoiding sleeps and global clock mocks.
  await pool.query("UPDATE auth_signing_key SET retain_until=statement_timestamp()-interval '1 second' WHERE kid='a'");
  state = await first.internal.signing.prune({ expectedGeneration: state.generation });
  expect((await jwks(second)).keys.map((key: JWK) => key.kid).sort()).toEqual(['b', 'c']);
  const results = await Promise.allSettled([
    first.internal.signing.rotate({ expectedGeneration: state.generation, kid: 'c' }),
    second.internal.signing.rotate({ expectedGeneration: state.generation, kid: 'c' }),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((result) => result.status === 'rejected')).toMatchObject([
    { reason: { code: 'signing_rotation_pending' } },
  ]);
  expect(decodeProtectedHeader(await issue(first)).kid).toBe('c');
  expect((await pool.query('SELECT kid FROM auth_signing_key')).rowCount).toBe(2);
  expect((await pool.query("SELECT kid FROM auth_signing_key_archive WHERE kid='a'")).rowCount).toBe(1);
  // An archived identity cannot be reintroduced or replaced, even after physical hot deletion.
  state = await first.internal.signing.status();
  await expect(
    first.internal.signing.stage({ expectedGeneration: state.generation, key: keys[0]! }),
  ).rejects.toMatchObject({ code: 'signing_rotation_pending' });
  const finalRestart = await createAuthService(options);
  expect(decodeProtectedHeader(await issue(finalRestart)).kid).toBe('c');
});

test('configured sequential rotation remains supported and failed injection is atomic', async () => {
  await expect(createAuthService({ ...options, signing: { activeKid: 'missing', privateKeys: [] } })).rejects.toThrow();
  await expect(
    createAuthService({
      ...options,
      signing: { activeKid: 'c', privateKeys: [keys[0]!, keys[1]!, keys[2]!, keys[3]!] },
    }),
  ).rejects.toThrow();
  await expect(
    createAuthService({ ...options, signing: { activeKid: 'd', privateKeys: [{ ...keys[3], alg: 'HS256' }] } }),
  ).rejects.toThrow();
  const before = await first.internal.signing.status();
  await expect(
    first.internal.signing.stage({ expectedGeneration: before.generation, key: { ...keys[3], x: keys[0]!.x! } }),
  ).rejects.toThrow();
  expect(await first.internal.signing.status()).toEqual(before);
  await pool.query(
    "UPDATE auth_signing_key SET retain_until=statement_timestamp()-interval '1 second' WHERE slot='retiring'",
  );
  await first.internal.signing.prune({ expectedGeneration: before.generation });
  const configured = await createAuthService({ ...options, signing: { activeKid: 'd', privateKeys: [keys[3]!] } });
  expect(decodeProtectedHeader(await issue(configured)).kid).toBe('d');
});

test('migration and generated schema are repeatable', async () => {
  migrate(fixture.url);
  expect(schemaDump(fixture.url, fixture)).toBe(await Bun.file(new URL('../db/schema.sql', import.meta.url)).text());
});

test('bounded legacy cutover archives history and refuses early adoption', async () => {
  const upgrade = testDatabase();
  const database = new Pool({ connectionString: upgrade.url });
  try {
    // Reconstruct the schema immediately before this migration in an isolated DB.
    await database.query(`DROP TABLE auth_signing_generation, auth_signing_key;
      ALTER TABLE auth_signing_key_archive RENAME TO auth_signing_key;
      ALTER TABLE auth_signing_key RENAME CONSTRAINT auth_signing_key_archive_pkey TO auth_signing_key_pkey;
      DELETE FROM schema_migrations WHERE version='20261025102414'`);
    await database.query(
      `INSERT INTO auth_signing_key(kid,private_jwk)
      SELECT 'legacy-'||n,$1::jsonb||jsonb_build_object('kid','legacy-'||n)
      FROM generate_series(1,512) n`,
      [keys[0]],
    );
    migrate(upgrade.url);
    const signing = { activeKid: 'legacy-1', privateKeys: [] };
    await expect(createAuthService({ ...options, database, signing })).rejects.toMatchObject({
      code: 'signing_rotation_pending',
    });
    expect((await database.query('SELECT count(*) FROM auth_signing_key_archive')).rows[0].count).toBe('512');
    expect((await database.query('SELECT count(*) FROM auth_signing_key')).rows[0].count).toBe('0');
    await database.query("UPDATE auth_signing_generation SET upgrade_after=statement_timestamp()-interval '1 second'");
    const adopted = await createAuthService({ ...options, database, signing });
    expect((await jwks(adopted)).keys.map((key: JWK) => key.kid)).toEqual(['legacy-1']);
    expect((await database.query('SELECT count(*) FROM auth_signing_key_archive')).rows[0].count).toBe('512');
    const changed = { ...keys[1], kid: 'legacy-1' };
    await expect(
      createAuthService({ ...options, database, signing: { activeKid: 'legacy-1', privateKeys: [changed] } }),
    ).rejects.toThrow(/immutable/);
  } finally {
    await database.end();
    upgrade.close();
  }
}, 60_000);

test('independent processes follow durable generation and race one promotion', async () => {
  let state = await first.internal.signing.status();
  await pool.query(
    "UPDATE auth_signing_key SET retain_until=statement_timestamp()-interval '1 second' WHERE slot='retiring'",
  );
  state = await first.internal.signing.prune({ expectedGeneration: state.generation });
  state = await first.internal.signing.stage({
    expectedGeneration: state.generation,
    key: { ...keys[0], kid: 'process-next' },
  });
  const program = `
    import { Pool } from 'pg';
    const { createSigner } = await import(process.env.SIGNER_MODULE);
    const pool = new Pool({ connectionString: process.env.SIGNER_DATABASE });
    try {
      const signer = await createSigner(pool, { activeKid: 'a', privateKeys: [] });
      const now = Math.floor(Date.now()/1000);
      const token = await signer.sign({ iss: '${issuer}', aud: '${audience}', sub: 'person',
        client_id: 'web', scope: 'read', authn_epoch: 1, iat: now, exp: now+300, auth_time: now, amr: ['pwd'] });
      let outcome;
      try {
        await signer.control.rotate({ expectedGeneration: Number(process.env.SIGNER_GENERATION), kid: 'process-next' });
        outcome = 'promoted';
      } catch (error) { outcome = error.code; }
      console.log(JSON.stringify({ outcome, token, jwks: await signer.getJwks() }));
    } finally { await pool.end(); }
  `;
  const outputs = await Promise.all(
    [1, 2].map(async () => {
      // pg resolves from the Auth workspace; all connection/material comes from
      // this test's migrated throwaway fixture, never a development database.
      const child = Bun.spawn([process.execPath, '-e', program], {
        cwd: new URL('..', import.meta.url).pathname,
        env: {
          ...process.env,
          SIGNER_MODULE: new URL('../src/signing.ts', import.meta.url).href,
          SIGNER_DATABASE: fixture.url,
          SIGNER_GENERATION: String(state.generation),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, stderr }).toEqual({ code: 0, stderr: '' });
      return JSON.parse(stdout);
    }),
  );
  expect(outputs.map((output) => output.outcome).sort()).toEqual(['promoted', 'signing_rotation_pending']);
  for (const output of outputs) {
    const verified = await jwtVerify(output.token, createLocalJWKSet(output.jwks), {
      issuer,
      audience,
      algorithms: ['ES256'],
    });
    expect(verified.payload.exp! - verified.payload.iat!).toBe(300);
  }
  expect(decodeProtectedHeader(await issue(second)).kid).toBe('process-next');
}, 30_000);
