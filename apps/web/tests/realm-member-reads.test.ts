import { afterEach, expect, spyOn, test } from 'bun:test';
import { pageRequest } from '../features/entity-page/request-fixture.ts';
import { readRealm as readWorkRealm } from '../features/work-page/read.ts';
import {
  readLatestChapters, readNewAdoptions, readPresentation, readRankings, readRealmDecision,
  readRealmDecisions, readRealmWorks, readRecentDecisions, readRecentlyCompleted, readRising,
  readRoster, readZoneBrowse, readZoneDiscussions, readZoneEditorLists, readZoneGenres,
  readZoneQuotes, readZoneRoute,
} from '../features/realm/read.ts';

const realm = '00000000-0000-4000-8000-000000000001';
const decision = '00000000-0000-4000-8000-000000000002';
const member = 'https://rezics.com/id/00000000-0000-4000-8000-000000000003';
const other = 'https://rezics.com/id/00000000-0000-4000-8000-000000000004';
const origin = process.env.MAIN_ORIGIN;
let restore = () => {};
afterEach(() => {
  restore();
  if (origin === undefined) delete process.env.MAIN_ORIGIN;
  else process.env.MAIN_ORIGIN = origin;
});

type Reader = 'member' | 'anonymous' | 'nonmember' | 'expired' | 'revoked' | 'unselected' | 'ineligible';
function mainDouble(initial: Reader) {
  process.env.MAIN_ORIGIN = 'http://realm-reader.test';
  let reader = initial;
  let moved = false;
  let failures = 0;
  const calls: { url: URL; authorization: string | null }[] = [];
  const fetch = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const authorization = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      .get('authorization');
    if (url.pathname === '/v1/me/session-agent') {
      if (reader === 'expired') return Response.json({ code: 'expired' }, { status: 401 });
      return Response.json({
        sessionAgent: { eligible: reader !== 'ineligible', actingSubject: reader === 'unselected' ? null
          : reader === 'nonmember' ? other : member, revision: decision },
        // Initialization and the main preference must never substitute for a saved selection.
        mainAgent: { eligible: true, actingSubject: member, revision: decision },
        initialActingSubject: member,
      });
    }
    if (url.pathname === '/v1/me/person-preferences') return Response.json({ contentLanguages: ['en'] });
    calls.push({ url, authorization });
    if (moved && failures++ === 0) return Response.json({ code: 'read_basis_changed' }, { status: 409 });
    return reader === 'member' && authorization === 'Bearer reader-token'
      && url.searchParams.get('actingSubject') === member
      ? Response.json({ profile: 'member-readable', items: [{ id: decision }] })
      : Response.json({ code: 'realm_unavailable' }, { status: 404 });
  }) as typeof globalThis.fetch);
  restore = () => fetch.mockRestore();
  return { calls, as: (value: Reader) => { reader = value; }, move: () => { moved = true; } };
}

/** Every adapter retains the owner's concealed answer alongside the same absence category. */
function expectConcealed(results: readonly object[]) {
  expect(results).toHaveLength(memberReads.length);
  for (const result of results) {
    const { status, problem, ...answer } = result as { status?: number; problem?: unknown };
    expect(answer).toEqual({ ok: false, failure: 'missing' });
    expect({ status, problem }).toEqual({ status: 404, problem: { code: 'realm_unavailable' } });
  }
}

const memberReads = [
  { path: `/v1/realms/${realm}`, read: () => readWorkRealm(realm, 'en') },
  { path: `/v1/realms/${realm}/works`, read: (cursor?: string) => readRealmWorks(realm, 'en', cursor) },
  { path: `/v1/realms/${realm}/decisions`, read: (cursor?: string) => readRealmDecisions(realm, cursor) },
  { path: `/v1/realms/${realm}/decisions/${decision}`, read: () => readRealmDecision(realm, decision) },
  { path: `/v1/zones/${realm}/presentation`, read: (after?: string) => readPresentation(realm, after) },
  { path: `/v1/zones/${realm}/routes`, read: (cursor?: string) => readZoneRoute(realm, 'books', cursor) },
];

