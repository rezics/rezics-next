import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { KeyRing } from '../../src/tokens/seal.ts';
import { bundledDigest } from '@rezics/definitions/bundled';
import { itemFacts } from '../../src/semantic/item.ts';
import { newId } from '../../src/route/route.ts';
import { encodeCursor } from '../../src/tokens/cursor.ts';
import {
  capture,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  seed,
  type Capture,
  type GrowthDatabase,
} from '../support/growth.ts';

const modulePath = '../../src/semantic/subject-page-candidates.ts';
let page: (
  pool: Pool,
  ring: KeyRing,
  options: { partition: number; size: number; cursor: string },
) => Promise<{ candidates: { route: number; id: string }[]; next: string | null }>;
let db: GrowthDatabase;
const partition = 321;
const size = 20;
const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(91)]]) };
const captures: Capture[] = [];
let cursor: string;

beforeAll(async () => {
  db = await openGrowthDatabase(process.env.DATABASE_URL!);
  if (existsSync(new URL(modulePath, import.meta.url))) page = (await import(modulePath)).pageSubjectPageCandidates;
});
afterAll(async () => {
  if (db) await db.close();
});

test('candidate window work stays bounded as unrelated and noindex populations grow', async () => {
  expect(page, 'the internal candidate-window primitive must exist').toBeFunction();
  try {
    const report = await checkGrowth(db, {
      name: 'candidate window work stays bounded as unrelated and noindex populations grow',
      scales: [1, 8, 64],
      warmups: 2,
      repetitions: 5,
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      grow: async (database, scale, previous) => {
        // Half of the production-shaped title-only/hidden subjects are in this owner;
        // the rest stay in their independently placed partitions across every scale.
        await seed(
          database,
          {
            name: 'candidate-window-growth',
            hotPartition: partition,
            hotShare: 0.5,
            rows: ({ ordinal, route }) => {
              const id = newId(route);
              const tx = randomUUID();
              const facts = itemFacts(id, { labels: { en: `Title only ${ordinal}`, ja: `Seed ${ordinal}` } });
              return {
                'semantic.subject': [
                  {
                    route,
                    subject_id: id,
                    type: 'schema:Book',
                    recorded_transaction_id: tx,
                    current_release: bundledDigest,
                    current_facts: facts.length,
                    visibility: ordinal % 3 === 0 ? 'hidden' : ordinal % 3 === 1 ? 'taken_down' : 'visible',
                    security_revision: 1,
                  },
                ],
                'semantic.fact': facts.map((fact) => ({ ...fact, route, subject_id: id, recorded_transaction_id: tx })),
              };
            },
          },
          { from: previous * 1024, to: scale * 1024 },
        );
        const counts = await database.admin.query<{ hot: number; total: number }>(
          `SELECT count(*) FILTER (WHERE route >= $1 AND route < $2)::int AS hot, count(*)::int AS total FROM semantic.subject`,
          [partition * 16, (partition + 1) * 16],
        );
        expect(counts.rows[0]).toEqual({ hot: scale * 512, total: scale * 1024 });
        if (!previous) {
          const keys = await database.admin.query<{ route: number; id: string }>(
            `SELECT route, subject_id::text AS id FROM semantic.subject WHERE route >= $1 AND route < $2 ORDER BY route, subject_id LIMIT 200`,
            [partition * 16, (partition + 1) * 16],
          );
          const last = keys.rows.at(-1)!;
          cursor = encodeCursor(
            ring,
            { operation: 'subject-pages.candidates', parameters: { partition, size } },
            { epoch: 1, after: [last.route, last.id] },
          );
        }
      },
      warmup: async (database) => {
        const measured = await capture(database, () => page(database.pool, ring, { partition, size, cursor }));
        captures.push(measured.capture);
        expect(measured.value.candidates).toHaveLength(size);
        expect(
          measured.value.candidates.every(({ route }) => route >= partition * 16 && route < (partition + 1) * 16),
        ).toBe(true);
        expect(measured.value.next).toBeString();
        const cost = costOf(measured.capture);
        expect(Object.keys(cost.relations).sort()).toEqual(['core.partition', 'semantic.subject']);
        expect(cost.relations['semantic.subject']!.rows).toBe(size + 1);
        expect(cost.relations['semantic.subject']!.sequentialScans).toBe(0);
        expect(cost.rows).toBe(size + 2);
        expect(cost.statements + cost.controlStatements).toBe(5);
        expect(JSON.stringify(measured.capture.plans)).toContain('subject_pkey');
        const sql = measured.capture.statements.join('\n');
        expect(JSON.stringify(measured.capture.plans)).toContain(`route >= ${partition * 16}`);
        expect(JSON.stringify(measured.capture.plans)).toContain(`route < ${(partition + 1) * 16}`);
        expect(sql).toMatch(/LIMIT \$\d+::integer/);
        expect(sql).not.toMatch(/semantic\.(?:fact|hidden_candidate)|visibility|OFFSET|enable_|SET.*cost/i);
      },
      operation: async (database) => {
        const window = await page(database.pool, ring, { partition, size, cursor });
        expect(window.candidates).toHaveLength(size);
        expect(window.next).toBeString();
      },
    });
    for (const sample of report.samples) {
      for (const cost of sample.repetitions) {
        expect(cost.rows).toBe(size + 2);
        expect(cost.relations['semantic.subject']!.rows).toBe(size + 1);
        expect(cost.relations['semantic.subject']!.sequentialScans).toBe(0);
        expect(cost.statements + cost.controlStatements).toBe(5);
      }
    }
    console.log(
      'Candidate window scale costs:',
      JSON.stringify(
        report.samples.map(({ scale, cost }) => ({
          scale,
          rows: cost.rows,
          blocks: cost.blocks,
          statements: cost.statements + cost.controlStatements,
        })),
      ),
    );
  } catch (error) {
    // Capture an unforced retry at the failing seeded scale as well as every warm-up's complete plans.
    if (cursor) captures.push((await capture(db, () => page(db.pool, ring, { partition, size, cursor }))).capture);
    console.error('Unforced candidate SQL and all plans:', JSON.stringify(captures));
    throw error;
  }
}, 120_000);
