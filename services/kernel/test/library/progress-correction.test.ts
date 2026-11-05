import { afterAll, beforeAll, expect, test } from 'bun:test';
import { compileCatalogue } from '@rezics/definitions/compile';
import { fixture, legacyProfile } from '../../../../packages/definitions/test/support/library-profiles.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let native: NativeProfileFixture;
let owner: NativeProfileFixture['owner'];
let digest: string;
beforeAll(async () => {
  native = await createProfileEntryFixture();
  owner = await native.identity([
    'subject:read',
    'library_entry:read',
    'library_entry:update',
    'copy:create',
    'copy:read',
    'progress_session:create',
    'progress_session:read',
    'progress_session:update',
  ]);
  const profile = legacyProfile();
  profile.id = 'fixture.corrections';
  digest = await native.publish(await compileCatalogue(fixture(profile)));
  await native.activate(digest);
  await native.send('steward', 'POST', '/v1/platform/exposure/reading_progress:open');
}, 120_000);
afterAll(async () => {
  await native?.close();
});
async function send(
  method: string,
  path: string,
  body?: unknown,
  status = 200,
  key = entryKey(),
  bearer = owner.bearer,
) {
  const response = await native.send(bearer, method, path, body, key);
  const result = await response.json();
  expect({ status: response.status, result }).toEqual({ status, result: expect.any(Object) });
  return result;
}

test('clear preserves accepted facts, rereads and other personal facts, with exact CAS, replay and owner refusal', async () => {
  const subjectId = await native.createSubject('game');
  await send('PUT', `/v1/libraryEntries/${subjectId}`, { state: 'planned' }, 201);
  const label = (await send('POST', '/v1/libraryLabels', { name: 'Keep me' }, 201)).label;
  await send('POST', `/v1/libraryLabels/${label.id}:assign`, { subjectId });
  await send('POST', '/v1/copies', { subjectId, kind: 'legacy-unspecified', status: 'owned' }, 201);
  const assignments = () => send('GET', `/v1/libraryLabelAssignments?subjectId=${subjectId}`);
  const savedLabels = await assignments();
  const before = await native.inspect(owner.actor.accountId);
  for (const [mode, unit, values] of [
    ['scalar_amount', 'page', { amount: '0' }],
    ['cursor_position', 'chapter', { locator: 'opaque/part:7', position: '0' }],
    ['completed_units', 'episode', { add: ['1', '3', '7'] }],
  ] as const) {
    const create = { subjectId, mode, unit, ...(mode === 'scalar_amount' ? { total: '400' } : {}) };
    const first = (await send('POST', '/v1/progressSessions', create, 201)).progressSession;
    const reread = (await send('POST', '/v1/progressSessions', create, 201)).progressSession;
    const path = `/v1/progressSessions/${first.id}`;
    const recorded = (await send('POST', `${path}:record`, { revision: 1, ...values })).progressSession;
    const completed = (await send('POST', `${path}:complete`, { revision: 2 })).progressSession;
    expect((await send('POST', `${path}:record`, { revision: 2, clear: true }, 409)).code).toBe('conflict');
    await send('POST', `${path}:record`, { revision: 3, clear: true, amount: '0' }, 400);
    const alien = await native.identity(['progress_session:update']);
    await send('POST', `${path}:record`, { revision: 3, clear: true }, 404, entryKey(), alien.bearer);
    // Replacement has no matching pair for page/chapter/episode. Clearing needs no new value admission.
    await native.activate(native.replacementDigest);
    const key = entryKey();
    const cleared = await send('POST', `${path}:record`, { revision: 3, clear: true }, 200, key);
    expect(cleared.progressSession).toEqual({
      ...completed,
      amount: null,
      locator: null,
      position: null,
      completedUnitCount: 0,
      revision: 4,
    });
    expect(await send('POST', `${path}:record`, { revision: 3, clear: true }, 200, key)).toEqual(cleared);
    expect((await send('GET', path)).progressSession).toEqual(cleared.progressSession);
    expect((await send('GET', `${path}/completedUnits`)).completedUnits).toEqual([]);
    expect((await send('GET', `/v1/progressSessions/${reread.id}`)).progressSession).toEqual(reread);
    const changes = await send('GET', `${path}/changes`);
    expect(changes.changes.map((change: { intent: unknown }) => change.intent)).toEqual([values, { clear: true }]);
    expect(recorded.total).toBe(first.total);
    await native.activate(digest);
  }
  const after = await native.inspect(owner.actor.accountId);
  expect(after.entries.map(({ row }) => [row.state, row.revision, row.library_profile_pin])).toEqual(
    before.entries.map(({ row }) => [row.state, row.revision, row.library_profile_pin]),
  );
  expect(after.copies).toEqual(before.copies);
  expect(await assignments()).toEqual(savedLabels);
  expect(after.sessions).toHaveLength(6); // A retained empty session still establishes Library presence.
}, 120_000);
