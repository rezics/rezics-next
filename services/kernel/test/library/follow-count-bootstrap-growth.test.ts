import { expect, test } from 'bun:test';
import type { Principal } from '../../../../specs/follow-counts-driver.ts';
import { bootstrapFollowCountOwner } from '../../src/library/follow-count-source.ts';
import { routeOf } from '../../src/route/route.ts';
import { assertGrowthAccessPaths, checkGrowth } from '../support/growth.ts';
import { createFollowCountsDriver } from './support/follow-counts-driver.ts';

test('native bootstrap first pages retain bounded work and durable continuation at 128 times 1/4/16 keys', async () => {
  const driver = await createFollowCountsDriver();
  try {
    const fixture = await driver.fixture('collection');
    const { world } = driver;
    const targets: string[] = [];
    let prepared: Principal | undefined;
    async function preparePage(scale: number) {
      const as = await world.native.principal(3840);
      for (const id of targets.slice(0, 128 * scale)) {
        const response = await driver.request(as.credential, `/v1/follows/${id}`, {
          method: 'PUT',
          headers: { 'Idempotency-Key': JSON.stringify(crypto.randomUUID()) },
        });
        expect(response.status).toBe(200);
      }
      return as;
    }
    async function page(as: Principal) {
      const result = await bootstrapFollowCountOwner(
        { pool: world.native.pool, client: world.native.workClient },
        as.accountId,
      );
      expect(result).toEqual({ examined: 100, complete: false });
      const checkpoint = (
        await world.native.pool.query(
          `SELECT bootstrap_upper,bootstrap_after,bootstrap_complete FROM library.follow_count_owner
         WHERE route=$1 AND account_id=$2`,
          [routeOf(as.accountId), as.accountId],
        )
      ).rows[0];
      expect(checkpoint.bootstrap_complete).toBe(false);
      expect(checkpoint.bootstrap_after).not.toBeNull();
      expect(checkpoint.bootstrap_upper).not.toBeNull();
      return result;
    }
    const report = await checkGrowth(world.native.growth, {
      name: 'Follow native bounded bootstrap first page and same-client continuation',
      scales: [1, 4, 16],
      bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
      includeBackends: true,
      attempts: { commands: 1 },
      async grow(_db, scale) {
        while (targets.length < 128 * scale) {
          const response = await driver.request(fixture.manager.credential, '/v1/collections', {
            method: 'POST',
            headers: { 'Idempotency-Key': JSON.stringify(crypto.randomUUID()), 'content-type': 'application/json' },
            body: JSON.stringify({ title: 'Native bootstrap target', visibility: 'public' }),
          });
          expect(response.status).toBe(201);
          targets.push((await response.json()).collection.id);
        }
      },
      async warmup(_db, scale) {
        return page(await preparePage(scale));
      },
      async prepare(_db, scale) {
        prepared = await preparePage(scale);
      },
      async operation() {
        if (!prepared) throw new Error('Native bootstrap page was not prepared');
        return page(prepared);
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([1, 4, 16]);
    assertGrowthAccessPaths(report.name, report.samples, [
      'library.follow',
      'library.follow_count_source',
      'library.follow_count_owner',
    ]);
    for (const sample of report.samples) {
      expect(sample.cost.plans).toBeGreaterThan(0);
      expect(sample.attempts?.commands).toBe(1);
    }
  } finally {
    await driver.close();
  }
}, 240_000);
