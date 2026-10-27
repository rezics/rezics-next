import { afterAll, beforeAll, expect, mock, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { readMaintenanceHistoryPage } from '../../src/library/maintenance-history-page.ts';
import { newId } from '../../src/route/route.ts';
import { capture, checkGrowth, costOf, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const route = 0x6a20;
const at = '2026-10-27T00:00:00.123456Z';
const deep = 1_000_000;
let db: GrowthDatabase;

beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});

async function session(accountId = newId(route)): Promise<{ route: number; accountId: string; sessionId: string }> {
  const sessionId = newId(route);
  await db.admin.query(
    `INSERT INTO library.progress_session
       (route,session_id,account_id,subject_id,mode,unit,completed_unit_count,state,revision,started_at,transaction_id)
     VALUES ($1,$2,$3,$4,'scalar_amount','page',0,'active',1,'2099-01-01',$5)`,
    [route, sessionId, accountId, newId(0x7b20), newId(route)],
  );
  return { route, accountId, sessionId };
}

async function changes(sessionId: string, first: number, last: number, date = at): Promise<void> {
  await db.admin.query(
    `INSERT INTO library.progress_change(route,session_id,change_no,intent,recorded_at,transaction_id)
     SELECT $1,$2,n,'{}',$5,$6 FROM generate_series($3::int,$4::int) n`,
    [route, sessionId, first, last, date, newId(route)],
  );
}

test('history continuation pages two and three ignore a high tail and use time maxima independently of change numbers', async () => {
  const input = await session();
  await changes(input.sessionId, 1, 300);
  await changes(input.sessionId, deep + 1, deep + 4096, '2098-01-01');
  const maxima = ['2026-10-27T00:00:03.123459Z', '2026-10-27T00:00:02.123458Z', '2026-10-27T00:00:01.123457Z'];
  for (const [index, maximum] of maxima.entries())
    await db.admin.query(
      'UPDATE library.progress_change SET recorded_at = $3 WHERE route = $1 AND session_id = $2 AND change_no = $4',
      [route, input.sessionId, maximum, index * 100 + 1],
    );
  let after = 0;
  for (const [index, maximum] of maxima.entries()) {
    const page = await readMaintenanceHistoryPage(db.admin, { ...input, after });
    expect(page).toEqual({ count: 100, after: (index + 1) * 100, lastChangedAt: maximum, complete: false });
    after = page!.after;
  }
});

test('empty history is distinct from absent and foreign sessions and preserves large safe checkpoints', async () => {
  const input = await session();
  for (const after of [0, 2_147_483_648, Number.MAX_SAFE_INTEGER])
    expect(await readMaintenanceHistoryPage(db.admin, { ...input, after })).toEqual({
      count: 0,
      after,
      lastChangedAt: null,
      complete: true,
    });
  expect(await readMaintenanceHistoryPage(db.admin, { ...input, sessionId: newId(route), after: 0 })).toBeNull();
  await changes(input.sessionId, 1, 1);
  expect(await readMaintenanceHistoryPage(db.admin, { ...input, accountId: newId(route), after: 0 })).toBeNull();
  expect(await readMaintenanceHistoryPage(db.admin, { ...input, after: 0, limit: 1 })).toEqual({
    count: 1,
    after: 1,
    lastChangedAt: at,
    complete: false,
  });
  expect(await readMaintenanceHistoryPage(db.admin, { ...input, after: 1, limit: 1 })).toEqual({
    count: 0,
    after: 1,
    lastChangedAt: null,
    complete: true,
  });
});

test('history keeps the native integer boundary and canonical UTC microseconds', async () => {
  const input = await session();
  await changes(input.sessionId, 2_147_483_647, 2_147_483_647, '2026-10-27T08:00:00.123459+08:00');
  expect(await readMaintenanceHistoryPage(db.admin, { ...input, after: 2_147_483_646 })).toEqual({
    count: 1,
    after: 2_147_483_647,
    lastChangedAt: '2026-10-27T00:00:00.123459Z',
    complete: true,
  });
  expect(await readMaintenanceHistoryPage(db.admin, { ...input, after: Number.MAX_SAFE_INTEGER })).toEqual({
    count: 0,
    after: Number.MAX_SAFE_INTEGER,
    lastChangedAt: null,
    complete: true,
  });
});

