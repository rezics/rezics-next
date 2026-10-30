import { afterEach, beforeEach, expect, setDefaultTimeout, test } from 'bun:test';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  Account,
  Board,
  Command,
  CommunityDriver,
  Fixture,
  Publication,
  Realm,
  Space,
  Subject,
  Thread,
  ThreadPage,
} from './community-driver';

setDefaultTimeout(180_000);
let driver: CommunityDriver;
let fixture: Fixture;
let current: CommunityDriver | undefined;
let fromPlainText: typeof import('@rezics/document').fromPlainText;
let serial = 0;
beforeEach(async () => {
  const location = process.env.COMMUNITY_DRIVER;
  if (!location) throw new Error('Community outcome driver is required');
  if (!isAbsolute(location) && !location.startsWith('file:')) {
    throw new Error('COMMUNITY_DRIVER must be an absolute path or file URL');
  }
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('Community driver must use a file URL');
  ({ fromPlainText } = await import('@rezics/document'));
  const binding = await import(url.href);
  if (typeof binding.createCommunityDriver !== 'function') {
    throw new Error('Community driver must export createCommunityDriver');
  }
  current = driver = await binding.createCommunityDriver();
  fixture = await driver.provision();
  serial = 0;
});
afterEach(async () => {
  const closing = current;
  current = undefined;
  await closing?.close();
});

