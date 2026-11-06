import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createBody, page, resourceFixture, type ResourceFixture } from './resource-fixture.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';

let f: ResourceFixture;
beforeAll(async () => {
  f = await resourceFixture();
  await f.available();
  await f.access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'operator', 'moderation:takedown');
  await f.access.grant({ route: 0, id: GLOBAL_CONTEXT }, 'operator', 'zone:purge');
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
  // The decision records the element's identity chain and the revision it was bound at.
  expect(Object.keys(withheld!.withholding)).toEqual(['/labels/en']);
  expect(withheld!.withholding['/labels/en'].chain).toEqual([{ key: 'labels' }, { key: 'en' }]);

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
  const repeated = await f.call('operator', 'POST', `${path}:takedown`, body, f.conditional(taken.body.zone.revision));
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

test('edits rebind a covered page through reorder and edit, retain superseded and removed originals, and release only live coverage', async () => {
  const body = createBody();
  body.configuration.scope = [];
  body.configuration.labels.en = `Array label ${randomUUID()}`;
  const notes = `Notes ${randomUUID()}`;
  body.configuration.pages = [
    { route: '', document: page(`Front ${randomUUID()}`) },
    { route: 'notes', document: page(notes) },
  ];
  const created = await f.call('owner', 'POST', '/v1/zones', body);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const zone = created.body.zone.id as string;
  const path = `/v1/zones/${zone}`;
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

  // Reordering moves the covered page and its decision together; readers still get no notes page.
  const reordered = await f.call(
    'owner',
    'PUT',
    `${path}/configuration`,
    { configuration: { ...current, pages: [current.pages[1], current.pages[0]] }, mounts: [] },
    f.conditional(taken.body.zone.revision),
  );
  expect(reordered.status, JSON.stringify(reordered.body)).toBe(200);
  expect((await f.read(zone, 'anonymous', { route: 'notes' })).status).toBe(404);
  expect((await f.read(zone)).status).toBe(200);
  const moved = await f.raw(zone);
  expect(Object.keys(moved!.withholding)).toEqual(['/pages/0/document']);
  expect(moved!.withholding.custody).toBeUndefined();

  // Delegates get no configuration while a live decision exists.
  await f.grant(zone, 'editor', 'zone:configure');
  expect((await f.call('editor', 'GET', `${path}/configuration`)).status).toBe(403);

  // Editing the covered page keeps its decision on the edited page and retains the superseded original.
  const replaced = `Replaced ${randomUUID()}`;
  const edited = await f.call(
    'owner',
    'PUT',
    `${path}/configuration`,
    {
      configuration: {
        ...current,
        pages: [{ ...current.pages[1], document: page(replaced) }, current.pages[0]],
      },
      mounts: [],
    },
    f.conditional(reordered.body.zone.revision),
  );
  expect(edited.status, JSON.stringify(edited.body)).toBe(200);
  expect((await f.read(zone, 'anonymous', { route: 'notes' })).status).toBe(404);
  const afterEdit = await f.raw(zone);
  expect(Object.keys(afterEdit!.withholding)).toEqual(['/pages/0/document']);
  expect(afterEdit!.withholding.custody).toEqual([
    expect.objectContaining({ pointer: '/pages/0/document', version: reordered.body.zone.revision }),
  ]);
  expect(JSON.stringify(afterEdit!.withholding.custody)).toContain(notes);

  // Removing the covered page retains its current original and clears the live decision; nothing is guessed.
  const removed = await f.call(
    'owner',
    'PUT',
    `${path}/configuration`,
    { configuration: { ...current, pages: [current.pages[0]] }, mounts: [] },
    f.conditional(edited.body.zone.revision),
  );
  expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  const afterRemoval = await f.raw(zone);
  expect(afterRemoval!.withholding.custody).toHaveLength(2);
  expect(afterRemoval!.withholding.custody[1]).toEqual(
    expect.objectContaining({ pointer: '/pages/0/document', version: edited.body.zone.revision }),
  );
  expect(JSON.stringify(afterRemoval!.withholding.custody[1])).toContain(replaced);
  expect(Object.keys(afterRemoval!.withholding).filter((key) => key.startsWith('/'))).toEqual([]);
  // Retained originals are never part of any configuration read.
  const owned = await f.call('owner', 'GET', `${path}/configuration`);
  expect(owned.body.configuration.pages).toHaveLength(1);
  expect(JSON.stringify(owned.body)).not.toContain(replaced);

  // Named release addresses live coverage only; the removed page's decision is already gone.
  const releasedGone = await f.call(
    'operator',
    'POST',
    `${path}:releaseTakedown`,
    { pointers: ['/pages/0/document'] },
    f.conditional(removed.body.zone.revision),
  );
  expect(releasedGone.status).toBe(409);

  // An unrelated edit saves and keeps the retained originals.
  const unrelated = await f.call(
    'owner',
    'PUT',
    `${path}/configuration`,
    { configuration: { ...current, pages: [current.pages[0]], labels: { en: `Renamed ${randomUUID()}` } }, mounts: [] },
    f.conditional(removed.body.zone.revision),
  );
  expect(unrelated.status, JSON.stringify(unrelated.body)).toBe(200);
  expect((await f.raw(zone))!.withholding.custody).toHaveLength(2);
});

test('ordinary owners cannot early-purge, a hold blocks cleanup, and legal order then removes a private Zone', async () => {
  const created = await f.call('owner', 'POST', '/v1/zones', createBody());
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const id = created.body.zone.id as string;
  const deleted = await f.call(
    'owner',
    'DELETE',
    `/v1/zones/${id}`,
    undefined,
    f.conditional(created.body.zone.revision),
  );
  expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
  expect((await f.call('owner', 'POST', `/v1/platform/zones/${id}:purge`, { reason: 'early' })).status).toBe(403);
  const held = await f.call('operator', 'POST', `/v1/platform/zones/${id}:hold`, { reason: 'Legal preservation' });
  expect(held.status, JSON.stringify(held.body)).toBe(200);
  expect(held.body.held).toBe(true);
  f.advance(31 * day);
  expect((await f.purge(id)).next).toBeNull();
  expect((await f.raw(id))!.configuration).not.toBeNull();
  expect((await f.call('operator', 'POST', `/v1/platform/zones/${id}:releaseHold`, {})).status).toBe(200);
  const purge = await f.call('operator', 'POST', `/v1/platform/zones/${id}:purge`, {
    reason: 'Legal order',
    order: 'court-order-1',
  });
  expect(purge.status, JSON.stringify(purge.body)).toBe(200);
  expect(purge.body.state).toBe('purge_pending');
  expect((await f.purge(id)).next).toBeNull();
  expect(await f.raw(id)).toBeUndefined();
});
