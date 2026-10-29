import { afterAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import {
  readAccount,
  readOrganizationRole,
  readPublicAccountByHandle,
  readPublicIdentities,
} from '../../src/access/account-data.ts';
import {
  createLifecycleCommands,
  createLifecycleInternals,
  LIFECYCLE_ACTIONS,
  LifecycleDeniedError,
  OrganizationCloseBlockedError,
} from '../../src/access/lifecycle.ts';
import { createOrganizationCloseRunner } from '../../src/access/organization-close-work.ts';
import { admittedAccess, authenticateAccount, accountToken } from '../support/admitted-access.ts';
import { accessCheck } from '../../src/request/access.ts';
import { createWorkflowApprovals } from '../../src/access/workflow-approvals.ts';
import operatorMember from '../../src/access/operator-member.sql';

const pool = createPool(process.env.DATABASE_URL!);
afterAll(() => pool.end());
const actions = new Map([...LIFECYCLE_ACTIONS, ['content:edit', { anonymous: false }] as const]);
const access = admittedAccess({ actions });
const commands = createLifecycleCommands({ pool, access });
const internal = createLifecycleInternals({
  pool,
  routeKey: new Uint8Array(32),
  provisioningEvidence: async () => null,
  recoveryEvidence: async () => null,
});
const key = () => Bun.randomUUIDv7();
async function person() {
  const id = newId(0x1351);
  await pool.query(
    "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES($1,$2,'actor','active',$2)",
    [routeOf(id), id],
  );
  return id;
}
async function context(id: string) {
  const actor = await authenticateAccount(
    access,
    { pool, deadline: Date.now() + 10000 },
    { accountId: id, clientId: 'close-test', scopes: [...actions.keys()] },
  );
  return { actor, deadline: Date.now() + 10000 };
}
async function organization(owner: string) {
  const id = newId(0x1371);
  const reservation = await internal.reserveCoordination({
    accountId: owner,
    relatedAccountId: id,
    purpose: 'membership',
    key: key(),
  });
  await internal.createOrganization({
    organizationId: id,
    ownerAccountId: owner,
    ownerReservationId: reservation.value.reservationId,
    key: key(),
  });
  return id;
}
async function join(id: string, member: string, role: 'owner' | 'member' = 'member') {
  const held = await internal.reserveCoordination({
    accountId: member,
    relatedAccountId: id,
    purpose: 'membership',
    key: key(),
  });
  // Native membership command still enforces the last-owner invariant.
  const owner = await pool.query(
    "SELECT member_account_id AS id FROM access.organization_member WHERE route=$1 AND organization_id=$2 AND role='owner' AND valid @> clock_timestamp() LIMIT 1",
    [routeOf(id), id],
  );
  await commands.setMembership(await context(owner.rows[0].id), {
    organizationId: id,
    memberAccountId: member,
    reservationId: held.value.reservationId,
    role,
    key: key(),
  });
}
async function grant(resource: string, subject: string, action: string, role = '') {
  await pool.query(
    "INSERT INTO access.resource_grant(route,resource_id,subject_id,subject_role,action,valid,transaction_id) VALUES($1,$2,$3,$4,$5,'(,)',$3)",
    [routeOf(resource), resource, subject, role, action],
  );
}
async function allowed(actor: string, action: string, resource: string) {
  const ctx = await context(actor);
  return (await accessCheck(access, ctx.actor, action, { route: routeOf(resource)!, id: resource }, { ...ctx, pool }))(
    pool,
  );
}
async function memberships(id: string) {
  return (
    await pool.query(
      'SELECT count(*)::int AS n FROM access.organization_member WHERE route=$1 AND organization_id=$2',
      [routeOf(id), id],
    )
  ).rows[0].n as number;
}

test('only a current owner with management closes; the barrier removes every organization authority before cleanup', async () => {
  const owner = await person(),
    member = await person(),
    manager = await person();
  const org = await organization(owner);
  const coowner = await person();
  await join(org, coowner, 'owner');
  await join(org, member);
  await join(org, manager);
  await grant(org, manager, 'account:manage');
  await grant(org, manager, 'account:delete');
  const resource = newId(0x1391);
  await grant(resource, org, 'content:edit', 'owner');
  await grant(resource, org, 'content:edit', 'member');
  expect(await allowed(owner, 'content:edit', resource)).toBe(true);
  expect(await allowed(member, 'content:edit', resource)).toBe(true);
  await expect(commands.tombstone(await context(manager), { accountId: org, key: key() })).rejects.toBeInstanceOf(
    LifecycleDeniedError,
  );
  await expect(commands.tombstone(await context(member), { accountId: org, key: key() })).rejects.toBeInstanceOf(
    LifecycleDeniedError,
  );
  await commands.tombstone(await context(owner), { accountId: org, key: key() });
  expect(await memberships(org)).toBe(4);
  expect(await readAccount(pool, routeOf(org)!, org)).toMatchObject({ state: 'deleted', fenced: true });
  expect(await allowed(owner, 'content:edit', resource)).toBe(false);
  expect(await allowed(coowner, 'content:edit', resource)).toBe(false);
  expect(await allowed(member, 'content:edit', resource)).toBe(false);
  expect(await allowed(owner, 'account:manage', org)).toBe(false);
  expect(await readOrganizationRole(pool, routeOf(org)!, org, owner, new Date())).toBeNull();
  expect(
    await operatorMember.run(pool, {
      route: routeOf(org)!,
      organization_id: org,
      human_id: owner,
      at: new Date().toISOString(),
    }),
  ).toEqual([]);
  expect(await readPublicIdentities(pool, [routeOf(org)!], [org])).toEqual([
    { id: org, state: 'deleted', kind: 'organization' },
  ]);
  // A stale inverse must not suppress an independent grant.
  await grant(resource, member, 'content:edit');
  expect(await allowed(member, 'content:edit', resource)).toBe(true);
});

test('responsibility blocks close, identifies its operated account, and release permits close', async () => {
  const owner = await person(),
    org = await organization(owner),
    automated = newId(0x1381);
  const held = await internal.reserveCoordination({
    accountId: org,
    relatedAccountId: automated,
    purpose: 'operator',
    key: key(),
  });
  try {
    await commands.tombstone(await context(owner), { accountId: org, key: key() });
    throw new Error('close unexpectedly succeeded');
  } catch (error) {
    expect(error).toBeInstanceOf(OrganizationCloseBlockedError);
    expect((error as OrganizationCloseBlockedError).blocker).toEqual({
      purpose: 'operator',
      relatedAccountId: automated,
    });
  }
  expect(await readAccount(pool, routeOf(org)!, org)).toMatchObject({ state: 'active' });
  // Simulate the owning operator workflow's completed transfer/deletion release.
  await pool.query('DELETE FROM access.lifecycle_coordination WHERE route=$1 AND account_id=$2 AND reservation_id=$3', [
    routeOf(org),
    org,
    held.value.reservationId,
  ]);
  await commands.tombstone(await context(owner), { accountId: org, key: key() });
});

test('cleanup is bounded, replayable and restartable and preserves accounts, grants and other memberships', async () => {
  const owner = await person(),
    org = await organization(owner),
    other = await organization(owner);
  const members = await Promise.all(Array.from({ length: 204 }, person));
  // Seed with native reservation provenance while avoiding 204 unrelated authorization setups.
  for (const member of members) await join(org, member);
  await join(other, members[0]!);
  const preserved = await pool.query('SELECT * FROM access.account WHERE route=$1 ORDER BY account_id', [0x1351]);
  const otherBefore = await pool.query(
    'SELECT * FROM access.organization_member WHERE route=$1 AND organization_id=$2 ORDER BY member_account_id',
    [routeOf(other), other],
  );
  // Inverse cleanup must also work for an independently suspended member.
  await pool.query("UPDATE access.account SET state='suspended' WHERE route=$1 AND account_id=$2", [
    routeOf(members[1]!),
    members[1],
  ]);
  const accountsBefore = await pool.query('SELECT * FROM access.account WHERE route=$1 ORDER BY account_id', [0x1351]);
  const grantsBefore = await pool.query(
    'SELECT * FROM access.resource_grant WHERE route=$1 ORDER BY resource_id,subject_id,action',
    [0x1351],
  );
  expect(preserved.rowCount).toBeGreaterThan(204);
  await commands.tombstone(await context(owner), { accountId: org, key: key() });
  const runner = createOrganizationCloseRunner({ pool });
  expect(await runner.step(org, 0)).toEqual({ count: 100, next: 1 });
  expect(await memberships(org)).toBe(105);
  expect(await runner.step(org, 0)).toEqual({ count: 100, next: 1 });
  expect(await memberships(org)).toBe(105);
  await createOrganizationCloseRunner({ pool }).continueCommitted(org);
  await runner.continueCommitted(org);
  expect(await memberships(org)).toBe(0);
  expect(
    (
      await pool.query(
        "SELECT count(*)::int n FROM access.membership_inverse WHERE kind='organization' AND group_id=$1",
        [org],
      )
    ).rows[0].n,
  ).toBe(0);
  expect((await pool.query('SELECT * FROM access.account WHERE route=$1 ORDER BY account_id', [0x1351])).rows).toEqual(
    accountsBefore.rows,
  );
  expect(
    (
      await pool.query(
        'SELECT * FROM access.resource_grant WHERE route=$1 ORDER BY resource_id,subject_id,action',
        [0x1351],
      )
    ).rows,
  ).toEqual(grantsBefore.rows);
  expect(
    (
      await pool.query(
        'SELECT * FROM access.organization_member WHERE route=$1 AND organization_id=$2 ORDER BY member_account_id',
        [routeOf(other), other],
      )
    ).rows,
  ).toEqual(otherBefore.rows);
}, 120000);

test('zero-owner deletion remains possible and deleted handle identity has only the tombstone fields', async () => {
  const actor = await person(),
    org = newId(0x1371);
  const handle = `closed-${key()}`;
  await pool.query(
    "INSERT INTO access.account(route,account_id,kind,state,handle,display_name,transaction_id) VALUES($1,$2,'organization','active',$3,'Private name',$2)",
    [routeOf(org), org, handle],
  );
  await grant(org, actor, 'account:delete');
  const claim = await internal.reserveHandle({ accountId: org, handle, key: key() });
  // Publish a privileged fixture claim; the cleanup must use the native redirect step.
  await pool.query(
    "UPDATE access.handle_claim SET state='active', expires_at=NULL WHERE account_id=$1 AND reservation_id=$2",
    [org, claim.value.reservationId],
  );
  await commands.tombstone(await context(actor), { accountId: org, key: key() });
  expect(await readPublicAccountByHandle(pool, handle)).toEqual([]);
  expect(await readPublicIdentities(pool, [routeOf(org)!], [org])).toEqual([
    { id: org, kind: 'organization', state: 'deleted' },
  ]);
  await createOrganizationCloseRunner({ pool }).continueCommitted(org);
});

test('the durable approval path admits an owner with management and no delete action', async () => {
  const owner = await person(),
    org = await organization(owner);
  const approvals = createWorkflowApprovals({
    pool,
    access,
    actions,
    referenceKeys: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(17)]]) },
  });
  const token = await accountToken({ accountId: owner, clientId: 'close-approval', scopes: ['account:manage'] });
  const operation = { kind: 'delete' as const, accountId: org, authorization: 'input' };
  const boundary = () => ({ pool, deadline: Date.now() + 10000 });
  const operationKey = key();
  const approval = await approvals.approve(token, { operationKey, operation }, boundary());
  const resolved = await approvals.resolve(approval.reference, { ...operation, operationKey }, boundary());
  await commands.tombstone(resolved, { accountId: org, key: key() });
  expect(await readAccount(pool, routeOf(org)!, org)).toMatchObject({ state: 'deleted' });
});

test('cleanup and an existing deletion continuation share the handle redirect receipt', async () => {
  const owner = await person(),
    org = await organization(owner);
  const handle = `shared-${key()}`;
  await pool.query('UPDATE access.account SET handle=$3 WHERE route=$1 AND account_id=$2', [routeOf(org), org, handle]);
  const claim = await internal.reserveHandle({ accountId: org, handle, key: key() });
  await pool.query(
    "UPDATE access.handle_claim SET state='active', expires_at=NULL WHERE account_id=$1 AND reservation_id=$2",
    [org, claim.value.reservationId],
  );
  const continuation = {
    operationKey: key(),
    operationDigest: 'a'.repeat(64),
    commandKeyPrefix: `wf:${'b'.repeat(64)}`,
  };
  await commands.tombstone(await context(owner), { accountId: org, key: key(), continuation });
  const redirect = { accountId: org, handle, key: `${continuation.commandKeyPrefix}:redirect-deleted-handle` };
  await internal.redirectHandle(redirect);
  await createOrganizationCloseRunner({ pool }).continueCommitted(org);
  expect((await internal.redirectHandle(redirect)).replayed).toBe(true);
  expect(await memberships(org)).toBe(0);
});
