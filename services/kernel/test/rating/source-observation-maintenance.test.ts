import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  materializeSourceObservations, prepareSourceObservationMaterialization,
  resetSourceObservationMaterialization,
} from '../../src/rating/source-observation-maintenance.ts';
import { sourceObservation } from '../../src/rating/source-provider.ts';
import { routeOf } from '../../src/route/route.ts';
import { createSourceStatisticIsolationFixture } from './source-statistic-isolation-fixture.ts';

let fixture: Awaited<ReturnType<typeof createSourceStatisticIsolationFixture>>;
beforeAll(async () => {
  fixture = await createSourceStatisticIsolationFixture();
  await fixture.grantImporter(fixture.actors.importer);
  // Model the old database's transitional nullable column in this isolated DB.
  await fixture.database.pool.query('ALTER TABLE rating.source_statistic_observation ALTER COLUMN seek_order DROP NOT NULL');
  await prepareSourceObservationMaterialization(fixture.database.pool);
}, 180_000);
afterAll(async () => { await fixture?.close(); });

const value = {
  sourceAlias: 'licensed-catalogue', sourceRecordId: '9001', scale: { min: 0, max: 10 },
  mean: 8, count: 2, asOf: '2026-11-01', licence: 'LicenseRef-Authorized-Test',
  attribution: 'Permitted source users',
  figures: { schemaVersion: 1 as const, rank: { unit: 'subjects' as const, position: 7 } },
};
const path = (id: string) => '/v1/subjects/' + id + '/source-statistics/bangumi';
async function json(response: Response, status = 200): Promise<any> {
  const body = await response.text();
  if (response.status !== status) throw new Error('Expected ' + status + ', received ' + response.status + ': ' + body);
  return body ? JSON.parse(body) : null;
}
function key(id: string) {
  const route = routeOf(id);
  if (route === null) throw new Error('Fixture Subject has no route');
  return { route, subjectId: id, source: 'bangumi' as const };
}
const inspect = async (id: string, query = '') => json(
  await fixture.request('GET', path(id) + '/observations' + query, { actor: fixture.actors.importer }),
);
const write = async (id: string, body: unknown) => json(await fixture.request('PUT', path(id), {
  actor: fixture.actors.importer, key: crypto.randomUUID(), body,
}));
async function complete(id: string, limit = 256) {
  for (let step = 0; step < 20; step++) {
    const result = await materializeSourceObservations(fixture.database.pool, { ...key(id), limit });
    expect(result.examined).toBeLessThanOrEqual(limit);
    if (result.done) return result;
  }
  throw new Error('Fixture conversion exceeded its caller step budget');
}
async function facts(id: string) {
  return (await fixture.database.pool.query(
    `SELECT digest,payload,transaction_id::text,local_order::text
     FROM rating.source_statistic_observation
     WHERE route=$1 AND subject_id=$2 AND source='bangumi' ORDER BY digest`, [key(id).route, id],
  )).rows;
}
async function legacyHistory(unknownCount: number) {
  const id = await fixture.createSubject();
  const rows = Array.from({ length: unknownCount + 3 }, (_, index) => {
    const payload = index === unknownCount + 2 ? {
      sourceAlias: value.sourceAlias, sourceRecordId: String(10000 + index), count: 0, asOf: '2026-11-02',
    } : { ...value, sourceRecordId: String(10000 + index) };
    const observed = sourceObservation(id, 'bangumi', payload);
    return {
      ...observed, transaction_id: crypto.randomUUID(),
      local_order: index < unknownCount ? null : String(index - unknownCount + 1),
    };
  });
  await fixture.database.pool.query(`
    INSERT INTO rating.source_statistic_observation
      (route,subject_id,source,digest,source_alias,source_record_id,as_of,payload,
       transaction_id,payload_version,local_order,seek_order)
    SELECT $1,$2,'bangumi',input.digest,input.payload->>'sourceAlias',input.payload->>'sourceRecordId',
           (input.payload->>'asOf')::date,input.payload,input.transaction_id,1,input.local_order,NULL
    FROM jsonb_to_recordset($3::jsonb) AS input
      (digest text,payload jsonb,transaction_id uuid,local_order bigint)`,
    [key(id).route, id, JSON.stringify(rows)],
  );
  await fixture.database.pool.query(`
    INSERT INTO rating.source_statistic_head (route,subject_id,source,digest,last_order,last_seek_order)
    VALUES ($1,$2,'bangumi',$3,3,0)`, [key(id).route, id, rows[rows.length - 1]!.digest],
  );
  return { id, rows };
}

