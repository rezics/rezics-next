import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { Client, Pool } from 'pg';
import { createAuthHost, type AuthService } from '@rezics/auth';
import { decodeJwt, exportJWK, generateKeyPair, importJWK, SignJWT } from 'jose';
import { createAuthDatabase } from '../support/auth-database.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { createAccess } from '../../src/access/index.ts';
import { authoritativeTimeValue } from '../../src/command/command.ts';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { createLifecycleInternals } from '../../src/access/lifecycle.ts';
import { createRegistrationPorts } from '../support/registration-ports.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { ACCESS_EVENTS } from '../../src/access/events.ts';
import { EVENT_TYPES } from '../../src/events/log.ts';
import { Value } from 'typebox/value';
import { readPublicAccount } from '../../src/access/account-data.ts';

async function cloneAuthDatabase(): Promise<{ url: string; close(): Promise<void> }> {
  const name = `suspension_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
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

const issuer = 'https://suspension.auth.test';
const audience = 'https://suspension.api.test';
const password = 'native grant routes registration password';
const routeKey = new Uint8Array(32).fill(71);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(72)]]) };
// Auth provisioning has a 120 s command budget; each of three registrations
// waits up to 30 s for pending, credential and activation.
const setupTimeout = 120_000 + 3 * 3 * 30_000;
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let authDatabase: Awaited<ReturnType<typeof cloneAuthDatabase>>;
let authPool: Pool;
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let access: ReturnType<typeof createAccess>;
let grants: ReturnType<typeof createGrantCommands>;
let kernel: ReturnType<typeof createKernel>;
let signingKey: Awaited<ReturnType<typeof exportJWK>> & { kid: string };
let root: { accountId: string; bearer: string };
let grantor: typeof root;
let recipient: typeof root;
let scopes: string[];
let now = Date.now();
let spends = 0;
let lifecycle: ReturnType<typeof createLifecycleInternals>;

async function issue(email: string, scope = scopes) {
  const signed = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'suspension-client', scope }),
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
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      body: '{}',
    }),
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}
async function person(name: string) {
  const result = await host.workflows.register({ key: name, handle: name, email: `${name}@suspension.test`, password });
  return { accountId: result.accountId, bearer: await issue(`${name}@suspension.test`) };
}
async function call(
  bearer: string,
  path: string,
  body: unknown,
  key = Bun.randomUUIDv7(),
  extra: Record<string, string> = {},
) {
  now = Date.now();
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: 'POST',
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(key),
        ...extra,
      },
      body: JSON.stringify(body),
    }),
  );
  return { response, value: await response.json() };
}
const inputFor = (accountId: string, actions = ['context:create']) => ({
  resource: PLATFORM_RESOURCE,
  subject: { kind: 'account' as const, id: accountId },
  actions,
  valid: '(,)',
});
const context = async (bearer: string) => {
  now = Date.now();
  const boundary = { pool: db.pool, deadline: Date.now() + 10000 };
  return { ...boundary, actor: await access.authenticate(bearer, boundary) };
};
const effects = async () =>
  (
    await db.admin.query(`SELECT
  (SELECT count(*)::int FROM core.receipt) receipts,
  (SELECT count(*)::int FROM core.outbox) events,
  (SELECT count(*)::int FROM access.resource_grant) grants,
  (SELECT count(*)::int FROM access.resource_role_grant) roles`)
  ).rows;

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  const limiter = createWriteRateLimiter({
    secret: 'suspension-private-write-rate-secret-32bytes',
    overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 86400 } } }),
  });
  kernel = createKernel({
    pool: db.pool,
    routeKey,
    tokens,
    receiptKeys: testReceiptKeys(),
    clock: () => new Date(now),
    access: (config) => {
      expect([...config.actions]).toEqual([...actionCatalogue(kernel)]);
      return access;
    },
    writeRate: {
      async spend(...args) {
        spends++;
        return limiter.spend(...args);
      },
    },
  });
  const actions = actionCatalogue(kernel);
  scopes = [...actions.keys()].filter((action) => action !== 'media:complete');
  authDatabase = await cloneAuthDatabase();
  authPool = new Pool({ connectionString: authDatabase.url });
  signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'suspension',
  };
  access = createAccess({
    actions,
    auth: {
      issuer,
      audience,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      fetch: async () => service.handler(new Request(`${issuer}/.well-known/jwks.json`)),
    },
  });
  grants = createGrantCommands({ pool: db.pool, access, managementAction: 'access:grant' });
  // Compose the existing native human registration ports directly. The full
  // account binding also requires unmounted operator-management routes, which
  // belong to a separate module. No action is added to the mounted catalogue.
  const registration = createRegistrationProofBindings({ pool: db.pool, referenceKeys: tokens });
  const { ports: registrationPorts, internal } = createRegistrationPorts({
    pool: db.pool,
    authPool,
    routeKey,
    referenceKeys: tokens,
  });
  lifecycle = internal;
  host = await createAuthHost({
    database: authPool,
    systemDatabasePool: authPool,
    issuer,
    audience,
    secret: 'suspension-auth-persistent-secret-32bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: createAuthBindings({
      pool: db.pool,
      ...registration,
      verifyPendingIdentity: registration.verifyNativePendingIdentity,
    }),
    access: registrationPorts,
    stagingKey: new Uint8Array(32).fill(73),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'suspension-executor',
  });
  service = host.service;
  await service.internal.registerClient({ clientId: 'suspension-client', firstParty: true, scopes });
  await host.start();
  root = await person('grant_root');
  grantor = await person('grant_grantor');
  recipient = await person('grant_recipient');
  const bootstrap = Bun.spawn(['bun', 'scripts/bootstrap-governance.ts', '--account', root.accountId], {
    env: { ...process.env, DATABASE_URL: db.url },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(await bootstrap.exited).toBe(0);
}, setupTimeout);
afterAll(async () => {
  await host?.stop();
  await authDatabase?.close();
  await db?.close();
});

const pathFor = (accountId: string) => `/v1/accounts/${accountId}:suspend`;
const account = async (accountId: string) =>
  (
    await db.admin.query('SELECT * FROM access.account WHERE route=$1 AND account_id=$2', [
      routeOf(accountId),
      accountId,
    ])
  ).rows[0]!;

test('native Auth and mounted platform suspension commit the real terminal state and revoke cached actors', async () => {
  expect(actionCatalogue(kernel).get('account:suspend')).toEqual({ anonymous: false });
  const mounted = kernel.routes.filter((route) => route.path === '/v1/accounts/:accountId/$suspend');
  expect(mounted).toHaveLength(1);
  expect(mounted[0]!.hooks.detail).toMatchObject({
    operationId: 'account.suspend',
    'x-action': 'account:suspend',
    'x-rate-limit': { family: 'write', units: 1 },
    security: [{ bearerAuth: [] }],
  });
  const target = await person('suspend_target');
  await grants.create(await context(root.bearer), {
    ...inputFor(target.accountId, ['account:suspend']),
    key: Bun.randomUUIDv7(),
  });
  const cached = await context(target.bearer);
  const { createSuspensionCommands } = await import('../../src/access/suspension.ts');
  const commands = createSuspensionCommands({ pool: db.pool, access, clock: () => new Date(now) });
  const victim = await person('cached_victim');
  const cachedInput = { accountId: victim.accountId, key: Bun.randomUUIDv7() };
  expect((await commands.suspend(cached, cachedInput)).replayed).toBe(false);
  const before = await account(target.accountId);
  const key = Bun.randomUUIDv7();
  const reason = 'private moderation evidence';
  const result = await call(root.bearer, pathFor(target.accountId), { reason }, key);
  expect(result.response.status).toBe(200);
  expect(Object.keys(result.value)).toEqual(['suspension']);
  const after = await account(target.accountId);
  expect(after).toMatchObject({
    state: 'suspended',
    minimum_authn_epoch: String(Number(before.minimum_authn_epoch) + 1),
    authn_fenced: true,
    suspension_reason: reason,
  });
  for (const field of ['handle', 'display_name', 'biography', 'operator_account_id'])
    expect(after[field]).toEqual(before[field]);
  const receipt = (
    await db.admin.query(
      'SELECT * FROM access.lifecycle_fence_receipt WHERE route=$1 AND account_id=$2 AND receipt_id=$3',
      [after.route, target.accountId, after.fence_receipt_id],
    )
  ).rows[0]!;
  expect(receipt).toMatchObject({
    kind: 'fence',
    minimum_authn_epoch: after.minimum_authn_epoch,
    transaction_id: after.transaction_id,
  });
  const stored = (await db.admin.query('SELECT * FROM core.receipt WHERE transaction_id=$1', [after.transaction_id]))
    .rows;
  expect(stored).toHaveLength(1);
  expect(stored[0].response).toEqual(result.value.suspension);
  const audit = (
    await db.admin.query('SELECT * FROM core.outbox WHERE partition_no=$1 AND position=$2', [
      stored[0].partition_no,
      stored[0].position,
    ])
  ).rows;
  expect(audit).toHaveLength(1);
  expect(JSON.stringify(audit)).not.toContain(reason);
  expect(JSON.stringify(result.value)).not.toContain(reason);
  expect(audit[0].type).toBe('com.rezics.access.account.suspended.v1');
  const schema = ACCESS_EVENTS()['com.rezics.access.account.suspended.v1'];
  expect(EVENT_TYPES()['com.rezics.access.account.suspended.v1']).toBe(schema);
  expect(Value.Check(schema, audit[0].data)).toBe(true);
  expect(Value.Check(schema, { ...audit[0].data, reason })).toBe(false);
  expect(JSON.stringify(await readPublicAccount(db.pool, after.route, target.accountId))).not.toContain(reason);
  expect(JSON.stringify(stored[0])).not.toContain(reason);
  const effectsAfter = await effects();
  expect((await call(root.bearer, pathFor(target.accountId), { reason }, key)).value).toEqual(result.value);
  expect(await effects()).toEqual(effectsAfter);
  expect(await account(target.accountId)).toEqual(after);
  await expect(
    access.authenticate(target.bearer, { pool: db.pool, deadline: Date.now() + 10000 }),
  ).rejects.toMatchObject({ status: 401 });
  expect((await call(target.bearer, pathFor(recipient.accountId), {})).response.status).toBe(401);
  await expect(commands.suspend(cached, cachedInput)).rejects.toThrow();
  await expect(commands.suspend(cached, { accountId: recipient.accountId, key: Bun.randomUUIDv7() })).rejects.toThrow();
  await grants.create(await context(root.bearer), { ...inputFor(recipient.accountId), key: Bun.randomUUIDv7() });
  const published = await call(root.bearer, '/v1/definitions/releases', {
    release: {
      format: 'https://rezics.com/definitions/release/1',
      catalogue: { id: 'https://rezics.com/catalogue/test', version: '1' },
      generator: { name: 'test', version: '1' },
      prefixes: {},
      types: {},
      properties: {},
    },
  });
  expect(published.response.status).toBe(201);
  const { digest } = published.value as { digest: string };
  expect(
    (await call(root.bearer, `/v1/definitions/releases/${digest}:activate`, { expected_head: null })).response.status,
  ).toBe(200);
  expect((await call(recipient.bearer, '/v1/contexts', { labels: { en: 'Unrelated account' } })).response.status).toBe(
    201,
  );
});

test('the mounted action checks Global Context at the sole clock and independently denies actor, scope and principal ceilings', async () => {
  const target = await person('ceilings_target');
  const noScope = await issue('grant_root@suspension.test', ['context:create']);
  const requestId = newId(routeOf(recipient.accountId)!);
  await db.admin.query(
    `INSERT INTO access.principal_assignment(route,principal_id,creator_principal_id,request_id,assigned_actor_id,valid,transaction_id) VALUES($1,$2,$2,$3,$4,'(,)',$5)`,
    [routeOf(recipient.accountId), recipient.accountId, requestId, root.accountId, Bun.randomUUIDv7()],
  );
  const delegated = await new SignJWT({
    ...decodeJwt<Record<string, unknown>>(root.bearer),
    requested_by: `urn:rezics:request:${recipient.accountId}:${requestId}`,
  })
    .setProtectedHeader({ alg: 'ES256', kid: signingKey.kid, typ: 'at+jwt' })
    .sign(await importJWK(signingKey, 'ES256'));
  for (const bearer of [recipient.bearer, noScope, delegated]) {
    const before = await effects();
    const row = await account(target.accountId);
    expect((await call(bearer, pathFor(target.accountId), {})).response.status).toBe(403);
    expect(await effects()).toEqual(before);
    expect(await account(target.accountId)).toEqual(row);
  }
  const observed: { action: string; resource: unknown; time: string }[] = [];
  const authorize = access.authorize.bind(access);
  const observation = spyOn(access, 'authorize').mockImplementation(
    (client, actor, action, resource, evidence, time) => {
      if (time) observed.push({ action, resource, time: authoritativeTimeValue(time) });
      return authorize(client, actor, action, resource, evidence, time);
    },
  );
  try {
    expect(
      (await call(root.bearer, pathFor(target.accountId), {}, Bun.randomUUIDv7(), { 'x-command-time': '1990-01-01' }))
        .response.status,
    ).toBe(200);
  } finally {
    observation.mockRestore();
  }
  expect(Date.parse(observed[0]!.time)).toBe(now);
  expect(observed).toEqual([{ action: 'account:suspend', resource: PLATFORM_RESOURCE, time: observed[0]!.time }]);
});

test('replay checks current governance and consent scopes before disclosing stored results', async () => {
  const target = await person('replay_target');
  const rights = inputFor(grantor.accountId, ['account:suspend']);
  expect((await call(root.bearer, '/v1/grants', rights)).response.status).toBe(201);
  const key = Bun.randomUUIDv7();
  expect((await call(grantor.bearer, pathFor(target.accountId), {}, key)).response.status).toBe(200);
  const before = await effects();
  const limited = await issue('grant_grantor@suspension.test', ['context:create']);
  expect((await call(limited, pathFor(target.accountId), {}, key)).response.status).toBe(403);
  expect(await effects()).toEqual(before);
  expect((await call(root.bearer, '/v1/grants:revoke', rights)).response.status).toBe(200);
  const revoked = await effects();
  expect((await call(grantor.bearer, pathFor(target.accountId), {}, key)).response.status).toBe(403);
  expect(await effects()).toEqual(revoked);
});

test('strict input, anonymous requests and wrong-resource authority have zero effects', async () => {
  const target = await person('invalid_target');
  for (const body of [
    { reason: '' },
    { reason: 'x'.repeat(2001) },
    { reason: 1 },
    { accountId: target.accountId },
    { state: 'suspended' },
    { resource: PLATFORM_RESOURCE },
  ]) {
    const before = await effects();
    const spent = spends;
    expect((await call(root.bearer, pathFor(target.accountId), body)).response.status).toBe(400);
    expect(spends).toBe(spent);
    expect(await effects()).toEqual(before);
  }
  expect((await call('', pathFor(target.accountId), {})).response.status).toBe(401);
  expect((await call(root.bearer, pathFor('bad-id'), {})).response.status).toBe(400);
  const wrong = {
    ...inputFor(recipient.accountId, ['account:suspend']),
    resource: { route: routeOf(target.accountId)!, id: target.accountId },
  };
  await expect(grants.create(await context(root.bearer), { ...wrong, key: Bun.randomUUIDv7() })).rejects.toThrow();
  expect((await call(recipient.bearer, pathFor(target.accountId), {})).response.status).toBe(403);
});

test('suspension preserves membership, first-owner and operator reservations indefinitely', async () => {
  const owner = await person('held_owner');
  const member = await person('held_member');
  const operator = await person('held_operator');
  const organizationId = newId(0x7310);
  const held = await lifecycle.reserveCoordination({
    accountId: owner.accountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: Bun.randomUUIDv7(),
  });
  await lifecycle.createOrganization({
    organizationId,
    ownerAccountId: owner.accountId,
    ownerReservationId: held.value.reservationId,
    key: Bun.randomUUIDv7(),
  });
  await lifecycle.reserveCoordination({
    accountId: member.accountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: Bun.randomUUIDv7(),
  });
  await lifecycle.reserveCoordination({
    accountId: operator.accountId,
    relatedAccountId: newId(0x7311),
    purpose: 'operator',
    key: Bun.randomUUIDv7(),
  });
  for (const subject of [owner, member, operator]) {
    const before = await account(subject.accountId);
    const effectsBefore = await effects();
    expect((await call(root.bearer, pathFor(subject.accountId), {})).response.status).toBe(200);
    const after = await account(subject.accountId);
    expect(after).toMatchObject({
      ...before,
      state: 'suspended',
      authn_fenced: true,
      minimum_authn_epoch: String(Number(before.minimum_authn_epoch) + 1),
      fence_receipt_id: expect.any(String),
      transaction_id: expect.any(String),
    });
    const effectsAfter = (await effects())[0]!;
    expect(effectsAfter).toEqual({
      ...effectsBefore[0]!,
      receipts: effectsBefore[0]!.receipts + 1,
      events: effectsBefore[0]!.events + 1,
    });
    expect(
      (
        await db.admin.query(
          'SELECT count(*)::int AS count FROM access.lifecycle_coordination WHERE route=$1 AND account_id=$2',
          [routeOf(subject.accountId), subject.accountId],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  }
  expect(
    (
      await db.admin.query(
        'SELECT role FROM access.organization_member WHERE route=$1 AND organization_id=$2 AND member_account_id=$3',
        [routeOf(organizationId), organizationId, owner.accountId],
      )
    ).rows,
  ).toEqual([{ role: 'owner' }]);
});

test('concurrent retries have one effect; a different command cannot transition a suspended or pending account', async () => {
  const target = await person('concurrent_target');
  const key = Bun.randomUUIDv7();
  const before = await account(target.accountId);
  db.pool.options.max = 4;
  const results = await Promise.all(
    Array.from({ length: 4 }, () => call(root.bearer, pathFor(target.accountId), {}, key)),
  );
  db.pool.options.max = 1;
  expect(results.map((r) => r.response.status)).toEqual([200, 200, 200, 200]);
  expect(results.every((r) => JSON.stringify(r.value) === JSON.stringify(results[0]!.value))).toBe(true);
  expect((await account(target.accountId)).minimum_authn_epoch).toBe(String(Number(before.minimum_authn_epoch) + 1));
  const effectsBefore = await effects();
  expect((await call(root.bearer, pathFor(target.accountId), {})).response.status).toBe(403);
  expect(await effects()).toEqual(effectsBefore);
  const pending = newId(0x7312);
  const reservation = await lifecycle.reserveHandle({
    accountId: pending,
    handle: 'pending_suspension',
    key: Bun.randomUUIDv7(),
  });
  await lifecycle.createPending({
    accountId: pending,
    handle: 'pending_suspension',
    reservationId: reservation.value.reservationId,
    key: Bun.randomUUIDv7(),
  });
  const pendingBefore = await account(pending);
  expect((await call(root.bearer, pathFor(pending), {})).response.status).toBe(403);
  expect(await account(pending)).toEqual(pendingBefore);
});

test('a native responsibility reservation races suspension and cannot block the safety transition', async () => {
  const subject = await person('reservation_race');
  const before = await account(subject.accountId);
  const { createSuspensionCommands } = await import('../../src/access/suspension.ts');
  const commands = createSuspensionCommands({ pool: db.pool, access, clock: () => new Date(now) });
  const authority = await context(root.bearer);
  db.pool.options.max = 4;
  const [suspended, reserved] = await Promise.allSettled([
    commands.suspend(authority, { accountId: subject.accountId, key: Bun.randomUUIDv7() }),
    lifecycle.reserveCoordination({
      accountId: subject.accountId,
      relatedAccountId: newId(0x7311),
      purpose: 'operator',
      key: Bun.randomUUIDv7(),
    }),
  ]);
  db.pool.options.max = 1;
  const after = await account(subject.accountId);
  expect(suspended.status).toBe('fulfilled');
  expect(after).toMatchObject({
    state: 'suspended',
    authn_fenced: true,
    minimum_authn_epoch: String(Number(before.minimum_authn_epoch) + 1),
  });
  const holds = (
    await db.admin.query(
      'SELECT reservation_id::text FROM access.lifecycle_coordination WHERE route=$1 AND account_id=$2',
      [routeOf(subject.accountId), subject.accountId],
    )
  ).rows;
  if (reserved.status === 'fulfilled') {
    expect(holds).toEqual([{ reservation_id: reserved.value.value.reservationId }]);
  } else {
    expect(holds).toEqual([]);
  }
});
