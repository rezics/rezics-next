import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture;
beforeAll(async () => {
  f = await createProfileEntryFixture();
}, 120000);
afterAll(async () => {
  await f?.close();
});
test('entry incarnation phase one exposes actual identity accepts optional guards and rejects a stale guarded mutation after refill', async () => {
  const subject = await f.createSubject('game'),
    path = '/v1/libraryEntries/' + subject;
  const created = await f.send('owner', 'PUT', path, { state: 'playing' });
  expect(created.status).toBe(201);
  const a = (await created.json()).libraryEntry;
  expect(a.incarnationId).toMatch(/^[0-9a-f-]{36}$/);
  const storedA = (await f.inspect()).entries.find((x) => x.subject_id === subject)!;
  expect(storedA.incarnation_id).toBe(a.incarnationId);
  const listed = await f.send('owner', 'GET', '/v1/libraryEntries?limit=100');
  expect(listed.status).toBe(200);
  expect(
    (await listed.json()).libraryEntries.find((x: { subjectId: string }) => x.subjectId === subject).incarnationId,
  ).toBe(a.incarnationId);
  const removed = await f.send(
    'owner',
    'DELETE',
    path + '?revision=' + a.revision + '&incarnationId=' + a.incarnationId,
  );
  expect(removed.status).toBe(204);
  const recreated = await f.send('owner', 'PUT', path, { state: 'playing' });
  expect(recreated.status).toBe(201);
  const b = (await recreated.json()).libraryEntry;
  expect(b.revision).toBe(a.revision);
  expect(b.incarnationId).not.toBe(a.incarnationId);
  const before = await f.inspect();
  const stale = await f.send('owner', 'DELETE', path + '?revision=' + b.revision + '&incarnationId=' + a.incarnationId);
  expect(stale.status).toBe(409);
  const staleUpdate = await f.send('owner', 'PUT', path, {
    state: 'playing',
    revision: b.revision,
    incarnationId: a.incarnationId,
  });
  expect(staleUpdate.status).toBe(409);
  expect(await f.inspect()).toEqual(before);
  const key = entryKey();
  const updated = await f.send(
    'owner',
    'PUT',
    path,
    { state: 'playing', revision: b.revision, incarnationId: b.incarnationId },
    key,
  );
  expect(updated.status).toBe(200);
  const current = await updated.json();
  expect(current.libraryEntry.incarnationId).toBe(b.incarnationId);
  const replay = await f.send(
    'owner',
    'PUT',
    path,
    { state: 'playing', revision: b.revision, incarnationId: b.incarnationId },
    key,
  );
  expect(replay.status).toBe(200);
  expect((await replay.json()).libraryEntry).toEqual(current.libraryEntry);
  const oldClient = await f.send('owner', 'PUT', path, { state: 'playing', revision: current.libraryEntry.revision });
  expect(oldClient.status).toBe(200);
}, 120000);
