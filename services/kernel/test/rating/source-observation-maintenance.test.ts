import { afterAll, beforeAll, expect, test } from 'bun:test';
import { materializeSourceObservations } from '../../src/rating/source-observation-maintenance.ts';
import { sourceObservation } from '../../src/rating/source-provider.ts';
import type { SourceObservationReadResponse } from '../../src/rating/source-observation-read.ts';
import { routeOf } from '../../src/route/route.ts';
import { createSourceStatisticIsolationFixture } from './source-statistic-isolation-fixture.ts';

let fixture: Awaited<ReturnType<typeof createSourceStatisticIsolationFixture>>;
beforeAll(async () => {
  fixture = await createSourceStatisticIsolationFixture();
  await fixture.grantImporter(fixture.actors.importer);
}, 180_000);
afterAll(async () => { await fixture?.close(); });

const value = {
  sourceAlias: 'licensed-catalogue', sourceRecordId: '9001', scale: { min: 0, max: 10 },
  mean: 8, count: 2, asOf: '2026-11-01', licence: 'LicenseRef-Authorized-Test',
  attribution: 'Permitted source users',
  figures: { schemaVersion: 1 as const, rank: { unit: 'subjects' as const, position: 7 } },
};
const path = (id: string) => `/v1/subjects/${id}/source-statistics/bangumi`;
async function json(response: Response, status = 200): Promise<any> {
  const body = await response.text();
  if (response.status !== status) throw new Error(`Expected ${status}, received ${response.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}
function key(id: string) {
  const route = routeOf(id);
  if (route === null) throw new Error('Fixture Subject has no route');
  return { route, subjectId: id, source: 'bangumi' as const };
}
const inspect = async (id: string, query = ''): Promise<SourceObservationReadResponse> => json(
  await fixture.request('GET', `${path(id)}/observations${query}`, { actor: fixture.actors.importer }),
);
const write = async (id: string, body: unknown) => json(await fixture.request('PUT', path(id), {
  actor: fixture.actors.importer, key: crypto.randomUUID(), body,
}));
async function history(id: string) {
  const items = [];
  let query = '?history=true';
  for (let page = 0; page < 4; page++) {
    const result = await inspect(id, query);
    items.push(...result.history!.items);
    if (result.history!.nextCursor === null) return items;
    query = `?cursor=${encodeURIComponent(result.history!.nextCursor)}`;
  }
  throw new Error('Fixture history exceeded its expected bound');
}
async function state(id: string) {
  const parameters = [key(id).route, id];
  const observations = await fixture.database.pool.query(
    `SELECT * FROM rating.source_statistic_observation
     WHERE route=$1 AND subject_id=$2 AND source='bangumi' ORDER BY digest`, parameters,
  );
  const head = await fixture.database.pool.query(
    `SELECT * FROM rating.source_statistic_head WHERE route=$1 AND subject_id=$2 AND source='bangumi'`, parameters,
  );
  const projection = await fixture.database.pool.query(
    `SELECT * FROM rating.source_statistic WHERE route=$1 AND subject_id=$2 AND source='bangumi'`, parameters,
  );
  return { observations: observations.rows, head: head.rows, projection: projection.rows };
}

test('bounded maintenance preserves native immutable history and a cleared head without changing provenance', async () => {
  const empty = await fixture.createSubject();
  expect(await materializeSourceObservations(fixture.database.pool, key(empty)))
    .toEqual({ observations: 0, materialized: false, head: null });
  expect((await inspect(empty)).head.state).toBe('empty');
  const id = await fixture.createSubject();
  const first = await write(id, value);
  const second = await write(id, {
    ...value, mean: 9, asOf: '2026-11-02', expectedObservation: first.observation.digest,
  });
  await json(await fixture.request('POST', `${path(id)}:clear`, {
    actor: fixture.actors.importer, key: crypto.randomUUID(), body: {
      sourceAlias: value.sourceAlias, sourceRecordId: value.sourceRecordId, count: 0,
      asOf: '2026-11-03', expectedObservation: second.observation.digest,
    },
  }), 204);
  const current = await inspect(id);
  const exact = await inspect(id, `?digest=${first.observation.digest}`);
  const priorHistory = await history(id);
  const before = await state(id);
  await expect(materializeSourceObservations(fixture.database.pool, { ...key(id), limit: 2 }))
    .rejects.toThrow('observation limit exceeded');
  expect(await state(id)).toEqual(before);
  expect(await materializeSourceObservations(fixture.database.pool, { ...key(id), limit: 3 }))
    .toEqual({ observations: 3, materialized: false, head: current.head.digest });
  expect(await state(id)).toEqual(before);
  expect(await inspect(id)).toEqual(current);
  expect(await inspect(id, `?digest=${first.observation.digest}`)).toEqual(exact);
  expect(await history(id)).toEqual(priorHistory);
  expect(current.head.state).toBe('cleared');
  expect(priorHistory.map((item) => item.nativeOrder)).toEqual(['3', '2', '1']);
});

test('maintenance repairs an absent projection digest only after matching its retained facts', async () => {
  const id = await fixture.createSubject();
  const written = await write(id, value);
  const before = await state(id);
  await fixture.database.pool.query(
    `UPDATE rating.source_statistic SET observation_digest=NULL
     WHERE route=$1 AND subject_id=$2 AND source='bangumi'`, [key(id).route, id],
  );
  await materializeSourceObservations(fixture.database.pool, key(id));
  expect(await state(id)).toEqual(before);
  const result = await inspect(id, `?digest=${written.observation.digest}`);
  expect(result.head.observation).toEqual(result.selectedObservation!);
  expect(result.selectedObservation!.payload).toEqual(value);
  await fixture.database.pool.query(
    `UPDATE rating.source_statistic SET observation_digest=NULL, mean=9
     WHERE route=$1 AND subject_id=$2 AND source='bangumi'`, [key(id).route, id],
  );
  const divergent = await state(id);
  await expect(materializeSourceObservations(fixture.database.pool, key(id)))
    .rejects.toThrow('projection facts differ');
  expect(await state(id)).toEqual(divergent);
});

test('a matching digest cannot materialize malformed clear facts', async () => {
  const id = await fixture.createSubject();
  const malformed = {
    sourceAlias: value.sourceAlias, sourceRecordId: value.sourceRecordId,
    asOf: value.asOf, count: 0, mean: 8,
  };
  const observed = sourceObservation(id, 'bangumi', malformed);
  await fixture.database.pool.query(
    `INSERT INTO rating.source_statistic_observation
       (route,subject_id,source,digest,source_alias,source_record_id,as_of,payload,
        transaction_id,payload_version,local_order,seek_order)
     VALUES ($1,$2,'bangumi',$3,$4,$5,$6,$7::jsonb,$8,1,NULL,1)`,
    [key(id).route, id, observed.digest, malformed.sourceAlias, malformed.sourceRecordId,
      malformed.asOf, JSON.stringify(observed.payload), crypto.randomUUID()],
  );
  const before = await state(id);
  await expect(materializeSourceObservations(fixture.database.pool, key(id)))
    .rejects.toThrow('invalid observation payload');
  expect(await state(id)).toEqual(before);
});
