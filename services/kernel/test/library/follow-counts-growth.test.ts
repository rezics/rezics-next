import { expect, test } from 'bun:test';
import { assertGrowthAccessPaths, checkGrowth } from '../support/growth.ts';
import { createFollowCountsDriver } from './support/follow-counts-driver.ts';

for (const axis of ['unrelated_followers', 'unrelated_targets', 'history', 'target_followers'] as const) {
  test(`native Follow target and own outgoing reads retain original growth axis ${axis}`, async () => {
    const driver = await createFollowCountsDriver();
    try {
      const fixture = await driver.fixture('collection');
      const response = await driver.request(fixture.follower.credential, `/v1/follows/${fixture.target.targetId}`, {
        method: 'PUT',
        headers: { 'Idempotency-Key': JSON.stringify(crypto.randomUUID()) },
      });
      expect(response.status).toBe(200);
      await driver.reconcile(fixture.follower, fixture.target);
      const report = await checkGrowth(driver.world.native.growth, {
        name: `Follow native fixed target and outgoing reads ${axis}`,
        scales: [1, 4, 16],
        bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
        includeBackends: true,
        async grow(_db, scale) {
          await driver.seed(fixture, scale, axis);
        },
        async operation(_db, scale) {
          const target = await driver.request(
            fixture.manager.credential,
            `/v1/followCounts/${fixture.target.targetType}/${fixture.target.targetId}`,
          );
          expect(target.status).toBe(200);
          expect(await target.json()).toEqual({
            ...fixture.target,
            followerCount: axis === 'target_followers' ? 1 + 128 * scale : 1,
          });
          const outgoing = await driver.request(fixture.follower.credential, '/v1/followCounts/outgoing');
          expect(outgoing.status).toBe(200);
          expect(await outgoing.json()).toEqual({ followingCount: 1 });
        },
      });
      expect(report.samples.map(({ scale }) => scale)).toEqual([1, 4, 16]);
      const relations = [
        ...new Set(
          report.samples.flatMap(({ repetitions }) => repetitions.flatMap(({ relations }) => Object.keys(relations))),
        ),
      ];
      assertGrowthAccessPaths(report.name, report.samples, relations);
      const first = report.samples[0]!.cost;
      for (const sample of report.samples) {
        expect(sample.cost.plans).toBeGreaterThan(0);
        expect(sample.cost.statements).toBe(first.statements);
        expect(sample.cost.rows).toBeLessThanOrEqual(first.rows + 8);
        expect(sample.cost.blocks).toBeLessThanOrEqual(first.blocks + 64 * Math.log2(16));
      }
    } finally {
      await driver.close();
    }
  }, 240_000);
}
