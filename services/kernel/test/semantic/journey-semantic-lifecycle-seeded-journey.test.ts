import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { createBody, page, resourceFixture, type ResourceFixture } from '../zones/resource-fixture.ts';

let f: ResourceFixture;
beforeAll(async () => {
  f = await resourceFixture();
  await f.available();
  await f.access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'operator', 'moderation:takedown');
}, 180_000);
afterAll(async () => {
  await f?.close();
}, 120_000);

test('owner, another owner, anonymous reader, moderator and a delegate see current Zone lifecycle', async () => {
  const body = createBody();
  body.configuration.scope = [];
  body.configuration.labels.en = 'Public journey label';
  body.configuration.pages = [{ route: '', document: page('Public journey page') }];
  const created = await f.call('owner', 'POST', '/v1/zones', body);
  expect(created.status).toBe(201);
  const published = await f.call(
    'owner',
    'POST',
    `/v1/zones/${created.body.zone.id}:publish`,
    { visibility: 'public' },
    f.conditional(created.body.zone.revision),
  );
  expect(published.status).toBe(200);
  const id = published.body.zone.id as string;
  expect((await f.read(id, 'anonymous')).status).toBe(200);
  expect((await f.read(id, 'other')).status).toBe(200);
  await f.grant(id, 'editor', 'zone:read');
  expect((await f.read(id, 'editor')).status).toBe(200);

  expect(
    (await f.call('anonymous', 'DELETE', `/v1/zones/${id}`, undefined, f.conditional(published.body.zone.revision)))
      .status,
  ).toBe(401);
  expect(
    (await f.call('other', 'DELETE', `/v1/zones/${id}`, undefined, f.conditional(published.body.zone.revision))).status,
  ).toBe(403);
  const deleted = await f.call(
    'owner',
    'DELETE',
    `/v1/zones/${id}`,
    undefined,
    f.conditional(published.body.zone.revision),
  );
  expect(deleted.status).toBe(200);
  expect((await f.read(id, 'anonymous')).status).toBe(404);
  expect((await f.read(id, 'other')).status).toBe(404);
  const trash = await f.call('owner', 'GET', '/v1/zones?deleted=true');
  expect(trash.status).toBe(200);
  expect(trash.body.zones.some((zone: { id: string }) => zone.id === id)).toBe(true);

  const taken = await f.call(
    'operator',
    'POST',
    `/v1/zones/${id}:takedown`,
    { pointers: ['/labels/en'] },
    f.conditional(deleted.body.zone.revision),
  );
  expect(taken.status).toBe(200);
  const restored = await f.call(
    'owner',
    'POST',
    `/v1/zones/${id}:restore`,
    {},
    f.conditional(taken.body.zone.revision),
  );
  expect(restored.status).toBe(200);
  const shown = await f.read(id, 'anonymous');
  expect(shown.status).toBe(200);
  expect(JSON.stringify(shown.body)).toContain('Public journey page');
  expect(JSON.stringify(shown.body)).not.toContain('Public journey label');
});
