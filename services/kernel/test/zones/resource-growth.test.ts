import { afterAll, beforeAll, expect, test } from 'bun:test';
import { checkGrowth } from '../support/growth.ts';
import { createBody, page, resourceFixture, type ResourceFixture } from './resource-fixture.ts';

let f: ResourceFixture;
beforeAll(async () => {
  f = await resourceFixture();
  await f.available();
}, 120_000);
afterAll(async () => {
  await f?.close();
});

test('Zone resource point metadata and bounded owned keys retain native growth bounds', async () => {
  const input = createBody();
  input.configuration.scope = [];
  input.configuration.pages = [{ route: '', document: page('Growth') }];
  const created = await f.call('owner', 'POST', '/v1/zones', input);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const probe = created.body.zone as { id: string };
  const report = await checkGrowth(f.db, {
    name: 'Zone resource metadata and owned keys',
    scales: [64, 512, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(_db, scale, previous) {
      // Every resource, grant, receipt and event is produced by the actual parent-authorized API.
      for (let index = previous; index < scale; index++) await f.create(input);
    },
    async operation() {
      const metadata = await f.call('owner', 'GET', `/v1/zones/${probe.id}`);
      expect(metadata.status).toBe(200);
      expect(Object.keys(metadata.body.zone).sort()).toEqual([
        'appearance',
        'id',
        'labels',
        'navigation',
        'revision',
        'visibility',
      ]);
      const owned = await f.call('owner', 'GET', '/v1/zones?limit=1');
      expect(owned.status).toBe(200);
      expect(owned.body.zones).toHaveLength(1);
      expect(owned.body.next).toBeString();
    },
  });
  expect(report.samples.map((sample) => sample.scale)).toEqual([64, 512, 4096]);
}, 900_000);
