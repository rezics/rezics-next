import { afterAll, expect, test } from 'bun:test';
import { createPool } from '../../src/database/pool';
import {
  createTrendingSearchesService,
  literalQuery,
  publicTerm,
  reduceTrendingCandidates,
  trendingLiteral,
  trendingSearchStore,
  type TrendingCandidate,
} from '../../src/search/trending-searches';

const now = Date.parse('2026-10-31T12:00:00Z');
const source = crypto.randomUUID();
const term = publicTerm(source, 'en', 'The Little Prince')!;
const accounts = Array.from({ length: 16 }, () => crypto.randomUUID());
const candidate: TrendingCandidate = { ...term, members: accounts.map((account) => ({ account, at: now - 1000 })) };
const labels = new Map([[source, [{ language: 'en', value: term.display }]]]);
const reduce = (row: TrendingCandidate, allowed = accounts, current = labels) =>
  reduceTrendingCandidates([row], now, current, new Set(allowed), 10);

test('closed private/advanced queries and arbitrary syntax cannot become literal contributions', () => {
  for (const body of [
    { text: '-Prince' },
    { text: 'Prince | Fox' },
    { text: 'Prince Fox' },
    { text: 'Prince', filter: {} },
    { text: 'Prince', sort: 'rating' as const },
    { text: 'Prince', cursor: 'private' },
  ])
    expect(trendingLiteral(body)).toBeNull();
  expect(trendingLiteral({ text: '"The Little Prince"' })).toBe(term.display);
  expect(literalQuery('a "quote" \\ path')).toBe('"a \\"quote\\" \\\\ path"');
  expect(literalQuery('x'.repeat(257))).toBeNull();
});
test('only ten distinct current Account contributors and the actual current public label qualify', () => {
  expect(reduce(candidate, accounts.slice(0, 9)).trendingSearches).toEqual([]);
  expect(
    reduce({ ...candidate, members: Array.from({ length: 16 }, () => candidate.members[0]!) }).trendingSearches,
  ).toEqual([]);
  expect(reduce(candidate, accounts.slice(0, 10))).toEqual({
    trendingSearches: [{ query: '"The Little Prince"', display: term.display }],
    next: null,
  });
  expect(reduce(candidate, accounts, new Map()).trendingSearches).toEqual([]);
  expect(
    reduce({ ...candidate, members: candidate.members.map((member) => ({ ...member, at: now - 7 * 86_400_000 })) })
      .trendingSearches,
  ).toEqual([]);
});

const pool = createPool(process.env.DATABASE_URL ?? 'postgres://kernel.invalid/trending');
afterAll(async () => {
  await pool.end();
});
test('missing current identity/definition binding prepares without reading or writing contributions', async () => {
  const service = createTrendingSearchesService({ pool });
  expect(await service.read('en', 10)).toEqual({ status: 'preparing' });
  expect(await service.submitted({ kind: 'anonymous' }, { text: 'Prince' })).toBe('excluded');
  await expect(service.read('en', 0)).rejects.toThrow();
});
// The ordinary kernel runner supplies a migrated database. No new native harness or permission fixture.
test('native projection deduplicates daily contributions and withdrawal blocks late replay', async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
  const store = trendingSearchStore(pool, () => new Date(now));
  try {
    for (const account of accounts.slice(0, 10)) await store.contribute(term, account);
    expect((await store.contribute(term, accounts[0]!)).value).toBe(false);
    const rows = await store.candidates('en', now);
    const stored = rows.find((row) => row.key === term.key)!;
    expect(stored.members).toHaveLength(10);
    expect(reduce(stored).trendingSearches).toHaveLength(1);
    await store.withdraw('account', accounts[0]!);
    expect((await store.contribute(term, accounts[0]!)).value).toBe(false);
    expect(reduce((await store.candidates('en', now)).find((row) => row.key === term.key)!).trendingSearches).toEqual(
      [],
    );
    await store.withdraw('source', source);
    expect((await store.contribute(term, accounts[1]!)).value).toBe(false);
    expect((await store.candidates('en', now)).some((row) => row.key === term.key)).toBe(false);
  } finally {
    await pool.query('DELETE FROM search.trending_term WHERE route=0 AND term_key=$1', [term.key]);
    await pool.query('DELETE FROM search.trending_blocked WHERE route=0 AND identity=ANY($1::uuid[])', [
      [source, ...accounts],
    ]);
  }
});