test('a non-owner member carries the saved Agent and bearer through every member-readable Realm adapter', async () => {
  const main = mainDouble('member');
  const results = await pageRequest(() => Promise.all(memberReads.map(({ read }) => read())), { signedIn: true });
  expect(results.every(result => result.ok)).toBe(true);
  expect(main.calls.map(call => call.url.pathname)).toEqual(memberReads.map(read => read.path));
  for (const call of main.calls) {
    expect(call.authorization).toBe('Bearer reader-token');
    expect(call.url.searchParams.get('actingSubject')).toBe(member);
  }
});

for (const reader of ['anonymous', 'nonmember', 'expired', 'revoked', 'unselected', 'ineligible'] as const) {
  test(`${reader} receives the owner's concealed answer on every member-readable adapter`, async () => {
    const main = mainDouble(reader);
    const results = await pageRequest(() => Promise.all(memberReads.map(({ read }) => read())),
      { signedIn: reader !== 'anonymous' });
    expectConcealed(results);
    for (const call of main.calls) {
      const subject = reader === 'nonmember' ? other : reader === 'revoked' ? member : null;
      expect(call.url.searchParams.get('actingSubject')).toBe(subject);
      expect(call.authorization).toBe(subject ? 'Bearer reader-token' : null);
    }
  });
}

test('the same Realm and decision keys in a later request cannot reuse a previous member answer', async () => {
  const main = mainDouble('member');
  const read = () => Promise.all(memberReads.map(({ read }) => read()));
  expect((await pageRequest(read, { signedIn: true })).every(result => result.ok)).toBe(true);
  main.as('nonmember');
  expectConcealed(await pageRequest(read, { signedIn: true }));
  main.as('anonymous');
  expectConcealed(await pageRequest(read));
});

test('first-page retry and continuation preserve the reader and exact continuation parameter', async () => {
  const main = mainDouble('member');
  main.move();
  expect((await pageRequest(() => readRealmDecisions(realm), { signedIn: true })).ok).toBe(true);
  expect(main.calls).toHaveLength(2);
  const results = await pageRequest(() => Promise.all(memberReads.map(({ read }) => read('next-page'))), { signedIn: true });
  expect(results.every(result => result.ok)).toBe(true);
  expect(main.calls[2]!.url.searchParams.has('cursor')).toBe(false);
  expect(main.calls[3]!.url.searchParams.get('cursor')).toBe('next-page');
  expect(main.calls[4]!.url.searchParams.get('cursor')).toBe('next-page');
  expect(main.calls[5]!.url.searchParams.has('cursor')).toBe(false);
  expect(main.calls[6]!.url.searchParams.get('after')).toBe('next-page');
  expect(main.calls[7]!.url.searchParams.get('cursor')).toBe('next-page');
  expect(main.calls[7]!.url.searchParams.get('path')).toBe('books');
  expect(main.calls.every(call => call.authorization === 'Bearer reader-token'
    && call.url.searchParams.get('actingSubject') === member)).toBe(true);
});

test('rankings, rising, published modules and the public roster retain the anonymous viewer', async () => {
  const main = mainDouble('member');
  await pageRequest(() => Promise.all([
    readRankings(realm, 'en', 'week', 'reads'), readRising(realm, 'en'),
    readNewAdoptions(realm, 'en'), readRecentlyCompleted(realm, 'en'), readLatestChapters(realm, 'en'),
    readRecentDecisions(realm), readZoneQuotes(realm, 'en'), readZoneDiscussions(realm, 'en'),
    readZoneEditorLists(realm, 'en'), readZoneGenres(realm, decision, 'en'),
    readZoneBrowse(realm, 'en', {}), readRoster(realm),
  ]), { signedIn: true });
  expect(main.calls).toHaveLength(12);
  expect(main.calls.every(call => call.authorization === null && !call.url.searchParams.has('actingSubject'))).toBe(true);
});
