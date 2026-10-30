import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { purgeExpiredEntryDeletion, EntryPurgeNotDueError } from '../../src/library/entry-due-command.ts';
import type { DueEntryDeletionKey } from '../../src/library/entry-due-store.ts';
import { routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture, time: number | undefined;
const clock = () => new Date(time ?? Date.now());
const reader = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  options: '-c default_transaction_read_only=on',
});
beforeAll(async () => {
  f = await createProfileEntryFixture({ clock, singleConnection: true });
}, 120000);
afterAll(async () => {
  await f?.close();
  await reader.end();
});
async function key(deletionId: string): Promise<DueEntryDeletionKey> {
  return (
    await reader.query(
      `SELECT route,account_id AS "accountId",deletion_id AS "deletionId",restore_until::text AS "restoreUntil" FROM library.entry_deleted WHERE route=$1 AND account_id=$2 AND deletion_id=$3`,
      [routeOf(f.owner.actor.accountId), f.owner.actor.accountId, deletionId],
    )
  ).rows[0]!;
}
async function archives(subjectId: string) {
  return (
    await reader.query(
      'SELECT to_jsonb(e) AS row FROM library.entry_deleted e WHERE route=$1 AND account_id=$2 AND subject_id=$3 ORDER BY deletion_id',
      [routeOf(f.owner.actor.accountId), f.owner.actor.accountId, subjectId],
    )
  ).rows;
}
test('native ordinary entry purge authorizes its exact original due episode before receipt cannot poison future delivery and a parked first deletion cannot erase a later episode or live replacement', async () => {
  const owner = f.owner.actor,
    subjectId = await f.createSubject('record');
  const a = (await f.commands.putEntry(owner, subjectId, { state: 'listening' }, entryKey())).value.entry;
  time = Date.now();
  const d1 = await f.commands.deleteEntry(owner, subjectId, a.revision, entryKey(), a.incarnationId!);
  const k1 = await key(d1.transactionId);
  time += 1000;
  const restored = (
    await f.commands.restoreEntry(
      owner,
      subjectId,
      { deletionId: d1.transactionId, revision: a.revision + 1 },
      entryKey(),
    )
  ).value.entry;
  expect(restored.incarnationId).toBe(a.incarnationId);
  time += 1000;
  const d3 = await f.commands.deleteEntry(owner, subjectId, restored.revision, entryKey(), restored.incarnationId!);
  const k3 = await key(d3.transactionId);
  const replacement = (await f.commands.putEntry(owner, subjectId, { state: 'listening' }, entryKey())).value.entry;
  expect(replacement.incarnationId).not.toBe(a.incarnationId);
  const before = await f.inspect(),
    retained = await archives(subjectId);
  time = Date.parse(k1.restoreUntil) - 1;
  await expect(purgeExpiredEntryDeletion({ pool: f.pool, clock }, k1)).rejects.toBeInstanceOf(EntryPurgeNotDueError);
  expect(await f.inspect()).toEqual(before);
  expect(await archives(subjectId)).toEqual(retained);
  time = Date.parse(k1.restoreUntil);
  const parked = await purgeExpiredEntryDeletion({ pool: f.pool, clock }, k1);
  expect(parked.value).toEqual({ purged: false });
  expect(parked.replayed).toBe(false);
  expect(await archives(subjectId)).toEqual(retained);
  expect((await f.commands.readEntry(owner, subjectId)).incarnationId).toBe(replacement.incarnationId);
  time = Date.parse(k3.restoreUntil);
  const purged = await purgeExpiredEntryDeletion({ pool: f.pool, clock }, k3);
  expect(purged.value).toEqual({ purged: true });
  expect(purged.replayed).toBe(false);
  expect(await archives(subjectId)).toEqual([]);
  const once = await f.inspect();
  expect(await purgeExpiredEntryDeletion({ pool: f.pool, clock }, k3)).toEqual({ ...purged, replayed: true });
  expect(await purgeExpiredEntryDeletion({ pool: f.pool, clock }, k1)).toEqual({ ...parked, replayed: true });
  expect(await f.inspect()).toEqual(once);
  expect((await f.commands.readEntry(owner, subjectId)).incarnationId).toBe(replacement.incarnationId);
}, 120000);
