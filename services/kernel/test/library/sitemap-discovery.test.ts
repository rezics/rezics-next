import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import type pg from 'pg';
import { readSitemapCandidates } from '../../src/library/sitemap-discovery.ts';
import sitemapPage from '../../src/library/sitemap-page.sql';
import { openGrowthDatabase, settle, type GrowthDatabase } from '../support/growth.ts';
import { checkStatement } from '../support/partition-binding.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
let db: GrowthDatabase;
let pool: pg.Pool;

const partition = 0x7a1;
const first = partition * 16;
const neighbour = partition + 1;
let generation = 0;

type Kind = 'public' | 'unlisted' | 'private' | 'deleted';

function id(route: number, n: number, prefix = '00000000'): string {
  const uniqueOrdinal = (generation * 10_000 + n).toString(16).padStart(8, '0');
  return `${prefix}-0000-7000-8000-${route.toString(16).padStart(4, '0')}${uniqueOrdinal}`;
}

async function insert(rows: { route: number; id: string; kind: Kind; updatedAt?: string }[]): Promise<void> {
  await pool.query(
    `INSERT INTO library.collection
       (route, collection_id, curator_account_id, title, visibility, state, revision, created_at, updated_at, transaction_id)
     SELECT row.route, row.id, ('00000000-0000-7000-8000-' || lpad(to_hex(row.route), 4, '0') || '000000ff')::uuid,
            'Collection', CASE WHEN row.kind = 'deleted' THEN 'public' ELSE row.kind END,
            CASE WHEN row.kind = 'deleted' THEN 'deleted' ELSE 'active' END, 1,
            '2026-01-01'::timestamptz, COALESCE(row.updated_at, '2026-02-03T04:05:06.123456Z')::timestamptz, row.id
     FROM jsonb_to_recordset($1::jsonb) AS row(route integer, id uuid, kind text, updated_at text)`,
    [JSON.stringify(rows.map((row) => ({ route: row.route, id: row.id, kind: row.kind, updated_at: row.updatedAt })))],
  );
}

async function clear(): Promise<void> {
  await pool.query('DELETE FROM library.collection WHERE route >= $1 AND route < $2', [
    first - 16,
    (neighbour + 1) * 16,
  ]);
}

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
  pool = db.admin;
  await clear();
});
beforeEach(async () => {
  generation++;
  await clear();
});
afterAll(async () => {
  try {
    await clear();
  } finally {
    await db?.close();
  }
});

test('pages walk a partition in route then id order and resume after the last candidate', async () => {
  // Ids are chosen so native uuid order disagrees with route order: the later route has the smaller leading bytes.
  await insert([
    { route: first + 2, id: id(first + 2, 1, '00000000'), kind: 'public' },
    { route: first + 2, id: id(first + 2, 2, '00000000'), kind: 'public' },
    { route: first, id: id(first, 1, 'ffff0000'), kind: 'public' },
    { route: first + 1, id: id(first + 1, 1, 'ffff0000'), kind: 'public' },
    { route: first + 1, id: id(first + 1, 2, 'ffff0000'), kind: 'public' },
  ]);
  const everything = await readSitemapCandidates(pool, { partition, after: null, limit: 100 });
  expect(everything.map((candidate) => candidate.id)).toEqual([
    id(first, 1, 'ffff0000'),
    id(first + 1, 1, 'ffff0000'),
    id(first + 1, 2, 'ffff0000'),
    id(first + 2, 1, '00000000'),
    id(first + 2, 2, '00000000'),
  ]);
  expect(everything.map((candidate) => candidate.route)).toEqual([first, first + 1, first + 1, first + 2, first + 2]);

  const walked: string[] = [];
  let after: { route: number; id: string } | null = null;
  for (let pages = 0; pages < 10; pages++) {
    const page = await readSitemapCandidates(pool, { partition, after, limit: 2 });
    expect(page.length).toBeLessThanOrEqual(2);
    if (page.length === 0) break;
    walked.push(...page.map((candidate) => candidate.id));
    const last = page.at(-1)!;
    after = { route: last.route, id: last.id };
  }
  expect(walked).toEqual(everything.map((candidate) => candidate.id));
});

test('a checkpoint that no longer exists is still a valid boundary', async () => {
  await insert([
    { route: first, id: id(first, 1), kind: 'public' },
    { route: first, id: id(first, 3), kind: 'public' },
  ]);
  const page = await readSitemapCandidates(pool, { partition, after: { route: first, id: id(first, 2) }, limit: 10 });
  expect(page.map((candidate) => candidate.id)).toEqual([id(first, 3)]);
});