test('history input rejects invalid routes, checkpoints and limits before querying and propagates query failures', async () => {
  const failure = new Error('history query failed');
  const query = mock(() => Promise.reject(failure));
  const client = { query } as unknown as Pick<PoolClient, 'query'>;
  const input = { route, accountId: newId(route), sessionId: newId(route), after: 0 };
  for (const after of [-1, 0.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    await expect(readMaintenanceHistoryPage(client, { ...input, after })).rejects.toBeInstanceOf(RangeError);
  for (const limit of [0, -1, 101, 1.1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    await expect(readMaintenanceHistoryPage(client, { ...input, limit })).rejects.toBeInstanceOf(RangeError);
  for (const invalid of [
    { route: -1 },
    { route: 65_536 },
    { route: 0.5 },
    { route: NaN },
    { accountId: newId(route + 1) },
    { sessionId: newId(route + 1) },
    { accountId: 'invalid' },
    { sessionId: 'invalid' },
  ])
    await expect(readMaintenanceHistoryPage(client, { ...input, ...invalid })).rejects.toBeInstanceOf(RangeError);
  expect(query).not.toHaveBeenCalled();
  await expect(readMaintenanceHistoryPage(client, input)).rejects.toBe(failure);
  expect(query).toHaveBeenCalledTimes(1);
});

function nodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (typeof value !== 'object' || value === null) return [];
  const object = value as Record<string, unknown>;
  return [...('Node Type' in object ? [object] : []), ...Object.values(object).flatMap(nodes)];
}

function expectPlan(plans: readonly unknown[]): void {
  const plan = nodes(plans);
  for (const [relation, maximum] of [
    ['progress_session', 1],
    ['progress_change', 100],
  ] as const) {
    const scans = plan.filter((node) => node['Relation Name'] === relation);
    expect(scans).toHaveLength(1);
    const scan = scans[0]!;
    expect(['Index Scan', 'Index Only Scan']).toContain(String(scan['Node Type']));
    expect(scan['Index Name']).toBe(`${relation}_pkey`);
    expect(Number(scan['Actual Rows']) * Number(scan['Actual Loops'])).toBeLessThanOrEqual(maximum);
    expect(Number(scan['Rows Removed by Filter'] ?? 0)).toBe(0);
    const condition = String(scan['Index Cond']);
    expect(condition).toContain('route =');
    expect(condition).toContain('session_id =');
    if (relation === 'progress_change') expect(condition).toContain('change_no >');
  }
  const root = plan[0]!;
  expect(root['Actual Rows']).toBe(1);
  expect(plan.some((node) => node['Node Type'] === 'Limit' && node['Actual Rows'] === 100)).toBe(true);
  const outputs = root.Output as string[];
  expect(outputs).toHaveLength(4);
  expect(outputs.join(' ')).not.toMatch(/intent|unit|started_at|revision/);
}

function otherId(prefix: string, ordinal: string): string {
  return `('${prefix}-0000-7000-8000-6a20' || lpad(to_hex(${ordinal}), 8, '0'))::uuid`;
}

test('history maxima stay bounded behind a long session tail', async () => {
  for (const after of [0, deep]) {
    const scales = [256, 1024, 4096] as const;
    const accountId = newId(route);
    const fixtures = new Map<number, Awaited<ReturnType<typeof session>>>();
    for (const scale of scales) fixtures.set(scale, await session(accountId));
    let input = fixtures.get(scales[0]!)!;
    // Interleave immutable windows before growing tails, so heap allocation does not become a growth dimension.
    await db.admin.query(
      `WITH fixtures(session_id,scale) AS (VALUES ($2::uuid,256),($3::uuid,1024),($4::uuid,4096)),
       payload AS MATERIALIZED (
         SELECT session_id,scale,
           (SELECT string_agg(md5(n::text), '' ORDER BY n)
            FROM generate_series(1,scale / 2) n) AS value
         FROM fixtures
       )
       INSERT INTO library.progress_change(route,session_id,change_no,intent,recorded_at,transaction_id)
       SELECT $1,session_id,change_no,jsonb_build_object('private',value),$6,$7
       FROM payload CROSS JOIN
         (SELECT n AS change_no FROM generate_series(1,100) n
          UNION ALL SELECT $5::int + n FROM generate_series(1,100) n) windows
       ORDER BY change_no,scale`,
      [route, ...scales.map((scale) => fixtures.get(scale)!.sessionId), deep, at, newId(route)],
    );
    const sessionPrefix = after === 0 ? '30000000' : '30000001';
    const ownerPrefix = after === 0 ? '40000000' : '40000001';
    const report = await checkGrowth(db, {
      name: `history maxima window after ${after}`,
      scales,
      warmups: 1,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      async grow(database, scale, previous) {
        input = fixtures.get(scale)!;
        // Growing prefixes and tails surround two fixed 100-row windows in the same session.
        await changes(input.sessionId, 101, 100 + scale * 4, '2097-01-01');
        await changes(input.sessionId, deep + 101, deep + 100 + scale * 16, '2098-01-01');
        // Other sessions for this owner and distinct owners share the route and child index.
        await database.admin.query(
          `INSERT INTO library.progress_session
             (route,session_id,account_id,subject_id,mode,unit,completed_unit_count,state,revision,started_at,transaction_id)
           SELECT $1,${otherId(sessionPrefix, 'n')},
             CASE WHEN n % 2 = 0 THEN $2::uuid ELSE ${otherId(ownerPrefix, 'n')} END,
             $3,'scalar_amount','page',0,'active',1,$4,$5
           FROM generate_series($6::int + 1,$7::int) n`,
          [route, input.accountId, newId(0x7b20), at, newId(route), previous, scale],
        );
        await database.admin.query(
          `INSERT INTO library.progress_change(route,session_id,change_no,intent,recorded_at,transaction_id)
           SELECT $1,${otherId(sessionPrefix, 'n')},1,jsonb_build_object('private',repeat(md5(n::text),$4)), $2,$3
           FROM generate_series($5::int + 1,$6::int) n`,
          [route, at, newId(route), scale / 32, previous, scale],
        );
        // Large intents grow at every scale without crossing the inline/TOAST boundary.
        const size = await database.admin.query<{ bytes: number }>(
          `SELECT octet_length(intent->>'private') AS bytes FROM library.progress_change
           WHERE route = $1 AND session_id = $2 AND change_no = 1`,
          [route, input.sessionId],
        );
        expect(size.rows[0]!.bytes).toBe(scale * 16);
      },
      async warmup(database) {
        const measured = await capture(database, () => readMaintenanceHistoryPage(database.pool, { ...input, after }));
        expect(measured.value).toEqual({ count: 100, after: after + 100, lastChangedAt: at, complete: false });
        expect(costOf(measured.capture).statements).toBe(1);
        expectPlan(measured.capture.plans);
      },
      async operation(database) {
        expect(await readMaintenanceHistoryPage(database.pool, { ...input, after })).toEqual({
          count: 100,
          after: after + 100,
          lastChangedAt: at,
          complete: false,
        });
      },
    });
    for (const metric of ['rows', 'blocks', 'statements'] as const)
      expect(report.shadow[metric].outcome).toBe('compatible');
    for (const sample of report.samples) {
      for (const cost of sample.repetitions) {
        expect(cost.statements).toBe(1);
        expect(cost.relations['library.progress_change']!.rows).toBe(100);
        expect(cost.relations['library.progress_session']!.rows).toBe(1);
        expect(cost.relations['library.progress_change']!.sequentialScans).toBe(0);
        expect(cost.relations['library.progress_session']!.sequentialScans).toBe(0);
      }
    }
    const measured = await capture(db, () => readMaintenanceHistoryPage(db.pool, { ...input, after }));
    expect(costOf(measured.capture).statements).toBe(1);
    expectPlan(measured.capture.plans);
  }
}, 300_000);
