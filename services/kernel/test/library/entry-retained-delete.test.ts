import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { LibraryNotFoundError } from '../../src/library/command-support.ts';
import { routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture;
let time: number | undefined;
const clock = () => new Date(time ?? Date.now());
const reader = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  options: '-c default_transaction_read_only=on',
});
beforeAll(async () => {
  f = await createProfileEntryFixture({ clock, singleConnection: true });
}, 120000);
afterAll(async () => {
  await f?.close();
  await reader.end();
});
test('native retained entry delete archives all persisted fields under its actual transaction id preserves guarded replacements and replays only after current owner admission', async () => {
  expect(f.pool.options.max).toBe(1);
  const subject = await f.createSubject('record'),
    owner = f.owner.actor;
  await f.commands.putEntry(owner, subject, { state: 'listening' }, entryKey());
  const stored = (
    await reader.query(
      "SELECT to_jsonb(e)||jsonb_build_object('type_source_position',e.type_source_position::text,'owner_write_seq',e.owner_write_seq::text) AS row FROM library.entry e WHERE route=$1 AND account_id=$2 AND subject_id=$3",
      [routeOf(owner.accountId), owner.accountId, subject],
    )
  ).rows[0]!.row;
  expect(stored.incarnation_id).toEqual(expect.any(String));
  await f.activate(f.replacementDigest);
  time = Date.now() + 60000;
  const headBefore = (
    await reader.query('SELECT generation::text FROM library.fact_source_head WHERE route=$1 AND account_id=$2', [
      routeOf(owner.accountId),
      owner.accountId,
    ])
  ).rows[0]!.generation;
  const key = entryKey();
  const removed = await f.commands.deleteEntry(owner, subject, stored.revision, key, stored.incarnation_id);
  expect(removed.value).toEqual({ deletionId: removed.transactionId, revision: stored.revision + 1 });
  const archived = (
    await reader.query(
      "SELECT to_jsonb(e)||jsonb_build_object('type_source_position',e.type_source_position::text,'owner_write_seq',e.owner_write_seq::text) AS row FROM library.entry_deleted e WHERE route=$1 AND account_id=$2 AND deletion_id=$3",
      [routeOf(owner.accountId), owner.accountId, removed.transactionId],
    )
  ).rows[0]!.row;
  const columns = [
    'route',
    'account_id',
    'subject_id',
    'requested_subject_id',
    'state',
    'revision',
    'created_at',
    'updated_at',
    'transaction_id',
    'activity_at',
    'finished_at',
    'type_id',
    'type_source_id',
    'type_source_partition',
    'type_source_epoch',
    'type_source_position',
    'incarnation_id',
    'library_profile_pin',
    'owner_write_seq',
  ];
  for (const column of columns) expect(archived[column]).toEqual(stored[column]);
  expect(Date.parse(archived.deleted_at)).toBe(time);
  expect(Date.parse(archived.restore_until) - Date.parse(archived.deleted_at)).toBe(720 * 60 * 60 * 1000);
  const headAfter = (
    await reader.query('SELECT generation::text FROM library.fact_source_head WHERE route=$1 AND account_id=$2', [
      routeOf(owner.accountId),
      owner.accountId,
    ])
  ).rows[0]!.generation;
  expect(BigInt(headAfter)).toBe(BigInt(headBefore) + 1n);
  expect(stored.owner_write_seq).not.toBeNull();
  expect(archived.owner_write_seq).toBe(stored.owner_write_seq);
  await expect(f.commands.readEntry(owner, subject)).rejects.toBeInstanceOf(LibraryNotFoundError);
  await f.activate(f.originalDigest);
  const replacement = await f.commands.putEntry(owner, subject, { state: 'listening' }, entryKey());
  expect(replacement.value.entry.revision).toBe(stored.revision);
  expect(replacement.value.entry.incarnationId).toEqual(expect.any(String));
  expect(replacement.value.entry.incarnationId).not.toBe(stored.incarnation_id);
  const before = await f.inspect();
  await expect(
    f.commands.deleteEntry(owner, subject, stored.revision, entryKey(), stored.incarnation_id),
  ).rejects.toMatchObject({ reason: 'stale' });
  expect(await f.inspect()).toEqual(before);
  expect(await f.commands.deleteEntry(owner, subject, stored.revision, key, stored.incarnation_id)).toEqual({
    ...removed,
    replayed: true,
  });
  expect(await f.inspect()).toEqual(before);
  await expect(
    f.commands.deleteEntry(
      { ...owner },
      subject,
      replacement.value.entry.revision,
      entryKey(),
      replacement.value.entry.incarnationId!,
    ),
  ).rejects.toBeInstanceOf(GrantDeniedError);
  expect(await f.inspect()).toEqual(before);
}, 120000);
