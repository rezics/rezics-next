import { afterAll, beforeAll, expect, test } from 'bun:test';
import { compileCatalogue } from '@rezics/definitions/compile';
import { fixture, libraryProfile, unitData } from '../../../../packages/definitions/test/support/library-profiles.ts';
import { mintReadTime, releaseOperationalTime } from '../../src/command/command.ts';
import { withConnection } from '../../src/database/pool.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { readLibraryProfileSourceObservation } from '../../src/library/profile-source.ts';
import { createSessionCommands } from '../../src/library/sessions.ts';
import type { ProgressSession } from '../../src/library/progress-model.ts';
import {
  executeProgressAdoption,
  reviewProgressAdoption,
  type ProgressAdoptionCheckpoint,
} from '../../src/library/list-import-progress-adoption.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let native: NativeProfileFixture;
let sessions: ReturnType<typeof createSessionCommands>;
let original: string;
let removed: string;
const path = (id: string) => `/v1/progressSessions/${id}`;
async function send(method: string, url: string, body?: unknown, status = 200, key = entryKey()) {
  const response = await native.send('owner', method, url, body, key);
  const value = await response.json();
  expect({ status: response.status, value }).toMatchObject({ status });
  return value;
}
beforeAll(async () => {
  native = await createProfileEntryFixture();
  sessions = createSessionCommands(native);
  for (const retained of [true, false]) {
    const profile = libraryProfile(retained ? 'fixture.reading' : 'fixture.replaced', 'chapter');
    profile.progress.allowed[0].units = (retained ? ['chapter', 'volume'] : ['chapter']).map((unit) => unitData(unit));
    const digest = await native.publish(await compileCatalogue(fixture(profile)));
    if (retained) original = digest;
    else removed = digest;
  }
  await native.activate(original);
  await native.grantLibraryGate(native.owner.actor.accountId);
  expect((await native.send('steward', 'POST', '/v1/platform/exposure/reading_progress:open')).status).toBe(200);
}, 120_000);
afterAll(async () => {
  await native?.close();
});
async function start() {
  const subjectId = await native.createSubject('game');
  return (
    await sessions.startSession(
      native.owner.actor,
      {
        subjectId,
        mode: 'scalar_amount',
        unit: 'chapter',
        additionalMeasures: [{ unit: 'volume' }],
      },
      entryKey(),
    )
  ).value;
}

test('MAL and AniList adopt chapters and volumes into the selected occurrence without changing its journal or lifecycle', async () => {
  for (const provider of ['mal', 'anilist']) {
    const occurrence = await start();
    await sessions.patchSessionJournal(
      native.owner.actor,
      occurrence.id,
      {
        revision: 0,
        startDate: { year: 2024 },
        assessment: { units: 0 },
      },
      entryKey(),
    );
    const journal = await sessions.readSessionJournal(native.owner.actor, occurrence.id);
    const base = `/v1/libraryImports/${provider}`;
    const upload = await send(
      'POST',
      `${base}:preview`,
      provider === 'mal'
        ? {
            xml: '<myanimelist><manga><manga_mangadb_id>710</manga_mangadb_id><manga_title>Reading</manga_title><my_read_chapters>0</my_read_chapters><my_read_volumes>2</my_read_volumes></manga></myanimelist>',
          }
        : { upload: JSON.stringify([{ mediaId: 710, media: { type: 'MANGA' }, progress: 0, progressVolumes: 2 }]) },
    );
    const url = `${base}/${upload.id}`;
    const progress = {
      occurrence: { kind: 'existing', sessionId: occurrence.id },
      measures: (provider === 'mal' ? ['my_read_chapters', 'my_read_volumes'] : ['progress', 'progressVolumes']).map(
        (field) => ({ field, action: 'adopt' }),
      ),
    };
    const key = entryKey();
    const review = await send(
      'POST',
      `${url}${provider === 'mal' ? '/review' : ':review'}`,
      provider === 'mal'
        ? { row: 0, target: occurrence.subjectId, progress }
        : { ordinal: 0, subjectId: occurrence.subjectId, fields: [], progress },
      200,
      key,
    );
    const result = await send(
      'POST',
      `${url}${provider === 'mal' ? '/apply' : ':apply'}`,
      provider === 'mal'
        ? { confirm: true, rows: [{ row: 0, version: key, fields: [] }] }
        : { confirmations: [{ ordinal: 0, reviewId: review.review.id }] },
    );
    expect(result.outcomes[0].progress.measures).toMatchObject([
      { unit: 'chapter', status: 'applied', currentAmount: '0' },
      { unit: 'volume', status: 'applied', currentAmount: '2' },
    ]);
    const current = (await send('GET', `${path(occurrence.id)}?presentation=FULL`)).progressSession;
    expect(current).toMatchObject({
      id: occurrence.id,
      revision: 3,
      state: 'active',
      completedAt: null,
      completedUnitCount: 0,
      measures: [
        { unit: 'chapter', amount: '0' },
        { unit: 'volume', amount: '2' },
      ],
    });
    const intents = [
      { measureId: 'chapter', amount: '3' },
      { measureId: 'volume', amount: '4' },
    ];
    const concurrent = await Promise.allSettled(
      intents.map((intent) =>
        sessions.recordProgress(native.owner.actor, occurrence.id, { revision: 3, ...intent }, entryKey()),
      ),
    );
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const losing = concurrent.findIndex((result) => result.status === 'rejected');
    await sessions.recordProgress(native.owner.actor, occurrence.id, { revision: 4, ...intents[losing] }, entryKey());
    expect((await send('GET', path(occurrence.id))).progressSession.measures).toMatchObject([
      { unit: 'chapter', amount: '3' },
      { unit: 'volume', amount: '4' },
    ]);
    expect(await sessions.readSessionJournal(native.owner.actor, occurrence.id)).toEqual(journal);
    expect((await send('GET', `/v1/progressSessions?subjectId=${occurrence.subjectId}`)).progressSessions).toHaveLength(
      1,
    );
  }
});

