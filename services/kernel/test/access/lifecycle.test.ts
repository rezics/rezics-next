import { afterAll, afterEach, expect, test } from 'bun:test';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { CommandUnavailableError, IdempotencyConflictError } from '../../src/command/command.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { readAccount, readPublicAccount } from '../../src/access/account-data.ts';
import { createAccess } from '../../src/access/permission.ts';
import { AccessUnavailableError } from '../../src/access/index.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import type { AccountActor } from '../../src/request/access.ts';
import {
  createLifecycleInternals,
  createLifecycleCommands,
  LifecycleDeniedError,
  LIFECYCLE_ACTIONS,
  REGISTRATION_TTL_MS,
  HANDLE_REDIRECT_TTL_MS,
} from '../../src/access/lifecycle.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(url);
const reader = createPool(url);
afterAll(async () => {
  await pool.end();
  await reader.end();
});
let instant = Date.now();
let fixedClock = false;
const clock = () => new Date(fixedClock ? instant : Date.now());
afterEach(() => {
  fixedClock = false;
});
const provisions = new Map<
  object,
  { accountId: string; registrationId: string; authIdentityId: string; authnEpoch: number }
>();
const recoveries = new Map<
  object,
  { accountId: string; receiptId: string; minimumAuthnEpoch: string; authnEpoch: number; establishmentId: string }
>();
const internal = createLifecycleInternals({
  pool,
  routeKey: new Uint8Array(32).fill(37),
  clock,
  provisioningEvidence: async (proof: unknown) => provisions.get(proof as object) ?? null,
  recoveryEvidence: async (proof: unknown) => recoveries.get(proof as object) ?? null,
});
const row = (id: string) => withConnection(reader, (client) => readAccount(client, routeOf(id)!, id));
const publicRow = (id: string) => withConnection(reader, (client) => readPublicAccount(client, routeOf(id)!, id));
const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
const commands = createLifecycleCommands({ pool, access, clock });
let sequence = 0;
const key = () => `command-${++sequence}`;
const context = async (id: string, scopes = [...LIFECYCLE_ACTIONS.keys()]) => {
  const claims = {
    accountId: id,
    clientId: 'verified-client',
    requestedBy: null,
    authnEpoch: 1,
    scopes,
  };
  let actor: AccountActor;
  try {
    actor = await authenticateAccount(access, { pool, deadline: Date.now() + 290_000 }, claims);
  } catch {
    actor = { kind: 'account', ...claims };
  }
  return { actor, account: await row(id), deadline: Date.now() + 2000 };
};
async function pending(handle: string) {
  const registrationKey = key();
  const accountId = internal.registrationTarget(registrationKey);
  const claim = await internal.reserveHandle({ handle, accountId, key: registrationKey });
  const account = await internal.createPending({
    handle,
    accountId,
    reservationId: claim.value.reservationId,
    key: registrationKey,
  });
  return { accountId, claim, account, registrationKey };
}
function provisioning(accountId: string, registrationId: string) {
  const proof = {};
  provisions.set(proof, { accountId, registrationId, authIdentityId: accountId, authnEpoch: 1 });
  return proof;
}
async function person(handle: string) {
  const p = await pending(handle);
  const evidence = provisioning(p.accountId, p.claim.value.reservationId);
  await internal.activate({ accountId: p.accountId, key: key(), evidence });
  await internal.claimHandle({
    handle,
    accountId: p.accountId,
    reservationId: p.claim.value.reservationId,
    key: key(),
  });
  return p.accountId;
}
async function organization(owner: string) {
  const organizationId = newId(0x7310);
  const reservation = await internal.reserveCoordination({
    accountId: owner,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: key(),
  });
  await internal.createOrganization({
    organizationId,
    ownerAccountId: owner,
    ownerReservationId: reservation.value.reservationId,
    key: key(),
  });
  return { organizationId, reservationId: reservation.value.reservationId };
}
async function counts(id: string) {
  return withConnection(reader, async (client) => {
    const { rows } = await client.query(
      `SELECT
      (SELECT count(*)::int FROM core.receipt WHERE partition_no = $1) AS receipts,
      (SELECT count(*)::int FROM core.outbox WHERE partition_no = $1) AS events,
      (SELECT position::text FROM core.partition WHERE partition_no = $1) AS position`,
      [partitionOf(routeOf(id)!)],
    );
    return rows[0];
  });
}