test('a slot exceeding 256 observations resumes committed bounded steps without changing facts or chronology', async () => {
  const { id, rows } = await legacyHistory(300);
  const before = await facts(id);
  const first = await materializeSourceObservations(fixture.database.pool, key(id));
  expect(first).toMatchObject({ done: false, examined: 256, observations: '256' });
  const saved = (await fixture.database.pool.query(`
    SELECT cursor_digest,processed::text FROM rating.source_observation_materialization
    WHERE route=$1 AND subject_id=$2 AND source='bangumi'`, [key(id).route,id],
  )).rows[0]!;
  expect(saved.cursor_digest).toBe(first.cursor!.digest);
  expect(saved.processed).toBe('256');
  await json(await fixture.request('GET', path(id) + '/observations', { actor: fixture.actors.importer }), 503);
  const finished = await complete(id);
  expect(finished).toMatchObject({ done: true, observations: '303' });
  expect(await facts(id)).toEqual(before);
  const current = await inspect(id, '?history=true');
  expect(current.head.state).toBe('cleared');
  expect(current.history.items[0]).toMatchObject({ digest: rows[302]!.digest, nativeOrder: '3', legacy: false });
  const exact = await inspect(id, '?digest=' + rows[0]!.digest);
  expect(exact.selectedObservation).toMatchObject({ payload: rows[0]!.payload, nativeOrder: null, legacy: true });
  const ordered = (await fixture.database.pool.query(`
    SELECT local_order::text AS native,digest,seek_order::text AS seek
    FROM rating.source_statistic_observation
    WHERE route=$1 AND subject_id=$2 AND source='bangumi' ORDER BY seek_order`, [key(id).route,id],
  )).rows;
  expect(ordered.slice(0,300).map((row) => row.digest))
    .toEqual(rows.slice(0,300).map((row) => row.digest).sort());
  expect(ordered.slice(300).map((row) => row.native)).toEqual(['1','2','3']);
  const ready = await materializeSourceObservations(fixture.database.pool, key(id));
  expect(ready.done).toBe(true);
  expect(ready.examined).toBe(0);
  expect(await facts(id)).toEqual(before);
});

test('erasure during a partial conversion removes progress without recreating the original head', async () => {
  const { id } = await legacyHistory(3);
  expect((await materializeSourceObservations(fixture.database.pool, { ...key(id),limit: 2 })).done).toBe(false);
  await fixture.database.pool.query(
    `DELETE FROM rating.source_statistic_head WHERE route=$1 AND subject_id=$2 AND source='bangumi'`,
    [key(id).route,id],
  );
  await fixture.database.pool.query(
    `DELETE FROM rating.source_statistic_observation WHERE route=$1 AND subject_id=$2 AND source='bangumi'`,
    [key(id).route,id],
  );
  await expect(materializeSourceObservations(fixture.database.pool,key(id))).rejects.toThrow('original head changed');
  await resetSourceObservationMaterialization(fixture.database.pool,key(id));
  expect(await complete(id)).toMatchObject({ done: true,head: null });
  expect((await inspect(id)).head.state).toBe('empty');
  expect(await facts(id)).toEqual([]);
});

test('canonical slots preserve existing seek positions and repair a missing projection digest only for identical facts', async () => {
  const id = await fixture.createSubject();
  const written = await write(id,value);
  const before = (await fixture.database.pool.query(
    `SELECT * FROM rating.source_statistic_observation WHERE route=$1 AND subject_id=$2`, [key(id).route,id],
  )).rows;
  expect(await complete(id)).toMatchObject({ done: true,examined: 0 });
  await fixture.database.pool.query(`UPDATE rating.source_statistic SET observation_digest=NULL
    WHERE route=$1 AND subject_id=$2 AND source='bangumi'`, [key(id).route,id]);
  await complete(id);
  const result = await inspect(id,'?digest=' + written.observation.digest);
  expect(result.head.observation).toEqual(result.selectedObservation);
  expect(result.selectedObservation.payload).toEqual(value);
  expect((await fixture.database.pool.query(
    `SELECT * FROM rating.source_statistic_observation WHERE route=$1 AND subject_id=$2`, [key(id).route,id],
  )).rows).toEqual(before);
  await resetSourceObservationMaterialization(fixture.database.pool,key(id));
  await fixture.database.pool.query(`UPDATE rating.source_statistic SET observation_digest=NULL,mean=9
    WHERE route=$1 AND subject_id=$2 AND source='bangumi'`, [key(id).route,id]);
  await expect(complete(id)).rejects.toThrow('projection facts differ');
});

test('a matching digest cannot convert malformed clear facts', async () => {
  const id = await fixture.createSubject();
  const malformed = {
    sourceAlias: value.sourceAlias,sourceRecordId: value.sourceRecordId,asOf: value.asOf,count: 0,mean: 8,
  };
  const observed = sourceObservation(id,'bangumi',malformed);
  await fixture.database.pool.query(`
    INSERT INTO rating.source_statistic_observation
      (route,subject_id,source,digest,source_alias,source_record_id,as_of,payload,
       transaction_id,payload_version,local_order,seek_order)
    VALUES ($1,$2,'bangumi',$3,$4,$5,$6,$7::jsonb,$8,1,NULL,1)`,
    [key(id).route,id,observed.digest,malformed.sourceAlias,malformed.sourceRecordId,
      malformed.asOf,JSON.stringify(observed.payload),crypto.randomUUID()],
  );
  await fixture.database.pool.query(`
    INSERT INTO rating.source_statistic_head (route,subject_id,source,digest,last_order,last_seek_order)
    VALUES ($1,$2,'bangumi',$3,0,1)`, [key(id).route,id,observed.digest],
  );
  const before = await facts(id);
  await expect(materializeSourceObservations(fixture.database.pool,key(id))).rejects.toThrow('invalid observation payload');
  expect(await facts(id)).toEqual(before);
});
