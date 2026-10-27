import { expect, test } from 'bun:test';
import { checkGrowth } from '../support/growth.ts';
import { currentMembershipFixture } from './membership-contract.test.ts';

// Local envelope: <=32 descriptors, <=256 candidate keys, bounded owner proof work per key.
// SQL rows include filtered keys; Search's provider counter is a separate required owner witness.
const MAX_SQL_ROWS = 32 * 256 * 32;
const MAX_STATEMENTS = 32 * 256 * 16;

for (const axis of ['unrelated subjects', 'Collection degree', 'Zone populations'] as const) {
  test(`Zone union native cost is bounded as ${axis} grows`, async () => {
    const f = currentMembershipFixture();
    const source = await f.collection();
    const anchor = await f.subject('Growth anchor');
    await f.add(source.id, anchor);
    // Assert successful native admission before growing or accepting any cost sample.
    const z = await f.zone([source.id]);
    expect((await f.page(z.id)).subjects.map((row) => row.id)).toEqual([anchor]);
    const report = await checkGrowth(f.db, {
      name: `Zone union native ${axis}`,
      scales: [64, 512, 4096],
      warmups: 1,
      repetitions: 3,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      async grow(_db, scale, previous) {
        for (let n = previous; n < scale; n++) {
          if (axis === 'Zone populations') {
            await f.zone([]);
          } else {
            const id = await f.subject(`Legal ${axis} ${n}`);
            if (axis === 'Collection degree') await f.add(source.id, id);
          }
        }
      },
      async operation() {
        // capture/checkGrowth covers every instrumented owner pool, not just the route's main pool.
        const first = await f.page(z.id, null, 1);
        expect(first.subjects).toHaveLength(1);
        if (axis !== 'Collection degree') expect(first.subjects[0]!.id).toBe(anchor);
        if (axis === 'Collection degree') {
          expect(first.next).not.toBeNull();
          const continued = await f.page(z.id, first.next, 1);
          expect(continued.subjects).toHaveLength(1);
          expect(continued.subjects[0]!.id).not.toBe(first.subjects[0]!.id);
        }
        const direct = await f.request('POST', `/v1/zones/${z.id}:readPage`, { target: { subject: anchor } }, true);
        await f.json(direct); // 404/503 never become successful low-cost samples.
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
    for (const sample of report.samples) {
      expect(sample.cost.rows).toBeLessThanOrEqual(MAX_SQL_ROWS);
      expect(sample.cost.statements).toBeLessThanOrEqual(MAX_STATEMENTS);
    }
  }, 600_000);
}

test('Zone union continued filtered windows retain a fixed cost budget', async () => {
  const f = currentMembershipFixture();
  const source = await f.collection();
  const z = await f.zone([source.id]);
  const keys: string[] = [];
  const report = await checkGrowth(f.db, {
    name: 'Zone union filtered source keys',
    scales: [64, 512, 4096],
    warmups: 1,
    repetitions: 3,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(_db, scale, previous) {
      for (let n = previous; n < scale; n++) {
        const id = await f.subject(`Filtered degree ${n}`);
        await f.add(source.id, id);
        keys.push(id);
      }
      for (const id of keys.slice(previous)) await f.suppress(id);
    },
    async operation() {
      const first = await f.page(z.id, null, 1);
      expect(first.subjects).toEqual([]);
      if (first.next !== null) {
        const continued = await f.page(z.id, first.next, 1);
        expect(continued.subjects).toEqual([]);
        expect(continued.next).not.toBe(first.next);
      }
      // At scales above one candidate budget, terminal exhaustion on the first page is dishonest.
      if (keys.length > 256) expect(first.next).not.toBeNull();
    },
  });
  expect(report.samples).toHaveLength(3);
  for (const sample of report.samples) {
    expect(sample.cost.rows).toBeLessThanOrEqual(MAX_SQL_ROWS);
    expect(sample.cost.statements).toBeLessThanOrEqual(MAX_STATEMENTS);
  }
}, 600_000);

test('Zone duplicate occurrence drivers retain bounded native page and target cost', async () => {
  const f = currentMembershipFixture();
  const sources = [await f.collection(), await f.collection()];
  const z = await f.zone(sources.map((source) => source.id));
  const anchor = await f.subject('Duplicate driver anchor');
  for (const source of sources) await f.add(source.id, anchor);
  const report = await checkGrowth(f.db, {
    name: 'Zone overlapping duplicate occurrence degree',
    scales: [64, 512, 4096],
    warmups: 1,
    repetitions: 3,
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    async grow(_db, scale, previous) {
      for (let n = previous; n < scale; n++) await f.add(sources[n % sources.length]!.id, anchor);
      // Outside capture: establish finite complete traversal before accepting a cheap page sample.
      // A permanently unresolved duplicate group cannot masquerade as bounded work.
      expect(await f.all(z.id, null, 1)).toEqual([anchor]);
    },
    async operation() {
      const first = await f.page(z.id, null, 1);
      expect(first.subjects.every((row) => row.id === anchor)).toBe(true);
      if (first.next !== null) {
        const continued = await f.page(z.id, first.next, 1);
        expect(continued.next).not.toBe(first.next);
        expect(continued.subjects.every((row) => row.id === anchor)).toBe(true);
        expect([...first.subjects, ...continued.subjects].length).toBeLessThanOrEqual(1);
      }
      await f.json(await f.request('POST', `/v1/zones/${z.id}:readPage`, { target: { subject: anchor } }, true));
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
  for (const sample of report.samples) {
    expect(sample.cost.rows).toBeLessThanOrEqual(MAX_SQL_ROWS);
    expect(sample.cost.statements).toBeLessThanOrEqual(MAX_STATEMENTS);
  }
}, 600_000);
