import { expect, test } from 'bun:test';
import { withConnection } from '../../src/database/pool.ts';
import { createShelfActivityAscReader } from '../../src/library/shelf-page-activity-asc.ts';
import type { ShelfQuery, ShelfSeek } from '../../src/library/shelf-contract.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { capture, checkGrowth, costOf, openGrowthDatabase, withoutCatalogStatements } from '../support/growth.ts';
const route = 0x6a30;
const at = '2026-10-20T00:00:00.000001Z';
const key = (n: number) => `2026-10-27T00:00:00.${String(Math.floor((n - 1) / 64) + 1).padStart(6, '0')}Z`;
const id = (bucket: number, n: number) =>
  `10000000-0000-7000-8000-7b20${(bucket * 100000 + n).toString(16).padStart(8, '0')}`;
function nodes(value: unknown): Record<string, unknown>[] {
  if (typeof value !== 'object' || value === null) return [];
  return [value as Record<string, unknown>, ...Object.values(value).flatMap(nodes)];
}

test('fixed date reader stays bounded as private populations grow', async () => {
  const db = await openGrowthDatabase();
  try {
    for (const axis of ['matching', 'state', 'type', 'foreign'] as const) {
      const [owner, foreign, remote] = [newId(route), newId(route), newId(route + 0x1000)];
      const types = [newId(route), newId(route)];
      const reader = createShelfActivityAscReader();
      const fixtures: {
        subjectId: string;
        state: 'planned' | 'completed';
        typeId: string;
        lastActivityAt: string;
        finishedAt: string | null;
      }[] = [];
      async function insert(from: number, to: number, buckets: number[], irrelevant = false) {
        await db.admin.query(
          `INSERT INTO library.entry(route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id,
            activity_at,finished_at,type_id,type_source_id,type_source_partition,type_source_epoch,type_source_position)
           SELECT CASE WHEN b = 5 THEN $1::int + 4096 ELSE $1::int END,
            CASE WHEN b = 4 THEN $3::uuid WHEN b = 5 THEN $4::uuid ELSE $2::uuid END,
            s, CASE WHEN b IN (1,3) THEN 'completed' ELSE 'planned' END, 1, $5::timestamptz, $5::timestamptz, s,
            '2026-10-27T00:00:00Z'::timestamptz + ((n-1)/64+1) * interval '1 microsecond',
            CASE WHEN n % 2 = 0 THEN $5::timestamptz END, CASE WHEN b IN (2,3) THEN $6::uuid ELSE $7::uuid END,
            s, $8::int, 1, 0
           FROM generate_series($9::int,$10::int) n CROSS JOIN unnest($11::int[]) b
           CROSS JOIN LATERAL (SELECT ('10000000-0000-7000-8000-7b20' || lpad(to_hex(b*100000+n),8,'0'))::uuid s) ids`,
          [route, owner, foreign, remote, at, types[1], types[0], partitionOf(0x7b20), from, to, buckets],
        );
        if (!irrelevant)
          for (const b of buckets)
            for (let n = from; n <= to; n++)
              fixtures.push({
                subjectId: id(b, n),
                state: b === 1 || b === 3 ? 'completed' : 'planned',
                typeId: types[b === 2 || b === 3 ? 1 : 0]!,
                lastActivityAt: key(n),
                finishedAt: n % 2 === 0 ? at : null,
              });
      }
      // Keep qualifying neighbours while growing each source of interference independently.
      await insert(1, 256, [0, 1, 2, 3]);
      for (const limit of [1, 48]) {
        if (limit === 48) {
          await db.admin.query('DELETE FROM library.entry WHERE account_id = ANY($1::uuid[])', [
            [owner, foreign, remote],
          ]);
          fixtures.length = 0;
          await insert(1, 256, [0, 1, 2, 3]);
        }
        const cases: {
          query: ShelfQuery;
          after: ShelfSeek | null;
          expected: typeof fixtures;
          more: boolean;
          index: string;
        }[] = [];
        const operation = () =>
          withConnection(db.pool, async (client) => {
            await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            try {
              for (const c of cases) {
                const result = await reader.page(client, route, owner, c.query, c.after);
                expect(result).toEqual({
                  entries: c.expected.map(({ typeId: _, ...r }) => ({
                    ...r,
                    revision: 1,
                    createdAt: at,
                    updatedAt: at,
                  })),
                  more: c.more,
                });
              }
            } finally {
              await client.query('ROLLBACK');
            }
          });
        const report = await checkGrowth(db, {
          name: `activity ascending ${axis} limit ${limit}`,
          scales: [256, 1024, 4096],
          warmups: 1,
          bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
          grow: async (_database, scale, previous) => {
            const start = Math.max(previous, 256) + 1;
            if (scale >= start)
              await insert(
                start,
                scale,
                axis === 'matching' ? [0, 1, 2, 3] : axis === 'state' ? [1] : axis === 'type' ? [2] : [4, 5],
                axis === 'foreign',
              );
            cases.length = 0;
            for (const state of [null, 'planned'] as const)
              for (const typeId of [null, types[0]!] as const) {
                const sorted = fixtures
                  .filter((r) => (state === null || r.state === state) && (typeId === null || r.typeId === typeId))
                  .sort(
                    (a, b) =>
                      a.lastActivityAt.localeCompare(b.lastActivityAt) || b.subjectId.localeCompare(a.subjectId),
                  );
                // Deep inside a tie group, at its end, and at EOF; first pages exercise the guarded first branch.
                const deep = Math.floor(sorted.length / 2) + 32;
                const tieEnd = sorted.findLastIndex((r) => r.lastActivityAt === sorted[deep]!.lastActivityAt);
                for (const position of [-1, deep, tieEnd, sorted.length - 1]) {
                  const boundary = sorted[position];
                  cases.push({
                    query: { state, typeId, orderBy: 'lastActivity', direction: 'asc', limit },
                    after: boundary ? { key: boundary.lastActivityAt, subjectId: boundary.subjectId } : null,
                    expected: sorted.slice(position + 1, position + 1 + limit),
                    more: sorted.length > position + 1 + limit,
                    index: `entry_shelf_activity${state === null ? '' : '_state'}${typeId === null ? '' : '_type'}`,
                  });
                }
              }
          },
          operation,
          warmup: async () => {
            const measured = await capture(db, operation);
            const kept = withoutCatalogStatements('activity ascending plans', measured.capture);
            const plans = kept.plans.filter((p) => nodes(p).some((n) => n['Relation Name'] === 'entry'));
            expect(plans).toHaveLength(cases.length);
            for (let i = 0; i < cases.length; i++) {
              const c = cases[i]!,
                plan = plans[i];
              const cost = costOf({ statements: [], plans: [plan] });
              expect(cost.rows).toBeLessThanOrEqual(3 * (limit + 1));
              expect(cost.relations['library.entry']?.sequentialScans).toBe(0);
              const scans = nodes(plan).filter((n) => n['Relation Name'] === 'entry' && Number(n['Actual Loops']) > 0);
              expect(scans.some((scan) => scan['Index Name'] === c.index)).toBe(true);
              for (const scan of scans) {
                if (scan['Index Name'] === 'entry_pkey') {
                  expect(scan['Index Cond']).toMatch(/route = .*account_id = .*subject_id =/);
                  expect(Number(scan['Actual Rows'])).toBeLessThanOrEqual(1);
                  expect(Number(scan['Actual Loops'])).toBeLessThanOrEqual(limit + 1);
                  continue;
                }
                expect(scan['Index Name'], JSON.stringify(scan)).toBe(c.index);
                expect(scan['Scan Direction']).toBe('Backward');
                expect(Number(scan['Actual Rows']) * Number(scan['Actual Loops'])).toBeLessThanOrEqual(limit + 1);
                const bound = String(scan['Index Cond']);
                expect(bound).toContain(`route = ${route}`);
                expect(bound).toContain(`account_id = '${owner}'`);
                if (c.query.state !== null) expect(bound).toContain(`state = 'planned'`);
                if (c.query.typeId !== null) expect(bound).toContain(`type_id = '${types[0]}'`);
                if (c.after) {
                  expect(bound).toMatch(/activity_at [>=]/);
                  if (!bound.includes('activity_at >')) expect(bound).toContain('subject_id <');
                }
              }
              // Any Sort must consume bounded branch output, including nodes that happen to emit no rows.
              for (const sort of nodes(plan).filter((n) => n['Node Type'] === 'Sort'))
                for (const child of sort.Plans as Record<string, unknown>[])
                  expect(Number(child['Actual Rows']) * Number(child['Actual Loops'])).toBeLessThanOrEqual(
                    2 * (limit + 1),
                  );
            }
          },
        });
        for (const sample of report.samples) {
          expect(sample.cost.statements).toBe(cases.length);
          expect(sample.cost.rows).toBeLessThanOrEqual(cases.length * 3 * (limit + 1));
        }
        console.info(
          JSON.stringify({
            name: report.name,
            samples: report.samples.map(({ scale, cost: { rows, blocks, statements } }) => ({
              scale,
              rows,
              blocks,
              statements,
            })),
          }),
        );
      }
    }
  } finally {
    await db.close();
  }
}, 180_000);

