/**
 * ---
 * acceptance:
 *   - a suspended account's earlier bearer reads nothing while anonymous reads answer as before
 *   - author and moderator walk board pages with their own cursors without repeats or gaps under inserts and current access changes
 * ---
 */
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { documentText, serializeDocument, type DocumentSnapshot } from '@rezics/document';
import type { Board, Content } from '../../../../specs/content-disclosure-driver.ts';
import { refreshBoardRankBatch } from '../../src/content/board-rank.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { routeOf } from '../../src/route/route.ts';
import { createContentDisclosureDriver } from './disclosure-driver.ts';
import * as nativeSystem from './support/native-system.ts';
import { digest } from './support/media-fixtures.ts';

type Persona = 'anonymous' | 'author' | 'moderator' | 'suspended';
let driver: Awaited<ReturnType<typeof createContentDisclosureDriver>>;
let system: nativeSystem.NativeContentSystem;

beforeEach(async () => {
  // Observe the unchanged native factory, retaining its real Auth credentials and kernel.
  const create = nativeSystem.createNativeContentSystem;
  const observation = spyOn(nativeSystem, 'createNativeContentSystem').mockImplementation(async (...args) => {
    system = await create(...args);
    return system;
  });
  try {
    driver = await createContentDisclosureDriver();
  } finally {
    observation.mockRestore();
  }
});
afterEach(async () => {
  // The driver owns and closes its native worker, Auth host and isolated databases.
  await driver?.close();
});

async function read(persona: Persona, path: string) {
  const actor = persona === 'anonymous' ? null : system.actors[persona];
  return system.kernel.handle(
    new Request(`https://content.test${path}`, {
      headers: actor ? { authorization: `Bearer ${actor.bearer}` } : {},
    }),
  );
}

async function failure(response: Response, code: 'not_found' | 'invalid_credentials' | 'invalid_request') {
  const status = code === 'not_found' ? 404 : code === 'invalid_credentials' ? 401 : 400;
  expect(response.status).toBe(status);
  expect(response.headers.get(SESSION_HEADER)).toBeNull();
  expect(response.headers.get('content-type')).toContain('application/problem+json');
  const { request_id, ...body } = await response.json();
  expect(request_id).toBeString();
  expect(body).toEqual({
    type: `https://rezics.com/problems/${code}`,
    title:
      code === 'not_found' ? 'Not Found' : code === 'invalid_credentials' ? 'Invalid Credentials' : 'Invalid Request',
    status,
    code,
    retryable: false,
    effect_status: 'not_applicable',
  });
  if (code === 'invalid_credentials') expect(response.headers.get('www-authenticate')).toContain('invalid_token');
}

