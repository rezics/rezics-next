import { expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../src/modules/access/admission.ts';
import { assertReplyBoardAuthority, readReplyBoards, replyBoards, replyBoardsGuard }
  from '../src/modules/realm-reply/boards.ts';
import { RealmReplyDenied, RealmReplyInvalid, RealmReplyUnavailable } from '../src/modules/realm-reply/content-store.ts';
import { readRealmThreads } from '../src/modules/realm-reply/thread-read.ts';
import { WorkReadInvalid, WorkReadMissing, type ReadRow } from '../src/modules/work/read-session.ts';
import type { WorkActivationEnvironment } from '../src/modules/work/activate.ts';
import { realm, reply, world } from './realm-reply-threads.test.ts';
import { realmReplyRoutes } from '../src/routes/realm-replies.ts';
import type { MainWorkDependencies } from '../src/routes/dependencies.ts';
import { AccountAssertionDenied } from '../src/modules/account/verify-assertion.ts';

const news = reply(800), empty = reply(801), actor = reply(802), author = reply(803);
const principal = { issuer: 'account', subject: 'reader' } as VerifiedPrincipal;
const noBoards = { concepts: [], primaryConcept: null };

test('a valid board placement reaches signed-out authentication instead of schema rejection', async () => {
  let verified = 0;
  const app = realmReplyRoutes({ account: { verify: async () => {
    verified++; throw new AccountAssertionDenied();
  } } } as unknown as MainWorkDependencies);
  const response = await app.handle(new Request('http://localhost/v1/realm-reply-placements', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'board-auth' },
    body: JSON.stringify({ profile: 'realm-reply-placement-v1', realm, reply: reply(1),
      revisionId: '00000000-0000-4000-8000-000000000001', revisionDigest: 'a'.repeat(64),
      expectedHead: reply(900), reviewDecisionId: null, actingSubject: actor,
      concepts: [news, empty], primaryConcept: news }),
  }));
  expect(response.status, await response.text()).toBe(401);
  expect(verified).toBe(1);
});

test('board selections preserve omission, explicit clearing, two Concepts and primary membership', () => {
  expect(replyBoards({})).toBeUndefined();
  expect(replyBoards(noBoards)).toEqual(noBoards);
  expect(replyBoards({ concepts: [news, empty], primaryConcept: news }))
    .toEqual({ concepts: [news, empty], primaryConcept: news });
  for (const value of [{ concepts: [news, news] }, { concepts: [news], primaryConcept: empty },
    { primaryConcept: news }, { concepts: ['urn:invalid'] }, { concepts: Array(9).fill(news) }])
    expect(() => replyBoards(value)).toThrow(RealmReplyInvalid);
  const guard = replyBoardsGuard(realm, { concepts: [news, empty], primaryConcept: news });
  expect(guard).toContain('?board0Scheme');
  expect(guard).toContain('?board1Scheme');
  expect(guard).toContain('rv:conceptState rv:Retired');
  expect(guard).toContain('rv:protectionHead');
});

test('placement board reads retain multiple Concepts and reject ambiguous or missing evidence', async () => {
  const uri = (value: string) => ({ type: 'uri', value });
  let rows: ReadRow[] = [{ concept: uri(news), primary: uri(news) }, { concept: uri(empty), primary: uri(news) }];
  const env = { fuseki: { query: async (query: string) => {
    expect(query).toContain('LIMIT 9');
    return { results: { bindings: rows } };
  } } } as unknown as WorkActivationEnvironment;
  expect(await readReplyBoards(env, reply(900))).toEqual({ concepts: [news, empty], primaryConcept: news });
  rows = [{}];
  expect(await readReplyBoards(env, reply(900))).toEqual(noBoards);
  for (const invalid of [[], [{ primary: uri(news) }],
    [{ concept: uri(news), primary: uri(news) }, { concept: uri(empty), primary: uri(empty) }]]) {
    rows = invalid;
    await expect(readReplyBoards(env, reply(900))).rejects.toBeInstanceOf(RealmReplyUnavailable);
  }
});

function grants(scopes: string[]) {
  const seen: string[] = [];
  const client = { query: async (sql: string, args: unknown[]) => {
    expect(sql).toContain('FOR SHARE');
    if (sql.includes('SELECT 1 FROM access.scope_gate')) return { rows: [{}], rowCount: 1 };
    const scope = String(args[3]); seen.push(scope);
    return { rows: scopes.includes(scope) ? [{ grantId: 'grant' }] : [] };
  } } as unknown as PoolClient;
  return { client, seen };
}

test('authors manage their own placements; membership and operator status grant no control of other authors', async () => {
  const { client, seen } = grants([]);
  await assertReplyBoardAuthority(client, principal, realm, author, author, true, noBoards,
    { concepts: [news], primaryConcept: null });
  expect(seen).toEqual([]);
  for (const member of [false, true])
    await expect(assertReplyBoardAuthority(client, principal, realm, actor, author, member, noBoards,
      { concepts: [news], primaryConcept: null })).rejects.toBeInstanceOf(RealmReplyDenied);
});

