import { afterAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { createPool } from '../../src/database/pool.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import {
  createLifecycleCommands,
  createLifecycleInternals,
  LIFECYCLE_ACTIONS,
  LifecycleDeniedError,
  normalizeHandle,
} from '../../src/access/lifecycle.ts';
import { RESERVED_HANDLES } from '../../src/access/handle-policy.ts';
import { readPublicAccountByHandle } from '../../src/access/account-data.ts';
import { admittedAccess, authenticateAccount } from '../support/admitted-access.ts';

const pool = createPool(process.env.DATABASE_URL!);
const access = admittedAccess({ actions: LIFECYCLE_ACTIONS });
const internal = createLifecycleInternals({
  pool,
  access,
  routeKey: new Uint8Array(32).fill(13),
  provisioningEvidence: async () => null,
  recoveryEvidence: async () => null,
});
const commands = createLifecycleCommands({ pool, access });
const key = () => Bun.randomUUIDv7();
afterAll(() => pool.end());

async function account(kind: 'actor' | 'organization' = 'actor', handle: string | null = null) {
  const id = newId(0x2468);
  await pool.query(
    `INSERT INTO access.account(route,account_id,kind,state,handle,transaction_id,membership_inverse_complete)
    VALUES ($1,$2,$3,'active',$4,$2,true)`,
    [routeOf(id), id, kind, handle],
  );
  return id;
}
async function grant(actor: string, target: string, action: string) {
  await pool.query(
    `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
    VALUES ($1,$2,$3,$4,'(,)',$3)`,
    [routeOf(target), target, actor, action],
  );
}
async function context(id: string, scopes = [...LIFECYCLE_ACTIONS.keys()]) {
  const deadline = Date.now() + 10000;
  return {
    deadline,
    actor: await authenticateAccount(
      access,
      { pool, deadline },
      {
        accountId: id,
        clientId: 'handle-policy-client',
        scopes,
      },
    ),
  };
}

test('new claims and renames require 3–64 folded characters and alphanumeric ends without trimming', async () => {
  const id = await account();
  for (const handle of [
    'a',
    'ab',
    'abc_',
    'abc-',
    '_abc',
    '-abc',
    'abc def',
    ' abc',
    'abc ',
    'abc\n',
    'a'.repeat(65),
    'éaa',
  ]) {
    expect(() => normalizeHandle(handle)).toThrow(LifecycleDeniedError);
    await expect(internal.reserveHandle({ accountId: id, handle, key: key() })).rejects.toBeInstanceOf(
      LifecycleDeniedError,
    );
    await expect(
      commands.transitionAccountHandle(await context(id), {
        accountId: id,
        handle,
        expectedHandle: null,
        operationId: key(),
        reservationId: newId(1),
        key: key(),
      }),
    ).rejects.toBeInstanceOf(LifecycleDeniedError);
  }
  for (const handle of ['AbC', 'A_0', '0-1', 'A'.repeat(64)]) {
    expect(normalizeHandle(handle)).toBe(handle.toLowerCase());
    const claim = await internal.reserveHandle({ accountId: id, handle, key: key() });
    expect(claim.value.handle).toBe(handle.toLowerCase());
  }
});

test('existing handles outside the new grammar still resolve to their owner and can be renamed', async () => {
  for (const handle of ['x', 'xy', 'old_', 'old-']) {
    const id = await account('actor', handle);
    const route = createHash('sha256').update(handle).digest().readUInt16BE(0);
    await pool.query(
      `INSERT INTO access.handle_claim(route,normalized_handle,account_id,state,transaction_id,reservation_id)
      VALUES ($1,$2,$3,'active',$3,$4)`,
      [route, handle, id, newId(route)],
    );
    expect(await internal.resolveHandle(handle.toUpperCase())).toEqual({ accountId: id, redirect: false });
    expect((await readPublicAccountByHandle(pool, handle))[0]?.id).toBe(id);
    await grant(id, id, 'account:update');
    const next = `new-${id}`;
    const claim = await internal.reserveHandle({ accountId: id, handle: next, key: key() });
    const transition = {
      accountId: id,
      handle: next,
      expectedHandle: handle,
      operationId: key(),
      reservationId: claim.value.reservationId,
      key: key(),
    };
    await internal.holdHandle(transition);
    await commands.transitionAccountHandle(await context(id), transition);
  }
});

