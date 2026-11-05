import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createBody, page, resourceFixture, type ResourceFixture } from './resource-fixture.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';

let f: ResourceFixture;
beforeAll(async () => {
  f = await resourceFixture();
  await f.available();
  await f.access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'operator', 'moderation:takedown');
}, 180_000);
afterAll(async () => {
  await f?.close();
}, 120_000);

const day = 86_400_000;

/** A published Zone whose only page and label carry distinct text, so each takedown is observable. */
async function publicZone() {
  const label = `Journey label ${randomUUID()}`;
  const text = `Journey page ${randomUUID()}`;
  const body = createBody();
  body.configuration.scope = [];
  body.configuration.labels.en = label;
  body.configuration.pages = [{ route: '', document: page(text) }];
  const created = await f.call('owner', 'POST', '/v1/zones', body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const published = await f.call(
    'owner',
    'POST',
    `/v1/zones/${created.body.zone.id}:publish`,
    { visibility: 'public' },
    f.conditional(created.body.zone.revision),
  );
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  return { id: published.body.zone.id as string, revision: published.body.zone.revision as string, label, text };
}

test('deleting a public Zone hides it at once, restores only inside its window, and takedown withholds one field', async () => {
  const zone = await publicZone();
  const path = `/v1/zones/${zone.id}`;
  expect((await f.read(zone.id)).status).toBe(200);

  const deleted = await f.call('owner', 'DELETE', path, undefined, f.conditional(zone.revision));
  expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
  expect(deleted.body.zone.deletedAt).not.toBeNull();
  expect((await f.read(zone.id)).status).toBe(404);
  expect((await f.read(zone.id, 'other')).status).toBe(404);
  const deletedRow = await f.raw(zone.id);
  const restoreUntil = deletedRow!.restore_until;
  expect(deletedRow!.state).toBe('deleted');

  // The owner keeps reading the deleted listing; another account cannot restore.
  const listed = await f.call('owner', 'GET', '/v1/zones?deleted=true');
  expect(listed.status).toBe(200);
  expect(JSON.stringify(listed.body)).toContain(zone.id);
  expect((await f.call('other', 'POST', `${path}:restore`, {}, f.conditional(deleted.body.zone.revision))).status).toBe(
    403,
  );

  // Moderation keeps its decision on a deleted Zone and never moves its deletion clock.
  const takedown = await f.call(
    'operator',
    'POST',
    `${path}:takedown`,
    { pointers: ['/labels/en'] },
    f.conditional(deleted.body.zone.revision),
  );
  expect(takedown.status, JSON.stringify(takedown.body)).toBe(200);
  const withheld = await f.raw(zone.id);
  expect(withheld!.state).toBe('deleted');
  expect(withheld!.restore_until).toEqual(restoreUntil);
  expect(withheld!.withholding).toEqual({ '/labels/en': {} });

  // Restore inside the window keeps the takedown; the withheld label stays absent for readers.
  f.advance(29 * day);
  const restored = await f.call('owner', 'POST', `${path}:restore`, {}, f.conditional(takedown.body.zone.revision));
  expect(restored.status, JSON.stringify(restored.body)).toBe(200);
  const shown = await f.read(zone.id);
  expect(shown.status).toBe(200);
  expect(JSON.stringify(shown.body)).toContain(zone.text);
  expect(JSON.stringify(shown.body)).not.toContain(zone.label);

  // Releasing only the label decision restores exactly that field.
  const released = await f.call(
    'operator',
    'POST',
    `${path}:releaseTakedown`,
    { pointers: ['/labels/en'] },
    f.conditional(restored.body.zone.revision),
  );
  expect(released.status, JSON.stringify(released.body)).toBe(200);
  expect(JSON.stringify((await f.read(zone.id)).body)).toContain(zone.label);
  const events = (await f.events(zone.id)).map((row) => row.type);
  expect(events).toEqual(
    expect.arrayContaining([
      'com.rezics.zone.deleted.v1',
      'com.rezics.zone.taken_down.v1',
      'com.rezics.zone.restored.v1',
      'com.rezics.zone.takedown_released.v1',
    ]),
  );
});

test('a Zone is not restorable at thirty days, and moderation keeps its page absent without a deletion clock', async () => {
  const zone = await publicZone();
  const path = `/v1/zones/${zone.id}`;
  const deleted = await f.call('owner', 'DELETE', path, undefined, f.conditional(zone.revision));
  expect(deleted.status).toBe(200);
  f.advance(30 * day);
  const late = await f.call('owner', 'POST', `${path}:restore`, {}, f.conditional(deleted.body.zone.revision));
  expect(late.status).toBe(409);
  expect((await f.raw(zone.id))!.state).toBe('deleted');
});

test('takedown is platform-only, names existing fields, and stale or repeated decisions refuse', async () => {
  const zone = await publicZone();
  const path = `/v1/zones/${zone.id}`;
  const body = { pointers: ['/pages/0/document'] };
  expect((await f.call('anonymous', 'POST', `${path}:takedown`, body, f.conditional(zone.revision))).status).toBe(401);
  expect((await f.call('owner', 'POST', `${path}:takedown`, body, f.conditional(zone.revision))).status).toBe(403);
  const missing = await f.call(
    'operator',
    'POST',
    `${path}:takedown`,
    { pointers: ['/pages/9/document'] },
    f.conditional(zone.revision),
  );
  expect(missing.status).toBe(400);
  expect(JSON.stringify(missing.body)).toContain('/pointers/0');
  expect(
    (await f.call('operator', 'POST', `${path}:takedown`, body, f.conditional(String(Number(zone.revision) + 7))))
      .status,
  ).toBe(412);

  const taken = await f.call('operator', 'POST', `${path}:takedown`, body, f.conditional(zone.revision));
  expect(taken.status).toBe(200);
  expect((await f.read(zone.id)).status).toBe(404);
  const repeated = await f.call(
    'operator',
    'POST',
    `${path}:takedown`,
    body,
    f.conditional(taken.body.zone.revision),
  );
  expect(repeated.status).toBe(409);
  const unknownRelease = await f.call(
    'operator',
    'POST',
    `${path}:releaseTakedown`,
    { pointers: ['/labels/en'] },
    f.conditional(taken.body.zone.revision),
  );
  expect(unknownRelease.status).toBe(409);
  // The page takedown leaves the Zone's own state and owner unchanged.
  const row = await f.raw(zone.id);
  expect(row!.state).toBe('active');
  expect(row!.owner_id).toBeTruthy();
});

test('configuration cannot move or replace a withheld array element, but unrelated fields still save', async () => {
  const body = createBody();
  body.configuration.scope = [];
  body.configuration.labels.en = `Array label ${randomUUID()}`;
  body.configuration.pages = [
    { route: '', document: page(`Front ${randomUUID()}`) },
    { route: 'notes', document: page(`Notes ${randomUUID()}`) },
  ];
  const created = await f.call('owner', 'POST', '/v1/zones', body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const path = `/v1/zones/${created.body.zone.id}`;
  const taken = await f.call(
    'operator',
    'POST',
    `${path}:takedown`,
    { pointers: ['/pages/1/document'] },
    f.conditional(created.body.zone.revision),
  );
  expect(taken.status, JSON.stringify(taken.body)).toBe(200);

  const configuration = await f.call('owner', 'GET', `${path}/configuration`);
  expect(configuration.status).toBe(200);
  const current = configuration.body.configuration;
  const movedPages = await f.call(
    'owner',
    'PUT',
    `${path}/configuration`,
    { configuration: { ...current, pages: [current.pages[0]] }, mounts: [] },
    f.conditional(taken.body.zone.revision),
  );
  expect(movedPages.status, JSON.stringify(movedPages.body)).toBe(409);

  const unrelated = await f.call(
    'owner',
    'PUT',
    `${path}/configuration`,
    { configuration: { ...current, labels: { en: `Renamed ${randomUUID()}` } }, mounts: [] },
    f.conditional(taken.body.zone.revision),
  );
  expect(unrelated.status, JSON.stringify(unrelated.body)).toBe(200);
  expect((await f.raw(created.body.zone.id))!.withholding).toEqual({ '/pages/1/document': {} });
});
