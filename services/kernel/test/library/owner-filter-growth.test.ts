import { expect, test } from 'bun:test';
import { checkGrowth, type GrowthDatabase, openGrowthDatabase } from '../support/growth.ts';
import { createOwnerFilterFixture, type OwnerFilterFixture } from './support/owner-filter-fixture.ts';

test('common owner-filter first and deep pages bound native history work at 64/512/4096 retained sessions', async () => {
  let database: GrowthDatabase | undefined;
  let fixture: OwnerFilterFixture | undefined;
  try {
    const f = await createOwnerFilterFixture({
      async kernelPool(url) {
        database = await openGrowthDatabase(url);
        // The existing native driver owns and closes its supplied runtime pool.
        return database.pool;
      },
    });
    fixture = f;
    if (!database) throw new Error('Native kernel did not request its measured pool');
    const filter = {
      and: [
        { type: { in: [f.type] } },
        f.leaves.presence,
        { or: [f.leaves.state, f.leaves.label, f.leaves.session, f.leaves.qualifiedHolding] },
        { not: f.leaves.state },
      ],
    };
    const expected = [f.subjects.labelOnly.id, f.subjects.sessionOnly.id, f.subjects.copyOnly.id].sort();
    const report = await checkGrowth(database, {
      name: 'Common owner predicate complete first/deep HTTP pages with retained history',
      scales: [64, 512, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      byteBounds: { requestBytes: 'constant', responseBytes: 'constant' },
      async grow(_db, scale, previous) {
        for (let ordinal = previous; ordinal < scale; ordinal++) await f.complete(f.subjects.sessionOnly.id);
      },
      async operation() {
        const result = await f.members(filter);
        expect(result).toEqual(expected);
        return result;
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
    for (const sample of report.samples)
      for (const cost of sample.repetitions) {
        // Two one-read pages, P=2 then P=2: each has c <= 6P+8 = 20.
        // These are the existing direct-plan bounds, including discarded native work.
        expect(cost.statements + (cost.backgroundStatements ?? 0)).toBeLessThanOrEqual(24);
        expect(cost.rows + (cost.backgroundRows ?? 0)).toBeLessThanOrEqual(2 * (64 + 16 * 20));
        expect(cost.blocks + (cost.backgroundBlocks ?? 0)).toBeLessThanOrEqual(6 * 2 * (64 + 16 * 20));
        expect(cost.requestBytes).toBeDefined();
        expect(cost.responseBytes).toBeDefined();
        expect(cost.requestBytes! + (cost.backgroundRequestBytes ?? 0)).toBeLessThanOrEqual(
          2 * (64 * 1024 + 1024 * 20),
        );
        expect(cost.responseBytes! + (cost.backgroundResponseBytes ?? 0)).toBeLessThanOrEqual(
          2 * (16 * 1024 + 4096 * 20),
        );
      }
  } finally {
    // Close the observer before the driver drops its owned database. The driver closes database.pool.
    await database?.admin.end();
    await fixture?.close();
  }
}, 600_000);
