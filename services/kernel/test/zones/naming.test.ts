import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { pickZoneName, type ZoneConfiguration } from '@rezics/composition';
import { createBody, page, resourceFixture, type ResourceFixture } from './resource-fixture.ts';

let f: ResourceFixture;
beforeAll(async () => {
  f = await resourceFixture();
  await f.available();
}, 120_000);
afterAll(async () => {
  await f?.close();
});

// Authored for the native fixture; execution is deferred by the current verification policy.
test('an owner creates reads renames and translates one primary Zone name while legacy fallback and refused writes stay honest', async () => {
  const configuration: ZoneConfiguration = {
    primaryLanguage: 'ja',
    labels: { ja: '私の本棚' },
    pages: [{ route: '', document: page('A static home') }],
    scope: [],
  };
  const input = { configuration, mounts: [], visibility: 'private' };
  const headers = { 'idempotency-key': JSON.stringify(randomUUID()) };
  const created = await f.call('owner', 'POST', '/v1/zones', input, headers);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect(created.body.zone).toMatchObject({ revision: '1', labels: { ja: '私の本棚' }, primaryLanguage: 'ja' });
  const id = created.body.zone.id as string;
  const path = `/v1/zones/${id}`;
  expect((await f.configuration(id)).body.configuration).toEqual(configuration);
  expect((await f.call('anonymous', 'GET', path)).status).toBe(404);
  expect((await f.call('owner', 'POST', '/v1/zones', input, headers)).body).toEqual(created.body);

  const rename = structuredClone(configuration);
  rename.labels = { ja: '新しい本棚', de: 'Mein Regal' };
  const command = { configuration: rename, mounts: [] };
  const conditional = { ...f.conditional('1'), 'idempotency-key': JSON.stringify(randomUUID()) };
  const saved = await f.call('owner', 'PUT', `${path}/configuration`, command, conditional);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect((await f.configuration(id)).body.configuration).toEqual(rename);
  expect(pickZoneName(saved.body.zone, 'de')).toEqual({ text: 'Mein Regal', lang: 'de' });
  expect(pickZoneName(saved.body.zone, 'fr')).toEqual({ text: '新しい本棚', lang: 'ja' });
  expect((await f.call('owner', 'PUT', `${path}/configuration`, command, conditional)).body).toEqual(saved.body);

  const before = await f.raw(id);
  const events = await f.events(id);
  const receipts = await f.receipts();
  expect((await f.call('owner', 'PUT', `${path}/configuration`, command, f.conditional('1'))).status).toBe(412);
  expect((await f.call('other', 'PUT', `${path}/configuration`, command, f.conditional('2'))).status).toBe(403);
  for (const invalid of [
    { ...rename, labels: {} },
    { ...rename, labels: { ja: '   ' } },
    { ...rename, labels: { de: 'Mein Regal' } },
    { ...rename, labels: { ja: 'Name', de: '' } },
    { ...rename, labels: { ja: 'x'.repeat(81) } },
    { ...rename, labels: { ja: '<script>' } },
    { ...rename, labels: { ja: 'Name', it: 'Nome' } },
    { ...rename, primaryLanguage: 'it' },
    { ...rename, unexpected: true },
  ]) {
    expect(
      (
        await f.call(
          'owner',
          'PUT',
          `${path}/configuration`,
          { configuration: invalid, mounts: [] },
          f.conditional('2'),
        )
      ).status,
    ).toBe(400);
  }
  expect(await f.raw(id)).toEqual(before);
  expect(await f.events(id)).toEqual(events);
  expect(await f.receipts()).toBe(receipts);

  delete rename.labels.de;
  expect(
    (await f.call('owner', 'PUT', `${path}/configuration`, { configuration: rename, mounts: [] }, f.conditional('2')))
      .status,
  ).toBe(200);
  expect((await f.configuration(id)).body.configuration.labels).toEqual({ ja: '新しい本棚' });
  expect((await f.call('owner', 'POST', `${path}:publish`, { visibility: 'public' }, f.conditional('3'))).status).toBe(
    200,
  );
  const metadata = await f.call('anonymous', 'GET', path);
  const read = await f.read(id, 'anonymous', { route: '' }, ['fr']);
  expect(metadata.status).toBe(200);
  expect(read.status, JSON.stringify(read.body)).toBe(200);
  expect(read.body.zone).toEqual(metadata.body.zone);
  expect(pickZoneName(read.body.zone, 'fr')).toEqual({ text: '新しい本棚', lang: 'ja' });
  expect(metadata.body.zone).not.toHaveProperty('configuration');
  expect(metadata.body.zone).not.toHaveProperty('mounts');

  const legacy = createBody();
  legacy.configuration.scope = [];
  legacy.configuration.pages = [{ route: '', document: page('Legacy static home') }];
  const old = await f.create(legacy);
  const oldRead = (await f.configuration(old.id)).body;
  expect(oldRead.configuration).toEqual(legacy.configuration);
  expect(old).not.toHaveProperty('primaryLanguage');
  expect(pickZoneName(oldRead.zone, 'it')).toEqual({ text: legacy.configuration.labels.en, lang: 'en' });
  // A redacted legacy map uses the same fixed order, independent of property insertion order.
  expect(pickZoneName({ labels: { es: 'Sitio', ja: '本棚' } }, 'fr')).toEqual({ text: '本棚', lang: 'ja' });
  expect(pickZoneName({ labels: {} }, 'en')).toEqual({ text: '' });
  expect((await f.raw(old.id))!.configuration).toEqual(legacy.configuration);
  const oldPath = `/v1/zones/${old.id}/configuration`;
  const adopted = { ...legacy.configuration, primaryLanguage: 'ja' };
  expect(
    (await f.call('owner', 'PUT', oldPath, { configuration: adopted, mounts: [] }, f.conditional('1'))).status,
  ).toBe(200);
  // An older full-configuration client omits the new field, but cannot implicitly reset Japanese to English.
  expect(
    (await f.call('owner', 'PUT', oldPath, { configuration: legacy.configuration, mounts: [] }, f.conditional('2')))
      .status,
  ).toBe(200);
  const retained = (await f.configuration(old.id)).body;
  expect(retained.configuration.primaryLanguage).toBe('ja');
  expect(pickZoneName(retained.zone, 'it')).toEqual({ text: legacy.configuration.labels.ja, lang: 'ja' });
}, 180_000);
