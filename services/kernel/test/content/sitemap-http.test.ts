import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createAccess } from '../../src/access/index.ts';
import { deriveAccess } from '../../src/access/derived-access.ts';
import { runCommand } from '../../src/command/command.ts';
import { applyBoardCandidate } from '../../src/content/board-projection.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { actionCatalogue, SESSION_HEADER } from '../../src/http/request.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { decodeCursor, encodeCursor } from '../../src/tokens/cursor.ts';
import { decodeListCursor } from '../../src/tokens/list-cursor.ts';
import { standingFixture } from '../access/standing-fixture.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { SUBJECT_THREAD_EVENT_FIELDS } from '../support/subject-thread-event.ts';

const routeKey = new Uint8Array(32).fill(7);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
const boardRoute = 0x4321;
const threadRoute = 0x1234;
const accountId = newId(0x2468);
const baseTime = Date.parse('2026-10-20T00:00:00.000Z');
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let fixture: Awaited<ReturnType<typeof standingFixture>>;
let app: ReturnType<typeof createKernel>;
let memberApp: ReturnType<typeof createKernel>;
let bearer: string;
let clock = 0;
const now = Date.now();

type Feed = 'boards' | 'threads';
type Item = { id: string; title?: string | null; lastModified: string };
type Fixture = {
  publicBoard: string;
  publicThreads: string[];
  globalBoard: string;
  globalThreads: string[];
  hidden: string[];
  hiddenBoards: string[];
  thinBoards: string[];
};

beforeAll(async () => {
  db = await openGrowthDatabase();
  fixture = await standingFixture();
  await fixture.reset();
  const authenticate = fixture.access.authenticate;
  const issued: string[] = [];
  fixture.access.authenticate = (token, boundary) => {
    issued.push(token);
    return authenticate(token, { ...boundary, pool: db.pool });
  };
  try {
    await fixture.context();
    bearer = issued[0]!;
  } finally {
    fixture.access.authenticate = authenticate;
  }
  const config = { pool: db.pool, routeKey, tokens, content: { cursorNow: () => now } };
  app = createKernel(config);
  // Production Access with the fixture's Auth: bearers authenticate, and the anonymous floor is the real one.
  memberApp = createKernel({
    ...config,
    access: (accessConfig) =>
      deriveAccess(createAccess(accessConfig), {
        authenticate: (token, boundary) => fixture.access.authenticate(token, boundary),
      }),
  });
});
afterAll(async () => {
  await fixture?.close();
  await db?.close();
});

function instant(): string {
  clock += 60_000;
  return new Date(baseTime + clock).toISOString();
}

async function realm(visibility: 'public' | 'protected'): Promise<string> {
  const createdAt = '2026-10-01T00:00:00.000Z';
  const spaceId = newId(boardRoute);
  const spaceRevisionId = newId(boardRoute);
  const realmId = newId(boardRoute);
  const realmRevisionId = newId(boardRoute);
  const client = await db.admin.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO community.space(route,space_id,state,head_revision_id,created_at,creator)
     VALUES ($1,$2,'active',$3,$4,$5)`,
      [boardRoute, spaceId, spaceRevisionId, createdAt, accountId],
    );
    await client.query(
      `INSERT INTO community.space_revision(route,space_id,revision_id,predecessor,title,summary,created_at,author)
     VALUES ($1,$2,$3,NULL,'Sitemap host','',$4,$5)`,
      [boardRoute, spaceId, spaceRevisionId, createdAt, accountId],
    );
    await client.query(
      `INSERT INTO community.realm(route,realm_id,space_id,state,visibility,context_id,head_revision_id,created_at,creator)
     VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8)`,
      [boardRoute, realmId, spaceId, visibility, GLOBAL_CONTEXT, realmRevisionId, createdAt, accountId],
    );
    await client.query(
      `INSERT INTO community.realm_revision(route,realm_id,revision_id,predecessor,title,summary,visibility,context_id,created_at,author)
     VALUES ($1,$2,$3,NULL,'Sitemap Realm','',$4,$5,$6,$7)`,
      [boardRoute, realmId, realmRevisionId, visibility, GLOBAL_CONTEXT, createdAt, accountId],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return realmId;
}

async function board(realmId: string | null, visibility = 'published'): Promise<string> {
  const id = newId(boardRoute);
  await db.admin.query(
    `INSERT INTO content.board(route,board_id,realm_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,$4,'Sitemap board',$5,1,$2)`,
    [boardRoute, id, realmId, newId(0x6789), visibility],
  );
  return id;
}

type ThreadState = { thread?: string; post?: string; erased?: boolean };
async function thread(boardId: string, state: ThreadState = {}, at = instant()): Promise<string> {
  const id = newId(threadRoute);
  const post = newId(threadRoute);
  const revision = newId(threadRoute);
  const body = Buffer.from(JSON.stringify(fromPlainText('sitemap body')));
  await runCommand(db.pool, { partition: partitionOf(threadRoute) }, async (tx) => {
    await tx.query(
      `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id,created_at)
       VALUES ($1,$2,$3,$4,'Sitemap thread',$5,1,$2,$6,$7)`,
      [threadRoute, id, accountId, boardId, state.thread ?? 'published', post, at],
    );
    await tx.query(
      `INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,1,$3,$7)`,
      [threadRoute, id, post, accountId, revision, state.post ?? 'published', at],
    );
    await tx.query(
      `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
       VALUES ($1,$2,$3,$4,$5,sha256($5),'sitemap body','MIT','{}',$6,'available',$4)`,
      [threadRoute, id, post, revision, body, boardId],
    );
    return {
      value: null,
      events: [
        {
          type: 'com.rezics.content.thread.created.v1',
          subject: id,
          data: {
            threadId: id,
            itemId: post,
            revisionId: revision,
            actorId: accountId,
            ...SUBJECT_THREAD_EVENT_FIELDS,
          },
        },
      ],
    };
  });
  await applyBoardCandidate(db.pool, { id, boardId, createdAt: at, epoch: 1, position: 1n });
  if (state.erased) {
    await db.admin.query(
      "UPDATE content.post SET availability='erased',security_revision=security_revision+1 WHERE route=$1 AND post_id=$2",
      [threadRoute, post],
    );
    await db.admin.query(
      "UPDATE content.revision SET body=NULL,body_sha256=NULL,search_text=NULL,availability='erased' WHERE route=$1 AND thread_id=$2",
      [threadRoute, id],
    );
  }
  return id;
}

async function get(feed: Feed, values: Record<string, string> = {}, token?: string) {
  const response = await (token ? memberApp : app).handle(
    new Request(`http://kernel.test/v1/sitemap/${feed}?${new URLSearchParams(values)}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    }),
  );
  return { response, text: await response.clone().text(), body: await response.json() };
}

