import { afterAll, beforeAll, expect, test } from 'bun:test';
import { Client, Pool } from 'pg';
import { createAuthHost, type AuthService } from '@rezics/auth';
import { exportJWK, generateKeyPair } from 'jose';
import { createAuthDatabase } from '../support/auth-database.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createAuthBindings } from '../../src/access/auth-bindings.ts';
import {
  createLifecycleCommands,
  createLifecycleInternals,
  LIFECYCLE_ACTIONS,
  LifecycleDeniedError,
} from '../../src/access/lifecycle.ts';
import { createOperatorCommands, OperatorDeniedError } from '../../src/access/operator.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { createRegistrationProofBindings } from '../../src/access/registration-proof.ts';
import { createSuspensionCommands } from '../../src/access/suspension.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { withConnection } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { actionCatalogue } from '../../src/http/request.ts';
import { createAccess } from '../../src/access/index.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import type { Access } from '../../src/request/access.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { createRegistrationPorts } from '../support/registration-ports.ts';

async function cloneAuthDatabase(): Promise<{ url: string; close(): Promise<void> }> {
  const name = `suspension_with_auth_${Bun.randomUUIDv7().replaceAll('-', '')}`;
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

const issuer = 'https://suspension-coordination.auth.test';
const audience = 'https://suspension-coordination.api.test';
const password = 'native grant routes registration password';
const routeKey = new Uint8Array(32).fill(81);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(82)]]) };
const operatorActions = new Map([...LIFECYCLE_ACTIONS, ['account:manage', { anonymous: false }] as const]);
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let authDatabase: Awaited<ReturnType<typeof cloneAuthDatabase>>;
let authPool: Pool;
let host: Awaited<ReturnType<typeof createAuthHost>>;
let service: AuthService;
let access: ReturnType<typeof createAccess>;
let kernel: ReturnType<typeof createKernel>;
let signingKey: Awaited<ReturnType<typeof exportJWK>> & { kid: string };
let root: { accountId: string; bearer: string };
let scopes: string[];
let now = Date.now();
let lifecycle: ReturnType<typeof createLifecycleInternals>;
let operators: ReturnType<typeof createOperatorCommands>;
let lifecycleCommands: ReturnType<typeof createLifecycleCommands>;
let lifecycleAccess: Access;

async function issue(email: string) {
  const signed = await service.handler(
    new Request(`${issuer}/signin`, {
      method: 'POST',
      headers: { origin: issuer, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password, client_id: 'suspension-coordination-client', scope: scopes }),
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
  const result = await host.workflows.register({
    key: name,
    handle: name,
    email: `${name}@suspension-coordination.test`,
    password,
  });
  return { accountId: result.accountId, bearer: await issue(`${name}@suspension-coordination.test`) };
}
async function call(bearer: string, accountId: string, key = Bun.randomUUIDv7()) {
  now = Date.now();
  const response = await kernel.handle(
    new Request(`http://kernel.test/v1/accounts/${accountId}:suspend`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(key),
      },
      body: '{}',
    }),
  );
  return { response, value: await response.json() };
}
const context = async (bearer: string) => {
  now = Date.now();
  const boundary = { pool: db.pool, deadline: Date.now() + 10000 };
  return { ...boundary, actor: await access.authenticate(bearer, boundary) };
};
async function lifecycleContext(accountId: string) {
  const account = await withConnection(db.pool, (client) => readAccount(client, routeOf(accountId)!, accountId));
  if (!account) throw new Error('missing account');
  return {
    actor: await authenticateAccount(
      lifecycleAccess,
      { pool: db.pool, deadline: Date.now() + 10_000 },
      {
        accountId,
        clientId: 'verified-client',
        requestedBy: null,
        authnEpoch: Number(account.minimumAuthnEpoch),
        scopes: [...LIFECYCLE_ACTIONS.keys()],
      },
    ),
    account,
    deadline: Date.now() + 10000,
  };
}
const account = async (accountId: string) =>
  (
    await db.admin.query('SELECT * FROM access.account WHERE route=$1 AND account_id=$2', [
      routeOf(accountId),
      accountId,
    ])
  ).rows[0]!;
const holds = async (accountId: string) =>
  Number(
    (
      await db.admin.query(
        'SELECT count(*)::int AS holds FROM access.lifecycle_coordination WHERE route=$1 AND account_id=$2',
        [routeOf(accountId), accountId],
      )
    ).rows[0]!.holds,
  );
