import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { assertGrowthAccessPaths, checkGrowth } from '../support/growth.ts';
import { createViewGrowthFixture, VIEW_AXES, VIEW_SCALES } from './support/growth-public-figure-views-fixture.ts';

for (const axis of VIEW_AXES) {
  test(`fixed public figure views remain exact and bounded as unrelated ${axis} grow`, async () => {
    console.info(
      'public figure views source',
      JSON.stringify({
        revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: import.meta.dir, encoding: 'utf8' }).trim(),
        command: 'bun run --cwd services/kernel check test/rating/growth-public-figure-views.test.ts',
        fixture: 'test/rating/support/figure-fixture.ts',
        axis,
      }),
    );
    const fixture = await createViewGrowthFixture();
    try {
      expect(fixture.ids).toHaveLength(4);
      expect(fixture.partitionCount).toBe(3);
      const name = `fixed public figure views under unrelated ${axis} growth`;
      const report = await checkGrowth(fixture.database, {
        name,
        scales: VIEW_SCALES,
        repetitions: 2,
        bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
        grow: (_database, scale, previous) => fixture.grow(axis, scale, previous),
        // Native auto_explain observes the helper, its caller's transaction, and all empty/rejected work.
        // Every warm-up/repetition replays the same fixed selection against the native HTTP baseline.
        operation: () => fixture.read(),
      });
      expect(report.samples.map(({ scale }) => scale)).toEqual([...VIEW_SCALES]);
      const relations = [
        ...new Set(
          report.samples.flatMap(({ repetitions }) => repetitions.flatMap(({ relations }) => Object.keys(relations))),
        ),
      ];
      expect(relations).toEqual(expect.arrayContaining(['rating.question', 'rating.public_figure']));
      assertGrowthAccessPaths(name, report.samples, relations);
      for (const sample of report.samples) {
        expect(sample.repetitions).toHaveLength(2);
        for (const cost of sample.repetitions) {
          const evidence = JSON.stringify({ axis, scale: sample.scale, cost });
          expect(cost.statements, evidence).toBe(2);
          expect(cost.plans, evidence).toBe(2);
          expect(cost.controlStatements, evidence).toBe(2);
          expect(cost.rows, evidence).toBeGreaterThan(0);
          expect(cost.blocks, evidence).toBeGreaterThan(0);
          const figures = Object.entries(cost.relations).filter(([name]) => name.endsWith('public_figure'));
          expect(figures.length, evidence).toBeGreaterThan(0);
          expect(
            figures.reduce((sum, [, value]) => sum + value.rows, 0),
            evidence,
          ).toBeLessThanOrEqual(4);
          for (const [, value] of figures) expect(value.sequentialScans, evidence).toBe(0);
        }
      }
      console.info(
        'public figure views observations',
        JSON.stringify({
          axis,
          selected: [...fixture.expected],
          partitionCount: fixture.partitionCount,
          samples: report.samples,
          verdicts: report.verdicts,
        }),
      );
    } finally {
      await fixture.close();
    }
  }, 600_000);
}
