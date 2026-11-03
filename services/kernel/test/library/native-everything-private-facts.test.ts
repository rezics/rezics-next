import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readOwnerOriginalTruth } from '../../src/library/owner-index.ts';
import { createLibraryDriver } from './support/outcome-driver.ts';
import { createDynamicCollectionsDriver } from './support/native-dynamic-driver.ts';
import { createNativePrivateFactsFixture } from './support/native-private-facts-fixture.ts';
import { json, setEntry, write, type NativeConformanceWorld } from './support/native-conformance.ts';

let world: NativeConformanceWorld;
let driver: Awaited<ReturnType<typeof createDynamicCollectionsDriver>>;
let facts: ReturnType<typeof createNativePrivateFactsFixture>;
beforeAll(async () => {
  world = await createLibraryDriver();
  driver = await createDynamicCollectionsDriver(world);
  facts = createNativePrivateFactsFixture(world);
}, 180_000);
afterAll(async () => {
  await world?.close();
});
const subject = () => driver.provisionSubject('recipe');
const state = () => driver.profiles.recipe.states[0]!.id;
const get = (path: string) => world.native.request('owner', { method: 'GET', path });
// The production native union predicate: no test-side membership model or canonical readiness claim.
const truth = (id: string, owner = world.accounts.owner.id) => readOwnerOriginalTruth(world.native.reader, owner, id);
async function ok(response: Response, status = 200) {
  expect(response.status, await response.clone().text()).toBe(status);
}

test('state, effective labels and holdings preserve the native Everything union independently in either clearing order', async () => {
  const unrelated = await subject();
  await ok(await driver.setEntryState(unrelated.id, state()));
  const untouched = await json(await get(`/v1/libraryEntries/${unrelated.id}`));
  for (const last of ['label', 'holding'] as const) {
    const target = await subject();
    await ok(await driver.setEntryState(target.id, state()));
    await ok(await driver.addLabel(target.id, 'shared label'));
    await ok(await driver.createHolding(target.id), 201);
    await ok(await driver.createHolding(target.id), 201);
    await ok(await setEntry(world, 'other', target.id, state()));
    const otherBefore = await truth(target.id, world.accounts.other.id);
    await ok(await facts.clearEntryState(target.id), 204);
    expect((await truth(target.id)).families).toEqual({
      entry: false,
      label: true,
      session: false,
      copy: true,
    });
    await ok(
      await (last === 'label' ? facts.removeHoldings(target.id) : driver.removeLabel(target.id, 'shared label')),
      last === 'label' ? 204 : 200,
    );
    expect(await truth(target.id)).toMatchObject({
      presence: true,
      families: {
        entry: false,
        label: last === 'label',
        session: false,
        copy: last === 'holding',
      },
    });
    await ok(await driver.removeAllPrivateFacts(target.id), last === 'label' ? 200 : 204);
    expect((await truth(target.id)).presence).toBe(false);
    expect(await truth(target.id, world.accounts.other.id)).toEqual(otherBefore);
    await ok(await driver.setEntryState(target.id, state()));
    expect((await truth(target.id)).presence).toBe(true);
    await ok(await driver.removeAllPrivateFacts(target.id), 204);
  }
  expect(await json(await get(`/v1/libraryEntries/${unrelated.id}`))).toEqual(untouched);
}, 180_000);

test('cleanup retains original guards, raw deletion receipts, exact replay and exact Undo inputs', async () => {
  const target = await subject();
  await ok(await driver.setEntryState(target.id, state()));
  await ok(await driver.addLabel(target.id, 'undo label'));
  const originalCopy = await json<{ copy: { id: string; revision: number } }>(
    await driver.createHolding(target.id),
    201,
  );
  const start = facts.removals.length;
  const response = await facts.removeAllPrivateFacts(target.id);
  const removals = facts.removals.slice(start);
  expect(removals.map((row) => row.kind)).toEqual(['entry', 'label', 'holding']);
  expect(response.status).toBe(204);
  expect(response.headers.get('Library-Copy-Deletion-Id')).toBe(
    removals[2]!.response.headers.get('Library-Copy-Deletion-Id'),
  );
  expect((await truth(target.id)).presence).toBe(false);
  for (const removal of removals) {
    const replay = await facts.replay(removal);
    expect(replay.status).toBe(removal.response.status);
    expect(await replay.text()).toBe(await removal.response.clone().text());
    for (const name of [
      'Library-Entry-Deletion-Id',
      'Library-Entry-Deletion-Revision',
      'Library-Copy-Deletion-Id',
      'Library-Copy-Deletion-Revision',
      'Library-Label-Assignment-Revision',
    ])
      expect(replay.headers.get(name)).toBe(removal.response.headers.get(name));
    const original = removal.original;
    let path: string;
    let body: unknown;
    if (removal.kind === 'label' && 'labelId' in original) {
      path = `/v1/libraryLabels/${original.labelId}:restoreAssignment`;
      body = {
        subjectId: target.id,
        assignmentId: original.id,
        revision: Number(removal.response.headers.get('Library-Label-Assignment-Revision')),
      };
    } else {
      const family = removal.kind === 'entry' ? 'Entry' : 'Copy';
      path =
        removal.kind === 'entry'
          ? `/v1/libraryEntries/${target.id}:restore`
          : `/v1/copies/${originalCopy.copy.id}:restore`;
      body = {
        deletionId: removal.response.headers.get(`Library-${family}-Deletion-Id`),
        revision: Number(removal.response.headers.get(`Library-${family}-Deletion-Revision`)),
      };
    }
    await ok(await write(world, 'owner', 'POST', path, body));
    expect((await truth(target.id)).presence).toBe(true);
  }
}, 180_000);