test('identical timestamps and identical trailing ids on different routes are all returned once', async () => {
  const rows = [first, first + 7, first + 15].flatMap((route) => [
    { route, id: id(route, 5), kind: 'public' as const, updatedAt: '2026-03-04T05:06:07.000001Z' },
    { route, id: id(route, 6), kind: 'public' as const, updatedAt: '2026-03-04T05:06:07.000001Z' },
  ]);
  await insert(rows);
  const all = await readSitemapCandidates(pool, { partition, after: null, limit: 100 });
  expect(all.map((candidate) => candidate.id)).toEqual(rows.map((row) => row.id));
  expect(new Set(all.map((candidate) => candidate.updatedAt))).toEqual(new Set(['2026-03-04T05:06:07.000001Z']));
  const rest = await readSitemapCandidates(pool, {
    partition,
    after: { route: first + 7, id: id(first + 7, 5) },
    limit: 100,
  });
  expect(rest.map((candidate) => candidate.id)).toEqual([id(first + 7, 6), id(first + 15, 5), id(first + 15, 6)]);
});

test('the final route of a partition ends the walk without entering the next partition', async () => {
  await insert([
    { route: first + 15, id: id(first + 15, 1), kind: 'public' },
    { route: neighbour * 16, id: id(neighbour * 16, 1), kind: 'public' },
    { route: first - 1, id: id(first - 1, 1), kind: 'public' },
  ]);
  const page = await readSitemapCandidates(pool, { partition, after: null, limit: 4000 });
  expect(page.map((candidate) => candidate.id)).toEqual([id(first + 15, 1)]);
  const done = await readSitemapCandidates(pool, {
    partition,
    after: { route: first + 15, id: id(first + 15, 1) },
    limit: 10,
  });
  expect(done).toEqual([]);
  const other = await readSitemapCandidates(pool, { partition: neighbour, after: null, limit: 10 });
  expect(other.map((candidate) => candidate.id)).toEqual([id(neighbour * 16, 1)]);
});

test('private, unlisted and deleted Collections are never candidates', async () => {
  await insert([
    { route: first, id: id(first, 1), kind: 'private' },
    { route: first, id: id(first, 2), kind: 'unlisted' },
    { route: first, id: id(first, 3), kind: 'deleted' },
    { route: first, id: id(first, 4), kind: 'public' },
    { route: first + 1, id: id(first + 1, 1), kind: 'deleted' },
  ]);
  const page = await readSitemapCandidates(pool, { partition, after: null, limit: 10 });
  expect(page).toEqual([{ route: first, id: id(first, 4), updatedAt: '2026-02-03T04:05:06.123456Z' }]);
});

test('the stored timestamp is returned exactly, to the microsecond, as UTC text', async () => {
  await insert([
    { route: first, id: id(first, 1), kind: 'public', updatedAt: '2026-10-27T01:02:03.100000+02:00' },
    { route: first, id: id(first, 2), kind: 'public', updatedAt: '2026-10-27T01:02:03.999999Z' },
    { route: first, id: id(first, 3), kind: 'public', updatedAt: '2026-10-27T01:02:03Z' },
  ]);
  const page = await readSitemapCandidates(pool, { partition, after: null, limit: 10 });
  expect(page.map((candidate) => candidate.updatedAt)).toEqual([
    '2026-10-26T23:02:03.100000Z',
    '2026-10-27T01:02:03.999999Z',
    '2026-10-27T01:02:03.000000Z',
  ]);
  expect(Object.keys(page[0]!).sort()).toEqual(['id', 'route', 'updatedAt']);
});

