import { expect, test } from 'bun:test';
import { assertGrowthAccessPaths, checkGrowth } from '../support/growth.ts';
import { countedAxes, createCountedGrowthFixture } from './support/growth-own-votes-counted-fixture.ts';

for (const axis of countedAxes) test(`counted prepare/read/finish has bounded physical work under ${axis} growth`, async () => {
  const f = await createCountedGrowthFixture();
  try {
    const name = `counted own-score ${axis}`;
    const report = await checkGrowth(f.database, {
      name, scales: [256, 1024, 4096], warmups: 1, repetitions: 2, includeBackends: true,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      counted: {
        read: value => value as Awaited<ReturnType<typeof f.operation>>,
        bounds: Object.fromEntries([
          'preparePhases', 'readPhases', 'finishPhases', 'accessPreparations', 'accessEvaluations', 'mappingCollections',
          'poolQueries', 'materializedRows', 'materializedBytes', 'retainedBytes', 'serializedBytes', 'cleanupStatements', 'runnerPhases', 'connections',
        ].map(key => [key, 'constant' as const])),
        limits: { preparePhases: 5, readPhases: 4, finishPhases: 4, cleanupStatements: 2,
          connections: 1, materializedBytes: 4_194_304, retainedBytes: 1_048_576, serializedBytes: 262_144 },
      },
      grow: (_db, scale, previous) => f.grow(axis, scale, previous),
      operation: () => f.operation(),
    });
    expect(report.samples.map(sample => sample.scale)).toEqual([256, 1024, 4096]);
    const relations = [...new Set(report.samples.flatMap(sample => sample.repetitions.flatMap(cost => Object.keys(cost.relations))))];
    expect(relations).toEqual(expect.arrayContaining(['rating.vote', 'semantic.redirect', 'semantic.identity_epoch_mapping',
      'semantic.identity_epoch_group', 'access.account', 'core.partition']));
    // Keep the harness's catalogue classifier, invisible-MVCC exclusion and asynchronous attribution intact.
    assertGrowthAccessPaths(name, report.samples, relations);
    for (const sample of report.samples) {
      expect(sample.counted!.accessPreparations!.value).toBeGreaterThan(0);
      expect(sample.counted!.accessEvaluations!.value).toBeGreaterThan(0);
      expect(sample.counted!.cleanupStatements!.value).toBe(2);
      for (const cost of sample.repetitions) {
        expect(cost.rows).toBeGreaterThan(0);
        expect(cost.controlStatements).toBeGreaterThan(0);
        expect(cost.requestBytes).toBeGreaterThan(0);
        expect(cost.responseBytes).toBeGreaterThan(0);
      }
    }
  } finally {
    await f.close();
  }
}, 900_000);
