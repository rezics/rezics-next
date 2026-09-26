import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { identityHarness, iri } from './source-identity-harness.ts';

const short = (value: string) => value.split('/').at(-1)!;

test('LIVE08: retained provider score and user key stay source statistics without native identity', async () => {
  const h = await identityHarness();
  try {
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
    expect((await h.get(`/v1/sources/statistics/${short(first.statistic.statistic)}`, 'reader')).status).toBe(200);
    expect((await h.get(`/v1/sources/statistics/${short(first.statistic.statistic)}`, 'other')).status).toBe(404);
    const partial = await h.observation(record, '{"score":7}', h.principalId, false);
    expect((await h.post('/v1/sources/statistics', 'owner', { ...aggregate,
      observation: iri(partial), scorePointer: '/score' }, randomUUID())).status).toBe(503);
    expect((await h.pool.query('SELECT count(*)::int AS n FROM source.statistic WHERE observation_id = $1',
      [observation])).rows[0]?.n).toBe(2);
    expect((await h.accessPool.query(`SELECT count(*)::int AS n FROM access.principal
      WHERE account_subject = 'provider-user-7'`)).rows[0]?.n).toBe(0);
    await h.accessPool.query('UPDATE access.principal SET active = false WHERE id = $1', [h.principalId]);
    expect((await h.post('/v1/sources/statistics', 'owner', aggregate, key)).status).toBe(403);
  } finally { await h.close(); }
}, 30_000);
