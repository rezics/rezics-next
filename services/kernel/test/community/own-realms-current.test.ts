import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { Compile } from 'typebox/compile';
import { ownRealmsResponseSchema } from '../../src/community/schemas.ts';
import {
  closeCommunityDrivers,
  communityFixtureRuntime,
  createCommunityDriver,
  queryCommunityDatabase,
} from './community-driver.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { createRealmViewerObservation } from '../../src/community/own-realms-viewer.ts';
import { REALM_OWNER_ROLE } from '../../src/access/realm-ownership.ts';
import type { Account, CommunityDriver, Fixture } from '../../../../specs/community-driver.ts';
import { routeOf } from '../../src/route/route.ts';

let driver: CommunityDriver;
let fixture: Fixture;
beforeAll(async () => {
  driver = await createCommunityDriver();
  fixture = await driver.provision();
}, 120_000);
afterAll(async () => {
  await closeCommunityDrivers();
});

const key = () => JSON.stringify(crypto.randomUUID());
async function grantOwner(realmId: string, accountId: string) {
  const result = await driver.request({
    actor: fixture.owner,
    method: 'POST',
    path: '/v1/roleGrants',
    key: key(),
    body: {
      resource: { route: routeOf(realmId)!, id: realmId },
      subject: { kind: 'account', id: accountId },
      role: REALM_OWNER_ROLE,
      valid: '(,)',
    },
  });
  expect(result.status).toBe(201);
  await driver.settle();
}
async function inventory(actor: Account) {
  // Exercise the installed generated response against the production handler.
  const client = createKernelClient('https://community.test', {
    fetch: Object.assign(
      async (input: URL | RequestInfo) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        return driver.request({
          actor,
          method: 'GET',
          path: url.pathname + url.search,
        });
      },
      { preconnect: async () => {} },
    ),
  });
  const result = await client.me.realms.get();
  expect(result.status).toBe(200);
  if (!result.data) throw new Error(`Inventory failed: ${JSON.stringify(result.error)}`);
  if (!Compile(ownRealmsResponseSchema).Check(result.data))
    throw new Error('Inventory does not match its closed schema');
  return result.data;
}

