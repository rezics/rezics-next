import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import {
  capture,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  placement,
  seed,
  type GrowthDatabase,
  type Population,
} from '../support/growth.ts';
import type { AccountActor } from '../../src/request/access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
let db: GrowthDatabase;
let source: ReturnType<typeof subjectSource>;
const hotPartition = 2048;
const actor: AccountActor = {
  kind: 'account',
  accountId: '019a1b2c-3d4e-7f00-8a00-ed170e000072',
  clientId: 'growth-current-visit',
  scopes: ['subject:create', 'subject:read'],
  requestedBy: null,
  authnEpoch: 1,
};

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  source = subjectSource(db.pool);
  expect(await bootstrapRelease(db.pool, bundledRelease)).toBe(bundledDigest);
});
afterAll(async () => {
  if (db) await db.close();
});

function digest(seed: string): Uint8Array {
  return createHash('sha256').update(seed).digest();
}

async function writeSubject(route: number, label: string, language: string): Promise<string> {
  const target = { route, id: newId(route) };
  await createSubject(db.pool, {
    actor,
    target,
    idempotencyKey: randomUUID(),
    digest: digest(target.id),
    item: {
      type: 'schema:Book',
      labels: { en: label },
      statements: {
        'schema:inLanguage': [
          {
            property: { id: 'schema:inLanguage' },
            value: { type: 'value', content: language },
          },
        ],
      },
    },
    release: { digest: bundledDigest, release: bundledRelease },
    authorize: async () => true,
  });
  return target.id;
}

function nodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (typeof value !== 'object' || value === null) return [];
  const object = value as Record<string, unknown>;
  return [...('Node Type' in object ? [object] : []), ...Object.values(object).flatMap(nodes)];
}

function expectCurrentHeadPlan(plans: readonly unknown[]): void {
  const selected = nodes(plans).filter((node) => node['Relation Name'] === 'search_selected');
  expect(selected.length).toBeGreaterThan(0);
  for (const scan of selected) {
    expect(['Index Scan', 'Index Only Scan', 'Bitmap Index Scan']).toContain(String(scan['Node Type']));
    if (scan['Index Name']) expect(String(scan['Index Name'])).toContain('search_selected');
    expect(Number(scan['Rows Removed by Filter'] ?? 0)).toBe(0);
  }
  const sorts = nodes(plans).filter(
    (node) =>
      node['Node Type'] === 'Sort' &&
      String(node['Sort Key'] ?? '').includes('log_seq') &&
      String((node as { 'Query Text'?: string })['Query Text'] ?? '').includes('kind = \'statement\''),
  );
  expect(sorts).toEqual([]);
}

async function appendObsoleteHistory(subject: string, from: number, to: number): Promise<void> {
  const route = routeOf(subject)!;
  const origin = await db.admin.query<{ recorded_transaction_id: string; current_release: string }>(
    `SELECT recorded_transaction_id::text, current_release FROM semantic.subject WHERE route=$1 AND subject_id=$2`,
    [route, subject],
  );
  const recorded = origin.rows[0]!.recorded_transaction_id;
  const values: unknown[] = [];
  const rows: string[] = [];
  let parameter = 6;
  for (let ordinal = from; ordinal < to; ordinal++) {
    rows.push(
      `($1,$2,$${parameter},1,'assert','statement','schema:inLanguage',$${parameter + 1},$3,$4,$5,false)`,
      `($1,$2,$${parameter},2,'retract','statement','schema:inLanguage',$${parameter + 1},'{}'::jsonb,$4,NULL,false)`,
    );
    values.push(newId(route), newId(route));
    parameter += 2;
  }
  if (!rows.length) return;
  await db.admin.query(
    `INSERT INTO semantic.fact
       (route, subject_id, slot_id, log_seq, operation, kind, property, statement_id, body, recorded_transaction_id, release, relation)
     VALUES ${rows.join(',')}`,
    [route, subject, { rank: 'normal', value: { type: 'value', content: 'zz' } }, recorded, bundledDigest, ...values],
  );
}

function unrelated(name: string): Population {
  let current: Population;
  current = {
    name,
    hotPartition,
    rows: ({ ordinal, route }) => {
      const id = newId(route);
      const transactionId = randomUUID();
      const facts = itemFacts(id, { labels: { en: `Unrelated ${ordinal}` } });
      return {
        'semantic.subject': [
          {
            route,
            subject_id: id,
            type: 'schema:Book',
            recorded_transaction_id: transactionId,
            visibility: 'visible',
            security_revision: 0,
            current_facts: facts.length,
            current_release: bundledDigest,
          },
        ],
        'semantic.fact': facts.map((fact) => ({
          ...fact,
          route,
          subject_id: id,
          recorded_transaction_id: transactionId,
          release: null,
        })),
      };
    },
    finish: async (admin, range) => {
      const counts = new Map<number, number>();
      for (let ordinal = range.from; ordinal < range.to; ordinal++) {
        const partition = placement(current, ordinal).partition;
        counts.set(partition, (counts.get(partition) ?? 0) + 1);
      }
      for (const [partition, visible] of counts) {
        await admin.query(
          `INSERT INTO semantic.partition_subjects (partition_no, visible) VALUES ($1, $2)
           ON CONFLICT (partition_no) DO UPDATE SET visible = semantic.partition_subjects.visible + EXCLUDED.visible`,
          [partition, visible],
        );
        await admin.query('UPDATE core.partition SET position = GREATEST(position, $2) WHERE partition_no = $1', [
          partition,
          1_000_000_000 + range.to,
        ]);
      }
    },
  };
  return current;
}

test('derived current-head bounds hold as unrelated Subjects and obsolete history grow', async () => {
  const route = hotPartition * 16;
  const subject = await writeSubject(route, 'Current visit anchor', 'ja');
  const neighbor = await writeSubject(route, 'Current visit neighbor', 'en');
  const expected = [
    { property: 'schema:inLanguage', value: 'ja', facet: { kind: 'code' } },
    { property: 'schema:inLanguage', value: 'en', facet: { kind: 'code' } },
  ];

  const report = await checkGrowth(db, {
    name: 'Search current nonrelation heads stay bounded as obsolete history and unrelated Subjects grow',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    repetitions: 3,
    grow: async (database, scale, previous) => {
      await appendObsoleteHistory(subject, previous, scale);
      await appendObsoleteHistory(neighbor, previous, scale);
      await seed({ pool: database.pool, admin: database.admin }, unrelated('semantic-search-source-current-visit'), {
        from: previous,
        to: scale,
      });
    },
    async warmup(database) {
      const measured = await capture(database, () => source.read(hotPartition, [subject, neighbor]));
      expect(measured.value.subjects.map((row) => row.statements).flat()).toEqual(expect.arrayContaining(expected));
      expectCurrentHeadPlan(measured.capture.plans);
      const selected = costOf(measured.capture).relations['semantic.search_selected'];
      expect(selected?.sequentialScans ?? 0).toBe(0);
    },
    operation: () => source.read(hotPartition, [subject, neighbor]),
  });
  expect(report.samples).toHaveLength(3);
  for (const sample of report.samples) {
    for (const cost of sample.repetitions) {
      expect(cost.relations['semantic.search_selected']?.sequentialScans ?? 0).toBe(0);
    }
  }
}, 180_000);
