import { afterAll, beforeAll, expect, test } from 'bun:test';
import { AUTH_MANAGEMENT_CLIENT_ID, AUTH_MANAGEMENT_SCOPES } from '@rezics/auth-contract';
import { createPool } from '../../src/database/pool.ts';
import { newId } from '../../src/route/route.ts';
await import('reylo/register');
const { cookies, nativeFixture, password, issuer } = await import('./native-account-bindings-fixture.ts');

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
  const token = await f.request('/token', {}, headers);
  expect(token.status).toBe(200);
  const { access_token: bearer } = (await token.json()) as { access_token: string };
  return { ...registered, headers, bearer };
}
async function context(human: Awaited<ReturnType<typeof person>>) {
  const deadline = Date.now() + 10000;
  return { actor: await f.access.authenticate(human.bearer, { pool, deadline }), deadline };
}
async function add(
  owner: Awaited<ReturnType<typeof person>>,
  member: Awaited<ReturnType<typeof person>>,
  organizationId: string,
  role: 'owner' | 'member',
) {
  const held = await f.bindings.internalLifecycle.reserveCoordination({
    accountId: member.accountId,
    relatedAccountId: organizationId,
    purpose: 'membership',
    key: key(),
  });
  await f.bindings.lifecycle.setMembership(await context(owner), {
    organizationId,
    memberAccountId: member.accountId,
    reservationId: held.value.reservationId,
    role,
    key: key(),
  });
  return held.value.reservationId;
}
function page(human: Awaited<ReturnType<typeof person>>, organizationId: string, cursor?: string) {
  return f.host.handler(
    new Request(`${issuer}/account-management/organizations/page`, {
      method: 'POST',
      headers: { origin: issuer, cookie: human.headers.get('cookie')!, 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId, ...(cursor ? { cursor } : {}) }),
    }),
  );
}
function selected(human: Awaited<ReturnType<typeof person>>, organizationId: string, memberAccountId: string) {
  return f.host.handler(
    new Request(`${issuer}/account-management/organizations/member`, {
      method: 'POST',
      headers: { origin: issuer, cookie: human.headers.get('cookie')!, 'content-type': 'application/json' },
      body: JSON.stringify({ organizationId, memberAccountId }),
    }),
  );
}

test('serves a bounded viewer-bound roster, observes current actions and keeps command authorization authoritative', async () => {
  const owner = await person('membership_page_owner');
  const secondOwner = await person('membership_page_second_owner');
  const member = await person('membership_page_member');
  const outsider = await person('membership_page_outsider');
  const organizationId = newId(0x9431);
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
  await add(owner, secondOwner, organizationId, 'owner');
  const reservations = new Map<string, string>();
  reservations.set(member.accountId, await add(owner, member, organizationId, 'member'));
  for (let index = 0; index < 18; index++) {
    const extra = await person(`membership_page_extra_${index}`);
    reservations.set(extra.accountId, await add(owner, extra, organizationId, 'member'));
  }

  const firstResponse = await page(owner, organizationId);
  expect(firstResponse.status).toBe(200);
  expect(firstResponse.headers.get('cache-control')).toBe('private, no-store');
  const first = (await firstResponse.json()) as any;
  expect(first.organizationId).toBe(organizationId);
  expect(first.viewer).toEqual({ accountId: owner.accountId, role: 'owner', leave: 'unavailable' });
  expect(first.members.state).toBe('ready');
  expect(first.members.items).toHaveLength(20);
  expect(first.members.next).toEqual(expect.any(String));
  expect(JSON.stringify(first)).not.toContain('reservationId');
  expect(JSON.stringify(first)).not.toContain('email');
  expect(first.members.items.some((row: any) => row.account?.handle?.startsWith('membership_page_'))).toBe(true);
  expect(
    first.members.items.every((row: any) => row.actions.changeRole === 'allowed' && row.actions.remove === 'allowed'),
  ).toBe(true);

  const secondResponse = await page(owner, organizationId, first.members.next);
  expect(secondResponse.status).toBe(200);
  const second = (await secondResponse.json()) as any;
  expect(second.members.items).toHaveLength(1);
  expect(second.members.next).toBeNull();
  expect((await page(secondOwner, organizationId, first.members.next)).status).toBe(400);
  expect((await page(outsider, organizationId)).status).toBe(403);

  const memberResponse = await page(member, organizationId);
  expect(memberResponse.status).toBe(200);
  const memberPage = (await memberResponse.json()) as any;
  expect(memberPage.viewer).toEqual({ accountId: member.accountId, role: 'member', leave: 'unavailable' });
  expect(memberPage.members.state).toBe('unavailable');

  const selectedOwner = await selected(owner, organizationId, secondOwner.accountId);
  const ownerState = (await selectedOwner.json()) as { membership: { reservationId: string } };
  await f.bindings.lifecycle.setMembership(await context(owner), {
    organizationId,
    memberAccountId: secondOwner.accountId,
    reservationId: ownerState.membership.reservationId,
    role: null,
    key: key(),
  });
  await expect(
    f.bindings.lifecycle.setMembership(await context(secondOwner), {
      organizationId,
      memberAccountId: member.accountId,
      reservationId: reservations.get(member.accountId)!,
      role: 'owner',
      key: key(),
    }),
  ).rejects.toThrow();
  expect((await page(secondOwner, organizationId)).status).toBe(403);

  const current = (await (await page(owner, organizationId)).json()) as any;
  expect(current.members.items.find((row: any) => row.accountId === owner.accountId).actions).toEqual({
    changeRole: 'last-owner',
    remove: 'last-owner',
  });
  const target = current.members.items.find((row: any) => row.role === 'member');
  expect(target.actions).toEqual({ changeRole: 'allowed', remove: 'allowed' });
  const targetState = (await (await selected(owner, organizationId, target.accountId)).json()) as {
    membership: { reservationId: string; role: 'member' };
  };
  await f.bindings.lifecycle.setMembership(await context(owner), {
    organizationId,
    memberAccountId: target.accountId,
    reservationId: targetState.membership.reservationId,
    role: 'owner',
    key: key(),
  });
  const promoted = (await (await page(owner, organizationId)).json()) as any;
  expect(promoted.members.items.find((row: any) => row.accountId === target.accountId).role).toBe('owner');
  const promotedState = (await (await selected(owner, organizationId, target.accountId)).json()) as {
    membership: { reservationId: string; role: 'owner' };
  };
  await f.bindings.lifecycle.setMembership(await context(owner), {
    organizationId,
    memberAccountId: target.accountId,
    reservationId: promotedState.membership.reservationId,
    role: null,
    key: key(),
  });
  const removed = (await (await page(owner, organizationId)).json()) as any;
  expect(removed.members.items.some((row: any) => row.accountId === target.accountId)).toBe(false);
  expect(removed.members.items.find((row: any) => row.accountId === owner.accountId).actions.remove).toBe('last-owner');
}, 120000);
