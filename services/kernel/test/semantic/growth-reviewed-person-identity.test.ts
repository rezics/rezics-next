import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { checkGrowth, capture, costOf, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { identityFixture, type IdentityFixture } from './identity-fixture.ts';
import { observeReviewedPersonIdentity } from '../../src/semantic/reviewed-person-identity.ts';
import { withReadTransaction } from '../../src/semantic/read.ts';
import { bundledRelease } from '@rezics/definitions/bundled';

let db: GrowthDatabase;
let f: IdentityFixture;
beforeAll(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL must name the migrated test database');
  db = await openGrowthDatabase(url);
}, 30_000);
beforeEach(async () => {
  f = await identityFixture(db.pool, db.admin);
}, 30_000);
afterAll(async () => {
  if (db) await db.close();
});

const scales = [256, 1024, 4096] as const;
const bounds = { rows: 'logarithmic', blocks: 'logarithmic', statements: 'constant' } as const;

test('reviewed Person observation stays bounded as unrelated claim population and revision history grow', async () => {
  const subject = await f.create(0x7200);
  await f.baseline(subject);
  const report = await checkGrowth(db, {
    name: 'reviewed Person observation stays bounded as unrelated claim population and revision history grow',
    scales,
    bounds,
    warmups: 1,
    repetitions: 3,
    async grow(_database, scale, previous) {
      for (let index = previous; index < scale; index++) {
        const extra = await f.create(0x7210);
        await f.baseline(extra);
      }
    },
    async operation() {
      await withReadTransaction(db.pool, async (tx) => {
        const observed = await observeReviewedPersonIdentity(
          tx,
          subject,
          { source: 'bangumi', externalId: 'person:1' },
          new Uint8Array(32).fill(4),
          bundledRelease,
        );
        expect(observed).toBeNull();
      });
    },
  });
  expect(report.samples).toHaveLength(3);
  const measured = await capture(db, () =>
    withReadTransaction(db.pool, async (tx) =>
      observeReviewedPersonIdentity(
        tx,
        subject,
        { source: 'bangumi', externalId: 'person:1' },
        new Uint8Array(32).fill(4),
        bundledRelease,
      ),
    ),
  );
  const cost = costOf(measured.capture);
  expect(cost.rows).toBeGreaterThanOrEqual(0);
  expect(cost.blocks).toBeGreaterThanOrEqual(0);
  expect(cost.statements).toBeGreaterThan(0);
  expect(measured.capture.plans.length).toBeGreaterThan(0);
}, 600_000);
