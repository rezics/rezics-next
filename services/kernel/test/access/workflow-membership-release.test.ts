import { afterAll, expect, test } from 'bun:test';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import { createOperatorCommands } from '../../src/access/operator.ts';
import {
  createLifecycleCommands,
  createLifecycleInternals,
  LIFECYCLE_ACTIONS,
  LifecycleDeniedError,
} from '../../src/access/lifecycle.ts';
import { IdempotencyConflictError } from '../../src/command/command.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';

const pool = createPool(process.env.DATABASE_URL!);
pool.options.max = 1;
const actions = new Map([...LIFECYCLE_ACTIONS, ['account:manage', { anonymous: false }] as const]);
const access = admittedAccess({ actions });
const commands = createLifecycleCommands({ pool, access });
const operators = createOperatorCommands({ pool, access, actions, managementAction: 'account:manage' });
const proofs = new Map<
  string,
  { accountId: string; registrationId: string; authIdentityId: string; authnEpoch: number }
>();
const internal = createLifecycleInternals({
  pool,
  routeKey: new Uint8Array(32).fill(59),
  provisioningEvidence: async (proof) => proofs.get(String(proof)) ?? null,
  recoveryEvidence: async () => null,
});
afterAll(() => pool.end());
let sequence = 0;
const key = () => `membership-release-${++sequence}`;
const row = (id: string) => withConnection(pool, (client) => readAccount(client, routeOf(id)!, id));
async function context(id: string) {
  return {
    actor: await authenticateAccount(
      access,
      { pool, deadline: Date.now() + 10_000 },
      { accountId: id, clientId: 'verified-client', scopes: [...actions.keys()], requestedBy: null, authnEpoch: 1 },
    ),
    account: await row(id),
    deadline: Date.now() + 5000,
  };
}
async function person() {
  const accountId = internal.registrationTarget(key());
  const claim = (await internal.reserveHandle({ accountId, handle: key(), key: key() })).value;
  await internal.createPending({ ...claim, key: key() });
  const evidence = key();
  proofs.set(evidence, { accountId, registrationId: claim.reservationId, authIdentityId: accountId, authnEpoch: 1 });
  await internal.activate({ accountId, evidence, key: key() });
  return accountId;
}
async function organization(ownerAccountId: string) {
  const organizationId = newId(0x3710);
  const hold = (
    await internal.reserveCoordination({
      accountId: ownerAccountId,
      relatedAccountId: organizationId,
      purpose: 'membership',
      key: key(),
    })
  ).value;
  await internal.createOrganization({
    organizationId,
    ownerAccountId,
    ownerReservationId: hold.reservationId,
    key: key(),
  });
  return organizationId;
}
async function reserve(organizationId: string, memberAccountId: string) {
  const hold = (
    await internal.reserveCoordination({
      accountId: memberAccountId,
      relatedAccountId: organizationId,
      purpose: 'membership',
      key: key(),
    })
  ).value;
  return { organizationId, memberAccountId, reservationId: hold.reservationId };
}
async function set(owner: string, input: Awaited<ReturnType<typeof reserve>>, role: 'owner' | 'member' | null) {
  return commands.setMembership(await context(owner), { ...input, role, key: key() });
}
async function holds(id: string) {
  return (
    await pool.query(
      'SELECT reservation_id::text FROM access.lifecycle_coordination WHERE route=$1 AND account_id=$2 ORDER BY reservation_id',
      [routeOf(id), id],
    )
  ).rows.map((r) => r.reservation_id);
}

test('terminal removal and cancellation release only their member hold and unblock account deletion', async () => {
  const owner = await person();
  const org = await organization(owner);
  for (const activate of [true, false]) {
    const member = await person();
    const input = await reserve(org, member);
    if (activate) await set(owner, input, 'member');
    expect((await operators.deletionEligibility(member)).safe).toBe(false);
    await expect(commands.tombstone(await context(member), { accountId: member, key: key() })).rejects.toBeInstanceOf(
      LifecycleDeniedError,
    );
    await set(owner, input, null);
    expect((await operators.deletionEligibility(member)).safe).toBe(false);
    await internal.releaseMembershipCoordination({ ...input, key: key() });
    expect(await holds(member)).toEqual([]);
    expect((await operators.deletionEligibility(member)).safe).toBe(true);
    await commands.tombstone(await context(member), { accountId: member, key: key() });
    expect((await row(member))!.state).toBe('deleted');
  }
});

