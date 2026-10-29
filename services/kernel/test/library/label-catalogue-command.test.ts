import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { createPersonalLabelCommands } from '../../src/library/label-commands.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { LibraryNotFoundError } from '../../src/library/command-support.ts';
import { LibraryConflictError } from '../../src/library/entries.ts';
import { routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture;
const reader = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  options: '-c default_transaction_read_only=on',
});
beforeAll(async () => {
  f = await createProfileEntryFixture();
}, 120000);
afterAll(async () => {
  await f?.close();
  await reader.end();
});
test('native private label catalogue preserves normalized uniqueness minimal receipts no-effect rename and strict ordinary undo under current owner authority', async () => {
  let time = new Date();
  const labels = createPersonalLabelCommands({ pool: f.pool, tokens: f.tokens, clock: () => time });
  const actor = f.owner.actor,
    key = entryKey();
  const created = await labels.createLabel(actor, { name: '  New   Label  ' }, key);
  const label = created.value.label;
  expect(Object.keys(created.value)).toEqual(['label']);
  expect(Object.keys(label).sort()).toEqual(['id', 'revision']);
  expect(label.revision).toBe(1);
  expect(routeOf(label.id)).toBe(routeOf(actor.accountId));
  expect(await labels.readLabel(actor, label.id)).toEqual({ id: label.id, name: 'New Label', revision: 1 });
  await expect(labels.createLabel(actor, { name: 'New Label' }, entryKey())).rejects.toBeInstanceOf(
    LibraryConflictError,
  );
  await expect(labels.readLabel(f.other.actor, label.id)).rejects.toBeInstanceOf(LibraryNotFoundError);
  await expect(labels.createLabel({ kind: 'anonymous' }, { name: 'private' }, entryKey())).rejects.toBeInstanceOf(
    GrantDeniedError,
  );
  const before = await f.inspect();
  const unchanged = await labels.renameLabel(actor, label.id, { name: 'New Label', revision: 1 }, entryKey());
  expect(unchanged.value).toEqual(created.value);
  const after = await f.inspect();
  expect(after.events).toEqual(before.events);
  expect(after.partition).toEqual(before.partition);
  expect(after.receipts.length - before.receipts.length).toBe(1);
  const renamed = await labels.renameLabel(actor, label.id, { name: 'Renamed', revision: 1 }, entryKey());
  expect(renamed.value.label).toEqual({ id: label.id, revision: 2 });
  const replay = await labels.createLabel(actor, { name: '  New   Label  ' }, key);
  expect(replay.replayed).toBe(true);
  expect(replay.value).toEqual(created.value);
  expect(await labels.readLabel(actor, label.id)).toEqual({ id: label.id, name: 'Renamed', revision: 2 });
  await expect(labels.renameLabel(actor, label.id, { name: 'stale', revision: 1 }, entryKey())).rejects.toBeInstanceOf(
    LibraryConflictError,
  );
  const deleted = await labels.deleteLabel(actor, label.id, 2, entryKey());
  expect(deleted.value).toEqual({ deleted: true, revision: 3 });
  await expect(labels.readLabel(actor, label.id)).rejects.toBeInstanceOf(LibraryNotFoundError);
  const tomb = (
    await reader.query(
      'SELECT deleted_at,purge_after,revision FROM library.personal_label WHERE route=$1 AND account_id=$2 AND label_id=$3',
      [routeOf(actor.accountId), actor.accountId, label.id],
    )
  ).rows[0]!;
  expect(Date.parse(tomb.purge_after) - Date.parse(tomb.deleted_at)).toBe(720 * 60 * 60 * 1000);
  const restored = await labels.restoreLabel(actor, label.id, 3, entryKey());
  expect(restored.value.label).toEqual({ id: label.id, revision: 4 });
  expect((await labels.readLabel(actor, label.id)).name).toBe('Renamed');
  await labels.createLabel(actor, { name: 'Second' }, entryKey());
  const page = await labels.listLabels(actor, { limit: 1 });
  expect(page.labels).toHaveLength(1);
  expect(page.next).toBeTruthy();
  await labels.renameLabel(actor, label.id, { name: 'Again', revision: 4 }, entryKey());
  await expect(labels.listLabels(actor, { limit: 1, cursor: page.next! })).rejects.toMatchObject({
    code: 'stale_cursor',
  });
  await labels.deleteLabel(actor, label.id, 5, entryKey());
  const deadline = (
    await reader.query(
      'SELECT purge_after FROM library.personal_label WHERE route=$1 AND account_id=$2 AND label_id=$3',
      [routeOf(actor.accountId), actor.accountId, label.id],
    )
  ).rows[0]!.purge_after;
  time = new Date(deadline);
  await expect(labels.restoreLabel(actor, label.id, 6, entryKey())).rejects.toMatchObject({
    code: 'library_label_restore_expired',
  });
  await f.revokeIdentity(actor.accountId);
  const receiptsBefore = await f.inspect();
  await expect(labels.createLabel(actor, { name: '  New   Label  ' }, key)).rejects.toBeInstanceOf(GrantDeniedError);
  const denied = await f.inspect();
  expect(denied.receipts).toEqual(receiptsBefore.receipts);
  expect(denied.events).toEqual(receiptsBefore.events);
}, 120000);
