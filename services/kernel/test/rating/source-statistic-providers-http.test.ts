import { afterAll, beforeAll, expect, test } from 'bun:test';
import { sourceObservation } from '../../src/rating/source-provider.ts';
import { routeOf } from '../../src/route/route.ts';
import { createSourceStatisticLifecycleFixture } from './source-statistic-lifecycle-fixture.ts';

let fixture: Awaited<ReturnType<typeof createSourceStatisticLifecycleFixture>>;
beforeAll(async () => {
  fixture = await createSourceStatisticLifecycleFixture();
}, 180_000);
afterAll(async () => {
  await fixture?.close();
});
const value = (sourceRecordId: string) => ({
  sourceRecordId,
  scale: { min: 0, max: 10 },
  mean: 0,
  count: 17,
  asOf: '2026-10-20',
  licence: 'LicenseRef-Authorized-Test-Figures',
  attribution: 'Provider users; authorized fixture',
});
const path = (id: string) => `/v1/subjects/${id}/source-statistics`;
async function result(response: Response, status = 200): Promise<any> {
  const text = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
const write = (id: string, provider: string, body: unknown, key?: string) =>
  fixture.request('PUT', `${path(id)}/${provider}`, { body, ...(key ? { key } : {}) });
const clear = (id: string, provider: string, body: unknown) =>
  fixture.request('POST', `${path(id)}/${provider}:clear`, { body });
const list = async (id: string) => result(await fixture.request('GET', path(id)));

test('mounted provider observations refresh independently, preserve zero means and fence stale clears/resurrection', async () => {
  const id = await fixture.createSubject();
  const vndb = value('v17');
  const bangumi = { ...value('123'), sourceAlias: 'bangumi-feed' };
  const nativeBefore = await fixture.database.admin.query('SELECT count(*)::int AS n FROM rating.vote');
  expect(await result(await write(id, 'vndb', vndb))).toEqual({ source: 'vndb', ...vndb });
  const digest = sourceObservation(id, 'bangumi', bangumi).digest;
  const initial = { source: 'bangumi', ...bangumi, observation: { kind: 'unversioned', digest } };
  expect(await result(await write(id, 'bangumi', bangumi))).toEqual(initial);
  expect(await list(id)).toEqual([initial, { source: 'vndb', ...vndb }]);
  const identical = await write(id, 'bangumi', bangumi);
  expect(await result(identical)).toEqual(initial);
  await result(await write(id, 'bangumi', { ...bangumi, mean: 8 }), 409);
  const correction = { ...bangumi, mean: 8, expectedObservation: digest };
  const corrected = await result(await write(id, 'bangumi', correction));
  expect(corrected.mean).toBe(8);
  await result(await write(id, 'bangumi', { ...bangumi, mean: 9, expectedObservation: digest }), 409);
  const next = { ...bangumi, mean: 7.5, count: 22, asOf: '2026-10-21' };
  const refreshed = await result(await write(id, 'bangumi', next));
  expect(await list(id)).toEqual([refreshed, { source: 'vndb', ...vndb }]);
  await result(await write(id, 'bangumi', bangumi), 409);
  await result(
    await clear(id, 'bangumi', {
      sourceAlias: bangumi.sourceAlias,
      sourceRecordId: '123',
      count: 0,
      asOf: bangumi.asOf,
    }),
    409,
  );
  // A different record or alias cannot select a winner or clear the current binding.
  await result(await write(id, 'bangumi', { ...next, sourceRecordId: '124', asOf: '2026-10-22' }), 409);
  await result(await clear(id, 'bangumi', { sourceRecordId: '123', count: 0, asOf: '2026-10-22' }), 204);
  expect(await list(id)).toEqual([refreshed, { source: 'vndb', ...vndb }]);
  const empty = {
    sourceAlias: bangumi.sourceAlias,
    sourceRecordId: '123',
    count: 0,
    asOf: next.asOf,
    expectedObservation: refreshed.observation.digest,
  };
  await result(await clear(id, 'bangumi', empty), 204);
  await result(await clear(id, 'bangumi', empty), 204);
  expect(await list(id)).toEqual([{ source: 'vndb', ...vndb }]);
  await result(await write(id, 'bangumi', bangumi), 409);
  await result(await write(id, 'bangumi', next), 409);
  const repaired = { ...next, mean: 9, expectedObservation: sourceObservation(id, 'bangumi', empty).digest };
  const repair = await result(await write(id, 'bangumi', repaired));
  expect(repair.mean).toBe(9);
  expect((await list(id))[1]).toEqual({ source: 'vndb', ...vndb });
  const heads = await fixture.database.admin.query(
    'SELECT source FROM rating.source_statistic_head WHERE route=$1 AND subject_id=$2 ORDER BY source',
    [routeOf(id), id],
  );
  expect(heads.rows).toEqual([{ source: 'bangumi' }, { source: 'vndb' }]);
  const original = await fixture.database.admin.query(
    'SELECT payload FROM rating.source_statistic_observation WHERE route=$1 AND subject_id=$2 AND source=$3 AND digest=$4',
    [routeOf(id), id, 'bangumi', digest],
  );
  expect(original.rows[0].payload).toEqual(sourceObservation(id, 'bangumi', bangumi).payload);
  expect((await fixture.database.admin.query('SELECT count(*)::int AS n FROM rating.vote')).rows).toEqual(
    nativeBefore.rows,
  );
});

test('profiles, exact current facts fences, Subject concealment and denied receipt replay govern both providers', async () => {
  const id = await fixture.createSubject();
  const vndb = value('v41');
  const bangumi = { ...value('456'), sourceAlias: 'bgm-authorized' };
  for (const [provider, body] of [
    ['other', bangumi],
    ['bangumi', { ...bangumi, scale: { min: 1, max: 100 } }],
    ['bangumi', { ...bangumi, sourceRecordId: 'v17', sourceAlias: 'vndb' }],
    ['bangumi', { ...bangumi, sourceRecordId: '0456' }],
    ['bangumi', { ...bangumi, sourceRecordId: '9007199254740992' }],
    ['bangumi', { ...bangumi, count: 0 }],
    ['bangumi', { ...bangumi, mean: -1 }],
  ] as const)
    await result(await write(id, provider, body), 400);
  await result(await write(id, 'vndb', vndb));
  const key = crypto.randomUUID();
  const figure = await result(await write(id, 'bangumi', bangumi, key));
  await result(
    await fixture.request('POST', '/v1/sourceFences:takedown', {
      body: { source: 'vndb', externalId: vndb.sourceRecordId, fieldGroup: 'facts', reason: 'Fixture takedown' },
    }),
  );
  expect(await list(id)).toEqual([figure]);
  // Fencing the display provider is unrelated to the actual configured alias.
  await result(
    await fixture.request('POST', '/v1/sourceFences:takedown', {
      body: { source: 'bangumi', externalId: bangumi.sourceRecordId, fieldGroup: 'facts', reason: 'Other tuple' },
    }),
  );
  expect(await list(id)).toEqual([figure]);
  await result(
    await fixture.request('POST', '/v1/sourceFences:takedown', {
      body: {
        source: bangumi.sourceAlias,
        externalId: bangumi.sourceRecordId,
        fieldGroup: 'facts',
        reason: 'Exact tuple',
      },
    }),
  );
  expect(await list(id)).toEqual([]);
  expect((await result(await write(id, 'bangumi', bangumi, key), 403)).effect_status).toBe('not_applicable');
  await fixture.revokeWriter();
  try {
    expect((await result(await write(id, 'bangumi', bangumi, key), 403)).effect_status).toBe('not_applied');
  } finally {
    await fixture.restoreWriter();
  }
  // Removal is allowed behind a facts fence; no source fact is disclosed by its 204.
  await result(
    await clear(id, 'bangumi', {
      sourceAlias: bangumi.sourceAlias,
      sourceRecordId: '456',
      count: 0,
      asOf: '2026-10-21',
    }),
    204,
  );
  const concealed = await fixture.createSubject();
  const visible = await result(await write(concealed, 'bangumi', value('789')));
  await fixture.database.admin.query(
    `INSERT INTO access.resource_denial
      (route, resource_id, subject_id, subject_role, action, reason, valid, transaction_id)
     VALUES ($1,$2,$3,'','subject:read','resource','(,)'::tstzrange,$4)`,
    [routeOf(concealed), concealed, fixture.actorId, crypto.randomUUID()],
  );
  await result(await fixture.request('GET', path(concealed)), 404);
  await result(await write(concealed, 'bangumi', { ...value('789'), asOf: '2026-10-22' }), 404);
  const retained = await fixture.database.admin.query(
    'SELECT observation_digest FROM rating.source_statistic WHERE route=$1 AND subject_id=$2',
    [routeOf(concealed), concealed],
  );
  expect(retained.rows[0].observation_digest).toBe(visible.observation.digest);
});