test('active and absent membership evidence never release and last owner remains protected', async () => {
  const owner = await person();
  const org = await organization(owner);
  const member = await person();
  const pending = await reserve(org, member);
  await expect(internal.releaseMembershipCoordination({ ...pending, key: key() })).rejects.toBeInstanceOf(
    LifecycleDeniedError,
  );
  await set(owner, pending, 'member');
  await expect(internal.releaseMembershipCoordination({ ...pending, key: key() })).rejects.toBeInstanceOf(
    LifecycleDeniedError,
  );
  const ownerHold = (await holds(owner))[0]!;
  await expect(
    set(owner, { organizationId: org, memberAccountId: owner, reservationId: ownerHold }, null),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  await expect(
    internal.releaseMembershipCoordination({
      organizationId: org,
      memberAccountId: owner,
      reservationId: ownerHold,
      key: key(),
    }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  expect(await holds(member)).toEqual([pending.reservationId]);
});

test('wrong organization member reservation and purpose cannot delete a newer or operator hold', async () => {
  const owner = await person();
  const org = await organization(owner);
  const otherOrg = await organization(owner);
  const member = await person();
  const other = await person();
  const old = await reserve(org, member);
  await set(owner, old, null);
  const next = await reserve(org, member);
  await set(owner, next, 'member');
  const operator = (
    await operators.reserveResponsibility({ operatorAccountId: member, subjectAccountId: newId(0x3920), key: key() })
  ).value;
  const before = await holds(member);
  for (const input of [
    { ...old, organizationId: otherOrg },
    { ...old, memberAccountId: other },
    { ...old, reservationId: next.reservationId },
    { ...old, reservationId: operator.reservationId },
    { ...old, reservationId: newId(0x3920) },
  ])
    await expect(internal.releaseMembershipCoordination({ ...input, key: key() })).rejects.toBeInstanceOf(
      LifecycleDeniedError,
    );
  expect(await holds(member)).toEqual(before);
  await internal.releaseMembershipCoordination({ ...old, key: key() });
  expect((await holds(member)).sort()).toEqual([next.reservationId, operator.reservationId].sort());
  expect((await operators.deletionEligibility(member)).safe).toBe(false);
});

test('lost acknowledgement retries one native receipt and rejects conflicting digest', async () => {
  const owner = await person();
  const org = await organization(owner);
  const member = await person();
  const input = await reserve(org, member);
  await set(owner, input, null);
  const command = { ...input, key: key() };
  const first = await internal.releaseMembershipCoordination(command);
  const replay = await internal.releaseMembershipCoordination(command);
  expect(replay.transactionId).toBe(first.transactionId);
  expect(replay.position).toBe(first.position);
  expect(replay.replayed).toBe(true);
  expect(
    (
      await pool.query(
        "SELECT transaction_id FROM core.receipt WHERE partition_no=$1 AND command_kind='access.membership-coordination-released' AND idempotency_key=$2",
        [partitionOf(routeOf(member)!), `${routeOf(member)}:${command.key}`],
      )
    ).rows,
  ).toHaveLength(1);
  await expect(
    internal.releaseMembershipCoordination({ ...command, reservationId: newId(0x3920) }),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);
});

test('permanent terminal slot denies delayed activation even while its hold still exists', async () => {
  const owner = await person();
  const org = await organization(owner);
  const member = await person();
  const input = await reserve(org, member);
  await set(owner, input, null);
  await expect(set(owner, input, 'member')).rejects.toBeInstanceOf(LifecycleDeniedError);
  await internal.releaseMembershipCoordination({ ...input, key: key() });
  await expect(set(owner, input, 'owner')).rejects.toBeInstanceOf(LifecycleDeniedError);
  const slots = (
    await pool.query(
      'SELECT terminal FROM access.lifecycle_membership_slot WHERE route=$1 AND organization_id=$2 AND member_account_id=$3 AND reservation_id=$4',
      [routeOf(org), org, member, input.reservationId],
    )
  ).rows;
  expect(slots).toEqual([{ terminal: true }]);
  expect((await operators.deletionEligibility(member)).safe).toBe(true);
});

test('an owner who leaves after a successor owner exists releases their own hold on the committed terminal record', async () => {
  const owner = await person();
  const successor = await person();
  const org = await organization(owner);
  const [ownerHold] = await holds(owner);
  await set(owner, await reserve(org, successor), 'owner');
  const leaving = { organizationId: org, memberAccountId: owner, reservationId: ownerHold! };
  await set(owner, leaving, null);
  // The owner no longer holds the right that removed them; release needs no actor.
  await internal.releaseMembershipCoordination({ ...leaving, key: key() });
  expect(await holds(owner)).toEqual([]);
  expect((await operators.deletionEligibility(owner)).safe).toBe(true);
});
