import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createPersonalLabelCommands } from '../../src/library/label-commands.ts';
import { createLabelAssignmentCommands } from '../../src/library/label-assignment-commands.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
let f: NativeProfileFixture;
beforeAll(async () => {
  f = await createProfileEntryFixture();
}, 120000);
afterAll(async () => {
  await f?.close();
});
test('native label assignments admit unprofiled subjects preserve no-effect duplicate receipts enforce32capacity and expose exact identity revision in bounded private pages', async () => {
  const catalogue = createPersonalLabelCommands({ pool: f.pool, tokens: f.tokens });
  const commands = createLabelAssignmentCommands({ pool: f.pool, access: f.access, tokens: f.tokens });
  const actor = f.owner.actor,
    subjectId = await f.createSubject('unprofiled');
  const label = (await catalogue.createLabel(actor, { name: 'Unprofiled' }, entryKey())).value.label;
  const key = entryKey(),
    first = await commands.assignLabel(actor, label.id, { subjectId }, key);
  const a = first.value.assignment;
  expect(Object.keys(a).sort()).toEqual(['id', 'revision']);
  expect(a.revision).toBe(1);
  const before = await f.inspect();
  const duplicate = await commands.assignLabel(actor, label.id, { subjectId }, entryKey());
  expect(duplicate.value).toEqual(first.value);
  const after = await f.inspect();
  expect(after.events).toEqual(before.events);
  expect(after.partition).toEqual(before.partition);
  expect(after.receipts.length - before.receipts.length).toBe(1);
  expect(after.entries).toEqual(before.entries);
  expect(after.sessions).toEqual(before.sessions);
  expect(after.copies).toEqual(before.copies);
  expect(after.entitlements).toEqual(before.entitlements);
  expect((await commands.listAssignments(actor, { labelId: label.id, limit: 100 })).assignments).toEqual([
    { id: a.id, labelId: label.id, subjectId, revision: 1 },
  ]);
  expect((await commands.listAssignments(actor, { subjectId, limit: 100 })).assignments).toEqual([
    { id: a.id, labelId: label.id, subjectId, revision: 1 },
  ]);
  const ids = [label.id];
  for (let n = 1; n < 33; n++)
    ids.push((await catalogue.createLabel(actor, { name: 'Cap ' + n }, entryKey())).value.label.id);
  for (const labelId of ids.slice(1, 32)) await commands.assignLabel(actor, labelId, { subjectId }, entryKey());
  const full = await f.inspect();
  await expect(commands.assignLabel(actor, ids[32]!, { subjectId }, entryKey())).rejects.toMatchObject({
    code: 'library_label_capacity',
  });
  expect(await f.inspect()).toEqual(full);
  const removed = await commands.unassignLabel(
    actor,
    label.id,
    { subjectId, assignmentId: a.id, revision: a.revision },
    entryKey(),
  );
  expect(removed.value).toEqual({ deleted: true, revision: 2 });
  expect((await commands.listAssignments(actor, { labelId: label.id })).assignments).toEqual([]);
  await commands.assignLabel(actor, ids[32]!, { subjectId }, entryKey());
  await expect(
    commands.restoreAssignment(
      actor,
      label.id,
      { subjectId, assignmentId: a.id, revision: removed.value.revision },
      entryKey(),
    ),
  ).rejects.toMatchObject({ code: 'library_label_restore_capacity' });
  const replay = await commands.assignLabel(actor, label.id, { subjectId }, key);
  expect(replay.replayed).toBe(true);
  expect(replay.value).toEqual(first.value);
  expect((await commands.listAssignments(actor, { labelId: label.id })).assignments).toEqual([]);
}, 120000);