test('rejects bounds outside the contract before querying', async () => {
  const client = {
    query: () => {
      throw new Error('must not query');
    },
  } as unknown as Pick<pg.PoolClient, 'query'>;
  const call = (input: Parameters<typeof readSitemapCandidates>[1]) => readSitemapCandidates(client, input);
  for (const bad of [-1, 4096, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
    expect(call({ partition: bad, after: null, limit: 10 })).rejects.toThrow(RangeError);
  for (const bad of [0, -1, 4001, 2.5, Number.NaN, Number.POSITIVE_INFINITY])
    expect(call({ partition, after: null, limit: bad })).rejects.toThrow(RangeError);
  // Foreign partition, a route one past the interval, and an id whose route differs from the stated route.
  expect(call({ partition, after: { route: first - 1, id: id(first - 1, 1) }, limit: 10 })).rejects.toThrow(RangeError);
  expect(call({ partition, after: { route: first + 16, id: id(first + 16, 1) }, limit: 10 })).rejects.toThrow(
    RangeError,
  );
  expect(call({ partition, after: { route: first, id: id(first + 1, 1) }, limit: 10 })).rejects.toThrow(RangeError);
  expect(call({ partition, after: { route: first, id: 'not-an-id' }, limit: 10 })).rejects.toThrow(RangeError);
  expect(call({ partition, after: { route: 1.5, id: id(first, 1) }, limit: 10 })).rejects.toThrow(TypeError);
  // The largest valid budget is accepted.
  expect(readSitemapCandidates(pool, { partition, after: null, limit: 4000 })).resolves.toEqual([]);
});

test('Collection sitemap discovery seeks within one partition and never scans rejected rows', async () => {
  // Every route holds thousands of Collections, hidden ones interleaved with the public ones, so a plan that
  // filtered after reading would have to read and reject many rows.
  const generate = (from: number, to: number, count: number) =>
    pool.query(
      `INSERT INTO library.collection
         (route, collection_id, curator_account_id, title, visibility, state, revision, created_at, updated_at, transaction_id)
       SELECT route, id, ('00000000-0000-7000-8000-' || lpad(to_hex(route), 4, '0') || '000000ff')::uuid,
              'Collection', CASE WHEN n % 9 = 0 THEN 'private' WHEN n % 9 = 3 THEN 'unlisted' ELSE 'public' END,
              CASE WHEN n % 9 = 6 THEN 'deleted' ELSE 'active' END, 1, '2026-01-01'::timestamptz,
              '2026-02-03T04:05:06.123456Z'::timestamptz, id
       FROM (
         SELECT r AS route, n,
                ('00000000-0000-7000-8000-' || lpad(to_hex(r), 4, '0') ||
                 lpad(to_hex(n + $4::int), 8, '0'))::uuid AS id
         FROM generate_series($1::int, $2::int) AS r, generate_series(1, $3::int) AS n
       ) AS source`,
      [from, to, count, generation * 10_000],
    );
  await generate(first, first + 15, 3000);
  // Neighbouring routes sit just outside the interval: a plan that did not stop at it would read or return them.
  await generate(first - 1, first - 1, 500);
  await generate(neighbour * 16, neighbour * 16, 500);
  await settle(db, { relations: ['library.collection'], analyze: true });

  const { rows: publicRows } = await pool.query<{ route: number; id: string }>(
    `SELECT route, collection_id::text AS id FROM library.collection
     WHERE route >= $1 AND route < $2 AND state = 'active' AND visibility = 'public'
     ORDER BY route, collection_id`,
    [first, first + 16],
  );
  const explain = async (after: { route: number; id: string } | null, limit: number) => {
    const { rows: plan } = await pool.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${sitemapPage.sql}`,
      [partition, after?.route ?? first - 1, after?.id ?? 'ffffffff-ffff-ffff-ffff-ffffffffffff', limit],
    );
    return plan[0]!['QUERY PLAN'][0]!.Plan;
  };
  for (const [after, limit] of [
    [null, 20],
    [{ route: first + 3, id: id(first + 3, 8) }, 20],
    [null, 4000],
  ] as const) {
    const label = `${after ? 'continuation' : 'first'} page, budget ${limit}`;
    const plan = await explain(after, limit);
    const nodes = flatten(plan);
    expect(
      nodes.map((node) => node['Node Type']).filter((type) => type.includes('Seq Scan')),
      label,
    ).toEqual([]);
    const indexed = nodes.filter((node) => node['Index Name']);
    expect(
      indexed.map((node) => node['Index Name']),
      label,
    ).toEqual(['collection_sitemap_public_page']);
    expect(
      nodes.reduce((sum, node) => sum + (node['Rows Removed by Filter'] ?? 0), 0),
      label,
    ).toBe(0);
    expect(
      nodes.reduce((sum, node) => sum + (node['Rows Removed by Index Recheck'] ?? 0), 0),
      label,
    ).toBe(0);
    expect(indexed[0]!['Index Cond'], label).toContain('route >=');
    expect(indexed[0]!['Index Cond'], label).toContain('route <');
    const expected = publicRows.filter(
      (row) => after === null || row.route > after.route || (row.route === after.route && row.id > after.id),
    );
    expect(plan['Actual Rows'], label).toBe(Math.min(limit, expected.length));
    // A budget far below the candidates is satisfied by one ordered range that stops at the budget.
    if (limit === 20) {
      expect(
        nodes.map((node) => node['Node Type']).filter((type) => type === 'Sort'),
        label,
      ).toEqual([]);
      expect(indexed[0]!['Node Type'], label).toMatch(/^Index (Only )?Scan$/);
      expect(indexed[0]!['Actual Rows'], label).toBe(limit);
    }
  }

  const client = await pool.connect();
  try {
    expect(await checkStatement(client, { sql: sitemapPage.sql, params: [...sitemapPage.params] })).toEqual({
      bound: true,
      parameter: 'partition_no',
    });
  } finally {
    client.release();
  }
});

type PlanNode = {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  'Actual Rows': number;
  'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number;
  Plans?: PlanNode[];
};

function flatten(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(flatten)];
}
