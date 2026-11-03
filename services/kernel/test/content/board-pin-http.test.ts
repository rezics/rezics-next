import { createNativeContentSystemWithWriteRateOverrides, type NativeContentSystem } from './support/native-system.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { channel } from 'node:diagnostics_channel';
import { bundledRelease } from '@rezics/definitions/bundled';
import { fromPlainText } from '@rezics/document';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId, routeOf } from '../../src/route/route.ts';
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
  channel('tracing:reylo:query:error').subscribe((message) => {
    const { query } = message as { query: { sql: string } };
    console.error('Failed native fixture statement:', query.sql);
  });
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
  'pins are ordered, bounded, current-authorized and separate from sparse board continuation',
  async () => {
    const { board, realmId } = await createBoard();
    const threads: Thread[] = [];
    for (let index = 0; index < 8; index++) threads.push(await createThread(board.id, `Pin candidate ${index}`));
    expect((await json<{ threads: Thread[] }>(member(), 'GET', `/v1/boards/${board.id}/threads`)).threads).toHaveLength(
      8,
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
    for (const index of [0, 1, 2, 4]) {
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
    // Competing commands for the last slot serialize on the native board row.
    const attempts = await Promise.all(
      [6, 7].map((index) =>
        request(member(), 'POST', `/v1/boards/${board.id}/threads/${threads[index]!.id}/pin`, { pinned: true }),
      ),
    );
    expect(attempts.map((response) => response.status).sort()).toEqual([200, 409]);
    const fifth = threads[attempts[0]!.ok ? 6 : 7]!;
    const ordinary = [threads[3]!, threads[5]!, threads[attempts[0]!.ok ? 7 : 6]!];
    const existing = await json<{ pinPosition: number }>(
      member(),
      'POST',
      `/v1/boards/${board.id}/threads/${threads[0]!.id}/pin`,
      { pinned: true },
    );
    expect(existing.pinPosition).toBe(5);
    await json(member(), 'POST', `/v1/boards/${board.id}/threads/${threads[2]!.id}/pin`, { pinned: false });
    await json(member(), 'POST', `/v1/boards/${board.id}/threads/${threads[2]!.id}/pin`, { pinned: true });
    const pinned = [threads[2]!.id, fifth.id, threads[4]!.id, threads[1]!.id, threads[0]!.id];
    type Page = { pinnedThreads: Thread[]; threads: Thread[]; next: string | null };
    const page = (sort: string, cursor?: string | null) =>
      json<Page>(
        member(),
        'GET',
        `/v1/boards/${board.id}/threads?limit=1&sort=${sort}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      );
    let retainedCursor = '';
    for (const sort of ['newest', 'oldest', 'active', 'hot']) {
      const first = await page(sort);
      expect(first.pinnedThreads.map(({ id }) => id)).toEqual(pinned);
      expect(first.next).toBeString();
      const seen = new Set(first.threads.map(({ id }) => id));
      let cursor = first.next;
      while (cursor) {
        const result = await page(sort, cursor);
        expect(result.pinnedThreads).toEqual([]);
        for (const thread of result.threads) {
          expect(pinned).not.toContain(thread.id);
          expect(seen.has(thread.id)).toBe(false);
          seen.add(thread.id);
        }
        cursor = result.next;
      }
      expect(seen).toEqual(new Set(ordinary.map(({ id }) => id)));
      const stalePath = `/v1/boards/${board.id}/threads?limit=1&sort=${sort}&cursor=${encodeURIComponent(first.next!)}`;
      // True no-ops, with fresh receipt keys, preserve the native observation.
      await json(member(), 'POST', `/v1/boards/${board.id}/threads/${threads[0]!.id}/pin`, { pinned: true });
      await json(member(), 'POST', `/v1/boards/${board.id}/threads/${ordinary[0]!.id}/pin`, { pinned: false });
      expect((await request(member(), 'GET', stalePath)).status).toBe(200);
      await json(member(), 'POST', `/v1/boards/${board.id}/threads/${threads[2]!.id}/pin`, { pinned: false });
      expect((await request(member(), 'GET', stalePath)).status).toBe(400);
      const unpinned = await page(sort);
      await json(member(), 'POST', `/v1/boards/${board.id}/threads/${threads[2]!.id}/pin`, { pinned: true });
      expect((await request(member(), 'GET', stalePath)).status).toBe(400); // ABA is stale too.
      expect(
        (
          await request(
            member(),
            'GET',
            `/v1/boards/${board.id}/threads?sort=${sort}&cursor=${encodeURIComponent(unpinned.next!)}`,
          )
        ).status,
      ).toBe(400);
      retainedCursor = (await page('newest')).next!;
    }

    // Hold an actual native read after it observed the cohort, then mutate
    // through the mounted pin command before allowing disclosure to finish.
    const prepare = system.access.prepareReadDecisions;
    if (!prepare) throw new Error('Native read decisions unavailable');
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    let held = false;
    system.access.prepareReadDecisions = async (input) => {
      const decisions = await prepare.call(system.access, input);
      return {
        ...decisions,
        async decide(client, input) {
          if (!held && input.action === 'thread:read') {
            held = true;
            entered.resolve();
            await released.promise;
          }
          return decisions.decide(client, input);
        },
      };
    };
    const racingRead = request(member(), 'GET', `/v1/boards/${board.id}/threads?limit=1`);
    try {
      await Promise.race([
        entered.promise,
        racingRead.then(() => {
          throw new Error('Read missed cohort barrier');
        }),
      ]);
      await json(member(), 'POST', `/v1/boards/${board.id}/threads/${threads[2]!.id}/pin`, { pinned: false });
    } finally {
      released.resolve();
      system.access.prepareReadDecisions = prepare;
    }
    expect((await racingRead).status).toBe(400);
    await json(member(), 'POST', `/v1/boards/${board.id}/threads/${threads[2]!.id}/pin`, { pinned: true });
    retainedCursor = (await page('newest')).next!;

    // Inert native projection references force a sparse page to exhaust its entire
    // raw window; the real ordinary candidates are beyond that first 200-row batch.
    const ghosts = Array.from({ length: 205 }, () => newId(routeOf(board.id)!));
    await system.database.pool.query(
      `INSERT INTO content.board_thread (route, board_id, thread_id, created_at, source_epoch, source_position)
     SELECT $1, $2, id, '2099-01-01'::timestamptz, 1, 1 FROM unnest($3::uuid[]) AS id`,
      [routeOf(board.id), board.id, ghosts],
    );
    const sparse = await page('newest');
    expect(sparse.threads).toEqual([]);
    expect(sparse.pinnedThreads.map(({ id }) => id)).toEqual(pinned);
    expect(sparse.next).toBeString();
    const readablePayload = Buffer.from(sparse.next!.split('.')[0]!, 'base64url').subarray(2).toString();
    for (const id of [...ghosts, ...pinned]) expect(readablePayload).not.toContain(id);
    const beyond = await page('newest', sparse.next);
    expect(beyond.pinnedThreads).toEqual([]);
    expect(ordinary.map(({ id }) => id)).toContain(beyond.threads[0]!.id);

    const hidden = threads[0]!;
    const hiddenDown = await request(member(), 'POST', `/v1/posts/${hidden.firstPost.id}:takeDown`, {
      reason: 'Hide pinned thread',
    });
    expect(hiddenDown.status).toBe(200);
    const hiddenPin = await request(member(), 'POST', `/v1/boards/${board.id}/threads/${hidden.id}/pin`, {
      pinned: true,
    });
    expect(hiddenPin.status).toBe(404);
    const afterHide = await json<{ pinnedThreads: Thread[] }>(member(), 'GET', `/v1/boards/${board.id}/threads`);
    expect(afterHide.pinnedThreads.map(({ id }) => id)).toEqual(pinned.filter((id) => id !== hidden.id));

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
    const concealedRealm = await request(
      member(),
      'GET',
      `/v1/boards/${board.id}/threads?cursor=${encodeURIComponent(retainedCursor)}`,
    );
    expect(concealedRealm.status).toBe(404);
    const concealedBody = await concealedRealm.text();
    for (const id of pinned) expect(concealedBody).not.toContain(id);
  },
  120_000,
);
