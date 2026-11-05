import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import * as semantic from '../../src/semantic/index.ts';
import { checkGrowth, type GrowthDatabase } from '../support/growth.ts';
import { createGrowthDeletionFixture } from './support/deletion-fixture.ts';

let fixture: Awaited<ReturnType<typeof createGrowthDeletionFixture>>;
beforeAll(async () => {
  fixture = await createGrowthDeletionFixture();
});
afterAll(async () => {
  await fixture.close();
});
const person = () => fixture.person();
const proposal = (subject: string) => fixture.proposal(subject);

test('automatic semantic purge pages count examined keys and replay durably as history grows', async () => {
  const { db, clock, call, status, path, setNow } = fixture;
  const subject = await person();
  let pending: Awaited<ReturnType<typeof proposal>>[] = [];
  // The required adapter executes real commands and checkpoints. It is deliberately
  // looked up only after native deletion succeeds; no missing module or fake job model.
  function adapter() {
    const factory = Reflect.get(semantic, 'semanticRetention');
    expect(typeof factory).toBe('function');
    return (
      factory as (
        pool: GrowthDatabase['pool'],
        options: { clock: () => Date },
      ) => {
        step(input: { partition: number; limit: number; key: string }): Promise<{
          examined: number;
          purged: number;
          checkpoint: string | null;
          done: boolean;
        }>;
      }
    )(db.pool, { clock });
  }
  const report = await checkGrowth(db, {
    name: 'semantic native minimal purge page',
    scales: [64, 512, 4096],
    repetitions: 1,
    warmups: 1,
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(_database, scale, previous) {
      for (let i = previous; i < scale; i++) await proposal(subject);
    },
    async warmup() {
      // Prepare separate eligible source keys for the warm-up and measured page.
      pending = [];
      for (let i = 0; i < 4; i++) {
        const record = await proposal(subject);
        status(await call('DELETE', path(record)), 200);
        pending.push(record);
      }
      setNow(new Date(clock().getTime() + 31 * 86_400_000));
      const page = await adapter().step({ partition: partitionOf(routeOf(subject)!), limit: 2, key: randomUUID() });
      expect(page.examined).toBeLessThanOrEqual(2);
      expect(page.purged).toBeLessThanOrEqual(page.examined);
    },
    async operation() {
      const input = { partition: partitionOf(routeOf(subject)!), limit: 2, key: randomUUID() };
      const first = await adapter().step(input);
      expect(first.examined).toBe(2);
      expect(first.purged).toBe(2);
      expect(await adapter().step(input)).toEqual(first);
      // Payload verification belongs to the same capture; the point reads stay fixed.
      const rows = await db.pool.query(
        'SELECT candidate_id, statement FROM semantic.candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=ANY($3::uuid[])',
        [routeOf(subject), subject, pending.map((record) => record.candidate)],
      );
      for (const record of pending) expect(JSON.stringify(rows.rows)).not.toContain(record.payload);
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
});
