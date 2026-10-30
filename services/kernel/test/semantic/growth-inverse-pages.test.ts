import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { bootstrapRelease } from '../../src/semantic/definitions.ts';
import { createSubject } from '../../src/semantic/subject.ts';
import { listSubjectLinks } from '../../src/semantic/links.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, measure, openGrowthDatabase, settle, type GrowthDatabase } from '../support/growth.ts';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL must name the migrated test database');
let db: GrowthDatabase;
const route = 15000;
const anchor = newId(route);
const role = newId(route);
const arc = newId(route);
const holder = newId(route + 16);
const ring = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(84)]]) };
const actor = {
  kind: 'account' as const,
  accountId: newId(route),
  clientId: 'growth',
  scopes: ['subject:create'],
  requestedBy: null,
  authnEpoch: 1,
};
beforeAll(async () => {
  db = await openGrowthDatabase(url);
  const digest = await bootstrapRelease(db.pool, bundledRelease);
  for (const [id, at, type] of [
    [anchor, route, 'schema:Person'],
    [holder, route + 16, 'schema:Book'],
  ] as const) {
    await createSubject(db.pool, {
      actor,
      target: { route: at, id },
      idempotencyKey: id,
      digest: new Uint8Array(32),
      item: { type, labels: { en: id } },
      release: { digest, release: bundledRelease },
      authorize: async () => true,
    });
  }
});
afterAll(async () => {
  await db.close();
});

test("an inverse page examines the same rows whatever the anchor's in-degree", async () => {
  for (const middle of [false, true]) {
    let cursor: string | undefined;
    const report = await checkGrowth(db, {
      name: `Inverse ${middle ? 'middle' : 'first'} page`,
      scales: [64, 512, 4096],
      bounds: { rows: 'constant' as const, blocks: 'constant' as const, statements: 'constant' as const },
      grow: async (_: GrowthDatabase, scale: number, previous: number) => {
        await db.admin.query(
          `INSERT INTO semantic.inbound_link(route,subject_id,property,source_subject_id,statement_id,source_revision,present,recorded_transaction_id,source_type,order_key,filter_value)
          SELECT $1,$2,$3,$4,gen_random_uuid(),1,true,gen_random_uuid(),'schema:Book',lpad(n::text,8,'0'),filter_value
          FROM generate_series($5::int,$6::int) n CROSS JOIN unnest($7::uuid[]) filter_value`,
          [
            route,
            anchor,
            middle ? 'schema:translator' : 'schema:author',
            holder,
            previous,
            scale - 1,
            ['00000000-0000-0000-0000-000000000000', role, arc],
          ],
        );
        await db.admin.query(
          `INSERT INTO semantic.inbound_link_count(route,subject_id,property,filter_value,value)
          SELECT $1,$2,$3,filter_value,$4 FROM unnest($5::uuid[]) filter_value
          ON CONFLICT(route,subject_id,property,filter_value) DO UPDATE SET value=excluded.value`,
          [
            route,
            anchor,
            middle ? 'schema:translator' : 'schema:author',
            scale,
            ['00000000-0000-0000-0000-000000000000', role, arc],
          ],
        );
        if (middle) {
          const { encodeCursor } = await import('../../src/tokens/cursor.ts');
          cursor = encodeCursor(
            ring,
            {
              operation: 'subject.links',
              parameters: { subject: anchor, property: 'schema:translator', filter: arc, type: null, language: null },
            },
            {
              epoch: 1,
              after: [
                String(Math.floor(scale / 2)).padStart(8, '0'),
                '00000000-0000-0000-0000-000000000000',
                '00000000-0000-0000-0000-000000000000',
              ],
            },
          );
        }
      },
      operation: async () => {
        const result = await listSubjectLinks(db.pool, ring, {
          routeKey: new Uint8Array(32).fill(1),
          subject: anchor,
          property: middle ? 'schema:translator' : 'schema:author',
          filter: arc,
          limit: 25,
          ...(cursor ? { cursor } : {}),
          seen: [],
          caughtUp: true,
          authorize: async () => true,
        });
        expect(result.links).toHaveLength(25);
        expect(result.next).not.toBeNull();
      },
    });
    expect(report.samples).toHaveLength(3);
    expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
  }
}, 60_000);

