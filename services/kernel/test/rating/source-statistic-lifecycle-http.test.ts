import { afterAll, beforeAll, expect, test } from 'bun:test';
import canonicalize from 'canonicalize';
import { sourceObservation } from '../../src/rating/source-provider.ts';
import { createHash } from 'node:crypto';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import sourceStatisticUpsert from '../../src/rating/source-statistic-upsert.sql';
import sourceStatisticList from '../../src/rating/source-statistic-list.sql';
import { observeSql } from '../content/support/sql-observer.ts';
import { createSourceStatisticLifecycleFixture } from './source-statistic-lifecycle-fixture.ts';

const source = 'vndb';
const asOf = '2026-10-15';
const baseStatistic = (sourceRecordId: string, mean = 8.4) => ({
  sourceRecordId,
  scale: { min: 0, max: 10 },
  mean,
  count: 1234,
  asOf,
  licence: 'CC BY 4.0',
  attribution: 'VNDB users',
});
const baseClear = (sourceRecordId: string, date = '2026-10-21') => ({ sourceRecordId, count: 0, asOf: date });

let fixture: Awaited<ReturnType<typeof createSourceStatisticLifecycleFixture>>;
let observer: ReturnType<typeof observeSql>;
let subjects: readonly string[];

function statisticPath(subjectId: string) {
  return `/v1/subjects/${subjectId}/source-statistics`;
}

function writePath(subjectId: string) {
  return `${statisticPath(subjectId)}/${source}`;
}

function clearPath(subjectId: string) {
  return `${writePath(subjectId)}:clear`;
}

function tuplePartition(subjectId: string, sourceRecordId: string): number {
  return partitionOf(tupleRoute(fixture.routeKey, source, sourceRecordId));
}

async function problem(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  return response.json() as Promise<Record<string, unknown>>;
}

async function sourceStatistics(subjectId: string, anonymous = true) {
  const response = await fixture.request('GET', statisticPath(subjectId), { anonymous });
  expect(response.status).toBe(200);
  const rows = await response.json();
  return rows.map(({ observation, ...row }: any) => {
    if (observation) expect(observation).toEqual({ kind: 'unversioned', digest: sourceObservation(subjectId, source, rowPayload(row)).digest });
    return row;
  });
}
function rowPayload({ source: _provider, ...value }: any) { return value; }
function expected(subjectId: string, value: any) {
  const { expectedObservation: _expected, ...payload } = value;
  return { source, ...payload, observation: { kind: 'unversioned', digest: sourceObservation(subjectId, source, payload).digest } };
}
function compare(subjectId: string, previous: any, next: any) {
  return { ...next, expectedObservation: sourceObservation(subjectId, source, previous).digest };
}

