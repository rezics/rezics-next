import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { assertGrowthAccessPaths, checkGrowth } from '../support/growth.ts';
import {
  axes,
  entitlementPageGrowth,
  scales,
  type EntitlementPageGrowth,
} from './support/entitlement-page-growth.ts';

setDefaultTimeout(1_800_000);
let world: EntitlementPageGrowth;

beforeAll(async () => {
  world = await entitlementPageGrowth();
}, 360_000);
afterAll(async () => world?.close());

test('native entitlement first, deep and empty pages stay bounded as buyer, peer and foreign histories grow independently', async () => {
  for (const axis of axes) {
    const report = await checkGrowth(world.db, {
      name: `mounted entitlement list ${axis} with current Access, public cursors and empty continuation`,
      scales: [...scales],
      bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      indexProbes: 18,
      includeBackends: true,
      async grow(database, scale, previous) {
        await world.grow(axis, database, scale, previous);
      },
      async warmup() {
        await world.refreshCursors();
        await world.warmupPages();
        await world.assertClosedControls();
      },
      async prepare() {
        await world.refreshCursors();
      },
      async operation() {
        await world.pages();
        await world.controls();
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
    expect(report.verdicts.statements.outcome).toBe('compatible');
    expect(report.verdicts.rows.outcome).toBe('compatible');
    expect(report.verdicts.blocks.outcome).toBe('compatible');
    for (const sample of report.samples)
      for (const cost of sample.repetitions) {
        expect(world.entitlementCost(cost).sequentialScans).toBe(0);
        expect(cost.requestBytes).toBeDefined();
        expect(cost.responseBytes).toBeDefined();
      }
    const relations = [
      ...new Set(
        report.samples.flatMap(({ repetitions }) => repetitions.flatMap(({ relations }) => Object.keys(relations))),
      ),
    ];
    assertGrowthAccessPaths(report.name, report.samples, relations);
  }
}, 1_800_000);