test('bounded candidates repair withdrawn and expired contributor ranks', async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
  const day = 86_400_000;
  const source = crypto.randomUUID(),
    withdrawn = crypto.randomUUID(),
    expired = crypto.randomUUID(),
    cleanupAccount = crypto.randomUUID();
  const eligible = Array.from({ length: 10 }, () => crypto.randomUUID());
  const current = publicTerm(source, 'en', 'Current')!,
    past = publicTerm(source, 'en', 'Expired')!,
    cleanup = publicTerm(source, 'en', 'Cleanup')!;
  const store = trendingSearchStore(pool, () => new Date(now));
  try {
    await pool.query(
      `WITH fixture AS (
        SELECT repeat(md5($1::uuid::text||'-stale-'||n::text),2) key,'Stale '||n display,16 rank,$2::timestamptz expiry FROM generate_series(1,10) AS sequence(n)
        UNION ALL SELECT $3,$4,10,$2 UNION ALL SELECT $5,$6,16,$7 UNION ALL SELECT $8,$9,2,$2
      ) INSERT INTO search.trending_term(route,term_key,language,source_id,display,rank,expires_at)
      SELECT 0,key,'en',$1::uuid,display,rank,expiry FROM fixture`,
      [
        source,
        new Date(now + 7 * day),
        current.key,
        current.display,
        past.key,
        past.display,
        new Date(now - 1),
        cleanup.key,
        cleanup.display,
      ],
    );
    await pool.query(
      `WITH fixture AS (
        SELECT repeat(md5($1::uuid::text||'-stale-'||n::text),2) key,$2::uuid account,$5::date day,$6::timestamptz at FROM generate_series(1,10) AS sequence(n)
        UNION ALL SELECT $3,account_id,$5,$6 FROM unnest($4::uuid[]) AS accounts(account_id)
        UNION ALL SELECT $7,$8,$5,$6 UNION ALL SELECT $7,$9,$10,$11
      ) INSERT INTO search.trending_member(route,term_key,account_id,day,contributed_at)
      SELECT 0,key,account,day,at FROM fixture`,
      [
        source,
        withdrawn,
        current.key,
        eligible,
        new Date(now).toISOString().slice(0, 10),
        new Date(now),
        cleanup.key,
        cleanupAccount,
        expired,
        new Date(now - 7 * day).toISOString().slice(0, 10),
        new Date(now - 7 * day),
      ],
    );
    expect((await store.contribute(cleanup, cleanupAccount)).value).toBe(false);
    await store.withdraw('account', withdrawn);
    const refreshed = await pool.query<{ display: string; rank: number; expires_at: Date }>(
      "SELECT display,rank,expires_at FROM search.trending_term WHERE source_id=$1 AND display IN ('Stale 1','Cleanup') ORDER BY display",
      [source],
    );
    expect(
      refreshed.rows.map(({ display, rank, expires_at }) => [display, Number(rank), expires_at.getTime()]),
    ).toEqual([
      ['Cleanup', 1, now + 7 * day],
      ['Stale 1', 0, now],
    ]);
    const page = await store.candidates('en', now);
    expect(page.some((term) => term.key === current.key)).toBe(true);
    expect(page.some((term) => term.key === past.key)).toBe(false);
  } finally {
    await pool.query('DELETE FROM search.trending_term WHERE route=0 AND source_id=$1', [source]);
    await pool.query('DELETE FROM search.trending_blocked WHERE route=0 AND identity=$1', [withdrawn]);
  }
});
