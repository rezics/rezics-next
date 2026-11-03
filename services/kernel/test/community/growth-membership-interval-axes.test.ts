import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checkGrowth } from '../support/growth.ts';
import { axes, membershipIntervalAxesFixture, outcomes, scales } from './support/growth-membership-interval-axes-fixture.ts';

let fixture: Awaited<ReturnType<typeof membershipIntervalAxesFixture>>;
beforeAll(async () => { fixture = await membershipIntervalAxesFixture(); }, 120_000);
afterAll(async () => fixture?.close());

for (const axis of axes) {
  for (const outcome of outcomes) {
    test(`current interval ${outcome} lookup stays bounded as only ${axis} grow`, async () => {
      await fixture.reset(axis, outcome);
      const report = await checkGrowth(fixture.db, {
        name: `Realm membership interval ${outcome}: ${axis}`,
        scales,
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        slack: { rows: { absolute: 0, relative: 0 } },
        grow: (_db, scale, previous) => fixture.grow(axis, outcome, scale, previous),
        operation: () => fixture.operation(outcome),
      });
      expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
      // Check every measured repetition, including the empty seek, rather than only the medians.
      for (const sample of report.samples) {
        for (const cost of sample.repetitions) {
          const rows = outcome === 'current' ? 1 : 0;
          expect(cost.statements).toBe(1);
          expect(cost.rows).toBe(rows);
          expect(cost.relations['community.realm_member']).toMatchObject({ rows, nodes: 1, sequentialScans: 0 });
          expect(cost.plans).toBe(1);
          expect(cost.catalogStatements).toBe(0);
          expect(cost.controlStatements).toBe(0);
          expect(cost.backgroundStatements ?? 0).toBe(0);
        }
      }
    }, 1_200_000);
  }
}