test('handle claim and pending account are separate anchored commands with deterministic replay and digest conflicts', async () => {
  instant = Date.now();
  fixedClock = true;
  const registrationKey = key();
  const accountId = internal.registrationTarget(registrationKey);
  expect(internal.registrationTarget(registrationKey)).toBe(accountId);
  const input = { handle: 'Separate_Registration', accountId, key: registrationKey };
  const first = await internal.reserveHandle(input);
  expect(first.value.handle).toBe('separate_registration');
  expect(first.partition).not.toBe(partitionOf(routeOf(accountId)!));
  expect(await row(accountId)).toBeNull();
  expect(first.value.expiresAt).toBe(new Date(instant + REGISTRATION_TTL_MS).toISOString());
  const replay = await internal.reserveHandle(input);
  expect(replay).toEqual({ ...first, replayed: true });
  await expect(internal.reserveHandle({ ...input, accountId: newId(0x1234) })).rejects.toBeInstanceOf(
    IdempotencyConflictError,
  );
  const create = {
    handle: first.value.handle,
    accountId,
    reservationId: first.value.reservationId,
    key: registrationKey,
  };
  const created = await internal.createPending(create);
  expect(await internal.createPending(create)).toEqual({ ...created, replayed: true });
  expect(await row(accountId)).toMatchObject({ state: 'pending', accountId, transactionId: created.transactionId });
  expect(await publicRow(accountId)).toBeNull();
  await expect(internal.createPending({ ...create, handle: 'different' })).rejects.toBeInstanceOf(
    IdempotencyConflictError,
  );
});

