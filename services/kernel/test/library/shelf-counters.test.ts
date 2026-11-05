import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createCollectionCommands } from '../../src/library/collections.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture;
beforeAll(async () => {
  f = await createProfileEntryFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
});
test('placement deltas roll back atomically after exact replay and generation retirement', async () => {
  const subject = await f.createSubject('game'),
    key = entryKey();
  const first = await f.commands.putEntry(f.owner.actor, subject, { state: 'planned' }, key);
  const route = routeOf(f.owner.actor.accountId)!,
    owner = f.owner.actor.accountId;
  const counts = async () =>
    (
      await f.pool.query(
        'SELECT generation_id,bucket,type_id,n::text FROM library.shelf_count WHERE route=$1 AND account_id=$2 ORDER BY generation_id,bucket,type_id',
        [route, owner],
      )
    ).rows;
  const before = await counts();
  expect((await f.commands.putEntry(f.owner.actor, subject, { state: 'planned' }, key)).replayed).toBe(true);
  expect(await counts()).toEqual(before);
  // The native generation seam retires the old complete generation. A late request cannot write old rows.
  await f.pool.query(
    'UPDATE library.shelf_writer_owner SET active_generation=$3,epoch=epoch+1 WHERE route=$1 AND account_id=$2',
    [route, owner, newId(route)],
  );
  expect((await f.commands.putEntry(f.owner.actor, subject, { state: 'planned' }, key)).replayed).toBe(true);
  expect(await counts()).toEqual(before);
  await expect(
    f.commands.putEntry(
      f.owner.actor,
      subject,
      { state: 'in_progress', revision: first.value.entry.revision, incarnationId: first.value.entry.incarnationId! },
      entryKey(),
    ),
  ).rejects.toThrow();
  expect(await counts()).toEqual(before);
  expect((await f.commands.readEntry(f.owner.actor, subject)).state).toBe('planned');
});

test('active Collection counters retain exact replay and known zero', async () => {
  const identity = await f.identity(['collection:create', 'collection:read', 'collection:delete']);
  const commands = createCollectionCommands(f);
  const input = { title: 'Native counter', visibility: 'private' as const };
  const key = entryKey(),
    owner = identity.actor.accountId,
    route = routeOf(owner)!;
  const first = await commands.createCollection(identity.actor, input, key);
  const count = async () =>
    (
      await f.pool.query(
        "SELECT n::text FROM library.shelf_count WHERE route=$1 AND account_id=$2 AND bucket='collections'",
        [route, owner],
      )
    ).rows;
  expect(await count()).toEqual([{ n: '1' }]);
  expect((await commands.createCollection(identity.actor, input, key)).replayed).toBe(true);
  expect(await count()).toEqual([{ n: '1' }]);
  const deleteKey = entryKey();
  await commands.deleteCollection(identity.actor, first.value.id, first.value.revision, deleteKey);
  expect(await count()).toEqual([{ n: '0' }]);
  expect(
    (await commands.deleteCollection(identity.actor, first.value.id, first.value.revision, deleteKey)).replayed,
  ).toBe(true);
  expect(await count()).toEqual([{ n: '0' }]);
});

test('restoring an active Collection adds one counter delta and exact replay adds none', async () => {
  const identity = await f.identity(['collection:create', 'collection:read', 'collection:delete', 'collection:update']);
  const commands = createCollectionCommands(f);
  const owner = identity.actor.accountId,
    route = routeOf(owner)!;
  const count = async () =>
    (
      await f.pool.query(
        "SELECT n::text FROM library.shelf_count WHERE route=$1 AND account_id=$2 AND bucket='collections'",
        [route, owner],
      )
    ).rows;
  const created = await commands.createCollection(
    identity.actor,
    { title: 'Restored native counter', visibility: 'private' },
    entryKey(),
  );
  const deleted = await commands.deleteCollection(identity.actor, created.value.id, created.value.revision, entryKey());
  expect(await count()).toEqual([{ n: '0' }]);
  const input = { deletionId: deleted.value.deletionId, revision: deleted.value.revision };
  const key = entryKey();
  const restored = await commands.restoreCollection(identity.actor, created.value.id, input, key);
  expect(restored.value.state).toBe('active');
  expect(await count()).toEqual([{ n: '1' }]);
  expect(await commands.restoreCollection(identity.actor, created.value.id, input, key)).toEqual({
    ...restored,
    replayed: true,
  });
  expect(await count()).toEqual([{ n: '1' }]);
  await expect(commands.restoreCollection(identity.actor, created.value.id, input, entryKey())).rejects.toThrow();
  expect(await count()).toEqual([{ n: '1' }]);
});
