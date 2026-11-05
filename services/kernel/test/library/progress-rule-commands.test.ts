import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { compileCatalogue } from '@rezics/definitions/compile';
import { fixture, legacyProfile } from '../../../../packages/definitions/test/support/library-profiles.ts';
import { createSessionCommands, ProgressConflictError, ProgressInvalidError } from '../../src/library/sessions.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let native: NativeProfileFixture;
let sessions: ReturnType<typeof createSessionCommands>;
beforeAll(async () => {
  native = await createProfileEntryFixture();
  await native.activate(await native.publish(await compileCatalogue(fixture(legacyProfile()))));
  await native.grantLibraryGate(native.owner.actor.accountId);
  expect((await native.send('steward', 'POST', '/v1/platform/exposure/reading_progress:open')).status).toBe(200);
  sessions = createSessionCommands(native);
}, 120_000);
afterAll(async () => {
  await native?.close();
});

describe('progress rules through the existing native session command', () => {
  test('stale edits refuse, while original receipts replay unchanged after later edits and retirement', async () => {
    const actor = native.owner.actor;
    const subjectId = await native.createSubject('game');
    const started = (
      await sessions.startSession(actor, { subjectId, mode: 'scalar_amount', unit: 'page', total: '400' }, entryKey())
    ).value;
    const record = { revision: started.revision, amount: '12.500000' };
    const recordKey = entryKey();
    const recorded = await sessions.recordProgress(actor, started.id, record, recordKey);
    const patch = {
      revision: 0,
      startDate: { year: 2024, month: 2 },
      reflection: ' kept\nexactly ',
      assessment: { units: 0 },
    };
    const key = entryKey();
    const receipt = await sessions.patchSessionJournal(actor, started.id, patch, key);
    expect(receipt.value).toEqual({ sessionId: started.id, revision: 1, changed: true });
    await expect(
      sessions.patchSessionJournal(actor, started.id, { revision: 0, reflection: 'stale' }, entryKey()),
    ).rejects.toBeInstanceOf(ProgressConflictError);
    await expect(
      sessions.patchSessionJournal(
        actor,
        started.id,
        { revision: 1, finishDate: { year: 1900, month: 2, day: 29 } },
        entryKey(),
      ),
    ).rejects.toBeInstanceOf(ProgressInvalidError);
    await sessions.patchSessionJournal(
      actor,
      started.id,
      { revision: 1, finishDate: { year: 2024, month: 2, day: 29 }, reflection: null },
      entryKey(),
    );
    const journal = await sessions.readSessionJournal(actor, started.id);
    expect(journal).toMatchObject({
      revision: 2,
      startDate: { year: 2024, month: 2 },
      finishDate: { year: 2024, month: 2, day: 29 },
      reflection: null,
      assessment: { units: 0 },
    });
    expect((await sessions.readSession(actor, started.id)).revision).toBe(recorded.value.revision);
    await expect(
      sessions.recordProgress(actor, started.id, { revision: started.revision, amount: '15' }, entryKey()),
    ).rejects.toBeInstanceOf(ProgressConflictError);
    await sessions.retireSession(actor, started.id, { revision: recorded.value.revision }, entryKey());
    expect((await sessions.patchSessionJournal(actor, started.id, patch, key)).value).toEqual(receipt.value);
    expect((await sessions.recordProgress(actor, started.id, record, recordKey)).value).toEqual(recorded.value);
  });
});