test('activation requires verified provisioning bound to this registration and rejects expiry; successful retries retain identity', async () => {
  instant = Date.now();
  fixedClock = true;
  const p = await pending('activation');
  const input = { accountId: p.accountId, key: key(), evidence: {} };
  await expect(internal.activate(input)).rejects.toBeInstanceOf(LifecycleDeniedError);
  await expect(
    internal.activate({ ...input, evidence: provisioning(newId(0x1234), p.claim.value.reservationId) }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  const evidence = provisioning(p.accountId, p.claim.value.reservationId);
  const activated = await internal.activate({ ...input, evidence });
  expect(await internal.activate({ ...input, evidence })).toEqual({ ...activated, replayed: true });
  expect(await row(p.accountId)).toMatchObject({ state: 'active', accountId: p.accountId });
  const expired = await pending('expired_activation');
  const before = instant;
  instant += REGISTRATION_TTL_MS;
  await expect(
    internal.activate({
      accountId: expired.accountId,
      key: key(),
      evidence: provisioning(expired.accountId, expired.claim.value.reservationId),
    }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  expect(await row(expired.accountId)).toMatchObject({ state: 'pending' });
  instant = before;
});

test('handle namespace protects active claims and former handles; expiry releases only expired pending claims', async () => {
  instant = Date.now();
  fixedClock = true;
  const id = await person('namespace');
  const other = internal.registrationTarget(key());
  await expect(internal.reserveHandle({ handle: 'NAMESPACE', accountId: other, key: key() })).rejects.toBeInstanceOf(
    LifecycleDeniedError,
  );
  const before = instant;
  instant += REGISTRATION_TTL_MS + HANDLE_REDIRECT_TTL_MS;
  await expect(internal.expireHandle({ handle: 'namespace', key: key() })).rejects.toBeInstanceOf(LifecycleDeniedError);
  expect(await internal.resolveHandle('namespace')).toMatchObject({ accountId: id, redirect: false });
  await internal.redirectHandle({ handle: 'namespace', accountId: id, key: key() });
  expect(await internal.resolveHandle('namespace')).toMatchObject({ accountId: id, redirect: true });
  await expect(internal.reserveHandle({ handle: 'namespace', accountId: other, key: key() })).rejects.toBeInstanceOf(
    LifecycleDeniedError,
  );
  instant += HANDLE_REDIRECT_TTL_MS;
  expect(await internal.resolveHandle('namespace')).toBeNull();
  await expect(internal.expireHandle({ handle: 'namespace', key: key() })).rejects.toBeInstanceOf(LifecycleDeniedError);
  await expect(internal.reserveHandle({ handle: 'namespace', accountId: other, key: key() })).rejects.toBeInstanceOf(
    LifecycleDeniedError,
  );
  await internal.reserveHandle({ handle: 'namespace', accountId: id, key: key() });
  const expired = await pending('expire_pending');
  instant += REGISTRATION_TTL_MS;
  await internal.expireHandle({ handle: 'expire_pending', key: key() });
  expect(await internal.resolveHandle('expire_pending')).toBeNull();
  await expect(
    internal.claimHandle({
      handle: 'expire_pending',
      accountId: expired.accountId,
      reservationId: expired.claim.value.reservationId,
      key: key(),
    }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  instant = before;
});

test('profile and private settings use real actor grants, scopes and denials and preserve the public allowlist', async () => {
  const id = await person('profile');
  const stranger = await person('stranger');
  const input = {
    accountId: id,
    key: key(),
    patch: {
      displayName: 'Visible',
      biography: 'Public biography',
      birthDate: '2000-02-29',
      contentPreferences: { secret: 'private-preference' },
    },
  };
  const changed = await commands.updateAccount(await context(id), input);
  expect(await commands.updateAccount(await context(id), input)).toEqual({ ...changed, replayed: true });
  expect(await row(id)).toMatchObject({
    displayName: 'Visible',
    birthDate: '2000-02-29',
    contentPreferences: { secret: 'private-preference' },
  });
  const projection = await publicRow(id);
  expect(projection).toMatchObject({ displayName: 'Visible', biography: 'Public biography' });
  expect(JSON.stringify(projection)).not.toContain('private-preference');
  expect(projection).not.toHaveProperty('birthDate');
  expect(projection).not.toHaveProperty('controllerId');
  const original = await row(id);
  const effects = await counts(id);
  for (const ctx of [
    await context(stranger),
    await context(id, []),
    {
      ...(await context(id)),
      actor: { ...(await context(id)).actor, requestedBy: `urn:rezics:request:${stranger}:${newId(0x1520)}` },
    },
  ]) {
    await expect(commands.updateAccount(ctx, { ...input, key: key() })).rejects.toBeInstanceOf(LifecycleDeniedError);
  }
  for (const patch of [
    { id: stranger },
    { kind: 'organization' },
    { route: 0 },
    { actor: stranger },
    { clientId: 'chosen' },
    { scopes: ['account:update'] },
    { handle: 'unreserved' },
  ]) {
    await expect(commands.updateAccount(await context(id), { ...input, key: key(), patch })).rejects.toBeInstanceOf(
      LifecycleDeniedError,
    );
  }
  await reader.query(
    `INSERT INTO access.resource_denial (route, resource_id, subject_id, action, reason, valid, transaction_id) VALUES ($1,$2,$2,'account:update','resource','(,)',$3)`,
    [routeOf(id), id, newId(routeOf(id)!)],
  );
  await expect(commands.updateAccount(await context(id), { ...input, key: key() })).rejects.toBeInstanceOf(
    LifecycleDeniedError,
  );
  expect(await row(id)).toEqual(original);
  expect(await counts(id)).toEqual(effects);
});

test('organizations have an atomic first human owner, explicit role grants and cannot lose the last owner', async () => {
  const owner = await person('owner');
  const member = await person('member');
  const { organizationId, reservationId } = await organization(owner);
  expect(await row(organizationId)).toMatchObject({ kind: 'organization', state: 'active' });
  const reserved = await internal.reserveCoordination({
    accountId: member,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: key(),
  });
  const input = {
    organizationId,
    memberAccountId: member,
    reservationId: reserved.value.reservationId,
    role: 'member' as const,
    key: key(),
  };
  const added = await commands.setMembership(await context(owner), input);
  expect(await commands.setMembership(await context(owner), input)).toEqual({ ...added, replayed: true });
  const before = await counts(organizationId);
  await expect(
    commands.setMembership(await context(member), { ...input, role: 'owner', key: key() }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  for (const role of ['member', null] as const) {
    await expect(
      commands.setMembership(await context(owner), {
        organizationId,
        memberAccountId: owner,
        reservationId,
        role,
        key: key(),
      }),
    ).rejects.toBeInstanceOf(LifecycleDeniedError);
  }
  expect(await counts(organizationId)).toEqual(before);
  await commands.setMembership(await context(owner), { ...input, role: 'owner', key: key() });
  await commands.setMembership(await context(member), {
    organizationId,
    memberAccountId: owner,
    reservationId,
    role: null,
    key: key(),
  });
  await expect(commands.tombstone(await context(owner), { accountId: owner, key: key() })).rejects.toBeInstanceOf(
    LifecycleDeniedError,
  );
  // A removed reservation cannot be reused by delayed membership work.
  await expect(
    commands.setMembership(await context(member), {
      organizationId,
      memberAccountId: owner,
      reservationId,
      role: 'owner',
      key: key(),
    }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
});

test('automated actors cannot reserve membership and unreserved actors cannot join an organization', async () => {
  const owner = await person('automation_owner');
  const automated = await person('automation');
  await reader.query('UPDATE access.account SET operator_account_id=$3 WHERE route=$1 AND account_id=$2', [
    routeOf(automated),
    automated,
    owner,
  ]);
  const { organizationId } = await organization(owner);
  await expect(
    internal.reserveCoordination({
      accountId: automated,
      relatedAccountId: organizationId,
      purpose: 'membership',
      key: key(),
    }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  await expect(
    commands.setMembership(await context(owner), {
      organizationId,
      memberAccountId: automated,
      reservationId: newId(routeOf(automated)!),
      role: 'member',
      key: key(),
    }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  const org = newId(0x9200);
  await expect(
    internal.createOrganization({
      organizationId: org,
      ownerAccountId: automated,
      ownerReservationId: newId(routeOf(automated)!),
      key: key(),
    }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  expect(await row(org)).toBeNull();
});

test('fences commit a durable exact-floor receipt before any Auth effect and reject stale recovery', async () => {
  const id = await person('fence');
  const input = { accountId: id, key: key() };
  const first = await internal.raiseFence(input);
  expect(first.value).toMatchObject({ accountId: id, minimumAuthnEpoch: '2', receiptId: expect.any(String) });
  const receipt = await internal.readFenceReceipt(id, first.value.receiptId);
  expect(receipt).toEqual(first.value);
  expect(await row(id)).toMatchObject({ minimumAuthnEpoch: 2n });
  expect(await internal.readFenceState(id)).toMatchObject({ fenced: true, receiptId: first.value.receiptId });
  expect(await internal.raiseFence(input)).toEqual({ ...first, replayed: true });
  const proof = {};
  recoveries.set(proof, { ...first.value, authnEpoch: 2, establishmentId: 'verified-establishment' });
  const second = await internal.raiseFence({ ...input, key: key() });
  expect(second.value.minimumAuthnEpoch).toBe('3');
  await expect(internal.clearFence({ accountId: id, evidence: proof, key: key() })).rejects.toBeInstanceOf(
    LifecycleDeniedError,
  );
  await expect(
    internal.clearFence({ accountId: id, evidence: { ...recoveries.get(proof) }, key: key() }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  const current = {};
  recoveries.set(current, { ...second.value, authnEpoch: 3, establishmentId: 'new-establishment' });
  await internal.clearFence({ accountId: id, evidence: current, key: key() });
  expect(await internal.readFenceState(id)).toMatchObject({ fenced: false });
  expect(await row(id)).toMatchObject({ minimumAuthnEpoch: 3n });
  expect((await counts(id)).events).toBeGreaterThan(0);
});

test('a failure in the executor final receipt insert rolls back the floor, fence receipt and outbox', async () => {
  const id = await person('rollback_fence');
  const original = await row(id);
  const before = await counts(id);
  await reader.query(
    `CREATE FUNCTION public.reject_lifecycle_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'receipt failure'; END $$`,
  );
  await reader.query(
    `CREATE TRIGGER reject_lifecycle_receipt BEFORE INSERT ON core.receipt FOR EACH ROW EXECUTE FUNCTION public.reject_lifecycle_receipt()`,
  );
  try {
    await expect(internal.raiseFence({ accountId: id, key: key() })).rejects.toThrow('receipt failure');
  } finally {
    await reader.query('DROP TRIGGER reject_lifecycle_receipt ON core.receipt');
    await reader.query('DROP FUNCTION public.reject_lifecycle_receipt()');
  }
  expect(await row(id)).toEqual(original);
  expect(await internal.readFenceState(id)).toMatchObject({ fenced: false, receiptId: null });
  expect(await counts(id)).toEqual(before);
  expect(
    (
      await reader.query('SELECT * FROM access.lifecycle_fence_receipt WHERE route=$1 AND account_id=$2', [
        routeOf(id),
        id,
      ])
    ).rows,
  ).toEqual([]);
});

test('tombstone atomically erases private fields and returns only a durable identity/fence/coordination result', async () => {
  const id = await person('erase');
  const operator = await person('erase_operator');
  await reader.query(
    `UPDATE access.account SET operator_account_id=$3, controller_id=$4, birth_date='2000-01-01', content_preferences='{"secret":"erase-value"}', display_name='erase-name', biography='erase-bio', avatar_url='erase-avatar', suspension_reason='erase-reason' WHERE route=$1 AND account_id=$2`,
    [routeOf(id), id, operator, newId(routeOf(id)!)],
  );
  const operatorBefore = await row(operator);
  const request = { accountId: id, key: key() };
  const ctx = await context(id);
  const result = await commands.tombstone(ctx, request);
  expect(result.value).toMatchObject({ accountId: id, minimumAuthnEpoch: '2', priorOperatorAccountId: operator });
  expect(await internal.readFenceReceipt(id, result.value.receiptId)).toEqual(result.value);
  expect(await internal.readFenceState(id)).toMatchObject({ fenced: true });
  expect(await row(id)).toMatchObject({
    state: 'deleted',
    handle: null,
    operatorAccountId: null,
    controllerId: null,
    birthDate: null,
    contentPreferences: {},
    displayName: null,
    avatarUrl: null,
    biography: null,
    suspensionReason: null,
    minimumAuthnEpoch: 2n,
  });
  expect(await publicRow(id)).toEqual({ accountId: id, kind: 'actor', state: 'deleted' });
  // Admission re-reads the account. Deletion changes that snapshot, so the same
  // actor cannot replay the command after the account is gone.
  await expect(commands.tombstone(ctx, request)).rejects.toBeInstanceOf(LifecycleDeniedError);
  expect(await row(operator)).toEqual(operatorBefore);
  const stored = await reader.query(
    'SELECT row_to_json(a)::text AS value FROM access.account a WHERE route=$1 AND account_id=$2',
    [routeOf(id), id],
  );
  expect(stored.rows[0].value).not.toContain('erase-');
  const effects = await reader.query(
    'SELECT response::text FROM core.receipt WHERE partition_no=$1 UNION ALL SELECT data::text FROM core.outbox WHERE partition_no=$1',
    [partitionOf(routeOf(id)!)],
  );
  expect(JSON.stringify(effects.rows)).not.toContain('erase-value');
});

test('operator responsibility and unresolved membership reservations deny tombstones with no committed effects', async () => {
  const id = await person('responsible');
  await internal.reserveCoordination({
    accountId: id,
    relatedAccountId: newId(0x7700),
    purpose: 'operator',
    key: key(),
  });
  const original = await row(id);
  const before = await counts(id);
  await expect(commands.tombstone(await context(id), { accountId: id, key: key() })).rejects.toBeInstanceOf(
    LifecycleDeniedError,
  );
  expect(await row(id)).toEqual(original);
  expect(await counts(id)).toEqual(before);
});

async function automated(operator: string, handle: string) {
  const id = await person(handle);
  await reader.query('UPDATE access.account SET operator_account_id=$3 WHERE route=$1 AND account_id=$2', [
    routeOf(id),
    id,
    operator,
  ]);
  return id;
}
async function manages(manager: string, operator: string) {
  await reader.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,'account:manage','(,)',$3)`,
    [routeOf(operator), operator, manager],
  );
}

test('a human who manages an operator can delete an automated account that operator operates, a human who does not manage that operator cannot', async () => {
  const operator = await person('delete_operator');
  const manager = await person('delete_manager');
  const stranger = await person('delete_stranger');
  await manages(manager, operator);
  const subject = await automated(operator, 'delete_automated');
  const before = await row(subject);
  await expect(commands.tombstone(await context(stranger), { accountId: subject, key: key() })).rejects.toBeInstanceOf(
    LifecycleDeniedError,
  );
  expect(await row(subject)).toEqual(before);
  const grants = await reader.query(
    'SELECT count(*)::int AS n FROM access.resource_grant WHERE route=$1 AND resource_id=$2',
    [routeOf(subject), subject],
  );
  const result = await commands.tombstone(await context(manager), { accountId: subject, key: key() });
  expect(result.value).toMatchObject({ accountId: subject, priorOperatorAccountId: operator });
  expect(await row(subject)).toMatchObject({ state: 'deleted', operatorAccountId: null });
  // Authority is read through the relation: no standing grant was written on the account.
  const after = await reader.query(
    'SELECT count(*)::int AS n FROM access.resource_grant WHERE route=$1 AND resource_id=$2',
    [routeOf(subject), subject],
  );
  expect(after.rows[0].n).toBe(grants.rows[0].n);
});

test('a human who manages the prior operator can replay an automated account tombstone with its original receipt', async () => {
  const operator = await person('replay_operator');
  const manager = await person('replay_manager');
  await manages(manager, operator);
  const subject = await automated(operator, 'replay_automated');
  const request = { accountId: subject, key: key() };

  const deleted = await commands.tombstone(await context(manager), request);
  const replay = await commands.tombstone(await context(manager), request);

  expect(replay).toEqual({ ...deleted, replayed: true });
  expect(replay.value).toEqual(deleted.value);
});

test('a tombstone replay stays denied after its caller loses management of the recorded prior operator', async () => {
  const operator = await person('revoked_replay_operator');
  const manager = await person('revoked_replay_manager');
  await manages(manager, operator);
  const subject = await automated(operator, 'revoked_replay_automated');
  const request = { accountId: subject, key: key() };

  await commands.tombstone(await context(manager), request);
  await reader.query(
    `DELETE FROM access.resource_grant
    WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action='account:manage'`,
    [routeOf(operator), operator, manager],
  );

  await expect(commands.tombstone(await context(manager), request)).rejects.toBeInstanceOf(LifecycleDeniedError);
});

test('a deleted automated account cannot receive a new tombstone command from its former operator manager', async () => {
  const operator = await person('new_key_operator');
  const manager = await person('new_key_manager');
  await manages(manager, operator);
  const subject = await automated(operator, 'new_key_automated');
  await commands.tombstone(await context(manager), { accountId: subject, key: key() });
  const before = await row(subject);

  await expect(commands.tombstone(await context(manager), { accountId: subject, key: key() })).rejects.toBeInstanceOf(
    LifecycleDeniedError,
  );
  expect(await row(subject)).toEqual(before);
});

test("after a transfer the old operator's managers can no longer delete it and the new operator's can", async () => {
  const oldOperator = await person('transfer_old');
  const newOperator = await person('transfer_new');
  const oldManager = await person('transfer_old_manager');
  const newManager = await person('transfer_new_manager');
  await manages(oldManager, oldOperator);
  await manages(newManager, newOperator);
  const subject = await automated(oldOperator, 'transfer_automated');
  await reader.query('UPDATE access.account SET operator_account_id=$3 WHERE route=$1 AND account_id=$2', [
    routeOf(subject),
    subject,
    newOperator,
  ]);
  const before = await row(subject);
  await expect(
    commands.tombstone(await context(oldManager), { accountId: subject, key: key() }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  expect(await row(subject)).toEqual(before);
  const result = await commands.tombstone(await context(newManager), { accountId: subject, key: key() });
  expect(result.value).toMatchObject({ accountId: subject, priorOperatorAccountId: newOperator });
  expect(await row(subject)).toMatchObject({ state: 'deleted' });
});

test("a person's account is still deleted only by that person", async () => {
  const person_ = await person('delete_person');
  const other = await person('delete_person_other');
  const holder = await person('delete_person_manager');
  await manages(holder, other);
  await manages(holder, person_);
  const before = await row(person_);
  await expect(commands.tombstone(await context(holder), { accountId: person_, key: key() })).rejects.toBeInstanceOf(
    LifecycleDeniedError,
  );
  await expect(commands.tombstone(await context(other), { accountId: person_, key: key() })).rejects.toBeInstanceOf(
    LifecycleDeniedError,
  );
  expect(await row(person_)).toEqual(before);
  await commands.tombstone(await context(person_), { accountId: person_, key: key() });
  expect(await row(person_)).toMatchObject({ state: 'deleted' });
});

test('an operator with operated accounts still cannot be deleted', async () => {
  const operator = await person('held_operator');
  const subject = await automated(operator, 'held_automated');
  const manager = await person('held_manager');
  await manages(manager, operator);
  await internal.reserveCoordination({
    accountId: operator,
    relatedAccountId: subject,
    purpose: 'operator',
    key: key(),
  });
  const before = await row(operator);
  await expect(commands.tombstone(await context(operator), { accountId: operator, key: key() })).rejects.toBeInstanceOf(
    LifecycleDeniedError,
  );
  await commands.tombstone(await context(manager), { accountId: subject, key: key() });
  // The responsibility hold outlives the operated account until it is released.
  await expect(commands.tombstone(await context(operator), { accountId: operator, key: key() })).rejects.toBeInstanceOf(
    LifecycleDeniedError,
  );
  expect(await row(operator)).toEqual(before);
});

test('fenced and moved partitions reject through the actual executor and authorization unavailability denies', async () => {
  const id = await person('partition_fence');
  const partition = partitionOf(routeOf(id)!);
  const original = await row(id);
  const before = await counts(id);
  for (const state of ['fenced', 'moved']) {
    await reader.query('UPDATE core.partition SET write_state=$2, moved_to=$3 WHERE partition_no=$1', [
      partition,
      state,
      state === 'moved' ? 'next-node' : null,
    ]);
    try {
      await expect(
        commands.updateAccount(
          { ...(await context(id)), deadline: Date.now() + 150 },
          { accountId: id, key: key(), patch: { displayName: 'forbidden' } },
        ),
      ).rejects.toBeInstanceOf(CommandUnavailableError);
    } finally {
      await reader.query("UPDATE core.partition SET write_state='active', moved_to=NULL WHERE partition_no=$1", [
        partition,
      ]);
    }
  }
  const unknown = createAccess({ actions: new Map(), accountEvidence: (_actor, ctx) => ctx.account });
  const unavailable = createLifecycleCommands({ pool, access: unknown, clock });
  await expect(
    unavailable.updateAccount(await context(id), { accountId: id, key: key(), patch: { displayName: 'forbidden' } }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  const unavailableActor = await context(id);
  await expect(
    commands.updateAccount(
      {
        ...unavailableActor,
        actor: { ...unavailableActor.actor, scopes: [...unavailableActor.actor.scopes] },
      },
      { accountId: id, key: key(), patch: { displayName: 'forbidden' } },
    ),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  expect(await row(id)).toEqual(original);
  expect(await counts(id)).toEqual(before);
});

test('prepared evidence is gathered once and expires before a delayed command attempt', async () => {
  const id = await person('delayed_evidence');
  let prepares = 0;
  const delayed = createLifecycleCommands({
    pool,
    clock,
    access: deriveAccess(access, {
      async prepare(actor, action, resource, ctx) {
        prepares++;
        const evidence = await access.prepare!(actor, action, resource, { ...ctx, deadline: Date.now() + 1000 });
        await Bun.sleep(1050);
        return evidence;
      },
    }),
  });
  const before = await counts(id);
  await expect(
    delayed.updateAccount(await context(id), { accountId: id, key: key(), patch: { displayName: 'expired' } }),
  ).rejects.toBeInstanceOf(AccessUnavailableError);
  expect(prepares).toBe(1);
  expect(await counts(id)).toEqual(before);
});
