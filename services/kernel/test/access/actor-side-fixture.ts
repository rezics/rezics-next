import type { Pool } from 'pg';
import { readAccount } from '../../src/access/account-data.ts';
import { createAccess, type PermissionConfig } from '../../src/access/permission.ts';
import { createMembershipInverseCommands } from '../../src/access/membership-inverse.ts';
import { accessCheck, type AccountActor, type Resource } from '../../src/request/access.ts';
import { withConnection } from '../../src/database/pool.ts';
import { newId, routeOf } from '../../src/route/route.ts';

export const action = 'subject:read';
export async function actorFixture(pool: Pool, admin: Pool = pool) {
  const actorId = newId(0x1234);
  const principalId = newId(0x2345);
  const organizationId = newId(0x3456);
  const staleId = newId(0x4567);
  const irrelevantId = newId(0x5678);
  const requestId = newId(0x2345);
  const transactionId = newId(0x6789);
  const resource = { route: 0x6789, id: newId(0x6789) };
  const inverse = createMembershipInverseCommands({ pool });
  async function account(id: string, kind = 'actor') {
    await admin.query(
      `INSERT INTO access.account(route,account_id,kind,state,transaction_id)
      VALUES ($1,$2,$3,'active',$4)`,
      [routeOf(id), id, kind, transactionId],
    );
  }
  for (const id of [actorId, principalId]) await account(id);
  for (const id of [organizationId, staleId, irrelevantId]) await account(id, 'organization');
  async function admit(id: string, member = actorId, kind: 'organization' | 'realm' = 'organization') {
    await inverse.reserve({ accountId: member, principal: { kind, id }, key: `fixture-${member}-${id}` });
  }
  for (const member of [actorId, principalId]) {
    await admit(organizationId, member);
    await admin.query(
      `INSERT INTO access.organization_member
      (route,organization_id,member_account_id,role,valid,transaction_id)
      VALUES ($1,$2,$3,'owner','(,)',$4)`,
      [routeOf(organizationId), organizationId, member, transactionId],
    );
  }
  await admit(staleId);
  await admin.query(
    `INSERT INTO access.principal_assignment
    (route,principal_id,request_id,assigned_actor_id,valid,transaction_id)
    VALUES ($1,$2,$3,$4,'(,)',$5)`,
    [routeOf(principalId), principalId, requestId, actorId, transactionId],
  );
  async function grant(subject = actorId, role = '', target = resource, valid = '(,)') {
    await admin.query(
      `INSERT INTO access.resource_grant
      (route,resource_id,subject_id,subject_role,action,valid,transaction_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [target.route, target.id, subject, role, action, valid, transactionId],
    );
  }
  async function deny(subject: string, role = 'owner', valid = '(,)') {
    await admin.query(
      `INSERT INTO access.resource_denial
      (route,resource_id,subject_id,subject_role,action,reason,valid,transaction_id)
      VALUES ($1,$2,$3,$4,$5,'resource',$6,$7)`,
      [resource.route, resource.id, subject, role, action, valid, transactionId],
    );
  }
  await grant();
  await grant(principalId);
  const actor: AccountActor = {
    kind: 'account',
    accountId: actorId,
    clientId: 'first-party',
    scopes: [action],
    authnEpoch: 1,
    requestedBy: null,
  };
  const config: PermissionConfig = {
    actions: new Map([
      [action, { anonymous: false, 'x-resource-types': ['fixture.page'] }],
      ['subject:update', { anonymous: false }],
    ]),
    resourceRoles: {
      roles: { 'fixture.reader': [action] },
      types: { 'fixture.page': { owner: 'fixture.reader', standing: [] } },
    },
    accountEvidence: (_, ctx) => ctx.account,
  };
  function permissions(extra: Partial<PermissionConfig> = {}) {
    return createAccess({ ...config, ...extra });
  }
  async function prepare(identity = actor, access = permissions(), target: Resource = resource) {
    const account = await readAccount(pool, routeOf(identity.accountId)!, identity.accountId);
    const context = { pool, deadline: Date.now() + 5000, account };
    return accessCheck(access, identity, action, target, context);
  }
  async function run(identity = actor, access = permissions(), target: Resource = resource) {
    const check = await prepare(identity, access, target);
    return withConnection(pool, (client) => check(client));
  }
  const delegated = {
    ...actor,
    clientId: 'third-party',
    requestedBy: `urn:rezics:request:${principalId}:${requestId}`,
  };
  return {
    pool,
    admin,
    actorId,
    principalId,
    organizationId,
    staleId,
    irrelevantId,
    transactionId,
    resource,
    actor,
    delegated,
    config,
    permissions,
    prepare,
    run,
    grant,
    deny,
    admit,
    account,
  };
}
export type ActorFixture = Awaited<ReturnType<typeof actorFixture>>;