async function walk(feed: Feed, limit: number, token?: string): Promise<{ items: Item[]; pages: number }> {
  const items: Item[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await get(feed, { limit: String(limit), ...(cursor ? { cursor } : {}) }, token);
    expect(page.response.status).toBe(200);
    expect(page.body.items.length).toBeLessThanOrEqual(limit);
    items.push(...page.body.items);
    cursor = page.body.next;
    expect(++pages).toBeLessThan(500);
  } while (cursor);
  return { items, pages };
}

test('a sitemap cursor issued for one feed is invalid_cursor on every other feed', async () => {
  for (const feed of ['boards', 'threads'] as const) {
    const issued = await get(feed, { limit: '1' });
    expect(issued.response.status).toBe(200);
    expect(issued.body.next).toEqual(expect.any(String));
    const decoded = await decodeListCursor(
      tokens,
      {
        route: `GET /v1/sitemap/${feed}`,
        viewer: null,
        query: {},
      },
      issued.body.next!,
      new Date(now),
    );
    expect(decoded.ok).toBe(true);
    for (const other of ['boards', 'threads'] as const) {
      if (other === feed) continue;
      expect((await get(other, { cursor: issued.body.next! })).body).toMatchObject({ code: 'invalid_cursor' });
    }
  }
});

test('a sitemap cursor sealed under the previous key still resumes after rotation, and one under a retired key is invalid_cursor', async () => {
  const issued = await get('boards', { limit: '1' });
  expect(issued.body.next).toEqual(expect.any(String));
  const originalCurrent = tokens.current;
  const originalKeys = new Map(tokens.keys);
  try {
    tokens.current = 2;
    tokens.keys.set(2, new Uint8Array(32).fill(9));
    expect((await get('boards', { limit: '1', cursor: issued.body.next! })).response.status).toBe(200);
    tokens.keys.delete(1);
    expect((await get('boards', { limit: '1', cursor: issued.body.next! })).body).toMatchObject({
      code: 'invalid_cursor',
    });
  } finally {
    tokens.current = originalCurrent;
    tokens.keys.clear();
    for (const [id, key] of originalKeys) tokens.keys.set(id, key);
  }
});