const effects = async () =>
  (
    await db.admin.query(`SELECT
  (SELECT count(*)::int FROM core.receipt) receipts,
  (SELECT count(*)::int FROM core.outbox) events`)
  ).rows;
async function suspend(accountId: string, key = Bun.randomUUIDv7()) {
  const result = await call(root.bearer, accountId, key);
  expect(result.response.status).toBe(200);
  return result;
}
async function reserveResponsibility(operatorAccountId: string, subjectAccountId: string) {
  return operators.reserveResponsibility({
    operatorAccountId,
    subjectAccountId,
    key: Bun.randomUUIDv7(),
  });
}
async function grantDelete(resourceId: string, subjectId: string) {
  await db.admin.query(
    `INSERT INTO access.resource_grant (route, resource_id, subject_id, action, valid, transaction_id)
     VALUES ($1, $2, $3, 'account:delete', '(,)', $4)`,
    [routeOf(resourceId), resourceId, subjectId, newId(routeOf(resourceId)!)],
  );
}

beforeAll(async () => {
  db = await openGrowthDatabase();
  db.pool.options.max = 1;
  const limiter = createWriteRateLimiter({
    secret: 'suspension-coordination-write-rate-secret-32b',
    overrides: JSON.stringify({ 'new-account': { write: { maximum: 100000, seconds: 86400 } } }),
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
    writeRate: limiter,
  });
  const actions = actionCatalogue(kernel);
  scopes = [...actions.keys()].filter((action) => action !== 'media:complete');
  authDatabase = await cloneAuthDatabase();
  authPool = new Pool({ connectionString: authDatabase.url });
  signingKey = {
    ...(await exportJWK((await generateKeyPair('ES256', { extractable: true })).privateKey)),
    kid: 'suspension-coordination',
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
  lifecycleAccess = admittedAccess({ actions: operatorActions });
  operators = createOperatorCommands({
    pool: db.pool,
    access: lifecycleAccess,
    actions: operatorActions,
    managementAction: 'account:manage',
  });
  lifecycleCommands = createLifecycleCommands({ pool: db.pool, access: lifecycleAccess });
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
    secret: 'suspension-coordination-auth-secret-32bytes',
    signing: { activeKid: signingKey.kid, privateKeys: [signingKey] },
    trustedAccess: createAuthBindings({
      pool: db.pool,
      ...registration,
      verifyPendingIdentity: registration.verifyNativePendingIdentity,
    }),
    access: registrationPorts,
    stagingKey: new Uint8Array(32).fill(83),
    maintenanceSchedule: '0 0 1 1 *',
    executorId: 'suspension-coordination-executor',
  });
  service = host.service;
  await service.internal.registerClient({ clientId: 'suspension-coordination-client', firstParty: true, scopes });
  await host.start();
  root = await person('coord_root');
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

test('platform governance suspends a human who operates automated accounts', async () => {
  const human = await person('coord_operator');
  const subject = await person('coord_automated');
  const reserved = await reserveResponsibility(human.accountId, subject.accountId);
  const linked = await operators.recordOperatorRelation({
    operatorAccountId: human.accountId,
    subjectAccountId: subject.accountId,
    reservationId: reserved.value.reservationId,
    expectedOperatorAccountId: null,
    expectedVersion: '0',
    key: Bun.randomUUIDv7(),
  });
  expect(linked.value.operatorAccountId).toBe(human.accountId);
  const before = await account(human.accountId);
  const suspended = await suspend(human.accountId);
  const after = await account(human.accountId);
  expect(suspended.value).toEqual({
    suspension: {
      accountId: human.accountId,
      state: 'suspended',
      minimumAuthnEpoch: String(Number(before.minimum_authn_epoch) + 1),
      receiptId: after.fence_receipt_id,
    },
  });
  expect(after).toMatchObject({
    state: 'suspended',
    authn_fenced: true,
    minimum_authn_epoch: String(Number(before.minimum_authn_epoch) + 1),
    suspension_reason: null,
  });
  expect(await holds(human.accountId)).toBe(1);
  expect(await account(subject.accountId)).toMatchObject({
    state: 'active',
    operator_account_id: human.accountId,
    operator_reservation_id: reserved.value.reservationId,
  });
});

test('suspension takes effect while a responsibility reservation or other lifecycle coordination is pending', async () => {
  const operator = await person('coord_pending_operator');
  const subject = await person('coord_pending_subject');
  const owner = await person('coord_pending_owner');
  const reserved = await reserveResponsibility(operator.accountId, subject.accountId);
  const organizationId = newId(routeOf(owner.accountId)!);
  const membership = await lifecycle.reserveCoordination({
    accountId: owner.accountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: Bun.randomUUIDv7(),
  });
  const operatorBefore = await account(operator.accountId);
  const ownerBefore = await account(owner.accountId);
  await suspend(operator.accountId);
  await suspend(owner.accountId);
  expect(await account(operator.accountId)).toMatchObject({
    state: 'suspended',
    authn_fenced: true,
    minimum_authn_epoch: String(Number(operatorBefore.minimum_authn_epoch) + 1),
  });
  expect(await account(owner.accountId)).toMatchObject({
    state: 'suspended',
    authn_fenced: true,
    minimum_authn_epoch: String(Number(ownerBefore.minimum_authn_epoch) + 1),
  });
  expect(await holds(operator.accountId)).toBe(1);
  expect(await holds(owner.accountId)).toBe(1);
  expect(reserved.value.subjectAccountId).toBe(subject.accountId);
  expect(membership.value.reservationId).toBeTruthy();
  expect((await account(subject.accountId)).operator_account_id).toBeNull();
  expect(
    (
      await db.admin.query('SELECT account_id FROM access.account WHERE route=$1 AND account_id=$2', [
        routeOf(organizationId),
        organizationId,
      ])
    ).rows,
  ).toEqual([]);
});

test('a pending coordinated workflow fails closed at its next step once the account is suspended', async () => {
  const operator = await person('coord_closed_operator');
  const subject = await person('coord_closed_subject');
  const owner = await person('coord_closed_owner');
  const target = await person('coord_closed_target');
  const reserved = await reserveResponsibility(operator.accountId, subject.accountId);
  const organizationId = newId(routeOf(owner.accountId)!);
  const membership = await lifecycle.reserveCoordination({
    accountId: owner.accountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: Bun.randomUUIDv7(),
  });
  await lifecycle.reserveCoordination({
    accountId: target.accountId,
    relatedAccountId: newId(routeOf(target.accountId)!),
    purpose: 'operator',
    key: Bun.randomUUIDv7(),
  });
  await grantDelete(target.accountId, subject.accountId);
  await suspend(operator.accountId);
  await suspend(owner.accountId);
  await suspend(target.accountId);
  const subjectBefore = await account(subject.accountId);
  const operatorAfter = await account(operator.accountId);
  const ownerAfter = await account(owner.accountId);
  const targetAfter = await account(target.accountId);
  const before = await effects();
  await expect(
    operators.recordOperatorRelation({
      operatorAccountId: operator.accountId,
      subjectAccountId: subject.accountId,
      reservationId: reserved.value.reservationId,
      expectedOperatorAccountId: null,
      expectedVersion: '0',
      key: Bun.randomUUIDv7(),
    }),
  ).rejects.toBeInstanceOf(OperatorDeniedError);
  await expect(
    lifecycle.createOrganization({
      organizationId,
      ownerAccountId: owner.accountId,
      ownerReservationId: membership.value.reservationId,
      key: Bun.randomUUIDv7(),
    }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  await expect(
    lifecycleCommands.tombstone(await lifecycleContext(subject.accountId), {
      accountId: target.accountId,
      key: Bun.randomUUIDv7(),
    }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  expect(await account(subject.accountId)).toEqual(subjectBefore);
  expect(await account(operator.accountId)).toEqual(operatorAfter);
  expect(await account(owner.accountId)).toEqual(ownerAfter);
  expect(await account(target.accountId)).toEqual(targetAfter);
  expect(await holds(operator.accountId)).toBe(1);
  expect(await holds(owner.accountId)).toBe(1);
  expect(await holds(target.accountId)).toBe(1);
  expect(targetAfter.state).toBe('suspended');
  expect(
    (
      await db.admin.query('SELECT account_id FROM access.account WHERE route=$1 AND account_id=$2', [
        routeOf(organizationId),
        organizationId,
      ])
    ).rows,
  ).toEqual([]);
  expect(await effects()).toEqual(before);
});

test('concurrent suspension and coordination never both commit an inconsistent state', async () => {
  const human = await person('coord_race_operator');
  const subject = await person('coord_race_subject');
  const before = await account(human.accountId);
  const subjectBefore = await account(subject.accountId);
  const commands = createSuspensionCommands({ pool: db.pool, access, clock: () => new Date(now) });
  const authority = await context(root.bearer);
  db.pool.options.max = 4;
  let suspended: PromiseSettledResult<Awaited<ReturnType<typeof commands.suspend>>>;
  let reserved: PromiseSettledResult<Awaited<ReturnType<typeof operators.reserveResponsibility>>>;
  try {
    [suspended, reserved] = await Promise.allSettled([
      commands.suspend(authority, { accountId: human.accountId, key: Bun.randomUUIDv7() }),
      reserveResponsibility(human.accountId, subject.accountId),
    ]);
  } finally {
    db.pool.options.max = 1;
  }
  const after = await account(human.accountId);
  expect(suspended.status).toBe('fulfilled');
  expect(after).toMatchObject({
    state: 'suspended',
    authn_fenced: true,
    minimum_authn_epoch: String(Number(before.minimum_authn_epoch) + 1),
  });
  expect(await account(subject.accountId)).toEqual(subjectBefore);
  const holdCount = await holds(human.accountId);
  if (reserved.status === 'fulfilled') {
    expect(holdCount).toBe(1);
    expect(reserved.value.value.subjectAccountId).toBe(subject.accountId);
  } else {
    expect(holdCount).toBe(0);
  }
  await expect(reserveResponsibility(human.accountId, subject.accountId)).rejects.toBeInstanceOf(OperatorDeniedError);
  expect(await holds(human.accountId)).toBe(holdCount);
  expect(await account(human.accountId)).toEqual(after);
  expect(await account(subject.accountId)).toEqual(subjectBefore);

  const orderedOperator = await person('coord_ordered_operator');
  const orderedSubject = await person('coord_ordered_subject');
  const ordered = await reserveResponsibility(orderedOperator.accountId, orderedSubject.accountId);
  const orderedBefore = await account(orderedOperator.accountId);
  await suspend(orderedOperator.accountId);
  expect(await account(orderedOperator.accountId)).toMatchObject({
    state: 'suspended',
    minimum_authn_epoch: String(Number(orderedBefore.minimum_authn_epoch) + 1),
  });
  expect(await holds(orderedOperator.accountId)).toBe(1);
  expect(ordered.value.reservationId).toBeTruthy();
  const blocked = await person('coord_blocked_operator');
  const blockedSubject = await person('coord_blocked_subject');
  await suspend(blocked.accountId);
  const blockedRow = await account(blocked.accountId);
  await expect(reserveResponsibility(blocked.accountId, blockedSubject.accountId)).rejects.toBeInstanceOf(
    OperatorDeniedError,
  );
  expect(await holds(blocked.accountId)).toBe(0);
  expect(await account(blocked.accountId)).toEqual(blockedRow);
  expect((await account(blockedSubject.accountId)).operator_account_id).toBeNull();
});

test('suspension of an already suspended or deleted account is still refused', async () => {
  const suspended = await person('coord_suspended_again');
  const key = Bun.randomUUIDv7();
  const first = await suspend(suspended.accountId, key);
  const row = await account(suspended.accountId);
  const before = await effects();
  const again = await call(root.bearer, suspended.accountId);
  expect(again.response.status).toBe(403);
  expect(await account(suspended.accountId)).toEqual(row);
  expect(await effects()).toEqual(before);
  const replay = await call(root.bearer, suspended.accountId, key);
  expect(replay.response.status).toBe(200);
  expect(replay.value).toEqual(first.value);

  const deleted = await person('coord_deleted');
  await lifecycleCommands.tombstone(await lifecycleContext(deleted.accountId), {
    accountId: deleted.accountId,
    key: Bun.randomUUIDv7(),
  });
  const deletedRow = await account(deleted.accountId);
  expect(deletedRow.state).toBe('deleted');
  const deletedEffects = await effects();
  const refused = await call(root.bearer, deleted.accountId);
  expect(refused.response.status).toBe(403);
  expect(await account(deleted.accountId)).toEqual(deletedRow);
  expect(await effects()).toEqual(deletedEffects);
});
