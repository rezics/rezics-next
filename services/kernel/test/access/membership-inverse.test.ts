import { afterAll, expect, test } from 'bun:test';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { newId, routeOf, partitionOf } from '../../src/route/route.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import {
  createLifecycleInternals,
  createLifecycleCommands,
  LIFECYCLE_ACTIONS,
  LifecycleDeniedError,
} from '../../src/access/lifecycle.ts';
import type { AccountActor } from '../../src/request/access.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const reader = createPool(url);
afterAll(async () => {
  await pool.end();
  await reader.end();
});
const key = () => Bun.randomUUIDv7();
const internals = createLifecycleInternals({
  pool,
  routeKey: new Uint8Array(32).fill(7),
  provisioningEvidence: async () => null,
  recoveryEvidence: async () => null,
});
const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
const lifecycle = createLifecycleCommands({ pool, access });
const api = () => import('../../src/access/membership-inverse.ts');
async function person(route = 0x5200) {
  const id = newId(route);
  await reader.query(
    "INSERT INTO access.account(route,account_id,kind,state,transaction_id) VALUES($1,$2,'actor','active',$3)",
    [route, id, key()],
  );
  return id;
}
async function context(id: string) {
  const claims = {
    accountId: id,
    clientId: 'test',
    requestedBy: null,
    authnEpoch: 1,
    scopes: [...LIFECYCLE_ACTIONS.keys()],
  };
  let actor: AccountActor;
  try {
    actor = await authenticateAccount(access, { pool, deadline: Date.now() + 290_000 }, claims);
  } catch {
    actor = { kind: 'account', ...claims };
  }
  return {
    actor,
    account: await withConnection(reader, (c) => readAccount(c, routeOf(id)!, id)),
    deadline: Date.now() + 2000,
  };
}
async function organization(owner: string) {
  const id = newId(0x7300);
  const reserved = await internals.reserveCoordination({
    accountId: owner,
    relatedAccountId: id,
    purpose: 'membership',
    key: key(),
  });
  await internals.createOrganization({
    organizationId: id,
    ownerAccountId: owner,
    ownerReservationId: reserved.value.reservationId,
    key: key(),
  });
  return id;
}
async function inverse(accountId: string) {
  return withConnection(reader, async (client) => (await api()).readMembershipInverse(client, { accountId }));
}
async function seed(accountId: string, count: number) {
  // Historical fixture setup, with explicit actor-side inverse evidence.
  const rows = Array.from({ length: count }, (_, i) => ({
    id: newId(0x7400),
    reservation: newId(routeOf(accountId)!),
    kind: i % 2 ? 'realm' : 'organization',
  }));
  await reader.query(
    `INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id)
    SELECT $1,$2,x.kind,x.id::uuid,x.reservation::uuid,$4 FROM jsonb_to_recordset($3::jsonb) AS x(id text,reservation text,kind text)`,
    [routeOf(accountId), accountId, JSON.stringify(rows), key()],
  );
  return rows;
}

