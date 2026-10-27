import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createShelfCreatedAscReader } from '../../src/library/shelf-page-created-asc.ts';
import type { ShelfQuery } from '../../src/library/shelf-contract.ts';
import { newId } from '../../src/route/route.ts';
import { checkGrowth, costOf, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

let db: GrowthDatabase;
beforeAll(async () => {
  db = await openGrowthDatabase();
});
afterAll(async () => {
  await db?.close();
});
const route = 0x6a10,
  owner = newId(route),
  foreign = newId(route),
  types = [newId(route), newId(route)];
const reader = createShelfCreatedAscReader();
const id = (n: number) => `10000000-0000-7000-8000-7b20${n.toString(16).padStart(8, '0')}`;
const key = (n: number) =>
  `2026-10-27 00:00:00.${String(Math.floor((n - 1) / 32) + 1)
    .padStart(6, '0')
    .replace(/0+$/, '')}+00`;
type Node = Record<string, unknown> & { Plans?: Node[] };
function nodes(plan: Node): Node[] {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

async function seed(account: string, start: number, end: number, state: string, type: string, offset = 0) {
  await db.admin.query(
    `INSERT INTO library.entry
    (route,account_id,subject_id,state,revision,created_at,updated_at,transaction_id,activity_at,finished_at,
     type_id,type_source_id,type_source_partition,type_source_epoch,type_source_position)
    SELECT $1,$2,subject_id,$5,1,stamp,stamp,subject_id,stamp,CASE WHEN n % 2 = 0 THEN stamp ELSE NULL END,
      $6,subject_id,1970,1,0
    FROM (SELECT n, ('10000000-0000-7000-8000-7b20'||lpad(to_hex(n+$7::int),8,'0'))::uuid subject_id,
      '2026-10-27'::timestamptz + ((CASE WHEN $7::int > 0 THEN (n-1)%256 ELSE n-1 END)/32+1)*interval '1 microsecond' AS stamp
      FROM generate_series($3::int+1,$4::int) n) source`,
    [route, account, start, end, state, type, offset],
  );
}

test('fixed date reader stays bounded as private populations grow', async () => {
  const pool = db.openPool();
  let plans: { Plan: Node }[] = [];
  pool.on('connect', (client) =>
    client.on('notice', (notice) => {
      const marker = 'plan:\n';
      if (notice.message?.startsWith('duration:') && notice.message.includes(marker))
        plans.push(JSON.parse(notice.message.slice(notice.message.indexOf(marker) + marker.length)));
    }),
  );
  const client = await pool.connect();
  try {
    for (const state of [null, 'planned'] as const)
      for (const typeId of [null, types[0]!] as const)
        for (const limit of [1, 48])
          for (const dimension of ['entries', 'foreign', 'state', 'type', 'sessions']) {
            if ((dimension === 'state' && state === null) || (dimension === 'type' && typeId === null)) continue;
            await db.admin.query('TRUNCATE library.entry, library.progress_session CASCADE');
            if (dimension !== 'entries') await seed(owner, 0, 256, 'planned', types[0]!);
            if (state !== null) await seed(owner, 0, 1024, 'paused', types[0]!, 20000);
            if (typeId !== null) await seed(owner, 0, 1024, 'planned', types[1]!, 30000);
            let expected: number[] = [];
            let measuredPages = 0;
            const query: ShelfQuery = { state, typeId, orderBy: 'createdAt', direction: 'asc', limit };
            const report = await checkGrowth(db, {
              name: `created asc ${state}/${typeId}/${limit}/${dimension}`,
              scales: [256, 1024, 4096],
              warmups: 1,
              repetitions: 5,
              bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
              async grow(_, scale, previous) {
                if (dimension === 'sessions') {
                  await db.admin.query(
                    `INSERT INTO library.progress_session
                (route,session_id,account_id,subject_id,mode,unit,state,revision,started_at,transaction_id,
                 completed_unit_count,last_changed_at)
                SELECT $1,uuid,$2,$3,'scalar_amount','page','active',1,'2026-10-27',uuid,0,'2026-10-27'
                FROM (SELECT ('20000000-0000-7000-8000-6a10'||lpad(to_hex(n),8,'0'))::uuid uuid
                  FROM generate_series($4::int+1,$5::int) n) source`,
                    [route, owner, id(1), previous, scale],
                  );
                } else
                  await seed(
                    dimension === 'foreign' ? foreign : owner,
                    previous,
                    scale,
                    dimension === 'state' ? 'paused' : 'planned',
                    dimension === 'type' ? types[1]! : types[0]!,
                    dimension === 'state' || dimension === 'type' ? 10000 : 0,
                  );
                const population = dimension === 'entries' ? scale : 256;
                expected = Array.from({ length: population }, (_, i) => i + 1).sort(
                  (a, b) => Math.floor((a - 1) / 32) - Math.floor((b - 1) / 32) || b - a,
                );
              },
              async operation() {
                // First page, deep date seek, deep tie seek and exhausted continuation.
                for (const position of [-1, expected.length - 128, expected.length - 17, expected.length - 1]) {
                  plans = [];
                  const boundary = expected[position];
                  const after = boundary === undefined ? null : { key: key(boundary), subjectId: id(boundary) };
                  const result = await reader.page(client, route, owner, query, after);
                  expect(result.entries.map((row) => row.subjectId)).toEqual(
                    expected.slice(position + 1, position + 1 + limit).map(id),
                  );
                  expect(result.more).toBe(expected.length > position + 1 + limit);
                  for (const row of result.entries) {
                    const n = parseInt(row.subjectId.slice(-8), 16);
                    expect(row).toEqual({
                      subjectId: id(n),
                      state: 'planned',
                      revision: 1,
                      createdAt: key(n),
                      updatedAt: key(n),
                      lastActivityAt: key(n),
                      finishedAt: n % 2 === 0 ? key(n) : null,
                    });
                  }
                  if (!plans.length) continue; // Unmeasured warmup has explaining disabled.
                  measuredPages++;
                  const cost = costOf({ statements: [], plans });
                  expect(cost.rows).toBeLessThanOrEqual(2 * (limit + 1));
                  const scans = plans
                    .flatMap((p) => nodes(p.Plan))
                    .filter((n) => n['Relation Name'] === 'entry' && Number(n['Actual Loops']) > 0);
                  expect(scans.length).toBeGreaterThan(0);
                  const index = `entry_shelf_created${state === null ? '' : '_state'}${typeId === null ? '' : '_type'}`;
                  for (const scan of scans) {
                    expect(scan['Node Type']).toBe('Index Scan');
                    expect(scan['Scan Direction']).toBe('Backward');
                    expect(scan['Index Name']).toBe(index);
                    const condition = String(scan['Index Cond']);
                    expect(condition).toContain('route =');
                    expect(condition).toContain('account_id =');
                    if (state !== null) expect(condition).toContain('state =');
                    if (typeId !== null) expect(condition).toContain('type_id =');
                    if (after !== null) {
                      expect(condition).toContain('created_at');
                      expect(
                        condition.includes('created_at >') ||
                          (condition.includes('created_at =') && condition.includes('subject_id <')),
                      ).toBe(true);
                    }
                  }
                }
              },
            });
            expect(measuredPages).toBeGreaterThanOrEqual(60);
            for (const sample of report.samples) {
              expect(sample.cost.statements).toBe(4);
              expect(sample.cost.rows).toBeLessThanOrEqual(8 * (limit + 1));
            }
            console.log(
              JSON.stringify({
                predicate: [state, typeId],
                limit,
                dimension,
                evidence: report.samples.map((s) => ({
                  scale: s.scale,
                  rows: s.cost.rows,
                  blocks: s.cost.blocks,
                  statements: s.cost.statements,
                })),
              }),
            );
          }
  } finally {
    client.release();
  }
});

test('created asc rejects impossible reader inputs before querying', async () => {
  const query: ShelfQuery = { state: null, typeId: null, orderBy: 'createdAt', direction: 'asc', limit: 1 };
  let calls = 0;
  const client = {
    query: () => {
      calls++;
      throw new Error('Invalid input reached SQL');
    },
  } as unknown as Parameters<typeof reader.page>[0];
  for (const bad of [
    { orderBy: 'finishedAt' },
    { direction: 'desc' },
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
    { state: undefined },
    { typeId: 'schema:Book' },
    { typeId: undefined },
  ])
    await expect(reader.page(client, route, owner, { ...query, ...bad } as ShelfQuery, null)).rejects.toBeInstanceOf(
      Error,
    );
  for (const key of ['', 'not-a-date', '2026-02-30T00:00:00Z', '2026-10-27T25:00:00Z'])
    await expect(reader.page(client, route, owner, query, { key, subjectId: id(1) })).rejects.toBeInstanceOf(TypeError);
  await expect(
    reader.page(client, route, owner, query, { key: key(1), subjectId: 'schema:Book' }),
  ).rejects.toBeInstanceOf(TypeError);
  expect(calls).toBe(0);
});
