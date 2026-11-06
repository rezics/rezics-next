import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { runCommand } from '../../src/command/command.ts';
import { applyBoardCandidate } from '../../src/content/board-projection.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { SUBJECT_THREAD_EVENT_FIELDS } from '../support/subject-thread-event.ts';

// A Board takedown committed after a page's Board check must not reach the page's final response, for anonymous readers
// of a published Board. Board pages pause on the thread read that follows their Board check. Thread post pages pause on
// the reaction-totals read that follows their entries. Each first page and continuation runs on its own Board, so the
// two revocations stay independent. The pauses only hold the request; the takedown is a committed Board row change.
const routeKey = new Uint8Array(32).fill(7);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
const boardRoute = 0x4322;
const threadRoute = 0x1235;
const subjectRoute = 0x6791;
const authorId = newId(0x9abd);
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let app: ReturnType<typeof createKernel>;
const now = Date.now();

beforeAll(async () => {
  db = await openGrowthDatabase();
  app = createKernel({
    pool: db.pool,
    routeKey,
    tokens,
    receiptKeys: testReceiptKeys(),
    content: { cursorNow: () => now },
  });
});
afterAll(async () => {
  await db?.close();
});

/** A published Board on a visible concept, as Subject threads use; a Board's public read needs its concept to be visible. */
async function board() {
  const id = newId(boardRoute);
  const concept = newId(subjectRoute);
  await db.admin.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,visibility,security_revision)
     VALUES ($1,$2,'schema:Book',$2,'visible',1)`,
    [subjectRoute, concept],
  );
  await db.admin.query(
    `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,'Current board','published',1,$2)`,
    [boardRoute, id, concept],
  );
  return id;
}

/** A thread with its opening post, indexed on its Board at the given position. */
async function thread(boardId: string, position: number, title: string) {
  const id = newId(threadRoute);
  const post = newId(threadRoute);
  const revision = newId(threadRoute);
  const at = `2026-10-24T00:00:0${position}.000Z`;
  const bytes = Buffer.from(JSON.stringify(fromPlainText(title)));
  // The thread references its Board's visible concept, as Subject threads do; public reads need that reference.
  const concept = (
    await db.pool.query<{ concept: string }>(
      'SELECT subject_id::text AS concept FROM content.board WHERE route=$1 AND board_id=$2',
      [boardRoute, boardId],
    )
  ).rows[0]!.concept;
  await runCommand(db.pool, { partition: partitionOf(threadRoute) }, async (tx) => {
    await tx.query(
      `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id,created_at)
       VALUES ($1,$2,$3,$4,$5,'published',1,$2,$6,$7)`,
      [threadRoute, id, authorId, boardId, title, post, at],
    );
    await tx.query(
      `INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id,created_at)
       VALUES ($1,$2,$3,$4,$5,'published',1,$3,$6)`,
      [threadRoute, id, post, authorId, revision, at],
    );
    await tx.query(
      `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
       VALUES ($1,$2,$3,$4,$5,sha256($5),$6,'MIT',$8::uuid[],$7,'available',$4)`,
      [threadRoute, id, post, revision, bytes, title, boardId, [concept]],
    );
    return {
      value: null,
      events: [
        {
          type: 'com.rezics.content.thread.created.v1',
          subject: id,
          data: { threadId: id, itemId: post, revisionId: revision, actorId: authorId, ...SUBJECT_THREAD_EVENT_FIELDS },
        },
      ],
    };
  });
  await applyBoardCandidate(db.pool, { id, boardId, createdAt: at, epoch: 1, position: BigInt(position) });
  return { id, post, title };
}

/** A reply inserted in creation order after the opening post; the thread's posts page orders by creation time. */
async function reply(threadId: string, position: number) {
  const post = newId(threadRoute);
  const revision = newId(threadRoute);
  const at = `2026-10-24T00:01:0${position}.000Z`;
  const bytes = Buffer.from(JSON.stringify(fromPlainText(`Controlled reply ${position}`)));
  await runCommand(db.pool, { partition: partitionOf(threadRoute) }, async (tx) => {
    await tx.query(
      `INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id,created_at)
       VALUES ($1,$2,$3,$4,$5,'published',1,$3,$6)`,
      [threadRoute, threadId, post, authorId, revision, at],
    );
    await tx.query(
      `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
       VALUES ($1,$2,$3,$4,$5,sha256($5),$6,'MIT',ARRAY(SELECT b.subject_id FROM content.thread t JOIN content.board b ON b.board_id=t.board_id WHERE t.route=$1 AND t.thread_id=$2),(SELECT board_id FROM content.thread WHERE route=$1 AND thread_id=$2),'available',$4)`,
      [threadRoute, threadId, post, revision, bytes, `Controlled reply ${position}`],
    );
    return {
      value: null,
      events: [
        {
          type: 'com.rezics.content.post.created.v1',
          subject: post,
          data: { threadId, itemId: post, revisionId: revision, actorId: authorId, ...SUBJECT_THREAD_EVENT_FIELDS },
        },
      ],
    };
  });
  return post;
}

/** Three threads on a fresh Board, newest first; the Board's newest page takes the two most recent. */
async function newestBoard() {
  const id = await board();
  const threads = [];
  for (const position of [1, 2, 3]) threads.push(await thread(id, position, `Controlled newest thread ${position}`));
  return { id, threads };
}

/** A thread with three posts: the opening post and two replies, in creation order. */
async function postsThread(boardId: string) {
  const opened = await thread(boardId, 4, 'Controlled posts thread');
  await reply(opened.id, 1);
  await reply(opened.id, 2);
  return opened;
}

async function takedown(boardId: string) {
  await db.admin.query(
    'UPDATE content.board SET visibility=$3, security_revision=security_revision+1 WHERE route=$1 AND board_id=$2',
    [routeOf(boardId), boardId, 'taken_down'],
  );
}

async function get(path: string) {
  const response = await app.handle(new Request(`http://kernel.test${path}`));
  const text = await response.clone().text();
  return { response, text, body: response.status === 200 ? (JSON.parse(text) as Record<string, unknown>) : null };
}

