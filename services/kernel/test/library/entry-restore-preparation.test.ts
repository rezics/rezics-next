import { afterAll, beforeAll, expect, test } from 'bun:test';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { PlatformClosedError } from '../../src/access/gates/admission.ts';
import { noEffect } from '../../src/command/command.ts';
import { createLibraryCommandRunner, LibraryNotFoundError } from '../../src/library/command-support.ts';
import { prepareEntryRestoration } from '../../src/library/entry-restore-preparation.ts';
import type { Actor } from '../../src/request/access.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture;
beforeAll(async () => {
  f = await createProfileEntryFixture({ singleConnection: true });
}, 120000);
afterAll(async () => {
  await f?.close();
});
test('native restore preparation admits before its private archive point releases owner checkout before immutable original meaning and source checks and defers fresh errors past receipt replay', async () => {
  expect(f.pool.options.max).toBe(1);
  const subjectId = await f.createSubject('record');
  const made = await f.commands.putEntry(f.owner.actor, subjectId, { state: 'listening' }, entryKey());
  const entry = made.value.entry;
  const removed = await f.commands.deleteEntry(
    f.owner.actor,
    subjectId,
    entry.revision,
    entryKey(),
    entry.incarnationId!,
  );
  const input = { subjectId, deletionId: removed.transactionId, revision: entry.revision + 1 };
  await f.activate(f.replacementDigest);
  expect(f.replacement.types['ex:Record']!.library).toBeUndefined();
  const runner = createLibraryCommandRunner({ pool: f.pool });
  let bodies = 0,
    preparations = 0;
  const probe = (actor: Actor, key = entryKey(), selected = input) => {
    const deadline = deadlineFor(30000);
    return runner.ownAccountPrepared(
      actor,
      {
        action: 'library_entry:update',
        kind: 'library.fixture.restore_preparation',
        requestKey: key,
        input: selected,
        prepare: async (attempt) => {
          preparations++;
          const prepared = await prepareEntryRestoration(
            { pool: f.pool, access: f.access },
            actor,
            selected,
            attempt,
            deadline,
          );
          expect(prepared.at).toBe(attempt.time);
          return prepared;
        },
      },
      async (_tx, context, prepared) => {
        expect(prepared.at).toBe(context.time);
        if (prepared.kind === 'deferred') throw prepared.error;
        bodies++;
        expect(prepared.deletion.deletionId).toBe(removed.transactionId);
        expect(prepared.reference).toEqual({
          releaseDigest: f.originalDigest,
          profileId: 'fixture.record',
          stateSetId: f.original.libraryProfiles!['fixture.record']!.entryStateSet!.id,
          stateId: 'listening',
        });
        return noEffect({ observed: true });
      },
    );
  };
  const key = entryKey();
  const first = await probe(f.owner.actor, key);
  expect(first.value).toEqual({ observed: true });
  expect(first.replayed).toBe(false);
  expect(bodies).toBe(1);
  const before = await f.inspect();
  await expect(probe({ ...f.owner.actor })).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(probe({ kind: 'anonymous' })).rejects.toBeInstanceOf(GrantDeniedError);
  await expect(probe(f.other.actor)).rejects.toBeInstanceOf(LibraryNotFoundError);
  expect(await f.inspect()).toEqual(before);
  await f.setLibraryOpen(false);
  const closed = await f.inspect();
  await expect(probe(f.owner.actor, key)).rejects.toBeInstanceOf(PlatformClosedError);
  expect(await f.inspect()).toEqual(closed);
  await f.setLibraryOpen(true);
  const hidden = await f.send('steward', 'POST', `/v1/subjects/${subjectId}:hide`, {
    reason: 'Native restore preparation source visibility',
  });
  expect(hidden.status).toBe(200);
  const concealed = await f.inspect();
  const preparationsBeforeReplay = preparations;
  const replay = await probe(f.owner.actor, key);
  expect(replay).toEqual({ ...first, replayed: true });
  expect(bodies).toBe(1);
  await expect(probe(f.owner.actor)).rejects.toBeInstanceOf(LibraryNotFoundError);
  expect(bodies).toBe(1);
  expect(preparations).toBeGreaterThan(preparationsBeforeReplay);
  expect(await f.inspect()).toEqual(concealed);
}, 120000);
