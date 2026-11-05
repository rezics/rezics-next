import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createShelfActivityDescReader } from '../../src/library/shelf-page-activity-desc.ts';
import type { ShelfQuery } from '../../src/library/shelf-contract.ts';
import { newId } from '../../src/route/route.ts';
import {
  catalogStatementBound,
  capture,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  type GrowthDatabase,
} from '../support/growth.ts';

let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});
const route = 0x6a10;
const id = (n: number) => `10000000-0000-7000-8000-7b20${n.toString(16).padStart(8, '0')}`;
const key = (n: number) => `2026-10-27T00:00:00.00000${(n % 2) + 1}Z`;
type Node = { [key: string]: unknown; Plans?: Node[] };
function nodes(node: Node): Node[] {
  return [node, ...(node.Plans ?? []).flatMap(nodes)];
}

async function seed(owner: string, typeId: string, state: string, first: number, last: number, noise = 0) {
  await db.admin.query(
    `INSERT INTO library.entry
    (route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id,activity_at,
     finished_at,type_id,type_source_id,type_source_partition,type_source_epoch,type_source_position)
    SELECT $1,$2,s.id,$3,1,'2026-10-20T00:00:00.123456Z','2026-10-21T00:00:00.234567Z',s.id,
      '2026-10-27'::timestamptz + (n % 2 + 1) * interval '1 microsecond',
      CASE WHEN n % 2 = 0 THEN '2026-10-22T00:00:00.345678Z'::timestamptz END,$4,s.id,1970,1,0
    FROM generate_series($5::int,$6::int) n CROSS JOIN LATERAL
      (SELECT ('10000000-0000-7000-8000-7b20' || lpad(to_hex(n + $7::int),8,'0'))::uuid id) s`,
    [route, owner, state, typeId, first, last, noise],
  );
}