/** Holds one table's lock so that a read reaching it waits; the caller commits its change during the hold. */
async function holdTable(table: 'content.thread' | 'content.reaction_total') {
  const lock = await db.pool.connect();
  await lock.query('BEGIN');
  await lock.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
  return {
    async release() {
      try {
        await lock.query('ROLLBACK');
      } finally {
        lock.release();
      }
    },
  };
}

async function waitForLockWait(table: string) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const waiting = await db.pool.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE datname=current_database() AND wait_event_type='Lock' AND position($1::text in query) > 0
       LIMIT 1`,
      [table],
    );
    if (waiting.rowCount) return;
    if (Date.now() >= deadline) throw new Error(`Page never reached its ${table} read`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Holds one page request at its read; a Board id commits a takedown during the hold, null leaves the page unchanged. */
async function heldPage(path: string, table: 'content.thread' | 'content.reaction_total', boardId: string | null) {
  const lock = await holdTable(table);
  const pending = get(path);
  pending.catch(() => undefined);
  try {
    await waitForLockWait(table);
    if (boardId !== null) await takedown(boardId);
  } finally {
    await lock.release();
  }
  return pending;
}

async function unheldPage(path: string) {
  return get(path);
}

test('late-board-revocation-pages: newest board first and continuation pages conceal a late Board takedown', async () => {
  const first = await newestBoard();
  const firstPath = `/v1/boards/${first.id}/threads?sort=newest&limit=2`;
  const firstPage = await unheldPage(firstPath);
  expect(firstPage.response.status).toBe(200);
  expect(firstPage.body?.threads as unknown[]).toHaveLength(2);
  expect(firstPage.body?.next).not.toBeNull();
  const late = await heldPage(firstPath, 'content.thread', first.id);
  expect(late.response.status).toBe(404);
  for (const item of first.threads) expect(late.text).not.toContain(item.id);

  const continuing = await newestBoard();
  const continuingFirst = await unheldPage(`/v1/boards/${continuing.id}/threads?sort=newest&limit=2`);
  const cursor = continuingFirst.body?.next as string;
  expect(typeof cursor).toBe('string');
  const continuingPath = `/v1/boards/${continuing.id}/threads?sort=newest&limit=2&cursor=${encodeURIComponent(cursor)}`;
  const expected = await unheldPage(continuingPath);
  expect(expected.response.status).toBe(200);
  const lateContinuation = await heldPage(continuingPath, 'content.thread', continuing.id);
  expect(lateContinuation.response.status).toBe(404);
  for (const item of continuing.threads) expect(lateContinuation.text).not.toContain(item.id);

  const control = await newestBoard();
  const controlPath = `/v1/boards/${control.id}/threads?sort=newest&limit=2`;
  const controlFirst = await unheldPage(controlPath);
  const controlCursor = controlFirst.body?.next as string;
  const controlContinuation = `/v1/boards/${control.id}/threads?sort=newest&limit=2&cursor=${encodeURIComponent(controlCursor)}`;
  const baseline = await unheldPage(controlContinuation);
  expect(baseline.response.status).toBe(200);
  const unchanged = await heldPage(controlContinuation, 'content.thread', null);
  expect(unchanged.response.status).toBe(200);
  expect(unchanged.body).toEqual(baseline.body);
});

test('late-board-revocation-pages: thread post first and continuation pages conceal a late Board takedown', async () => {
  const first = await postsThread(await board());
  const firstPath = `/v1/threads/${first.id}/posts?limit=2`;
  const firstPage = await unheldPage(firstPath);
  expect(firstPage.response.status).toBe(200);
  expect(firstPage.body?.posts as unknown[]).toHaveLength(2);
  const late = await heldPage(firstPath, 'content.reaction_total', await boardIdOf(first.id));
  expect(late.response.status).toBe(404);
  expect(late.text).not.toContain(first.id);

  const continuing = await postsThread(await board());
  const continuingFirst = await unheldPage(`/v1/threads/${continuing.id}/posts?limit=2`);
  const cursor = continuingFirst.body?.next as string;
  expect(typeof cursor).toBe('string');
  const continuingPath = `/v1/threads/${continuing.id}/posts?limit=2&cursor=${encodeURIComponent(cursor)}`;
  const expected = await unheldPage(continuingPath);
  expect(expected.response.status).toBe(200);
  const lateContinuation = await heldPage(continuingPath, 'content.reaction_total', await boardIdOf(continuing.id));
  expect(lateContinuation.response.status).toBe(404);
  expect(lateContinuation.text).not.toContain(continuing.id);

  const control = await postsThread(await board());
  const controlPath = `/v1/threads/${control.id}/posts?limit=2`;
  const controlBaseline = await unheldPage(controlPath);
  expect(controlBaseline.response.status).toBe(200);
  const unchanged = await heldPage(controlPath, 'content.reaction_total', null);
  expect(unchanged.response.status).toBe(200);
  expect(unchanged.body).toEqual(controlBaseline.body);
});

/** The Board that a thread sits on, read from the same thread row the page uses. */
async function boardIdOf(threadId: string) {
  const rows = await db.pool.query<{ board_id: string }>(
    'SELECT board_id::text AS board_id FROM content.thread WHERE route=$1 AND thread_id=$2',
    [threadRoute, threadId],
  );
  return rows.rows[0]!.board_id;
}
