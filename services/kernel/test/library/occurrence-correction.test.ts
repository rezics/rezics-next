import { afterAll, beforeAll, expect, test } from 'bun:test';
import { entryKey, createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { routeOf } from '../../src/route/route.ts';
import { exportSections, initialExportSeek, readExportSourcePage } from '../../src/library/library-export-source.ts';

let native: NativeProfileFixture;
let owner: NativeProfileFixture['owner'];
const scopes = [
  'subject:read',
  'library_entry:read',
  'library_entry:update',
  'copy:create',
  'copy:read',
  'progress_session:create',
  'progress_session:read',
  'progress_session:list',
  'progress_session:update',
  'published_log:create',
  'published_log:read',
  'published_log:delete',
];
beforeAll(async () => {
  native = await createProfileEntryFixture();
  owner = await native.identity(scopes);
  expect((await native.send('steward', 'POST', '/v1/platform/exposure/reading_progress:open')).status).toBe(200);
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
async function start(subjectId: string) {
  return (
    await send('POST', '/v1/progressSessions', { subjectId, mode: 'scalar_amount', unit: 'minute', total: '10' }, 201)
  ).progressSession;
}

test('one terminal occurrence reopens and a duplicate retires, with immutable snapshots and independent personal facts', async () => {
  const subjectId = await native.createSubject('game');
  await send('PUT', `/v1/libraryEntries/${subjectId}`, { state: 'planned' }, 201);
  await send('POST', '/v1/copies', { subjectId, kind: 'physical', status: 'owned' }, 201);
  const first = await start(subjectId);
  const duplicateStart = await start(subjectId);
  const duplicate = (await send('POST', `/v1/progressSessions/${duplicateStart.id}:complete`, { revision: 1 }))
    .progressSession;
  const repeatStart = await start(subjectId);
  const repeat = (await send('POST', `/v1/progressSessions/${repeatStart.id}:complete`, { revision: 1 }))
    .progressSession;
  const path = `/v1/progressSessions/${first.id}`;
  const journalKey = entryKey();
  const journalBody = { revision: 0, finishDate: { year: 2024 }, reflection: 'Retain original private meaning' };
  const journalReceipt = await send('PATCH', `${path}/journal`, journalBody, 200, journalKey);
  const journal = await send('GET', `${path}/journal`);
  const record = (await send('POST', `${path}:record`, { revision: 1, amount: '10' })).progressSession;
  expect(record.state).toBe('active'); // A full amount is not completion.
  const completed = (await send('POST', `${path}:complete`, { revision: 2 })).progressSession;
  const publicLog = (await send('POST', '/v1/publishedLogs', { sessionId: first.id, note: 'Captured' }, 201))
    .publishedLog;
  const before = await native.inspect(owner.actor.accountId);
  expect((await send('GET', '/v1/libraryConsumptionSummary')).completedOccurrences).toBe('3');
  await send('POST', `${path}:reopen`, { revision: 2 }, 409);
  const foreign = await native.identity(scopes, undefined, routeOf(owner.actor.accountId)!);
  await send('POST', `${path}:reopen`, { revision: 3 }, 404, entryKey(), foreign.bearer);
  const key = entryKey();
  const reopened = await send('POST', `${path}:reopen`, { revision: 3 }, 200, key);
  expect(reopened.progressSession).toEqual({ ...completed, state: 'active', completedAt: null, revision: 4 });
  expect(await send('POST', `${path}:reopen`, { revision: 3 }, 200, key)).toEqual(reopened);
  expect(await send('GET', `${path}/journal`)).toEqual(journal);
  await send('POST', `${path}:reopen`, { revision: 4 }, 400);
  expect((await native.inspect(owner.actor.accountId)).entries).toEqual(before.entries);
  await send('POST', `${path}:record`, { revision: 4, amount: '7' });
  const beforeRetirement = await native.inspect(owner.actor.accountId);
  const changes = (await send('GET', `${path}/changes`)).changes;
  expect(changes.map((row: { intent: unknown }) => row.intent)).toEqual([
    { amount: '10' },
    { lifecycle: 'reopen', previousState: 'completed', previousCompletedAt: completed.completedAt },
    { amount: '7' },
  ]);
  const retireKey = entryKey();
  const retired = await send('POST', `/v1/progressSessions/${duplicate.id}:retire`, { revision: 2 }, 200, retireKey);
  expect(retired.progressSession).toEqual({ ...duplicate, state: 'retired', completedAt: null, revision: 3 });
  expect(await send('POST', `/v1/progressSessions/${duplicate.id}:retire`, { revision: 2 }, 200, retireKey)).toEqual(
    retired,
  );
  for (const suffix of ['', '/changes', '/completedUnits', '/journal'])
    await send('GET', `/v1/progressSessions/${duplicate.id}${suffix}`, undefined, 404);
  await send('POST', `/v1/progressSessions/${duplicate.id}:retire`, { revision: 3 }, 404);
  await send('POST', '/v1/publishedLogs', { sessionId: duplicate.id }, 404);
  const ids: string[] = [];
  let next: string | null = null;
  do {
    const page = await send(
      'GET',
      `/v1/progressSessions?subjectId=${subjectId}&limit=1${next ? `&cursor=${encodeURIComponent(next)}` : ''}`,
    );
    ids.push(...page.progressSessions.map((row: { id: string }) => row.id));
    next = page.next;
  } while (next);
  expect(ids.sort()).toEqual([first.id, repeat.id].sort());
  expect((await send('GET', `/v1/progressSessions/${repeat.id}`)).progressSession).toEqual(repeat);
  await send('POST', `${path}:retire`, { revision: 5 });
  await send('GET', `${path}/journal`, undefined, 404);
  await send('PATCH', `${path}/journal`, { revision: 1, reflection: null }, 404);
  expect(await send('PATCH', `${path}/journal`, journalBody, 200, journalKey)).toEqual(journalReceipt);
  expect((await send('GET', '/v1/libraryDiary?limit=1')).occurrences.map((row: { id: string }) => row.id)).toEqual([
    repeat.id,
  ]);
  expect(await send('GET', '/v1/libraryConsumptionSummary')).toMatchObject({
    completedOccurrences: '1',
    distinctCompletedSubjects: '1',
    repeatOccurrences: '0',
  });
  for (const section of ['sessions', 'history'] as const) {
    const page = await readExportSourcePage(
      native.pool,
      routeOf(owner.actor.accountId)!,
      owner.actor.accountId,
      {
        ...initialExportSeek(),
        section: exportSections.indexOf(section),
        parent: section === 'history' ? first.id : '',
      },
      new Date().toISOString(),
    );
    expect(page.records.map((row) => row.session_id)).toEqual(section === 'sessions' ? [repeat.id] : []);
  }
  expect((await send('GET', `/v1/publishedLogs/${publicLog.id}`)).publishedLog).toEqual(publicLog);
  const after = await native.inspect(owner.actor.accountId);
  expect(after.entries).toEqual(beforeRetirement.entries);
  expect(after.copies).toEqual(before.copies);
  expect(after.sessions).toHaveLength(3); // Private history is retained for account erasure.
  expect(after.sessions.filter(({ row }) => row.state === 'retired')).toHaveLength(2);
  expect(after.sessions.filter(({ row }) => row.state === 'completed')).toHaveLength(1);
}, 120_000);

test('retiring the last occurrence removes its native support; concealment and account fences govern fresh commands and retries', async () => {
  const subjectId = await native.createSubject('game');
  const first = await start(subjectId);
  const path = `/v1/progressSessions/${first.id}`;
  const key = entryKey();
  const retired = await send('POST', `${path}:retire`, { revision: 1 }, 200, key);
  const support = await native.pool.query(
    `SELECT 1 FROM library.owner_member_support WHERE route=$1 AND account_id=$2 AND subject_id=$3`,
    [routeOf(owner.actor.accountId), owner.actor.accountId, subjectId],
  );
  expect(support.rows).toEqual([]);
  const hidden = await native.createSubject('game');
  const occurrence = await start(hidden);
  await send('POST', `/v1/progressSessions/${occurrence.id}:complete`, { revision: 1 });
  expect(
    (await native.send('steward', 'POST', `/v1/subjects/${hidden}:hide`, { reason: 'Mistaken source' })).status,
  ).toBe(200);
  await send('POST', `/v1/progressSessions/${occurrence.id}:reopen`, { revision: 2 }, 404);
  await send('POST', `/v1/progressSessions/${occurrence.id}:retire`, { revision: 2 }, 404);
  expect(await send('POST', `${path}:retire`, { revision: 1 }, 200, key)).toEqual(retired);
  const isolated = await native.identity(scopes);
  const session = (
    await send(
      'POST',
      '/v1/progressSessions',
      { subjectId, mode: 'scalar_amount', unit: 'minute' },
      201,
      entryKey(),
      isolated.bearer,
    )
  ).progressSession;
  const isolatedKey = entryKey();
  await send('POST', `/v1/progressSessions/${session.id}:retire`, { revision: 1 }, 200, isolatedKey, isolated.bearer);
  await native.revokeIdentity(isolated.actor.accountId);
  const response = await native.send(
    isolated.bearer,
    'POST',
    `/v1/progressSessions/${session.id}:retire`,
    { revision: 1 },
    isolatedKey,
  );
  expect(response.status).toBe(401);
}, 120_000);