test('organization publication rejects a historical hold without the matching member-anchor inverse', async () => {
  const owner = await person();
  const organizationId = newId(0x7300);
  const reservationId = newId(routeOf(owner)!);
  await reader.query(
    `INSERT INTO access.lifecycle_coordination(route,account_id,reservation_id,related_account_id,purpose,transaction_id)
    VALUES($1,$2,$3,$4,'membership',$5)`,
    [routeOf(owner), owner, reservationId, organizationId, key()],
  );
  await expect(
    internals.createOrganization({
      organizationId,
      ownerAccountId: owner,
      ownerReservationId: reservationId,
      key: key(),
    }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
});

test('first owner and member publication require a prior inverse; stale extras never prove authoritative membership', async () => {
  const owner = await person();
  const organizationId = await organization(owner);
  expect(await inverse(owner)).toEqual([{ kind: 'organization', id: organizationId }]);
  const member = await person();
  const reservationId = newId(routeOf(member)!);
  await reader.query(
    `INSERT INTO access.lifecycle_coordination(route,account_id,reservation_id,related_account_id,purpose,transaction_id)
    VALUES($1,$2,$3,$4,'membership',$5)`,
    [routeOf(member), member, reservationId, organizationId, key()],
  );
  await expect(
    lifecycle.setMembership(await context(owner), {
      organizationId,
      memberAccountId: member,
      reservationId,
      role: 'member',
      key: key(),
    }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  const reserved = await internals.reserveCoordination({
    accountId: member,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: key(),
  });
  expect(await inverse(member)).toEqual([{ kind: 'organization', id: organizationId }]);
  const prepared = await access.prepare!(
    (await context(member)).actor,
    'account:update',
    { route: routeOf(organizationId)!, id: organizationId },
    { ...(await context(member)), pool },
  );
  expect(
    await withConnection(reader, (c) =>
      access.authorize(
        c,
        contextActor(member),
        'account:update',
        { route: routeOf(organizationId)!, id: organizationId },
        prepared,
      ),
    ),
  ).toBe(false);
  await lifecycle.setMembership(await context(owner), {
    organizationId,
    memberAccountId: member,
    reservationId: reserved.value.reservationId,
    role: 'member',
    key: key(),
  });
});
function contextActor(id: string): AccountActor {
  return {
    kind: 'account',
    accountId: id,
    clientId: 'test',
    requestedBy: null,
    authnEpoch: 1,
    scopes: [...LIFECYCLE_ACTIONS.keys()],
  };
}

test('distinct admissions serialize at 999 and 1000 with combined organization and Realm cap and typed membership_limit', async () => {
  const { createMembershipInverseCommands, MembershipLimitError, MEMBERSHIP_LIMIT } = await api();
  expect(MEMBERSHIP_LIMIT).toBe(1000);
  const commands = createMembershipInverseCommands({ pool });
  const accountId = await person();
  const seeded = await seed(accountId, 999);
  const inputs = ['organization', 'realm'].map((kind) => ({
    accountId,
    principal: { kind: kind as 'organization' | 'realm', id: newId(0x7500) },
    key: key(),
  }));
  const result = await Promise.allSettled(inputs.map((input) => commands.reserve(input)));
  expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const failed = result.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  expect(failed.reason).toBeInstanceOf(MembershipLimitError);
  expect(failed.reason.code).toBe('membership_limit');
  expect(await inverse(accountId)).toHaveLength(1000);
  const winner = inputs[result.findIndex((r) => r.status === 'fulfilled')]!;
  const first = await commands.reserve(winner);
  expect(first.replayed).toBe(true);
  const duplicate = await commands.reserve({ ...winner, key: key() });
  expect(duplicate.value.reservationId).toBe(first.value.reservationId);
  const failures = await Promise.allSettled(
    inputs.map((input) =>
      commands.reserve({ ...input, principal: { ...input.principal, id: newId(0x7500) }, key: key() }),
    ),
  );
  expect(failures.every((r) => r.status === 'rejected' && r.reason instanceof MembershipLimitError)).toBe(true);
  expect(seeded).toHaveLength(999);
});

test('release requires immutable exact authoritative terminal proof and cannot delete a newer operation', async () => {
  const { createMembershipInverseCommands } = await api();
  const commands = createMembershipInverseCommands({ pool });
  const owner = await person();
  const organizationId = await organization(owner);
  const accountId = await person();
  const principal = { kind: 'organization' as const, id: organizationId };
  const input = { accountId, principal, key: key() };
  const reservation = (await commands.reserve(input)).value;
  await expect(
    commands.release({ ...reservation, key: key(), terminal: true } as typeof reservation & { key: string }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  await expect(
    reader.query('DELETE FROM access.membership_inverse WHERE route=$1 AND account_id=$2', [
      routeOf(accountId),
      accountId,
    ]),
  ).rejects.toThrow();
  await lifecycle.setMembership(await context(owner), {
    organizationId,
    memberAccountId: accountId,
    reservationId: reservation.reservationId,
    role: 'member',
    key: key(),
  });
  await expect(commands.release({ ...reservation, key: key() })).rejects.toBeInstanceOf(LifecycleDeniedError);
  await lifecycle.setMembership(await context(owner), {
    organizationId,
    memberAccountId: accountId,
    reservationId: reservation.reservationId,
    role: null,
    key: key(),
  });
  const closedMembership = await reader.query(
    `SELECT role, valid::text, transaction_id FROM access.organization_member
     WHERE route=$1 AND organization_id=$2 AND member_account_id=$3 AND NOT upper_inf(valid)`,
    [routeOf(organizationId), organizationId, accountId],
  );
  expect(closedMembership.rows).toHaveLength(1);
  await expect(
    reader.query(
      `UPDATE access.lifecycle_membership_slot SET terminal=false WHERE route=$1 AND organization_id=$2 AND member_account_id=$3 AND reservation_id=$4`,
      [routeOf(organizationId), organizationId, accountId, reservation.reservationId],
    ),
  ).rejects.toThrow();
  await expect(
    reader.query(
      `DELETE FROM access.lifecycle_membership_slot WHERE route=$1 AND organization_id=$2 AND member_account_id=$3 AND reservation_id=$4`,
      [routeOf(organizationId), organizationId, accountId, reservation.reservationId],
    ),
  ).rejects.toThrow();
  const releaseInput = { ...reservation, key: key() };
  const released = await commands.release(releaseInput);
  expect(await commands.release(releaseInput)).toEqual({ ...released, replayed: true });
  expect(await inverse(accountId)).toEqual([]);
  const next = (await commands.reserve({ ...input, key: key() })).value;
  expect(next.reservationId).not.toBe(reservation.reservationId);
  await expect(commands.release({ ...reservation, key: key() })).rejects.toBeInstanceOf(LifecycleDeniedError);
  await expect(
    lifecycle.setMembership(await context(owner), {
      organizationId,
      memberAccountId: accountId,
      reservationId: reservation.reservationId,
      role: 'owner',
      key: key(),
    }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  expect(await inverse(accountId)).toEqual([principal]);
  await lifecycle.setMembership(await context(owner), {
    organizationId,
    memberAccountId: accountId,
    reservationId: next.reservationId,
    role: 'member',
    key: key(),
  });
  await expect(
    lifecycle.setMembership(await context(owner), {
      organizationId,
      memberAccountId: accountId,
      reservationId: reservation.reservationId,
      role: null,
      key: key(),
    }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  expect(
    (
      await reader.query(
        `SELECT role FROM access.organization_member
         WHERE route=$1 AND organization_id=$2 AND member_account_id=$3 AND valid @> statement_timestamp()`,
        [routeOf(organizationId), organizationId, accountId],
      )
    ).rows,
  ).toEqual([{ role: 'member' }]);
  expect(
    (
      await reader.query(
        `SELECT role, valid::text, transaction_id FROM access.organization_member
         WHERE route=$1 AND organization_id=$2 AND member_account_id=$3 AND NOT upper_inf(valid)`,
        [routeOf(organizationId), organizationId, accountId],
      )
    ).rows,
  ).toEqual(closedMembership.rows);
});

test('failed joins compensate only after terminalization; operator holds survive member release; no nested checkout', async () => {
  const { createMembershipInverseCommands } = await api();
  const commands = createMembershipInverseCommands({ pool });
  const accountId = await person();
  const principal = { kind: 'organization' as const, id: newId(0x7600) };
  const reserved = (await commands.reserve({ accountId, principal, key: key() })).value;
  await internals.reserveCoordination({ accountId, relatedAccountId: newId(0x7600), purpose: 'operator', key: key() });
  await expect(commands.release({ ...reserved, key: key() })).rejects.toBeInstanceOf(LifecycleDeniedError);
  await internals.terminalizeMembership({
    organizationId: principal.id,
    memberAccountId: accountId,
    reservationId: reserved.reservationId,
    key: key(),
  });
  await commands.release({ ...reserved, key: key() });
  expect(
    (
      await reader.query('SELECT purpose FROM access.lifecycle_coordination WHERE route=$1 AND account_id=$2', [
        routeOf(accountId),
        accountId,
      ])
    ).rows,
  ).toEqual([{ purpose: 'operator' }]);
  expect(await inverse(accountId)).toEqual([]);
});

test('malformed, automated, following, incomplete and overflow evidence fail closed without truncation', async () => {
  const { createMembershipInverseCommands, MembershipInverseIncompleteError } = await api();
  const commands = createMembershipInverseCommands({ pool });
  const accountId = await person();
  const principal = { kind: 'realm' as const, id: newId(0x7600) };
  for (const invalid of [accountId.toUpperCase(), 'invalid']) {
    await expect(commands.reserve({ accountId: invalid, principal, key: key() })).rejects.toBeInstanceOf(
      LifecycleDeniedError,
    );
    await expect(inverse(invalid)).rejects.toBeInstanceOf(LifecycleDeniedError);
  }
  await expect(
    commands.reserve({
      accountId,
      principal: { ...principal, kind: 'following' } as unknown as typeof principal,
      key: key(),
    }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  expect(await inverse(accountId)).toEqual([]);
  await reader.query('UPDATE access.account SET operator_account_id=$3 WHERE route=$1 AND account_id=$2', [
    routeOf(accountId),
    accountId,
    newId(0x7600),
  ]);
  await expect(commands.reserve({ accountId, principal, key: key() })).rejects.toBeInstanceOf(LifecycleDeniedError);
  const legacy = await person();
  await reader.query('UPDATE access.account SET membership_inverse_complete=false WHERE route=$1 AND account_id=$2', [
    routeOf(legacy),
    legacy,
  ]);
  await expect(inverse(legacy)).rejects.toBeInstanceOf(MembershipInverseIncompleteError);
  const overflow = await person();
  await seed(overflow, 1001);
  await expect(inverse(overflow)).rejects.toBeInstanceOf(LifecycleDeniedError);
});

test('bootstrap verifies one actual authoritative change cursor and remains behind the deployment barrier', async () => {
  const { createMembershipInverseCommands, MembershipInverseIncompleteError } = await api();
  const commands = createMembershipInverseCommands({ pool });
  const owner = await person();
  const organizationId = await organization(owner);
  const accountId = await person();
  const transactionId = key();
  await reader.query(
    `INSERT INTO access.organization_member(route,organization_id,member_account_id,role,valid,transaction_id) VALUES($1,$2,$3,'member','(,)'::tstzrange,$4)`,
    [routeOf(organizationId), organizationId, accountId, transactionId],
  );
  await reader.query('UPDATE access.account SET membership_inverse_complete=false WHERE route=$1 AND account_id=$2', [
    routeOf(accountId),
    accountId,
  ]);
  const input = {
    accountId,
    principal: { kind: 'organization' as const, id: organizationId },
    sourceTransactionId: transactionId,
    key: key(),
  };
  await expect(commands.bootstrapStep({ ...input, sourceTransactionId: key() })).rejects.toBeInstanceOf(
    LifecycleDeniedError,
  );
  const first = await commands.bootstrapStep(input);
  expect(first.value.sourceTransactionId).toBe(transactionId);
  expect(await commands.bootstrapStep(input)).toEqual({ ...first, replayed: true });
  await expect(inverse(accountId)).rejects.toBeInstanceOf(MembershipInverseIncompleteError);
  expect(
    (
      await reader.query('SELECT count(*)::int AS n FROM access.membership_inverse WHERE route=$1 AND account_id=$2', [
        routeOf(accountId),
        accountId,
      ])
    ).rows[0].n,
  ).toBe(1);
});

test('inverse anchor probe has bounded rows and buffers across unrelated same-route growth', async () => {
  const accountId = await person();
  await seed(accountId, 3);
  const seedId = 'membership-growth';
  const measured: number[] = [];
  for (const scale of [100, 1000, 5000]) {
    const unrelated = newId(routeOf(accountId)!);
    await reader.query(
      `INSERT INTO access.membership_inverse(route,account_id,kind,group_id,reservation_id,transaction_id)
      SELECT $1,$2,'organization',md5($3 || g)::uuid,md5($3 || 'reservation' || g)::uuid,$4 FROM generate_series(1,$5) g`,
      [routeOf(accountId), unrelated, seedId, key(), scale],
    );
    await reader.query('ANALYZE access.membership_inverse');
    const explain = await reader.query(
      `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT kind,group_id FROM access.membership_inverse WHERE route=$1 AND account_id=$2 ORDER BY kind,group_id`,
      [routeOf(accountId), accountId],
    );
    const plan = explain.rows[0]['QUERY PLAN'][0].Plan;
    expect(plan['Actual Rows']).toBe(3);
    expect(JSON.stringify(plan)).toContain('Index');
    measured.push(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']);
    expect(await inverse(accountId)).toHaveLength(3);
  }
  expect(Math.max(...measured)).toBeLessThanOrEqual(Math.min(...measured) + 8);
  expect(partitionOf(routeOf(accountId)!)).toBe(0x520);
});