test('active, abandoned and completed history remain facts and expose the missing session removal interface', async () => {
  const target = await subject();
  const sessions: { id: string; revision: number }[] = [];
  for (const transition of [null, 'abandon', 'complete']) {
    const { progressSession } = await json<{
      progressSession: { id: string; revision: number };
    }>(await driver.startProgressSession(target.id), 201);
    await ok(
      await write(world, 'owner', 'POST', `/v1/progressSessions/${progressSession.id}:record`, {
        revision: progressSession.revision,
        amount: '2',
      }),
    );
    if (transition)
      await ok(
        await write(world, 'owner', 'POST', `/v1/progressSessions/${progressSession.id}:${transition}`, {
          revision: progressSession.revision + 1,
        }),
      );
    sessions.push(progressSession);
  }
  const published = await json<{ publishedLog: { id: string } }>(
    await write(world, 'owner', 'POST', '/v1/publishedLogs', {
      sessionId: sessions[2]!.id,
      note: 'Retained original snapshot',
    }),
    201,
  );
  const paths = [
    `/v1/progressSessions?subjectId=${target.id}`,
    `/v1/publishedLogs/${published.publishedLog.id}`,
    ...sessions.map((session) => `/v1/progressSessions/${session.id}/changes`),
  ];
  const before = await Promise.all(paths.map(async (path) => json(await get(path))));
  await ok(await driver.setEntryState(target.id, state()));
  await ok(await driver.addLabel(target.id, 'history label'));
  await ok(await driver.createHolding(target.id), 201);
  await expect(driver.removeAllPrivateFacts(target.id)).rejects.toThrow(
    'owner-scoped progress-session deletion/retention command',
  );
  expect((await truth(target.id)).families).toEqual({
    entry: false,
    label: false,
    session: true,
    copy: false,
  });
  expect((await truth(target.id)).presence).toBe(true);
  await expect(facts.removeSessions(target.id)).rejects.toThrow(
    'owner-scoped progress-session deletion/retention command',
  );
  expect(
    facts.retainedSessions
      .get(target.id)
      ?.map((session) => session.state)
      .sort(),
  ).toEqual(['abandoned', 'active', 'completed']);
  expect(await Promise.all(paths.map(async (path) => json(await get(path))))).toEqual(before);
}, 180_000);

test('follows, curated occurrences and another account publication do not create private membership or get erased', async () => {
  const target = await subject();
  await ok(await write(world, 'owner', 'PUT', `/v1/follows/${target.id}`));
  const { collection } = await json<{ collection: { id: string } }>(
    await write(world, 'owner', 'POST', '/v1/collections', {
      title: 'Curated only',
      visibility: 'private',
    }),
    201,
  );
  const { member } = await json<{ member: { id: string } }>(
    await write(world, 'owner', 'POST', `/v1/collections/${collection.id}/members`, { subjectId: target.id }),
    201,
  );
  const { progressSession } = await json<{ progressSession: { id: string } }>(
    await write(world, 'other', 'POST', '/v1/progressSessions', {
      subjectId: target.id,
      mode: 'scalar_amount',
      unit: 'minute',
    }),
    201,
  );
  const { publishedLog } = await json<{ publishedLog: { id: string } }>(
    await write(world, 'other', 'POST', '/v1/publishedLogs', {
      sessionId: progressSession.id,
    }),
    201,
  );
  const paths = [
    `/v1/follows/${target.id}`,
    `/v1/collections/${collection.id}/members/${member.id}`,
    `/v1/publishedLogs/${publishedLog.id}`,
  ];
  const before = await Promise.all(paths.map(async (path) => json(await get(path))));
  expect((await truth(target.id)).presence).toBe(false);
  await ok(await driver.removeAllPrivateFacts(target.id));
  expect((await truth(target.id)).presence).toBe(false);
  expect((await truth(target.id, world.accounts.other.id)).presence).toBe(true);
  expect(await Promise.all(paths.map(async (path) => json(await get(path))))).toEqual(before);
}, 180_000);
