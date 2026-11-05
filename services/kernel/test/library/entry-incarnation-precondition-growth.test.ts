import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { principalCommandIdentity } from '../../src/command/command.ts';
import { createLibraryCommandRunner } from '../../src/library/command-support.ts';
import { admitEntryAttempt } from '../../src/library/entry-lifecycle.ts';
import * as store from '../../src/library/entry-store.ts';
import { LibraryConflictError } from '../../src/library/entries.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { routeOf } from '../../src/route/route.ts';
import { accountToken, authenticateAccount } from '../support/admitted-access.ts';
import { capture, catalogStatementBound, checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let f: NativeProfileFixture;
let time: number | undefined;
beforeAll(async () => {
  f = await createProfileEntryFixture({ clock: () => new Date(time ?? Date.now()) });
}, 120000);
afterAll(async () => {
  await f?.close();
});
const path = (subjectId: string) => `/v1/libraryEntries/${subjectId}`;
const scopes = ['subject:read', 'library_entry:read', 'library_entry:update', 'library_entry:delete'];

async function legacyNull(f: NativeProfileFixture, subjectId: string) {
  // Only historical storage setup: no forged identity, scope, receipt or readiness flag.
  await f.pool.query(
    'UPDATE library.entry SET incarnation_id=NULL WHERE route=$1 AND account_id=$2 AND subject_id=$3',
    [routeOf(f.owner.actor.accountId), f.owner.actor.accountId, subjectId],
  );
}

/** Execute the pre-retention physical-delete producer in its actual native authorized receipt envelope. */
async function historicalDelete(f: NativeProfileFixture, subjectId: string, revision: number, key: string) {
  const runner = createLibraryCommandRunner({ pool: f.pool });
  return runner.ownAccountPrepared(
    f.owner.actor,
    {
      action: 'library_entry:delete',
      kind: 'library.entry.delete',
      requestKey: key,
      input: { subjectId, revision },
      prepare: (attempt) => admitEntryAttempt(f, f.owner.actor, 'library_entry:delete', attempt, deadlineFor(5000)),
    },
    async (tx) => {
      const removed = await store.deleteEntry(
        tx,
        routeOf(f.owner.actor.accountId)!,
        f.owner.actor.accountId,
        subjectId,
        revision,
      );
      if (!removed) throw new LibraryConflictError();
      return {
        value: removed,
        events: [
          { type: 'com.rezics.library.entry.deleted.v1', subject: f.owner.actor.accountId, data: { subjectId } },
        ],
      };
    },
  );
}

async function oldReceipts(f: NativeProfileFixture) {
  const subjectId = await f.createSubject('game');
  const first = (await f.commands.putEntry(f.owner.actor, subjectId, { state: 'playing' }, entryKey())).value.entry;
  await legacyNull(f, subjectId);
  const key = entryKey(),
    input = { state: 'playing', revision: first.revision };
  const updated = await f.commands.putEntry(f.owner.actor, subjectId, input, key);
  expect(updated.value.entry.incarnationId).toBeNull();
  const deleteKey = entryKey();
  const deleted = await historicalDelete(f, subjectId, updated.value.entry.revision, deleteKey);
  const replacement = (await f.commands.putEntry(f.owner.actor, subjectId, { state: 'planned' }, entryKey())).value
    .entry;
  const receipts = (await f.inspect(f.owner.actor.accountId)).receipts;
  for (const [kind, requestKey, body] of [
    ['library.entry.put', key, { subjectId, requestedSubjectId: null, ...input }],
    ['library.entry.delete', deleteKey, { subjectId, revision: updated.value.entry.revision }],
  ] as const) {
    const receipt = receipts.find((x) => x.row.command_kind === kind && x.row.idempotency_key === requestKey)!.row;
    const digest = createHash('sha256')
      .update(canonicalize([principalCommandIdentity(f.owner.actor), kind, body])!)
      .digest('hex');
    expect(receipt.request_digest).toBe('\\x' + digest);
  }
  return { subjectId, key, input, updated, deleteKey, deleted, replacement };
}

test('exact historical revisioned HTTP bodies retain native digest and response after refill without inventing deletion metadata', async () => {
  const old = await oldReceipts(f);
  const before = await f.inspect();
  const replay = await f.send('owner', 'PUT', path(old.subjectId), old.input, old.key);
  expect(replay.status).toBe(200);
  expect((await replay.json()).libraryEntry).toEqual({
    subjectId: old.subjectId,
    incarnationId: null,
    state: old.updated.value.entry.state,
    revision: old.updated.value.entry.revision,
    createdAt: old.updated.value.entry.createdAt,
    updatedAt: old.updated.value.entry.updatedAt,
  });
  const deleted = await f.send(
    'owner',
    'DELETE',
    path(old.subjectId) + `?revision=${old.updated.value.entry.revision}`,
    undefined,
    old.deleteKey,
  );
  expect(deleted.status).toBe(204);
  expect(await deleted.text()).toBe('');
  expect(deleted.headers.get('Library-Entry-Deletion-Id')).toBeNull();
  expect(deleted.headers.get('Library-Entry-Deletion-Revision')).toBeNull();
  expect(await f.inspect()).toEqual(before);
  expect((await f.send('owner', 'PUT', path(old.subjectId), old.input)).status).toBe(409);
  expect((await f.send('owner', 'DELETE', path(old.subjectId) + `?revision=${old.replacement.revision}`)).status).toBe(
    409,
  );
  expect(
    (
      await f.send(
        'owner',
        'PUT',
        path(old.subjectId),
        { ...old.input, incarnationId: old.replacement.incarnationId },
        old.key,
      )
    ).status,
  ).toBe(422);
  expect(await f.inspect()).toEqual(before);
}, 120000);

test('fresh HTTP PUT and DELETE reject missing wrong and replacement guards and retain every effect counter', async () => {
  const subjectId = await f.createSubject('game');
  let entry = (await f.commands.putEntry(f.owner.actor, subjectId, { state: 'playing' }, entryKey())).value.entry;
  const original = entry;
  await f.commands.deleteEntry(f.owner.actor, subjectId, entry.revision, entryKey(), entry.incarnationId!);
  entry = (await f.commands.putEntry(f.owner.actor, subjectId, { state: 'playing' }, entryKey())).value.entry;
  expect(entry.revision).toBe(original.revision);
  expect(entry.incarnationId).not.toBe(original.incarnationId);
  const before = await f.inspect();
  for (const guard of [undefined, entryKey(), original.incarnationId!]) {
    expect(
      (
        await f.send('owner', 'PUT', path(subjectId), {
          state: 'completed',
          revision: entry.revision,
          ...(guard === undefined ? {} : { incarnationId: guard }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await f.send(
          'owner',
          'DELETE',
          path(subjectId) + `?revision=${entry.revision}` + (guard === undefined ? '' : `&incarnationId=${guard}`),
        )
      ).status,
    ).toBe(409);
    expect(await f.inspect()).toEqual(before);
  }
  const changed = await f.send('owner', 'PUT', path(subjectId), {
    state: 'completed',
    revision: entry.revision,
    incarnationId: entry.incarnationId,
  });
  expect(changed.status).toBe(200);
  const current = (await changed.json()).libraryEntry;
  expect(current.incarnationId).toBe(entry.incarnationId);
  const removed = await f.send(
    'owner',
    'DELETE',
    path(subjectId) + `?revision=${current.revision}&incarnationId=${current.incarnationId}`,
  );
  expect(removed.status).toBe(204);
  expect(await removed.text()).toBe('');
  expect(removed.headers.get('Library-Entry-Deletion-Revision')).toBe(String(current.revision + 1));
}, 120000);

test('historical receipts still require actual same-owner current scope and native identity authority', async () => {
  const old = await oldReceipts(f);
  const reduced = { accountId: f.owner.actor.accountId, clientId: f.owner.actor.clientId, scopes: ['subject:read'] };
  const actor = await authenticateAccount(f.access, { pool: f.pool, deadline: deadlineFor(30000) }, reduced);
  const bearer = await accountToken(reduced);
  const before = await f.inspect();
  await expect(f.commands.putEntry(actor, old.subjectId, old.input, old.key)).rejects.toBeInstanceOf(GrantDeniedError);
  for (const persona of [bearer, 'anonymous']) {
    const response = await f.send(persona, 'PUT', path(old.subjectId), old.input, old.key);
    expect([401, 403, 404]).toContain(response.status);
    expect(await response.text()).not.toContain('libraryEntry');
  }
  const foreign = await f.send(
    'other',
    'DELETE',
    path(old.subjectId) + `?revision=${old.updated.value.entry.revision}`,
    undefined,
    old.deleteKey,
  );
  expect(foreign.status).toBe(404);
  expect(foreign.headers.get('Library-Entry-Deletion-Id')).toBeNull();
  expect(await f.inspect()).toEqual(before);
  for (const denial of ['revoked', 'suspended'] as const) {
    const who = await f.identity(scopes);
    const history = await oldReceipts({ ...f, owner: who });
    if (denial === 'revoked') await f.revokeIdentity(who.actor.accountId);
    else await f.suspend(who.actor.accountId);
    const snapshot = await f.inspect(who.actor.accountId);
    await expect(f.commands.putEntry(who.actor, history.subjectId, history.input, history.key)).rejects.toBeInstanceOf(
      GrantDeniedError,
    );
    expect([401, 403, 404]).toContain(
      (await f.send(who.bearer, 'PUT', path(history.subjectId), history.input, history.key)).status,
    );
    expect(await f.inspect(who.actor.accountId)).toEqual(snapshot);
  }
}, 120000);

test('retired profile guarded clear and exact Undo preserve original identity values and sequence while fresh state still needs a compiled profile', async () => {
  const subjectId = await f.createSubject('record');
  const entry = (await f.commands.putEntry(f.owner.actor, subjectId, { state: 'listening' }, entryKey())).value.entry;
  const original = (await f.inspect()).entries.find((x) => x.row.subject_id === subjectId)!.row;
  await f.activate(f.replacementDigest);
  try {
    const before = await f.inspect();
    expect(
      (
        await f.send('owner', 'PUT', path(subjectId), {
          state: 'planned',
          revision: entry.revision,
          incarnationId: entry.incarnationId,
        })
      ).status,
    ).toBe(422);
    expect(await f.inspect()).toEqual(before);
    const deleted = await f.send(
      'owner',
      'DELETE',
      path(subjectId) + `?revision=${entry.revision}&incarnationId=${entry.incarnationId}`,
    );
    expect(deleted.status).toBe(204);
    const input = {
      deletionId: deleted.headers.get('Library-Entry-Deletion-Id'),
      revision: Number(deleted.headers.get('Library-Entry-Deletion-Revision')),
    };
    const archive = (await f.inspect()).deletedEntries.find((x) => x.row.deletion_id === input.deletionId)!.row;
    expect(archive.owner_write_seq).toBe(original.owner_write_seq);
    expect(Date.parse(archive.restore_until) - Date.parse(archive.deleted_at)).toBe(720 * 60 * 60 * 1000);
    const key = entryKey();
    const restored = await f.send('owner', 'POST', path(subjectId) + ':restore', input, key);
    expect(restored.status).toBe(200);
    const body = await restored.json();
    expect(body.libraryEntry).toMatchObject({
      incarnationId: entry.incarnationId,
      revision: entry.revision + 2,
      state: entry.state,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    });
    const stored = (await f.inspect()).entries.find((x) => x.row.subject_id === subjectId)!.row;
    for (const field of [
      'library_profile_pin',
      'activity_at',
      'finished_at',
      'type_id',
      'type_source_id',
      'type_source_partition',
      'type_source_epoch',
      'type_source_position',
    ])
      expect(stored[field]).toEqual(original[field]);
    expect(BigInt(stored.owner_write_seq)).toBeGreaterThan(BigInt(original.owner_write_seq));
    const beforeReplay = await f.inspect();
    expect(await (await f.send('owner', 'POST', path(subjectId) + ':restore', input, key)).json()).toEqual(body);
    expect(await f.inspect()).toEqual(beforeReplay);
    expect(
      (await f.send('owner', 'POST', path(subjectId) + ':restore', { ...input, incarnationId: entry.incarnationId }))
        .status,
    ).toBe(400);
  } finally {
    await f.activate(f.originalDigest);
  }
}, 120000);

test('legacy NULL compatibility ends on the actual stamped row and supplied mismatches never bypass NULL', async () => {
  const subjectId = await f.createSubject('game');
  const created = (await f.commands.putEntry(f.owner.actor, subjectId, { state: 'playing' }, entryKey())).value.entry;
  await legacyNull(f, subjectId);
  const before = await f.inspect();
  for (const method of ['PUT', 'DELETE']) {
    const response =
      method === 'PUT'
        ? await f.send('owner', method, path(subjectId), {
            state: 'playing',
            revision: created.revision,
            incarnationId: created.incarnationId,
          })
        : await f.send(
            'owner',
            method,
            path(subjectId) + `?revision=${created.revision}&incarnationId=${created.incarnationId}`,
          );
    expect(response.status).toBe(409);
    expect(await f.inspect()).toEqual(before);
  }
  const key = entryKey();
  const legacy = await f.commands.putEntry(
    f.owner.actor,
    subjectId,
    { state: 'playing', revision: created.revision },
    key,
  );
  expect(legacy.value.entry.incarnationId).toBeNull();
  const locked = (await f.inspect()).entries.find((x) => x.row.subject_id === subjectId)!.row;
  const stamped = await f.pool.query(
    'UPDATE library.entry SET incarnation_id=$4 WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND revision=$5 AND transaction_id=$6 AND incarnation_id IS NULL RETURNING incarnation_id',
    [
      routeOf(f.owner.actor.accountId),
      f.owner.actor.accountId,
      subjectId,
      created.incarnationId,
      locked.revision,
      locked.transaction_id,
    ],
  );
  expect(stamped.rowCount).toBe(1);
  const cutover = await f.inspect();
  await expect(
    f.commands.putEntry(
      f.owner.actor,
      subjectId,
      { state: 'completed', revision: legacy.value.entry.revision },
      entryKey(),
    ),
  ).rejects.toBeInstanceOf(LibraryConflictError);
  await expect(
    f.commands.deleteEntry(f.owner.actor, subjectId, legacy.value.entry.revision, entryKey()),
  ).rejects.toBeInstanceOf(LibraryConflictError);
  expect(
    await f.commands.putEntry(f.owner.actor, subjectId, { state: 'playing', revision: created.revision }, key),
  ).toEqual({ ...legacy, replayed: true });
  expect(await f.inspect()).toEqual(cutover);
  await f.commands.deleteEntry(
    f.owner.actor,
    subjectId,
    legacy.value.entry.revision,
    entryKey(),
    created.incarnationId!,
  );
}, 120000);

test('expiry rejects a fresh Undo while exact authorized historical receipts remain unchanged', async () => {
  const subjectId = await f.createSubject('game');
  const original = (await f.commands.putEntry(f.owner.actor, subjectId, { state: 'playing' }, entryKey())).value.entry;
  const key = entryKey();
  const deleted = await f.commands.deleteEntry(
    f.owner.actor,
    subjectId,
    original.revision,
    key,
    original.incarnationId!,
  );
  const archived = (await f.inspect()).deletedEntries.find((x) => x.row.deletion_id === deleted.transactionId)!.row;
  time = Date.parse(archived.restore_until);
  try {
    const before = await f.inspect();
    await expect(
      f.commands.restoreEntry(
        f.owner.actor,
        subjectId,
        { deletionId: deleted.transactionId, revision: original.revision + 1 },
        entryKey(),
      ),
    ).rejects.toMatchObject({ reason: 'expired' });
    expect(
      await f.commands.deleteEntry(f.owner.actor, subjectId, original.revision, key, original.incarnationId!),
    ).toEqual({ ...deleted, replayed: true });
    expect(await f.inspect()).toEqual(before);
  } finally {
    time = undefined;
  }
}, 120000);

test('concurrent exact legacy stamping and a guardless state mutation serialize on the real row', async () => {
  const subjectId = await f.createSubject('game');
  const original = (await f.commands.putEntry(f.owner.actor, subjectId, { state: 'playing' }, entryKey())).value.entry;
  await legacyNull(f, subjectId);
  const stored = (await f.inspect()).entries.find((x) => x.row.subject_id === subjectId)!.row;
  const [stamp, mutation] = await Promise.all([
    f.pool.query(
      'UPDATE library.entry SET incarnation_id=$4 WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND revision=$5 AND transaction_id=$6 AND incarnation_id IS NULL RETURNING incarnation_id',
      [
        routeOf(f.owner.actor.accountId),
        f.owner.actor.accountId,
        subjectId,
        original.incarnationId,
        stored.revision,
        stored.transaction_id,
      ],
    ),
    f.commands.putEntry(f.owner.actor, subjectId, { state: 'completed', revision: original.revision }, entryKey()).then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
  ]);
  const current = await f.commands.readEntry(f.owner.actor, subjectId);
  if (stamp.rowCount === 1) {
    expect(mutation).toMatchObject({ error: expect.any(LibraryConflictError) });
    expect(current).toEqual(original);
  } else {
    expect(mutation).toHaveProperty('value');
    expect(current.incarnationId).toBeNull();
    expect(current.revision).toBe(original.revision + 1);
  }
}, 120000);

test('fresh guard work remains bounded across 64 512 and 4096 unrelated live retained and receipt histories including physical native controls', async () => {
  const db = await openGrowthDatabase();
  let native: NativeProfileFixture | undefined;
  try {
    native = await createProfileEntryFixture({ pool: db.pool, singleConnection: true, projectLinks: false });
    const f = native;
    const target = await f.createSubject('game');
    let current = (await f.commands.putEntry(f.owner.actor, target, { state: 'planned' }, entryKey())).value.entry;
    const original = current;
    await f.commands.deleteEntry(f.owner.actor, target, current.revision, entryKey(), current.incarnationId!);
    current = (await f.commands.putEntry(f.owner.actor, target, { state: 'planned' }, entryKey())).value.entry;
    const old = await oldReceipts(f);
    const operation = async () => {
      for (const guard of [undefined, entryKey(), original.incarnationId!]) {
        await expect(
          f.commands.putEntry(
            f.owner.actor,
            target,
            { state: 'planned', revision: current.revision, ...(guard === undefined ? {} : { incarnationId: guard }) },
            entryKey(),
          ),
        ).rejects.toBeInstanceOf(LibraryConflictError);
        await expect(
          f.commands.deleteEntry(f.owner.actor, target, current.revision, entryKey(), guard),
        ).rejects.toBeInstanceOf(LibraryConflictError);
      }
      current = (
        await f.commands.putEntry(
          f.owner.actor,
          target,
          { state: 'planned', revision: current.revision, incarnationId: current.incarnationId! },
          entryKey(),
        )
      ).value.entry;
      const key = entryKey();
      const removed = await f.commands.deleteEntry(
        f.owner.actor,
        target,
        current.revision,
        key,
        current.incarnationId!,
      );
      const deleted = current;
      current = (await f.commands.putEntry(f.owner.actor, target, { state: 'planned' }, entryKey())).value.entry;
      expect(
        await f.commands.deleteEntry(f.owner.actor, target, deleted.revision, key, deleted.incarnationId!),
      ).toEqual({ ...removed, replayed: true });
      expect(await f.commands.putEntry(f.owner.actor, old.subjectId, old.input, old.key)).toEqual({
        ...old.updated,
        replayed: true,
      });
      expect(
        await f.commands.deleteEntry(f.owner.actor, old.subjectId, old.updated.value.entry.revision, old.deleteKey),
      ).toEqual({ ...old.deleted, replayed: true });
    };
    const report = await checkGrowth(db, {
      name: 'fresh native incarnation admission success rejection replay and ABA',
      scales: [64, 512, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      includeBackends: true,
      async grow(_db, scale, previous) {
        // One ordinary subject supports many unrelated private owner slots.
        const subjectId = await f.createSubject('game');
        for (let n = previous; n < scale; n++) {
          for (const who of [f.owner, f.steward, f.other]) {
            who.bearer = await accountToken(who.actor);
            who.actor = await f.access.authenticate(who.bearer, { pool: db.pool, deadline: deadlineFor(30000) });
          }
          // Native identities, Access and receipt/outbox producers all grow together.
          const who = await f.identity(scopes);
          const first = (await f.commands.putEntry(who.actor, subjectId, { state: 'planned' }, entryKey())).value.entry;
          await f.commands.deleteEntry(who.actor, subjectId, first.revision, entryKey(), first.incarnationId!);
          await f.commands.putEntry(who.actor, subjectId, { state: 'planned' }, entryKey());
          const ownSubject = await f.createSubject('game');
          const own = (await f.commands.putEntry(f.owner.actor, ownSubject, { state: 'planned' }, entryKey())).value
            .entry;
          await f.commands.deleteEntry(f.owner.actor, ownSubject, own.revision, entryKey(), own.incarnationId!);
          await f.commands.putEntry(f.owner.actor, ownSubject, { state: 'planned' }, entryKey());
        }
        for (const who of [f.owner, f.steward, f.other]) {
          who.bearer = await accountToken(who.actor);
          who.actor = await f.access.authenticate(who.bearer, { pool: db.pool, deadline: deadlineFor(30000) });
        }
      },
      operation,
    });
    for (const sample of report.samples) {
      expect(sample.cost.plans).toBeGreaterThan(0);
      for (const relation of [
        'library.entry',
        'library.entry_deleted',
        'library.owner_write_counter',
        'library.fact_source_head',
      ])
        expect(sample.cost.relations[relation]?.sequentialScans ?? 0).toBe(0);
    }
    const rejected = await capture(
      db,
      async () => {
        await expect(
          f.commands.deleteEntry(f.owner.actor, target, current.revision, entryKey()),
        ).rejects.toBeInstanceOf(LibraryConflictError);
      },
      { includeBackends: true },
    );
    const classified = catalogStatementBound(rejected.capture);
    expect(classified.catalogStatements).toBeLessThanOrEqual(classified.allowedStatements);
    expect(
      rejected.capture.statements.some((sql) => /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?library\./i.test(sql)),
    ).toBe(false);
  } finally {
    await native?.close();
    await db.close();
  }
}, 3600000);
