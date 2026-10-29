import { expect, test } from 'bun:test';
import { runEntryUndoGrowth, ownerSequence } from './support/entry-undo-growth.ts';
import { createProfileEntryFixture, entryKey } from './support/profile-entry-fixture.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { routeOf } from '../../src/route/route.ts';

test('exact restore and all rejected/replayed native envelopes have bounded whole-command work at three unrelated population scales', async () => {
  await runEntryUndoGrowth('restore');
}, 3600000);

test('native concurrent Undo and live-slot arbitration allocate one fresh sequence and preserve independent archives and conflicts', async () => {
  const db = await openGrowthDatabase();
  let time: number | undefined;
  const f = await createProfileEntryFixture({ pool: db.pool, clock: () => new Date(time ?? Date.now()) });
  try {
    const subject = await f.createSubject('record');
    const first = (await f.commands.putEntry(f.owner.actor, subject, { state: 'listening' }, entryKey())).value.entry;
    const clear = () =>
      f.commands.deleteEntry(f.owner.actor, subject, first.revision, entryKey(), first.incarnationId!);
    const one = await clear();
    const d1 = { deletionId: one.transactionId, revision: first.revision + 1 };
    const replacement = (await f.commands.putEntry(f.owner.actor, subject, { state: 'planned' }, entryKey())).value
      .entry;
    const two = await f.commands.deleteEntry(
      f.owner.actor,
      subject,
      replacement.revision,
      entryKey(),
      replacement.incarnationId!,
    );
    const d2 = { deletionId: two.transactionId, revision: replacement.revision + 1 };
    const before = BigInt(await ownerSequence(db, f));
    const keys = [entryKey(), entryKey()];
    const results = await Promise.allSettled(
      keys.map((key) => f.commands.restoreEntry(f.owner.actor, subject, d1, key)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(BigInt(await ownerSequence(db, f))).toBe(before + 1n);
    const live = await f.commands.readEntry(f.owner.actor, subject);
    expect(live.incarnationId).toBe(first.incarnationId);
    const stored = await db.admin.query<{ seq: string }>(
      'SELECT owner_write_seq::text AS seq FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3',
      [routeOf(f.owner.actor.accountId), f.owner.actor.accountId, subject],
    );
    expect(BigInt(stored.rows[0]!.seq)).toBe(before + 1n);
    const archives = await db.admin.query<{ deletion_id: string }>(
      'SELECT deletion_id FROM library.entry_deleted WHERE route=$1 AND account_id=$2 AND subject_id=$3',
      [routeOf(f.owner.actor.accountId), f.owner.actor.accountId, subject],
    );
    expect(archives.rows).toEqual([{ deletion_id: d2.deletionId }]);
    const snapshot = await f.inspect();
    await expect(
      f.commands.restoreEntry(f.owner.actor, subject, { ...d2, revision: d2.revision + 1 }, entryKey()),
    ).rejects.toMatchObject({ reason: 'stale' });
    await expect(f.commands.restoreEntry({ ...f.owner.actor }, subject, d2, entryKey())).rejects.toMatchObject({
      name: 'GrantDeniedError',
    });
    time = Date.now() + 720 * 60 * 60 * 1000 + 60000;
    try {
      await expect(f.commands.restoreEntry(f.owner.actor, subject, d2, entryKey())).rejects.toMatchObject({
        reason: 'expired',
      });
    } finally {
      time = undefined;
    }
    await expect(f.commands.restoreEntry(f.owner.actor, subject, d2, entryKey())).rejects.toMatchObject({
      reason: 'occupied',
    });
    expect(await f.inspect()).toEqual(snapshot);
    expect(BigInt(await ownerSequence(db, f))).toBe(before + 1n);
    const winner = results.findIndex((r) => r.status === 'fulfilled');
    await f.commands.restoreEntry(f.owner.actor, subject, d1, keys[winner]!);
    expect(BigInt(await ownerSequence(db, f))).toBe(before + 1n);
    await f.commands.deleteEntry(f.owner.actor, subject, live.revision, entryKey(), live.incarnationId!);
    const emptyCounter = BigInt(await ownerSequence(db, f));
    // Two real writers arbitrate the same empty live PK; neither may overwrite the other.
    const race = await Promise.allSettled([
      f.commands.restoreEntry(f.owner.actor, subject, d2, entryKey()),
      f.commands.putEntry(f.owner.actor, subject, { state: 'planned' }, entryKey()),
    ]);
    expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(race.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(BigInt(await ownerSequence(db, f))).toBe(emptyCounter + 1n);
    const final = await f.commands.readEntry(f.owner.actor, subject);
    expect(final.incarnationId).toEqual(expect.any(String));
  } finally {
    await f.close();
    await db.close();
  }
}, 120000);
