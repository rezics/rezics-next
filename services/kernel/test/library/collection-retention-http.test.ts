import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture;
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>;
beforeAll(async () => {
  f = await createProfileEntryFixture();
  owner = await f.identity([
    'subject:read',
    'collection:create',
    'collection:read',
    'collection:update',
    'collection:delete',
  ]);
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/collections:open')).status).toBe(200);
}, 120000);
afterAll(async () => {
  await f?.close();
});
test('Collection exact Undo preserves identity visibility ordered duplicate occurrences and notes without a new owner grant', async () => {
  const subjectId = await f.createSubject('game');
  const made = await f.send(owner.bearer, 'POST', '/v1/collections', {
    title: 'Original curated title',
    description: 'private original',
    visibility: 'private',
  });
  expect(made.status).toBe(201);
  const original = (await made.json()).collection,
    path = `/v1/collections/${original.id}`;
  const add = async (note: string) => {
    const r = await f.send(owner.bearer, 'POST', path + '/members', { subjectId, note });
    expect(r.status).toBe(201);
    return (await r.json()).member;
  };
  const a = await add('first note'),
    b = await add('second note');
  expect(a.id).not.toBe(b.id);
  const live = await f.send(owner.bearer, 'GET', path);
  expect(live.status).toBe(200);
  const before = (await live.json()).collection;
  const key = entryKey(),
    deletePath = `${path}?revision=${before.revision}`;
  // The command commits, but its response is discarded as if the acknowledgement were lost.
  await f.send(owner.bearer, 'DELETE', deletePath, undefined, key);
  const committedDeleteCount = await f.pool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM core.outbox WHERE subject=$1 AND type='com.rezics.library.collection.deleted.v1'",
    [original.id],
  );
  expect(committedDeleteCount.rows[0]?.count).toBe('1');
  // Simulate a caller retrying the exact command after losing the successful response.
  const deleted = await f.send(owner.bearer, 'DELETE', deletePath, undefined, key);
  expect(deleted.status).toBe(204);
  const deletionId = deleted.headers.get('Library-Collection-Deletion-Id'),
    revision = Number(deleted.headers.get('Library-Collection-Deletion-Revision'));
  expect(deletionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(revision).toBeGreaterThan(before.revision);
  expect((await f.send('anonymous', 'GET', path)).status).toBe(404);
  const restored = await f.send(owner.bearer, 'POST', path + ':restore', { deletionId, revision });
  expect(restored.status).toBe(200);
  const value = (await restored.json()).collection;
  expect(value).toMatchObject({
    id: original.id,
    title: original.title,
    description: original.description,
    visibility: 'private',
    memberCount: 2,
  });
  expect(value.revision).toBeGreaterThan(revision);
  const page = await f.send(owner.bearer, 'GET', path + '/members');
  expect(page.status).toBe(200);
  expect((await page.json()).members).toEqual([a, b]);
  const replay = await f.send(owner.bearer, 'DELETE', `${path}?revision=${before.revision}`, undefined, key);
  expect(replay.status).toBe(204);
  expect(replay.headers.get('Library-Collection-Deletion-Id')).toBe(deletionId);
  expect((await f.send(owner.bearer, 'GET', path)).status).toBe(200);
}, 120000);