test('current native identity and presentation follow membership completion and revisions', async () => {
  const spaceResponse = await driver.request({
    actor: fixture.owner,
    method: 'POST',
    path: '/v1/spaces',
    key: key(),
    body: { title: 'Inventory host' },
  });
  expect(spaceResponse.status).toBe(201);
  const { space } = await spaceResponse.json();
  const created = await driver.request({
    actor: fixture.owner,
    method: 'POST',
    path: '/v1/realms',
    key: key(),
    body: {
      spaceId: space.spaceId,
      title: 'Current community',
      summary: 'Current description',
      visibility: 'public',
      contextId: fixture.contextId,
    },
  });
  expect(created.status).toBe(201);
  const { realm } = await created.json();
  const membership = `/v1/realms/${realm.realmId}/membership`;
  const join = async () => {
    expect(
      (
        await driver.request({
          actor: fixture.member,
          method: 'POST',
          path: membership,
          key: key(),
        })
      ).status,
    ).toBe(202);
    await driver.settle();
  };
  await join();
  const first = (await inventory(fixture.member)).items.find((item) => item.realmId === realm.realmId)!;
  expect(first).toMatchObject({
    name: 'Current community',
    role: 'member',
    current: {
      description: 'Current description',
      avatar: { state: 'none', value: null },
      banner: { state: 'none', value: null },
      destination: { kind: 'realm', realmId: realm.realmId },
      spaceId: space.spaceId,
      viewer: { membership: { state: 'member' }, participation: 'allowed' },
      actions: {
        state: 'current',
        enter: { state: 'available', method: 'GET', expectedStatus: 200 },
        manage: { state: 'prohibited', reason: 'not_authorized' },
        leave: {
          state: 'available',
          method: 'DELETE',
          path: membership,
          expectedStatus: 202,
        },
      },
    },
  });
  expect(first.realmId).not.toBe(first.current.spaceId);
  expect((await inventory(fixture.owner)).items.some((item) => item.realmId === realm.realmId)).toBe(false);
  const updated = await driver.request({
    actor: fixture.owner,
    method: 'PATCH',
    path: `/v1/realms/${realm.realmId}`,
    key: key(),
    ifMatch: JSON.stringify(realm.headRevisionId),
    body: { title: 'Renamed community', summary: 'New description' },
  });
  expect(updated.status).toBe(200);
  const second = (await inventory(fixture.member)).items.find((item) => item.realmId === realm.realmId)!;
  expect(second.name).toBe('Renamed community');
  expect(second.current.description).toBe('New description');
  const advice = second.current.actions.leave;
  if (advice.state !== 'available' || advice.method !== 'DELETE') throw new Error('Native leave unavailable');
  const leave = await driver.request({
    actor: fixture.member,
    method: advice.method,
    path: advice.path,
  });
  expect(leave.status).toBe(202);
  await driver.settle();
  expect((await inventory(fixture.member)).items.some((item) => item.realmId === realm.realmId)).toBe(false);
  await join();
  const rejoined = (await inventory(fixture.member)).items.find((item) => item.realmId === realm.realmId)!;
  expect(rejoined.current.viewer.membership.since).not.toBe(first.current.viewer.membership.since);
  expect(rejoined.current.viewer.membership.reservationId).not.toBe(first.current.viewer.membership.reservationId);
  expect(rejoined.current.viewer.membership.transactionId).not.toBe(first.current.viewer.membership.transactionId);
  expect(rejoined.current.actions.leave.state).toBe('available');

  // A revision between the locating read and first advice round cannot become
  // the original witness, even for an independent assembler without a selection.
  const { system } = communityFixtureRuntime();
  const deadline = Date.now() + 30_000;
  const actor = await system.access.authenticate(fixture.member.bearer, {
    pool: system.database.pool,
    deadline,
  });
  let changed = false;
  const access = deriveAccess(system.access, {
    async prepare(viewer, action, resource, context) {
      if (action === 'realm:manage' && !changed) {
        changed = true;
        expect(
          (
            await driver.request({
              actor: fixture.owner,
              method: 'PATCH',
              path: `/v1/realms/${realm.realmId}`,
              key: key(),
              ifMatch: updated.headers.get('etag')!,
              body: { summary: 'Changed during observation' },
            })
          ).status,
        ).toBe(200);
      }
      return system.access.prepare!(viewer, action, resource, context);
    },
  });
  await expect(
    createRealmViewerObservation({ pool: system.database.pool, access })({
      actor,
      realmId: realm.realmId,
      deadline,
    }),
  ).rejects.toMatchObject({ code: 'transaction_retry_exhausted' });
  expect(changed).toBe(true);

  // Management is admitted by the actual native action, never by member status.
  expect(
    (
      await driver.request({
        actor: fixture.owner,
        method: 'POST',
        path: membership,
        key: key(),
      })
    ).status,
  ).toBe(202);
  await driver.settle();
  const owned = (await inventory(fixture.owner)).items.find((item) => item.realmId === realm.realmId)!;
  const manage = owned.current.actions.manage;
  expect(manage.state).toBe('available');
  if (manage.state !== 'available' || manage.method !== 'GET') throw new Error('Native management unavailable');
  expect(
    (
      await driver.request({
        actor: fixture.owner,
        method: manage.method,
        path: manage.path,
      })
    ).status,
  ).toBe(200);
  expect(JSON.parse(JSON.stringify(owned.current.actions.leave))).toEqual({
    state: 'unavailable',
    reason: 'last_explicit_holder',
  });
  expect(
    (
      await driver.request({
        actor: fixture.owner,
        method: 'DELETE',
        path: membership,
      })
    ).status,
  ).toBe(409);
  await grantOwner(realm.realmId, fixture.member.id);
  const permitted = (await inventory(fixture.owner)).items.find((item) => item.realmId === realm.realmId)!;
  expect(permitted.current.actions.leave).toMatchObject({
    state: 'available',
    method: 'DELETE',
    path: membership,
    expectedStatus: 202,
  });
  const leaveAdvice = permitted.current.actions.leave;
  if (leaveAdvice.state !== 'available' || leaveAdvice.method !== 'DELETE')
    throw new Error('Permitted owner leave advice is unavailable');
  const leaveIntent = { actor: fixture.owner, method: leaveAdvice.method, path: leaveAdvice.path, key: key() };
  expect((await driver.request(leaveIntent)).status).toBe(202);
  await driver.settle();
  expect((await inventory(fixture.owner)).items.some((item) => item.realmId === realm.realmId)).toBe(false);
  expect((await driver.request(leaveIntent)).status).toBe(202);
  expect((await driver.commandEvidence(fixture.owner, leaveIntent.key)).receipts).toHaveLength(1);
  expect((await inventory(fixture.outsider)).items).toEqual([]);

  const lifecycle = await driver.request({
    actor: fixture.owner,
    method: 'GET',
    path: `/v1/spaces/${space.spaceId}/lifecycle`,
  });
  expect(lifecycle.status).toBe(200);
  const { container } = await lifecycle.json();
  const removed = await driver.request({
    actor: fixture.owner,
    method: 'POST',
    path: `/v1/spaces/${space.spaceId}/removal`,
    key: key(),
    ifMatch: JSON.stringify(container.headRevisionId),
    body: {
      expectedVersion: container.version,
      reason: 'Inventory source removed',
    },
  });
  expect(removed.status).toBe(200);
  expect((await inventory(fixture.member)).items.some((item) => item.realmId === realm.realmId)).toBe(false);
}, 120_000);

test('an unfinished inverse cut cannot certify an empty inventory and retry recovers', async () => {
  const account = fixture.outsider;
  expect((await inventory(account)).items).toEqual([]);
  const setComplete = (complete: boolean) =>
    queryCommunityDatabase(
      'UPDATE access.account SET membership_inverse_complete=$3 WHERE route=$1 AND account_id=$2',
      [routeOf(account.id), account.id, complete],
    );
  await setComplete(false);
  try {
    const result = await driver.request({
      actor: account,
      method: 'GET',
      path: '/v1/me/realms',
    });
    expect(result.status).toBe(503);
    expect((await result.json()).code).toBe('dependency_unavailable');
  } finally {
    await setComplete(true);
  }
  expect((await inventory(account)).items).toEqual([]);
});

test('revoked native account cannot retain inventory actions or continuation', async () => {
  const isolated = await driver.provision();
  expect((await driver.suspend(isolated.member)).status).toBe(200);
  const response = await driver.request({
    actor: isolated.member,
    method: 'GET',
    path: '/v1/me/realms',
  });
  expect(response.status).not.toBe(200);
  const body = await response.json();
  expect(body.items).toBeUndefined();
  expect(body.next).toBeUndefined();
});
