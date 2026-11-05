import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createProfileEntryFixture, entryKey, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import { routeOf } from '../../src/route/route.ts';
import eraseNavigation from '../../src/library/erasure-owned-diary-navigation.sql';

let native: NativeProfileFixture;
let now = new Date();
const scopes = [
  'subject:read',
  'progress_session:create',
  'progress_session:read',
  'progress_session:list',
  'progress_session:update',
];
beforeAll(async () => {
  native = await createProfileEntryFixture({
    clock: () => now,
    projectLinks: false,
  });
  expect((await native.send('steward', 'POST', '/v1/platform/exposure/reading_progress:open')).status).toBe(200);
}, 120_000);
afterAll(async () => {
  await native?.close();
});
async function journey() {
  const owner = await native.identity(scopes);
  const send = async (method: string, path: string, body?: unknown, status = 200, key = entryKey()) => {
    const response = await native.send(owner.bearer, method, path, body, key);
    const value = await response.json();
    expect({ status: response.status, value }).toMatchObject({ status });
    return value;
  };
  const subjectId = await native.createSubject('game', 'Independent occurrence context');
  const start = async () =>
    (await send('POST', '/v1/progressSessions', { subjectId, mode: 'scalar_amount', unit: 'minute' }, 201))
      .progressSession;
  const page = (query = '', status = 200) => send('GET', '/v1/libraryDiary?limit=1' + query, undefined, status);
  const summary = (year = 2020) => send('GET', `/v1/libraryReportedYearSummary?year=${year}`);
  return { owner, send, start, page, summary, subjectId };
}

test('maintained generations bind repeats, private corrections and original receipts to exact occurrence revisions', async () => {
  const { send, start, page, summary, subjectId } = await journey();
  const first = await start(),
    repeat = await start();
  for (const row of [first, repeat])
    await send('POST', `/v1/progressSessions/${row.id}:complete`, {
      revision: 1,
    });
  const path = `/v1/progressSessions/${first.id}/journal`,
    key = entryKey();
  const patch = {
    revision: 0,
    startDate: { year: 2019 },
    finishDate: { year: 2020 },
    reflection: 'First only',
    assessment: { units: 0 },
  };
  const receipt = await send('PATCH', path, patch, 200, key); // Accepted before the client retains its checkpoint.
  const repeatPath = `/v1/progressSessions/${repeat.id}/journal`;
  await send('PATCH', repeatPath, {
    revision: 0,
    finishDate: { year: 2020, month: 2 },
    reflection: 'Repeat only',
    assessment: { units: 12 },
  });
  const totals = await summary(),
    opened = await page('&year=2020');
  expect(totals).toMatchObject({
    completedOccurrences: '2',
    distinctCompletedSubjects: '1',
    repeatOccurrences: '1',
  });
  expect(opened.currentness).toEqual(totals.currentness);
  const last = await page('&year=2020&cursor=' + encodeURIComponent(opened.next));
  expect(new Set([opened.occurrences[0].id, last.occurrences[0].id])).toEqual(new Set([first.id, repeat.id]));
  expect((await page('&year=2020&month=unallocated')).occurrences[0]).toMatchObject({
    id: first.id,
    assessment: { meaningRevision: 1, units: 0 },
    reportedDates: { revision: 1, startDate: { year: 2019 } },
  });
  await send('PATCH', path, { revision: 1, reflection: null });
  const corrected = await summary();
  expect(corrected.completedOccurrences).toBe('2');
  expect(corrected.currentness.revision).not.toBe(totals.currentness.revision);
  expect((await page('&year=2020&cursor=' + encodeURIComponent(opened.next), 409)).code).toBe('stale_cursor');
  expect(await send('PATCH', path, patch, 200, key)).toEqual(receipt);
  expect((await summary()).currentness).toEqual(corrected.currentness);
  await send('PATCH', path, { revision: 1, finishDate: null }, 409);
  const beforeClear = await page('&year=2020');
  await send('PATCH', path, { revision: 2, assessment: null });
  expect((await page('&year=2020&cursor=' + encodeURIComponent(beforeClear.next), 409)).code).toBe('stale_cursor');
  await send('PATCH', path, {
    revision: 3,
    finishDate: { year: 2021, month: 3, day: 4 },
  });
  expect((await summary()).monthUnallocated.completedOccurrences).toBe('0');
  expect((await summary(2021)).months[2].completedOccurrences).toBe('1');
  expect((await page('&year=2021&month=3')).occurrences[0]).toMatchObject({
    id: first.id,
    reportedDates: { revision: 4 },
    assessment: { meaningRevision: 1, units: null },
  });
  expect((await send('GET', repeatPath)).journal).toMatchObject({
    revision: 1,
    reflection: 'Repeat only',
    assessment: { units: 12 },
  });
  await native.activate(native.replacementDigest);
  expect(
    (await send('GET', `/v1/progressSessions/${first.id}?presentation=FULL`)).progressSession.presentation.meaning,
  ).toBe('known');
  await native.activate(native.originalDigest);
  await send('PATCH', path, { revision: 4, finishDate: null });
  expect((await summary(2021)).completedOccurrences).toBe('0');
  expect((await summary()).coverage.completedOccurrencesWithMissingFinish).toBe('1');
  expect(
    (
      await native.send('steward', 'POST', `/v1/subjects/${subjectId}:hide`, {
        reason: 'Private diary context',
      })
    ).status,
  ).toBe(200);
  expect((await page('&year=2020')).occurrences[0]).toMatchObject({
    id: repeat.id,
    subject: null,
    assessment: { units: 12 },
  });
  expect((await send('GET', path)).journal).toMatchObject({
    sessionId: first.id,
    revision: 5,
    reflection: null,
    finishDate: null,
    assessment: { units: null },
  });
}, 120_000);