/** A public and a protected Realm, a Global board, an empty board, and every kind of unlisted thread. */
async function populate(): Promise<Fixture> {
  const publicRealm = await realm('public');
  const protectedRealm = await realm('protected');
  const publicBoard = await board(publicRealm);
  const protectedBoard = await board(protectedRealm);
  const globalBoard = await board(null);
  const removedBoard = await board(publicRealm, 'taken_down');
  const emptyBoard = await board(publicRealm);
  const emptyGlobalBoard = await board(null);
  const publicThreads = [await thread(publicBoard), await thread(publicBoard), await thread(publicBoard)];
  const globalThreads = [await thread(globalBoard), await thread(globalBoard)];
  const hidden = [
    await thread(protectedBoard),
    await thread(removedBoard),
    await thread(publicBoard, { thread: 'draft' }),
    await thread(publicBoard, { thread: 'protected' }),
    await thread(publicBoard, { thread: 'taken_down' }),
    await thread(publicBoard, { post: 'taken_down' }),
    await thread(publicBoard, { erased: true }),
  ];
  // A board whose only thread is unlisted is thin.
  const draftOnly = await board(publicRealm);
  hidden.push(await thread(draftOnly, { thread: 'draft' }));
  return {
    publicBoard,
    publicThreads,
    globalBoard,
    globalThreads,
    hidden,
    hiddenBoards: [protectedBoard, removedBoard],
    thinBoards: [emptyBoard, emptyGlobalBoard, draftOnly],
  };
}

let populated: Fixture;

test('the feeds are public, mount once and carry the shared shape', async () => {
  const document = openApiDocument(app);
  for (const feed of ['boards', 'threads'] as const) {
    const operation = document.paths[`/v1/sitemap/${feed}`]?.get;
    expect(operation?.operationId).toBe(`sitemap_${feed}.list`);
    expect(operation?.['x-exposure']).toBe('public');
    expect(operation?.description).toContain('next');
    expect(actionCatalogue(app).has(operation?.['x-action'] as string)).toBe(true);
    expect(app.routes.filter((route) => route.path === `/v1/sitemap/${feed}`)).toHaveLength(1);
    const empty = await get(feed);
    expect(empty.response.status).toBe(200);
    expect(empty.body).toEqual({ items: [], next: null });
  }
  populated = await populate();
});

test('the board and thread sitemap feeds walk every listed item exactly once through their cursors', async () => {
  const expectedThreads = [...populated.publicThreads, ...populated.globalThreads].sort();
  for (const limit of [1, 2, 3, 1000]) {
    const threads = await walk('threads', limit);
    const ids = threads.items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(expectedThreads);
    for (const item of threads.items) {
      expect(item.title).toBe('Sitemap thread');
      expect(Object.keys(item).sort()).toEqual(['id', 'lastModified', 'title']);
      expect(new Date(item.lastModified).toISOString()).toBe(item.lastModified);
    }
    const boards = await walk('boards', limit);
    const boardIds = boards.items.map((item) => item.id);
    expect(new Set(boardIds).size).toBe(boardIds.length);
    expect(boardIds.sort()).toEqual([populated.publicBoard, populated.globalBoard].sort());
    for (const item of boards.items) expect(Object.keys(item).sort()).toEqual(['id', 'lastModified']);
  }
  const first = await get('threads', { limit: '2' });
  expect(first.body.items).toHaveLength(2);
  expect(first.body.next).toEqual(expect.any(String));
});

test('boards and threads under a protected Realm or a removed board, and draft, protected, taken-down and erased threads never appear', async () => {
  const listed = new Set((await walk('threads', 1000)).items.map((item) => item.id));
  for (const id of populated.hidden) expect(listed.has(id)).toBe(false);
  const boards = new Set((await walk('boards', 1000)).items.map((item) => item.id));
  for (const id of populated.hiddenBoards) expect(boards.has(id)).toBe(false);
});

test('a board with no listed thread is not listed', async () => {
  const boards = new Set((await walk('boards', 1000)).items.map((item) => item.id));
  expect(populated.thinBoards).toHaveLength(3);
  for (const id of populated.thinBoards) expect(boards.has(id)).toBe(false);
});

test('a bearer caller receives the same feed as an anonymous caller', async () => {
  for (const feed of ['boards', 'threads'] as const) {
    for (const limit of ['1', '2', '1000']) {
      const anonymous = await get(feed, { limit });
      const member = await get(feed, { limit }, bearer);
      expect(member.response.status).toBe(200);
      expect(member.text).toBe(anonymous.text);
      // The cursor of a bearer caller continues the anonymous walk and the other way round.
      if (anonymous.body.next) {
        const next = await get(feed, { limit, cursor: anonymous.body.next });
        const nextMember = await get(feed, { limit, cursor: anonymous.body.next }, bearer);
        expect(nextMember.text).toBe(next.text);
      }
    }
  }
  const anonymous = await get('threads', { limit: '1' });
  expect(anonymous.response.headers.get(SESSION_HEADER)).toBeNull();
});

