import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createShelfFinishedAscReader } from '../../src/library/shelf-page-finished-asc.ts';
import type { ShelfQuery, ShelfSeek } from '../../src/library/shelf-contract.ts';
import {
  capture,
  checkGrowth,
  costOf,
  openGrowthDatabase,
  withoutCatalogStatements,
  type GrowthDatabase,
} from '../support/growth.ts';

const route = 0x6a30;
const id = (n: number, r = route) =>
  `10000000-0000-7000-8000-${r.toString(16).padStart(4, '0')}${n.toString(16).padStart(8, '0')}`;
const owner = id(1),
  foreign = id(2),
  type = id(3),
  otherType = id(4);
const reader = createShelfFinishedAscReader();
const scales = [256, 1024, 4096] as const;
let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});

type Node = { [key: string]: unknown; Plans?: Node[] };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  const node = value as Node;
  if (node.Plan) return nodes(node.Plan);
  return [node, ...(node.Plans ?? []).flatMap(nodes)];
}
async function seed(count: number, group: number, query: ShelfQuery) {
  const filtered = group === 2;
  await db.admin.query(
    `INSERT INTO library.entry
    (route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id,activity_at,finished_at,type_id,type_source_id,type_source_partition,type_source_epoch,type_source_position)
    SELECT $1,$2,subject_id,CASE WHEN $5::boolean THEN 'dropped' WHEN n%2=0 THEN 'planned' ELSE 'completed' END,
      1,'2026-10-20T00:00:00.000001Z','2026-10-21T00:00:00.000002Z',$2,
      '2026-10-22T00:00:00.000003Z',CASE WHEN n%8<4 THEN NULL ELSE
        '2026-10-27'::timestamptz + (n/64)*interval '1 microsecond' END,
      CASE WHEN $5::boolean THEN $6::uuid WHEN n%4<2 THEN $7::uuid ELSE $6::uuid END,subject_id,1970,1,0
    FROM (SELECT n,('10000000-0000-7000-8000-7b20'||lpad(to_hex($3::int+n),8,'0'))::uuid subject_id
      FROM generate_series(1,$4::int*4) n) source`,
    [route, group === 1 ? foreign : owner, group * 100000, count, filtered, otherType, type],
  );
  // With no filter, only another owner can be irrelevant. Filtered fixtures always fail every supplied predicate.
  if (filtered && query.state === null && query.typeId === null) throw new Error('No filtered dimension');
}