test('eight native slots retain absolute expiry, original cancellation and indexed terminal cleanup', async () => {
  const { owner, start, send, page } = await journey();
  await start();
  await start();
  const handles = [];
  for (let i = 0; i < 8; i++) handles.push(await page());
  expect((await page('', 503)).code).toBe('overloaded');
  await send('POST', '/v1/libraryDiary:cancel', {
    continuation: handles[0].continuation,
  });
  const replacement = await page();
  await send('POST', '/v1/libraryDiary:cancel', {
    continuation: handles[0].continuation,
  });
  expect((await page('&cursor=' + encodeURIComponent(replacement.next))).occurrences).toHaveLength(1);
  now = new Date(now.getTime() + 14 * 60_000);
  expect((await page('&cursor=' + encodeURIComponent(replacement.next))).expiresAt).toBe(replacement.expiresAt);
  now = new Date(now.getTime() + 60_000);
  expect((await page('&cursor=' + encodeURIComponent(replacement.next), 409)).code).toBe('stale_cursor');
  await page(); // Reuse expired metadata without an age scan.
  await native.revokeIdentity(owner.actor.accountId);
  await page('', 401);
  const params = {
    route: routeOf(owner.actor.accountId)!,
    account_id: owner.actor.accountId,
  };
  expect((await eraseNavigation.run(native.pool, params)).length).toBeLessThanOrEqual(8);
  expect(await eraseNavigation.run(native.pool, params)).toEqual([]);
}, 120_000);

test('optional journal and assessment installation never turn unsupported history into a clear or a zero', async () => {
  const { start, send, page } = await journey();
  const recorded = await start();
  await send('POST', `/v1/progressSessions/${recorded.id}:complete`, {
    revision: 1,
  });
  await send('PATCH', `/v1/progressSessions/${recorded.id}/journal`, {
    revision: 0,
    finishDate: { year: 2020 },
    assessment: { units: 0 },
  });
  // Rename only in this disposable database; native effects and all derivation triggers remain installed.
  for (const column of ['journal_assessment_meaning_revision', 'journal_revision', 'journal_finish_year']) {
    await native.pool.query(
      `ALTER TABLE library.progress_session RENAME COLUMN ${column} TO unavailable_journal_column`,
    );
    try {
      const row = (await page()).occurrences[0];
      expect(row.id).toBe(recorded.id);
      if (column === 'journal_assessment_meaning_revision') {
        expect(row).not.toHaveProperty('assessment');
        expect(row.reportedDates.availability).toBe('available');
      } else {
        expect(row.reportedDates).toEqual({ availability: 'unavailable' });
        expect(row.assessment).toEqual({ meaningRevision: 1, units: 0 });
        expect((await page('&year=2020', 503)).code).toBe('dependency_unavailable');
      }
      expect((await send('GET', `/v1/progressSessions/${recorded.id}`)).progressSession.id).toBe(recorded.id);
    } finally {
      await native.pool.query(
        `ALTER TABLE library.progress_session RENAME COLUMN unavailable_journal_column TO ${column}`,
      );
    }
  }
  expect((await page('&year=2020')).occurrences[0].assessment).toEqual({
    meaningRevision: 1,
    units: 0,
  });
}, 120_000);
