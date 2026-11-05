import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { Pool } from 'pg';
import { createAuthHost, type AccountWorkflowPorts } from '@rezics/auth';
import { testDatabase } from '../../../auth/scripts/database.ts';
import { trustedAccessPorts } from '../../../auth/test/support/trusted-access.ts';

const issuer = 'https://kind-consent-auth.test';
const accessIssuer = 'https://kind-consent.cloudflareaccess.com';
const accessAudience = 'kind-consent-private';
const serviceTokenId = 'kind-consent-worker.access';
const serviceTokenSecret = 'kind-consent-worker-private-service-secret';
const accountId = 'kind-consent-account';
const clientId = 'kind-consent-client';
const scopes = ['books:read', 'catalogue:read'];

let fixture: ReturnType<typeof testDatabase>;
let database: Pool;
let systemDatabase: Pool;
let host: Awaited<ReturnType<typeof createAuthHost>>;
let jwksServer: ReturnType<typeof Bun.serve>;
let privateServer: ReturnType<typeof Bun.serve>;
let accessToken: string;
let deadlineSeen: Promise<number>;
let resolveDeadlineSeen!: (deadline: number) => void;
let deadlineHeaderSeen: Promise<string | null>;
let resolveDeadlineHeaderSeen!: (deadline: string | null) => void;

const unused = async (): Promise<never> => {
  throw new Error('Unexpected account workflow access');
};
const access: AccountWorkflowPorts = {
  registrationTarget: () => {
    throw new Error('Unexpected registration target');
  },
  reserveHandle: unused,
  createPending: unused,
  claimHandle: unused,
  activate: unused,
  expireRegistration: unused,
  releaseExpiredRegistrationHandle: unused,
  provisioningReference: unused,
  provisioningEvidence: unused,
  raiseFence: unused,
  readAccount: unused,
};

beforeAll(async () => {
  fixture = testDatabase();
  database = new Pool({ connectionString: fixture.url });
  systemDatabase = new Pool({ connectionString: fixture.url, max: 8 });
  const signingPair = await generateKeyPair('ES256', { extractable: true });
  const signingJwk = { ...(await exportJWK(signingPair.privateKey)), kid: 'kind-consent-host', alg: 'ES256' };
  const accessPair = await generateKeyPair('RS256', { extractable: true });
  const publicAccessKey = { ...(await exportJWK(accessPair.publicKey)), kid: 'kind-consent-access', alg: 'RS256' };
  jwksServer = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => Response.json({ keys: [publicAccessKey] }) });
  const now = Math.floor(Date.now() / 1000);
  accessToken = await new SignJWT({
    type: 'app',
    common_name: serviceTokenId,
    sub: '',
    iss: accessIssuer,
    aud: [accessAudience],
    iat: now,
    exp: now + 60,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'kind-consent-access' })
    .sign(accessPair.privateKey);

  await database.query('INSERT INTO auth_client (client_id,first_party,scopes) VALUES ($1,false,$2)', [
    clientId,
    scopes,
  ]);
  await database.query('INSERT INTO auth_client_coverage (client_id,ready) VALUES ($1,true)', [clientId]);
  await database.query('INSERT INTO auth_consent (account_id,client_id,scopes) VALUES ($1,$2,$3)', [
    accountId,
    clientId,
    scopes,
  ]);

  host = await createAuthHost({
    database,
    systemDatabasePool: systemDatabase,
    issuer,
    audience: `${issuer}/api`,
    secret: 'kind-consent-host-secret-long-enough-for-auth',
    signing: { activeKid: signingJwk.kid!, privateKeys: [signingJwk] },
    trustedAccess: trustedAccessPorts({ readAccount: async () => null, authorizeProvisioning: unused }),
    access,
    stagingKey: randomBytes(32),
    maintenanceSchedule: '0 0 0 1 1 *',
    executorId: 'kind-consent-host',
    privateConsent: {
      issuer: accessIssuer,
      jwksUrl: `${jwksServer.url}cdn-cgi/access/certs`,
      audience: accessAudience,
      allowedServiceTokenIds: [serviceTokenId],
    },
  });
  await host.start();
  deadlineSeen = new Promise<number>((resolve) => {
    resolveDeadlineSeen = resolve;
  });
  deadlineHeaderSeen = new Promise<string | null>((resolve) => {
    resolveDeadlineHeaderSeen = resolve;
  });
  privateServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (request) => {
      if (new URL(request.url).pathname === '/internal/v1/kind-consents:enroll')
        void request
          .clone()
          .json()
          .then((body: { deadline: number }) => resolveDeadlineSeen(body.deadline));
      if (new URL(request.url).pathname === '/internal/v1/kind-consents:enroll')
        resolveDeadlineHeaderSeen(request.headers.get('X-Rezics-Kind-Deadline'));
      return host.privateConsentHandler!(request);
    },
  });
}, 60_000);