async function evidence() {
  const client = await system.database.pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result: Record<string, unknown[]> = {};
    for (const table of [
      'content.thread',
      'content.post',
      'content.revision',
      'content.media',
      'content.media_variant',
      'core.receipt',
      'core.outbox',
    ])
      result[table] = (await client.query(`SELECT to_jsonb(r) AS row FROM ${table} r ORDER BY to_jsonb(r)::text`)).rows;
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function assertBody(value: { body: DocumentSnapshot; sha256: string }, text: string, expectedDigest: string | null) {
  if (expectedDigest === null) throw new Error('An available command revision must have a digest');
  expect(documentText(value.body)).toBe(text);
  expect(value.sha256).toBe(expectedDigest);
  expect(digest(new TextEncoder().encode(serializeDocument(value.body)))).toBe(expectedDigest);
}

async function json(persona: Persona, path: string) {
  const response = await read(persona, path);
  expect(response.status).toBe(200);
  return response.json();
}

async function firstPost(thread: Content) {
  return (await json('author', `/v1/threads/${thread.id}`)).thread.firstPost as { id: string; revisionId: string };
}

test("a suspended account's earlier bearer reads nothing while anonymous reads answer as before", async () => {
  const personas = ['anonymous', 'author', 'moderator', 'suspended'] as const;
  const board = await driver.board();
  const thread = await driver.publish({ board, body: 'Public opening sentinel' });
  const opening = await firstPost(thread);
  const post = await driver.publish({ board, thread, body: 'Earlier post sentinel' });
  const edited = await driver.edit(post, 'Current post sentinel');
  await driver.projection('drain');
  const itemPaths = [
    `/v1/threads/${thread.id}`,
    `/v1/posts/${opening.id}`,
    `/v1/posts/${post.id}`,
    `/v1/posts/${opening.id}/revisions/${thread.revision.id}`,
    `/v1/posts/${post.id}/revisions/${post.revision.id}`,
    `/v1/posts/${post.id}/revisions/${edited.id}`,
    `/v1/posts/${opening.id}/revisions`,
    `/v1/posts/${post.id}/revisions`,
    `/v1/threads/${thread.id}/posts`,
  ];
  const boardPaths = [`/v1/boards/${board.id}`, `/v1/boards/${board.id}/threads?limit=2`];
  const publicBefore = await evidence();
  for (const persona of personas) {
    if (persona === 'suspended') {
      for (const path of [...itemPaths, ...boardPaths]) await failure(await read(persona, path), 'invalid_credentials');
      continue;
    }
    expect((await json(persona, boardPaths[0]!)).board.id).toBe(board.id);
    for (const path of [
      itemPaths[0]!,
      `/v1/posts/${opening.id}`,
      `/v1/posts/${opening.id}/revisions/${thread.revision.id}`,
    ]) {
      const value = await json(persona, path);
      const openingView = value.thread?.firstPost ?? value.post;
      expect(openingView.revisionId).toBe(thread.revision.id);
      assertBody(openingView, 'Public opening sentinel', thread.revision.hash);
    }
    const current = (await json(persona, `/v1/posts/${post.id}`)).post;
    expect(current.revisionId).toBe(edited.id);
    assertBody(current, 'Current post sentinel', edited.hash);
    for (const [revision, text] of [
      [post.revision, 'Earlier post sentinel'],
      [edited, 'Current post sentinel'],
    ] as const) {
      const exact = (await json(persona, `/v1/posts/${post.id}/revisions/${revision.id}`)).post;
      expect(exact.revisionId).toBe(revision.id);
      assertBody(exact, text, revision.hash);
    }
    const openingHistory = await json(persona, `/v1/posts/${opening.id}/revisions`);
    expect(openingHistory.next).toBeNull();
    expect(openingHistory.revisions.map((revision: { id: string }) => revision.id)).toEqual([thread.revision.id]);
    assertBody(openingHistory.revisions[0], 'Public opening sentinel', thread.revision.hash);
    const history = await json(persona, `/v1/posts/${post.id}/revisions`);
    expect(history.next).toBeNull();
    expect(history.revisions.map((revision: { id: string }) => revision.id).sort()).toEqual(
      [post.revision.id, edited.id].sort(),
    );
    for (const [revision, text] of [
      [post.revision, 'Earlier post sentinel'],
      [edited, 'Current post sentinel'],
    ] as const)
      assertBody(
        history.revisions.find((value: { id: string }) => value.id === revision.id),
        text,
        revision.hash,
      );
    const page = await json(persona, boardPaths[1]!);
    expect(page.threads.map((value: { id: string }) => value.id)).toEqual([thread.id]);
    expect(page.threads[0].firstPost.revisionId).toBe(thread.revision.id);
    assertBody(page.threads[0].firstPost, 'Public opening sentinel', thread.revision.hash);
    expect(page.next).toBeNull();
    expect(
      (await json(persona, `/v1/threads/${thread.id}/posts`)).posts.map((value: { id: string }) => value.id),
    ).toEqual([opening.id, post.id]);
  }
  expect(await evidence()).toEqual(publicBefore);

  await driver.protect(thread);
  await driver.protect(post);
  await driver.grantRead('moderator', thread);
  await driver.grantRead('moderator', post);
  const protectedBefore = await evidence();
  for (const persona of personas) {
    for (const path of [...itemPaths, ...boardPaths]) {
      if (persona === 'suspended') await failure(await read(persona, path), 'invalid_credentials');
      else if (persona === 'anonymous' && itemPaths.includes(path))
        await failure(await read(persona, path), 'not_found');
      else {
        const result = await json(persona, path);
        if (path === boardPaths[1])
          expect(result.threads.map((value: { id: string }) => value.id)).toEqual(
            persona === 'anonymous' ? [] : [thread.id],
          );
        if (persona !== 'anonymous') {
          if (result.thread) {
            expect(result.thread.firstPost.revisionId).toBe(thread.revision.id);
            assertBody(result.thread.firstPost, 'Public opening sentinel', thread.revision.hash);
          }
          if (result.post) {
            const old = path.endsWith(`/revisions/${post.revision.id}`);
            const isOpening = path.startsWith(`/v1/posts/${opening.id}`);
            const revision = isOpening ? thread.revision : old ? post.revision : edited;
            expect(result.post.revisionId).toBe(revision.id);
            assertBody(
              result.post,
              isOpening ? 'Public opening sentinel' : old ? 'Earlier post sentinel' : 'Current post sentinel',
              revision.hash,
            );
          }
          if (result.revisions) {
            const isOpening = path.startsWith(`/v1/posts/${opening.id}`);
            expect(result.revisions.map((revision: { id: string }) => revision.id).sort()).toEqual(
              (isOpening ? [thread.revision.id] : [post.revision.id, edited.id]).sort(),
            );
            for (const value of result.revisions) {
              const revision = isOpening ? thread.revision : value.id === post.revision.id ? post.revision : edited;
              assertBody(
                value,
                isOpening
                  ? 'Public opening sentinel'
                  : revision === post.revision
                    ? 'Earlier post sentinel'
                    : 'Current post sentinel',
                revision.hash,
              );
            }
          }
        }
      }
    }
  }
  expect(await evidence()).toEqual(protectedBefore);

  // A separate public thread preserves the public withheld form, including the author-only decision.
  const withheldThread = await driver.publish({ board, body: 'Withheld opening sentinel' });
  const withheldOpening = await firstPost(withheldThread);
  const reply = await driver.publish({ board, thread: withheldThread, body: 'Retained visible reply' });
  expect(
    (await driver.takedown('moderator', { kind: 'post', id: withheldOpening.id }, crypto.randomUUID())).response.status,
  ).toBe(200);
  await driver.projection('drain');
  const withheldBefore = await evidence();
  for (const persona of personas) {
    const paths = [
      `/v1/threads/${withheldThread.id}`,
      `/v1/threads/${withheldThread.id}/posts`,
      `/v1/posts/${withheldOpening.id}`,
      `/v1/posts/${withheldOpening.id}/revisions/${withheldThread.revision.id}`,
      `/v1/posts/${withheldOpening.id}/revisions`,
      boardPaths[1]!,
    ];
    if (persona === 'suspended') {
      for (const path of paths) await failure(await read(persona, path), 'invalid_credentials');
      continue;
    }
    for (const path of paths.slice(2, 5)) await failure(await read(persona, path), 'not_found');
    const detail = (await json(persona, paths[0]!)).thread;
    expect(detail.firstPost).toMatchObject({
      id: withheldOpening.id,
      revisionId: withheldThread.revision.id,
      availability: 'withheld',
      removed: true,
      body: null,
      sha256: null,
    });
    if (persona === 'author') expect(detail.firstPost.decisionId).toBeString();
    else expect(detail.firstPost).not.toHaveProperty('decisionId');
    const page = await json(persona, paths[1]!);
    expect(page.posts[0]).toEqual(detail.firstPost);
    expect(page.posts[1]).toMatchObject({ id: reply.id, revisionId: reply.revision.id });
    assertBody(page.posts[1], 'Retained visible reply', reply.revision.hash);
    const listing = await json(persona, boardPaths[1]!);
    expect(listing.threads.find((value: { id: string }) => value.id === withheldThread.id).firstPost).toEqual(
      detail.firstPost,
    );
  }
  expect(await evidence()).toEqual(withheldBefore);
  expect((await driver.takedown('moderator', withheldThread, crypto.randomUUID())).response.status).toBe(200);
  await driver.projection('drain');
  const takenDownBefore = await evidence();
  for (const persona of personas) {
    for (const path of [
      `/v1/threads/${withheldThread.id}`,
      `/v1/posts/${reply.id}`,
      `/v1/posts/${reply.id}/revisions/${reply.revision.id}`,
      `/v1/posts/${reply.id}/revisions`,
      `/v1/threads/${withheldThread.id}/posts`,
    ])
      await failure(await read(persona, path), persona === 'suspended' ? 'invalid_credentials' : 'not_found');
    if (persona !== 'suspended')
      expect((await json(persona, boardPaths[1]!)).threads.map((value: { id: string }) => value.id)).not.toContain(
        withheldThread.id,
      );
  }
  expect(await evidence()).toEqual(takenDownBefore);

  const erased = await driver.publish({ board, body: 'Permanently erased opening sentinel' });
  const erasedOpening = await firstPost(erased);
  const erasedPost = await driver.publish({ board, thread: erased, body: 'Permanently erased reply sentinel' });
  // Exact erased metadata is explicitly granted; owner roles alone do not authorize history.
  for (const persona of ['author', 'moderator'] as const) {
    await driver.grantRead(persona, erased);
    await driver.grantRead(persona, erasedPost);
  }
  expect((await driver.erase('author', erased, 'author', crypto.randomUUID())).response.status).toBe(202);
  await driver.projection('drain');
  const stored = await system.database.pool.query(
    `SELECT revision_id,availability,body,body_sha256,search_text FROM content.revision
     WHERE route=$1 AND thread_id=$2 ORDER BY revision_id`,
    [routeOf(erased.id), erased.id],
  );
  expect(stored.rows).toHaveLength(2);
  for (const row of stored.rows)
    expect(row).toMatchObject({ availability: 'erased', body: null, body_sha256: null, search_text: null });
  for (const persona of personas) {
    const paths = [
      `/v1/threads/${erased.id}`,
      `/v1/posts/${erasedOpening.id}`,
      `/v1/posts/${erasedPost.id}`,
      `/v1/posts/${erasedOpening.id}/revisions/${erased.revision.id}`,
      `/v1/posts/${erasedPost.id}/revisions/${erasedPost.revision.id}`,
      `/v1/posts/${erasedOpening.id}/revisions`,
      `/v1/posts/${erasedPost.id}/revisions`,
      `/v1/threads/${erased.id}/posts`,
      boardPaths[1]!,
    ];
    if (persona === 'suspended') {
      const before = await evidence();
      for (const path of paths) await failure(await read(persona, path), 'invalid_credentials');
      expect(await evidence()).toEqual(before);
      continue;
    }
    const detail = (await json(persona, paths[0]!)).thread;
    expect(detail.title).toBeNull();
    expect(detail.firstPost).toMatchObject({
      id: erasedOpening.id,
      availability: 'erased',
      removed: true,
      body: null,
      sha256: null,
    });
    for (const path of paths.slice(1, 3))
      expect((await json(persona, path)).post).toMatchObject({ availability: 'erased', body: null, sha256: null });
    for (const path of paths.slice(3, 5)) {
      if (persona === 'anonymous') await failure(await read(persona, path), 'not_found');
      else expect((await json(persona, path)).post).toMatchObject({ availability: 'erased', body: null, sha256: null });
    }
    for (const path of paths.slice(5, 7)) {
      const page = await json(persona, path);
      expect(page.next).toBeNull();
      if (persona === 'anonymous') expect(page.revisions).toEqual([]);
      else {
        expect(page.revisions).toHaveLength(1);
        expect(page.revisions[0]).toMatchObject({ availability: 'erased', body: null, sha256: null });
      }
    }
    const posts = (await json(persona, paths[7]!)).posts;
    expect(posts.map((value: { id: string }) => value.id)).toEqual([erasedOpening.id, erasedPost.id]);
    for (const value of posts) expect(value).toMatchObject({ availability: 'erased', body: null, sha256: null });
    const listed = (await json(persona, boardPaths[1]!)).threads.find(
      (value: { id: string }) => value.id === erased.id,
    );
    expect(listed).toBeDefined();
    expect(listed.firstPost).toMatchObject({ availability: 'erased', body: null, sha256: null });
  }
});

type WalkItem = {
  content: Content;
  createdAt: number;
  activityAt: number;
  text: string;
  revisionId: string;
  revisionHash: string | null;
};
type Page = {
  threads: { id: string; firstPost: { revisionId: string; body: DocumentSnapshot; sha256: string } }[];
  next: string | null;
};

async function page(
  persona: 'author' | 'moderator',
  board: Board,
  sort: 'newest' | 'active',
  cursor?: string,
): Promise<Page> {
  const query = new URLSearchParams({ limit: '2', sort });
  if (cursor !== undefined) query.set('cursor', cursor);
  return json(persona, `/v1/boards/${board.id}/threads?${query}`) as Promise<Page>;
}

function order(items: WalkItem[], sort: 'newest' | 'active', at: number) {
  const rank = (item: WalkItem) => Math.log10(2) / Math.pow(Math.max(0, (at - item.activityAt) / 3_600_000) + 2, 1.8);
  return [...items].sort((a, b) =>
    sort === 'newest'
      ? b.createdAt - a.createdAt || b.content.id.localeCompare(a.content.id)
      : rank(b) - rank(a) || a.content.id.localeCompare(b.content.id),
  );
}

test('author and moderator walk board pages with their own cursors without repeats or gaps under inserts and current access changes', async () => {
  for (const sort of ['newest', 'active'] as const) {
    const board = await driver.board();
    const base = Date.now() - 3_600_000;
    const rankAt = Date.now() + 30 * 60_000;
    const items: WalkItem[] = [];
    async function publish(offset: number, text: string) {
      const createdAt = base + offset;
      const content = await driver.publish({ board, body: text, createdAt: new Date(createdAt).toISOString() });
      const item = {
        content,
        createdAt,
        activityAt: createdAt,
        text,
        revisionId: content.revision.id,
        revisionHash: content.revision.hash,
      };
      items.push(item);
      return item;
    }
    for (const [index, offset] of [0, 0, -60_000, -60_000, -120_000, -180_000, -240_000].entries())
      await publish(offset, `Original ${sort} opening ${index}`);
    if (sort === 'active') {
      const oldest = items.at(-1)!;
      const activityAt = base + 30_000;
      await driver.publish({
        board,
        thread: oldest.content,
        body: 'A real reply changes active order',
        createdAt: new Date(activityAt).toISOString(),
      });
      oldest.activityAt = activityAt;
    }
    await driver.projection('drain');
    if (sort === 'active') await refreshBoardRankBatch(system.database.pool, new Date(rankAt), [board.partition]);
    const expectedInitial = order(items, sort, rankAt);
    const first = { author: await page('author', board, sort), moderator: await page('moderator', board, sort) };
    for (const initial of Object.values(first)) {
      expect(initial.threads.map(({ id }) => id)).toEqual(expectedInitial.slice(0, 2).map(({ content }) => content.id));
      expect(initial.next).toBeString();
      for (const [index, value] of initial.threads.entries()) {
        const expected = expectedInitial[index]!;
        expect(value.firstPost.revisionId).toBe(expected.revisionId);
        assertBody(value.firstPost, expected.text, expected.revisionHash);
      }
    }
    expect(first.author.next).not.toBe(first.moderator.next);
    const beforeBadCursors = await evidence();
    for (const [persona, foreign] of [
      ['author', first.moderator.next!],
      ['moderator', first.author.next!],
    ] as const) {
      const query = new URLSearchParams({ limit: '2', sort, cursor: foreign });
      await failure(await read(persona, `/v1/boards/${board.id}/threads?${query}`), 'invalid_request');
      const tampered = `${foreign.slice(0, Math.floor(foreign.length / 2))}${foreign[Math.floor(foreign.length / 2)] === 'A' ? 'B' : 'A'}${foreign.slice(Math.floor(foreign.length / 2) + 1)}`;
      query.set('cursor', tampered);
      await failure(await read(persona, `/v1/boards/${board.id}/threads?${query}`), 'invalid_request');
    }
    expect(await evidence()).toEqual(beforeBadCursors);
    const revoked = expectedInitial[3]!;
    const taken = expectedInitial[5]!;
    const revised = expectedInitial[4]!;
    await driver.protect(revoked.content);
    await driver.revokeCreatorReadAuthority(revoked.content);
    expect((await driver.takedown('moderator', taken.content, crypto.randomUUID())).response.status).toBe(200);
    const newHead = await driver.edit(revised.content, `Current ${sort} opening after page one`);
    revised.text = `Current ${sort} opening after page one`;
    revised.revisionId = newHead.id;
    revised.revisionHash = newHead.hash;
    const ahead = await publish(60_000, `Inserted ahead of ${sort} cursor`);
    const behind = await publish(-90_000, `Inserted after ${sort} cursor`);
    await driver.projection('drain');
    if (sort === 'active') await refreshBoardRankBatch(system.database.pool, new Date(rankAt), [board.partition]);
    const alreadySeen = new Set(expectedInitial.slice(0, 2).map(({ content }) => content.id));
    const remaining = order(
      items.filter((item) => item !== revoked && item !== taken && item !== ahead && !alreadySeen.has(item.content.id)),
      sort,
      rankAt,
    );
    expect(remaining.map(({ content }) => content.id)).toContain(behind.content.id);
    for (const persona of ['author', 'moderator'] as const) {
      const seen = first[persona].threads.map(({ id }) => id);
      let cursor = first[persona].next;
      const cursors = new Set<string>();
      let pages = 0;
      while (cursor !== null) {
        expect(pages++).toBeLessThan(12);
        expect(cursors.has(cursor)).toBe(false);
        cursors.add(cursor);
        const result = await page(persona, board, sort, cursor);
        expect(result.threads.length).toBeLessThanOrEqual(2);
        for (const value of result.threads) {
          expect(seen).not.toContain(value.id);
          const expected = remaining.find(({ content }) => content.id === value.id);
          expect(expected).toBeDefined();
          expect(value.firstPost.revisionId).toBe(expected!.revisionId);
          assertBody(value.firstPost, expected!.text, expected!.revisionHash);
          seen.push(value.id);
        }
        cursor = result.next;
      }
      expect(seen).toEqual([...expectedInitial.slice(0, 2), ...remaining].map(({ content }) => content.id));
      expect(new Set(seen).size).toBe(seen.length);
      const fresh: string[] = [];
      cursor = null;
      pages = 0;
      cursors.clear();
      do {
        expect(pages++).toBeLessThan(12);
        const result = await page(persona, board, sort, cursor ?? undefined);
        for (const value of result.threads) {
          const expected = items.find(({ content }) => content.id === value.id)!;
          expect(value.firstPost.revisionId).toBe(expected.revisionId);
          assertBody(value.firstPost, expected.text, expected.revisionHash);
        }
        fresh.push(...result.threads.map(({ id }) => id));
        cursor = result.next;
        if (cursor !== null) {
          expect(cursors.has(cursor)).toBe(false);
          cursors.add(cursor);
        }
        expect(fresh.length).toBeLessThanOrEqual(items.length);
      } while (cursor !== null);
      expect(fresh).toEqual(
        order(
          items.filter((item) => item !== revoked && item !== taken),
          sort,
          rankAt,
        ).map(({ content }) => content.id),
      );
    }
  }
});
