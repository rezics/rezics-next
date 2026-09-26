import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { GRAPHS, RV } from '../../../services/main/src/modules/work/activate.ts';
import { identityHarness, iri } from './source-identity-harness.ts';

const short = (value: string) => value.split('/').at(-1)!;

test('LIVE08: retained provider score and user key stay source statistics without native identity', async () => {
  const h = await identityHarness({ realAccount: true, acquisition: true });
  const accountPool = new Pool({ connectionString: Bun.env.ACCOUNT_DATABASE_URL! });
  try {
    const accountCount = (await accountPool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM public."user"')).rows[0]!.n;
    const record = await h.record('score-work');
    const observation = await h.observation(record,
      '{"summary":{"score":8.25},"votes":[{"user":"provider-user-7","score":9}]}');
    const aggregate = { profile: 'source-statistic-v1', observation: iri(observation),
      kind: 'aggregate-score', scorePointer: '/summary/score', userPointer: null };
    expect((await h.post('/v1/sources/statistics', 'reader', aggregate, randomUUID())).status).toBe(401);
    expect((await h.post('/v1/sources/statistics', 'other', aggregate, randomUUID())).status).toBe(404);
    const key = randomUUID();
    const raced = await Promise.all([h.post('/v1/sources/statistics', 'owner', aggregate, key),
      h.post('/v1/sources/statistics', 'owner', aggregate, key)]);
    expect(raced.map(response => response.status).sort()).toEqual([200, 201]);
    const created = raced.find(response => response.status === 201)!;
    const first = await created.json() as { statistic: { statistic: string; score: string;
      nativeEffect: string; providerUserKey: string | null }; replayed: boolean };
    expect(first.statistic).toMatchObject({ score: '8.250000', nativeEffect: 'none', providerUserKey: null });
    expect((await h.post('/v1/sources/statistics', 'owner', aggregate, key)).status).toBe(200);
    expect((await h.post('/v1/sources/statistics', 'owner', { ...aggregate,
      scorePointer: '/votes/0/score' }, key)).status).toBe(409);
    expect((await h.post('/v1/sources/statistics', 'owner', { ...aggregate,
      scorePointer: '/missing' }, randomUUID())).status).toBe(400);
    const user = { ...aggregate, kind: 'provider-user-score', scorePointer: '/votes/0/score',
      userPointer: '/votes/0/user' };
    const imported = await h.post('/v1/sources/statistics', 'owner', user, randomUUID());
    expect(imported.status).toBe(201);
    const second = await imported.json() as { statistic: { providerUserKey: string; nativeEffect: string } };
    expect(second.statistic).toMatchObject({ providerUserKey: 'provider-user-7', nativeEffect: 'none' });
    const precise = await h.observation(record, '{"average":4.192234848484849}');
    const preciseResult = await h.post('/v1/sources/statistics', 'owner', {
      ...aggregate, observation: iri(precise), scorePointer: '/average' }, randomUUID());
    expect(preciseResult.status).toBe(201);
    expect((await preciseResult.json() as { statistic: { score: string; sourceScore: string;
      valuePrecision: string } }).statistic).toMatchObject({ score: '4.192235',
        sourceScore: '4.192234848484849', valuePrecision: 'rounded-to-six-decimals' });
    h.provider.work('OL991901W', 1);
    h.provider.ratings.set('OL991901W', { summary: { average: 4.2, count: 11 }, counts: { 5: 5 } });
    const nativeRatings = () => h.fuseki.query(`ASK { GRAPH <${GRAPHS.current}> {
      ?observation a <${RV}RatingObservation> } }`);
    const beforeNative = await nativeRatings();
    const captured = await h.post('/v1/sources/acquisitions', 'owner', {
      profile: 'open-library-works-run-v1', workIds: ['OL991901W'],
      editions: false, ratings: true, frontier: false }, randomUUID());
    expect(captured.status).toBe(201);
    const run = await captured.json() as { run: { surfaces: Array<{ surface: string;
      outcome: { outcome: string } | null; captures: Array<{ observation: string }> }> } };
    const ratingSurface = run.run.surfaces.find(surface => surface.surface === 'ratings');
    expect(ratingSurface?.outcome?.outcome).toBe('qualified');
    const ratedObservation = ratingSurface?.captures[0]?.observation;
    expect(ratedObservation).toBeString();
    const fromRun = await h.post('/v1/sources/statistics', 'owner', {
      ...aggregate, observation: ratedObservation, scorePointer: '/summary/average' }, randomUUID());
    expect(fromRun.status).toBe(201);
    expect((await fromRun.json() as { statistic: { score: string; nativeEffect: string } }).statistic)
      .toMatchObject({ score: '4.200000', nativeEffect: 'none' });
    expect((await nativeRatings()).boolean).toBe(beforeNative.boolean);
    expect((await h.get(`/v1/sources/statistics/${short(first.statistic.statistic)}`, 'reader')).status).toBe(401);
    expect((await h.get(`/v1/sources/statistics/${short(first.statistic.statistic)}`, 'owner')).status).toBe(200);
    expect((await h.get(`/v1/sources/statistics/${short(first.statistic.statistic)}`, 'other')).status).toBe(404);
    const partial = await h.observation(record, '{"score":7}', h.principalId, false);
    expect((await h.post('/v1/sources/statistics', 'owner', { ...aggregate,
      observation: iri(partial), scorePointer: '/score' }, randomUUID())).status).toBe(503);
    expect((await h.pool.query('SELECT count(*)::int AS n FROM source.statistic WHERE observation_id = $1',
      [observation])).rows[0]?.n).toBe(2);
    expect((await h.accessPool.query(`SELECT count(*)::int AS n FROM access.principal
      WHERE account_subject = 'provider-user-7'`)).rows[0]?.n).toBe(0);
    expect((await accountPool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM public."user"')).rows[0]?.n).toBe(accountCount);
    await h.accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [h.principalId]);
    expect((await h.post('/v1/sources/statistics', 'owner', aggregate, key)).status).toBe(403);
  } finally { await accountPool.end(); await h.close(); }
}, 60_000);