test('fixed date reader stays bounded as private populations grow', async () => {
  const reader = createShelfActivityDescReader();
  for (const axis of ['qualifying', 'foreign', 'state', 'type', 'sessions'] as const) {
    // Separate owners keep the independently grown populations from contaminating another series.
    const types = [newId(route), newId(route)];
    const fixtures = [null, 'planned'].flatMap((state) =>
      [null, types[0]!].map((typeId) => ({
        owner: newId(route),
        foreign: newId(route),
        query: { state, typeId } as Pick<ShelfQuery, 'state' | 'typeId'>,
      })),
    );
    const report = await checkGrowth(db, {
      name: `activity desc ${axis}`,
      scales: [256, 1024, 4096],
      warmups: 1,
      repetitions: 3,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      async grow(_db, scale, previous) {
        for (const f of fixtures) {
          if (previous === 0)
            await seed(f.query.state || f.query.typeId ? f.owner : f.foreign, types[1]!, 'dropped', 1, 4096, 200000);
          if (axis === 'qualifying' || previous === 0)
            await seed(f.owner, types[0]!, 'planned', previous + 1, axis === 'qualifying' ? scale : 256);
          if (axis === 'sessions')
            await db.admin.query(
              `INSERT INTO library.progress_session
               (route,session_id,account_id,subject_id,mode,unit,completed_unit_count,state,revision,
                started_at,transaction_id,last_changed_at)
               SELECT $1,s,$2,$3,'scalar_amount','page',0,'active',1,'2026-10-28',s,'2026-10-28'
               FROM unnest($4::uuid[]) s`,
              [route, f.owner, id(1), Array.from({ length: scale - previous }, () => newId(route))],
            );
          else if (axis !== 'qualifying') {
            const filtered = axis === 'state' ? f.query.state !== null : axis === 'type' && f.query.typeId !== null;
            await seed(
              filtered ? f.owner : f.foreign,
              axis === 'type' ? types[1]! : types[0]!,
              axis === 'state' ? 'dropped' : 'planned',
              previous + 1,
              scale,
              100000,
            );
          }
        }
      },
      operation: (_db, scale) => run(scale, false),
      warmup: (_db, scale) => run(scale, true),
    });
    expect(report.samples.every(({ cost }) => cost.statements === 32 && cost.plans === 32)).toBe(true);
    console.log(
      JSON.stringify({
        check: report.name,
        samples: report.samples.map(({ scale, cost }) => ({
          scale,
          rows: cost.rows,
          blocks: cost.blocks,
          statements: cost.statements,
        })),
      }),
    );

    async function run(scale: number, inspect: boolean) {
      const count = axis === 'qualifying' ? scale : 256;
      const expected = Array.from({ length: count }, (_, i) => i + 1).sort((a, b) => (b % 2) - (a % 2) || a - b);
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        for (const f of fixtures)
          for (const limit of [1, 48])
            for (const offset of [-1, Math.floor(count / 2) - 2, Math.floor((count * 3) / 4), count - 1]) {
              const n = expected[offset];
              const after = n === undefined ? null : { key: key(n), subjectId: id(n) };
              const read = async () => {
                const page = await reader.page(
                  client,
                  route,
                  f.owner,
                  { ...f.query, orderBy: 'lastActivity', direction: 'desc', limit },
                  after,
                );
                // Flush extended-protocol portal-close notices before the capture ends.
                await client.query('SET LOCAL auto_explain.log_min_duration = 0');
                return page;
              };
              const measured = inspect ? await capture(db, read) : null;
              const result = measured ? measured.value : await read();
              const wanted = expected.slice(offset + 1, offset + 1 + limit);
              expect(result.entries.map((row) => row.subjectId)).toEqual(wanted.map(id));
              expect(result.more).toBe(count > offset + 1 + limit);
              for (const [i, row] of result.entries.entries()) {
                expect(Object.keys(row).sort()).toEqual(
                  ['subjectId', 'state', 'revision', 'createdAt', 'updatedAt', 'lastActivityAt', 'finishedAt'].sort(),
                );
                expect(row.lastActivityAt).toBe(key(wanted[i]!));
                expect(row.createdAt).toBe('2026-10-20T00:00:00.123456Z');
                expect(row.updatedAt).toBe('2026-10-21T00:00:00.234567Z');
                expect(row.finishedAt).toBe(wanted[i]! % 2 ? null : '2026-10-22T00:00:00.345678Z');
              }
              if (!measured) continue;
              const raw = measured.capture;
              const catalog = catalogStatementBound(raw);
              expect(catalog.catalogStatements).toBeLessThanOrEqual(catalog.allowedStatements);
              const cost = costOf(raw);
              expect(cost.statements).toBe(1);
              expect(cost.rows).toBeLessThanOrEqual(2 * (limit + 1));
              expect(cost.blocks).toBeLessThanOrEqual(12 * (limit + 1) + 64);
              const plans = raw.plans as { Plan: Node; 'Query Text': string }[];
              const selected = plans.filter((plan) => !catalog.catalogTexts.has(plan['Query Text']));
              expect(selected, JSON.stringify(raw)).toHaveLength(1);
              const scans = nodes(selected[0]!.Plan).filter(
                (node) => node['Relation Name'] === 'entry' && Number(node['Actual Loops']) > 0,
              );
              expect(scans.length).toBeGreaterThan(0);
              const index = `entry_shelf_activity${f.query.state === null ? '' : '_state'}${f.query.typeId === null ? '' : '_type'}`;
              for (const scan of scans) {
                expect(scan['Node Type']).toMatch(/^Index (Only )?Scan$/);
                expect(scan['Index Name'], JSON.stringify(scan)).toBe(index);
                const bound = String(scan['Index Cond']);
                expect(bound).toContain('route =');
                expect(bound).toContain('account_id =');
                if (f.query.state !== null) expect(bound).toContain('state =');
                if (f.query.typeId !== null) expect(bound).toContain('type_id =');
                if (after) {
                  expect(bound).toMatch(/activity_at [<=]/);
                  if (bound.includes('activity_at =')) expect(bound).toContain('subject_id >');
                }
                expect(Number(scan['Rows Removed by Filter'] ?? 0)).toBe(0);
                expect(Number(scan['Actual Rows'])).toBeLessThanOrEqual(limit + 1);
              }
            }
        await client.query('COMMIT');
      } finally {
        client.release();
      }
    }
  }
}, 120_000);

test('activity desc reader rejects impossible predicates and seeks before querying', async () => {
  const reader = createShelfActivityDescReader(),
    owner = newId(route);
  const query: ShelfQuery = { state: null, typeId: null, orderBy: 'lastActivity', direction: 'desc', limit: 1 };
  const client = {
    query() {
      throw new Error('Unexpected SQL');
    },
  } as Parameters<typeof reader.page>[0];
  for (const patch of [
    { state: undefined },
    { state: 'invalid' },
    { typeId: 'schema:Book' },
    { typeId: undefined },
    { orderBy: 'createdAt' },
    { direction: 'asc' },
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { limit: NaN },
  ])
    await expect(reader.page(client, route, owner, { ...query, ...patch } as ShelfQuery, null)).rejects.toThrow(
      /Invalid/,
    );
  for (const key of ['', '2026-02-30T00:00:00.000001Z', '2026-10-27T24:00:00Z', 'now', 'infinity'])
    await expect(reader.page(client, route, owner, query, { key, subjectId: id(1) })).rejects.toThrow(
      'Invalid activity shelf seek',
    );
  await expect(reader.page(client, route + 1, owner, query, null)).rejects.toThrow('Shelf owner');
});
