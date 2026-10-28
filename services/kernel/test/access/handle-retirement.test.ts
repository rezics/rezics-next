import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { readAccount } from '../../src/access/account-data.ts';
import {
  createLifecycleCommands,
  createLifecycleInternals,
  HANDLE_REDIRECT_TTL_MS,
  LIFECYCLE_ACTIONS,
  LifecycleDeniedError,
} from '../../src/access/lifecycle.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
let instant = Date.now();
const clock = () => new Date(instant);
const internal = createLifecycleInternals({
  pool,
  clock,
  routeKey: new Uint8Array(32).fill(71),
  provisioningEvidence: async (evidence) => proofs.get(evidence as object) ?? null,
  recoveryEvidence: async () => null,
});
const commands = createLifecycleCommands({ pool, access, clock });
const kernel = createKernel({ pool, routeKey: new Uint8Array(32).fill(72), clock });
const proofs = new Map<
  object,
  { accountId: string; registrationId: string; authIdentityId: string; authnEpoch: number }
>();
const key = () => Bun.randomUUIDv7();
afterAll(async () => pool.end());

async function context(accountId: string) {
  const deadline = Date.now() + 30_000;
  const actor = await authenticateAccount(
    access,
    { pool, deadline },
    {
      accountId,
      clientId: 'handle-retirement-test',
      scopes: [...LIFECYCLE_ACTIONS.keys()],
      requestedBy: null,
      authnEpoch: 1,
    },
  );
  return { actor, account: await readAccount(pool, routeOf(accountId)!, accountId), deadline };
}

async function person(handle: string) {
  const registrationKey = key();
  const accountId = internal.registrationTarget(registrationKey);
  const reservation = await internal.reserveHandle({ handle, accountId, key: registrationKey });
  const claim = reservation.value;
  await internal.createPending({ accountId, handle: claim.handle, reservationId: claim.reservationId, key: key() });
  const evidence = {};
  proofs.set(evidence, {
    accountId,
    registrationId: claim.reservationId,
    authIdentityId: accountId,
    authnEpoch: 1,
  });
  await internal.claimHandle({
    accountId,
    handle: claim.handle,
    reservationId: claim.reservationId,
    key: key(),
    evidence,
  });
  await internal.activate({ accountId, key: key(), evidence });
  return accountId;
}

