import { expect, test } from 'bun:test';
import { createShelfFinishedDescReader } from '../../src/library/shelf-page-finished-desc.ts';
import type { ShelfQuery, ShelfSeek } from '../../src/library/shelf-contract.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { checkGrowth, costOf, openGrowthDatabase, withoutCatalogStatements } from '../support/growth.ts';
const route = 0x6a10,
  owner = newId(route),
  foreign = newId(route),
  types = [newId(route), newId(route)];
const id = (n: number) => `10000000-0000-7000-8000-7b20${n.toString(16).padStart(8, '0')}`;
const key = (n: number) =>
  `2026-10-27T00:00:00.${Math.floor(n / 128)
    .toString()
    .padStart(6, '0')}Z`;
type Node = { [key: string]: any }; // PostgreSQL's recursive EXPLAIN JSON.
function nodes(node: Node): Node[] {
  return [node, ...(node.Plans ?? []).flatMap(nodes)];
}

test('fixed date reader stays bounded as private populations grow', async () => {
  const db = await openGrowthDatabase(),
    reader = createShelfFinishedDescReader(),
    pool = db.openPool();
  let plans: Node[] = [];
  pool.on('connect', (client) =>
    client.on('notice', ({ message }) => {
      const marker = 'plan:\n';
      if (message?.includes(marker)) plans.push(JSON.parse(message.slice(message.indexOf(marker) + marker.length)));
    }),
  );
  try {
    for (const dimension of ['private', 'excluded'] as const)
      for (const state of [null, 'planned'] as const)
        for (const typeId of [null, types[0]!] as const)
          for (const limit of [1, 48]) {
            let expected: { subjectId: string; finishedAt: string | null }[] = [];
            let checked = 0;
            const query: ShelfQuery = { state, typeId, limit, orderBy: 'finishedAt', direction: 'desc' };
            const name = `finished desc ${dimension}/${state}/${typeId !== null}/${limit}`;
            const report = await checkGrowth(db, {
              name,
              scales: [256, 1024, 4096],
              warmups: 1,
              bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
              slack: { rows: { absolute: 25 * (limit + 1), relative: 0 } },
              async grow(database, scale) {
                await database.admin.query('DELETE FROM library.entry WHERE route=$1', [route]);
                const count = dimension === 'private' ? scale * 4 : 4096;
                expected = Array.from({ length: count }, (_, i) => i + 1)
                  .filter((n) => (state === null || n % 2 === 0) && (typeId === null || Math.floor(n / 2) % 2 === 0))
                  .map((n) => ({ subjectId: id(n), finishedAt: n > (count * 3) / 4 ? null : key(n) }))
                  .sort((a, b) =>
                    a.finishedAt === b.finishedAt
                      ? a.subjectId.localeCompare(b.subjectId)
                      : a.finishedAt === null
                        ? 1
                        : b.finishedAt === null
                          ? -1
                          : b.finishedAt.localeCompare(a.finishedAt),
                  );
                // Independent axes: matching private population, then foreign-owner and rejected state/type rows.
                await database.admin.query(
                  `INSERT INTO library.entry
                  (route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id,activity_at,finished_at,
                   type_id,type_source_id,type_source_partition,type_source_epoch,type_source_position)
                  SELECT $1, CASE WHEN bucket=1 OR (bucket=2 AND $10::boolean) THEN $3::uuid ELSE $2::uuid END, subject,
                    CASE WHEN bucket=2 THEN 'dropped' WHEN n%2=0 THEN 'planned' ELSE 'completed' END, 1,
                    '2026-10-20', '2026-10-21', subject, '2026-10-22',
                    CASE WHEN n > $6::int*3/4 THEN NULL ELSE '2026-10-27'::timestamptz + (n/128)*interval '1 microsecond' END,
                    CASE WHEN bucket=2 THEN $5::uuid WHEN (n/2)%2=0 THEN $4::uuid ELSE $5::uuid END,
                    subject, $8, 1, 0
                  FROM (SELECT n, bucket, ('10000000-0000-7000-8000-7b20'||lpad(to_hex(n+bucket*100000),8,'0'))::uuid subject
                    FROM generate_series(1,$7::int) n CROSS JOIN generate_series(0,2) bucket
                    WHERE (bucket=0 AND n<=$6) OR (bucket>0 AND n<=$9)) source`,
                  [
                    route,
                    owner,
                    foreign,
                    types[0],
                    types[1],
                    count,
                    Math.max(count, scale, 4096),
                    partitionOf(0x7b20),
                    dimension === 'excluded' ? scale : 4096,
                    state === null && typeId === null,
                  ],
                );
              },
              async operation() {
                const client = await pool.connect();
                try {
                  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
                  const nonnull = expected.findIndex((r) => r.finishedAt === null);
                  // First, deep date/tie, final finite key crossing into null, deep null, and exhausted null.
                  for (const position of [
                    -1,
                    Math.floor(nonnull * 0.7),
                    nonnull - 1,
                    Math.floor((nonnull + expected.length) / 2),
                    expected.length - 1,
                  ]) {
                    const row = expected[position];
                    const after: ShelfSeek | null = row
                      ? { key: row.finishedAt ?? '', subjectId: row.subjectId }
                      : null;
                    plans = [];
                    const result = await reader.page(client, route, owner, query, after);
                    // Flush the trailing auto_explain notice before inspecting this page's plan.
                    await client.query('SAVEPOINT measured_page');
                    expect(result.entries.map(({ subjectId, finishedAt }) => ({ subjectId, finishedAt }))).toEqual(
                      expected.slice(position + 1, position + 1 + limit),
                    );
                    expect(result.more).toBe(expected.length > position + 1 + limit);
                    for (const entry of result.entries) {
                      expect(Object.keys(entry).sort()).toEqual(
                        'subjectId state revision createdAt updatedAt lastActivityAt finishedAt'.split(' ').sort(),
                      );
                      expect(entry.createdAt).toBe('2026-10-20T00:00:00.000000Z');
                    }
                    if (plans.length === 0) continue; // Unmeasured warmup.
                    checked++;
                    const raw = { plans, statements: plans.map((p) => p['Query Text']) };
                    const measured = withoutCatalogStatements(name, raw);
                    const cost = costOf(measured);
                    expect(cost.statements).toBe(1);
                    expect(cost.rows).toBeLessThanOrEqual(5 * (limit + 1));
                    const scans = measured.plans
                      .flatMap((p) => nodes((p as Node).Plan))
                      .filter((p) => p['Relation Name'] === 'entry' && p['Actual Loops'] > 0);
                    expect(scans.length).toBeGreaterThan(0);
                    for (const scan of scans) {
                      expect(scan['Index Name']).toBe(
                        `entry_shelf_finished${state ? '_state' : ''}${typeId ? '_type' : ''}`,
                      );
                      const bound = scan['Index Cond'] as string;
                      expect(bound).toContain('route =');
                      expect(bound).toContain('account_id =');
                      if (state) expect(bound).toContain('state =');
                      if (typeId) expect(bound).toContain('type_id =');
                      if (after) {
                        expect(bound).toContain('finished_at');
                        if (bound.includes('finished_at =') || after.key === '')
                          expect(bound).toContain('subject_id >');
                        else
                          expect(bound.includes('finished_at <') || bound.includes('finished_at IS NULL')).toBe(true);
                      }
                      expect(
                        (scan['Actual Rows'] + (scan['Rows Removed by Filter'] ?? 0)) * scan['Actual Loops'],
                      ).toBeLessThanOrEqual(limit + 1);
                    }
                  }
                  await client.query('COMMIT');
                } finally {
                  client.release();
                }
              },
            });
            expect(checked).toBe(75);
            expect(report.samples.every((s) => s.cost.statements === 5)).toBe(true);
            console.info(
              JSON.stringify({
                name,
                samples: report.samples.map(({ scale, cost: { rows, blocks, statements } }) => ({
                  scale,
                  rows,
                  blocks,
                  statements,
                })),
              }),
            );
          }
  } finally {
    await db.close();
  }
}, 600_000);
