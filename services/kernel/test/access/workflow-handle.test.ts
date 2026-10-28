import { afterAll, expect, test } from 'bun:test';
import { createPool, withConnection } from '../../src/database/pool.ts';
import { IdempotencyConflictError } from '../../src/command/command.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';
import type { AccountActor } from '../../src/request/access.ts';
import {
  createLifecycleCommands,
  createLifecycleInternals,
  HANDLE_REDIRECT_TTL_MS,
  LIFECYCLE_ACTIONS,
  LifecycleDeniedError,
  REGISTRATION_TTL_MS,
} from '../../src/access/lifecycle.ts';
import { newId, routeOf } from '../../src/route/route.ts';

const pool = createPool(process.env.DATABASE_URL!);
const reader = createPool(process.env.DATABASE_URL!);
afterAll(async () => {
  await pool.end();
  await reader.end();
});
let instant = Date.now();
let sequence = 0;
const key = () => `handle-command-${++sequence}`;
const clock = () => new Date(instant);
const proofs = new Map<
  string,
  { accountId: string; registrationId: string; authIdentityId: string; authnEpoch: number }
>();
const internal = createLifecycleInternals({
  pool,
  clock,
  routeKey: new Uint8Array(32).fill(83),
  provisioningEvidence: async (proof) => proofs.get(String(proof)) ?? null,
  recoveryEvidence: async () => null,
});
const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
// Authorization uses the real database clock; the injected coordinator clock
// advances lifecycle deadlines without changing the request evidence budget.
const commands = createLifecycleCommands({ pool, access });
const row = (id: string) => withConnection(reader, (client) => readAccount(client, routeOf(id)!, id));
async function context(id: string, scopes = ['account:update']) {
  const claims = { accountId: id, clientId: 'verified-client', requestedBy: null, authnEpoch: 1, scopes };
  let actor: AccountActor;
  try {
    actor = await authenticateAccount(access, { pool, deadline: Date.now() + 290_000 }, claims);
  } catch {
    actor = { kind: 'account', ...claims };
  }
  return { actor, account: await row(id), deadline: Date.now() + 5000 };
}
async function pending(handle: string) {
  const registrationKey = key();
  const accountId = internal.registrationTarget(registrationKey);
  const claim = (await internal.reserveHandle({ handle, accountId, key: key() })).value;
  await internal.createPending({ ...claim, key: key() });
  const evidence = key();
  proofs.set(evidence, { accountId, registrationId: claim.reservationId, authIdentityId: accountId, authnEpoch: 1 });
  return { ...claim, evidence };
}
async function person(handle: string) {
  const p = await pending(handle);
  await internal.claimHandle({ ...p, key: key() });
  await internal.activate({ ...p, key: key() });
  return p.accountId;
}
async function prepare(accountId: string, handle: string, expectedHandle: string | null) {
  const reservation = (await internal.reserveHandle({ handle, accountId, key: key() })).value;
  const input = {
    accountId,
    handle: reservation.handle,
    reservationId: reservation.reservationId,
    expectedHandle,
    operationId: key(),
    key: key(),
  };
  await internal.holdHandle(input);
  return input;
}
async function finish(input: Awaited<ReturnType<typeof prepare>>) {
  await internal.finalizeHandleTransition({ ...input, key: `${input.key}:claim` });
  if (input.expectedHandle !== null)
    await internal.redirectTransitionHandle({ ...input, key: `${input.key}:redirect` });
  return internal.completeHandleTransition({ ...input, key: `${input.key}:complete` });
}

test('organization first handle and both kinds of rename use real authorized account-anchor commands', async () => {
  const owner = await person('handle_owner');
  const organizationId = newId(0x3394);
  const hold = (
    await internal.reserveCoordination({
      accountId: owner,
      relatedAccountId: organizationId,
      purpose: 'membership',
      key: key(),
    })
  ).value;
  await internal.createOrganization({
    organizationId,
    ownerAccountId: owner,
    ownerReservationId: hold.reservationId,
    key: key(),
  });
  expect((await row(organizationId))!.handle).toBeNull();
  const first = await prepare(organizationId, 'First_Organization', null);
  await commands.transitionAccountHandle(await context(owner), first);
  await finish(first);
  expect(await row(organizationId)).toMatchObject({ handle: 'first_organization', kind: 'organization' });
  for (const [actor, accountId, oldHandle, nextHandle] of [
    [owner, owner, 'handle_owner', 'renamed_person'],
    [owner, organizationId, 'first_organization', 'renamed_organization'],
  ] as const) {
    const input = await prepare(accountId, nextHandle, oldHandle);
    await commands.transitionAccountHandle(await context(actor), input);
    await finish(input);
    expect(await internal.resolveHandle(nextHandle)).toEqual({ accountId, redirect: false });
    expect(await internal.resolveHandle(oldHandle)).toEqual({ accountId, redirect: true });
    expect(await row(accountId)).toMatchObject({ handle: nextHandle });
  }
});

