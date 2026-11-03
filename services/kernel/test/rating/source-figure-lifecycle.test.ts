import { expect, test } from 'bun:test';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { tupleRoute } from '../../src/content/imported-contract.ts';
import upsert from '../../src/rating/source-statistic-upsert.sql';
import { observeSql } from '../content/support/sql-observer.ts';
import { createSourceStatisticLifecycleFixture } from './source-statistic-lifecycle-fixture.ts';

test('provider figures follow current Subject identity and exact alias facts fences', async () => {
  const fixture = await createSourceStatisticLifecycleFixture();
  const observer = observeSql(fixture.database.pool);
  try {
    const original = await fixture.createSubject();
    const survivor = await fixture.createSubject();
    const path = (id: string) => `/v1/subjects/${id}/source-statistics`;
    const body = { sourceAlias: 'permitted-bangumi', sourceRecordId: '123', scale: { min: 0, max: 10 },
      mean: 8, count: 17, asOf: '2026-11-01', licence: 'LicenseRef-Permitted-Test', attribution: 'Provider users',
      figures: { schemaVersion: 1, rank: { unit: 'subjects', position: 3 } } };
    const key = crypto.randomUUID();
    const put = await fixture.request('PUT', `${path(original)}/bangumi`, { body, key });
    expect(put.status).toBe(200);
    await fixture.merge(original, survivor);
    const redirected = await fixture.request('GET', path(original), { anonymous: true });
    expect(redirected.status).toBe(200);
    expect(await redirected.json()).toEqual([]);
    expect((await fixture.request('PUT', `${path(original)}/bangumi`, { body, key })).status).toBe(404);
    expect((await fixture.request('PUT', `${path(survivor)}/bangumi`, { body })).status).toBe(200);
    const fence = await fixture.request('POST', '/v1/sourceFences:takedown', {
      body: { source: body.sourceAlias, externalId: body.sourceRecordId, fieldGroup: 'facts', reason: 'Test fence' },
    });
    expect(fence.status).toBe(200);
    const hidden = await fixture.request('GET', path(survivor), { anonymous: true });
    expect(hidden.status).toBe(200);
    expect(await hidden.json()).toEqual([]);
    // A facts fence after admission but before commit must conceal the entire
    // committed figure and its retry, without claiming that no write occurred.
    const racing = await fixture.createSubject();
    let record = 1000;
    while (partitionOf(tupleRoute(fixture.routeKey, body.sourceAlias, String(record))) === partitionOf(routeOf(racing)!)) record++;
    const fresh = { ...body, sourceRecordId: String(record) };
    const retryKey = crypto.randomUUID();
    const barrier = observer.hold({ statement: upsert.sql }, 'before');
    const pending = fixture.request('PUT', `${path(racing)}/bangumi`, { body: fresh, key: retryKey });
    await barrier.entered;
    try {
      expect((await fixture.request('POST', '/v1/sourceFences:takedown', {
        body: { source: fresh.sourceAlias, externalId: fresh.sourceRecordId, fieldGroup: 'facts', reason: 'Racing fence' },
      })).status).toBe(200);
    } finally { barrier.release(); }
    const concealed = await pending;
    expect(concealed.status).toBe(404);
    expect((await concealed.json()).effect_status).toBe('not_applicable');
    const replay = await fixture.request('PUT', `${path(racing)}/bangumi`, { body: fresh, key: retryKey });
    expect(replay.status).toBe(403);
    expect((await replay.json()).effect_status).toBe('not_applicable');
  } finally { await observer.close(); await fixture.close(); }
}, 180_000);
