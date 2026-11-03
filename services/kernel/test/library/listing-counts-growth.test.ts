import { afterAll, beforeAll, expect, test } from 'bun:test';
import { subjectListingSource } from '../../src/library/listing-counts.ts';
import { capture, checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import {
  LISTING_COUNT_BATCH,
  LISTING_COUNT_SCALES,
  assertListingCountReaderWork,
  growListingCounts,
  insertListingCountHits,
  listingCountBatch,
  listingCountsGrowthPopulations,
  readListingCounts,
} from './support/listing-counts-growth.ts';

let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});

test('native listing-count reader rejects a foreign-route id before SQL, including mixed batches', async () => {
  const batch = listingCountBatch('mixed');
  await insertListingCountHits(db, batch);
  const listing = subjectListingSource(db.pool);
  const foreign = await capture(db, () =>
    expect(listing.read(batch.partition, [batch.foreignId])).rejects.toBeInstanceOf(RangeError),
  );
  expect(foreign.capture.statements).toEqual([]);
  const mixed = await capture(db, () =>
    expect(listing.read(batch.partition, [...batch.ids, batch.foreignId])).rejects.toBeInstanceOf(RangeError),
  );
  expect(mixed.capture.statements).toEqual([]);
  expect(await listing.read(batch.partition, batch.ids)).toEqual(batch.expected);
});

for (const input of ['all-hit', 'all-miss', 'mixed'] as const) {
  test(`native listing-count reader ${input} examines O(k) rows as same-home and unrelated listing/history grow`, async () => {
    const batch = listingCountBatch(input);
    await insertListingCountHits(db, batch);
    const populations = listingCountsGrowthPopulations(batch.partition, `${input}-${crypto.randomUUID()}`);
    const report = await checkGrowth(db, {
      name: `Library listing-counts.sql ${input} k=${LISTING_COUNT_BATCH}`,
      scales: LISTING_COUNT_SCALES,
      bounds: { statements: 'constant', rows: 'constant', blocks: 'logarithmic' },
      indexProbes: LISTING_COUNT_BATCH,
      includeBackends: true,
      async grow(_database, scale, previous) {
        await growListingCounts(db, populations, scale, previous);
      },
      async operation() {
        expect(await readListingCounts(db, batch)).toEqual(batch.expected);
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([...LISTING_COUNT_SCALES]);
    assertListingCountReaderWork(report, batch);
  }, 600_000);
}
