import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import { createKernel } from '../../src/http/kernel.ts';
import type { Access } from '../../src/request/access.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { itemFacts } from '../../src/semantic/item.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import {
  checkGrowth,
  openGrowthDatabase,
  seed,
  type GrowthDatabase,
  type Population,
  type Row,
} from '../support/growth.ts';
import { createRealAccess } from './real-access.ts';
import type { PublicationStore, PublicationRunner } from './subject-page-local-publication.test.ts';

let db: GrowthDatabase;
let app: ReturnType<typeof createKernel>;
let real: Awaited<ReturnType<typeof createRealAccess<{ editor: string }>>>;
let access: Access;
let now = new Date();
const clock = () => now;
const scales = [1, 8, 64] as const;
const units = 32;
let anchor: string;
const NIL = '00000000-0000-0000-0000-000000000000';
let editor: string;
const routeKey = new Uint8Array(32).fill(85);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(86)]]) };
const stmt = (property: string, content: string) => ({ property: { id: property }, value: { type: 'value', content } });
afterAll(async () => {
  if (db) await db.close();
});
async function post(path: string, body: unknown) {
  const key = randomUUID();
  const send = () =>
    app.handle(
      new Request(`http://kernel.test${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${real.bearer('editor')}`,
          'content-type': 'application/json',
          'idempotency-key': `"${key}"`,
        },
        body: JSON.stringify(body),
      }),
    );
  let response = await send();
  let value = (await response.json()) as Record<string, any>;
  for (
    let retry = 0;
    retry < 2 &&
    response.status === 503 &&
    value.code === 'overloaded' &&
    value.retryable === true &&
    value.effect_status === 'not_applied';
    retry++
  ) {
    response = await send();
    value = (await response.json()) as Record<string, any>;
  }
  expect([path, response.status, response.status === 200 ? null : value]).toEqual([path, 200, null]);
}
async function setup() {
  db = await openGrowthDatabase();
  anchor = newId(0);
  editor = newId(0x185);
  await bootstrapRelease(db.pool, bundledRelease);
  const actions = ['subject:read', 'moderation:hide'];
  real = await createRealAccess(db.admin, { editor }, actions, { clock });
  for (const action of actions) await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', action);
  await db.admin.query("UPDATE access.account SET rate_tier='trusted' WHERE route=$1 AND account_id=$2", [
    routeOf(editor),
    editor,
  ]);
  app = createKernel({
    pool: db.pool,
    routeKey,
    tokens,
    clock,
    writeRate: real.writeRate,
    access(config) {
      access = real.access(config);
      return access;
    },
  });
  await anchorFixture();
  // Resolve the same real Access through an existing native reader, independently of the absent feed.
  const read = () => app.handle(new Request(`http://kernel.test/v1/subjects/${anchor}`));
  let response = await read();
  let value = (await response.json()) as Record<string, any>;
  for (
    let retry = 0;
    retry < 2 && response.status === 503 && value.code === 'overloaded' && value.retryable === true;
    retry++
  ) {
    response = await read();
    value = (await response.json()) as Record<string, any>;
  }
  expect([response.status, response.status === 200 ? null : value]).toEqual([200, null]);
}
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
  await db.admin.query(`INSERT INTO semantic.partition_subjects(partition_no,visible) VALUES (0,1)
    ON CONFLICT(partition_no) DO UPDATE SET visible=semantic.partition_subjects.visible+1`);
}

async function drain(runner: PublicationRunner) {
  const seen = new Set<string>();
  for (let page = 0; page < 16384; page++) {
    const step = await runner.step({ limit: 32 });
    expect(step.processed).toBeGreaterThanOrEqual(0);
    expect(step.processed).toBeLessThanOrEqual(32);
    if (step.done) {
      expect(step.next).toBeNull();
      return;
    }
    expect(typeof step.next).toBe('string');
    expect(seen.has(step.next!)).toBe(false);
    seen.add(step.next!);
  }
  throw new Error('Finite focused growth repair did not settle');
}

