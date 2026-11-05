import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { readAccount, readOrganizationRole } from '../../src/access/account-data.ts';
import { readAssignment } from '../../src/access/delegation-commands.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { accessCheck, actorOf } from '../../src/request/access.ts';
import { createPool } from '../../src/database/pool.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { nativeFixture } from '../access/native-account-bindings-fixture.ts';
import { testKernel, type TestKernel } from './test-kernel.ts';
import { createPersonas, PERSONAS_VERSION, type Persona } from './personas.ts';

const pool = createPool(process.env.DATABASE_URL!);
const context = () => ({ pool, deadline: Date.now() + 10000 });
let auth: Awaited<ReturnType<typeof nativeFixture>>;
let kernel: TestKernel;
let first: Awaited<ReturnType<typeof createPersonas>>;
let second: typeof first;
let verify: (bearer: string) => ReturnType<typeof jwtVerify>;
const names = [
  'alice',
  'bob',
  'organization',
  'orgOwner',
  'software',
  'operator',
  'suspended',
  'revoked',
  'delegated',
  'staff',
] as const;
const bearerNames = names.filter((name) => name !== 'organization');
const account = (persona: { accountId: string }) => readAccount(pool, routeOf(persona.accountId)!, persona.accountId);

beforeAll(async () => {
  auth = await nativeFixture(pool);
  const service = auth.host.service;
  kernel = testKernel({
    pool,
    auth: { ...service.verifier, fetch: (url, init) => service.handler(new Request(url, init)) },
    writeRate: createWriteRateLimiter({ secret: 'personas-native-write-rate-secret-32-bytes' }),
  });
  const jwks = await service.handler(new Request(service.verifier.jwksUrl));
  const keys = createLocalJWKSet(await jwks.json());
  verify = (bearer) =>
    jwtVerify(bearer, keys, {
      issuer: service.verifier.issuer,
      audience: service.verifier.audience,
      algorithms: ['ES256'],
      typ: 'at+jwt',
    });
  first = await createPersonas(kernel, { version: 1, pool, auth });
  second = await createPersonas(kernel, { version: 1, pool, auth, governance: first.staff });
}, 360000);

afterAll(async () => {
  try {
    await auth?.close();
  } finally {
    await pool.end();
  }
});

