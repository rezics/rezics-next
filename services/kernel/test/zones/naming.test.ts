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

test('public shells preserve withheld explicit naming through an unrelated rename and pointer releases', async () => {
  const configuration: ZoneConfiguration = {
    primaryLanguage: 'ja',
    labels: { ja: '本棚', en: 'Books' },
    pages: [{ route: '', document: page('A static home') }],
    scope: [],
  };
  const created = await f.call('owner', 'POST', '/v1/zones', {
    configuration,
    mounts: [],
    visibility: 'public',
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.zone.id as string;
  const path = `/v1/zones/${id}`;
  await f.grant(id, 'operator', 'moderation:takedown');
  const taken = await f.call(
    'operator',
    'POST',
    `${path}:takedown`,
    { pointers: ['/primaryLanguage', '/labels/ja'] },
    f.conditional('1'),
  );
  expect(taken.status, JSON.stringify(taken.body)).toBe(200);
  expect(taken.body.zone.primaryLanguage).toBeNull();
  expect(taken.body.zone.labels).toEqual({ en: 'Books' });
  expect(pickZoneName(taken.body.zone, 'de')).toEqual({ text: '' });

  for (const reader of ['owner', 'other', 'anonymous'] as const) {
    const metadata = await f.call(reader, 'GET', path);
    const read = await f.read(id, reader, { route: '' }, ['de']);
    expect(metadata.status, JSON.stringify(metadata.body)).toBe(200);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.zone).toEqual(metadata.body.zone);
    expect(metadata.body.zone.primaryLanguage).toBeNull();
    expect(metadata.body.zone.labels).toEqual({ en: 'Books' });
    expect(pickZoneName(metadata.body.zone, 'de')).toEqual({ text: '' });
    expect(pickZoneName(metadata.body.zone, 'en')).toEqual({ text: 'Books', lang: 'en' });
    expect(metadata.body.zone).not.toHaveProperty('configuration');
    expect(metadata.body.zone).not.toHaveProperty('ownerId');
  }
  const owned = (await f.configuration(id)).body;
  expect(owned.zone).toEqual(taken.body.zone);
  expect(owned.configuration).toEqual(configuration);
  const listed = await f.call('owner', 'GET', '/v1/zones?limit=100');
  expect(listed.status, JSON.stringify(listed.body)).toBe(200);
  expect(listed.body.zones.find((zone: { id: string }) => zone.id === id)).toEqual(owned.zone);
  const before = (await f.raw(id))!;
  expect(before.configuration).toEqual(configuration);

  const rename = structuredClone(configuration);
  rename.labels.en = 'New books';
  const saved = await f.call(
    'owner',
    'PUT',
    `${path}/configuration`,
    { configuration: rename, mounts: [] },
    f.conditional('2'),
  );
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body.zone.primaryLanguage).toBeNull();
  expect(saved.body.zone.labels).toEqual({ en: 'New books' });
  expect(pickZoneName(saved.body.zone, 'de')).toEqual({ text: '' });
  expect(pickZoneName(saved.body.zone, 'en')).toEqual({ text: 'New books', lang: 'en' });
  const after = (await f.raw(id))!;
  expect(after.configuration).toEqual(rename);
  expect(Object.keys(after.withholding).sort()).toEqual(Object.keys(before.withholding).sort());
  expect(after.withholding.custody).toEqual(before.withholding.custody);

  const nameReleased = await f.call(
    'operator',
    'POST',
    `${path}:releaseTakedown`,
    { pointers: ['/labels/ja'] },
    f.conditional('3'),
  );
  expect(nameReleased.status, JSON.stringify(nameReleased.body)).toBe(200);
  expect(nameReleased.body.zone.primaryLanguage).toBeNull();
  expect(nameReleased.body.zone.labels).toEqual(rename.labels);
  expect(pickZoneName(nameReleased.body.zone, 'de')).toEqual({ text: '' });
  expect(pickZoneName(nameReleased.body.zone, 'ja')).toEqual({ text: '本棚', lang: 'ja' });
  const primaryReleased = await f.call(
    'operator',
    'POST',
    `${path}:releaseTakedown`,
    { pointers: ['/primaryLanguage'] },
    f.conditional('4'),
  );
  expect(primaryReleased.status, JSON.stringify(primaryReleased.body)).toBe(200);
  expect(primaryReleased.body.zone.primaryLanguage).toBe('ja');
  expect(primaryReleased.body.zone.labels).toEqual(rename.labels);
  expect(pickZoneName(primaryReleased.body.zone, 'de')).toEqual({ text: '本棚', lang: 'ja' });
  expect((await f.raw(id))!.configuration).toEqual(rename);
}, 180_000);