test('links projection work grows with changed links and stays flat in in-degree', async () => {
  // Keep the projection's input relations large enough to exercise indexed probes at every scale.
  await db.admin.query(
    `INSERT INTO semantic.inbound_link(route,subject_id,property,source_subject_id,statement_id,source_revision,present,recorded_transaction_id,source_type,order_key)
    SELECT $1,$2,'fixture:link',$3,md5(n::text)::uuid,1,true,gen_random_uuid(),'schema:Book',lpad(n::text,8,'0')
    FROM generate_series(1,8000) n`,
    [route, anchor, holder],
  );
  await db.admin.query(`INSERT INTO core.outbox(partition_no,position,event_seq,event_count,epoch,id,type,data)
    SELECT 4095,n,0,1,1,gen_random_uuid(),'fixture.baseline','{}'::jsonb FROM generate_series(1,4000) n`);
  await db.admin.query(`INSERT INTO core.consumer_checkpoint(partition_no,consumer)
    SELECT n,'fixture_baseline' FROM generate_series(0,4095) n`);
  await db.admin.query(
    `INSERT INTO semantic.inbound_link_count(route,subject_id,property,filter_value,value)
    SELECT $1,$2,'fixture:counter' || n,'00000000-0000-0000-0000-000000000000',0
    FROM generate_series(1,4000) n`,
    [route, anchor],
  );
  const { runCommand } = await import('../../src/command/command.ts');
  const { LINKS_CHANGED } = await import('../../src/semantic/events.ts');
  const { linkProjection } = await import('../../src/semantic/links.ts');
  const projection = linkProjection(db.pool);
  let revision = 1;
  for (const growingLinks of [true, false]) {
    const check = {
      name: growingLinks ? 'Changed outbound links' : 'Projection at growing in-degree',
      scales: [64, 512, 4096] as const,
      repetitions: 3,
      bounds: growingLinks
        ? { rows: 'linear' as const, blocks: 'linear' as const, statements: 'linear' as const }
        : { rows: 'constant' as const, blocks: 'constant' as const, statements: 'constant' as const },
      grow: async (_: GrowthDatabase, scale: number, previous: number) => {
        if (!growingLinks)
          await db.admin.query(
            `INSERT INTO semantic.inbound_link(route,subject_id,property,source_subject_id,statement_id,source_revision,present,recorded_transaction_id)
          SELECT $1,$2,'schema:contributor',$3,gen_random_uuid(),1,true,gen_random_uuid() FROM generate_series($4::int,$5::int)`,
            [route, anchor, holder, previous, scale - 1],
          );
      },
      operation: async (_: GrowthDatabase, scale: number) => {
        const source = newId(route + 16);
        const changes = Array.from({ length: growingLinks ? scale : 10 }, () => {
          const statement = newId(route + 16);
          return ['00000000-0000-0000-0000-000000000000', role, arc].map((filter_value) => ({
            property: 'schema:contributor',
            statement,
            filter_value,
            target: anchor,
            present: true,
            source_type: 'schema:Book',
            order_key: '0name',
          }));
        }).flat();
        await runCommand(db.pool, { partition: (route + 16) >>> 4 }, async () => ({
          value: null,
          events: [
            {
              type: LINKS_CHANGED,
              subject: source,
              data: { subject: source, revision: revision++, security_revision: 0, changes },
            },
          ],
        }));
        const result = await projection.run((route + 16) >>> 4);
        expect(result.status).toBe('read');
        if (result.status === 'read') expect(result.envelopes).toBeGreaterThan(0);
      },
    };
    if (growingLinks) {
      const costs = [];
      for (const scale of [10, 100, 500]) {
        await check.operation(db, scale);
        await settle(db, { analyze: true });
        costs.push({ scale, cost: (await measure(db, () => check.operation(db, scale))).cost });
      }
      for (const sample of costs.slice(1)) {
        for (const metric of ['rows', 'blocks', 'statements'] as const) {
          expect(sample.cost[metric]).toBeLessThanOrEqual(((costs[0]!.cost[metric] * sample.scale) / 10) * 1.2);
        }
      }
    } else {
      const report = await checkGrowth(db, check);
      expect(report.samples).toHaveLength(3);
      expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
    }
  }
}, 60_000);