test('repair store and current witness reads remain bounded as unrelated state grows', async () => {
  for (const mode of ['local', 'current', 'repair'] as const) {
    await setup();
    const storePath = '../../src/semantic/subject-page-publication-store.ts';
    const stores = await import(storePath).catch(() => ({}));
    expect(
      typeof (stores as any).createSubjectPagePublicationStore,
      'production store factory, independent of HTTP feed',
    ).toBe('function');
    const repairPath = '../../src/semantic/subject-page-publication.ts';
    const repairs = await import(repairPath).catch(() => ({}));
    expect(typeof (repairs as any).createSubjectPagePublication).toBe('function');
    const store: PublicationStore = (stores as any).createSubjectPagePublicationStore({
      pool: db.pool,
      access,
      clock,
      routeKey,
    });
    const runner: PublicationRunner = (repairs as any).createSubjectPagePublication({
      pool: db.pool,
      access,
      clock,
      routeKey,
    });
    const key = { route: 0, id: anchor };
    await runner.requestRebuild(key);
    await drain(runner);
    expect(await store.readCurrent(key)).toEqual({
      id: anchor,
      labels: [{ language: 'en', value: 'Fixed candidate' }],
    });
    const selected = (
      await db.admin.query(
        `SELECT statement_id::text AS id FROM semantic.fact
      WHERE route=0 AND subject_id=$1 AND property='schema:inLanguage'`,
        [anchor],
      )
    ).rows[0].id as string;
    for (const axis of ['population', 'noindex', 'history', 'degree'] as const) {
      const report = await checkGrowth(db, {
        name: `subject page publication ${mode}: ${axis}`,
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
          if (mode === 'local') {
            now = new Date(now.getTime() + 1000);
            await post(`/v1/subjects/${anchor}/candidates/${selected}:hide`, { reason: 'Bounded public removal' });
            now = new Date(now.getTime() + 1000);
            const restoredAt = now.toISOString();
            await post(`/v1/subjects/${anchor}/candidates/${selected}:restore`, {
              reason: 'Bounded public restoration',
            });
            expect((await store.read(key))?.publicEffectiveAt).toBe(restoredAt);
            expect((await store.readCurrent(key))?.lastModified).toBe(restoredAt);
          } else if (mode === 'current') {
            const current = await store.readCurrent(key);
            expect(current?.id, 'measure a real current positive proof').toBe(anchor);
            expect((await store.read(key))!.witnesses.length).toBeLessThanOrEqual(8);
          } else {
            // Enqueue and all owner/checkpoint/background work are inside the measured sample.
            await runner.requestRebuild(key);
            const step = await runner.step({ limit: 32 });
            expect(step.processed, 'idle work cannot satisfy repair cost').toBeGreaterThan(0);
            expect(step.processed).toBeLessThanOrEqual(32);
          }
        },
      });
      expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
      for (const sample of report.samples) {
        expect(sample.repetitions).toHaveLength(3);
        const relations = sample.cost.relations;
        expect(Object.keys(relations).some((name) => /subject_page_(publication|component|repair)/.test(name))).toBe(
          true,
        );
        expect(Object.keys(relations).some((name) => /fact|outbound_link/.test(name))).toBe(true);
        expect(
          Object.keys(relations).some((name) => /permission|grant|policy|closure|resource|fence|moderation/.test(name)),
        ).toBe(true);
        expect(Object.values(relations).reduce((sum, value) => sum + value.rows, 0)).toBeGreaterThan(0);
      }
      await runner.requestRebuild(key);
      await drain(runner);
      const current = await store.readCurrent(key);
      expect(current?.id).toBe(anchor);
      if (mode !== 'local') expect(Object.hasOwn(current!, 'lastModified')).toBe(false);
      for (let repeat = 0; repeat < 3; repeat++) {
        expect(await store.readCurrent(key)).toEqual(current);
        expect(await runner.step({ limit: 32 })).toEqual({ processed: 0, next: null, done: true });
      }
    }
    await db.close();
    // Avoid a second close if setup of the next owned database fails.
    db = undefined as unknown as GrowthDatabase;
  }
}, 240_000);
