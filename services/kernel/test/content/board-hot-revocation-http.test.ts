import { createNativeContentSystemWithWriteRateOverrides, type NativeContentSystem } from './support/native-system.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { routeOf } from '../../src/route/route.ts';
import type { ContentCredential } from './support/system.ts';

type Thread = { id: string; firstPost: { id: string } };
type Page = { threads: Thread[]; pinnedThreads: Thread[]; next: string | null };
type Change = 'takedown' | 'ban' | 'none';
let system: NativeContentSystem;
const owner = () => system.actors.author;
const member = () => system.actors.other;
const moderator = () => system.actors.moderator;
const highWriteBudget = JSON.stringify({
  'new-account': { write: { maximum: 10_000, seconds: 86_400 } },
  member: { write: { maximum: 10_000, seconds: 86_400 } },
});

async function request(actor: ContentCredential, method: string, path: string, body?: unknown) {
  return system.kernel.handle(
    new Request(`https://content.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${actor.bearer}`,
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(crypto.randomUUID()) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function json<T>(actor: ContentCredential, method: string, path: string, body?: unknown): Promise<T> {
  const response = await request(actor, method, path, body);
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

// Same Realm-board fixture as board-pin-http: the reader is a Realm member with board read access.
async function createBoard(): Promise<{ boardId: string; realmId: string }> {
  const author = owner();
  const { space } = await json<{ space: { spaceId: string } }>(author, 'POST', '/v1/spaces', {
    title: 'Revocation host',
  });
  const { realm } = await json<{ realm: { realmId: string; headRevisionId: string } }>(author, 'POST', '/v1/realms', {
    spaceId: space.spaceId,
    title: 'Revocation Realm',
    visibility: 'protected',
    contextId: GLOBAL_CONTEXT,
    votes: { upvote: 1, downvote: -1 },
  });
  const { subject: scheme } = await json<{ subject: { id: string } }>(author, 'POST', '/v1/subjects', {
    type: 'skos:ConceptScheme',
    labels: { en: 'Revocation scheme' },
  });
  const { subject: concept } = await json<{ subject: { id: string } }>(author, 'POST', '/v1/subjects', {
    type: 'skos:Concept',
    labels: { en: 'Revocation board' },
    statements: {
      'skos:inScheme': [{ property: { id: 'skos:inScheme' }, value: { type: 'value', content: scheme.id } }],
    },
  });
  await json(author, 'PUT', `/v1/realms/${realm.realmId}/boardScheme`, { schemeId: scheme.id }, realm.headRevisionId);
  const { board } = await json<{ board: { id: string } }>(author, 'POST', `/v1/realms/${realm.realmId}/boards`, {
    conceptId: concept.id,
    title: 'Revocation discussion',
    visibility: 'protected',
  });
  await system.database.pool.query(
    `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,subject_role,grant_role,valid,transaction_id)
     VALUES ($1,$2,$3,'','content.board.owner','(,)',$4)`,
    [routeOf(board.id), board.id, member().actor.accountId, crypto.randomUUID()],
  );
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
  await json(author, 'POST', '/v1/roleGrants', {
    resource: { route: routeOf(realm.realmId), id: realm.realmId },
    subject: { kind: 'account', id: member().actor.accountId },
    role: 'community.realm.member',
    valid: '(,)',
  });
  await json(author, 'POST', '/v1/roleGrants', {
    resource: { route: routeOf(realm.realmId), id: realm.realmId },
    subject: { kind: 'account', id: moderator().actor.accountId },
    role: 'community.realm.moderator',
    valid: '(,)',
  });
  return { boardId: board.id, realmId: realm.realmId };
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

async function revoke(change: Change, boardId: string, realmId: string): Promise<void> {
  if (change === 'takedown')
    await json(moderator(), 'POST', `/v1/boards/${boardId}:takeDown`, { reason: 'Late takedown' });
  if (change === 'ban')
    await json(moderator(), 'PUT', `/v1/realms/${realmId}/bans/${member().actor.accountId}`, { reason: 'Late ban' });
}

// A concealed continuation is an empty page with no cursor, or a denial; no item identity may survive.
async function expectConcealed(response: Response, text: string, identities: readonly string[]): Promise<void> {
  if (response.status === 200) {
    const body = JSON.parse(text) as { threads?: unknown[]; posts?: unknown[]; next?: string | null };
    expect([...(body.threads ?? []), ...(body.posts ?? [])]).toEqual([]);
    expect(body.next ?? null).toBeNull();
  } else expect([403, 404]).toContain(response.status);
  for (const identity of identities) expect(text).not.toContain(identity);
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

test.serial(
  'a late board takedown or Realm ban conceals hot, active and newest continuation pages, while an unchanged board answers',
  async () => {
    for (const sort of ['hot', 'active', 'newest'] as const) {
      for (const change of ['takedown', 'ban', 'none'] as const) {
        const { boardId, realmId } = await createBoard();
        const threads: Thread[] = [];
        for (let index = 0; index < 4; index++) threads.push(await createThread(boardId, `${sort} ${change} ${index}`));
        const path = `/v1/boards/${boardId}/threads?limit=2&sort=${sort}`;
        const first = await json<Page>(member(), 'GET', path);
        expect(first.threads).toHaveLength(2);
        expect(first.next).toBeString();

        await revoke(change, boardId, realmId);
        const continuation = await request(member(), 'GET', `${path}&cursor=${encodeURIComponent(first.next!)}`);
        const text = await continuation.text();
        if (change === 'none') {
          expect(continuation.status).toBe(200);
          expect((JSON.parse(text) as Page).threads).toHaveLength(2);
          continue;
        }
        await expectConcealed(
          continuation,
          text,
          threads.map(({ id }) => id),
        );
      }
    }
  },
  300_000,
);

test.serial('a late board takedown or Realm ban conceals thread post continuation pages', async () => {
  for (const change of ['takedown', 'ban', 'none'] as const) {
    const { boardId, realmId } = await createBoard();
    const thread = await createThread(boardId, `posts ${change}`);
    for (let index = 0; index < 3; index++)
      await json(owner(), 'POST', `/v1/threads/${thread.id}/posts`, {
        body: fromPlainText(`reply ${index}`),
        licence: 'MIT',
        subjectIds: [],
      });
    const path = `/v1/threads/${thread.id}/posts?limit=2`;
    const first = await json<{ posts: { id: string }[]; next: string | null }>(member(), 'GET', path);
    expect(first.posts).toHaveLength(2);
    expect(first.next).toBeString();

    await revoke(change, boardId, realmId);
    const continuation = await request(member(), 'GET', `${path}&cursor=${encodeURIComponent(first.next!)}`);
    const text = await continuation.text();
    if (change === 'none') {
      expect(continuation.status).toBe(200);
      expect((JSON.parse(text) as { posts: unknown[] }).posts.length).toBeGreaterThan(0);
      continue;
    }
    await expectConcealed(continuation, text, [thread.id, thread.firstPost.id]);
  }
});
