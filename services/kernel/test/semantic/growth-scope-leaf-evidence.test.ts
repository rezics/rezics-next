import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import {
  accounted,
  current,
  languageLeaf,
  leafFixture,
  leafReader,
  snak,
  stepBudget,
  typeLeaf,
  type LeafFixture,
} from './scope-leaf-evidence-fixture.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
let db: GrowthDatabase;
let f: LeafFixture;
beforeAll(async () => {
  db = await openGrowthDatabase(url);
  f = await leafFixture(db.pool, db.admin);
});
afterAll(async () => {
  if (db) await db.close();
});

test('leaf evidence cost is bounded under unrelated property history and relation growth', async () => {
  const book = await f.baseline();
  // Resolve only after legal commands, actual current fact selection and real Access; no route404 substitute.
  const read = await leafReader();
  const target = await f.create();
  const receipts: { axis: string; scale: number; usage: ReturnType<typeof stepBudget> }[] = [];
  for (const axis of ['unrelated-properties', 'unrelated-history', 'relation-degree', 'same-pair-witnesses'] as const) {
    const subject = axis === 'unrelated-properties' ? book : await f.baseline();
    let head: number | null = null;
    let historyWrites = Promise.resolve();
    const population: Population = {
      name: `current-leaf-${axis}`,
      hotPartition: 0x750,
      hotShare: 1,
      async write(_database, { ordinal }) {
        if (axis === 'unrelated-properties') {
          // Grow native slotKey property ranges on the SAME selected subject, not unrelated subjects only.
          const key = await f.create();
          const candidate = await f.propose(subject, 'ex:credit', target, [snak('ex:key', key)]);
          await f.accept(subject, candidate);
          await f.adopt(subject, 'ex:credit', [candidate], null, { target, key });
        } else if (axis === 'unrelated-history') {
          // Serialize this native slot's compare-and-swap heads while retaining the shared seed population.
          historyWrites = historyWrites.then(async () => {
            // Thousands of legal expanded editorial heads on an unrelated property of the selected subject.
            const candidate = await f.propose(subject, 'schema:datePublished', {
              time: `+${1900 + ordinal}-01-01T00:00:00Z`,
              precision: 11,
              calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
            });
            await f.accept(subject, candidate);
            if (head === null) {
              const row = await db.admin.query(
                'SELECT max(head) AS head FROM semantic.adoption WHERE route=$1 AND subject_id=$2',
                [0x7500, subject],
              );
              head = row.rows[0].head === null ? null : Number(row.rows[0].head);
            }
            head = await f.adopt(subject, 'schema:datePublished', [candidate], head);
          });
          await historyWrites;
        } else if (axis === 'relation-degree') {
          const other = await f.create();
          const candidate = await f.propose(subject, 'schema:author', other);
          await f.accept(subject, candidate);
          await f.adopt(subject, 'schema:author', [candidate], null, { target: other });
        } else {
          const key = await f.create();
          const candidate = await f.propose(subject, 'ex:credit', target, [snak('ex:key', key)]);
          await f.accept(subject, candidate);
          await f.adopt(subject, 'ex:credit', [candidate], null, { target, key });
          await f.hideCandidate(subject, candidate);
        }
      },
    };
    // Type/property isolation and relevant bounded witness-driver work are measured independently.
    const leaf =
      axis === 'same-pair-witnesses'
        ? { facet: 'statement' as const, property: 'ex:credit', values: [target] }
        : axis === 'relation-degree'
          ? typeLeaf
          : languageLeaf;
    const report = await checkGrowth(db, {
      name: `current selected leaf: ${axis}`,
      scales: [64, 512, 4096],
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      warmups: 1,
      repetitions: 3,
      grow: (database, scale, previous) => seed(database, population, { from: previous, to: scale }),
      async operation(_database, scale) {
        const evidence = current(await read(db.pool, f.request(subject, leaf), f.options()));
        accounted(evidence, stepBudget());
        expect(evidence.usage.keys).toBeLessThanOrEqual(17);
        if (axis === 'same-pair-witnesses') {
          expect(evidence.coverage).toBeNull();
          expect(evidence.progress).not.toBeNull();
          expect(evidence.facts).toEqual([]);
          expect(evidence.usage.witnesses).toBeGreaterThan(0);
        } else if (axis === 'relation-degree') {
          expect(evidence.type).toBe('schema:Book');
          expect(evidence.facts).toEqual([]);
        } else {
          expect(evidence.facts.map((fact) => fact.statement)).toEqual([
            { property: 'schema:inLanguage', value: 'ja', facet: { kind: 'code' } },
          ]);
        }
        receipts.push({ axis, scale, usage: evidence.usage });
      },
    });
    expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
    for (const sample of report.samples) {
      expect(sample.repetitions).toHaveLength(3);
      expect(sample.cost.statements).toBeGreaterThan(0);
      expect(sample.cost.rows).toBeGreaterThan(0);
      expect(sample.cost.blocks).toBeGreaterThan(0);
      const usage = receipts.filter((receipt) => receipt.axis === axis && receipt.scale === sample.scale).at(-1)!.usage;
      expect(usage.rows).toBeGreaterThanOrEqual(sample.cost.rows);
    }
  }
  expect(receipts.length).toBe(4 * 3 * 4);
}, 1_800_000);
