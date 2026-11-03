import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { routeOf } from '../../src/route/route.ts';
import { createNativeContentSystemWithWriteRateOverrides, type NativeContentSystem } from './support/native-system.ts';
import type { ContentCredential } from './support/system.ts';

type Thread = { id: string; firstPost: { id: string } };
type Board = { id: string };
let system: NativeContentSystem;
const owner = () => system.actors.author;
const member = () => system.actors.other;
const moderator = () => system.actors.moderator;
const highWriteBudget = JSON.stringify({
  'new-account': { write: { maximum: 10_000, seconds: 86_400 } },
  member: { write: { maximum: 10_000, seconds: 86_400 } },
});

async function request(
  actor: ContentCredential,
  method: string,
  path: string,
  body?: unknown,
  key = crypto.randomUUID(),
  ifMatch?: string,
) {
  return system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${actor.bearer}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(key) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(ifMatch === undefined ? {} : { 'if-match': JSON.stringify(ifMatch) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function json<T>(
  actor: ContentCredential,
  method: string,
  path: string,
  body?: unknown,
  ifMatch?: string,
): Promise<T> {
  const response = await request(actor, method, path, body, crypto.randomUUID(), ifMatch);
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

async function createBoard(): Promise<{ board: Board; realmId: string }> {
  const author = owner();
  const { space } = await json<{ space: { spaceId: string } }>(author, 'POST', '/v1/spaces', { title: 'Pin host' });
  const { realm } = await json<{ realm: { realmId: string; headRevisionId: string } }>(author, 'POST', '/v1/realms', {
    spaceId: space.spaceId,
    title: 'Pinned Realm',
    visibility: 'protected',
    contextId: GLOBAL_CONTEXT,
    votes: { upvote: 1, downvote: -1 },
  });
  const { subject: scheme } = await json<{ subject: { id: string } }>(author, 'POST', '/v1/subjects', {
    type: 'skos:ConceptScheme',
    labels: { en: 'Pin scheme' },
  });
  const { subject: concept } = await json<{ subject: { id: string } }>(author, 'POST', '/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Pin board' },
    statements: {
      'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
    },
  });
  await json(author, 'PUT', `/v1/realms/${realm.realmId}/boardScheme`, { schemeId: scheme.id }, realm.headRevisionId);
  const { board } = await json<{ board: Board }>(author, 'POST', `/v1/realms/${realm.realmId}/boards`, {
    conceptId: concept.id,
    title: 'Pinned discussion',
    visibility: 'protected',
  });
  await system.database.pool.query(
    `INSERT INTO community.realm_member (route, realm_id, account_id, role, valid, reservation_id, transaction_id)
     VALUES ($1, $2, $3, 'member', tstzrange($4, NULL, '[)'), $5, $6)`,
    [
      routeOf(realm.realmId)!,
      realm.realmId,
      member().actor.accountId,
      new Date(Date.now() - 60_000),
      crypto.randomUUID(),
      crypto.randomUUID(),
    ],
  );
  return { board, realmId: realm.realmId };
}

async function createThread(boardId: string, title: string): Promise<Thread> {
  const { thread } = await json<{ thread: Thread }>(owner(), 'POST', '/v1/threads', {
    boardId,
    title,
    body: fromPlainText(title),
    licence: 'MIT',
    subjectIds: [],
    visibility: 'published',
  });
  return thread;
}

beforeAll(async () => {
  system = await createNativeContentSystemWithWriteRateOverrides(
    { databaseUrl: process.env.DATABASE_URL! },
    highWriteBudget,
  );
  await bootstrapRelease(system.database.pool, bundledRelease);
}, 120_000);

afterAll(async () => {
  await system?.close();
});

test.serial('pins are ordered, bounded, current-authorized and separate from sparse board continuation', async () => {
  const { board, realmId } = await createBoard();
  const threads: Thread[] = [];
  for (let index = 0; index < 6; index++) threads.push(await createThread(board.id, `Pin candidate ${index}`));
  expect((await json<{ threads: Thread[] }>(member(), 'GET', `/v1/boards/${board.id}/threads`)).threads).toHaveLength(
    6,
  );

  const memberAttempt = await request(member(), 'POST', `/v1/boards/${board.id}/threads/${threads[0]!.id}/pin`, {
    pinned: true,
  });
  expect(memberAttempt.status).toBe(403);
  await json(owner(), 'POST', '/v1/roleGrants', {
    resource: { route: routeOf(realmId), id: realmId },
    subject: { kind: 'account', id: member().actor.accountId },
    role: 'community.realm.moderator',
    valid: '(,)',
  });
  await json(owner(), 'POST', '/v1/roleGrants', {
    resource: { route: routeOf(realmId), id: realmId },
    subject: { kind: 'account', id: moderator().actor.accountId },
    role: 'community.realm.moderator',
    valid: '(,)',
  });

  const firstKey = crypto.randomUUID();
  for (const index of [0, 2, 4]) {
    const result = await request(
      member(),
      'POST',
      `/v1/boards/${board.id}/threads/${threads[index]!.id}/pin`,
      {
        pinned: true,
      },
      index === 0 ? firstKey : crypto.randomUUID(),
    );
    expect(result.status).toBe(200);
  }
  const full = await request(member(), 'POST', `/v1/boards/${board.id}/threads/${threads[5]!.id}/pin`, {
    pinned: true,
  });
  expect(full.status).toBe(409);
  const existing = await json<{ pinPosition: number }>(
    member(),
    'POST',
    `/v1/boards/${board.id}/threads/${threads[0]!.id}/pin`,
    {
      pinned: true,
    },
  );
  expect(existing.pinPosition).toBe(3);
  await json(member(), 'POST', `/v1/boards/${board.id}/threads/${threads[2]!.id}/pin`, { pinned: false });
  await json(member(), 'POST', `/v1/boards/${board.id}/threads/${threads[5]!.id}/pin`, { pinned: true });

  const page = await json<{ pinnedThreads: Thread[] }>(member(), 'GET', `/v1/boards/${board.id}/threads?limit=1`);
  expect(page.pinnedThreads.map(({ id }) => id)).toEqual([threads[5]!.id, threads[4]!.id, threads[0]!.id]);
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const path = new URL(
      `https://content.test/v1/boards/${board.id}/threads?limit=1&sort=newest${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    const response = await request(member(), 'GET', `${path.pathname}${path.search}`);
    expect(response.status).toBe(200);
    const result = (await response.json()) as { threads: Thread[]; next: string | null };
    for (const thread of result.threads) {
      expect([threads[0]!.id, threads[4]!.id, threads[5]!.id]).not.toContain(thread.id);
      expect(seen.has(thread.id)).toBe(false);
      seen.add(thread.id);
    }
    cursor = result.next;
  } while (cursor);
  expect(seen).toEqual(new Set([threads[1]!.id, threads[2]!.id, threads[3]!.id]));

  const hidden = threads[0]!;
  const hiddenDown = await request(member(), 'POST', `/v1/threads/${hidden.id}:takeDown`, {
    reason: 'Hide pinned thread',
  });
  expect(hiddenDown.status).toBe(200);
  const hiddenPin = await request(member(), 'POST', `/v1/boards/${board.id}/threads/${hidden.id}/pin`, {
    pinned: true,
  });
  expect(hiddenPin.status).toBe(404);
  const afterHide = await json<{ pinnedThreads: Thread[] }>(member(), 'GET', `/v1/boards/${board.id}/threads`);
  expect(afterHide.pinnedThreads.map(({ id }) => id)).toEqual([threads[5]!.id, threads[4]!.id]);

  await json(moderator(), 'PUT', `/v1/realms/${realmId}/bans/${member().actor.accountId}`, {
    reason: 'Revoked moderator',
  });
  const replay = await request(
    member(),
    'POST',
    `/v1/boards/${board.id}/threads/${threads[0]!.id}/pin`,
    {
      pinned: true,
    },
    firstKey,
  );
  expect(replay.status).toBe(404);
});