test('holds survive pending TTL before and after publication, recovery finishes every separate phase', async () => {
  const id = await person('crash_old');
  const input = await prepare(id, 'crash_new', 'crash_old');
  instant += REGISTRATION_TTL_MS + 1;
  await expect(internal.expireHandle({ handle: input.handle, key: key() })).rejects.toBeInstanceOf(
    LifecycleDeniedError,
  );
  await expect(
    internal.reserveHandle({ handle: input.handle, accountId: newId(0x1234), key: key() }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  const published = await commands.transitionAccountHandle(await context(id), input);
  instant += REGISTRATION_TTL_MS + 1;
  expect(await row(id)).toMatchObject({ handle: input.handle });
  await expect(
    internal.reserveHandle({ handle: input.handle, accountId: newId(0x1234), key: key() }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  expect((await commands.transitionAccountHandle(await context(id), input)).transactionId).toBe(
    published.transactionId,
  );
  await internal.finalizeHandleTransition({ ...input, key: `${input.key}:claim` });
  instant += REGISTRATION_TTL_MS + 1;
  await internal.redirectTransitionHandle({ ...input, key: `${input.key}:redirect` });
  await finish(input);
  expect(await internal.resolveHandle('crash_old')).toEqual({ accountId: id, redirect: true });
  instant += HANDLE_REDIRECT_TTL_MS - 1;
  await expect(
    internal.reserveHandle({ handle: 'crash_old', accountId: newId(0x1234), key: key() }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  instant += 1;
  await expect(
    internal.reserveHandle({ handle: 'crash_old', accountId: newId(0x1234), key: key() }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  await finish(input);
  const reclaim = await prepare(id, 'crash_old', input.handle);
  await commands.transitionAccountHandle(await context(id), reclaim);
  await finish(reclaim);
  expect(await internal.resolveHandle('crash_old')).toEqual({ accountId: id, redirect: false });
});

test('public rename binds actor, scopes, expected handle, reservation and digest before receipt disclosure', async () => {
  const id = await person('authorization_old');
  const stranger = await person('authorization_stranger');
  const input = await prepare(id, 'authorization_new', 'authorization_old');
  await expect(
    commands.updateAccount(await context(id), { accountId: id, key: key(), patch: { handle: input.handle } }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  await expect(commands.transitionAccountHandle(await context(stranger), input)).rejects.toBeInstanceOf(
    LifecycleDeniedError,
  );
  await expect(
    commands.transitionAccountHandle(await context(id), { ...input, reservationId: newId(0x1234) }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  await commands.transitionAccountHandle(await context(id), input);
  await expect(commands.transitionAccountHandle(await context(id, []), input)).rejects.toBeInstanceOf(
    LifecycleDeniedError,
  );
  await expect(
    commands.transitionAccountHandle(await context(id), { ...input, expectedHandle: 'different' }),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);
  await internal.raiseFence({ accountId: id, key: key() });
  await expect(commands.transitionAccountHandle(await context(id), input)).rejects.toBeInstanceOf(LifecycleDeniedError);
});

test('concurrent renames serialize and terminal cancellation cannot release or repoint a newer claim', async () => {
  const id = await person('competing_old');
  const a = await prepare(id, 'competing_a', 'competing_old');
  const b = await prepare(id, 'competing_b', 'competing_old');
  const results = await Promise.allSettled([
    commands.transitionAccountHandle(await context(id), a),
    commands.transitionAccountHandle(await context(id), b),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  const winner = results[0]!.status === 'fulfilled' ? a : b;
  const loser = winner === a ? b : a;
  await internal.cancelHandleTransition({ ...loser, key: `${loser.key}:cancel` });
  await internal.releaseHandleTransition({ ...loser, key: `${loser.key}:release` });
  await expect(commands.transitionAccountHandle(await context(id), { ...loser, key: key() })).rejects.toBeInstanceOf(
    LifecycleDeniedError,
  );
  await expect(internal.cancelHandleTransition({ ...winner, key: key() })).rejects.toBeInstanceOf(LifecycleDeniedError);
  await finish(winner);
  const other = newId(0x1234);
  await internal.reserveHandle({ handle: loser.handle, accountId: other, key: key() });
  await internal.releaseHandleTransition({ ...loser, key: `${loser.key}:release` });
  expect(await internal.resolveHandle(loser.handle)).toEqual({ accountId: other, redirect: false });
  expect(await row(id)).toMatchObject({ handle: winner.handle });
});

test('expired registration after active handle barrier terminalizes account before releasing only its own claim', async () => {
  const p = await pending('expired_barrier');
  await internal.claimHandle({ ...p, key: key() });
  instant += REGISTRATION_TTL_MS + 1;
  await expect(internal.activate({ ...p, key: key() })).rejects.toBeInstanceOf(LifecycleDeniedError);
  await expect(internal.expireHandle({ handle: p.handle, key: key() })).rejects.toBeInstanceOf(LifecycleDeniedError);
  await expect(internal.releaseExpiredRegistrationHandle({ ...p, key: key() })).rejects.toBeInstanceOf(
    LifecycleDeniedError,
  );
  await internal.expireRegistration({ ...p, key: key() });
  expect(await row(p.accountId)).toMatchObject({ state: 'deleted', fenced: true });
  await internal.releaseExpiredRegistrationHandle({ ...p, key: key() });
  expect(await internal.resolveHandle(p.handle)).toBeNull();
  const next = await pending(p.handle);
  expect(next.accountId).not.toBe(p.accountId);
  await expect(internal.releaseExpiredRegistrationHandle({ ...p, key: key() })).rejects.toBeInstanceOf(
    LifecycleDeniedError,
  );
  expect(await internal.resolveHandle(p.handle)).toMatchObject({ accountId: next.accountId });
  await expect(internal.activate({ ...p, key: key() })).rejects.toBeInstanceOf(LifecycleDeniedError);
});
