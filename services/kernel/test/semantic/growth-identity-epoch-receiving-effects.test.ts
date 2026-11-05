import { afterAll, beforeAll, expect, test } from 'bun:test';
import { identityEpochStore as store } from '../../src/semantic/identity-epoch-store.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { epochFixture, type EpochFixture } from './support/identity-epoch.ts';
import { admittedReceivingJob, completeReceivingParticipant } from './support/identity-receiving-effects.ts';

let db: GrowthDatabase;
let f: EpochFixture;
beforeAll(async () => {
  db = await openGrowthDatabase();
  f = await epochFixture(db.url);
});
afterAll(async () => {
  await f?.close();
  await db?.close();
});

test('native receiving receipt custody replay stays bounded across unrelated source history', async () => {
  const input = await admittedReceivingJob(f);
  const progress = await completeReceivingParticipant(f, input.job);
  await store().reconcileStepReceipt(db.pool, progress.receipt);
  const report = await checkGrowth(db, {
    name: 'native receiving receipt custody replay',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    warmups: 1,
    repetitions: 3,
    async grow(_database, scale, previous) {
      // Ordinary births supply unrelated source/native creation history, never receiving proof rows.
      for (let row = previous; row < scale; row++) await f.create('Unrelated receiving history', 0x8c10);
    },
    async operation(database) {
      expect(await store().reconcileStepReceipt(database.pool, progress.receipt)).toEqual(progress);
    },
  });
  expect(report.samples).toHaveLength(3);
  expect(await input.members()).toHaveLength(2);
}, 600_000);
