process.env.CONTENT_MEDIA_DRIVER = new URL('./media-driver.ts', import.meta.url).href;

await import('../../../../specs/content-media-outcomes.test.ts');

const { test, expect } = await import('bun:test');
const { checkGrowth, openGrowthDatabase } = await import('../support/growth.ts');
const { currentMediaScenario } = await import('./media-driver.ts');
const { mediaGrowthFixture } = await import('./support/media-fixtures.ts');

test('media requests and jobs obey the three-scale bound with native PostgreSQL plans', async () => {
  const { system, anchors } = currentMediaScenario();
  const db = await openGrowthDatabase(system.database.pool.options.connectionString);
  try {
    const fixture = await mediaGrowthFixture(system, db, anchors);
    try {
      // One real unmeasured run initializes native result-type/catalogue caches.
      // Fresh keys still apply effects at every measured scale; five author
      // reservations including setup stay within the production upload budget.
      await fixture.grow(db, 0, 0);
      await fixture.operation(db, 0, -1);
      const report = await checkGrowth(db, {
        name: 'Media HTTP and trusted jobs with fixed bytes, references, lineage and changed set',
        scales: [32, 256, 2048],
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        repetitions: 1,
        warmups: 0,
        grow: fixture.grow,
        operation: fixture.operation,
      });
      expect(report.samples.map((sample) => sample.scale)).toEqual([32, 256, 2048]);
      for (const { cost } of report.samples) {
        expect(cost.rows).toBeGreaterThan(0);
        expect(cost.blocks).toBeGreaterThan(0);
        expect(cost.statements).toBeGreaterThan(0);
      }
      fixture.varyChangedSet();
      const changed = await checkGrowth(db, {
        name: 'Media collection intentional changed rows and source bytes with fixed unrelated population',
        scales: [1, 4, 16],
        bounds: { rows: 'linear', statements: 'linear', blocks: 'linear' },
        repetitions: 1,
        warmups: 0,
        grow: fixture.grow,
        operation: fixture.collectChanged,
      });
      await Bun.write(
        new URL('../../../../.temp/media-growth-report.json', import.meta.url),
        JSON.stringify({ unrelated: report, changed }),
      );
      console.info('Media GrowthReport', JSON.stringify(report));
      console.info('Media changed-set GrowthReport', JSON.stringify(changed));
    } finally {
      await fixture.close();
    }
  } finally {
    await db.close();
  }
});
