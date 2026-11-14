import { afterAll, beforeAll, expect, test } from 'bun:test';
import pg from 'pg';
import { createPersonalLabelCommands } from '../../src/library/label-commands.ts';
import { GrantDeniedError } from '../../src/access/contract/errors.ts';
import { LibraryNotFoundError } from '../../src/library/command-support.ts';
import { LibraryConflictError } from '../../src/library/entries.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
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

test('native label point and catalogue reads require the current credential and active home while admitting an empty catalogue', async () => {
  const owner = await f.identity(['library_entry:read', 'library_entry:list', 'library_entry:update']);
  const actor = owner.actor;
  const labels = createPersonalLabelCommands({ pool: f.pool, tokens: f.tokens });
  expect(await labels.listLabels(actor)).toEqual({ labels: [], next: null });
  const label = (await labels.createLabel(actor, { name: 'Admission' }, entryKey())).value.label;
  const route = routeOf(actor.accountId)!;
  const partition = partitionOf(route);
  const account = (
    await f.pool.query<{ floor: string }>(
      'SELECT minimum_authn_epoch::text AS floor FROM access.account WHERE route=$1 AND account_id=$2',
      [route, actor.accountId],
    )
  ).rows[0]!;
  const home = (
    await f.pool.query<{ writeState: string; movedTo: string | null }>(
      'SELECT write_state AS "writeState",moved_to AS "movedTo" FROM core.partition WHERE partition_no=$1',
      [partition],
    )
  ).rows[0]!;
  try {
    await f.pool.query('UPDATE access.account SET minimum_authn_epoch=$3::bigint WHERE route=$1 AND account_id=$2', [
      route,
      actor.accountId,
      actor.authnEpoch + 1,
    ]);
    await expect(labels.readLabel(actor, label.id)).rejects.toBeInstanceOf(GrantDeniedError);
    await expect(labels.listLabels(actor)).rejects.toBeInstanceOf(GrantDeniedError);
    await f.pool.query('UPDATE access.account SET minimum_authn_epoch=$3::bigint WHERE route=$1 AND account_id=$2', [
      route,
      actor.accountId,
      account.floor,
    ]);
    await f.pool.query("UPDATE core.partition SET write_state='fenced' WHERE partition_no=$1", [partition]);
    await expect(labels.readLabel(actor, label.id)).rejects.toBeInstanceOf(GrantDeniedError);
    await expect(labels.listLabels(actor)).rejects.toBeInstanceOf(GrantDeniedError);
  } finally {
    await f.pool.query('UPDATE access.account SET minimum_authn_epoch=$3::bigint WHERE route=$1 AND account_id=$2', [
      route,
      actor.accountId,
      account.floor,
    ]);
    await f.pool.query('UPDATE core.partition SET write_state=$2,moved_to=$3 WHERE partition_no=$1', [
      partition,
      home.writeState,
      home.movedTo,
    ]);
  }
});
