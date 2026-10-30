import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Client, Pool } from 'pg';
import { createAuthHost, type AuthService } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { createAuthDatabase } from '../support/auth-database.ts';
import { createAccess } from '../../src/access/index.ts';
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

async function cloneAuthDatabase(): Promise<{ url: string; close(): Promise<void> }> {
  const name = `reinstatement_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
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

const issuer = 'https://reinstatement.auth.test';
const audience = 'https://reinstatement.api.test';
const password = 'native grant routes registration password';
const routeKey = new Uint8Array(32).fill(71);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(72)]]) };
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let authDatabase: Awaited<ReturnType<typeof cloneAuthDatabase>>;
let authPool: Pool;
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let access: ReturnType<typeof createAccess>;
let grants: ReturnType<typeof createGrantCommands>;
let kernel: ReturnType<typeof createKernel>;
let root: { accountId: string; bearer: string };
let grantor: typeof root;
let recipient: typeof root;
let scopes: string[];
let now = Date.now();
let lifecycle: ReturnType<typeof createLifecycleInternals>;

async function establish(email: string, scope = scopes) {
  const signed = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'reinstatement-client', scope }),
    }),
  );
  const cookie = signed.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  if (signed.status !== 200) return { status: signed.status, cookie, bearer: '' };
  const response = await service.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      body: '{}',
    }),
  );
  expect(response.status).toBe(200);
  return { status: signed.status, cookie, bearer: ((await response.json()) as { access_token: string }).access_token };
}
async function tokenFrom(cookie: string) {
  return service.handler(
    new Request(`${issuer}/token`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json', cookie },
      body: '{}',
    }),
  );
}
async function person(name: string) {
  const result = await host.workflows.register({
    key: name,
    handle: name,
    email: `${name}@reinstatement.test`,
    password,
  });
  const session = await establish(`${name}@reinstatement.test`);
  expect(session.status).toBe(200);
  return { accountId: result.accountId, bearer: session.bearer, cookie: session.cookie };
}
async function call(bearer: string, path: string, body: unknown, key = Bun.randomUUIDv7()) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method: 'POST',
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(key),
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
const account = async (accountId: string) =>
  (
    await db.admin.query('SELECT * FROM access.account WHERE route=$1 AND account_id=$2', [
      routeOf(accountId),
      accountId,
    ])
  ).rows[0]!;
const holds = async (accountId: string) =>
  (
    await db.admin.query(
      `SELECT reservation_id, related_account_id, purpose FROM access.lifecycle_coordination
       WHERE route=$1 AND account_id=$2 ORDER BY reservation_id`,
      [routeOf(accountId), accountId],
    )
  ).rows;
const suspendPath = (accountId: string) => `/v1/accounts/${accountId}:suspend`;
const reinstatePath = (accountId: string) => `/v1/accounts/${accountId}:reinstate`;

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  const limiter = createWriteRateLimiter({
    secret: 'reinstatement-private-write-rate-secret-32bytes',
    overrides: JSON.stringify({
      'new-account': { write: { maximum: 100000, seconds: 86400 } },
      member: { write: { maximum: 100000, seconds: 86400 } },
    }),
  });
  kernel = createKernel({
    pool: db.pool,
    routeKey,
    tokens,
    clock: () => new Date(now),
    access: (config) => {
      expect([...config.actions]).toEqual([...actionCatalogue(kernel)]);
      return access;
    },
    writeRate: {
      async spend(...args) {
        return limiter.spend(...args);
      },
    },
  });
  const actions = actionCatalogue(kernel);
  scopes = [...actions.keys()].filter((action) => action !== 'media:complete');
  authDatabase = await cloneAuthDatabase();
  authPool = new Pool({ connectionString: authDatabase.url });
  const signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'reinstatement',
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
    secret: 'reinstatement-auth-persistent-secret-32bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: createAuthBindings({
      pool: db.pool,
      ...registration,
      verifyPendingIdentity: registration.verifyNativePendingIdentity,
    }),
    access: registrationPorts,
    stagingKey: new Uint8Array(32).fill(73),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'reinstatement-executor',
  });
  service = host.service;
  await service.internal.registerClient({ clientId: 'reinstatement-client', firstParty: true, scopes });
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
}, 60000);
afterAll(async () => {
  await host?.stop();
  await authDatabase?.close();
  await db?.close();
});

test('platform governance reinstates a suspended account and the person signs in and is permitted at T', async () => {
  expect(actionCatalogue(kernel).get('account:reinstate')).toEqual({ anonymous: false });
  const mounted = kernel.routes.filter((route) => route.path === '/v1/accounts/:accountId/$reinstate');
  expect(mounted).toHaveLength(1);
  expect(mounted[0]!.hooks.detail).toMatchObject({
    operationId: 'account.reinstate',
    'x-action': 'account:reinstate',
    'x-exposure': 'public',
    'x-rate-limit': { family: 'write', units: 1 },
    security: [{ bearerAuth: [] }],
  });
  const target = await person('restored_person');
  const operated = await person('operated_person');
  await grants.create(await context(root.bearer), {
    ...inputFor(target.accountId, ['context:create']),
    key: Bun.randomUUIDv7(),
  });
  await lifecycle.reserveCoordination({
    accountId: target.accountId,
    relatedAccountId: newId(0x7321),
    purpose: 'operator',
    key: Bun.randomUUIDv7(),
  });
  const fenceReceipt = Bun.randomUUIDv7();
  await db.admin.query(
    `UPDATE access.account SET operator_account_id=$3, authn_fenced=true, fence_receipt_id=$4
     WHERE route=$1 AND account_id=$2`,
    [routeOf(operated.accountId), operated.accountId, target.accountId, fenceReceipt],
  );
  const operatedBefore = await account(operated.accountId);
  const holdsBefore = await holds(target.accountId);
  expect(holdsBefore).toHaveLength(1);
  const session = await establish('restored_person@reinstatement.test');
  expect(session.status).toBe(200);
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
  expect(published.response.status, JSON.stringify(published.value)).toBe(201);
  const { digest } = published.value as { digest: string };
  const activated = await call(root.bearer, `/v1/definitions/releases/${digest}:activate`, { expected_head: null });
  expect(activated.response.status, JSON.stringify(activated.value)).toBe(200);
  const before = await call(session.bearer, '/v1/contexts', { labels: { en: 'Before suspension' } });
  expect(before.response.status, JSON.stringify(before.value)).toBe(201);
  const active = await account(target.accountId);
  expect(
    (await call(root.bearer, suspendPath(target.accountId), { reason: 'mistaken suspension' })).response.status,
  ).toBe(200);
  const suspended = await account(target.accountId);
  expect(suspended).toMatchObject({
    state: 'suspended',
    authn_fenced: true,
    suspension_reason: 'mistaken suspension',
    minimum_authn_epoch: String(Number(active.minimum_authn_epoch) + 1),
  });
  expect((await establish('restored_person@reinstatement.test')).status).toBe(403);
  const suspendedCall = await call(session.bearer, '/v1/contexts', { labels: { en: 'While suspended' } });
  expect(suspendedCall.response.status, JSON.stringify(suspendedCall.value)).toBe(401);
  const reason = 'complaint justified';
  const key = Bun.randomUUIDv7();
  const result = await call(root.bearer, reinstatePath(target.accountId), { reason }, key);
  expect(result.response.status).toBe(200);
  expect(Object.keys(result.value)).toEqual(['reinstatement']);
  const after = await account(target.accountId);
  expect(after).toMatchObject({
    state: 'active',
    authn_fenced: false,
    suspension_reason: null,
    minimum_authn_epoch: suspended.minimum_authn_epoch,
    fence_receipt_id: suspended.fence_receipt_id,
  });
  expect(after.handle).toEqual(suspended.handle);
  expect(after.operator_account_id).toEqual(suspended.operator_account_id);
  expect(result.value.reinstatement).toMatchObject({
    accountId: target.accountId,
    state: 'active',
    minimumAuthnEpoch: String(after.minimum_authn_epoch),
  });
  expect(JSON.stringify(result.value)).not.toContain(reason);
  const stored = (await db.admin.query('SELECT * FROM core.receipt WHERE transaction_id=$1', [after.transaction_id]))
    .rows;
  expect(stored).toHaveLength(1);
  expect(stored[0].command_kind).toBe('access.account.reinstate');
  expect(stored[0].response).toEqual(result.value.reinstatement);
  expect(JSON.stringify(stored[0])).not.toContain(reason);
  const audit = (
    await db.admin.query('SELECT * FROM core.outbox WHERE partition_no=$1 AND position=$2', [
      stored[0].partition_no,
      stored[0].position,
    ])
  ).rows;
  expect(audit).toHaveLength(1);
  expect(audit[0].type).toBe('com.rezics.access.account.reinstated.v1');
  const schema = ACCESS_EVENTS['com.rezics.access.account.reinstated.v1'];
  expect(EVENT_TYPES['com.rezics.access.account.reinstated.v1']).toBe(schema);
  expect(Value.Check(schema, audit[0].data)).toBe(true);
  expect(JSON.stringify(audit)).not.toContain(reason);
  expect(await account(operated.accountId)).toEqual(operatedBefore);
  expect(await holds(target.accountId)).toEqual(holdsBefore);
  await expect(
    access.authenticate(session.bearer, { pool: db.pool, deadline: Date.now() + 10000 }),
  ).rejects.toMatchObject({ status: 401 });
  expect((await tokenFrom(session.cookie)).status).toBe(401);
  expect((await call(session.bearer, '/v1/contexts', { labels: { en: 'Stale token' } })).response.status).toBe(401);
  const fresh = await establish('restored_person@reinstatement.test');
  expect(fresh.status).toBe(200);
  const restoredCall = await call(fresh.bearer, '/v1/contexts', { labels: { en: 'After reinstatement' } });
  expect(restoredCall.response.status, JSON.stringify(restoredCall.value)).toBe(201);
});

test('an ordinary account or one holding only account suspend is refused and nothing changes', async () => {
  const target = await person('refused_target');
  expect((await call(root.bearer, suspendPath(target.accountId), {})).response.status).toBe(200);
  expect(
    (await call(root.bearer, '/v1/grants', inputFor(grantor.accountId, ['account:suspend']))).response.status,
  ).toBe(201);
  const suspended = await account(target.accountId);
  for (const bearer of [recipient.bearer, grantor.bearer]) {
    const before = await effects();
    const result = await call(bearer, reinstatePath(target.accountId), {});
    expect(result.response.status).toBe(403);
    expect(result.value).toMatchObject({ code: 'forbidden' });
    expect(await effects()).toEqual(before);
    expect(await account(target.accountId)).toEqual(suspended);
  }
});

test('reinstating an active, pending, or deleted account answers 409 and changes nothing', async () => {
  const active = await person('still_active');
  const pending = newId(0x7323);
  const reservation = await lifecycle.reserveHandle({
    accountId: pending,
    handle: 'pending_reinstatement',
    key: Bun.randomUUIDv7(),
  });
  await lifecycle.createPending({
    accountId: pending,
    handle: 'pending_reinstatement',
    reservationId: reservation.value.reservationId,
    key: Bun.randomUUIDv7(),
  });
  const deleted = await person('deleted_person');
  await db.admin.query('UPDATE access.account SET state=$3 WHERE route=$1 AND account_id=$2', [
    routeOf(deleted.accountId),
    deleted.accountId,
    'deleted',
  ]);
  const missing = newId(0x7324);
  for (const accountId of [active.accountId, pending, deleted.accountId, missing]) {
    const before = await effects();
    const row = (
      await db.admin.query('SELECT * FROM access.account WHERE route=$1 AND account_id=$2', [
        routeOf(accountId),
        accountId,
      ])
    ).rows[0];
    const result = await call(root.bearer, reinstatePath(accountId), { reason: 'does not apply' });
    expect(result.response.status).toBe(409);
    expect(result.value).toMatchObject({ status: 409, code: 'conflict', effect_status: 'not_applied' });
    expect(await effects()).toEqual(before);
    const after = (
      await db.admin.query('SELECT * FROM access.account WHERE route=$1 AND account_id=$2', [
        routeOf(accountId),
        accountId,
      ])
    ).rows[0];
    expect(after).toEqual(row);
  }
});

test('a replay returns the same receipt and a later suspension is left in place', async () => {
  const target = await person('replay_person');
  expect((await call(root.bearer, suspendPath(target.accountId), {})).response.status).toBe(200);
  const key = Bun.randomUUIDv7();
  const reason = 'first reversal';
  const first = await call(root.bearer, reinstatePath(target.accountId), { reason }, key);
  expect(first.response.status).toBe(200);
  const restored = await account(target.accountId);
  const effectsAfter = await effects();
  expect((await call(root.bearer, reinstatePath(target.accountId), { reason }, key)).value).toEqual(first.value);
  expect(await account(target.accountId)).toEqual(restored);
  expect(await effects()).toEqual(effectsAfter);
  const conflict = await call(root.bearer, reinstatePath(target.accountId), { reason: 'different reason' }, key);
  expect(conflict.response.status).toBe(422);
  expect(conflict.value).toMatchObject({ code: 'idempotency_conflict', effect_status: 'not_applied' });
  expect(await account(target.accountId)).toEqual(restored);
  expect(await effects()).toEqual(effectsAfter);
  expect((await call(root.bearer, suspendPath(target.accountId), {})).response.status).toBe(200);
  const suspended = await account(target.accountId);
  expect(suspended.state).toBe('suspended');
  expect(Number(suspended.minimum_authn_epoch)).toBe(Number(restored.minimum_authn_epoch) + 1);
  const replay = await call(root.bearer, reinstatePath(target.accountId), { reason }, key);
  expect(replay.response.status).toBe(200);
  expect(replay.value).toEqual(first.value);
  expect(await account(target.accountId)).toEqual(suspended);
});

test('suspend, reinstate, and suspend advances the floor again', async () => {
  const target = await person('floor_person');
  const started = await account(target.accountId);
  const epoch = Number(started.minimum_authn_epoch);
  expect((await call(root.bearer, suspendPath(target.accountId), {})).response.status).toBe(200);
  const suspended = await account(target.accountId);
  expect(Number(suspended.minimum_authn_epoch)).toBe(epoch + 1);
  expect(suspended.authn_fenced).toBe(true);
  const reinstated = await call(root.bearer, reinstatePath(target.accountId), {});
  expect(reinstated.response.status).toBe(200);
  const restored = await account(target.accountId);
  expect(restored).toMatchObject({
    state: 'active',
    authn_fenced: false,
    suspension_reason: null,
    minimum_authn_epoch: suspended.minimum_authn_epoch,
    fence_receipt_id: suspended.fence_receipt_id,
  });
  const session = await establish('floor_person@reinstatement.test');
  expect(session.status).toBe(200);
  const boundary = { pool: db.pool, deadline: Date.now() + 10000 };
  await expect(access.authenticate(session.bearer, boundary)).resolves.toMatchObject({ accountId: target.accountId });
  expect((await call(root.bearer, suspendPath(target.accountId), {})).response.status).toBe(200);
  const again = await account(target.accountId);
  expect(again).toMatchObject({ state: 'suspended', authn_fenced: true });
  expect(Number(again.minimum_authn_epoch)).toBe(epoch + 2);
  expect(again.fence_receipt_id).not.toEqual(restored.fence_receipt_id);
  await expect(access.authenticate(session.bearer, boundary)).rejects.toMatchObject({ status: 401 });
  expect((await tokenFrom(session.cookie)).status).toBe(401);
});
