import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { compileSessionProfile, sessionScopes } from './support/session-profile-fixture.ts';
let f: NativeProfileFixture;
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>;
beforeAll(async () => {
  f = await createProfileEntryFixture();
  owner = await f.identity([...sessionScopes, 'published_log:create', 'published_log:read', 'published_log:delete']);
  await f.activate(await f.publish(await compileSessionProfile()));
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/reading_progress:open')).status).toBe(200);
}, 120000);
afterAll(async () => {
  await f?.close();
});
test('published reading log retracts immediately and Undo restores its original snapshot rather than recopying private session state', async () => {
  const subjectId = await f.createSubject('game');
  const started = await f.send(owner.bearer, 'POST', '/v1/progressSessions', {
    subjectId,
    mode: 'scalar_amount',
    unit: 'minute',
  });
  expect(started.status).toBe(201);
  const session = (await started.json()).progressSession;
  const made = await f.send(owner.bearer, 'POST', '/v1/publishedLogs', {
    sessionId: session.id,
    note: 'chosen public note',
  });
  expect(made.status).toBe(201);
  const original = (await made.json()).publishedLog;
  const revision = Number(made.headers.get('Library-Published-Log-Revision'));
  expect(revision).toBeGreaterThan(0);
  const path = `/v1/publishedLogs/${original.id}`,
    key = entryKey();
  const removed = await f.send(owner.bearer, 'DELETE', `${path}?revision=${revision}`, undefined, key);
  expect(removed.status).toBe(200);
  const deletionId = removed.headers.get('Library-Published-Log-Deletion-Id');
  const deletedRevision = Number(removed.headers.get('Library-Published-Log-Deletion-Revision'));
  expect(deletionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(deletedRevision).toBeGreaterThan(revision);
  const hidden = await f.send('anonymous', 'GET', path);
  expect(hidden.status).toBe(200);
  const tombstone = (await hidden.json()).publishedLog;
  expect(tombstone).toMatchObject({ id: original.id, deleted: true });
  expect(tombstone).not.toHaveProperty('note');
  expect(tombstone).not.toHaveProperty('accountId');
  const completed = await f.send(owner.bearer, 'POST', `/v1/progressSessions/${session.id}:complete`, {
    revision: session.revision,
  });
  expect(completed.status).toBe(200);
  const restored = await f.send(owner.bearer, 'POST', path + ':restore', { deletionId, revision: deletedRevision });
  expect(restored.status).toBe(200);
  const value = (await restored.json()).publishedLog;
  expect(value).toMatchObject({
    id: original.id,
    sessionState: original.sessionState,
    startedAt: original.startedAt,
    completedAt: original.completedAt,
    note: original.note,
    publishedAt: original.publishedAt,
  });
  expect(value.sessionState).not.toBe('completed');
  const replay = await f.send(owner.bearer, 'DELETE', `${path}?revision=${revision}`, undefined, key);
  expect(replay.status).toBe(200);
  expect(replay.headers.get('Library-Published-Log-Deletion-Id')).toBe(deletionId);
  expect((await f.send('anonymous', 'GET', path)).status).toBe(200);
}, 120000);
