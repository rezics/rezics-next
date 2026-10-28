import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { decodeJwt } from 'jose';
import pg from 'pg';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { PlatformClosedError } from '../../src/access/gates/admission.ts';
import { IdempotencyConflictError, type CommandOutcome } from '../../src/command/command.ts';
import { LibraryNotFoundError } from '../../src/library/command-support.ts';
import type { Actor } from '../../src/request/access.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { routeOf } from '../../src/route/route.ts';
import { authenticateAccount } from '../support/admitted-access.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let f: NativeProfileFixture;
let time: number | undefined;
const clock = () => new Date(time ?? Date.now());
const windowMs = 720 * 60 * 60 * 1000;
const reader = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 1,
  options: '-c default_transaction_read_only=on',
});
beforeAll(async () => {
  f = await createProfileEntryFixture({ clock });
}, 120_000);
beforeEach(async () => {
  time = undefined;
  await f.activate(f.originalDigest);
});
afterAll(async () => {
  await f?.close();
  await reader.end();
});

type Row = Record<string, unknown> & {
  subject_id: string;
  revision: number;
  incarnation_id: string | null;
  transaction_id: string;
  type_source_position: string | null;
};
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
];

// JSON timestamps retain PostgreSQL precision; the bigint is converted BEFORE JSON decoding.
// These connections cannot seed or repair any positive admission/fact/archive evidence.
async function rows(subjectId: string, deleted = false, accountId = f.owner.actor.accountId): Promise<Row[]> {
  return (
    await reader.query<{ row: Row }>(
      `SELECT to_jsonb(e) || jsonb_build_object('type_source_position', e.type_source_position::text) AS row
     FROM library.${deleted ? 'entry_deleted' : 'entry'} e
     WHERE route=$1 AND account_id=$2 AND subject_id=$3
     ORDER BY ${deleted ? 'deletion_id' : 'subject_id'}`,
      [routeOf(accountId), accountId, subjectId],
    )
  ).rows.map(({ row }) => row);
}
async function live(subjectId: string, accountId = f.owner.actor.accountId) {
  const found = await rows(subjectId, false, accountId);
  expect(found).toHaveLength(1);
  return found[0]!;
}
async function observed(subjectId: string, accountId = f.owner.actor.accountId) {
  return { native: await f.inspect(accountId), archived: await rows(subjectId, true, accountId) };
}
async function create(state = 'planned', vertical: 'game' | 'record' = 'game', actor = f.owner.actor) {
  const subjectId = await f.createSubject(vertical);
  const result = await f.commands.putEntry(actor, subjectId, { state }, entryKey());
  expect(result.replayed).toBe(false);
  expect(result.value.entry.subjectId).toBe(subjectId);
  expect(String((await f.commands.readEntry(actor, subjectId)).state)).toBe(state);
  return { subjectId, row: await live(subjectId, actor.accountId) };
}
function object(value: unknown): Record<string, unknown> {
  expect(value).not.toBeNull();
  expect(typeof value).toBe('object');
  return value as Record<string, unknown>;
}
function privateFree(value: unknown) {
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    expect([
      'library_profile_pin',
      'libraryProfilePin',
      'pin',
      'releaseDigest',
      'profileId',
      'acceptingType',
      'type_source_position',
      'typeSourcePosition',
    ]).not.toContain(key);
    privateFree(child);
  }
}
async function remove(actor: Actor, row: Row, key = entryKey()) {
  // Phase-one adds this optional fifth argument. Invoke the actual factory method, never a fixture writer.
  return Reflect.apply(f.commands.deleteEntry, f.commands, [
    actor,
    row.subject_id,
    row.revision,
    key,
    ...(row.incarnation_id === null ? [] : [row.incarnation_id]),
  ]) as ReturnType<typeof f.commands.deleteEntry>;
}
function descriptor(outcome: CommandOutcome<unknown>, source: Row) {
  const value = object(outcome.value);
  expect(value).toMatchObject({ deletionId: outcome.transactionId, revision: source.revision + 1 });
  expect(value).not.toHaveProperty('state');
  expect(value).not.toHaveProperty('entry');
  privateFree(value);
  // Read metadata from the actual command result, not a reconstructed fixture handle.
  return { deletionId: value.deletionId as string, revision: value.revision as number };
}
async function restore(
  actor: Actor,
  subjectId: string,
  input: { deletionId: string; revision: number },
  key = entryKey(),
) {
  const method: unknown = Reflect.get(f.commands, 'restoreEntry');
  expect(method, 'createEntryCommands must export the native restoreEntry command').toBeFunction();
  return Reflect.apply(method as (...args: unknown[]) => unknown, f.commands, [
    actor,
    subjectId,
    input,
    key,
  ]) as Promise<CommandOutcome<unknown>>;
}
async function conflict(run: () => Promise<unknown>, reason: 'occupied' | 'stale' | 'expired') {
  // Native errors must carry the stable reason used by the later 409 transport mapping.
  await expect(run()).rejects.toMatchObject({ reason });
}
async function snapshot(source: Row, outcome: CommandOutcome<unknown>) {
  const d = descriptor(outcome, source);
  const found = (await rows(source.subject_id, true)).filter((row) => row.deletion_id === d.deletionId);
  expect(found).toHaveLength(1);
  const archive = found[0]!;
  expect(columns).toHaveLength(18);
  for (const column of columns) {
    expect(Object.hasOwn(source, column), column).toBe(true);
    expect(Object.hasOwn(archive, column), column).toBe(true);
    expect(archive[column], column).toEqual(source[column]);
  }
  expect(archive.incarnation_id).toEqual(expect.any(String));
  expect(archive).toMatchObject({ deleted_revision: d.revision, deletion_id: outcome.transactionId });
  expect(Number.isFinite(Date.parse(String(archive.deleted_at)))).toBe(true);
  expect(Date.parse(String(archive.deleted_at))).toBeLessThanOrEqual(clock().getTime());
  if (time !== undefined) expect(Date.parse(String(archive.deleted_at))).toBe(time);
  expect(Date.parse(String(archive.restore_until)) - Date.parse(String(archive.deleted_at))).toBe(windowMs);
  return { d, archive };
}
async function restored(source: Row, outcome: CommandOutcome<unknown>) {
  const row = await live(source.subject_id);
  for (const column of columns.filter((key) => key !== 'revision' && key !== 'transaction_id'))
    expect(row[column], column).toEqual(source[column]);
  expect(row.revision).toBe(source.revision + 2);
  expect(row.transaction_id).toBe(outcome.transactionId);
  expect(row.transaction_id).not.toBe(source.transaction_id);
  const entry = object(object(outcome.value).entry);
  expect(entry).toMatchObject({ subjectId: source.subject_id, revision: row.revision, state: source.state });
  privateFree(entry);
  // HTTP's entryView intentionally omits private pin/transaction fields; compare those only in storage.
}

