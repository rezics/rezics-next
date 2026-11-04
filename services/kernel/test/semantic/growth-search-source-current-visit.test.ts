import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
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
import { configureTestReceiptKeys } from '../support/receipt-keys.ts';
import { accessCommandAuthorization, type AccountActor, type Actor } from '../../src/request/access.ts';
import { createRealAccess } from './real-access.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
let db: GrowthDatabase;
let source: ReturnType<typeof subjectSource>;
let realAccess: Awaited<ReturnType<typeof createRealAccess<{ editor: string }>>>;
let access: ReturnType<Awaited<ReturnType<typeof createRealAccess<{ editor: string }>>>['access']>;
const hotPartition = 2048;
const ACTIONS = ['subject:create', 'subject:read'] as const;
const accounts = { editor: '019a1b2c-3d4e-7f00-8a00-ed170e000072' };
const globalResource = { route: 0, id: GLOBAL_CONTEXT };
const deadline = () => Date.now() + 30_000;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  configureTestReceiptKeys(db.pool);
  realAccess = await createRealAccess(db.admin, accounts, ACTIONS);
  access = realAccess.access({
    actions: new Map(ACTIONS.map((action) => [action, { anonymous: action === 'subject:read' }])),
  });
  await realAccess.grant(globalResource, 'editor', 'subject:create');
  source = subjectSource(db.pool);
  expect(await bootstrapRelease(db.pool, bundledRelease)).toBe(bundledDigest);
});
afterAll(async () => {
  if (db) await db.close();
});

function digest(seed: string): Uint8Array {
  return createHash('sha256').update(seed).digest();
}

async function actor(): Promise<AccountActor> {
  const authenticated: Actor = await access.authenticate(realAccess.bearer('editor'), {
    pool: db.pool,
    deadline: deadline(),
  });
  if (authenticated.kind !== 'account') throw new TypeError('Growth fixture requires an account actor');
  return authenticated;
}

async function writeSubject(route: number, label: string, language: string): Promise<string> {
  const target = { route, id: newId(route) };
  const key = randomUUID();
  await createSubject(db.pool, {
    actor: await actor(),
    target,
    idempotencyKey: key,
    digest: digest(key),
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
    authorization: await accessCommandAuthorization(
      access,
      await actor(),
      'subject:create',
      globalResource,
      { pool: db.pool, deadline: deadline() },
      () => new Error('Denied subject:create'),
    ),
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
  const selected = nodes(plans).filter(
    (node) =>
      node['Relation Name'] === 'search_selected' ||
      /search_selected_(nonrelation_page|page|value)/.test(String(node['Index Name'] ?? '')),
  );
  expect(selected.length).toBeGreaterThan(0);
  expect(selected.some((node) => node['Index Name'] === 'search_selected_nonrelation_page')).toBe(true);
  for (const scan of selected) {
    expect(['Index Scan', 'Index Only Scan', 'Bitmap Index Scan', 'Bitmap Heap Scan']).toContain(
      String(scan['Node Type']),
    );
    if (scan['Index Name']) expect(String(scan['Index Name'])).toMatch(/search_selected_(nonrelation_page|page|value)/);
    expect(Number(scan['Rows Removed by Filter'] ?? 0)).toBe(0);
  }
  const nonrelation = selected.find((node) => node['Index Name'] === 'search_selected_nonrelation_page')!;
  expect(String(nonrelation['Index Cond'])).toContain('route');
  expect(String(nonrelation['Index Cond'])).toContain('subject_id');
  expect(nodes(plans).some((node) => node['Node Type'] === 'Limit')).toBe(true);
  expect(nodes(plans).filter((node) => node['Relation Name'] === 'fact' && node['Node Type'] === 'Seq Scan')).toEqual(
    [],
  );
}

async function appendActiveRelationHeads(subject: string, target: string, from: number, to: number): Promise<void> {
  if (from >= to) return;
  await db.admin.query(
    `INSERT INTO semantic.search_selected
       (route, subject_id, slot_id, candidate_id, property, rank, ordinal, body, release, revision, source,
        relation, compact, active, log_seq)
     SELECT $1,$2,gen_random_uuid(),gen_random_uuid(),'schema:author','normal',n,
       jsonb_build_object('rank','normal','value',jsonb_build_object('type','value','content',$6::text)),
       $3,1,NULL,true,true,true,n
     FROM generate_series($4::integer + 1,$5::integer) AS n`,
    [routeOf(subject), subject, bundledDigest, from, to, target],
  );
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
  ] as const;
  let responseBytes = 0;
  const expectWindow = (value: Awaited<ReturnType<typeof source.read>>) => {
    expect(value.subjects.map(({ id, statements }) => ({ id, statements }))).toEqual([
      { id: subject, statements: [expected[0]] },
      { id: neighbor, statements: [expected[1]] },
    ]);
    return Buffer.byteLength(JSON.stringify(value.subjects), 'utf8');
  };

  const report = await checkGrowth(db, {
    name: 'Search current nonrelation heads stay bounded as relation heads, obsolete history and unrelated Subjects grow',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
    byteBounds: { responseBytes: 'constant' },
    repetitions: 3,
    grow: async (database, scale, previous) => {
      await appendObsoleteHistory(subject, previous, scale);
      await appendObsoleteHistory(neighbor, previous, scale);
      await appendActiveRelationHeads(subject, neighbor, previous, scale);
      await seed({ pool: database.pool, admin: database.admin }, unrelated('semantic-search-source-current-visit'), {
        from: previous,
        to: scale,
      });
      await database.admin.query('ANALYZE semantic.search_selected');
      const heads = await database.admin.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM semantic.search_selected
         WHERE route=$1 AND subject_id=$2 AND relation IS TRUE AND active`,
        [routeOf(subject), subject],
      );
      expect(heads.rows[0]?.count).toBe(String(scale));
      const observed = await capture(database, () => source.read(hotPartition, [subject, neighbor]));
      expect(expectWindow(observed.value)).toBe(responseBytes);
      expectCurrentHeadPlan(observed.capture.plans);
    },
    async warmup(database) {
      const measured = await capture(database, () => source.read(hotPartition, [subject, neighbor]));
      responseBytes = expectWindow(measured.value);
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