test('fixed date reader stays bounded as private populations grow', async () => {
  for (const state of [null, 'planned'] as const)
    for (const typeId of [null, type])
      for (const limit of [1, 48]) {
        const query: ShelfQuery = { state, typeId, limit, orderBy: 'finishedAt', direction: 'asc' };
        for (const dimension of ['eligible', 'foreign', 'filtered'] as const) {
          if (dimension === 'filtered' && state === null && typeId === null) continue;
          let positions: (ShelfSeek | null)[] = [],
            expected: string[][] = [],
            more: boolean[] = [];
          async function operation() {
            for (const [i, after] of positions.entries()) {
              const page = await reader.page(db.pool, route, owner, query, after);
              expect(page.entries.map((row) => row.subjectId)).toEqual(expected[i]!);
              expect(page.more).toBe(more[i]!);
              for (const row of page.entries) {
                expect(Object.keys(row).sort()).toEqual(
                  ['subjectId', 'state', 'revision', 'createdAt', 'updatedAt', 'lastActivityAt', 'finishedAt'].sort(),
                );
                expect(row.createdAt).toBe('2026-10-20T00:00:00.000001Z');
                expect(row.updatedAt).toBe('2026-10-21T00:00:00.000002Z');
                expect(row.lastActivityAt).toBe('2026-10-22T00:00:00.000003Z');
              }
            }
          }
          const report = await checkGrowth(db, {
            name: `finished asc ${state}/${typeId}/${limit}/${dimension}`,
            scales,
            warmups: 1,
            bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
            async grow(_database, scale) {
              await db.admin.query('DELETE FROM library.entry WHERE route=$1', [route]);
              await seed(dimension === 'eligible' ? scale : 4096, 0, query);
              if (dimension !== 'eligible') await seed(scale, dimension === 'foreign' ? 1 : 2, query);
              const { rows } = await db.admin.query<{ subjectId: string; key: string }>(
                `SELECT subject_id::text AS "subjectId",
            COALESCE(to_char(finished_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'') AS key
            FROM library.entry WHERE route=$1 AND account_id=$2
              AND ($3::text IS NULL OR state=$3) AND ($4::uuid IS NULL OR type_id=$4)
            ORDER BY finished_at ASC NULLS FIRST,subject_id DESC`,
                [route, owner, state, typeId],
              );
              const nullEnd = rows.findIndex((row) => row.key !== '');
              // First, deep null ties, null-to-date boundary, deep date ties, and exhausted continuation.
              const offsets = [
                -1,
                Math.floor(nullEnd / 2),
                nullEnd - 1,
                Math.floor(rows.length * 0.8),
                rows.length - 1,
              ];
              positions = offsets.map((n) => (n < 0 ? null : rows[n]!));
              expected = offsets.map((n) => rows.slice(n + 1, n + 1 + limit).map((row) => row.subjectId));
              more = offsets.map((n) => rows.length > n + 1 + limit);
            },
            async warmup() {
              await operation();
              for (const after of positions) {
                const measured = await capture(db, () => reader.page(db.pool, route, owner, query, after));
                const raw = withoutCatalogStatements('finished asc selected plan', measured.capture);
                const scans = raw.plans
                  .flatMap(nodes)
                  .filter((node) => node['Relation Name'] === 'entry' && Number(node['Actual Loops']) > 0);
                expect(scans.length).toBeGreaterThan(0);
                const index = `entry_shelf_finished${state === null ? '' : '_state'}${typeId === null ? '' : '_type'}`;
                for (const scan of scans) {
                  expect(scan['Index Name'], JSON.stringify({ after, scan })).toBe(index);
                  const cond = String(scan['Index Cond']);
                  expect(cond).toContain('route =');
                  expect(cond).toContain('account_id =');
                  if (state !== null) expect(cond).toContain('state =');
                  if (typeId !== null) expect(cond).toContain('type_id =');
                  if (after) {
                    expect(cond).toContain('finished_at');
                    if (cond.includes('IS NULL') || cond.includes('finished_at ='))
                      expect(cond).toContain('subject_id <');
                    else expect(cond).toMatch(/finished_at (>|IS NOT NULL)/);
                  }
                  expect(Number(scan['Actual Rows']) + Number(scan['Rows Removed by Filter'] ?? 0)).toBeLessThanOrEqual(
                    limit + 1,
                  );
                }
                expect(costOf(raw).statements).toBe(1);
              }
            },
            operation,
          });
          for (const sample of report.samples) {
            expect(sample.cost.statements).toBe(positions.length);
            expect(sample.cost.rows).toBeLessThanOrEqual(positions.length * 2 * (limit + 1));
            expect(sample.cost.blocks).toBeLessThanOrEqual(200 * (limit + 1));
          }
          console.log(
            JSON.stringify({
              name: report.name,
              evidence: report.samples.map((s) => ({
                scale: s.scale,
                rows: s.cost.rows,
                blocks: s.cost.blocks,
                statements: s.cost.statements,
              })),
            }),
          );
        }
      }
}, 300_000);

test('finished ascending reader rejects impossible private queries before SQL', async () => {
  const query: ShelfQuery = { state: null, typeId: null, orderBy: 'finishedAt', direction: 'asc', limit: 1 };
  const client = {
    query() {
      throw new Error('SQL must not run');
    },
  } as unknown as Parameters<typeof reader.page>[0];
  for (const patch of [
    { direction: 'desc' },
    { orderBy: 'createdAt' },
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { state: 'bad' },
    { typeId: 'schema:Book' },
    { typeId: undefined },
  ])
    await expect(reader.page(client, route, owner, { ...query, ...patch } as ShelfQuery, null)).rejects.toThrow(
      /Invalid|private/,
    );
  for (const key of ['2026-02-30T00:00:00Z', '2026-10-27T25:00:00Z', 'Infinity', '2026-10-27T00:00:00.1234567Z'])
    await expect(reader.page(client, route, owner, query, { key, subjectId: id(10) })).rejects.toThrow(
      'Invalid shelf seek',
    );
});
