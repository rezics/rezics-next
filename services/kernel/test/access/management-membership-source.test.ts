import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AUTH_MANAGEMENT_CLIENT_ID, AUTH_MANAGEMENT_SCOPES } from '@rezics/auth-contract';
import { createPool } from '../../src/database/pool.ts';
import { newId, routeOf } from '../../src/route/route.ts';
await import('reylo/register');
const { cookies, nativeFixture, password, issuer } = await import('./native-account-bindings-fixture.ts');
const { readOrganizationMembershipCommandState } = await import('../../src/access/management-membership-source.ts');
const { createManagementRead } = await import('../../src/access/account-management.ts');

const pool = createPool(process.env.DATABASE_URL!);
let f: Awaited<ReturnType<typeof nativeFixture>>;
beforeAll(async () => {
  f = await nativeFixture(pool);
}, 60000);
afterAll(async () => {
  try {
    await f?.close();
  } finally {
    await pool.end();
  }
});
const key = () => Bun.randomUUIDv7();
async function person(name: string) {
  const registered = await f.person(name);
  const signed = await f.request('/signin', {
    email: `${name}@ordinary.test`,
    password,
    client_id: AUTH_MANAGEMENT_CLIENT_ID,
    scope: [...AUTH_MANAGEMENT_SCOPES.membership],
  });
  expect(signed.status).toBe(200);
  const headers = cookies(signed);
  const issued = await f.request('/token', {}, headers);
  expect(issued.status).toBe(200);
  const { access_token } = (await issued.json()) as { access_token: string };
  return { accountId: registered.accountId, headers, bearer: access_token };
}
async function context(human: Awaited<ReturnType<typeof person>>) {
  const deadline = Date.now() + 10000;
  return { actor: await f.access.authenticate(human.bearer, { pool, deadline }), deadline };
}
function point(
  human: Awaited<ReturnType<typeof person>>,
  selection: { organizationId: string; memberAccountId: string },
  extra = {},
) {
  return f.host.handler(
    new Request(`${issuer}/account-management/organizations/member`, {
      method: 'POST',
      headers: { origin: issuer, cookie: human.headers.get('cookie')!, 'content-type': 'application/json' },
      body: JSON.stringify({ ...selection, ...extra }),
    }),
  );
}

test('Resolve native membership reservation for an exact selected member preserves exact current native authority target privacy and immutable operation readback', async () => {
  const owner = await person('point_owner');
  const member = await person('point_member');
  const outsider = await person('point_outsider');
  const organizationId = newId(0x9421);
  const ownerHold = await f.bindings.internalLifecycle.reserveCoordination({
    accountId: owner.accountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: key(),
  });
  await f.bindings.internalLifecycle.createOrganization({
    organizationId,
    ownerAccountId: owner.accountId,
    ownerReservationId: ownerHold.value.reservationId,
    key: key(),
  });
  const selected = { organizationId, memberAccountId: member.accountId };
  const empty = await point(owner, selected);
  expect(empty.status).toBe(200);
  expect(await empty.json()).toEqual({ ...selected, membership: null });
  const held = await f.bindings.internalLifecycle.reserveCoordination({
    accountId: member.accountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: key(),
  });
  const descriptor = Object.freeze({
    ...selected,
    reservationId: held.value.reservationId,
    role: 'member' as const,
    key: key(),
  });
  await f.bindings.lifecycle.setMembership(await context(owner), descriptor);
  const response = await point(owner, selected);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(await response.json()).toEqual({
    ...selected,
    membership: { role: 'member', reservationId: descriptor.reservationId },
  });
  expect((await point(outsider, selected)).status).toBe(403);
  expect((await point(member, { organizationId, memberAccountId: owner.accountId })).status).toBe(403);
  expect((await point(owner, selected, { role: 'owner' })).status).toBe(400);
  // The separate generic read remains denied; this point does not mint its scopes.
  const ownerContext = await context(owner);
  await expect(
    createManagementRead(
      { pool, access: () => f.access, tokens: f.referenceKeys, clock: () => new Date() },
      ownerContext.actor,
      ownerContext.deadline,
    ),
  ).rejects.toThrow();
  await expect(
    readOrganizationMembershipCommandState(
      { pool, access: f.access },
      ownerContext.actor,
      { organizationId: owner.accountId, memberAccountId: member.accountId },
      ownerContext,
    ),
  ).rejects.toThrow();
  // Removing the final owner still fails in the command, despite readable metadata.
  await expect(
    f.bindings.lifecycle.setMembership(await context(owner), {
      organizationId,
      memberAccountId: owner.accountId,
      reservationId: ownerHold.value.reservationId,
      role: null,
      key: key(),
    }),
  ).rejects.toThrow();
  await pool.query('UPDATE access.account SET membership_inverse_complete=false WHERE route=$1 AND account_id=$2', [
    routeOf(member.accountId),
    member.accountId,
  ]);
  try {
    expect((await point(owner, selected)).status).toBe(503);
  } finally {
    await pool.query('UPDATE access.account SET membership_inverse_complete=true WHERE route=$1 AND account_id=$2', [
      routeOf(member.accountId),
      member.accountId,
    ]);
  }
  const removal = Object.freeze({ ...descriptor, role: null, key: key() });
  await f.bindings.lifecycle.setMembership(await context(owner), removal);
  expect(Object.isFrozen(removal)).toBe(true);
  expect(descriptor.role).toBe('member');
  const readback = await point(owner, selected);
  expect(readback.status).toBe(200);
  expect(await readback.json()).toEqual({ ...selected, membership: null });
  // Replay does not synthesize current membership from the old command receipt.
  await f.bindings.lifecycle.setMembership(await context(owner), descriptor);
  expect(await (await point(owner, selected)).json()).toEqual({ ...selected, membership: null });
}, 60000);
