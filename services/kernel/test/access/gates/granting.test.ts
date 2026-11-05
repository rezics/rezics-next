import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Client, Pool } from 'pg';
import { exportJWK, generateKeyPair } from 'jose';
import { createAuthHost, type AuthService } from '@rezics/auth';
import { createAuthDatabase } from '../../support/auth-database.ts';

async function cloneAuthDatabase(): Promise<{ url: string; close(): Promise<void> }> {
  const name = `granting_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
  const url = await createAuthDatabase(process.env.DATABASE_URL!, name);
  return {
    url,
    async close() {
      const admin = new URL(process.env.DATABASE_URL!);
      admin.pathname = '/postgres';
      const owner = new Client({ connectionString: admin.toString() });
      await owner.connect();
      try {
        await owner.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      } finally {
        await owner.end();
      }
    },
  };
}

// Root `bun test` does not load services/kernel/bunfig.toml. Register the SQL
// loader before any SQL-bearing module is linked; a static import is linked first.
await import('reylo/register');
const { PLATFORM_RESOURCE } = await import('../../../src/access/bootstrap-governance.ts');
const { createAuthBindings } = await import('../../../src/access/auth-bindings.ts');
const { createAccess } = await import('../../../src/access/index.ts');
const { createRegistrationPorts } = await import('../../support/registration-ports.ts');
const { createRegistrationProofBindings } = await import('../../../src/access/registration-proof.ts');
const { createPool, withConnection } = await import('../../../src/database/pool.ts');
const { createKernel } = await import('../../../src/http/kernel.ts');
const { actionCatalogue } = await import('../../../src/http/request.ts');
const { accessCheck } = await import('../../../src/request/access.ts');

const root = new URL('../../../../../', import.meta.url).pathname;
const script = 'services/kernel/scripts/bootstrap-governance.ts';
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');

const issuer = 'https://gate-grants.auth.test';
const audience = 'https://gate-grants.api.test';
const password = 'native gate grant registration password';
const routeKey = new Uint8Array(32).fill(81);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(82)]]) };
const gates = ['gate:any', 'gate:moderation', 'gate:support'] as const;
const group = 'gate:moderation';
const otherGroup = 'gate:support';

const pool = createPool(url);
let authDatabase: Awaited<ReturnType<typeof cloneAuthDatabase>>;
let authPool: Pool;
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let access: ReturnType<typeof createAccess>;
let kernel: ReturnType<typeof createKernel>;
let scopes: string[];

type Person = { accountId: string; email: string; bearer: string };
let staff: Person;
let delegate: Person;
let plain: Person;
let recipient: Person;
let carrier: Person;

async function issue(email: string, scope: readonly string[]) {
  const signed = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'gate-grants-client', scope }),
    }),
  );
  expect(signed.status).toBe(200);
  const cookie = signed.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const response = await service.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { origin: issuer, cookie, 'content-type': 'application/json' },
      body: '{}',
    }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

async function person(name: string, scope: readonly string[]): Promise<Person> {
  const email = `${name}@gate.test`;
  const result = await host.workflows.register({ key: name, handle: name, email, password });
  return { accountId: result.accountId, email, bearer: await issue(email, scope) };
}

function grantBody(accountId: string, actions: readonly string[]) {
  return {
    resource: PLATFORM_RESOURCE,
    subject: { kind: 'account' as const, id: accountId },
    actions: [...actions],
    valid: '(,)',
  };
}

async function call(bearer: string, path: string, body: unknown) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(Bun.randomUUIDv7()),
      },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, value: (await response.json()) as { grant?: { actions: string[] } } };
}

async function grantRows(): Promise<number> {
  const result = await pool.query('SELECT count(*)::int AS n FROM access.resource_grant');
  return result.rows[0].n as number;
}

async function expectDenied(bearer: string, accountId: string, actions: readonly string[]) {
  const before = await grantRows();
  const result = await call(bearer, '/v1/grants', grantBody(accountId, actions));
  expect({ status: result.status, body: result.value }).toMatchObject({ status: 403 });
  expect(result.value).not.toHaveProperty('grant');
  expect(await grantRows()).toBe(before);
}

async function expectGranted(bearer: string, accountId: string, actions: readonly string[]) {
  const result = await call(bearer, '/v1/grants', grantBody(accountId, actions));
  expect({ status: result.status, body: result.value }).toEqual({
    status: 201,
    body: { grant: grantBody(accountId, actions) },
  });
  return result;
}

/** The installed formula's answer for one direct action at this transaction's T. */
async function formula(bearer: string, action: string): Promise<{ allowed: boolean; at: string }> {
  const deadline = Date.now() + 10_000;
  const actor = await access.authenticate(bearer, { pool, deadline });
  const check = await accessCheck(access, actor, action, PLATFORM_RESOURCE, { pool, deadline });
  return withConnection(pool, async (client) => {
    await client.query('BEGIN');
    try {
      const at = (await client.query('SELECT transaction_timestamp()::text AS at')).rows[0].at as string;
      return { allowed: await check(client), at };
    } finally {
      await client.query('ROLLBACK');
    }
  });
}

beforeAll(
  async () => {
    kernel = createKernel({
      pool,
      routeKey,
      tokens,
      writeRate: {
        async spend() {
          return { allowed: true as const };
        },
      },
      access: () => {
        if (access) return access;
        const actions = new Map(actionCatalogue(kernel));
        for (const action of gates) actions.set(action, { anonymous: false });
        access = createAccess({
          actions,
          auth: {
            issuer,
            audience,
            jwksUrl: `${issuer}/.well-known/jwks.json`,
            fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
          },
        });
        return access;
      },
    });
    scopes = ['access:grant', 'gate:any', group, otherGroup, 'thread:create'];
    authDatabase = await cloneAuthDatabase();
    authPool = new Pool({ connectionString: authDatabase.url });
    const signingKey = {
      ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
      kid: 'gate-grants',
    };
    const registration = createRegistrationProofBindings({ pool, referenceKeys: tokens });
    const { ports: registrationPorts } = createRegistrationPorts({
      pool,
      authPool,
      routeKey,
      referenceKeys: tokens,
    });
    host = await createAuthHost({
      database: authPool,
      systemDatabasePool: authPool,
      issuer,
      audience,
      secret: 'gate-grants-auth-persistent-secret-32bytes',
      signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
      trustedAccess: createAuthBindings({
        pool,
        ...registration,
        verifyPendingIdentity: registration.verifyNativePendingIdentity,
      }),
      access: registrationPorts,
      stagingKey: new Uint8Array(32).fill(83),
      maintenanceSchedule: '0 0 1 1 *',
      executorId: 'gate-grants-executor',
    });
    service = host.service;
    await service.internal.registerClient({ clientId: 'gate-grants-client', firstParty: true, scopes });
    await host.start();
    // Staff's grant token carries access:grant and gate:any, not the group itself.
    const staffScopes = ['access:grant', 'gate:any', 'thread:create'];
    const broad = ['access:grant', 'gate:any', group, otherGroup, 'thread:create'];
    staff = await person('gate_staff', staffScopes);
    delegate = await person('gate_delegate', broad);
    plain = await person('gate_plain', broad);
    recipient = await person('gate_recipient', broad);
    carrier = await person('gate_carrier', broad);
    const child = Bun.spawn(['bun', script, '--account', staff.accountId], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: url },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: '', stderr: '' });
    // Auth database setup runs four external commands with 120 s limits, followed
    // by five native registrations, token exchanges and the governance bootstrap.
  },
  4 * 120_000 + 60_000,
);

afterAll(async () => {
  if (host) await host.stop();
  else await authPool?.end();
  await authDatabase?.close();
  await pool.end();
}, 60_000);

test('platform gates are granted and revoked through the ordinary grant routes', async () => {
  // A direct access:grant holding alone cannot grant either gate action.
  const beforePlainGrant = await grantRows();
  await expectGranted(staff.bearer, plain.accountId, ['access:grant']);
  expect(await grantRows()).toBe(beforePlainGrant + 1);
  expect(await formula(plain.bearer, 'access:grant')).toMatchObject({ allowed: true });
  await expectDenied(plain.bearer, recipient.accountId, [group]);
  await expectDenied(plain.bearer, carrier.accountId, ['gate:any']);

  // Bootstrap governance carries gate:any. It covers group grant administration,
  // while permission evaluation still treats the covering action as exact.
  expect(await formula(staff.bearer, 'gate:any')).toMatchObject({ allowed: true });
  // The formula does not treat gate:any as the group, even when the token names that group.
  const staffGroup = await issue(staff.email, ['access:grant', 'gate:any', group]);
  expect(await formula(staffGroup, group)).toMatchObject({ allowed: false });

  await expectGranted(staff.bearer, recipient.accountId, [group]);
  const granted = await formula(recipient.bearer, group);
  expect(granted.allowed).toBe(true);
  await expectDenied(staff.bearer, recipient.accountId, ['thread:create']);

  await expectGranted(staff.bearer, delegate.accountId, ['access:grant', group]);

  // One group's gate plus access:grant grants that gate and no other.
  await expectGranted(delegate.bearer, carrier.accountId, [group]);
  expect(await formula(carrier.bearer, group)).toMatchObject({ allowed: true });
  await expectDenied(delegate.bearer, carrier.accountId, [otherGroup]);
  await expectDenied(delegate.bearer, carrier.accountId, ['gate:any']);
  await expectDenied(delegate.bearer, carrier.accountId, ['thread:create']);

  // access:grant without the gate cannot grant it, and cannot grant gate:any.
  await expectDenied(plain.bearer, recipient.accountId, [group]);
  await expectDenied(plain.bearer, recipient.accountId, ['gate:any']);

  // A holder of gate:any can grant gate:any. The delegate, who lacks it, cannot.
  await expectGranted(staff.bearer, carrier.accountId, ['gate:any']);
  expect(await formula(carrier.bearer, 'gate:any')).toMatchObject({ allowed: true });
  await expectDenied(delegate.bearer, plain.accountId, ['gate:any']);

  const revokeKey = Bun.randomUUIDv7();
  const revoked = await kernel.handle(
    new Request('http://kernel.test/v1/grants:revoke', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${staff.bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(revokeKey),
      },
      body: JSON.stringify(grantBody(recipient.accountId, [group])),
    }),
  );
  expect(revoked.status).toBe(200);
  const receipt = await pool.query(
    `SELECT created_at::text AS at FROM core.receipt
     WHERE partition_no = 0 AND principal_id = $1 AND command_kind = 'access.grant.revoke'
       AND idempotency_key = $2`,
    [staff.accountId, `0:${revokeKey}`],
  );
  const ended = await formula(recipient.bearer, group);
  const order = await pool.query('SELECT $1::timestamptz >= $2::timestamptz AS at_revoke', [
    ended.at,
    receipt.rows[0].at,
  ]);
  const afterGrant = await pool.query('SELECT $1::timestamptz >= $2::timestamptz AS later', [ended.at, granted.at]);
  expect(ended.allowed).toBe(false);
  expect(order.rows[0].at_revoke).toBe(true);
  expect(afterGrant.rows[0].later).toBe(true);
  const still = await pool.query(
    `SELECT count(*)::int AS n FROM access.resource_grant
     WHERE route = $1 AND resource_id = $2 AND subject_id = $3 AND action = $4 AND valid @> $5::timestamptz`,
    [PLATFORM_RESOURCE.route, PLATFORM_RESOURCE.id, recipient.accountId, group, ended.at],
  );
  expect(still.rows[0].n).toBe(0);
}, 60_000);
