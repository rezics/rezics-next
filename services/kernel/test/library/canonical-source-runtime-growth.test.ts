import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as store from '../../src/library/canonical-source-store.ts';
import { openGrowthDatabase, checkGrowth, type GrowthDatabase } from '../support/growth.ts';
import { canonicalFixture, allowance, receipt, type CanonicalFixture } from './canonical-source-fixture.ts';
let db: GrowthDatabase, f: CanonicalFixture;
beforeAll(async () => {
  db = await openGrowthDatabase();
  f = await canonicalFixture(db);
});
afterAll(async () => {
  await db?.close();
});

test('actual canonical current-state first/deep/negative seeks and group evidence remain indexed under unrelated native history', async () => {
  const collection = await f.collection('public'),
    history = await f.collection('private');
  const ids = [await f.subject(), await f.subject()].sort();
  await f.add(collection.id, ids[0]!);
  await f.add(collection.id, ids[0]!);
  await f.add(collection.id, ids[1]!);
  const ready = await f.build(collection.id, 1);
  const report = await checkGrowth(db, {
    name: 'native canonical runtime fixed-source first deep negative and duplicate windows',
    scales: [64, 512, 4096],
    slack: {
      rows: { absolute: 0, relative: 0 },
      statements: { absolute: 0, relative: 0 },
      blocks: { absolute: 0, relative: 0 },
    },
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(_db, scale, previous) {
      for (let n = previous; n < scale; n++) await f.add(history.id, ids[0]!, `Unrelated source occurrence ${n}`);
    },
    async operation() {
      expect((await store.readCanonicalSourceState(db.pool, f.call(collection.id))).state).toBe('ready');
      for (const [afterSubjectId, expected] of [
        [null, ids[0]],
        [ids[0], ids[1]],
        [ids[1], null],
      ] as const) {
        const reserved = allowance(1),
          result = await store.seekCanonicalSourceGroup(db.pool, {
            ...f.call(collection.id, reserved),
            ...ready,
            afterSubjectId: afterSubjectId ?? null,
          });
        receipt(result.work, reserved);
        expect(result).toMatchObject({ state: 'ready', subjectId: expected });
      }
      const reserved = allowance(1),
        window = await store.readCanonicalSourceGroup(db.pool, {
          ...f.call(collection.id, reserved),
          basis: ready.basis,
          progress: { pendingSubjectId: ids[0]!, after: null, ...ready },
        });
      receipt(window.work, reserved);
      expect(window.state).toBe('ready');
      if (window.state !== 'ready') throw new Error('Actual native group window must succeed');
      expect(window.rows).toHaveLength(1);
      expect(window.exhausted).toBe(false);
    },
  });
  expect(Object.values(report.shadow).every((row) => row.outcome === 'compatible')).toBe(true);
}, 1800000);