test('native lifecycle baseline creates and reads a legal planned entry before lifecycle assertions', async () => {
  const { subjectId, row } = await create();
  expect(row.state).toBe('planned');
  expect((await f.commands.readEntry(f.owner.actor, subjectId)).revision).toBe(row.revision);
});

test('native entry factory exposes restoreEntry after a successful native create and read', async () => {
  await create();
  expect(
    Reflect.get(f.commands, 'restoreEntry'),
    'Missing native lifecycle command, not a fixture substitute',
  ).toBeFunction();
});

test('native entry delete retains an independent exact snapshot and owner restore respects the empty-slot CAS strict720hour deadline and current authorization before replay', async () => {
  const { subjectId, row: a } = await create();
  const deleteKey = entryKey();
  time = Date.now() + 60_000;
  const deleted1 = await remove(f.owner.actor, a, deleteKey);
  const { d: d1, archive: archive1 } = await snapshot(a, deleted1);
  expect(await rows(subjectId)).toEqual([]);
  await expect(f.commands.readEntry(f.owner.actor, subjectId)).rejects.toBeInstanceOf(LibraryNotFoundError);
  expect((await f.commands.listEntries(f.owner.actor)).entries.some((e) => e.subjectId === subjectId)).toBe(false);

  await f.commands.putEntry(f.owner.actor, subjectId, { state: 'planned' }, entryKey());
  const b = await live(subjectId);
  expect(b.revision).toBe(a.revision);
  expect(b.incarnation_id).not.toBe(a.incarnation_id);
  const occupied = await observed(subjectId);
  await conflict(() => restore(f.owner.actor, subjectId, d1), 'occupied');
  expect(await observed(subjectId)).toEqual(occupied);
  await conflict(() => remove(f.owner.actor, a), 'stale');
  expect(await observed(subjectId)).toEqual(occupied);
  expect(await remove(f.owner.actor, a, deleteKey)).toEqual({ ...deleted1, replayed: true });
  expect(await observed(subjectId)).toEqual(occupied);
  await expect(remove(f.owner.actor, { ...a, revision: a.revision + 1 }, deleteKey)).rejects.toBeInstanceOf(
    IdempotencyConflictError,
  );
  expect(await observed(subjectId)).toEqual(occupied);

  time += 60_000;
  const deleted2 = await remove(f.owner.actor, b);
  const { d: d2, archive: archive2 } = await snapshot(b, deleted2);
  expect(d2.deletionId).not.toBe(d1.deletionId);
  expect(await rows(subjectId, true)).toEqual(expect.arrayContaining([archive1, archive2]));
  const restoreKey = entryKey();
  const undo1 = await restore(f.owner.actor, subjectId, d1, restoreKey);
  expect(undo1.transactionId).not.toBe(deleted1.transactionId);
  await restored(a, undo1);
  expect((await rows(subjectId, true)).map((r) => r.deletion_id)).toEqual([d2.deletionId]);
  const once = await observed(subjectId);
  await expect(restore(f.owner.actor, subjectId, d1)).rejects.toBeInstanceOf(LibraryNotFoundError);
  await expect(
    restore(f.owner.actor, subjectId, { ...d1, revision: d1.revision + 1 }, restoreKey),
  ).rejects.toBeInstanceOf(IdempotencyConflictError);
  expect(await observed(subjectId)).toEqual(once);

  // Delete the restored SAME incarnation: a third episode, never reuse/recreate D1.
  const aAgain = await live(subjectId);
  time += 60_000;
  const deleted3 = await remove(f.owner.actor, aAgain);
  const { d: d3 } = await snapshot(aAgain, deleted3);
  expect(aAgain.incarnation_id).toBe(a.incarnation_id);
  expect(new Set([d1.deletionId, d2.deletionId, d3.deletionId]).size).toBe(3);
  const absent = await observed(subjectId);
  expect(absent.archived.find((row) => row.deletion_id === d2.deletionId)).toEqual(archive2);
  expect(await restore(f.owner.actor, subjectId, d1, restoreKey)).toEqual({ ...undo1, replayed: true });
  expect(await remove(f.owner.actor, a, deleteKey)).toEqual({ ...deleted1, replayed: true });
  expect(await observed(subjectId)).toEqual(absent);
  expect(await rows(subjectId)).toEqual([]);
  expect((await rows(subjectId, true)).map((r) => r.deletion_id).sort()).toEqual([d2.deletionId, d3.deletionId].sort());
  // Parked purge and automatic due delivery remain separate production-worker acceptance.
});

