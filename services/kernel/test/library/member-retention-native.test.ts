import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createGrantCommands } from '../../src/access/grant-commands.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let f: NativeProfileFixture;
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let time = Date.now();
const scopes = ['subject:read', 'collection:create', 'collection:read', 'collection:update', 'collection:delete'];
beforeAll(async () => {
  f = await createProfileEntryFixture({ clock: () => new Date(time) });
  owner = await f.identity(scopes);
  expect((await f.send('steward', 'POST', '/v1/platform/exposure/collections:open')).status).toBe(200);
}, 120000);
afterAll(async () => {
  await f?.close();
});
async function make(visibility = 'private') {
  const subjectId = await f.createSubject('game');
  const response = await f.send(owner.bearer, 'POST', '/v1/collections', { title: 'Occurrence lifecycle', visibility });
  expect(response.status).toBe(201);
  const collection = (await response.json()).collection;
  const root = `/v1/collections/${collection.id}`;
  const add = async (note = 'original note', after?: string | null) => {
    const response = await f.send(owner.bearer, 'POST', root + '/members', {
      subjectId,
      note,
      ...(after === undefined ? {} : { after }),
    });
    expect(response.status).toBe(201);
    return (await response.json()).member;
  };
  const first = await add();
  const path = `${root}/members/${first.id}`;
  const parent = async () => {
    const response = await f.send(owner.bearer, 'GET', root);
    expect(response.status).toBe(200);
    return (await response.json()).collection;
  };
  const remove = async (bearer = owner.bearer, key = entryKey()) => {
    const revision = (await parent()).revision;
    const response = await f.send(bearer, 'DELETE', `${path}?revision=${revision}`, undefined, key);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    return {
      deletionId: response.headers.get('Library-Collection-Member-Deletion-Id')!,
      revision: Number(response.headers.get('Library-Collection-Member-Deletion-Revision')),
    };
  };
  const snapshot = async () =>
    (
      await f.pool.query(
        'SELECT to_jsonb(m) AS row FROM library.collection_member m WHERE route=$1 AND collection_id=$2 AND member_id=$3',
        [routeOf(collection.id), collection.id, first.id],
      )
    ).rows;
  return { collection, subjectId, root, path, add, first, parent, remove, snapshot };
}
async function code(response: Response, expected: string) {
  expect(response.status).toBe(409);
  expect((await response.json()).code).toBe(expected);
}
test('parent CAS precedes fresh removal; exact episode Undo tolerates unrelated sibling writes and replay never moves source generation', async () => {
  const m = await make();
  const parent = await m.parent();
  const receiptKey = entryKey();
  const removed = await m.remove(owner.bearer, receiptKey);
  const sibling = await m.add('independent sibling');
  const before = await m.snapshot();
  await code(
    await f.send(owner.bearer, 'POST', m.path + ':restore', { ...removed, revision: removed.revision + 1 }),
    'member_restore_stale',
  );
  expect(await m.snapshot()).toEqual(before);
  const key = entryKey();
  const restored = await f.send(owner.bearer, 'POST', m.path + ':restore', removed, key);
  expect(restored.status).toBe(200);
  expect((await restored.json()).member).toEqual(m.first);
  const observed = await f.pool.query(
    'SELECT source_generation,revision,member_count FROM library.collection WHERE route=$1 AND collection_id=$2',
    [routeOf(m.collection.id), m.collection.id],
  );
  const replay = await f.send(owner.bearer, 'POST', m.path + ':restore', removed, key);
  expect(replay.status).toBe(200);
  expect((await replay.json()).member).toEqual(m.first);
  const deletedReplay = await f.send(
    owner.bearer,
    'DELETE',
    `${m.path}?revision=${parent.revision}`,
    undefined,
    receiptKey,
  );
  expect(deletedReplay.status).toBe(204);
  expect(deletedReplay.headers.get('Library-Collection-Member-Deletion-Id')).toBe(removed.deletionId);
  expect(
    (
      await f.pool.query(
        'SELECT source_generation,revision,member_count FROM library.collection WHERE route=$1 AND collection_id=$2',
        [routeOf(m.collection.id), m.collection.id],
      )
    ).rows,
  ).toEqual(observed.rows);
  const page = await f.send(owner.bearer, 'GET', m.root + '/members');
  expect((await page.json()).members.map((member: { id: string }) => member.id)).toEqual([m.first.id, sibling.id]);
  await code(await f.send(owner.bearer, 'DELETE', `${m.path}?revision=${parent.revision}`), 'conflict');
});
test('native delegated editor can Undo a private occurrence; revoked authority cannot replay a retained receipt', async () => {
  const m = await make();
  const editor = await f.identity(scopes);
  const grants = createGrantCommands({
    pool: f.pool,
    access: f.access,
    managementAction: 'access:grant',
    clock: () => new Date(time),
  });
  const input = {
    resource: { route: routeOf(m.collection.id)!, id: m.collection.id },
    subject: { kind: 'account' as const, id: editor.actor.accountId },
    actions: ['collection:read', 'collection:update'],
    valid: '(,)',
  };
  const context = () => ({ actor: f.steward.actor, deadline: deadlineFor(30000) });
  await grants.create(context(), { ...input, key: entryKey() });
  const removed = await m.remove(editor.bearer);
  const key = entryKey();
  const response = await f.send(editor.bearer, 'POST', m.path + ':restore', removed, key);
  expect(response.status).toBe(200);
  expect((await response.json()).member).toEqual(m.first);
  await grants.revoke(context(), { ...input, key: entryKey() });
  const denied = await f.send(editor.bearer, 'POST', m.path + ':restore', removed, key);
  expect(denied.status).toBe(404);
  expect(await denied.text()).not.toContain('original note');
});
test('unscoped anonymous revoked and actual pre-suspension bearers cannot restore or replay', async () => {
  const m = await make('public');
  const removed = await m.remove();
  const unscoped = await f.identity(['subject:read', 'collection:read']);
  expect((await f.send(unscoped.bearer, 'POST', m.path + ':restore', removed)).status).toBe(403);
  expect((await f.send('anonymous', 'POST', m.path + ':restore', removed)).status).toBe(401);
  const suspended = await f.identity(scopes);
  await f.suspend(suspended.actor.accountId);
  const denied = await f.send(suspended.bearer, 'POST', m.path + ':restore', removed);
  expect(denied.status).toBe(401);
  expect((await denied.json()).code).toBe('invalid_credentials');
  expect(denied.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"');
  const revoked = await f.identity(scopes);
  await f.revokeIdentity(revoked.actor.accountId);
  expect((await f.send(revoked.bearer, 'POST', m.path + ':restore', removed)).status).toBe(401);
});
test('original placement collision rolls back; deleted parents never revive through a member and the 720-hour cutoff is strict', async () => {
  const m = await make();
  const removed = await m.remove();
  const collision = await m.add('new occupant', null);
  const before = await m.snapshot();
  await code(await f.send(owner.bearer, 'POST', m.path + ':restore', removed), 'member_restore_occupied');
  expect(await m.snapshot()).toEqual(before);
  const p = await m.parent();
  expect(
    (await f.send(owner.bearer, 'DELETE', `${m.root}/members/${collision.id}?revision=${p.revision}`)).status,
  ).toBe(204);
  const deadline = (
    await f.pool.query(
      'SELECT purge_after::text AS deadline FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND member_id=$3',
      [routeOf(m.collection.id), m.collection.id, m.first.id],
    )
  ).rows[0].deadline;
  const originalTime = time;
  time = Date.parse(deadline);
  await code(await f.send(owner.bearer, 'POST', m.path + ':restore', removed), 'member_restore_expired');
  time = originalTime;
  const parent = await m.parent();
  expect((await f.send(owner.bearer, 'DELETE', `${m.root}?revision=${parent.revision}`)).status).toBe(204);
  expect((await f.send(owner.bearer, 'POST', m.path + ':restore', removed)).status).toBe(404);
});

test('fresh Undo rechecks current native subject concealment without exposing the retained note', async () => {
  const m = await make();
  const removed = await m.remove();
  const hidden = await f.send('steward', 'POST', `/v1/subjects/${m.subjectId}:hide`, {
    reason: 'Current occurrence subject disclosure',
  });
  expect(hidden.status).toBe(200);
  const before = await m.snapshot();
  const response = await f.send(owner.bearer, 'POST', m.path + ':restore', removed);
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain('original note');
  expect(await m.snapshot()).toEqual(before);
});