const key = () => JSON.stringify(`community-${++serial}`);
const realmPath = (realm: Realm) => `/v1/realms/${realm.realmId}`;
const get = (path: string, actor: Account | null = fixture.owner) => driver.request({ actor, method: 'GET', path });
function command(
  method: Command['method'],
  path: string,
  body?: unknown,
  actor: Account | null = fixture.owner,
  ifMatch?: string,
): Command {
  return {
    method,
    path,
    actor,
    key: key(),
    ...(body === undefined ? {} : { body }),
    ...(ifMatch === undefined ? {} : { ifMatch }),
  };
}
const send = (
  method: Command['method'],
  path: string,
  body?: unknown,
  actor: Account | null = fixture.owner,
  ifMatch?: string,
) => driver.request(command(method, path, body, actor, ifMatch));
async function json<T>(response: Response, status = 200): Promise<T> {
  expect(response.status).toBe(status);
  return (await response.clone().json()) as T;
}
async function success(response: Response) {
  expect([200, 201, 202, 204]).toContain(response.status);
}
async function problem(response: Response, status: number, effect = 'not_applied') {
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  const { request_id, ...body } = await response.clone().json();
  expect(request_id).toEqual(expect.any(String));
  expect(body).toMatchObject({
    type: expect.stringMatching(/^https:\/\/rezics.com\/problems\//),
    title: expect.any(String),
    status,
    code: expect.any(String),
    retryable: false,
    effect_status: effect,
  });
  return body;
}
async function same404(hidden: Response, missing: Response) {
  const expected = await problem(missing, 404, 'not_applicable');
  expect(await problem(hidden, 404, 'not_applicable')).toEqual(expected);
}
interface Community {
  space: Space;
  realm: Realm;
  board: Board;
  thread: Thread;
  conceptId: string;
}
async function community(visibility: Realm['visibility'] = 'public'): Promise<Community> {
  const { space } = await json<{ space: Space }>(await send('POST', '/v1/spaces', { title: 'Community host' }), 201);
  let { realm } = await json<{ realm: Realm }>(
    await send('POST', '/v1/realms', {
      spaceId: space.spaceId,
      title: 'Community Realm',
      visibility,
      contextId: fixture.contextId,
    }),
    201,
  );
  const scheme = (
    await json<{ subject: Subject }>(
      await send('POST', '/v1/subjects', {
        type: 'skos:ConceptScheme',
        labels: { en: 'Board scheme' },
      }),
      201,
    )
  ).subject;
  realm = (
    await json<{ realm: Realm }>(
      await send(
        'PUT',
        `${realmPath(realm)}/boardScheme`,
        { schemeId: scheme.id },
        fixture.owner,
        JSON.stringify(realm.headRevisionId),
      ),
    )
  ).realm;
  const conceptId = await concept(realm);
  const { board } = await json<{ board: Board }>(
    await send('POST', `${realmPath(realm)}/boards`, { conceptId, title: 'Discussion', visibility: 'published' }),
    201,
  );
  const thread = await createThread(board);
  return { space, realm, board, thread, conceptId };
}
async function concept(realm: Realm) {
  return (
    await json<{ subject: Subject }>(
      await send('POST', '/v1/subjects', {
        type: 'skos:Concept',
        labels: { en: 'Discussion concept' },
        statements: {
          'skos:inScheme': [
            { property: { id: 'skos:inScheme' }, value: { type: 'value', content: realm.boardSchemeId } },
          ],
        },
      }),
      201,
    )
  ).subject.id;
}
function threadBody(board: Board) {
  return {
    boardId: board.id,
    title: 'Discussion thread',
    body: fromPlainText('Community body'),
    licence: 'CC-BY-4.0',
    subjectIds: [],
    visibility: 'published',
  };
}
async function createThread(board: Board, actor = fixture.owner) {
  const { thread } = await json<{ thread: Thread }>(await send('POST', '/v1/threads', threadBody(board), actor), 201);
  await driver.settle();
  return thread;
}
const postBody = () => ({ body: fromPlainText('Member contribution'), licence: 'CC-BY-4.0', subjectIds: [] });
const post = (thread: Thread, actor = fixture.member) =>
  send('POST', `/v1/threads/${thread.id}/posts`, postBody(), actor);
async function join(realm: Realm, actor = fixture.member) {
  await json(await send('POST', `${realmPath(realm)}/membership`, undefined, actor), 202);
  await driver.settle();
  expect(await json(await get(`${realmPath(realm)}/members/me`, actor))).toMatchObject({ state: 'member' });
  expect((await get(`${realmPath(realm)}/participation`, actor)).status).toBe(204);
}
const sorts = ['newest', 'oldest', 'active', 'hot'] as const;
async function listing(
  board: Board,
  sort: (typeof sorts)[number],
  actor: Account | null = fixture.owner,
  cursor?: string,
) {
  const query = new URLSearchParams({ sort, limit: '1' });
  if (cursor) query.set('cursor', cursor);
  const page = await json<ThreadPage>(await get(`/v1/boards/${board.id}/threads?${query}`, actor));
  expect(page.next === null || typeof page.next === 'string').toBe(true);
  expect(page.threads.length).toBeLessThanOrEqual(1);
  if (sort === 'active' || sort === 'hot') {
    expect(page).toHaveProperty('rankRefreshedAt');
    if (page.threads.length) expect(Number.isFinite(Date.parse(page.rankRefreshedAt!))).toBe(true);
  }
  return page;
}
async function follow(space: Space, actor = fixture.member) {
  const { follow: body } = await json<{ follow: { reason: string; state: string } }>(
    await get(`/v1/follows/${space.spaceId}`, actor),
  );
  expect(body).toMatchObject({ reason: 'membership', state: 'following' });
  return body;
}

test('anonymous reads public Realm boards and every thread sort but cannot create join react or post', async () => {
  const c = await community();
  await driver.refreshRanks();
  expect((await json<{ realm: Realm }>(await get(realmPath(c.realm), null))).realm.realmId).toBe(c.realm.realmId);
  expect(
    (await json<{ items: Board[] }>(await get(`${realmPath(c.realm)}/boards`, null))).items.map((b) => b.id),
  ).toContain(c.board.id);
  expect((await get(`/v1/boards/${c.board.id}`, null)).status).toBe(200);
  expect((await get(`/v1/threads/${c.thread.id}`, null)).status).toBe(200);
  for (const sort of sorts)
    expect((await listing(c.board, sort, null)).threads.map((t) => t.id)).toEqual([c.thread.id]);
  await join(c.realm);
  await json(await post(c.thread), 201);
  await success(await send('PUT', `/v1/threads/${c.thread.id}/reaction`, { kind: 'upvote' }, fixture.member));
  const anonymousHost = (
    await json<{ space: Space }>(await send('POST', '/v1/spaces', { title: 'Unused anonymous creation slot' }), 201)
  ).space;
  const anonymousConcept = await concept(c.realm);
  for (const attempt of [
    command('POST', '/v1/spaces', { title: 'Anonymous host' }, null),
    command(
      'POST',
      '/v1/realms',
      { spaceId: anonymousHost.spaceId, title: 'Realm', visibility: 'public', contextId: fixture.contextId },
      null,
    ),
    command(
      'POST',
      `${realmPath(c.realm)}/boards`,
      { conceptId: anonymousConcept, title: 'Board', visibility: 'published' },
      null,
    ),
    command('POST', '/v1/threads', threadBody(c.board), null),
    command('POST', `${realmPath(c.realm)}/membership`, undefined, null),
    command('PUT', `/v1/threads/${c.thread.id}/reaction`, { kind: 'upvote' }, null),
    command('POST', `/v1/threads/${c.thread.id}/posts`, postBody(), null),
  ])
    await problem(await driver.request(attempt), 401);
});

test('creator owns Space and Realm and stale If-Match updates return 412', async () => {
  const c = await community();
  expect(c.space.creator).toBe(fixture.owner.id);
  expect(c.realm.creator).toBe(fixture.owner.id);
  expect(c.realm.contextId).toBe(fixture.contextId);
  for (const [path, head, field] of [
    [`/v1/spaces/${c.space.spaceId}`, c.space.headRevisionId, 'space'],
    [realmPath(c.realm), c.realm.headRevisionId, 'realm'],
  ] as const) {
    const etag = JSON.stringify(head);
    const updated = await send('PATCH', path, { title: 'Owner edit' }, fixture.owner, etag);
    expect(updated.status).toBe(200);
    expect(updated.headers.get('etag')).not.toBe(etag);
    await problem(await send('PATCH', path, { title: 'Stale edit' }, fixture.owner, etag), 412);
    expect((await json<Record<string, { title: string }>>(await get(path)))[field]!.title).toBe('Owner edit');
    await problem(
      await send('PATCH', path, { title: 'Outsider edit' }, fixture.outsider, updated.headers.get('etag')!),
      403,
    );
  }
  const realm = (await json<{ realm: Realm }>(await get(realmPath(c.realm)))).realm;
  expect(realm.boardSchemeId).toEqual(expect.any(String));
  const scheme = (await json<{ subject: Subject }>(await get(`/v1/subjects/${realm.boardSchemeId}`))).subject;
  const concept = (await json<{ subject: Subject }>(await get(`/v1/subjects/${c.conceptId}`))).subject;
  expect(scheme.type).toBe('skos:ConceptScheme');
  expect(concept.type).toBe('skos:Concept');
  expect(concept.statements['skos:inScheme']!.map((s) => s.value)).toContainEqual(
    expect.objectContaining({ type: 'value', content: realm.boardSchemeId }),
  );
});

test('member joins posts reacts and follows Space then settled leave preserves public participation but hides protected threads without unfollowing', async () => {
  const c = await community();
  await json(await post(c.thread), 201);
  expect((await get(`${realmPath(c.realm)}/participation`, fixture.member)).status).toBe(204);
  await join(c.realm);
  await json(await post(c.thread), 201);
  await success(await send('PUT', `/v1/threads/${c.thread.id}/reaction`, { kind: 'upvote' }, fixture.member));
  const before = await follow(c.space);
  await json(await send('DELETE', `${realmPath(c.realm)}/membership`, undefined, fixture.member), 202);
  await driver.settle();
  expect(await json(await get(`${realmPath(c.realm)}/members/me`, fixture.member))).toMatchObject({ state: 'none' });
  expect(await follow(c.space)).toEqual(before);
  expect((await get(`/v1/threads/${c.thread.id}`, fixture.member)).status).toBe(200);
  await json(await post(c.thread), 201);
  expect((await get(`${realmPath(c.realm)}/participation`, fixture.member)).status).toBe(204);

  const protectedRealm = await community('protected');
  await json(await send('POST', `${realmPath(protectedRealm.realm)}/members`, { accountId: fixture.member.id }), 202);
  await driver.settle();
  expect((await get(`/v1/threads/${protectedRealm.thread.id}`, fixture.member)).status).toBe(200);
  await json(await post(protectedRealm.thread), 201);
  expect((await get(`${realmPath(protectedRealm.realm)}/participation`, fixture.member)).status).toBe(204);
  await json(await send('DELETE', `${realmPath(protectedRealm.realm)}/membership`, undefined, fixture.member), 202);
  await driver.settle();
  const missing = await get(`/v1/threads/${fixture.unknown.thread}`, fixture.member);
  await same404(await post(protectedRealm.thread), missing);
  await same404(await get(`${realmPath(protectedRealm.realm)}/participation`, fixture.member), missing);
  await same404(await get(`/v1/threads/${protectedRealm.thread.id}`, fixture.member), missing);
});

test('protected Realm non-member sees unknown-equivalent 404 and owner addition enables reading and posting', async () => {
  const c = await community('protected');
  const actor = fixture.outsider;
  expect((await get(`/v1/threads/${c.thread.id}`)).status).toBe(200);
  for (const [hidden, missing] of [
    [realmPath(c.realm), `/v1/realms/${fixture.unknown.realm}`],
    [`${realmPath(c.realm)}/boards`, `/v1/realms/${fixture.unknown.realm}/boards`],
    [`/v1/boards/${c.board.id}`, `/v1/boards/${fixture.unknown.board}`],
    [`/v1/threads/${c.thread.id}`, `/v1/threads/${fixture.unknown.thread}`],
  ])
    await same404(await get(hidden!, actor), await get(missing!, actor));
  for (const sort of sorts)
    await same404(
      await get(`/v1/boards/${c.board.id}/threads?sort=${sort}`, actor),
      await get(`/v1/boards/${fixture.unknown.board}/threads?sort=${sort}`, actor),
    );
  await problem(await send('POST', `${realmPath(c.realm)}/membership`, undefined, actor), 404);
  await problem(await post(c.thread, actor), 404);
  await json(await send('POST', `${realmPath(c.realm)}/members`, { accountId: actor.id }), 202);
  await driver.settle();
  expect((await get(`${realmPath(c.realm)}/participation`, actor)).status).toBe(204);
  expect((await get(`/v1/threads/${c.thread.id}`, actor)).status).toBe(200);
  await json(await post(c.thread, actor), 201);
});

test('Realm moderator ban removes membership denies join participation and replay while public reads remain open', async () => {
  const c = await community();
  await join(c.realm);
  const original = command('POST', `/v1/threads/${c.thread.id}/posts`, postBody(), fixture.member);
  await json(await driver.request(original), 201);
  const before = await driver.commandEvidence(fixture.member, original.key!);
  expect(before.posts.length).toBe(1);
  expect(before.receipts.length).toBe(1);
  await success(await driver.grantModerator(c.realm.realmId, fixture.moderator));
  const path = `${realmPath(c.realm)}/bans/${fixture.member.id}`;
  await problem(await send('PUT', path, { reason: 'Community outcome ban' }, fixture.outsider), 403);
  await success(await send('PUT', path, { reason: 'Community outcome ban' }, fixture.moderator));
  await problem(await send('POST', `${realmPath(c.realm)}/membership`, undefined, fixture.member), 403);
  await problem(await get(`${realmPath(c.realm)}/participation`, fixture.member), 403, 'not_applicable');
  await problem(await post(c.thread), 403);
  const replay = await driver.request(original);
  await problem(replay, 403);
  expect(replay.headers.get('rezics-session-token')).toBeNull();
  const after = await driver.commandEvidence(fixture.member, original.key!);
  expect(after.posts).toEqual(before.posts);
  expect(after.receipts).toEqual(before.receipts);
  expect(after.lastAttempt).toEqual({ authorized: false, receiptRead: false, storedResponseReturned: false });
  await driver.settle();
  expect(await json(await get(`${realmPath(c.realm)}/members/me`, fixture.member))).toMatchObject({ state: 'none' });
  expect((await get(realmPath(c.realm), fixture.member)).status).toBe(200);
  expect((await get(`/v1/boards/${c.board.id}`, fixture.member)).status).toBe(200);
  expect((await get(`/v1/threads/${c.thread.id}`, fixture.member)).status).toBe(200);
  await driver.refreshRanks();
  for (const sort of sorts)
    expect((await listing(c.board, sort, fixture.member)).threads.map((t) => t.id)).toEqual([c.thread.id]);
  await success(await send('DELETE', path, undefined, fixture.moderator));
  await join(c.realm);
  await json(await post(c.thread), 201);
});

test('Realm moderator takedown hides the thread from every sort and read without authority in another Realm', async () => {
  const c = await community();
  const other = await community();
  const survivor = await createThread(c.board);
  await success(await driver.grantModerator(c.realm.realmId, fixture.moderator));
  await driver.refreshRanks();
  for (const sort of sorts) {
    const page = await json<ThreadPage>(await get(`/v1/boards/${c.board.id}/threads?sort=${sort}&limit=10`, null));
    expect(page.threads.map((t) => t.id)).toContain(c.thread.id);
  }
  await problem(
    await send('POST', `/v1/threads/${other.thread.id}:takeDown`, { reason: 'spam' }, fixture.moderator),
    403,
  );
  await success(await send('POST', `/v1/threads/${c.thread.id}:takeDown`, { reason: 'spam' }, fixture.moderator));
  // No rank refresh: stale materialized candidates must pass final disclosure.
  for (const sort of sorts) {
    const page = await listing(c.board, sort, null);
    expect(page.threads.map((t) => t.id)).toEqual([survivor.id]);
    expect(page.next).toBeNull();
  }
  for (const actor of [null, fixture.member, fixture.moderator])
    await same404(
      await get(`/v1/threads/${c.thread.id}`, actor),
      await get(`/v1/threads/${fixture.unknown.thread}`, actor),
    );
  expect((await get(`/v1/threads/${other.thread.id}`, null)).status).toBe(200);
});

test('hot ranks use Realm vote weights after refresh and signed cursors page each sort without disclosure leaks', async () => {
  const c = await community();
  const second = await createThread(c.board);
  await join(c.realm);
  await success(await send('PUT', `/v1/threads/${c.thread.id}/reaction`, { kind: 'upvote' }, fixture.member));
  await success(await send('PUT', `/v1/threads/${second.id}/reaction`, { kind: 'downvote' }, fixture.member));
  await driver.refreshRanks();
  const initial = await listing(c.board, 'hot', null);
  expect(initial.threads.map((t) => t.id)).toEqual([c.thread.id]);
  for (const sort of sorts) {
    const first = await listing(c.board, sort, null);
    expect(first.next).toEqual(expect.any(String));
    const next = await listing(c.board, sort, null, first.next!);
    expect(new Set([...first.threads, ...next.threads].map((t) => t.id))).toEqual(new Set([c.thread.id, second.id]));
    expect(next.next).toBeNull();
    const tampered = `${first.next![0] === 'A' ? 'B' : 'A'}${first.next!.slice(1)}`;
    await problem(
      await get(`/v1/boards/${c.board.id}/threads?sort=${sort}&limit=1&cursor=${encodeURIComponent(tampered)}`, null),
      400,
      'not_applicable',
    );
  }
  const head = JSON.stringify(c.realm.headRevisionId);
  const read = await get(realmPath(c.realm));
  await json(
    await send(
      'PATCH',
      realmPath(c.realm),
      { votes: { upvote: -1, downvote: 1 } },
      fixture.owner,
      read.headers.get('etag') ?? head,
    ),
  );
  await driver.refreshRanks();
  const changed = await listing(c.board, 'hot', null);
  expect(changed.threads.map((t) => t.id)).toEqual([second.id]);
  expect(Date.parse(changed.rankRefreshedAt!)).toBeGreaterThan(Date.parse(initial.rankRefreshedAt!));
  expect((await listing(c.board, 'hot', null, changed.next!)).threads.map((t) => t.id)).toEqual([c.thread.id]);
});

test('publication uses one unique slot across withdraw reject and re-publication and grants no Global subject rights', async () => {
  const c = await community();
  const subjectId = fixture.subject.id;
  const path = `${realmPath(c.realm)}/publications`;
  const before = (await json<{ subject: Subject }>(await get(`/v1/subjects/${subjectId}`))).subject;
  const adopted = await send('POST', path, { subjectId });
  const first = (await json<{ publication: Publication }>(adopted, 201)).publication;
  expect(first.verdict).toBe('adopt');
  expect(adopted.headers.get('etag')).toBe(JSON.stringify(first.publicationId));
  await problem(await send('POST', path, { subjectId }), 409);
  const withdrawn = await send(
    'POST',
    `${path}/${subjectId}:withdraw`,
    {},
    fixture.owner,
    adopted.headers.get('etag')!,
  );
  expect((await json<{ publication: Publication }>(withdrawn)).publication.verdict).toBe('withdraw');
  expect((await json<{ items: Publication[] }>(await get(path))).items).toEqual([]);
  const republished = await send('POST', path, { subjectId }, fixture.owner, withdrawn.headers.get('etag')!);
  const second = (await json<{ publication: Publication }>(republished, 201)).publication;
  expect(second.realmId).toBe(first.realmId);
  expect(second.subjectId).toBe(first.subjectId);
  expect(second.publicationId).not.toBe(first.publicationId);
  const page = await json<{ items: Publication[]; next: string | null }>(await get(path));
  expect(page.items.map((p) => p.subjectId)).toEqual([subjectId]);
  expect(page.items[0]!.publicationId).toBe(second.publicationId);
  expect(page.next).toBeNull();
  for (const kind of ['edit', 'takeDown'] as const) {
    await problem(await driver.subjectCommand(kind, fixture.owner, subjectId, key()), 403);
  }
  expect((await json<{ subject: Subject }>(await get(`/v1/subjects/${subjectId}`))).subject).toEqual(before);
  await success(await driver.subjectCommand('edit', fixture.subjectOwner, subjectId, key()));
  const rejected = await send(
    'POST',
    `${path}/${subjectId}:reject`,
    {},
    fixture.owner,
    republished.headers.get('etag')!,
  );
  expect((await json<{ publication: Publication }>(rejected)).publication.verdict).toBe('reject');
  expect((await json<{ items: Publication[] }>(await get(path))).items).toEqual([]);
  await success(await driver.subjectCommand('takeDown', fixture.subjectOwner, subjectId, key()));
});

test('Realm Context accepts and rejects locally with Global fallback and unchanged global identity', async () => {
  const c = await community();
  const { id, candidateId, property, fallback } = fixture.subject;
  expect(c.realm.contextId).toBe(fixture.contextId);
  await success(await driver.grantModerator(c.realm.realmId, fixture.moderator));
  const globalContext = '00000000-0000-8000-8000-000000000000';
  const view = async (context: string) =>
    (await json<{ subject: Subject }>(await get(`/v1/subjects/${id}?context=${context}`, fixture.moderator))).subject;
  const global = await view(globalContext);
  expect(global.statements[property]!.map((s) => s.id)).toContain(candidateId);
  expect(global.statements[fallback]!.length).toBeGreaterThan(0);
  const globalCandidates = await json(
    await get(`/v1/subjects/${id}/candidates?property=${property}&context=${globalContext}`, fixture.moderator),
  );
  expect((await view(fixture.contextId)).statements).toEqual(global.statements);
  for (const [verb, expected, head] of [
    ['reject', null, 1],
    ['accept', 1, 2],
  ] as const) {
    const result = await send(
      'POST',
      `/v1/subjects/${id}/candidates/${candidateId}:${verb}`,
      { context: fixture.contextId, expected_head: expected },
      fixture.moderator,
    );
    expect(await json(result)).toMatchObject({
      acceptance: { context: fixture.contextId, candidate: candidateId, decision: verb, head },
    });
    const local = await view(fixture.contextId);
    expect(local.statements[property] ?? []).toEqual(verb === 'reject' ? [] : global.statements[property]!);
    expect(local.statements[fallback]).toEqual(global.statements[fallback]);
    const after = await view(globalContext);
    for (const field of ['id', 'type', 'labels', 'descriptions', 'aliases', 'statements'] as const) {
      expect(after[field]).toEqual(global[field]);
      if (field !== 'statements') expect(local[field]).toEqual(global[field]);
    }
    expect(
      await json(
        await get(`/v1/subjects/${id}/candidates?property=${property}&context=${globalContext}`, fixture.moderator),
      ),
    ).toEqual(globalCandidates);
  }
});

test('suspended account receives 401 on every community write with active positive controls', async () => {
  const actor = fixture.owner;
  const attempts: Command[] = [];
  async function control(request: Command) {
    await success(await driver.request(request));
    attempts.push(request);
    await driver.settle();
  }
  const c = await community();
  // Each slot-changing control uses its own Space/Realm or subject slot.
  const spaceRequest = command('POST', '/v1/spaces', { title: 'Suspension host' });
  const { space } = await json<{ space: Space }>(await driver.request(spaceRequest), 201);
  attempts.push(spaceRequest);
  await control(
    command(
      'PATCH',
      `/v1/spaces/${space.spaceId}`,
      { title: 'Updated host' },
      actor,
      JSON.stringify(space.headRevisionId),
    ),
  );
  await control(
    command('POST', '/v1/realms', {
      spaceId: space.spaceId,
      title: 'Suspension Realm',
      visibility: 'public',
      contextId: fixture.contextId,
    }),
  );
  const read = await get(realmPath(c.realm));
  await control(
    command(
      'PATCH',
      realmPath(c.realm),
      { title: 'Owner update', votes: { upvote: -1, downvote: 1 } },
      actor,
      read.headers.get('etag')!,
    ),
  );
  await control(
    command('POST', `${realmPath(c.realm)}/boards`, {
      conceptId: await concept(c.realm),
      title: 'Another board',
      visibility: 'published',
    }),
  );
  await control(command('POST', `${realmPath(c.realm)}/membership`));
  await control(command('POST', '/v1/threads', threadBody(c.board)));
  await control(command('POST', `/v1/threads/${c.thread.id}/posts`, postBody()));
  await control(command('PUT', `/v1/threads/${c.thread.id}/reaction`, { kind: 'upvote' }));
  await control(command('DELETE', `${realmPath(c.realm)}/membership`));
  const protectedRealm = await community('protected');
  await control(command('POST', `${realmPath(protectedRealm.realm)}/members`, { accountId: fixture.outsider.id }));
  await success(await driver.grantModerator(c.realm.realmId, actor));
  await join(c.realm);
  await control(command('PUT', `${realmPath(c.realm)}/bans/${fixture.member.id}`, { reason: 'Community outcome ban' }));
  await control(command('DELETE', `${realmPath(c.realm)}/bans/${fixture.member.id}`));
  const doomed = await createThread(c.board);
  await control(command('POST', `/v1/threads/${doomed.id}:takeDown`, { reason: 'spam' }));
  const subjectId = fixture.subject.id;
  const publications = `${realmPath(c.realm)}/publications`;
  const publishRequest = command('POST', publications, { subjectId });
  const published = await driver.request(publishRequest);
  await json(published, 201);
  attempts.push(publishRequest);
  const withdrawRequest = command(
    'POST',
    `${publications}/${subjectId}:withdraw`,
    {},
    actor,
    published.headers.get('etag')!,
  );
  const withdrawn = await driver.request(withdrawRequest);
  await json(withdrawn);
  attempts.push(withdrawRequest);
  const republished = await send('POST', publications, { subjectId }, actor, withdrawn.headers.get('etag')!);
  await json(republished, 201);
  await control(command('POST', `${publications}/${subjectId}:reject`, {}, actor, republished.headers.get('etag')!));
  // Context owner is the fixture's Realm creator and can make these local decisions.
  const candidate = `/v1/subjects/${subjectId}/candidates/${fixture.subject.candidateId}`;
  await control(command('POST', `${candidate}:reject`, { context: fixture.contextId, expected_head: null }));
  await control(command('POST', `${candidate}:accept`, { context: fixture.contextId, expected_head: 1 }));
  await success(await driver.suspend(actor));
  for (const attempt of attempts) {
    // Fresh keys force authentication on a new attempt; old bearer remains unchanged.
    await problem(await driver.request({ ...attempt, key: key() }), 401);
  }
  await success(await driver.subjectCommand('edit', fixture.subjectOwner, subjectId, key()));
  await success(await driver.subjectCommand('takeDown', fixture.subjectOwner, subjectId, key()));
  await success(await driver.suspend(fixture.subjectOwner));
  for (const kind of ['edit', 'takeDown'] as const) {
    await problem(await driver.subjectCommand(kind, fixture.subjectOwner, subjectId, key()), 401);
  }
  expect((await get(`/v1/threads/${c.thread.id}`, null)).status).toBe(200);
});

test('hot page and membership check have derived constant row and statement bounds at three population scales', async () => {
  // For fixed L=2 and fixed Access conditions/chain: hot seeks L ranked keys,
  // reads L thread/board/Realm heads and runs L final disclosure checks. Membership
  // seeks one Realm head and one account's interval (plus the bounded Access
  // temporal proof). Both are O(1) rows/statements, O(log R) index blocks, with no
  // member enumeration, global thread scan, COUNT or OFFSET as R grows.
  const { assertGrowthAccessPaths, checkGrowth } = await import('../services/kernel/test/support/growth');
  for (const operation of ['hot', 'membership'] as const) {
    const growth = await driver.growthFixture();
    try {
      const report = await checkGrowth(growth.database, {
        name: `community ${operation}`,
        scales: [256, 1024, 4096],
        bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
        slack: { rows: { absolute: 0, relative: 0 }, statements: { absolute: 0, relative: 0 } },
        repetitions: 3,
        warmups: 1,
        grow: async (_database, scale, previous) => {
          await growth.grow(scale, previous);
          expect(await growth.populations()).toEqual({ realms: scale, members: scale, threads: scale });
        },
        operation: async () => {
          if (operation === 'hot') {
            const page = await json<ThreadPage>(
              await get(`/v1/boards/${growth.boardId}/threads?sort=hot&limit=2`, growth.actor),
            );
            expect(page.threads.map((t) => t.id)).toEqual(growth.threadIds);
            expect(page.next).toBeNull();
            expect(Number.isFinite(Date.parse(page.rankRefreshedAt!))).toBe(true);
          } else {
            expect(await json(await get(`/v1/realms/${growth.realmId}/members/me`, growth.actor))).toMatchObject({
              state: 'member',
            });
          }
        },
      });
      expect(report.samples.map((s) => s.scale)).toEqual([256, 1024, 4096]);
      const relations = [
        ...new Set(report.samples.flatMap((sample) => sample.repetitions.flatMap((run) => Object.keys(run.relations)))),
      ];
      for (const sample of report.samples) {
        expect(sample.repetitions).toHaveLength(3);
        for (const run of sample.repetitions) expect(Object.keys(run.relations).length).toBeGreaterThan(0);
      }
      assertGrowthAccessPaths(`community ${operation}`, report.samples, relations);
      for (const { cost } of report.samples) {
        expect(cost.rows).toBeGreaterThan(0);
        expect(cost.statements).toBeGreaterThan(0);
        expect(cost.blocks).toBeGreaterThan(0);
        expect(Object.keys(cost.relations!).length).toBeGreaterThan(0);
      }
    } finally {
      await growth.close();
    }
  }
});
