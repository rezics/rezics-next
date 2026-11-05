import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { assertGrowthAccessPaths, checkGrowth } from '../support/growth.ts';
import {
  AXES,
  JOBS,
  PAGE,
  SCALES,
  payoutPageGrowthFixture,
  type PayoutPageFixture,
} from './support/payout-page-growth.ts';

setDefaultTimeout(360_000);
let f: PayoutPageFixture;
beforeAll(async () => {
  f = await payoutPageGrowthFixture();
}, 360_000);
afterAll(async () => f?.close());

test('native payout statement and line pages stay bounded through current Access as depth and history grow', async () => {
  for (const axis of AXES) {
    const relation = axis === 'selected statement lines' ? 'commerce.royalty_line' : 'commerce.payout_statement';
    const report = await checkGrowth(f.db, {
      name: `creator payout ${axis} through current Access and public continuation`,
      scales: SCALES,
      bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
      indexProbes: 18,
      includeBackends: true,
      repetitions: 1,
      async grow(database, scale, previous) {
        await f.grow(database, axis, scale, previous);
      },
      async warmup() {
        for (const job of JOBS) await f.evidence(job, axis);
      },
      async operation() {
        for (const job of JOBS) await f.operate(job, axis);
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([...SCALES]);
    expect(report.verdicts.statements.outcome).toBe('compatible');
    expect(report.verdicts.rows.outcome).toBe('compatible');
    expect(report.verdicts.blocks.outcome).toBe('compatible');
    const relations = [
      ...new Set(
        report.samples.flatMap(({ repetitions }) => repetitions.flatMap(({ relations }) => Object.keys(relations))),
      ),
    ];
    assertGrowthAccessPaths(report.name, report.samples, relations);
    for (const sample of report.samples) {
      expect(sample.cost.plans).toBeGreaterThan(0);
      for (const cost of sample.repetitions) {
        expect(cost.relations[relation]?.sequentialScans ?? 0).toBe(0);
        expect(cost.relations[relation]?.rows).toBe((PAGE + 1) * 2);
      }
    }
  }
}, 1_800_000);
