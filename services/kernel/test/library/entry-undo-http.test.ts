import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture;
beforeAll(async () => {
  f = await createProfileEntryFixture();
}, 120000);
afterAll(async () => {
  await f?.close();
});
const clean = (body: Record<string, unknown>) => {
  const { request_id, ...stable } = body;
  return stable;
};
function privateFree(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    expect([
      'pin',
      'libraryProfilePin',
      'library_profile_pin',
      'releaseDigest',
      'profileId',
      'acceptingType',
      'transactionId',
      'transaction_id',
    ]).not.toContain(key);
    privateFree(child);
  }
}
test('native entry DELETE returns receipt-bound undo headers and restore exposes exact lifecycle conflicts without a pre-read or private storage fields', async () => {
  const subjectId = await f.createSubject('record');
  const path = `/v1/libraryEntries/${subjectId}`;
  const made = await f.send('owner', 'PUT', path, { state: 'listening' });
  expect(made.status).toBe(201);
  const original = (await made.json()).libraryEntry;
  expect(original.incarnationId).toEqual(expect.any(String));
  const deletePath = path + `?revision=${original.revision}&incarnationId=${original.incarnationId}`;
  const key = entryKey();
  const deleted = await f.send('owner', 'DELETE', deletePath, undefined, key);
  expect(deleted.status).toBe(204);
  expect(await deleted.text()).toBe('');
  const deletionId = deleted.headers.get('Library-Entry-Deletion-Id');
  const revisionHeader = deleted.headers.get('Library-Entry-Deletion-Revision');
  expect(deletionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(revisionHeader).toBe(String(original.revision + 1));
  expect(deleted.headers.get('Library-Entry-Restore-Until')).toBeNull();
  const input = { deletionId, revision: Number(revisionHeader) };
  const stale = await f.send('owner', 'POST', path + ':restore', { ...input, revision: input.revision + 1 });
  expect(stale.status).toBe(409);
  expect(await stale.json()).toMatchObject({
    code: 'library_entry_restore_stale',
    effect_status: 'not_applied',
    retryable: false,
  });
  const foreign = await f.send('other', 'POST', path + ':restore', input);
  const missing = await f.send('other', 'POST', path + ':restore', { ...input, deletionId: entryKey() });
  expect(foreign.status).toBe(404);
  expect(missing.status).toBe(404);
  expect(clean(await foreign.json())).toEqual(clean(await missing.json()));
  expect(
    (await f.send('owner', 'POST', path + ':restore', { ...input, revision: String(input.revision) })).status,
  ).toBe(400);
  expect((await f.send('owner', 'POST', path + ':restore', { ...input, state: 'planned' })).status).toBe(400);
  const restoreKey = entryKey();
  const restored = await f.send('owner', 'POST', path + ':restore', input, restoreKey);
  expect(restored.status).toBe(200);
  const restoredBody = await restored.json();
  expect(restoredBody.libraryEntry).toMatchObject({
    subjectId,
    state: 'listening',
    revision: original.revision + 2,
    incarnationId: original.incarnationId,
  });
  privateFree(restoredBody);
  const before = await f.inspect();
  const oldDelete = await f.send('owner', 'DELETE', deletePath, undefined, key);
  expect(oldDelete.status).toBe(204);
  expect(oldDelete.headers.get('Library-Entry-Deletion-Id')).toBe(deletionId);
  expect(oldDelete.headers.get('Library-Entry-Deletion-Revision')).toBe(revisionHeader);
  expect(await f.inspect()).toEqual(before);
  const replay = await f.send('owner', 'POST', path + ':restore', input, restoreKey);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toEqual(restoredBody);
  expect(await f.inspect()).toEqual(before);
  const again = await f.send(
    'owner',
    'DELETE',
    path + `?revision=${original.revision + 2}&incarnationId=${original.incarnationId}`,
  );
  expect(again.status).toBe(204);
  const d2 = {
    deletionId: again.headers.get('Library-Entry-Deletion-Id'),
    revision: Number(again.headers.get('Library-Entry-Deletion-Revision')),
  };
  expect((await f.send('owner', 'PUT', path, { state: 'listening' })).status).toBe(201);
  const occupied = await f.send('owner', 'POST', path + ':restore', d2);
  expect(occupied.status).toBe(409);
  expect(await occupied.json()).toMatchObject({ code: 'library_entry_restore_occupied', effect_status: 'not_applied' });
}, 120000);
test('entry undo OpenAPI publishes both response headers and the closed restore contract', async () => {
  const document = await Bun.file(new URL('../../../../contracts/openapi.json', import.meta.url)).json();
  const deleted = document.paths['/v1/libraryEntries/{subjectId}'].delete;
  expect(deleted.responses['204'].headers).toHaveProperty('Library-Entry-Deletion-Id');
  expect(deleted.responses['204'].headers).toHaveProperty('Library-Entry-Deletion-Revision');
  const restored = document.paths['/v1/libraryEntries/{subjectId}:restore'].post;
  expect(restored['x-exposure']).toBe('gate:personal_library');
  expect(restored['x-action']).toBe('library_entry:update');
  const schema = restored.requestBody.content['application/json'].schema;
  expect(schema.additionalProperties).toBe(false);
  expect(Object.keys(schema.properties).sort()).toEqual(['deletionId', 'revision']);
  for (const code of ['library_entry_restore_occupied', 'library_entry_restore_stale', 'library_entry_restore_expired'])
    expect(JSON.stringify(restored.responses['409'])).toContain(code);
});
