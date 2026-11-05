import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import { accountToken } from '../support/admitted-access.ts';
import { createProfileEntryFixture, type NativeProfileFixture } from './support/profile-entry-fixture.ts';
import type { DiaryPage } from '../../src/library/diary-model.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';

const scopes = [
  'subject:read',
  'progress_session:create',
  'progress_session:read',
  'progress_session:list',
  'progress_session:update',
];
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
afterAll(async () => {
  await native?.close();
});

async function json(response: Response, status = 200) {
  const body = await response.json();
  expect({ status: response.status, body }).toMatchObject({ status });
  return body;
}
const send = (method: string, path: string, body?: unknown, bearer = owner.bearer) =>
  native.send(bearer, method, path, body);
async function start(subjectId: string, bearer = owner.bearer) {
  return (
    await json(
      await send(
        'POST',
        '/v1/progressSessions',
        {
          subjectId,
          mode: 'scalar_amount',
          unit: 'minute',
        },
        bearer,
      ),
      201,
    )
  ).progressSession;
}
async function page(cursor?: string, bearer = owner.bearer, limit = 2): Promise<DiaryPage> {
  const response = await send(
    'GET',
    `/v1/libraryDiary?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    undefined,
    bearer,
  );
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
  const expected = sessions
    .map((item) => item.id)
    .sort()
    .reverse();
  const datedId = expected.at(-1)!;
  await json(
    await send('PATCH', `/v1/progressSessions/${datedId}/journal`, {
      revision: 0,
      startDate: { year: 1999 },
      finishDate: { year: 2000, month: 2 },
      reflection: 'Private detail only',
    }),
  );
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
    expect(row.assessment).toEqual({ meaningRevision: 1, units: null });
    expect(row.reportedDates).toEqual(
      row.id === datedId
        ? { availability: 'available', revision: 1, startDate: { year: 1999 }, finishDate: { year: 2000, month: 2 } }
        : { availability: 'available', revision: 0, startDate: null, finishDate: null },
    );
    expect(row.subject?.label).toBe(row.subjectId === a ? 'First diary subject' : 'Second diary subject');
    expect(row).not.toHaveProperty('startedAt');
    expect(row).not.toHaveProperty('libraryProfilePin');
  }
  expect(JSON.stringify(rows)).not.toContain('Private detail only');
  await json(
    await send('PATCH', `/v1/progressSessions/${datedId}/journal`, {
      revision: 1,
      startDate: { year: 1998, month: 4, day: 3 },
      finishDate: null,
    }),
  );
  const correctedDates = await page(second.next!);
  expect(correctedDates.occurrences.map((row) => row.id)).toEqual([datedId]);
  expect(correctedDates.occurrences[0]!.reportedDates).toEqual({
    availability: 'available',
    revision: 2,
    startDate: { year: 1998, month: 4, day: 3 },
    finishDate: null,
  });
  expect((await json(await send('GET', `/v1/progressSessions/${datedId}/journal`))).journal).toMatchObject({
    revision: 2,
    startDate: { year: 1998, month: 4, day: 3 },
    finishDate: null,
  });
  const corrected = await json(
    await send('POST', `/v1/progressSessions/${sessions[2].id}:record`, {
      revision: 1,
      amount: '12',
    }),
  );
  const detail = await json(await send('GET', `/v1/progressSessions/${sessions[2].id}?presentation=FULL&view=FULL`));
  expect(detail.progressSession).toMatchObject({
    id: sessions[2].id,
    revision: corrected.progressSession.revision,
    amount: '12',
    presentation: { meaning: 'known', structure: 'unverified' },
  });
  expect((await page()).occurrences.map((row) => row.id)).toEqual(expected.slice(0, 2));
  expect((await page(first.next!)).occurrences).toEqual((await page(first.next!)).occurrences);
  await cancel(first.continuation!);
});

test('repeated completed occurrences keep zero and cleared assessments independently', async () => {
  const subject = await native.createSubject('game', 'Assessment subject');
  const zero = await start(subject);
  const cleared = await start(subject);
  for (const occurrence of [zero, cleared])
    await json(await send('POST', `/v1/progressSessions/${occurrence.id}:complete`, { revision: 1 }));
  const before = await Promise.all(
    [zero, cleared].map(
      async (occurrence) => (await json(await send('GET', `/v1/progressSessions/${occurrence.id}`))).progressSession,
    ),
  );

  const zeroPath = `/v1/progressSessions/${zero.id}/journal`;
  const zeroPatch = { revision: 0, assessment: { units: 0 } };
  const zeroWrite = await json(await native.send('owner', 'PATCH', zeroPath, zeroPatch, 'assessment-zero'));
  expect(await json(await native.send('owner', 'PATCH', zeroPath, zeroPatch, 'assessment-zero'))).toEqual(zeroWrite);
  await json(await native.send('owner', 'PATCH', zeroPath, { revision: 0, assessment: { units: 8 } }), 409);
  await json(
    await send('PATCH', `/v1/progressSessions/${zero.id}/journal`, { revision: 0, assessment: null }, other.bearer),
    404,
  );

  const clearedPath = `/v1/progressSessions/${cleared.id}/journal`;
  await json(await send('PATCH', clearedPath, { revision: 0, assessment: { units: 12 } }));
  await json(await send('PATCH', clearedPath, { revision: 1, reflection: 'Private assessment note.' }));
  await json(await send('PATCH', clearedPath, { revision: 2, assessment: null }));
  const zeroJournal = (await json(await send('GET', zeroPath))).journal;
  const clearedJournal = (await json(await send('GET', clearedPath))).journal;
  expect(zeroJournal).toMatchObject({ revision: 1, assessment: { meaningRevision: 1, units: 0 } });
  expect(clearedJournal).toMatchObject({ revision: 3, assessment: { meaningRevision: 1, units: null } });
  const diary = await page(undefined, owner.bearer, 25);
  expect(diary.occurrences.find((row) => row.id === zero.id)?.assessment).toEqual(zeroJournal.assessment);
  expect(diary.occurrences.find((row) => row.id === cleared.id)?.assessment).toEqual(clearedJournal.assessment);
  expect(JSON.stringify(diary)).not.toContain('Private assessment note.');
  if (diary.continuation) await cancel(diary.continuation);

  const after = await Promise.all(
    [zero, cleared].map(
      async (occurrence) => (await json(await send('GET', `/v1/progressSessions/${occurrence.id}`))).progressSession,
    ),
  );
  for (let index = 0; index < before.length; index++)
    expect(after[index]).toMatchObject({
      revision: before[index]!.revision,
      state: 'completed',
      completedAt: before[index]!.completedAt,
      completedUnitCount: before[index]!.completedUnitCount,
    });
});

test('native subject concealment withholds labels without hiding private occurrences or leaking them to others', async () => {
  const hidden = await native.createSubject('game', 'Concealed catalogue title');
  const recorded = await start(hidden);
  expect((await page(undefined, other.bearer)).occurrences).toEqual([]);
  await json(await send('GET', `/v1/progressSessions/${recorded.id}?presentation=FULL`, undefined, other.bearer), 404);
  await json(await native.send('anonymous', 'GET', '/v1/libraryDiary'), 401);
  const reduced = await accountToken({
    accountId: owner.actor.accountId,
    clientId: owner.actor.clientId,
    scopes: ['subject:read'],
  });
  await json(await send('GET', '/v1/libraryDiary', undefined, reduced), 403);
  const privateOnly = await accountToken({
    accountId: owner.actor.accountId,
    clientId: owner.actor.clientId,
    scopes: ['progress_session:list'],
  });
  // Native public visibility admits this label even without a subject client scope.
  const publicLabels = await page(undefined, privateOnly, 25);
  expect(publicLabels.occurrences.find((row) => row.id === recorded.id)?.subject?.label).toBe(
    'Concealed catalogue title',
  );
  expect(
    (await native.send('steward', 'POST', `/v1/subjects/${hidden}:hide`, { reason: 'Diary privacy scenario' })).status,
  ).toBe(200);
  const result = await page(undefined, owner.bearer, 25);
  expect(result.occurrences.find((row) => row.id === recorded.id)).toMatchObject({ subjectId: hidden, subject: null });
  expect(JSON.stringify(result)).not.toContain('Concealed catalogue title');
});

test('continuations bind caller and page size; cancellation retires native state and is idempotent', async () => {
  const first = await page();
  const cursor = encodeURIComponent(first.next!);
  const changedClient = await accountToken({
    accountId: owner.actor.accountId,
    clientId: 'different-diary-client',
    scopes,
  });
  for (const bearer of [other.bearer, changedClient]) {
    expect(
      (await json(await send('GET', `/v1/libraryDiary?limit=2&cursor=${cursor}`, undefined, bearer), 400)).code,
    ).toBe('invalid_cursor');
  }
  expect((await json(await send('GET', `/v1/libraryDiary?limit=3&cursor=${cursor}`), 400)).code).toBe('invalid_cursor');
  expect((await json(await send('GET', '/v1/libraryDiary?sort=reportedDate'), 400)).code).toBe('invalid_request');
  await cancel(first.continuation!);
  await cancel(first.continuation!);
  expect((await json(await send('GET', `/v1/libraryDiary?limit=2&cursor=${cursor}`), 409)).code).toBe('stale_cursor');
  const persisted = await native.pool.query(
    'SELECT navigation_id FROM library.diary_navigation WHERE route=$1 AND account_id=$2',
    [routeOf(owner.actor.accountId), owner.actor.accountId],
  );
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
  await native.pool.query('DELETE FROM library.progress_session WHERE route=$1 AND session_id=$2', [
    routeOf(identity.actor.accountId),
    anchor.id,
  ]);
  await json(await send('GET', `/v1/progressSessions/${anchor.id}?presentation=FULL`, undefined, identity.bearer), 404);
  expect((await page(first.next!, identity.bearer)).occurrences.every((row) => row.id !== anchor.id)).toBe(true);
  now = new Date(now.getTime() + 16 * 60_000);
  expect(
    (
      await json(
        await send(
          'GET',
          `/v1/libraryDiary?limit=2&cursor=${encodeURIComponent(first.next!)}`,
          undefined,
          identity.bearer,
        ),
        409,
      )
    ).code,
  ).toBe('stale_cursor');
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
  await json(
    await send('GET', `/v1/libraryDiary?limit=1&cursor=${encodeURIComponent(first.next!)}`, undefined, identity.bearer),
    401,
  );
  await json(
    await send('GET', `/v1/progressSessions/${sessions[0].id}?presentation=FULL`, undefined, identity.bearer),
    401,
  );
});

test('reported year and explicit buckets page exact completed IDs and reject changed membership', async () => {
  const identity = await native.identity(scopes);
  const a = await native.createSubject('game', 'Year repeat');
  const b = await native.createSubject('recipe', 'Year independent');
  const dated: string[] = [];
  for (const [subjectId, finishDate] of [
    [a, { year: 2020, month: 2, day: 29 }],
    [a, { year: 2020, month: 2 }],
    [b, { year: 2020, month: 3 }],
    [b, { year: 2020 }],
    [a, null],
  ] as const) {
    const session = await start(subjectId, identity.bearer);
    if (typeof session.id !== 'string') throw new Error('Progress session is missing its native ID');
    if (finishDate)
      await json(
        await send('PATCH', `/v1/progressSessions/${session.id}/journal`, { revision: 0, finishDate }, identity.bearer),
      );
    await json(await send('POST', `/v1/progressSessions/${session.id}:complete`, { revision: 1 }, identity.bearer));
    dated.push(session.id);
  }
  const active = await start(a, identity.bearer);
  await json(
    await send(
      'PATCH',
      `/v1/progressSessions/${active.id}/journal`,
      { revision: 0, finishDate: { year: 2020, month: 2 } },
      identity.bearer,
    ),
  );
  const client = createKernelClient('http://kernel.test', {
    fetch: (async (input, init) => {
      const request = new Request(input, init),
        url = new URL(request.url);
      return native.send(
        identity.bearer,
        request.method,
        url.pathname + url.search,
        request.method === 'POST' ? await request.json() : undefined,
      );
    }) as typeof fetch,
  });
  const open = async (month?: number | 'unallocated', cursor?: string) => {
    const result = await client.libraryDiary.get({
      query: {
        year: 2020,
        limit: 1,
        ...(month === undefined ? {} : { month }),
        ...(cursor === undefined ? {} : { cursor }),
      },
    });
    expect(result.error).toBeNull();
    return result.data!;
  };
  const summary = async () =>
    await json(await send('GET', '/v1/libraryReportedYearSummary?year=2020', undefined, identity.bearer));
  const totals = await summary();
  expect(totals).toMatchObject({ completedOccurrences: '4', distinctCompletedSubjects: '2', repeatOccurrences: '2' });
  const februarySecond = dated[2];
  const march = dated[3];
  if (!februarySecond || !march) throw new Error('The expected dated progress sessions are missing');
  for (const [month, expected] of [
    [undefined, dated.slice(0, 4)],
    [2, dated.slice(0, 2)],
    [3, [februarySecond]],
    ['unallocated', [march]],
    [1, []],
  ] as const) {
    let value = await open(month);
    const first = value;
    const ids = value.occurrences.map((row) => {
      if (row.id === undefined) throw new Error('Diary occurrence is missing its native ID');
      return row.id;
    });
    expect(value.currentness).toEqual(totals.currentness);
    while (value.next) {
      value = await open(month, value.next);
      ids.push(
        ...value.occurrences.map((row) => {
          if (row.id === undefined) throw new Error('Diary occurrence is missing its native ID');
          return row.id;
        }),
      );
    }
    expect(ids).toEqual([...expected].sort().reverse());
    if (first.continuation) {
      const continuation = value.continuation;
      const cursor = first.next;
      if (!continuation || !cursor) throw new Error('The next diary page is missing its continuation');
      expect(continuation).toBeString();
      expect((await client.libraryDiary.$cancel.post({ continuation })).error).toBeNull();
      const stale = await client.libraryDiary.get({
        query: { year: 2020, ...(month === undefined ? {} : { month }), limit: 1, cursor },
      });
      expect(stale.error?.status).toBe(409);
    }
  }
  const first = await open(2);
  for (const query of [{ year: 2020, month: 3 }, { year: 2021, month: 2 }, {}]) {
    const changed = await client.libraryDiary.get({
      query: {
        limit: 1,
        cursor: first.next!,
        ...(query.year === undefined ? {} : { year: query.year }),
        ...(query.month === undefined ? {} : { month: query.month }),
      },
    });
    expect(changed.error?.status).toBe(400);
  }
  const exact = await json(
    await send('GET', `/v1/progressSessions/${dated[0]}?presentation=FULL&view=FULL`, undefined, identity.bearer),
  );
  expect(exact.progressSession.id).toBe(dated[0]);
  await json(
    await send(
      'PATCH',
      `/v1/progressSessions/${dated[0]}/journal`,
      { revision: 1, finishDate: { year: 2020, month: 3 } },
      identity.bearer,
    ),
  );
  expect(
    (await client.libraryDiary.get({ query: { year: 2020, month: 2, limit: 1, cursor: first.next! } })).error?.status,
  ).toBe(409);
  expect((await open(2)).occurrences.map((row) => row.id)).toEqual([dated[1]!]);
  const beforeRetire = await open();
  await native.pool.query("UPDATE library.progress_session SET state='retired' WHERE route=$1 AND session_id=$2", [
    routeOf(identity.actor.accountId),
    dated[1],
  ]);
  expect(
    (await client.libraryDiary.get({ query: { year: 2020, limit: 1, cursor: beforeRetire.next! } })).error?.status,
  ).toBe(409);
  expect((await open(2)).occurrences).toEqual([]);
  expect((await summary()).completedOccurrences).toBe('3');
  for (const query of ['month=2', 'year=0', 'year=2020&month=0', 'year=2020&month=13', 'year=2020&month=2&month=3'])
    await json(await send('GET', `/v1/libraryDiary?${query}`, undefined, identity.bearer), 400);
});

test('unavailable native authority refuses new pages, retained continuation and addressed reopening', async () => {
  const identity = await native.identity(scopes);
  const subject = await native.createSubject('game');
  const recorded = await start(subject, identity.bearer);
  await start(subject, identity.bearer);
  const first = await page(undefined, identity.bearer, 1);
  const partition = partitionOf(routeOf(identity.actor.accountId)!);
  await native.pool.query("UPDATE core.partition SET write_state='fenced' WHERE partition_no=$1", [partition]);
  // This final scenario owns the disposable database. Reactivation belongs to native
  // lineage reconciliation; leave its fence in place until the fixture is dropped.
  await json(await send('GET', '/v1/libraryDiary', undefined, identity.bearer), 503);
  await json(
    await send('GET', `/v1/libraryDiary?limit=1&cursor=${encodeURIComponent(first.next!)}`, undefined, identity.bearer),
    503,
  );
  await json(
    await send('GET', `/v1/progressSessions/${recorded.id}?presentation=FULL`, undefined, identity.bearer),
    503,
  );
});
