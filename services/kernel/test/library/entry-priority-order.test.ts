import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { createEntryPriorityReaders } from '../../src/library/entry-priority-page.ts';
import { routeOf } from '../../src/route/route.ts';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';

let f: NativeProfileFixture;
beforeAll(async () => {
  f = await createProfileEntryFixture();
}, 120_000);
beforeEach(async () => f.activate(f.originalDigest));
afterAll(async () => f?.close());

test('priority pages order the full filtered shelf and read current annotation writes', async () => {
  const route = routeOf(f.owner.actor.accountId)!;
  const owner = f.owner.actor.accountId;
  const ids = {
    edited: await f.createSubject('recipe'),
    first: await f.createSubject('recipe'),
    tied: await f.createSubject('recipe'),
    unranked: await f.createSubject('recipe'),
    excluded: await f.createSubject('record'),
  };
  for (const [subjectId, state] of [
    [ids.edited, 'planned'],
    [ids.first, 'planned'],
    [ids.tied, 'planned'],
    [ids.unranked, 'planned'],
    [ids.excluded, 'completed'],
  ] as const)
    await f.commands.putEntry(f.owner.actor, subjectId, { state }, entryKey());

  async function annotate(subjectId: string, revision: number, priority: { op: 'set'; value: number } | { op: 'clear' }) {
    return f.send(
      'owner',
      'PUT',
      `/v1/libraryEntries/${subjectId}/annotations`,
      { revision, note: revision === 0 ? { op: 'set', value: 'Keep this note' } : { op: 'unchanged' }, priority },
      entryKey(),
    );
  }
  expect((await annotate(ids.edited, 0, { op: 'set', value: 8 })).status).toBe(200);
  expect((await annotate(ids.first, 0, { op: 'set', value: 1 })).status).toBe(200);
  expect((await annotate(ids.tied, 0, { op: 'set', value: 8 })).status).toBe(200);
  expect((await annotate(ids.excluded, 0, { op: 'set', value: 1 })).status).toBe(200);
  const source = await f.send(
    'owner',
    'POST',
    `/v1/libraryEntries/${ids.edited}/sourceObservations`,
    {
      provider: 'anilist',
      recordId: 'priority-plan',
      confirmReviewed: true,
      privacy: { status: 'unknown' },
      sourceCreated: { status: 'absent' },
      sourceUpdated: { status: 'absent' },
    },
    entryKey(),
  );
  expect(source.status).toBe(201);

  const type = await f.pool.query<{ typeId: string }>(
    'SELECT type_id AS "typeId" FROM library.entry WHERE route=$1 AND account_id=$2 AND subject_id=$3',
    [route, owner, ids.edited],
  );
  const readers = createEntryPriorityReaders();
  const query = (direction: 'asc' | 'desc', limit: number) => ({
    state: 'planned',
    typeId: type.rows[0]!.typeId,
    orderBy: 'priority' as const,
    direction,
    limit,
  });
  const asc = (after: { key: string; subjectId: string } | null, limit = 2) =>
    readers.asc.page(f.pool, route, owner, query('asc', limit), after);
  const firstPage = await asc(null);
  expect(firstPage.entries.map((entry) => entry.subjectId)).toEqual([
    ids.first,
    [ids.edited, ids.tied].sort((a, b) => a.localeCompare(b))[0],
  ]);
  expect(firstPage.entries.map((entry) => entry.priority)).toEqual([1, 8]);
  const boundary = firstPage.entries.at(-1)!;
  const secondPage = await asc({ key: String(boundary.priority), subjectId: boundary.subjectId });
  expect(secondPage.entries.map((entry) => entry.subjectId)).toEqual([
    [ids.edited, ids.tied].sort((a, b) => a.localeCompare(b))[1],
    ids.unranked,
  ]);
  expect(secondPage.entries.at(-1)?.priority).toBeNull();

  const unranked = await asc({ key: '100', subjectId: owner }, 10);
  expect(unranked.entries.map((entry) => entry.priority)).toEqual([null]);
  const descending = await readers.desc.page(f.pool, route, owner, query('desc', 10), null);
  expect(descending.entries.map((entry) => entry.subjectId)).toEqual([
    ...[ids.edited, ids.tied].sort((a, b) => a.localeCompare(b)),
    ids.first,
    ids.unranked,
  ]);

  expect((await annotate(ids.edited, 1, { op: 'set', value: 2 })).status).toBe(200);
  const changedFirst = await asc(null);
  expect(changedFirst.entries.map((entry) => entry.subjectId)).toEqual([ids.first, ids.edited]);
  expect(changedFirst.entries.map((entry) => entry.priority)).toEqual([1, 2]);
  const changedPersonal = await f.send('owner', 'GET', `/v1/libraryEntries/${ids.edited}/personal`);
  expect((await changedPersonal.json()).personalEntry).toMatchObject({
    note: 'Keep this note',
    priority: 2,
    sourceObservations: [expect.objectContaining({ recordId: 'priority-plan' })],
  });

  expect((await annotate(ids.edited, 2, { op: 'set', value: 0 })).status).toBe(400);
  expect((await annotate(ids.edited, 2, { op: 'clear' })).status).toBe(200);
  const cleared = await f.send('owner', 'GET', `/v1/libraryEntries/${ids.edited}/personal`);
  expect((await cleared.json()).personalEntry).toMatchObject({ note: 'Keep this note', priority: null });
  const afterClear = await asc({ key: '100', subjectId: owner }, 10);
  expect(afterClear.entries.map((entry) => entry.priority)).toEqual([null, null]);
});