async function takedown(sourceRecordId: string, fieldGroup: 'facts' | 'summary' | 'cover') {
  const response = await fixture.request('POST', '/v1/sourceFences:takedown', {
    body: { source, externalId: sourceRecordId, fieldGroup, reason: `Lifecycle ${fieldGroup} test` },
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function stored(subjectId: string) {
  return fixture.database.admin.query(
    `SELECT source_record_id AS "sourceRecordId", mean::text, count
     FROM rating.source_statistic WHERE route=$1 AND subject_id=$2 AND source=$3`,
    [routeOf(subjectId), subjectId, source],
  );
}

beforeAll(async () => {
  fixture = await createSourceStatisticLifecycleFixture({ nativeFigures: true });
  observer = observeSql(fixture.database.pool);
  subjects = fixture.nativeFigures!.subjectIds;
  const subjectId = subjects[0]!;
  await fixture.nativeFigures!.vote(subjectId, fixture.nativeFigures!.globalVoters[0]!, 14);
  await fixture.nativeFigures!.published(subjectId, 1);
});

afterAll(async () => {
  await observer?.close();
  await fixture?.close();
});

test('the facts tuple controls source-score publication and final disclosure independently', async () => {
  const [subjectId, independentSubject] = subjects;
  expect(subjectId).toBeDefined();
  expect(independentSubject).toBeDefined();

  const nativeBefore = await fixture.nativeFigures!.figure(subjectId!);
  const published = baseStatistic('lifecycle-facts-record');
  const put = await fixture.request('PUT', writePath(subjectId!), { body: published });
  expect(put.status).toBe(200);
  expect(await put.json()).toEqual({ source, ...published });

  await takedown(published.sourceRecordId, 'summary');
  await takedown(published.sourceRecordId, 'cover');
  const refreshed = { ...published, mean: 8.8, count: 1400, asOf: '2026-10-20' };
  const refresh = await fixture.request('PUT', writePath(subjectId!), { body: refreshed });
  expect(refresh.status).toBe(200);
  expect(await sourceStatistics(subjectId!)).toEqual([{ source, ...refreshed }]);

  const independent = baseStatistic('lifecycle-independent-record', 7.1);
  const independentWrite = await fixture.request('PUT', writePath(independentSubject!), { body: independent });
  expect(independentWrite.status).toBe(200);

  await takedown(published.sourceRecordId, 'facts');
  expect(await sourceStatistics(subjectId!)).toEqual([]);
  const deniedKey = crypto.randomUUID();
  await problem(
    await fixture.request('PUT', writePath(subjectId!), {
      body: { ...refreshed, mean: 9.2, count: 1500 },
      key: deniedKey,
    }),
    403,
  );
  expect(await stored(subjectId!)).toMatchObject({ rows: [{ sourceRecordId: published.sourceRecordId, mean: '8.8' }] });
  const deniedReceipt = await fixture.database.admin.query(
    `SELECT count(*)::int AS n FROM core.receipt
     WHERE principal_id=$1 AND command_kind='rating.source_statistic.write' AND idempotency_key=$2`,
    [fixture.actorId, deniedKey],
  );
  expect(deniedReceipt.rows).toEqual([{ n: 0 }]);
  expect(await sourceStatistics(independentSubject!)).toEqual([{ source, ...independent }]);

  const nativeAfter = await fixture.nativeFigures!.figure(subjectId!);
  expect(nativeAfter).toEqual(nativeBefore);
  const nativeRows = await fixture.database.admin.query(
    `SELECT (SELECT count(*)::int FROM rating.vote WHERE target_id=$1) AS votes,
            (SELECT count(*)::int FROM rating.public_figure WHERE subject_id=$1) AS figures`,
    [subjectId],
  );
  expect(nativeRows.rows[0]).toMatchObject({ votes: 1, figures: 1 });
});

test('a facts fence racing a committed write hides its response without claiming no effect', async () => {
  const subjectId = subjects[2]!;
  const subjectPartition = partitionOf(routeOf(subjectId)!);
  let sourceRecordId = 'lifecycle-final-fence-race';
  let attempt = 0;
  while (tuplePartition(subjectId, sourceRecordId) === subjectPartition) {
    sourceRecordId = `lifecycle-final-fence-race-${++attempt}`;
  }

  const key = crypto.randomUUID();
  const barrier = observer.hold({ statement: sourceStatisticUpsert.sql }, 'before');
  const pending = fixture.request('PUT', writePath(subjectId), {
    body: baseStatistic(sourceRecordId, 9.1),
    key,
  });
  await barrier.entered;
  try {
    await takedown(sourceRecordId, 'facts');
  } finally {
    barrier.release();
  }
  const response = await pending;
  const failure = await problem(response, 404);
  expect(failure.effect_status).toBe('not_applicable');
  expect(JSON.stringify(failure)).not.toContain('VNDB users');
  expect(JSON.stringify(failure)).not.toContain('9.1');
  expect(JSON.stringify(failure)).not.toContain(sourceRecordId);
  expect(JSON.stringify(failure)).not.toContain('CC BY 4.0');

  const row = await stored(subjectId);
  expect(row.rows).toEqual([{ sourceRecordId, mean: '9.1', count: 1234 }]);
  const receipt = await fixture.database.admin.query(
    `SELECT response FROM core.receipt
     WHERE principal_id=$1 AND command_kind='rating.source_statistic.write' AND idempotency_key=$2`,
    [fixture.actorId, key],
  );
  expect(receipt.rows).toHaveLength(1);
  expect(receipt.rows[0]!.response).toMatchObject({ source, sourceRecordId, mean: 9.1 });

  const retry = await fixture.request('PUT', writePath(subjectId), {
    body: baseStatistic(sourceRecordId, 9.1),
    key,
  });
  const retryFailure = await problem(retry, 403);
  expect(JSON.stringify(retryFailure)).not.toContain(sourceRecordId);
  expect(JSON.stringify(retryFailure)).not.toContain('9.1');
});

test('an unavailable tuple home fails closed for reads and publication', async () => {
  const subjectId = subjects[3]!;
  let sourceRecordId = 'lifecycle-unavailable-fence-home';
  let attempt = 0;
  while (tuplePartition(subjectId, sourceRecordId) === partitionOf(routeOf(subjectId)!)) {
    sourceRecordId = `lifecycle-unavailable-fence-home-${++attempt}`;
  }
  const positive = baseStatistic(sourceRecordId, 6.7);
  const put = await fixture.request('PUT', writePath(subjectId), { body: positive });
  expect(put.status).toBe(200);

  const tupleHome = tuplePartition(subjectId, sourceRecordId);
  const previous = await fixture.database.admin.query(
    'SELECT write_state AS "writeState", moved_to AS "movedTo" FROM core.partition WHERE partition_no=$1',
    [tupleHome],
  );
  expect(previous.rows).toHaveLength(1);
  try {
    await fixture.database.admin.query(
      "UPDATE core.partition SET write_state='moved', moved_to='lifecycle-unavailable' WHERE partition_no=$1",
      [tupleHome],
    );
    const readFailure = await problem(await fixture.request('GET', statisticPath(subjectId), { anonymous: true }), 503);
    expect(readFailure.code).toBe('partition_unavailable');
    expect(JSON.stringify(readFailure)).not.toContain('6.7');
    expect(JSON.stringify(readFailure)).not.toContain(positive.licence);

    const writeFailure = await problem(
      await fixture.request('PUT', writePath(subjectId), { body: { ...positive, mean: 7.2 } }),
      503,
    );
    expect(writeFailure.code).toBe('partition_unavailable');
    expect(JSON.stringify(writeFailure)).not.toContain('7.2');
    expect(await stored(subjectId)).toMatchObject({ rows: [{ sourceRecordId, mean: '6.7' }] });
  } finally {
    await fixture.database.admin.query('UPDATE core.partition SET write_state=$2, moved_to=$3 WHERE partition_no=$1', [
      tupleHome,
      previous.rows[0]!.writeState,
      previous.rows[0]!.movedTo,
    ]);
  }
});

test('explicit zero clears the exact current binding with strict replay and current authorization', async () => {
  const [fencedSubject, subjectId] = await Promise.all([fixture.createSubject(), fixture.createSubject()]);
  expect(fencedSubject).toBeDefined();
  expect(subjectId).toBeDefined();

  const fencedBinding = 'lifecycle-fenced-clear-binding';
  const fencedRow = await fixture.request('PUT', writePath(fencedSubject!), { body: baseStatistic(fencedBinding) });
  expect(fencedRow.status).toBe(200);
  await takedown(fencedBinding, 'facts');
  const fencedClear = await fixture.request('POST', clearPath(fencedSubject!), { body: baseClear(fencedBinding) });
  expect(fencedClear.status).toBe(204);
  expect(fencedClear.headers.get(SESSION_HEADER)).toBeTruthy();
  expect((await stored(fencedSubject!)).rows).toHaveLength(0);

  const firstRecord = 'lifecycle-clear-old-binding';
  const currentRecord = 'lifecycle-clear-current-binding';
  expect((await fixture.request('PUT', writePath(subjectId!), { body: baseStatistic(firstRecord) })).status).toBe(200);
  expect(
    (
      await fixture.request('PUT', writePath(subjectId!), {
        body: compare(subjectId!, baseStatistic(firstRecord), baseStatistic(currentRecord, 9.3)),
      })
    ).status,
  ).toBe(200);

  const malformed = [
    { sourceRecordId: currentRecord, count: 0, asOf, mean: null },
    { sourceRecordId: currentRecord, count: 1, asOf },
    { sourceRecordId: currentRecord, count: '0', asOf },
    { sourceRecordId: currentRecord, count: 0, asOf: '2026-02-30' },
    { sourceRecordId: '', count: 0, asOf },
    { sourceRecordId: 17, count: 0, asOf },
    { sourceRecordId: currentRecord, count: 0, asOf, mean: 9.3 },
    { sourceRecordId: currentRecord, count: 0, asOf, scale: { min: 0, max: 10 } },
    { sourceRecordId: currentRecord, count: 0, asOf, licence: 'CC BY 4.0' },
    { sourceRecordId: currentRecord, count: 0, asOf, attribution: 'VNDB users' },
    { sourceRecordId: currentRecord, count: 0, asOf, clear: true },
  ];
  for (const body of malformed) {
    await problem(await fixture.request('POST', clearPath(subjectId!), { body }), 400);
  }
  expect(await sourceStatistics(subjectId!)).toEqual([{ source, ...baseStatistic(currentRecord, 9.3) }]);

  const mismatch = await fixture.request('POST', clearPath(subjectId!), {
    body: baseClear(firstRecord),
  });
  expect(mismatch.status).toBe(204);
  expect(await sourceStatistics(subjectId!)).toEqual([{ source, ...baseStatistic(currentRecord, 9.3) }]);

  const missingBinding = await fixture.request('POST', clearPath(subjectId!), {
    body: baseClear('lifecycle-absent-binding'),
  });
  expect(missingBinding.status).toBe(204);
  const unknownSubjectId = '00000000-0000-7000-8000-400000000001';
  await problem(
    await fixture.request('POST', clearPath(unknownSubjectId), {
      body: baseClear(currentRecord),
    }),
    404,
  );

  const changedEventsBefore = await fixture.database.admin.query(
    `SELECT count(*)::int AS n FROM core.outbox
     WHERE type='com.rezics.rating.source_statistic.changed.v1' AND data->>'sourceRecordId'=$1`,
    [currentRecord],
  );
  const key = crypto.randomUUID();
  const clear = await fixture.request('POST', clearPath(subjectId!), {
    body: baseClear(currentRecord),
    key,
  });
  expect(clear.status).toBe(204);
  expect(clear.headers.get(SESSION_HEADER)).toBeTruthy();
  const replay = await fixture.request('POST', clearPath(subjectId!), {
    body: baseClear(currentRecord),
    key,
  });
  expect(replay.status).toBe(204);
  await problem(
    await fixture.request('POST', clearPath(subjectId!), {
      body: baseClear(currentRecord, '2026-10-16'),
      key,
    }),
    422,
  );

  const clearReceipt = await fixture.database.admin.query(
    `SELECT partition_no FROM core.receipt
     WHERE principal_id=$1 AND command_kind='rating.source_statistic.clear' AND idempotency_key=$2`,
    [fixture.actorId, key],
  );
  expect(clearReceipt.rows).toEqual([{ partition_no: partitionOf(routeOf(subjectId!)!) }]);
  const changedEventsAfter = await fixture.database.admin.query(
    `SELECT count(*)::int AS n FROM core.outbox
     WHERE type='com.rezics.rating.source_statistic.changed.v1' AND data->>'sourceRecordId'=$1`,
    [currentRecord],
  );
  expect(changedEventsAfter.rows[0]!.n).toBe(Number(changedEventsBefore.rows[0]!.n) + 1);
  expect((await stored(subjectId!)).rows).toHaveLength(0);

  await fixture.revokeWriter();
  try {
    await problem(await fixture.request('POST', clearPath(subjectId!), { body: baseClear(currentRecord), key }), 403);
  } finally {
    await fixture.restoreWriter();
  }
});

async function aliasTakedown(sourceAlias: string, sourceRecordId: string) {
  const response = await fixture.request('POST', '/v1/sourceFences:takedown', {
    body: { source: sourceAlias, externalId: sourceRecordId, fieldGroup: 'facts', reason: 'Exact alias lifecycle' },
  });
  expect(response.status).toBe(200);
}

async function aliasEffects(subjectId: string) {
  const result = await fixture.database.admin.query(
    `SELECT count(*)::int AS n FROM core.outbox
     WHERE type='com.rezics.rating.source_statistic.changed.v1' AND subject=$1`,
    [subjectId],
  );
  return result.rows[0]!.n;
}

test('configured aliases publish and fence exact facts without affecting the same native id in another alias', async () => {
  const subjectId = await fixture.createSubject();
  const independentSubject = await fixture.createSubject();
  const defaultSubject = await fixture.createSubject();
  const sourceRecordId = 'v123';
  const feedTwo = { ...baseStatistic(sourceRecordId), sourceAlias: 'feed-two' };
  const feedOne = { ...baseStatistic(sourceRecordId, 7.3), sourceAlias: 'feed-one' };
  for (const [id, value] of [
    [subjectId, feedTwo],
    [independentSubject, feedOne],
    [defaultSubject, baseStatistic(sourceRecordId)],
  ] as const) {
    const put = await fixture.request('PUT', writePath(id), { body: value });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ source, ...value });
    expect(await sourceStatistics(id)).toEqual([{ source, ...value }]);
  }
  const persisted = await fixture.database.admin.query(
    'SELECT source, source_alias FROM rating.source_statistic WHERE route=$1 AND subject_id=$2',
    [routeOf(subjectId), subjectId],
  );
  expect(persisted.rows).toEqual([{ source, source_alias: 'feed-two' }]);
  await aliasTakedown('feed-two', sourceRecordId);
  expect(await sourceStatistics(subjectId)).toEqual([]);
  expect(await sourceStatistics(independentSubject)).toEqual([{ source, ...feedOne }]);
  expect(await sourceStatistics(defaultSubject)).toEqual([{ source, ...baseStatistic(sourceRecordId) }]);
  await problem(await fixture.request('PUT', writePath(subjectId), { body: feedTwo }), 403);
  const native = await fixture.database.admin.query(
    `SELECT (SELECT count(*)::int FROM rating.vote WHERE target_id=ANY($1::uuid[])) AS votes,
            (SELECT count(*)::int FROM rating.public_figure WHERE subject_id=ANY($1::uuid[])) AS figures,
            (SELECT count(*)::int FROM rating.aggregate_component WHERE target_id=ANY($1::uuid[])) AS aggregates`,
    [[subjectId, independentSubject, defaultSubject]],
  );
  expect(native.rows).toEqual([{ votes: 0, figures: 0, aggregates: 0 }]);
});

test('alias rebind isolates clear, no-op receipts and committed replay from the replacement binding', async () => {
  const subjectId = await fixture.createSubject();
  const sourceRecordId = 'alias-rebound-same-record';
  const first = { ...baseStatistic(sourceRecordId), sourceAlias: 'feed-one' };
  const second = { ...baseStatistic(sourceRecordId), sourceAlias: 'feed-two' };
  const writeKey = crypto.randomUUID();
  expect((await fixture.request('PUT', writePath(subjectId), { body: first, key: writeKey })).status).toBe(200);
  const firstReplay = await fixture.request('PUT', writePath(subjectId), { body: first, key: writeKey });
  expect(firstReplay.status).toBe(200);
  expect(await firstReplay.json()).toEqual({ source, ...first });
  await problem(await fixture.request('PUT', writePath(subjectId), { body: second, key: writeKey }), 422);
  expect((await fixture.request('PUT', writePath(subjectId), { body: compare(subjectId, first, second) })).status).toBe(200);
  const replacedReplay = await problem(
    await fixture.request('PUT', writePath(subjectId), { body: first, key: writeKey }),
    404,
  );
  expect(replacedReplay.effect_status).toBe('not_applicable');
  expect(JSON.stringify(replacedReplay)).not.toContain('feed-two');

  const staleClear = { ...baseClear(sourceRecordId), sourceAlias: 'feed-one' };
  const correctClear = { ...baseClear(sourceRecordId), sourceAlias: 'feed-two' };
  const staleKey = crypto.randomUUID();
  const before = await aliasEffects(subjectId);
  for (const body of [staleClear, baseClear(sourceRecordId), { ...correctClear, sourceRecordId: 'absent-record' }]) {
    const key = body === staleClear ? staleKey : crypto.randomUUID();
    expect((await fixture.request('POST', clearPath(subjectId), { body, key })).status).toBe(204);
    expect((await fixture.request('POST', clearPath(subjectId), { body, key })).status).toBe(204);
    expect(await sourceStatistics(subjectId)).toEqual([{ source, ...second }]);
  }
  expect(await aliasEffects(subjectId)).toBe(before);
  await problem(await fixture.request('POST', clearPath(subjectId), { body: correctClear, key: staleKey }), 422);
  const key = crypto.randomUUID();
  expect((await fixture.request('POST', clearPath(subjectId), { body: correctClear, key })).status).toBe(204);
  expect((await fixture.request('POST', clearPath(subjectId), { body: correctClear, key })).status).toBe(204);
  expect(await sourceStatistics(subjectId)).toEqual([]);
  expect(await aliasEffects(subjectId)).toBe(before + 1);
  // A receipt that recorded no removal must never become a later deletion.
  const restored = { ...first, asOf: '2026-10-22' };
  expect((await fixture.request('PUT', writePath(subjectId), { body: compare(subjectId, correctClear, restored) })).status).toBe(200);
  expect((await fixture.request('POST', clearPath(subjectId), { body: staleClear, key: staleKey })).status).toBe(204);
  expect(await sourceStatistics(subjectId)).toEqual([{ source, ...restored }]);
  await fixture.revokeWriter();
  try {
    await problem(await fixture.request('PUT', writePath(subjectId), { body: first, key: writeKey }), 403);
    await problem(await fixture.request('POST', clearPath(subjectId), { body: correctClear, key }), 403);
  } finally {
    await fixture.restoreWriter();
  }
});

test('a late configured facts fence hides committed serialization and its replay truthfully', async () => {
  const subjectId = await fixture.createSubject();
  const sourceAlias = 'feed-two';
  let sourceRecordId = 'alias-late-fence';
  while (partitionOf(tupleRoute(fixture.routeKey, sourceAlias, sourceRecordId)) === partitionOf(routeOf(subjectId)!)) {
    sourceRecordId += '-x';
  }
  const value = { ...baseStatistic(sourceRecordId), sourceAlias };
  const key = crypto.randomUUID();
  const barrier = observer.hold({ statement: sourceStatisticUpsert.sql }, 'before');
  const pending = fixture.request('PUT', writePath(subjectId), { body: value, key });
  await barrier.entered;
  try {
    await aliasTakedown(sourceAlias, sourceRecordId);
  } finally {
    barrier.release();
  }
  const failure = await problem(await pending, 404);
  expect(failure.effect_status).toBe('not_applicable');
  expect(JSON.stringify(failure)).not.toContain(sourceAlias);
  expect(JSON.stringify(failure)).not.toContain(sourceRecordId);
  const retryFailure = await problem(await fixture.request('PUT', writePath(subjectId), { body: value, key }), 403);
  expect(retryFailure.effect_status).toBe('not_applicable');
  expect(await stored(subjectId)).toMatchObject({ rows: [{ sourceRecordId, count: value.count }] });
  expect(await aliasEffects(subjectId)).toBe(1);
  expect(await sourceStatistics(subjectId)).toEqual([]);
  expect(
    (
      await fixture.request('POST', clearPath(subjectId), {
        body: { ...baseClear(sourceRecordId), sourceAlias },
      })
    ).status,
  ).toBe(204);
});

test('subject merge keeps the survivor current alias isolated from an old alias clear and write replay', async () => {
  const original = await fixture.createSubject();
  const survivor = await fixture.createSubject();
  const sourceRecordId = 'alias-merge-same-record';
  const oldValue = { ...baseStatistic(sourceRecordId), sourceAlias: 'feed-one' };
  const currentValue = { ...baseStatistic(sourceRecordId), sourceAlias: 'feed-two' };
  const oldKey = crypto.randomUUID();
  expect((await fixture.request('PUT', writePath(original), { body: oldValue, key: oldKey })).status).toBe(200);
  expect((await fixture.request('PUT', writePath(survivor), { body: currentValue })).status).toBe(200);
  const merged = await fixture.merge(original, survivor);
  expect(merged).toMatchObject({ redirected: original, survivor });
  expect(await sourceStatistics(original)).toEqual([{ source, ...currentValue }]);
  const replay = await problem(await fixture.request('PUT', writePath(original), { body: oldValue, key: oldKey }), 404);
  expect(replay.effect_status).toBe('not_applicable');
  expect(JSON.stringify(replay)).not.toContain('feed-two');
  const before = await aliasEffects(survivor);
  const staleKey = crypto.randomUUID();
  for (let repetition = 0; repetition < 2; repetition++) {
    expect(
      (
        await fixture.request('POST', clearPath(survivor), {
          body: { ...baseClear(sourceRecordId), sourceAlias: 'feed-one' },
          key: staleKey,
        })
      ).status,
    ).toBe(204);
  }
  expect(await aliasEffects(survivor)).toBe(before);
  expect(await sourceStatistics(survivor)).toEqual([{ source, ...currentValue }]);
  expect(
    (
      await fixture.request('POST', clearPath(survivor), {
        body: { ...baseClear(sourceRecordId), sourceAlias: 'feed-two' },
      })
    ).status,
  ).toBe(204);
  expect(await sourceStatistics(original)).toEqual([]);
});

test('default alias normalization retains original positive and clear receipt digests and strict unknown validation', async () => {
  const subjectId = await fixture.createSubject();
  const value = baseStatistic('alias-default-compatible');
  const key = crypto.randomUUID();
  const first = await fixture.request('PUT', writePath(subjectId), { body: value, key });
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({ source, ...value });
  const explicit = await fixture.request('PUT', writePath(subjectId), { body: { ...value, sourceAlias: source }, key });
  expect(explicit.status).toBe(200);
  expect(await explicit.json()).toEqual({ source, ...value });
  await problem(
    await fixture.request('PUT', writePath(subjectId), { body: { ...value, sourceAlias: 'feed-two' }, key }),
    422,
  );
  for (const sourceAlias of ['', 'Feed-two', 'a'.repeat(33), 'feed.two', 'feed-two\n', '源', null, 17]) {
    await problem(await fixture.request('PUT', writePath(subjectId), { body: { ...value, sourceAlias } }), 400);
    await problem(
      await fixture.request('POST', clearPath(subjectId), {
        body: { ...baseClear(value.sourceRecordId), sourceAlias },
      }),
      400,
    );
  }
  for (const body of [
    { sourceRecordId: value.sourceRecordId, sourceAlias: 'feed-two', asOf },
    { sourceRecordId: value.sourceRecordId, sourceAlias: 'feed-two', mean: null, asOf },
    { ...value, sourceAlias: 'feed-two', count: 0 },
    { ...value, sourceAlias: 'feed-two', mean: null },
  ]) {
    await problem(await fixture.request('PUT', writePath(subjectId), { body }), 400);
  }
  expect(await sourceStatistics(subjectId)).toEqual([{ source, ...value }]);
  const legacyReceipt = await fixture.database.admin.query(
    `SELECT request_digest FROM core.receipt
     WHERE principal_id=$1 AND command_kind='rating.source_statistic.write' AND idempotency_key=$2`,
    [fixture.actorId, key],
  );
  expect(legacyReceipt.rows).toHaveLength(1);
  expect(Buffer.from(legacyReceipt.rows[0]!.request_digest)).toEqual(
    createHash('sha256')
      .update(canonicalize([subjectId, source, value])!)
      .digest(),
  );
  const maximumAlias = 'a'.repeat(32);
  const custom = { ...value, sourceAlias: maximumAlias };
  const customKey = crypto.randomUUID();
  const customWrite = await fixture.request('PUT', writePath(subjectId), { body: compare(subjectId, value, custom), key: customKey });
  expect(customWrite.status).toBe(200);
  expect(await customWrite.json()).toEqual(expected(subjectId, custom));
  await problem(await fixture.request('PUT', writePath(subjectId), { body: value, key: customKey }), 422);
  expect((await fixture.request('PUT', writePath(subjectId), { body: compare(subjectId, custom, value) })).status).toBe(200);
  const clearKey = crypto.randomUUID();
  const clear = baseClear(value.sourceRecordId);
  expect((await fixture.request('POST', clearPath(subjectId), { body: clear, key: clearKey })).status).toBe(204);
  expect(
    (await fixture.request('POST', clearPath(subjectId), { body: { ...clear, sourceAlias: source }, key: clearKey }))
      .status,
  ).toBe(204);
  await problem(
    await fixture.request('POST', clearPath(subjectId), { body: { ...clear, sourceAlias: 'feed-two' }, key: clearKey }),
    422,
  );
  const legacyClearReceipt = await fixture.database.admin.query(
    `SELECT request_digest FROM core.receipt
     WHERE principal_id=$1 AND command_kind='rating.source_statistic.clear' AND idempotency_key=$2`,
    [fixture.actorId, clearKey],
  );
  expect(legacyClearReceipt.rows).toHaveLength(1);
  expect(Buffer.from(legacyClearReceipt.rows[0]!.request_digest)).toEqual(
    createHash('sha256')
      .update(canonicalize([subjectId, source, clear])!)
      .digest(),
  );
});

test('a configured tuple home unavailable503 does not use the provider tuple as a substitute', async () => {
  const subjectId = await fixture.createSubject();
  const sourceAlias = 'feed-two';
  let sourceRecordId = 'alias-unavailable';
  let tupleHome = partitionOf(tupleRoute(fixture.routeKey, sourceAlias, sourceRecordId));
  while (
    [partitionOf(routeOf(subjectId)!), partitionOf(tupleRoute(fixture.routeKey, source, sourceRecordId))].includes(
      tupleHome,
    )
  ) {
    sourceRecordId += '-x';
    tupleHome = partitionOf(tupleRoute(fixture.routeKey, sourceAlias, sourceRecordId));
  }
  const value = { ...baseStatistic(sourceRecordId), sourceAlias };
  expect((await fixture.request('PUT', writePath(subjectId), { body: value })).status).toBe(200);
  const previous = await fixture.database.admin.query(
    'SELECT write_state, moved_to FROM core.partition WHERE partition_no=$1',
    [tupleHome],
  );
  expect(previous.rows).toHaveLength(1);
  try {
    await fixture.database.admin.query(
      "UPDATE core.partition SET write_state='moved', moved_to='alias-unavailable' WHERE partition_no=$1",
      [tupleHome],
    );
    for (const response of [
      await fixture.request('GET', statisticPath(subjectId), { anonymous: true }),
      await fixture.request('PUT', writePath(subjectId), { body: { ...value, mean: 8.8 } }),
    ]) {
      const failure = await problem(response, 503);
      expect(failure.code).toBe('partition_unavailable');
      expect(JSON.stringify(failure)).not.toContain(sourceAlias);
      expect(JSON.stringify(failure)).not.toContain(sourceRecordId);
    }
  } finally {
    await fixture.database.admin.query('UPDATE core.partition SET write_state=$2, moved_to=$3 WHERE partition_no=$1', [
      tupleHome,
      previous.rows[0]!.write_state,
      previous.rows[0]!.moved_to,
    ]);
  }
  expect(await sourceStatistics(subjectId)).toEqual([{ source, ...value }]);
});

test('a rebind during GET cannot serialize either alias under the earlier binding', async () => {
  const subjectId = await fixture.createSubject();
  const sourceRecordId = 'alias-final-binding-race';
  const first = { ...baseStatistic(sourceRecordId), sourceAlias: 'feed-one' };
  const second = { ...baseStatistic(sourceRecordId), sourceAlias: 'feed-two' };
  expect((await fixture.request('PUT', writePath(subjectId), { body: first })).status).toBe(200);
  const barrier = observer.hold({ statement: sourceStatisticList.sql }, 'after');
  const pending = fixture.request('GET', statisticPath(subjectId), { anonymous: true });
  await barrier.entered;
  try {
    const replaced = await fixture.request('PUT', writePath(subjectId), { body: compare(subjectId, first, second) });
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toEqual(expected(subjectId, second));
  } finally {
    barrier.release();
  }
  const failure = await problem(await pending, 404);
  expect(JSON.stringify(failure)).not.toContain(sourceRecordId);
  expect(JSON.stringify(failure)).not.toContain('feed-one');
  expect(JSON.stringify(failure)).not.toContain('feed-two');
  expect(await sourceStatistics(subjectId)).toEqual([{ source, ...second }]);
});