async function prepare(accountId: string, handle: string, expectedHandle: string) {
  const reservation = (await internal.reserveHandle({ accountId, handle, key: key() })).value;
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

async function rename(accountId: string, oldHandle: string, nextHandle: string) {
  const input = await prepare(accountId, nextHandle, oldHandle);
  await commands.transitionAccountHandle(await context(accountId), input);
  await internal.finalizeHandleTransition({ ...input, key: `${input.key}:claim` });
  await internal.redirectTransitionHandle({ ...input, key: `${input.key}:redirect` });
  await internal.completeHandleTransition({ ...input, key: `${input.key}:complete` });
}

async function read(handle: string) {
  const response = await kernel.handle(
    new Request(`https://kernel.test/v1/accounts?handle=${encodeURIComponent(handle)}`),
  );
  return {
    status: response.status,
    body: (await response.json()) as { accounts: Record<string, unknown>[]; next: null },
  };
}

test.serial('after a rename the old handle answers movedTo for 30 days and not after', async () => {
  instant = Date.now();
  const id = await person('retirement_window_old');
  await rename(id, 'retirement_window_old', 'retirement_window_current');

  expect(await read('retirement_window_old')).toMatchObject({
    status: 200,
    body: { accounts: [{ id, handle: 'retirement_window_current', movedTo: 'retirement_window_current' }] },
  });

  instant += HANDLE_REDIRECT_TTL_MS - 1;
  expect((await read('retirement_window_old')).body.accounts[0]).toHaveProperty('movedTo', 'retirement_window_current');
  instant += 1;
  expect(await read('retirement_window_old')).toEqual(await read('retirement_window_unknown'));
});

test.serial('a renamed-twice account forwards every former handle straight to its current handle', async () => {
  instant = Date.now();
  const id = await person('retirement_chain_first');
  await rename(id, 'retirement_chain_first', 'retirement_chain_second');
  instant += 1000;
  await rename(id, 'retirement_chain_second', 'retirement_chain_current');

  for (const handle of ['retirement_chain_first', 'retirement_chain_second']) {
    expect(await read(handle)).toMatchObject({
      status: 200,
      body: { accounts: [{ id, handle: 'retirement_chain_current', movedTo: 'retirement_chain_current' }] },
    });
  }
});

test.serial('a former handle cannot be claimed by another account, and its active owner can take it back', async () => {
  instant = Date.now();
  const owner = await person('retirement_reclaim_old');
  const other = await person('retirement_reclaim_other');
  await rename(owner, 'retirement_reclaim_old', 'retirement_reclaim_current');

  await expect(
    internal.reserveHandle({ handle: 'retirement_reclaim_old', accountId: other, key: key() }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  instant += HANDLE_REDIRECT_TTL_MS + 1;
  await expect(
    internal.reserveHandle({ handle: 'retirement_reclaim_old', accountId: other, key: key() }),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);

  await rename(owner, 'retirement_reclaim_current', 'retirement_reclaim_old');
  expect(await internal.resolveHandle('retirement_reclaim_old')).toEqual({ accountId: owner, redirect: false });
  expect(await read('retirement_reclaim_old')).toMatchObject({
    status: 200,
    body: { accounts: [{ id: owner, handle: 'retirement_reclaim_old' }] },
  });
});

test.serial('a sixth handle change is refused while the fifth-latest change is under 30 days old', async () => {
  instant = Date.now();
  const id = await person('retirement_cap_initial');
  let current = 'retirement_cap_initial';
  for (let change = 1; change <= 5; change++) {
    const next = `retirement_cap_change_${change}`;
    await rename(id, current, next);
    current = next;
    instant += 60_000;
  }

  const sixth = await prepare(id, 'retirement_cap_sixth', current);
  await expect(commands.transitionAccountHandle(await context(id), sixth)).rejects.toBeInstanceOf(LifecycleDeniedError);
  await internal.cancelHandleTransition({ ...sixth, key: `${sixth.key}:cancel` });
  await internal.releaseHandleTransition({ ...sixth, key: `${sixth.key}:release` });
});

test.serial(
  'deleted current and former handles are indistinguishable from unknown handles and stay unclaimable',
  async () => {
    instant = Date.now();
    const id = await person('retirement_deleted_former');
    const other = await person('retirement_deleted_other');
    await rename(id, 'retirement_deleted_former', 'retirement_deleted_current');
    await commands.tombstone(await context(id), { accountId: id, key: key() });
    await internal.redirectHandle({ accountId: id, handle: 'retirement_deleted_current', key: key() });

    const unknown = await read('retirement_deleted_unknown');
    expect(await read('retirement_deleted_former')).toEqual(unknown);
    expect(await read('retirement_deleted_current')).toEqual(unknown);

    instant += HANDLE_REDIRECT_TTL_MS + 1;
    for (const handle of ['retirement_deleted_former', 'retirement_deleted_current']) {
      await expect(internal.reserveHandle({ handle, accountId: other, key: key() })).rejects.toBeInstanceOf(
        LifecycleDeniedError,
      );
    }
  },
);

test.serial('a handle another account claimed under the former policy keeps that owner', async () => {
  instant = Date.now();
  const priorOwner = await person('retirement_prior_claim');
  const currentOwner = await person('retirement_prior_owner');
  await rename(priorOwner, 'retirement_prior_claim', 'retirement_prior_new');

  const oldRoute = handleRoute('retirement_prior_claim');
  const currentRoute = handleRoute('retirement_prior_owner');
  await pool.query(
    `UPDATE access.handle_claim SET account_id=$1, state='active', reserved_until=NULL, former_until=NULL, transaction_id=$2
      WHERE route=$3 AND normalized_handle=$4`,
    [currentOwner, newId(oldRoute), oldRoute, 'retirement_prior_claim'],
  );
  await pool.query(
    `UPDATE access.handle_claim SET state='reserved', reserved_until=now() + interval '30 days',
      former_until=now() + interval '30 days', transaction_id=$1 WHERE route=$2 AND normalized_handle=$3`,
    [newId(currentRoute), currentRoute, 'retirement_prior_owner'],
  );
  await pool.query('UPDATE access.account SET handle=$1 WHERE route=$2 AND account_id=$3', [
    'retirement_prior_claim',
    routeOf(currentOwner),
    currentOwner,
  ]);

  expect(await internal.resolveHandle('retirement_prior_claim')).toEqual({ accountId: currentOwner, redirect: false });
  expect(await read('retirement_prior_claim')).toMatchObject({
    status: 200,
    body: { accounts: [{ id: currentOwner, handle: 'retirement_prior_claim' }] },
  });
});

function handleRoute(handle: string): number {
  return createHash('sha256').update(handle).digest().readUInt16BE(0);
}
