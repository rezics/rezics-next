import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture;
beforeAll(async () => {
  f = await createProfileEntryFixture();
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/personal_library:open')).status).toBe(200);
}, 120000);
afterAll(async () => {
  await f?.close();
});
test('fresh revisioned entry mutations require the exact native incarnation without poisoning old receipt compatibility', async () => {
  const subjectId = await f.createSubject('game');
  const entry = (await f.commands.putEntry(f.owner.actor, subjectId, { state: 'planned' }, entryKey())).value.entry;
  expect(entry.incarnationId).toBeString();
  const before = await f.inspect();
  const response = await f.send(f.owner.bearer, 'PUT', `/v1/libraryEntries/${subjectId}`, {
    state: 'planned',
    revision: entry.revision,
  });
  expect(response.status).toBe(409);
  expect(await f.inspect()).toEqual(before);
  const removed = await f.send(f.owner.bearer, 'DELETE', `/v1/libraryEntries/${subjectId}?revision=${entry.revision}`);
  expect(removed.status).toBe(409);
  expect(await f.inspect()).toEqual(before);
  const changed = await f.send(f.owner.bearer, 'PUT', `/v1/libraryEntries/${subjectId}`, {
    state: 'planned',
    revision: entry.revision,
    incarnationId: entry.incarnationId,
  });
  expect(changed.status).toBe(200);
}, 120000);
