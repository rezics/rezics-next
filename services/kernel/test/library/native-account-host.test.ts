import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readErasureStatus } from '../../src/access/erasure.ts';
import { createFollowCountsDriver, type NativeFollowCountsDriver } from './support/follow-counts-driver.ts';
import { deleteAccount } from './support/native-conformance.ts';

let driver: NativeFollowCountsDriver;
beforeAll(async () => {
  driver = await createFollowCountsDriver();
}, 240000);
afterAll(async () => {
  await driver?.close();
});

test('native human, operator and organization authority resolves distinct graph subjects privately', async () => {
  for (const kind of ['person', 'automated', 'organization'] as const) {
    const fixture = await driver.fixture(kind);
    expect(fixture.targetAccountId).not.toBe(fixture.target.targetId);
    if (kind === 'person') expect(fixture.manager.accountId).toBe(fixture.targetAccountId!);
    expect(
      (
        await driver.request(fixture.follower.credential, `/v1/follows/${fixture.target.targetId}`, {
          method: 'PUT',
          headers: { 'Idempotency-Key': crypto.randomUUID() },
        })
      ).status,
    ).toBe(200);
    await driver.reconcile(fixture.follower, fixture.target);
    const path = `/v1/followCounts/subject/${fixture.target.targetId}`;
    for (const principal of [fixture.manager, fixture.granted]) {
      const response = await driver.request(principal.credential, path);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toEqual({
        ...fixture.target,
        followerCount: 1,
      });
    }
    await driver.revokeManagement(fixture);
    for (const [credential, status, code] of [
      [null, 401, 'authentication_required'],
      [fixture.suspended.credential, 401, 'invalid_credentials'],
      [fixture.noScope.credential, 403, 'forbidden'],
      [fixture.granted.credential, 404, 'not_found'],
    ] as const) {
      const response = await driver.request(credential, path);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ code });
    }
    await driver.accountState(fixture.targetAccountId!, 'deleted');
    expect(await readErasureStatus(driver.world.native.reader, fixture.targetAccountId!)).toMatchObject({
      state: 'pending',
      completedAt: null,
    });
    expect((await driver.request(fixture.manager.credential, path)).status).toBe(
      kind === 'person' ? 401 : 404,
    );
  }
}, 240000);

test('Library deletion returns the exact committed T while shared completion stays pending', async () => {
  const response = await deleteAccount(driver.world, 'other');
  expect(response.status).toBe(200);
  const receipt = await response.json();
  const status = await readErasureStatus(driver.world.native.reader, driver.world.accounts.other.id);
  expect(receipt).toEqual({
    accountId: driver.world.accounts.other.id,
    at: status!.at,
  });
  expect(status).toMatchObject({ state: 'pending', completedAt: null });
}, 240000);
