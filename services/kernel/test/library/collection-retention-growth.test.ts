import { expect, test } from 'bun:test';
import { pageDueCollectionDeletions } from '../../src/library/collection-retention.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { seedCollectionGrowthPopulation } from './support/collection-growth-population.ts';
import { createProfileEntryFixture } from './support/profile-entry-fixture.ts';

// Uses the shared native growth harness; no local classifier or new runtime.
test('Collection due partition seek stays bounded as unrelated owner, Collection and member populations grow', async () => {
  const db = await openGrowthDatabase();
  const f = await createProfileEntryFixture({ pool: db.pool });
  try {
    const subjectId = await f.createSubject('game');
    const report = await checkGrowth(db, {
      name: 'Collection due partition seek',
      scales: [1, 8, 64],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow: (database, scale, previous) =>
        seedCollectionGrowthPopulation(database, scale, previous, f.owner.actor.accountId, subjectId),
      operation: async () => {
        const page = await pageDueCollectionDeletions(db.pool, {
          partition: partitionOf(routeOf(f.owner.actor.accountId)!),
          cutoff: new Date().toISOString(),
          after: null,
        });
        expect(page.length).toBeLessThanOrEqual(8);
        expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096);
      },
    });
    expect(report.samples).toHaveLength(3);
  } finally {
    await f.close();
    await db.close();
  }
}, 3600000);
