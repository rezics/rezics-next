import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { GRAPHS, RV } from '../../../services/main/src/modules/work/activate.ts';
import { identityHarness } from './source-identity-harness.ts';

const short = (value: string) => value.split('/').at(-1)!;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('LIVE08: current Open Library ratings and reading-log counts remain source-only', async () => {
  // The public aggregate surfaces expose counts, not per-user score identities.
  // The authored provider-user counterexample is in source-score.test.ts.
  const workId = 'OL18020194W';
  const h = await identityHarness({ realAccount: true, acquisition: 'live' });
  const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL! });
  try {
    const accountsBefore = (await accountPool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM public."user"')).rows[0]!.n;
    const nativeBefore = await h.fuseki.query(`ASK { GRAPH <${GRAPHS.current}> {
      ?observation a <${RV}RatingObservation> } }`);
    const key = randomUUID();
    const request = { profile: 'open-library-works-run-v1', workIds: [workId],
      editions: false, ratings: true, bookshelves: true, frontier: false };
    const response = await h.post('/v1/sources/acquisitions', 'owner', request, key);
    expect(response.status).toBe(201);
    const run = await response.json() as { run: { run: string; state: string;
      surfaces: Array<{ surface: string; outcome: { outcome: string };
        captures: Array<{ observation: string; record: string; byteDigest: string }> }> } };
    expect(run.run.state).toBe('completed');
    const ratings = run.run.surfaces.find(surface => surface.surface === 'ratings')!;
    const bookshelves = run.run.surfaces.find(surface => surface.surface === 'bookshelves')!;
    expect(ratings.outcome.outcome).toBe('qualified');
    expect(bookshelves.outcome.outcome, JSON.stringify(bookshelves.outcome)).toBe('qualified');
    const rating = ratings.captures[0]!;
    const shelf = bookshelves.captures[0]!;
    expect(rating.record).not.toBe(shelf.record);
    const captured = (await h.pool.query<{ id: string; raw_bytes: Buffer; byte_digest: string;
      namespace: string }>(`SELECT o.id, o.raw_bytes, o.byte_digest, r.namespace
      FROM source.observation o JOIN source.record r ON r.id = o.record_id
      WHERE o.id IN ($1,$2)`, [short(rating.observation), short(shelf.observation)])).rows;
    const ratingRow = captured.find(row => row.id === short(rating.observation))!;
    const shelfRow = captured.find(row => row.id === short(shelf.observation))!;
    expect(ratingRow.namespace).toBe('work-ratings');
    expect(shelfRow.namespace).toBe('work-bookshelves');
    expect(ratingRow.byte_digest).toBe(sha(ratingRow.raw_bytes));
    expect(shelfRow.byte_digest).toBe(sha(shelfRow.raw_bytes));
    const plan = (await h.pool.query<{ 'QUERY PLAN': Array<{ Plan: {
      'Actual Rows': number; 'Shared Hit Blocks': number; 'Shared Read Blocks': number;
      'Temp Read Blocks': number } }> }>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON, TIMING OFF)
      SELECT record_id, raw_bytes, byte_digest, retention, coverage, media_type
      FROM source.observation WHERE id = $1 AND principal_id = $2`,
    [short(rating.observation), h.principalId])).rows[0]!['QUERY PLAN'][0]!.Plan;
    expect(plan['Actual Rows']).toBe(1);
    expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThan(32);
    expect(plan['Temp Read Blocks']).toBe(0);
    const currentRating = JSON.parse(ratingRow.raw_bytes.toString('utf8')) as {
      summary: { average: number; count: number } };
    const currentShelves = JSON.parse(shelfRow.raw_bytes.toString('utf8')) as {
      counts: { want_to_read: number; currently_reading: number; already_read: number } };
    expect(currentRating.summary.count).toBeGreaterThan(0);
    expect(currentShelves.counts.want_to_read).toBeGreaterThan(0);
    const statistic = await h.post('/v1/sources/statistics', 'owner', {
      profile: 'source-statistic-v1', observation: rating.observation,
      kind: 'aggregate-score', scorePointer: '/summary/average', userPointer: null }, randomUUID());
    expect(statistic.status).toBe(201);
    const source = await statistic.json() as { statistic: { statistic: string; score: string;
      sourceScore: string; valuePrecision: string; nativeEffect: string } };
    expect(source.statistic).toMatchObject({ nativeEffect: 'none',
      sourceScore: String(currentRating.summary.average),
      score: currentRating.summary.average.toFixed(6),
      valuePrecision: Number(currentRating.summary.average.toFixed(6)) === currentRating.summary.average
        ? 'exact' : 'rounded-to-six-decimals' });
    expect((await h.get(`/v1/sources/statistics/${short(source.statistic.statistic)}`, 'owner')).status).toBe(200);
    expect((await h.post('/v1/sources/acquisitions', 'owner', request, key)).status).toBe(200);
    expect((await h.fuseki.query(`ASK { GRAPH <${GRAPHS.current}> {
      ?observation a <${RV}RatingObservation> } }`)).boolean).toBe(nativeBefore.boolean);
    expect((await accountPool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM public."user"')).rows[0]!.n).toBe(accountsBefore);
    expect((await h.pool.query('SELECT count(*)::int AS n FROM source.statistic WHERE observation_id = $1',
      [short(shelf.observation)])).rows[0]?.n).toBe(0);
  } finally { await accountPool.end(); await h.close(); }
}, 60_000);