test('native retained point selection conceals foreign missing and wrong-subject handles and preserves stale archives', async () => {
  const { subjectId, row } = await create();
  const deleted = await remove(f.owner.actor, row);
  const { d } = await snapshot(row, deleted);
  const before = await observed(subjectId);
  const foreignBefore = await observed(subjectId, f.other.actor.accountId);
  await expect(restore(f.other.actor, subjectId, d)).rejects.toBeInstanceOf(LibraryNotFoundError);
  await expect(restore(f.owner.actor, subjectId, { ...d, deletionId: entryKey() })).rejects.toBeInstanceOf(
    LibraryNotFoundError,
  );
  await expect(restore(f.owner.actor, f.unknownSubject(), d)).rejects.toBeInstanceOf(LibraryNotFoundError);
  await conflict(() => restore(f.owner.actor, subjectId, { ...d, revision: d.revision + 1 }), 'stale');
  expect(await observed(subjectId)).toEqual(before);
  expect(await observed(subjectId, f.other.actor.accountId)).toEqual(foreignBefore);
});

test('native delete and restore receipts require current owner scope active account authentication fence and gate without private denied outcomes', async () => {
  for (const denial of ['anonymous', 'other', 'scope', 'suspended', 'fence', 'gate'] as const) {
    const who = await f.identity([
      'subject:read',
      'library_entry:read',
      'library_entry:update',
      'library_entry:delete',
    ]);
    const { subjectId, row } = await create('planned', 'game', who.actor);
    const deleteKey = entryKey(),
      restoreKey = entryKey();
    const deleted = await remove(who.actor, row, deleteKey);
    const d = descriptor(deleted, row);
    const undone = await restore(who.actor, subjectId, d, restoreKey);
    expect(undone.replayed).toBe(false);
    let actor: Actor = who.actor;
    if (denial === 'anonymous') actor = { kind: 'anonymous' };
    if (denial === 'other') actor = f.other.actor;
    if (denial === 'scope')
      actor = await authenticateAccount(
        f.access,
        { pool: f.pool, deadline: deadlineFor(30_000) },
        {
          accountId: who.actor.accountId,
          clientId: who.actor.clientId,
          scopes: ['subject:read'],
        },
      );
    if (denial === 'suspended') await f.suspend(who.actor.accountId);
    if (denial === 'fence') await f.revokeIdentity(who.actor.accountId);
    if (denial === 'gate') {
      await f.grantLibraryGate(who.actor.accountId);
      await f.setLibraryOpen(false);
      expect(await remove(who.actor, row, deleteKey)).toEqual({ ...deleted, replayed: true });
      await f.revokeLibraryGate(who.actor.accountId);
    }
    try {
      const before = await observed(subjectId, who.actor.accountId);
      const callerBefore = await observed(subjectId, actor.kind === 'account' ? actor.accountId : who.actor.accountId);
      for (const run of [() => remove(actor, row, deleteKey), () => restore(actor, subjectId, d, restoreKey)]) {
        const error = await run().then(
          () => {
            throw new Error('Denied receipt returned a private success');
          },
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(
          denial === 'other' ? LibraryNotFoundError : denial === 'gate' ? PlatformClosedError : GrantDeniedError,
        );
        expect(error).not.toHaveProperty('value');
        expect(error).not.toHaveProperty('entry');
        expect(error).not.toHaveProperty('deletionId');
        privateFree(error);
      }
      expect(await observed(subjectId, who.actor.accountId)).toEqual(before);
      if (actor.kind === 'account') expect(await observed(subjectId, actor.accountId)).toEqual(callerBefore);
    } finally {
      if (denial === 'gate') await f.setLibraryOpen(true);
    }
  }
});

test('native strict720hour undo and replay retain a wall-time-valid admitted actor while the domain clock governs the original restore window', async () => {
  const a = await create(),
    b = await create();
  time = Date.now();
  const deletedAt = time;
  const { actor, bearer } = f.owner;
  const claims = decodeJwt(bearer);
  expect(claims.iat!).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  const da = await remove(f.owner.actor, a.row),
    db = await remove(f.owner.actor, b.row);
  const { d: d1 } = await snapshot(a.row, da);
  const { d: d2, archive } = await snapshot(b.row, db);
  const restoreKey = entryKey();
  time = deletedAt + windowMs - 1;
  // Only domain time advances; native admission keeps the original wall-time-valid actor.
  const beforeBoundary = await restore(actor, a.subjectId, d1, restoreKey);
  await restored(a.row, beforeBoundary);
  time = deletedAt + windowMs;
  // No worker runs in this command fixture: prove expiry while the original archive still exists.
  const boundary = await observed(b.subjectId);
  expect(boundary.archived).toEqual([archive]);
  expect(Date.parse(String(boundary.archived[0]!.restore_until))).toBe(time);
  await conflict(() => restore(actor, b.subjectId, d2), 'expired');
  expect(await observed(b.subjectId)).toEqual(boundary);
  const oldReceipt = await observed(a.subjectId);
  expect(await restore(actor, a.subjectId, d1, restoreKey)).toEqual({ ...beforeBoundary, replayed: true });
  expect(await observed(a.subjectId)).toEqual(oldReceipt);
  expect(await rows(b.subjectId)).toEqual([]);
  expect(f.owner.actor).toBe(actor);
  expect(f.owner.bearer).toBe(bearer);
  expect(claims.exp!).toBeGreaterThan(Date.now() / 1000);
});

test('native pinned custom entry clear and exact undo preserve all eighteen source fields when the current profile disappears', async () => {
  // This additional profile baseline can fail independently of the planned-state lifecycle baseline.
  const { subjectId, row } = await create('listening', 'record');
  expect(row.library_profile_pin).toEqual({
    provenance: 'profile',
    releaseDigest: f.originalDigest,
    acceptingType: 'ex:Record',
    profileId: 'fixture.record',
  });
  expect(row.incarnation_id).toEqual(expect.any(String));
  if (row.type_source_position !== null) {
    expect(typeof row.type_source_position).toBe('string');
    expect(BigInt(row.type_source_position).toString()).toBe(row.type_source_position);
  }
  await f.activate(f.replacementDigest);
  expect(f.replacement.types['ex:Record']!.library).toBeUndefined();
  time = Date.now() + 60_000;
  const deleteKey = entryKey(),
    restoreKey = entryKey();
  const deletion = await remove(f.owner.actor, row, deleteKey);
  const { d } = await snapshot(row, deletion);
  time += 60_000;
  const undo = await restore(f.owner.actor, subjectId, d, restoreKey);
  await restored(row, undo);
  const occupied = await observed(subjectId);
  expect(await remove(f.owner.actor, row, deleteKey)).toEqual({ ...deletion, replayed: true });
  expect(await observed(subjectId)).toEqual(occupied);
  const originalAgain = await live(subjectId);
  const clearedAgain = await remove(f.owner.actor, originalAgain);
  await snapshot(originalAgain, clearedAgain);
  const absent = await observed(subjectId);
  expect(await restore(f.owner.actor, subjectId, d, restoreKey)).toEqual({ ...undo, replayed: true });
  expect(await remove(f.owner.actor, row, deleteKey)).toEqual({ ...deletion, replayed: true });
  expect(await observed(subjectId)).toEqual(absent);
  expect(absent.archived.map((r) => r.deletion_id)).toEqual([clearedAgain.transactionId]);
  const freshSubject = await f.createSubject('record');
  const before = await observed(subjectId);
  const unsupported = await f.send('owner', 'PUT', `/v1/libraryEntries/${freshSubject}`, { state: 'listening' });
  expect(unsupported.status).toBe(422);
  expect(await unsupported.json()).toMatchObject({ code: 'unsupported_library_profile', effect_status: 'not_applied' });
  expect(await observed(subjectId)).toEqual(before);
  expect(await rows(freshSubject)).toEqual([]);
});

test('native fresh undo applies current source visibility while old authorized receipts only acknowledge their original effect', async () => {
  const { subjectId, row } = await create();
  const deleteKey = entryKey(),
    restoreKey = entryKey();
  const deleted = await remove(f.owner.actor, row, deleteKey);
  const d = descriptor(deleted, row);
  const undone = await restore(f.owner.actor, subjectId, d, restoreKey);
  const current = await live(subjectId);
  const again = await remove(f.owner.actor, current);
  const d2 = descriptor(again, current);
  const hidden = await f.send('steward', 'POST', `/v1/subjects/${subjectId}:hide`, {
    reason: 'Lifecycle source visibility',
  });
  expect(hidden.status).toBe(200);
  const before = await observed(subjectId);
  await expect(restore(f.owner.actor, subjectId, d2)).rejects.toBeInstanceOf(LibraryNotFoundError);
  expect(await remove(f.owner.actor, row, deleteKey)).toEqual({ ...deleted, replayed: true });
  expect(await restore(f.owner.actor, subjectId, d, restoreKey)).toEqual({ ...undone, replayed: true });
  expect(await observed(subjectId)).toEqual(before);
});
