import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { assertGrowthAccessPaths, checkGrowth } from '../support/growth.ts';
import { AXES, JOBS, SCALES, payoutPageGrowthFixture, type PayoutPageFixture } from './support/payout-page-growth.ts';

setDefaultTimeout(360_000);
let f: PayoutPageFixture;
beforeAll(async () => {
  f = await payoutPageGrowthFixture();
}, 360_000);
afterAll(async () => f?.close());

test('native payout statement and line pages stay bounded through current Access as depth and history grow', async () => {
  for (const axis of AXES) {
    for (const job of JOBS) {
      const report = await checkGrowth(f.db, {
        name: `creator payout ${axis}: ${job} through current Access and public continuation`,
        scales: SCALES,
        bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
        indexProbes: 18,
        includeBackends: true,
        repetitions: 1,
        async grow(database, scale, previous) {
          await f.grow(database, axis, scale, previous, job);
        },
        async warmup() {
          await f.evidence(job, axis);
        },
        async operation() {
          await f.operate(job, axis);
        },
      });
      expect(report.samples.map(({ scale }) => scale)).toEqual([...SCALES]);
      const relations = [
        ...new Set(
          report.samples.flatMap(({ repetitions }) => repetitions.flatMap(({ relations }) => Object.keys(relations))),
        ),
      ];
      assertGrowthAccessPaths(report.name, report.samples, relations);
      for (const sample of report.samples) {
        expect(sample.cost.plans).toBeGreaterThan(0);
        for (const cost of sample.repetitions) {
          if (axis === 'selected statement lines')
            expect(cost.relations['commerce.royalty_line']?.sequentialScans ?? 0).toBe(0);
          else expect(cost.relations['commerce.payout_statement']?.sequentialScans ?? 0).toBe(0);
        }
      }
    }
  }
}, 1_800_000);