test('uncertain native measure receipts survive profile replacement and retirement while new effects require review', async () => {
  for (const retirement of [false, true]) {
    await native.activate(original);
    const occurrence = await start();
    const at = await withConnection(native.pool, (client) => mintReadTime(client));
    const observation = await readLibraryProfileSourceObservation(
      {
        ...native,
        actor: native.owner.actor,
        at,
        deadline: deadlineFor(30_000),
      },
      occurrence.subjectId,
    ).finally(() => releaseOperationalTime(at));
    if (observation?.source.kind !== 'supported') throw new Error('Missing native profile observation');
    const binding = {
      pin: observation.source.pin,
      epoch: observation.anchor.identityEpoch.toString(),
      acceptingType: observation.anchor.acceptingType,
    };
    const plan = await reviewProgressAdoption(
      sessions,
      native.owner.actor,
      occurrence.subjectId,
      observation.source.profile,
      binding,
      [
        { field: 'my_read_chapters', unit: 'chapter', state: 'zero', amount: '0' },
        { field: 'my_read_volumes', unit: 'volume', state: 'value', amount: '5' },
      ],
      {
        occurrence: { kind: 'existing', sessionId: occurrence.id },
        measures: [
          { field: 'my_read_chapters', action: 'adopt' },
          { field: 'my_read_volumes', action: 'adopt' },
        ],
      },
      entryKey(),
    );
    let saved: ProgressAdoptionCheckpoint | undefined;
    const receipts: ProgressSession[] = [];
    let loseAcknowledgement = true;
    let admitted = true;
    const controls = {
      canceled: async () => false,
      binding: async () => (admitted ? binding : null),
      save: async (checkpoint: ProgressAdoptionCheckpoint) => {
        saved = structuredClone(checkpoint);
      },
      recordNative(command: { value: ProgressSession }) {
        receipts.push(command.value);
        if (loseAcknowledgement && receipts.length === 2) throw new Error('Lost native acknowledgement after commit');
      },
    };
    const pending = await executeProgressAdoption(native.owner.actor, sessions, plan, null, controls);
    expect(pending.complete).toBe(false);
    expect(pending.steps.my_read_chapters?.result?.status).toBe('applied');
    expect(pending.steps.my_read_volumes?.result?.status).toBe('failed');
    expect((await send('GET', path(occurrence.id))).progressSession).toMatchObject({ revision: 3, amount: '0' });
    if (retirement) await sessions.retireSession(native.owner.actor, occurrence.id, { revision: 3 }, entryKey());
    else {
      await native.activate(removed);
      const detail = (await send('GET', `${path(occurrence.id)}?presentation=FULL`)).progressSession;
      expect(detail.measures[1]).toMatchObject({
        unit: 'volume',
        amount: '5',
        presentation: { meaning: 'known', unitLabel: 'volume', recording: { state: 'unsupported' } },
      });
    }
    admitted = false;
    loseAcknowledgement = false;
    await executeProgressAdoption(native.owner.actor, sessions, plan, saved, {
      ...controls,
      save: async () => false,
    });
    expect(receipts).toHaveLength(2);
    const recovered = await executeProgressAdoption(native.owner.actor, sessions, plan, saved, controls);
    expect(receipts[2]).toEqual(receipts[1]);
    expect(recovered.steps.my_read_volumes).toMatchObject({
      requestKey: pending.steps.my_read_volumes!.requestKey,
      revision: 2,
      result: { status: 'applied' },
    });
    expect(recovered.complete).toBe(true);
    const retained = (await native.inspect()).sessions.find(({ row }) => row.session_id === occurrence.id)!.row;
    expect(retained.library_profile_pin).toEqual(binding.pin);
    if (retirement) await send('GET', path(occurrence.id), undefined, 404);
    // A pending key without an admitted receipt cannot create a value under the old review.
    for (const intent of [{ amount: '3' }, { clear: true }])
      await expect(
        sessions.recordProgress(
          native.owner.actor,
          occurrence.id,
          { revision: 3, measureId: 'chapter', ...intent },
          entryKey(),
          {
            subjectId: plan.subjectId,
            acceptingType: binding.acceptingType,
            identityEpoch: binding.epoch,
            profilePin: binding.pin,
          },
        ),
      ).rejects.toThrow();
  }
});
