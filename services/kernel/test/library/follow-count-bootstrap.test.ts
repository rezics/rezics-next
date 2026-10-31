import { afterEach, expect, test } from 'bun:test';
import { bootstrapFollowCountOwner, reconcileFollowCountSource } from '../../src/library/follow-count-source.ts';
import { routeOf } from '../../src/route/route.ts';
import { createFollowCountsDriver, type NativeFollowCountsDriver } from './support/follow-counts-driver.ts';

let driver: NativeFollowCountsDriver | undefined;
afterEach(async () => {
  await driver?.close();
  driver = undefined;
});

test('native bootstrap persists finite 100-key coverage and preserves a newer negative behind its cursor', async () => {
  driver = await createFollowCountsDriver();
  const fixture = await driver.fixture('collection');
  const { world } = driver;
  const deps = { pool: world.native.pool, client: world.native.workClient };
  const targets = [];
  for (let i = 0; i < 101; i++) targets.push(await driver.additionalOutgoing(fixture.follower));
  const page = await bootstrapFollowCountOwner(deps, fixture.follower.accountId);
  expect(page).toEqual({ examined: 100, complete: false });
  const args = [routeOf(fixture.follower.accountId), fixture.follower.accountId];
  const checkpoint = (
    await world.native.reader.query(
      'SELECT bootstrap_upper,bootstrap_after,bootstrap_complete FROM library.follow_count_owner WHERE route=$1 AND account_id=$2',
      args,
    )
  ).rows[0];
  expect(checkpoint.bootstrap_complete).toBe(false);
  expect(checkpoint.bootstrap_after).not.toBeNull();
  const first = targets.toSorted((a, b) => a.targetId.localeCompare(b.targetId))[0]!;
  const response = await driver.request(fixture.follower.credential, `/v1/follows/${first.targetId}`, {
    method: 'DELETE',
    headers: { 'Idempotency-Key': JSON.stringify(crypto.randomUUID()) },
  });
  expect(response.status).toBe(200);
  const key = { accountId: fixture.follower.accountId, ...first };
  const negative = await reconcileFollowCountSource(deps, key);
  expect(negative?.eligible).toBe(false);
  expect(await bootstrapFollowCountOwner(deps, fixture.follower.accountId)).toEqual({ examined: 1, complete: true });
  expect(await bootstrapFollowCountOwner(deps, fixture.follower.accountId)).toEqual({ examined: 0, complete: true });
  expect(await reconcileFollowCountSource(deps, key)).toEqual(negative);
  const after = (
    await world.native.reader.query(
      'SELECT bootstrap_upper,observed_live_count::text FROM library.follow_count_owner WHERE route=$1 AND account_id=$2',
      args,
    )
  ).rows[0];
  expect(after.bootstrap_upper).toBe(checkpoint.bootstrap_upper);
  expect(after.observed_live_count).toBe('100');
}, 240_000);

test('native capture releases source work and delivery uses current source after explicit withdrawal', async () => {
  driver = await createFollowCountsDriver();
  const fixture = await driver.fixture('collection');
  const target = await driver.additionalOutgoing(fixture.follower);
  const captured = await driver.capture(fixture.follower, target);
  const response = await driver.request(fixture.follower.credential, `/v1/follows/${target.targetId}`, {
    method: 'DELETE',
    headers: { 'Idempotency-Key': JSON.stringify(crypto.randomUUID()) },
  });
  expect(response.status).toBe(200);
  const { world } = driver;
  const replacement = await reconcileFollowCountSource(
    { pool: world.native.pool, client: world.native.workClient },
    {
      accountId: fixture.follower.accountId,
      ...target,
    },
  );
  expect(replacement?.eligible).toBe(false);
  await driver.deliver(captured);
  const rows = (await driver.inspect(fixture.follower, target)).targetRows;
  expect(
    rows.some(
      ({ relation, row }) =>
        relation === 'library.follow_count_pair' &&
        typeof row === 'object' &&
        row !== null &&
        'eligible' in row &&
        row.eligible === false,
    ),
  ).toBe(true);
}, 240_000);
