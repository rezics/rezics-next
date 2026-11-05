import { expect, test } from 'bun:test';
import { publicCollectionDiscoverySource } from '../../src/library/collection-discovery-source.ts';
import { compareCollectionDiscoveryOperands } from '../../src/search/collection-discovery.ts';
import { routeOf, partitionOf } from '../../src/route/route.ts';
import { createFollowCountsDriver, type NativeFollowCountsDriver } from './support/follow-counts-driver.ts';

test('native public popularity follows current aggregate changes and identity ties', async () => {
  const driver: NativeFollowCountsDriver = await createFollowCountsDriver();
  try {
    const first = await driver.fixture('collection');
    const second = await driver.additionalOutgoing(first.follower);
    const source = publicCollectionDiscoverySource({ pool: driver.world.native.pool });
    async function popular(id: string) {
      const route = routeOf(id)!;
      const snapshot = await source.read(partitionOf(route), [{ route, id }], {
        popularity: true,
        order: 'popularity',
      });
      if (snapshot.status !== 'available') throw new Error('Native Collection source is unavailable');
      const item = snapshot.items[0];
      if (item?.status !== 'indexable') throw new Error('Current public Collection is not indexable');
      expect(snapshot.stamp.followCountHealth).toBeDefined();
      if (!item.value.operands.popularity) throw new Error('Native popularity operand is unavailable');
      return item.value;
    }
    async function reconcileAndRead(target: typeof first.target, expected: number) {
      await driver.reconcile(first.follower, target);
      const response = await driver.request(first.manager.credential, `/v1/followCounts/collection/${target.targetId}`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ followerCount: expected });
      return popular(target.targetId);
    }

    const initial = await reconcileAndRead(first.target, 0);
    expect(initial.operands.popularity).toEqual({ followers: '0' });
    const followed = await driver.request(first.follower.credential, `/v1/follows/${first.target.targetId}`, {
      method: 'PUT',
      headers: { 'Idempotency-Key': JSON.stringify(crypto.randomUUID()) },
    });
    expect(followed.status).toBe(200);
    const firstPopular = await reconcileAndRead(first.target, 1);

    const secondPopular = await reconcileAndRead(second, 1);
    const toRanked = (value: typeof firstPopular) => ({
      key: value.key,
      operand: {
        id: value.key.id,
        presentationKind: value.operands.presentationKind,
        curator: { state: 'unavailable' as const, reason: 'deidentified' as const },
        subjectMembership: null,
        popularity: value.operands.popularity,
        recency: value.operands.recency,
        eligible: { presentationKind: null, curator: null, subject: null },
      },
    });
    const tie = [toRanked(firstPopular), toRanked(secondPopular)].toSorted((a, b) =>
      compareCollectionDiscoveryOperands(a, b, 'popularity'),
    );
    expect(tie.map(({ key }) => key.id)).toEqual(
      [firstPopular.key, secondPopular.key]
        .toSorted((a, b) => a.route - b.route || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map(({ id }) => id),
    );

    const unfollowed = await driver.request(first.follower.credential, `/v1/follows/${first.target.targetId}`, {
      method: 'DELETE',
      headers: { 'Idempotency-Key': JSON.stringify(crypto.randomUUID()) },
    });
    expect(unfollowed.status).toBe(200);
    const firstCurrent = await reconcileAndRead(first.target, 0);
    const secondCurrent = await popular(second.targetId);
    expect(firstCurrent.operands.popularity).toEqual({ followers: '0' });
    expect(secondCurrent.operands.popularity).toEqual({ followers: '1' });
    expect(
      compareCollectionDiscoveryOperands(toRanked(firstCurrent), toRanked(secondCurrent), 'popularity'),
    ).toBeGreaterThan(0);
  } finally {
    await driver.close();
  }
}, 240_000);
