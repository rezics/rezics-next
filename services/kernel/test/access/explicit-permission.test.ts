import { suspendAccount } from '../support/native-suspension-driver.ts';
import { afterAll, expect, test } from 'bun:test';
import { createResourcePublicEligibility } from '../../src/access/eligibility.ts';
import { accessRoot, deriveAccess } from '../../src/access/derived-access.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { createPool, withConnection } from '../../src/database/pool.ts';
import {
  accessCheck,
  accessExplicitCheck,
  type Access,
  type AccountActor,
  type Resource,
  type ResourcePage,
} from '../../src/request/access.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { action, actorFixture, type ActorFixture } from './actor-side-fixture.ts';

const pool = createPool(process.env.DATABASE_URL!);
pool.options.max = 1;
afterAll(() => pool.end());

function publicResource(f: ActorFixture): Resource {
  return {
    ...f.resource,
    eligibility: createResourcePublicEligibility({
      resource: f.resource,
      action,
      async prepare() {
        return {};
      },
      async verify() {
        return true;
      },
    }),
  };
}

async function decide(f: ActorFixture, actor = f.actor, resource: Resource = f.resource, access?: Access) {
  const account = await readAccount(pool, routeOf(actor.accountId)!, actor.accountId);
  const permissions = access ?? f.permissions({ actions: new Map([[action, { anonymous: true }]]) });
  const context = { pool, deadline: Date.now() + 10_000, account };
  const check = await accessExplicitCheck(permissions, actor, action, resource, context);
  const ordinary = await accessCheck(accessRoot(permissions), actor, action, resource, context);
  const decision = await withConnection(pool, (client) => check(client));
  expect(decision.allowed).toBe(await withConnection(pool, (client) => ordinary(client)));
  return decision;
}

async function roleGrant(f: ActorFixture, target: Resource, subject: string) {
  await pool.query(
    `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,grant_role,valid,transaction_id)
     VALUES ($1,$2,$3,'fixture.reader','(,)',$4)`,
    [target.route, target.id, subject, f.transactionId],
  );
}

test('explicit action authority excludes the public floor and resource grant roles', async () => {
  const f = await actorFixture(pool);
  const resource = publicResource(f);
  expect(await decide(f, f.actor, resource)).toEqual({ allowed: true, explicit: true });
  await pool.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [
    resource.route,
    resource.id,
  ]);
  await roleGrant(f, resource, f.actorId);
  expect(await decide(f)).toEqual({ allowed: true, explicit: false });
  await pool.query('DELETE FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2', [
    resource.route,
    resource.id,
  ]);
  expect(await decide(f, f.actor, resource)).toEqual({ allowed: true, explicit: false });
  await f.grant();
  expect(await decide(f, { ...f.actor, scopes: [] }, resource)).toEqual({ allowed: true, explicit: false });
});

test('explicit action authority retains membership and both delegation grant operands', async () => {
  const f = await actorFixture(pool);
  expect(await decide(f, f.delegated)).toEqual({ allowed: true, explicit: true });
  await pool.query('DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2', [
    f.resource.route,
    f.resource.id,
  ]);
  await f.grant(f.organizationId, 'owner');
  expect(await decide(f, f.delegated)).toEqual({ allowed: true, explicit: true });
  await pool.query('DELETE FROM access.organization_member WHERE organization_id=$1 AND member_account_id=$2', [
    f.organizationId,
    f.principalId,
  ]);
  expect(await decide(f, f.delegated, publicResource(f))).toEqual({ allowed: true, explicit: false });
});

for (const operand of ['denial', 'fence', 'principal', 'delegation', 'temporal'] as const) {
  test(`explicit action authority retains the ${operand} operand`, async () => {
    const f = await actorFixture(pool);
    const actor: AccountActor = f.delegated;
    expect(await decide(f, actor)).toEqual({ allowed: true, explicit: true });
    if (operand === 'denial') await f.deny(f.actorId, '');
    if (operand === 'fence')
      await pool.query('UPDATE access.account SET authn_fenced=true WHERE route=$1 AND account_id=$2', [
        routeOf(f.actorId),
        f.actorId,
      ]);
    if (operand === 'principal') await suspendAccount(pool, f.principalId);
    if (operand === 'delegation')
      await pool.query('DELETE FROM access.principal_assignment WHERE route=$1 AND principal_id=$2', [
        routeOf(f.principalId),
        f.principalId,
      ]);
    if (operand === 'temporal')
      await pool.query(
        "UPDATE access.resource_grant SET valid='[2000-01-01,2000-01-02)' WHERE route=$1 AND resource_id=$2",
        [f.resource.route, f.resource.id],
      );
    expect(await decide(f, actor)).toEqual({ allowed: false, explicit: false });
  });
}

test('explicit page decisions equal the conjunction of singleton decisions', async () => {
  const f = await actorFixture(pool);
  const second = { route: f.resource.route, id: newId(f.resource.route) };
  await f.grant(f.actorId, '', second);
  await roleGrant(f, second, f.principalId);
  const account = await readAccount(pool, routeOf(f.actorId)!, f.actorId);
  const access = f.permissions({ accountEvidence: () => account });
  const page: ResourcePage = { route: f.resource.route, resourceType: 'fixture.page', ids: [f.resource.id, second.id] };
  const evidence = await access.preparePage!(f.delegated, action, page, { pool, deadline: Date.now() + 10_000 });
  const decision = await withConnection(pool, (client) =>
    access.authorizeExplicit!(client, f.delegated, action, page, evidence),
  );
  const singles = await Promise.all([decide(f, f.delegated), decide(f, f.delegated, second)]);
  expect(decision).toEqual({
    allowed: singles.every((value) => value.allowed),
    explicit: singles.every((value) => value.explicit),
  });
  expect(decision).toEqual({ allowed: true, explicit: false });
});

test('explicit projection independently excludes newly matching resource role grants', async () => {
  const f = await actorFixture(pool);
  const access = f.permissions();
  const account = await readAccount(pool, routeOf(f.actorId)!, f.actorId);
  const context = { pool, deadline: Date.now() + 10_000, account };
  const evidence = await access.prepare!(f.actor, action, f.resource, context);
  await pool.query(
    `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,subject_role,grant_role,valid,transaction_id)
     VALUES ($1,$2,$3,'owner','fixture.reader','(,)',$4)`,
    [f.resource.route, f.resource.id, f.staleId, f.transactionId],
  );
  expect(await access.authorizeExplicit!(pool, f.actor, action, f.resource, evidence)).toEqual({
    allowed: false,
    explicit: true,
  });
  expect(await access.authorize(pool, f.actor, action, f.resource, evidence)).toBe(false);
});

test('explicit checks use the installed root port and missing ports fail closed', async () => {
  const f = await actorFixture(pool);
  const root = f.permissions();
  const derived = deriveAccess(root, {
    async prepare() {
      throw new Error('Must use the installed root');
    },
    async authorizeExplicit() {
      return { allowed: false, explicit: false };
    },
  });
  expect(await decide(f, f.actor, f.resource, derived)).toEqual({ allowed: true, explicit: true });
  const absent: Access = { authenticate: root.authenticate, authorize: root.authorize };
  const check = await accessExplicitCheck(absent, f.actor, action, f.resource, {
    pool,
    deadline: Date.now() + 10_000,
  });
  expect(await check(pool)).toEqual({ allowed: false, explicit: false });
});
