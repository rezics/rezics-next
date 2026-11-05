import { afterAll, beforeAll, expect, test } from 'bun:test';
import { IdempotencyConflictError } from '../../src/command/command.ts';
import { LibraryConflictError } from '../../src/library/entries.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture;
beforeAll(async () => {
  f = await createProfileEntryFixture();
}, 120000);
afterAll(async () => {
  await f?.close();
});
test('entry incarnation exposes actual identity and rejects missing or stale guards after refill', async () => {
  const subject = await f.createSubject('game'),
    path = '/v1/libraryEntries/' + subject;
  const created = await f.send('owner', 'PUT', path, { state: 'playing' });
  expect(created.status).toBe(201);
  const a = (await created.json()).libraryEntry;
  expect(a.incarnationId).toMatch(/^[0-9a-f-]{36}$/);
  const storedA = (await f.inspect()).entries.find((x) => x.row.subject_id === subject)!.row;
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
  const beforeMissing = await f.inspect();
  const oldClient = await f.send('owner', 'PUT', path, { state: 'playing', revision: current.libraryEntry.revision });
  expect(oldClient.status).toBe(409);
  expect(await f.inspect()).toEqual(beforeMissing);
}, 120000);

test('entry incarnation binds guarded writers and receipts across real clear and refill', async () => {
  const subject = await f.createSubject('record');
  const first = await f.commands.putEntry(f.owner.actor, subject, { state: 'listening' }, entryKey());
  const original = first.value.entry;
  const key = entryKey();
  const removed = await f.commands.deleteEntry(f.owner.actor, subject, original.revision, key, original.incarnationId!);
  const next = await f.commands.putEntry(f.owner.actor, subject, { state: 'planned' }, entryKey());
  expect(next.value.entry.revision).toBe(original.revision);
  expect(next.value.entry.incarnationId).not.toBe(original.incarnationId);
  const before = await f.inspect();
  await expect(
    f.commands.deleteEntry(f.owner.actor, subject, original.revision, entryKey(), original.incarnationId!),
  ).rejects.toMatchObject({ name: 'LibraryConflictError', reason: 'stale' });
  await expect(
    f.commands.putEntry(
      f.owner.actor,
      subject,
      {
        state: 'listening',
        revision: original.revision,
        incarnationId: original.incarnationId!,
      },
      entryKey(),
    ),
  ).rejects.toBeInstanceOf(LibraryConflictError);
  expect(await f.commands.deleteEntry(f.owner.actor, subject, original.revision, key, original.incarnationId!)).toEqual(
    { ...removed, replayed: true },
  );
  await expect(
    f.commands.deleteEntry(f.owner.actor, subject, original.revision, key, next.value.entry.incarnationId!),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);
  expect(await f.inspect()).toEqual(before);
  const unguardedKey = entryKey();
  await expect(
    f.commands.deleteEntry(f.owner.actor, subject, next.value.entry.revision, unguardedKey),
  ).rejects.toBeInstanceOf(LibraryConflictError);
  expect(await f.inspect()).toEqual(before);
  const guarded = await f.commands.deleteEntry(
    f.owner.actor,
    subject,
    next.value.entry.revision,
    unguardedKey,
    next.value.entry.incarnationId!,
  );
  expect(
    await f.commands.deleteEntry(
      f.owner.actor,
      subject,
      next.value.entry.revision,
      unguardedKey,
      next.value.entry.incarnationId!,
    ),
  ).toEqual({ ...guarded, replayed: true });
});
