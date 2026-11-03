import { expect, test } from 'bun:test';
import { createSourceStatisticLifecycleFixture } from './source-statistic-lifecycle-fixture.ts';

test('provider figures follow current Subject identity and exact alias facts fences', async () => {
  const fixture = await createSourceStatisticLifecycleFixture();
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
  } finally { await fixture.close(); }
}, 180_000);
