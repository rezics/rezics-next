import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { Compile } from 'typebox/compile';
import { ownRealmsResponseSchema } from '../../src/community/schemas.ts';
import { closeCommunityDrivers, createCommunityDriver, queryCommunityDatabase } from './community-driver.ts';
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
async function inventory(actor: Account) {
  // Exercise the installed generated response against the production handler.
  const client = createKernelClient('https://community.test', {
    fetch: async (input) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return driver.request({ actor, method: 'GET', path: url.pathname + url.search });
    },
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
    expect((await driver.request({ actor: fixture.member, method: 'POST', path: membership, key: key() })).status).toBe(
      202,
    );
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
      actions: { state: 'unavailable' },
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
  const leave = await driver.request({ actor: fixture.member, method: 'DELETE', path: membership });
  expect(leave.status).toBe(202);
  await driver.settle();
  expect((await inventory(fixture.member)).items.some((item) => item.realmId === realm.realmId)).toBe(false);
  await join();
  const rejoined = (await inventory(fixture.member)).items.find((item) => item.realmId === realm.realmId)!;
  expect(rejoined.current.viewer.membership.since).not.toBe(first.current.viewer.membership.since);
  expect(rejoined.current.actions).toEqual({ state: 'unavailable' });
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
    body: { expectedVersion: container.version, reason: 'Inventory source removed' },
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
    const result = await driver.request({ actor: account, method: 'GET', path: '/v1/me/realms' });
    expect(result.status).toBe(503);
    expect((await result.json()).code).toBe('dependency_unavailable');
  } finally {
    await setComplete(true);
  }
  expect((await inventory(account)).items).toEqual([]);
});