test('all registry entries refuse every unprivileged reservation, regardless of case or account kind', async () => {
  expect(RESERVED_HANDLES).toHaveLength(25);
  for (const kind of ['actor', 'organization'] as const) {
    const id = await account(kind);
    const owner = kind === 'organization' ? await account() : id;
    await grant(owner, id, 'account:manage');
    await grant(owner, id, 'account:update');
    for (const { handle } of RESERVED_HANDLES) {
      for (const spelling of [handle, handle.toUpperCase()]) {
        await expect(internal.reserveHandle({ accountId: id, handle: spelling, key: key() })).rejects.toBeInstanceOf(
          LifecycleDeniedError,
        );
        await expect(
          internal.reserveHandle({ accountId: id, handle: spelling, key: key() }, await context(owner)),
        ).rejects.toBeInstanceOf(LifecycleDeniedError);
      }
    }
  }
});

test('the Global Context exception requires scope and management and persists its audit fact through rename', async () => {
  const staff = await account();
  const unmanaged = await account();
  await grant(staff, PLATFORM_RESOURCE.id, 'account:assign_reserved_handle');
  for (const kind of ['actor', 'organization'] as const) {
    const id = await account(kind);
    await grant(staff, id, 'account:manage');
    await grant(staff, id, 'account:update');
    const handle = kind === 'actor' ? 'AdMiN' : 'OfFiCiAl';
    await expect(
      internal.reserveHandle(
        { accountId: id, handle, key: key() },
        await context(staff, ['account:manage', 'account:update']),
      ),
    ).rejects.toBeInstanceOf(LifecycleDeniedError);
    const claim = await internal.reserveHandle({ accountId: id, handle, key: key() }, await context(staff));
    expect(claim.value).toMatchObject({ handle: handle.toLowerCase(), reservedHandleException: true });
    const receipt = (
      await pool.query('SELECT response,principal_id FROM core.receipt WHERE transaction_id=$1', [claim.transactionId])
    ).rows[0];
    expect(receipt.principal_id).toBe(staff);
    expect(receipt.response).toMatchObject({ reservedHandleException: true });
    const transition = {
      accountId: id,
      handle,
      expectedHandle: null,
      operationId: key(),
      reservationId: claim.value.reservationId,
      key: key(),
    };
    await internal.holdHandle(transition);
    const published = await commands.transitionAccountHandle(await context(staff), transition);
    expect(published.value).toMatchObject({ reservedHandleException: true });
    await internal.finalizeHandleTransition(transition);
    expect(await internal.resolveHandle(handle)).toMatchObject({ accountId: id });
  }
  await expect(
    internal.reserveHandle({ accountId: unmanaged, handle: 'support', key: key() }, await context(staff)),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
  const self = await internal.reserveHandle({ accountId: staff, handle: 'system', key: key() }, await context(staff));
  expect(self.value).toMatchObject({ reservedHandleException: true });
  await pool.query(
    `DELETE FROM access.resource_grant WHERE subject_id=$1 AND action='account:assign_reserved_handle'`,
    [staff],
  );
  await expect(
    internal.reserveHandle({ accountId: staff, handle: 'root', key: key() }, await context(staff)),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
});

test('a reserved-handle grant on an account instead of Global grants no exception', async () => {
  const id = await account();
  await grant(id, id, 'account:assign_reserved_handle');
  await expect(
    internal.reserveHandle({ accountId: id, handle: 'root', key: key() }, await context(id)),
  ).rejects.toBeInstanceOf(LifecycleDeniedError);
});