test('Realm managers can edit boards; Concept mandates must cover additions and removals', async () => {
  const scope = `publication:adopt:${realm}`;
  const previous = { concepts: [empty], primaryConcept: null }, next = { concepts: [news], primaryConcept: news };
  const wide = grants([scope]);
  await assertReplyBoardAuthority(wide.client, principal, realm, actor, author, false, previous, next);
  const newsOnly = grants([`${scope}:concept:${news}`]);
  await expect(assertReplyBoardAuthority(newsOnly.client, principal, realm, actor, author, true, previous, next))
    .rejects.toBeInstanceOf(RealmReplyDenied);
  expect(newsOnly.seen).toContain(`${scope}:concept:${empty}`);
  const scoped = grants([`${scope}:concept:${news}`, `${scope}:concept:${empty}`]);
  await assertReplyBoardAuthority(scoped.client, principal, realm, actor, author, false, previous, next);
  await expect(assertReplyBoardAuthority(grants([]).client, principal, realm, actor, author, false,
    noBoards, noBoards)).rejects.toBeInstanceOf(RealmReplyDenied);
});

function boardWorld(options: { retired?: boolean; hidden?: boolean } = {}) {
  const fixture = world([{ id: 1, author: 1 }, { id: 2, author: 1, approved: false },
    { id: 3, author: 1 }, { id: 4, author: 1 }]);
  const { session } = fixture, original = session.query.bind(session);
  Object.assign(session, { disclosure: async (targets: unknown[]) => targets.map(() => options.hidden ? 'hidden' : 'visible') });
  session.query = async (query, limit) => {
    if (query.includes('SELECT ?concept ?head')) {
      expect(limit).toBe(2);
      expect(query).toContain('rv:conceptState rv:Retired');
      const selected = query.match(/BIND\(<([^>]+)> AS \?concept\)/)![1]!;
      return options.retired ? [] : [{ concept: { type: 'uri', value: selected }, head: { type: 'uri', value: reply(901) } }];
    }
    let rows = await original(query, limit);
    if (query.includes('SELECT DISTINCT ?id ?reply ?work')) {
      if (query.includes(`?id rv:concept <${empty}>`)) rows = [];
      if (query.includes(`?id rv:concept <${news}>`)) rows = rows.filter(row =>
        [reply(1), reply(2)].includes(row.reply!.value));
      const after = query.match(/\?sequence < (\d+)/);
      if (after) rows = rows.filter(row => Number(row.sequence!.value) < Number(after[1]));
      rows = rows.slice(0, limit);
    }
    return rows;
  };
  return fixture;
}

test('New board pages seek matching placements before the bound and exclude unapproved replies from counts', async () => {
  const { session } = boardWorld();
  const first = await readRealmThreads(session, realm, { concept: news, sort: 'new', limit: 1 });
  expect(first.items).toEqual([]); // The newest matching placement lost its approval.
  expect(first.count.value).toBe(0);
  expect(first.nextCursor).toBeString();
  const second = await readRealmThreads(session, realm, { concept: news, sort: 'new', limit: 1, cursor: first.nextCursor! });
  expect(second.items.map(item => item.reply)).toEqual([reply(1)]);
  expect(second.count.value).toBe(1);
  expect(second.nextCursor).toBeNull();
  const emptyPage = await readRealmThreads(session, realm, { concept: empty, sort: 'new', limit: 1 });
  expect(emptyPage.items).toEqual([]);
  expect(emptyPage.count.value).toBe(0);
  expect(emptyPage.nextCursor).toBeNull();
});

test('a thread continuation cannot enter another board or leave its board', async () => {
  const { session } = boardWorld();
  const unfiltered = await readRealmThreads(session, realm, { sort: 'new', limit: 1 });
  await expect(readRealmThreads(session, realm, { sort: 'new', concept: news, cursor: unfiltered.nextCursor! }))
    .rejects.toBeInstanceOf(WorkReadInvalid);
  const board = await readRealmThreads(session, realm, { sort: 'new', concept: news, limit: 1 });
  for (const concept of [undefined, empty])
    await expect(readRealmThreads(session, realm, { sort: 'new', concept, cursor: board.nextCursor! }))
      .rejects.toBeInstanceOf(WorkReadInvalid);
});

test('retired and withheld boards answer gone before reading thread content', async () => {
  for (const options of [{ retired: true }, { hidden: true }]) {
    const { session, calls } = boardWorld(options);
    await expect(readRealmThreads(session, realm, { concept: news, sort: 'new' })).rejects.toBeInstanceOf(WorkReadMissing);
    expect(calls.bodies).toBe(0);
    expect(calls.admitted).toBe(0);
  }
});

test('Best and Top board reads retain their ordering and cannot disclose other boards', async () => {
  for (const sort of ['best', 'top'] as const) {
    const { session } = boardWorld();
    const page = await readRealmThreads(session, realm, { concept: news, sort, window: 'all', limit: 20 });
    expect(page.items.map(item => item.reply)).toEqual([reply(1)]);
  }
});