test('activity ascending reader rejects impossible queries and seeks before SQL', async () => {
  const reader = createShelfActivityAscReader(),
    owner = newId(route);
  const query: ShelfQuery = { state: null, typeId: null, orderBy: 'lastActivity', direction: 'asc', limit: 1 };
  const client = {
    query: () => Promise.reject(new Error('SQL must not run')),
  } as unknown as Parameters<typeof reader.page>[0];
  for (const change of [
    { orderBy: 'finishedAt' },
    { direction: 'desc' },
    { state: 'unknown' },
    { typeId: 'schema:Book' },
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { limit: NaN },
    { state: undefined },
    { typeId: undefined },
  ])
    await expect(reader.page(client, route, owner, { ...query, ...change } as ShelfQuery, null)).rejects.toThrow(
      /Invalid/,
    );
  for (const key of ['', 'infinity', '2026-02-29T00:00:00Z', '2026-10-27T24:00:00Z', '2026-10-27T00:00:00.0000001Z'])
    await expect(reader.page(client, route, owner, query, { key, subjectId: newId(route) })).rejects.toThrow(
      'Invalid activity shelf seek',
    );
  await expect(reader.page(client, route, owner, query, { key: at, subjectId: 'invalid' })).rejects.toThrow(
    'Invalid activity shelf seek',
  );
  await expect(reader.page(client, route + 1, owner, query, null)).rejects.toThrow('Invalid shelf owner route');
});
