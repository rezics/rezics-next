import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readSitemapCandidates, type SitemapAfter } from '../../src/library/sitemap-discovery.ts';
import { checkGrowth, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');

const partition = 0x6b4;
const first = partition * 16;
const scales = [256, 1024, 4096] as const;
const bounds = { rows: 'constant', blocks: 'logarithmic', statements: 'constant' } as const;
const PAGE = 20;
const MAXIMUM = 4000;
// 16 routes of 2000 fixed public Collections keep every page, up to the maximum budget, a fraction of the partition.
const FIXED_PER_ROUTE = 2000;
const COLUMNS = `(route, collection_id, curator_account_id, title, visibility, state, revision, created_at, updated_at, transaction_id)`;
let db: GrowthDatabase;
let generation = 0;

beforeAll(async () => {
  db = await openGrowthDatabase(databaseUrl);
});

afterAll(async () => {
  await db?.admin.query('DELETE FROM library.collection WHERE route >= $1 AND route < $2', [first, first + 16]);
  await db?.close();
});

function fixedId(route: number, ordinal: number, run: number): string {
  const uniqueOrdinal = (run * 5000 + ordinal).toString(16).padStart(8, '0');
  return `10000000-0000-7000-8000-${route.toString(16).padStart(4, '0')}${uniqueOrdinal}`;
}

async function seedFixed(database: GrowthDatabase, hidden: number, run: number): Promise<void> {
  await database.admin.query('DELETE FROM library.collection WHERE route >= $1 AND route < $2', [first, first + 16]);
  await database.admin.query(
    `INSERT INTO library.collection ${COLUMNS}
     SELECT route, id, ('10000000-0000-7000-8000-' || lpad(to_hex(route), 4, '0') || '000000ff')::uuid,
            'Fixed public', 'public', 'active', 1, '2026-01-01'::timestamptz, '2026-05-01'::timestamptz, id
     FROM (
       SELECT r AS route,
              ('10000000-0000-7000-8000-' || lpad(to_hex(r), 4, '0') || lpad(to_hex(n + $4::int), 8, '0'))::uuid AS id
       FROM generate_series($1::int, $2::int) AS r, generate_series(1, $3::int) AS n
     ) AS source`,
    [first, first + 15, FIXED_PER_ROUTE, run * 5000],
  );
  if (hidden > 0) await growHidden(database, 0, hidden);
}

/**
 * Private, unlisted and deleted Collections spread over all routes. Their ids sort before, among the end of, and after
 * the fixed public ids, so a scan that filters afterwards would have to read them.
 */
async function growHidden(database: GrowthDatabase, previous: number, scale: number): Promise<void> {
  await database.admin.query(
    `INSERT INTO library.collection ${COLUMNS}
     SELECT route, id, ('10000000-0000-7000-8000-' || lpad(to_hex(route), 4, '0') || '000000ff')::uuid,
            'Hidden', CASE WHEN n % 9 < 3 THEN 'private' WHEN n % 9 < 6 THEN 'unlisted' ELSE 'public' END,
            CASE WHEN n % 9 >= 6 THEN 'deleted' ELSE 'active' END, 1,
            '2026-01-01'::timestamptz, '2026-06-01'::timestamptz, id
     FROM (
       SELECT n, $1::int + (n % 16) AS route,
              ((ARRAY['00000000', '10000000', '20000000'])[1 + n % 3] || '-0000-7000-8000-'
                || lpad(to_hex($1::int + (n % 16)), 4, '0') || lpad(to_hex(100000 + n), 8, '0'))::uuid AS id
       FROM generate_series($2::int + 1, $3::int) AS n
     ) AS source`,
    [first, previous, scale],
  );
}

/**
 * Public Collections beyond the fixed ones, all on the last route and after every fixed id. The measured pages keep
 * the same candidates at every scale, so only the size of the surrounding index differs.
 */
async function growPublic(database: GrowthDatabase, previous: number, scale: number, run: number): Promise<void> {
  await database.admin.query(
    `INSERT INTO library.collection ${COLUMNS}
     SELECT $1::int, id, ('10000000-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') || '000000ff')::uuid,
            'Growing public', 'public', 'active', 1, '2026-01-01'::timestamptz, '2026-06-02'::timestamptz, id
     FROM (
       SELECT ('20000001-0000-7000-8000-' || lpad(to_hex($1::int), 4, '0') ||
               lpad(to_hex(n + $4::int), 8, '0'))::uuid AS id
       FROM generate_series($2::int + 1, $3::int) AS n
     ) AS source`,
    [first + 15, previous, scale, run * 5000],
  );
}

/** Unmeasured full verification of a page against the table, outside the instrumented pool. */
async function verify(
  database: GrowthDatabase,
  page: Awaited<ReturnType<typeof readSitemapCandidates>>,
  after: SitemapAfter | null,
  budget: number,
): Promise<void> {
  expect(page).toHaveLength(budget);
  for (const [index, candidate] of page.entries()) {
    expect(candidate.route >>> 4).toBe(partition);
    const previous = page[index - 1] ?? after;
    if (previous)
      expect(
        candidate.route > previous.route || (candidate.route === previous.route && candidate.id > previous.id),
      ).toBe(true);
  }
  const { rows } = await database.admin.query<{ visible: string }>(
    `SELECT count(*)::text AS visible FROM library.collection
     WHERE route = ANY($1::int[]) AND collection_id = ANY($2::uuid[]) AND state = 'active' AND visibility = 'public'
       AND (route, collection_id) IN (SELECT * FROM unnest($1::int[], $2::uuid[]))`,
    [page.map((candidate) => candidate.route), page.map((candidate) => candidate.id)],
  );
  expect(Number(rows[0]!.visible)).toBe(budget);
}

type Dimension = 'hidden' | 'public';

function check(dimension: Dimension, budget: number): () => Promise<void> {
  return async () => {
    for (const position of ['first', 'continuation'] as const) {
      const run = generation++;
      const after = position === 'first' ? null : { route: first, id: fixedId(first, 100, run) };
      await checkGrowth(db, {
        name: `Collection sitemap discovery cost stays bounded as public and hidden Collections grow (${dimension} rows, ${position} page, budget ${budget})`,
        scales,
        bounds,
        warmups: 1,
        async grow(database, scale, previous) {
          if (previous === 0) await seedFixed(database, dimension === 'hidden' ? 0 : scales.at(-1)!, run);
          if (dimension === 'hidden') await growHidden(database, previous, scale);
          else await growPublic(database, previous, scale, run);
        },
        async warmup(database) {
          await verify(
            database,
            await readSitemapCandidates(db.pool, { partition, after, limit: budget }),
            after,
            budget,
          );
        },
        async operation() {
          const page = await readSitemapCandidates(db.pool, { partition, after, limit: budget });
          expect(page).toHaveLength(budget);
        },
      });
    }
  };
}

test('Collection sitemap discovery cost stays bounded as public and hidden Collections grow', async () => {
  // Hidden rows grow with public rows fixed, then public rows grow with hidden rows fixed. Page 20 and the
  // maximum budget are separate checks so a cost that scales with the budget cannot hide in the small page.
  await check('hidden', PAGE)();
  await check('hidden', MAXIMUM)();
  await check('public', PAGE)();
  await check('public', MAXIMUM)();
}, 300_000);