afterAll(async () => {
  privateServer?.stop(true);
  jwksServer?.stop(true);
  if (host) await host.stop();
  else await Promise.allSettled([database?.end(), systemDatabase?.end()]);
  fixture?.close();
});

test('default Work composition enrolls the original Kind consumer through private Auth with one bounded charge', async () => {
  const deadline = Date.now() + 20_000;
  const input = {
    accountId,
    clientId,
    requestedScopes: scopes,
    consumer: {
      route: 'collection/kind-consent',
      ownerAccountId: accountId,
      collectionId: 'collection-kind-consent',
      preparationId: 'preparation-kind-consent',
      originId: 'origin-kind-consent',
    },
  };
  const program = `
    import assert from 'node:assert/strict';
    import pg from 'pg';
    import { composeWork } from './src/work/registry.ts';

    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('Cf-Access-Jwt-Assertion', process.env.TEST_ACCESS_TOKEN);
      const target = new URL(String(input));
      const proxied = await originalFetch(process.env.TEST_PRIVATE_ORIGIN + target.pathname, { ...init, headers });
      return new Response(proxied.body, { status: proxied.status, headers: proxied.headers });
    };
    const pool = new pg.Pool({ connectionString: 'postgres://unused/work' });
    let context;
    await composeWork(
      [{ name: 'kind-consent', register(value) { context = value; } }],
      {
        databaseUrl: 'postgres://unused/work',
        pool,
        client: { async registerQueue() {} },
        env: {
          KERNEL_AUTH_CONSENT_URL: 'https://private-auth.test/internal/v1/consents:read',
          CF_ACCESS_CLIENT_ID: process.env.TEST_SERVICE_TOKEN_ID,
          CF_ACCESS_CLIENT_SECRET: process.env.TEST_SERVICE_TOKEN_SECRET,
        },
      },
    );
    const participant = context.getKindConsentParticipant(Number(process.env.TEST_DEADLINE));
    assert.ok(participant);
    const input = JSON.parse(process.env.TEST_INPUT);
    const bound = participant.enroll.bound(input);
    assert.ok(bound);
    const result = await participant.enroll(input);
    assert.equal(result.status, 'enrolled');
    assert.deepEqual(result.effectiveScopes, ['books:read', 'catalogue:read']);
    const actual = participant.enroll.actual(input, result);
    assert.ok(actual);
    for (const group of ['source', 'access']) {
      assert.deepEqual(Object.keys(actual[group]).sort(), Object.keys(bound[group]).sort());
      for (const [axis, value] of Object.entries(actual[group])) {
        assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= bound[group][axis], group + '.' + axis);
      }
    }
    assert.equal(participant.enroll.actual(input, result), undefined);
    await pool.end();
    process.stdout.write(JSON.stringify({ result, bound, actual, deadline: Number(process.env.TEST_DEADLINE) }));
  `;
  const child = Bun.spawn([process.execPath, '-e', program], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: {
      ...process.env,
      TEST_ACCESS_TOKEN: accessToken,
      TEST_PRIVATE_ORIGIN: new URL(privateServer.url).origin,
      TEST_SERVICE_TOKEN_ID: serviceTokenId,
      TEST_SERVICE_TOKEN_SECRET: serviceTokenSecret,
      TEST_DEADLINE: String(deadline),
      TEST_INPUT: JSON.stringify(input),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, errors).toBe(0);
  const observed = JSON.parse(output) as { deadline: number; bound: unknown; actual: unknown };
  expect(observed.deadline).toBe(deadline);
  expect(await deadlineSeen).toBe(deadline);
  expect(await deadlineHeaderSeen).toBe(String(deadline));
  expect(observed.actual).toBeDefined();
  expect(observed.bound).toBeDefined();
}, 60_000);

test('maximum stored scopes fit canonical private transport actual with one-use invocation binding', async () => {
  const maxClientId = 'kind-consent-maximum-scopes-client';
  const maximumScopes = Array.from(
    { length: 512 },
    (_, index) => `${index.toString(16).padStart(3, '0')}${'x'.repeat(125)}`,
  );
  const escapedIdentifier = '\\'.repeat(1024);
  await database.query('INSERT INTO auth_client (client_id,first_party,scopes) VALUES ($1,false,$2)', [
    maxClientId,
    maximumScopes,
  ]);
  await database.query('INSERT INTO auth_client_coverage (client_id,ready) VALUES ($1,true)', [maxClientId]);
  await database.query('INSERT INTO auth_consent (account_id,client_id,scopes) VALUES ($1,$2,$3)', [
    accountId,
    maxClientId,
    maximumScopes,
  ]);

  const deadline = Date.now() + 20_000;
  const input = {
    accountId,
    clientId: maxClientId,
    requestedScopes: maximumScopes,
    consumer: {
      route: escapedIdentifier,
      ownerAccountId: escapedIdentifier,
      collectionId: escapedIdentifier,
      preparationId: escapedIdentifier,
      originId: escapedIdentifier,
    },
  };
  const program = `
    import assert from 'node:assert/strict';
    import pg from 'pg';
    import { composeWork } from './src/work/registry.ts';

    const originalFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set('Cf-Access-Jwt-Assertion', process.env.TEST_ACCESS_TOKEN);
      const target = new URL(String(input));
      const proxied = await originalFetch(process.env.TEST_PRIVATE_ORIGIN + target.pathname, { ...init, headers });
      return new Response(proxied.body, { status: proxied.status, headers: proxied.headers });
    };
    const pool = new pg.Pool({ connectionString: 'postgres://unused/work' });
    let context;
    await composeWork(
      [{ name: 'kind-consent', register(value) { context = value; } }],
      {
        databaseUrl: 'postgres://unused/work',
        pool,
        client: { async registerQueue() {} },
        env: {
          KERNEL_AUTH_CONSENT_URL: 'https://private-auth.test/internal/v1/consents:read',
          CF_ACCESS_CLIENT_ID: process.env.TEST_SERVICE_TOKEN_ID,
          CF_ACCESS_CLIENT_SECRET: process.env.TEST_SERVICE_TOKEN_SECRET,
        },
      },
    );
    const input = JSON.parse(process.env.TEST_INPUT);
    const participant = context.getKindConsentParticipant(Number(process.env.TEST_DEADLINE));
    assert.ok(participant);
    const bound = participant.enroll.bound(input);
    assert.ok(bound);
    const result = await participant.enroll(input);
    assert.equal(result.status, 'enrolled');
    assert.deepEqual(result.effectiveScopes, input.requestedScopes);
    const lookalike = { ...input, requestedScopes: [...input.requestedScopes], consumer: { ...input.consumer } };
    assert.equal(participant.enroll.actual(lookalike, result), undefined);
    const actual = participant.enroll.actual(input, result);
    assert.ok(actual);
    for (const group of ['source', 'access']) {
      assert.deepEqual(Object.keys(actual[group]).sort(), Object.keys(bound[group]).sort());
      for (const [axis, value] of Object.entries(actual[group])) {
        assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= bound[group][axis], group + '.' + axis);
      }
    }
    assert.equal(actual.source.nativeRows, 2);
    assert.equal(actual.access.rows, 2);
    assert.equal(participant.enroll.actual(input, result), undefined);
    await pool.end();
    process.stdout.write(JSON.stringify({ bound, actual }));
  `;
  const child = Bun.spawn([process.execPath, '-e', program], {
    cwd: new URL('../..', import.meta.url).pathname,
    env: {
      ...process.env,
      TEST_ACCESS_TOKEN: accessToken,
      TEST_PRIVATE_ORIGIN: new URL(privateServer.url).origin,
      TEST_SERVICE_TOKEN_ID: serviceTokenId,
      TEST_SERVICE_TOKEN_SECRET: serviceTokenSecret,
      TEST_DEADLINE: String(deadline),
      TEST_INPUT: JSON.stringify(input),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, output, errors] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(exitCode, errors).toBe(0);
  const observed = JSON.parse(output) as {
    bound: { source: { bytes: number } };
    actual: { source: { bytes: number } };
  };
  expect(observed.actual.source.bytes).toBeLessThanOrEqual(observed.bound.source.bytes);
  expect(observed.actual.source.bytes).toBeGreaterThan(67_073);
}, 60_000);