test('each persona has ordinary Auth issuance and native Access command provenance', async () => {
  expect(PERSONAS_VERSION).toBe(1);
  for (const name of bearerNames) {
    const persona = first[name] as Persona;
    const { payload } = await verify(persona.bearer);
    expect(payload.sub).toBe(persona.accountId);
    expect(payload.client_id).toBeString();
    expect(payload.scope).toBeString();
    if (name !== 'suspended' && name !== 'revoked') {
      const actor = await kernel.testAccess.authenticate(persona.bearer, context());
      expect(actor.accountId).toBe(persona.accountId);
      expect(actor.requestedBy).toBe(name === 'delegated' ? first.delegated.requestedBy : null);
    }
    const provisioned = await auth.authPool.query(
      'SELECT account_id FROM auth_provisioning_receipt WHERE account_id=$1',
      [persona.accountId],
    );
    expect(provisioned.rowCount).toBe(1);
  }
  for (const name of names) {
    const row = await account(first[name]);
    expect(row).not.toBeNull();
    const receipt = await pool.query(
      'SELECT command_kind FROM core.receipt WHERE partition_no=$1 AND transaction_id=$2',
      [partitionOf(routeOf(first[name].accountId)!), row!.transactionId],
    );
    expect(receipt.rowCount).toBe(1);
  }
  // Every grant on these accounts was written with a real native command receipt.
  const ids = names.map((name) => first[name].accountId);
  const grants = await pool.query<{ proven: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM core.receipt r WHERE r.transaction_id=g.transaction_id) AS proven
     FROM access.resource_grant g WHERE g.resource_id=ANY($1::uuid[])`,
    [ids],
  );
  expect(grants.rows.length).toBeGreaterThan(0);
  expect(grants.rows.every((row) => row.proven)).toBe(true);
  expect(await actorOf(kernel.testAccess, new Request('http://kernel.test'), context())).toEqual({
    kind: 'anonymous',
  });
  expect(first.anonymous).toEqual({ bearer: null });
});

test('ordinary people, organization ownership and platform governance are real Access identities', async () => {
  for (const name of ['alice', 'bob', 'orgOwner', 'operator', 'staff'] as const) {
    expect(await account(first[name])).toMatchObject({ kind: 'actor', state: 'active', operatorAccountId: null });
  }
  expect(await account(first.organization)).toMatchObject({ kind: 'organization', state: 'active' });
  expect(
    await readOrganizationRole(
      pool,
      routeOf(first.organization.accountId)!,
      first.organization.accountId,
      first.orgOwner.accountId,
      new Date(),
    ),
  ).toBe('owner');
  expect(
    (await auth.authPool.query('SELECT id FROM "user" WHERE id=$1', [first.organization.accountId])).rowCount,
  ).toBe(0);
  const ctx = context();
  const actor = await kernel.testAccess.authenticate(first.staff.bearer, ctx);
  const governance = await accessCheck(kernel.testAccess, actor, 'account:suspend', PLATFORM_RESOURCE, ctx);
  expect(await governance(pool)).toBe(true);
});

test('the suspended bearer is otherwise valid and Access records governance suspension', async () => {
  const { payload } = await verify(first.suspended.bearer);
  expect(payload.sub).toBe(first.suspended.accountId);
  const row = await account(first.suspended);
  expect(row).toMatchObject({ state: 'suspended', suspensionReason: 'Personas fixture' });
  const receipt = await pool.query(
    'SELECT command_kind,principal_id::text FROM core.receipt WHERE partition_no=$1 AND transaction_id=$2',
    [partitionOf(routeOf(first.suspended.accountId)!), row!.transactionId],
  );
  expect(receipt.rows[0]).toMatchObject({
    command_kind: 'access.account.suspend',
    principal_id: first.staff.accountId,
  });
});

test('the revoked bearer was invalidated by the real Auth session revocation workflow', async () => {
  const { payload } = await verify(first.revoked.bearer);
  expect(payload.sub).toBe(first.revoked.accountId);
  const row = await account(first.revoked);
  expect(row!.minimumAuthnEpoch).toBeGreaterThan(BigInt(payload.authn_epoch as number));
  expect(
    (await auth.authPool.query('SELECT id FROM session WHERE "userId"=$1', [first.revoked.accountId])).rowCount,
  ).toBe(0);
  await expect(kernel.testAccess.authenticate(first.revoked.bearer, context())).rejects.toThrow();
});

test('unscoped(action) retains the named grant while omitting only that consented scope', async () => {
  const read = await first.unscoped('account:read');
  const update = await first.unscoped('account:update');
  const platform = await first.unscoped('account:suspend', PLATFORM_RESOURCE);
  expect(update.accountId).toBe(read.accountId);
  expect(platform.accountId).toBe(read.accountId);
  for (const persona of [read, update, platform]) {
    const ctx = context();
    const actor = await kernel.testAccess.authenticate(persona.bearer, ctx);
    expect(actor.scopes).not.toContain(persona.action);
    expect(actor.scopes).toContain(persona.action === 'account:read' ? 'account:update' : 'account:read');
    const grants = await pool.query(
      `SELECT action FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3
       AND action=$4 AND valid @> clock_timestamp()`,
      [persona.resource.route, persona.resource.id, persona.accountId, persona.action],
    );
    expect(grants.rows).toEqual([{ action: persona.action }]);
  }
  await expect(first.unscoped('unmounted:action')).rejects.toThrow('Unmounted persona action');
});

test('the delegated bearer acts for alice through a native assignment and Auth requested_by issuance', async () => {
  const actor = await kernel.testAccess.authenticate(first.delegated.bearer, context());
  expect(actor.accountId).toBe(first.delegated.accountId);
  expect(actor.requestedBy).toBe(first.delegated.requestedBy);
  expect(await readAssignment(pool, actor.requestedBy, actor.accountId)).toMatchObject({
    kind: 'resolved',
    principalId: first.alice.accountId,
    assignedActorId: actor.accountId,
  });
  expect((await verify(first.delegated.bearer)).payload.requested_by).toBe(actor.requestedBy);
});

test('software has a real operator relation and an Auth bearer from an operator opening', async () => {
  expect(await account(first.software)).toMatchObject({
    kind: 'actor',
    state: 'active',
    operatorAccountId: first.operator.accountId,
  });
  const actor = await kernel.testAccess.authenticate(first.software.bearer, context());
  expect(actor.accountId).toBe(first.software.accountId);
  expect(actor.scopes).not.toContain('media:complete');
});

test('two builds with pinned version and logical names produce distinct accounts and identical shapes', async () => {
  expect(first.version).toBe(1);
  expect(second.version).toBe(1);
  expect(Object.keys(first)).toEqual(Object.keys(second));
  const firstIds = new Set(names.map((name) => first[name].accountId));
  expect(firstIds.size).toBe(names.length);
  const secondIds = new Set(names.map((name) => second[name].accountId));
  expect(secondIds.size).toBe(names.length);
  for (const name of names) {
    expect(firstIds.has(second[name].accountId)).toBe(false);
    expect(Object.keys(first[name])).toEqual(Object.keys(second[name]));
    const before = await account(first[name]);
    const after = await account(second[name]);
    expect([after!.kind, after!.state, after!.operatorAccountId !== null]).toEqual([
      before!.kind,
      before!.state,
      before!.operatorAccountId !== null,
    ]);
  }
  const unscoped = await second.unscoped('account:read');
  expect(unscoped.accountId).not.toBe((await first.unscoped('account:read')).accountId);
  await expect(createPersonas(kernel, { version: 0 as 1, pool, auth })).rejects.toThrow('Unsupported personas version');
});