test('invalid cursors and limits are refused', async () => {
  for (const feed of ['boards', 'threads'] as const) {
    for (const values of [{ limit: '0' }, { limit: '1001' }, { limit: '1.5' }, { limit: 'x' }]) {
      const result = await get(feed, values);
      expect(result.response.status).toBe(400);
      expect(result.body).toMatchObject({ code: 'invalid_request' });
    }
    for (const cursor of ['nonsense', 'AAAA']) {
      const result = await get(feed, { cursor });
      expect(result.response.status).toBe(400);
      expect(result.body).toMatchObject({ code: 'invalid_cursor' });
    }
  }
  // A cursor belongs to its feed.
  const page = await get('boards', { limit: '1' });
  expect(page.body.next).toEqual(expect.any(String));
  const crossed = await get('threads', { cursor: page.body.next });
  expect(crossed.response.status).toBe(400);
  expect(crossed.body).toMatchObject({ code: 'invalid_cursor' });
});

test('lastModified follows a new reply and a new thread', async () => {
  const id = await board(null);
  const first = await thread(id);
  const read = async () => {
    const boards = (await walk('boards', 1000)).items.find((item) => item.id === id);
    const threads = (await walk('threads', 1000)).items;
    return { board: boards?.lastModified, thread: threads.find((item) => item.id === first)?.lastModified };
  };
  const before = await read();
  expect(before.board).toBeDefined();
  expect(before.thread).toBeDefined();

  // A reply advances the thread's activity; the board's newest thread did not change.
  const replyAt = instant();
  await db.admin.query(
    `UPDATE content.board_thread SET last_activity_at=$3, source_position=source_position+1
     WHERE route=$1 AND thread_id=$2`,
    [boardRoute, first, replyAt],
  );
  const afterReply = await read();
  expect(afterReply.thread).toBe(replyAt);
  expect(afterReply.thread! > before.thread!).toBe(true);
  expect(afterReply.board).toBe(before.board);

  // A new thread advances the board.
  await thread(id);
  const afterThread = await read();
  expect(afterThread.board! > before.board!).toBe(true);
  expect(afterThread.thread).toBe(afterReply.thread);
});

test('a cursor that stops on a skipped candidate contains no id, route or timestamp of that candidate in its decoded bytes', async () => {
  const hiddenRealm = await realm('protected');
  const hiddenBoards = [];
  for (let i = 0; i < 6; i++) hiddenBoards.push(await board(hiddenRealm));
  const visibleBoard = await board(null);
  const hiddenThreads = [];
  for (let i = 0; i < 12; i++) hiddenThreads.push(await thread(visibleBoard, { thread: 'draft' }));
  await thread(visibleBoard);
  for (const feed of ['boards', 'threads'] as const) {
    let cursor: string | null = null;
    let emptyPages = 0;
    do {
      const result = await get(feed, { limit: '1', ...(cursor ? { cursor } : {}) });
      expect(result.response.status).toBe(200);
      cursor = result.body.next;
      if (!result.body.items.length && cursor) emptyPages++;
      if (!cursor) continue;
      const scope = { operation: `sitemap.${feed}.list`, parameters: {} };
      const decoded = decodeCursor(tokens, scope, cursor, now);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) throw new Error('Cursor did not decode');
      const bytes = Buffer.from(cursor.split('.')[0]!, 'base64url').toString('utf8');
      for (const id of [...hiddenBoards, ...hiddenThreads]) expect(bytes).not.toContain(id);
      // Only a key id and encrypted bytes belong in the readable signed position.
      expect(decoded.after).toHaveLength(2);
      expect(typeof decoded.after[0]).toBe('number');
      expect(typeof decoded.after[1]).toBe('string');
      const payload = Buffer.from(decoded.after[1] as string, 'base64url');
      payload[0] = payload[0]! ^ 1;
      const tampered = encodeCursor(
        tokens,
        scope,
        { epoch: 1, after: [decoded.after[0]!, payload.toString('base64url')] },
        now,
      );
      expect((await get(feed, { cursor: tampered })).body).toMatchObject({ code: 'invalid_cursor' });
      const foreign = encodeCursor(
        tokens,
        { operation: `sitemap.${feed === 'boards' ? 'threads' : 'boards'}.list`, parameters: {} },
        { epoch: 1, after: decoded.after },
        now,
      );
      expect((await get(feed === 'boards' ? 'threads' : 'boards', { cursor: foreign })).body).toMatchObject({
        code: 'invalid_cursor',
      });
    } while (cursor);
    expect(emptyPages).toBeGreaterThan(0);
  }
});

test('a board stays listed when more than eight newer candidates are hidden', async () => {
  const id = await board(null);
  const listed = await thread(id);
  for (let i = 0; i < 12; i++) await thread(id, { thread: i % 2 ? 'draft' : 'taken_down' });
  const threads = (await walk('threads', 1)).items;
  const boards = (await walk('boards', 1)).items;
  expect(threads.some((item) => item.id === listed)).toBe(true);
  expect(boards.find((item) => item.id === id)?.lastModified).toBe(
    threads.find((item) => item.id === listed)?.lastModified,
  );
});
