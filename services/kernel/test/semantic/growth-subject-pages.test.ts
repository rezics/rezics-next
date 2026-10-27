import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createKernel } from '../../src/http/kernel.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { newId } from '../../src/route/route.ts';
import {
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Population,
  type Row,
} from '../support/growth.ts';

let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
const scales = [1, 8, 64] as const;
const units = 32;
const limit = 4;
const anchor = '00000000-0000-7000-8000-000000000001';
const NIL = '00000000-0000-0000-0000-000000000000';
const routeKey = new Uint8Array(32).fill(76);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(77)]]) };
const stmt = (property: string, content: string) => ({ property: { id: property }, value: { type: 'value', content } });

beforeAll(async () => {
  db = await openGrowthDatabase();
  await bootstrapRelease(db.pool, bundledRelease);
  app = createKernel({ pool: db.pool, routeKey, tokens });
}, 60_000);
afterAll(async () => {
  if (db) await db.close();
});

type Axis = 'population' | 'noindex' | 'history' | 'degree';
function population(axis: Axis): Population {
  return {
    name: `subject-pages-${axis}`,
    hotPartition: 0,
    hotShare: 1,
    rows: ({ ordinal }) => {
      const route = axis === 'population' ? 0xfff0 : 0;
      const id = newId(route);
      const tx = randomUUID();
      if (axis === 'history')
        return {
          'semantic.revision': [
            {
              route: 0,
              subject_id: anchor,
              revision: ordinal + 2,
              kind: 'propose',
              release: bundledDigest,
              recorded_transaction_id: tx,
            },
          ],
          'semantic.candidate': [
            {
              route: 0,
              subject_id: anchor,
              candidate_id: newId(0),
              slot_id: newId(0),
              property: 'schema:inLanguage',
              rank: 'normal',
              statement: { value: { type: 'value', content: 'ja' }, qualifiers: [], references: [] },
              release: bundledDigest,
              revision: ordinal + 2,
              origin: 'proposal',
              view_order: 0,
            },
          ],
        };
      const facts = itemFacts(id, { labels: { en: `Population ${ordinal}` } });
      const rows: Record<string, Row[]> = {
        'semantic.subject': [
          {
            route,
            subject_id: id,
            type: axis === 'degree' ? 'schema:Person' : 'schema:Book',
            recorded_transaction_id: tx,
            current_facts: 1,
            current_release: bundledDigest,
          },
        ],
        'semantic.revision': [
          { route, subject_id: id, revision: 1, kind: 'create', release: bundledDigest, recorded_transaction_id: tx },
        ],
        'semantic.fact': facts.map((fact) => ({ ...fact, route, subject_id: id, recorded_transaction_id: tx })),
      };
      if (axis === 'degree') {
        const relation = itemFacts(
          anchor,
          { statements: { 'schema:author': [stmt('schema:author', id)] } },
          'schema:Book',
          bundledRelease,
        )[0]!;
        rows['semantic.fact'] = [
          ...rows['semantic.fact']!,
          {
            ...relation,
            route: 0,
            subject_id: anchor,
            recorded_transaction_id: tx,
            release: bundledDigest,
            relation: true,
          },
        ];
        rows['semantic.outbound_link'] = [
          {
            route: 0,
            subject_id: anchor,
            property: 'schema:author',
            context_id: GLOBAL_CONTEXT,
            filter_value: NIL,
            order_key: String(ordinal).padStart(8, '0'),
            target_subject_id: id,
            statement_id: relation.statement_id,
            slot_id: relation.slot_id,
            relation: true,
            source_type: 'schema:Book',
            source_revision: 1,
            target_type: 'schema:Person',
            value: 'value',
            present: true,
            recorded_transaction_id: tx,
          },
        ];
        rows['semantic.inbound_link'] = [
          {
            route: 0,
            subject_id: id,
            property: 'schema:author',
            source_subject_id: anchor,
            statement_id: relation.statement_id,
            source_revision: 1,
            present: true,
            recorded_transaction_id: tx,
          },
        ];
      }
      return rows;
    },
    finish: async (admin, range) => {
      if (axis !== 'history')
        await admin.query(
          `INSERT INTO semantic.partition_subjects(partition_no,visible) VALUES ($1,$2)
         ON CONFLICT(partition_no) DO UPDATE SET visible=semantic.partition_subjects.visible+EXCLUDED.visible`,
          [axis === 'population' ? 4095 : 0, range.to - range.from],
        );
      if (axis === 'degree')
        await admin.query(
          `INSERT INTO semantic.outbound_link_count(route,subject_id,property,filter_value,value)
         VALUES (0,$1,'schema:author',$2,$3)
         ON CONFLICT(route,subject_id,property,filter_value) DO UPDATE SET value=EXCLUDED.value`,
          [anchor, NIL, range.to],
        );
    },
  };
}

async function anchorFixture() {
  // Deliberately preexisting data: bootstrap needs original evidence, never a deployment-time stamp.
  const tx = randomUUID();
  await db.admin.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,current_facts,current_release)
     VALUES (0,$1,'schema:Book',$2,2,$3)`,
    [anchor, tx, bundledDigest],
  );
  await db.admin.query(
    `INSERT INTO semantic.revision(route,subject_id,revision,kind,release,recorded_transaction_id)
     VALUES (0,$1,1,'create',$2,$3)`,
    [anchor, bundledDigest, tx],
  );
  const facts = itemFacts(
    anchor,
    { labels: { en: 'Fixed candidate' }, statements: { 'schema:inLanguage': [stmt('schema:inLanguage', 'ja')] } },
    'schema:Book',
    bundledRelease,
  );
  await seed(
    { pool: db.pool, admin: db.admin },
    {
      name: 'subject-pages-anchor-facts',
      hotPartition: 0,
      rows: () => ({
        'semantic.fact': facts.map((fact) => ({
          ...fact,
          route: 0,
          subject_id: anchor,
          recorded_transaction_id: tx,
          release: fact.kind === 'statement' ? bundledDigest : null,
        })),
      }),
    },
    { from: 0, to: 1 },
  );
}

// Keep checkGrowth's catalog/background accounting, including any maintenance the GET itself starts.
// Its row metric includes Rows Removed by Filter; an empty JSON result proves no bound by itself.
test('subject page feed cost is bounded per candidate page as subjects and history grow', async () => {
  await anchorFixture();
  for (const axis of ['population', 'noindex', 'history', 'degree'] as const) {
    const report = await checkGrowth(db, {
      name: `subject page candidate request: ${axis}`,
      scales,
      warmups: 1,
      repetitions: 3,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      grow: async (database, scale, previous) => {
        await seed({ pool: database.pool, admin: database.admin }, population(axis), {
          from: previous * units,
          to: scale * units,
        });
      },
      operation: async () => {
        const response = await app.handle(new Request(`http://kernel.test/v1/subject-pages?limit=${limit}`));
        expect(response.status, 'cost must measure the real subject-page backend, not an unavailable stub').toBe(200);
        const body = (await response.json()) as { subjectPages: unknown[]; next: string | null };
        expect(body.subjectPages.length).toBeLessThanOrEqual(limit);
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
    for (const sample of report.samples) {
      expect(sample.repetitions).toHaveLength(3);
      // This prevents a route that returns constant empty output without enumerating candidates from passing.
      const subject = sample.cost.relations.subject;
      expect(subject, 'candidate examinations must be captured').toBeDefined();
      expect(subject!.rows).toBeGreaterThan(0);
    }
  }
}, 180_000);
