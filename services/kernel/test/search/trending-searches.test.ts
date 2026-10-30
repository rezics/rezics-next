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
