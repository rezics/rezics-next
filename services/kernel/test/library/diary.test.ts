import { afterAll, beforeAll, expect, test } from 'bun:test';
import { accountToken } from '../support/admitted-access.ts';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import type { DiaryPage } from '../../src/library/diary-model.ts';
import { routeOf } from '../../src/route/route.ts';

const scopes = ['subject:read', 'progress_session:create', 'progress_session:read',
  'progress_session:list', 'progress_session:update'];
let native: NativeProfileFixture;
let owner: Awaited<ReturnType<NativeProfileFixture['identity']>>;
let other: typeof owner;
let now = new Date();

beforeAll(async () => {
  native = await createProfileEntryFixture({ clock: () => now, singleConnection: true, projectLinks: false });
  owner = await native.identity(scopes);
  other = await native.identity(scopes);
  expect((await native.send('steward', 'POST', '/v1/platform/exposure/reading_progress:open')).status).toBe(200);
}, 120_000);
afterAll(async () => { await native?.close(); });

async function json(response: Response, status = 200) {
  const body = await response.json();
  expect({ status: response.status, body }).toMatchObject({ status });
  return body;
}
const send = (method: string, path: string, body?: unknown, bearer = owner.bearer) =>
  native.send(bearer, method, path, body);
async function start(subjectId: string, bearer = owner.bearer) {
  return (await json(await send('POST', '/v1/progressSessions', {
    subjectId, mode: 'scalar_amount', unit: 'minute',
  }, bearer), 201)).progressSession;
}
async function page(cursor?: string, bearer = owner.bearer, limit = 2): Promise<DiaryPage> {
  const response = await send('GET', `/v1/libraryDiary?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    undefined, bearer);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  return json(response);
}
async function cancel(continuation: string, bearer = owner.bearer) {
  return json(await send('POST', '/v1/libraryDiary:cancel', { continuation }, bearer));
}

test('native owner pages across subjects and separate repeats, then reopens exact corrected occurrence', async () => {
  const a = await native.createSubject('game', 'First diary subject');
  const b = await native.createSubject('recipe', 'Second diary subject');
  const sessions = [];
  for (const subject of [a, b, a, b, a]) sessions.push(await start(subject));
  const completed = await json(await send('POST', `/v1/progressSessions/${sessions[0].id}:complete`, { revision: 1 }));
  expect(completed.progressSession.state).toBe('completed');
  await json(await send('POST', `/v1/progressSessions/${sessions[1].id}:abandon`, { revision: 1 }));
  // All five recordings share the same clock: the full native UUID is the descending tie break.
  const expected = sessions.map((item) => item.id).sort().reverse();
  const first = await page();
  const second = await page(first.next!);
  const third = await page(second.next!);
  expect(first.order).toBe('recorded_started_desc_id_desc');
  expect(first.next).toBeString();
  expect(second.next).toBeString();
  expect(third.next).toBeNull();
  const rows = [...first.occurrences, ...second.occurrences, ...third.occurrences];
  expect(rows.map((item) => item.id)).toEqual(expected);
  expect(rows.filter((item) => item.subjectId === a)).toHaveLength(3);
  expect(new Set(rows.map((item) => item.state))).toEqual(new Set(['active', 'completed', 'abandoned']));
  for (const row of rows) {
    expect(row.recordedStartedAt).toMatch(/\.\d{6}Z$/);
    expect(row.reportedDates).toEqual({ availability: 'unavailable' });
    expect(row.subject?.label).toBe(row.subjectId === a ? 'First diary subject' : 'Second diary subject');
    expect(row).not.toHaveProperty('startedAt');
    expect(row).not.toHaveProperty('libraryProfilePin');
  }
  const corrected = await json(await send('POST', `/v1/progressSessions/${sessions[2].id}:record`, {
    revision: 1, amount: '12',
  }));
  const detail = await json(await send('GET', `/v1/progressSessions/${sessions[2].id}?presentation=FULL&view=FULL`));
  expect(detail.progressSession).toMatchObject({
    id: sessions[2].id, revision: corrected.progressSession.revision, amount: '12',
    presentation: { meaning: 'known', structure: 'unverified' },
  });
  expect((await page()).occurrences.map((row) => row.id)).toEqual(expected.slice(0, 2));
  expect((await page(first.next!)).occurrences).toEqual((await page(first.next!)).occurrences);
  await cancel(first.continuation!);
});

test('native subject concealment withholds labels without hiding private occurrences or leaking them to others', async () => {
  const hidden = await native.createSubject('game', 'Concealed catalogue title');
  const recorded = await start(hidden);
  expect((await native.send('steward', 'POST', `/v1/subjects/${hidden}:hide`, { reason: 'Diary privacy scenario' })).status)
    .toBe(200);
  const result = await page(undefined, owner.bearer, 25);
  expect(result.occurrences.find((row) => row.id === recorded.id)).toMatchObject({ subjectId: hidden, subject: null });
  expect(JSON.stringify(result)).not.toContain('Concealed catalogue title');
  expect((await page(undefined, other.bearer)).occurrences).toEqual([]);
  await json(await send('GET', `/v1/progressSessions/${recorded.id}?presentation=FULL`, undefined, other.bearer), 404);
  await json(await native.send('anonymous', 'GET', '/v1/libraryDiary'), 401);
  const reduced = await accountToken({ accountId: owner.actor.accountId, clientId: owner.actor.clientId,
    scopes: ['subject:read'] });
  await json(await send('GET', '/v1/libraryDiary', undefined, reduced), 403);
});

test('continuations bind caller and page size; cancellation retires native state and is idempotent', async () => {
  const first = await page();
  const cursor = encodeURIComponent(first.next!);
  const changedClient = await accountToken({ accountId: owner.actor.accountId, clientId: 'different-diary-client', scopes });
  for (const bearer of [other.bearer, changedClient]) {
    expect((await json(await send('GET', `/v1/libraryDiary?limit=2&cursor=${cursor}`, undefined, bearer), 400)).code)
      .toBe('invalid_cursor');
  }
  expect((await json(await send('GET', `/v1/libraryDiary?limit=3&cursor=${cursor}`), 400)).code).toBe('invalid_cursor');
  expect((await json(await send('GET', '/v1/libraryDiary?sort=reportedDate'), 400)).code).toBe('invalid_request');
  await cancel(first.continuation!);
  await cancel(first.continuation!);
  expect((await json(await send('GET', `/v1/libraryDiary?limit=2&cursor=${cursor}`), 409)).code).toBe('stale_cursor');
  const persisted = await native.pool.query(
    'SELECT navigation_id FROM library.diary_navigation WHERE route=$1 AND account_id=$2',
    [routeOf(owner.actor.accountId), owner.actor.accountId]);
  expect(persisted.rows.length).toBeLessThanOrEqual(8);
});

test('deleted anchors remain seekable; missing occurrences return 404 and expiration requires a fresh first page', async () => {
  const identity = await native.identity(scopes);
  const subject = await native.createSubject('game');
  for (let i = 0; i < 4; i++) await start(subject, identity.bearer);
  const first = await page(undefined, identity.bearer);
  const anchor = first.occurrences.at(-1)!;
  // Exercise the installed native session retirement boundary, without introducing a diary fact writer.
  // These real sessions have no progress children, so child-before-parent retirement is already satisfied.
  await native.pool.query('DELETE FROM library.progress_session WHERE route=$1 AND session_id=$2',
    [routeOf(identity.actor.accountId), anchor.id]);
  await json(await send('GET', `/v1/progressSessions/${anchor.id}?presentation=FULL`, undefined, identity.bearer), 404);
  expect((await page(first.next!, identity.bearer)).occurrences.every((row) => row.id !== anchor.id)).toBe(true);
  now = new Date(now.getTime() + 16 * 60_000);
  expect((await json(await send('GET', `/v1/libraryDiary?limit=2&cursor=${encodeURIComponent(first.next!)}`,
    undefined, identity.bearer), 409)).code)
    .toBe('stale_cursor');
  await cancel(first.continuation!, identity.bearer);
  const fresh = await page(undefined, identity.bearer);
  expect(fresh.occurrences.length).toBe(2);
  await cancel(fresh.continuation!, identity.bearer);
});

test('native identity fencing rejects retained navigation and occurrence reopening', async () => {
  const identity = await native.identity(scopes);
  const subject = await native.createSubject('game');
  const sessions = [await start(subject, identity.bearer), await start(subject, identity.bearer)];
  const first = await page(undefined, identity.bearer, 1);
  await native.revokeIdentity(identity.actor.accountId);
  await json(await send('GET', `/v1/libraryDiary?limit=1&cursor=${encodeURIComponent(first.next!)}`,
    undefined, identity.bearer), 401);
  await json(await send('GET', `/v1/progressSessions/${sessions[0].id}?presentation=FULL`, undefined, identity.bearer), 401);
});
