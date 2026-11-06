import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { runCommand } from '../../src/command/command.ts';
import type { DisclosureBarrier } from '../../src/content/reads.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';
import { SUBJECT_THREAD_EVENT_FIELDS } from '../support/subject-thread-event.ts';

// A Board takedown committed after a point read's Board check must not reach its final response, for anonymous
// readers of a published Board. Thread head and post head pause on the reaction-totals read, which follows their final
// disclosure. Exact revision pauses at the disclosure seam, before its final disclosure. The pauses only hold the
// request. The takedown is a committed Board row change, and the reads run through the production kernel.
// Protected read-grant revocation needs an account fixture and is covered by the composed user-case suite.
const routeKey = new Uint8Array(32).fill(7);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
const boardRoute = 0x4321;
const threadRoute = 0x1234;
const subjectRoute = 0x6790;
const authorId = newId(0x9abc);
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let app: ReturnType<typeof createKernel>;
const now = Date.now();

type Hold = { entered: () => void; released: Promise<void> };
const seamHolds = new Map<string, Hold>();
const disclosureBarrier: DisclosureBarrier = async (target) => {
  const key = target.postId ?? target.threadId;
  const hold = seamHolds.get(key);
  if (!hold) return;
  seamHolds.delete(key);
  hold.entered();
  await hold.released;
};

beforeAll(async () => {
  db = await openGrowthDatabase();
  app = createKernel({
    pool: db.pool,
    routeKey,
    tokens,
    receiptKeys: testReceiptKeys(),
    content: { cursorNow: () => now, disclosureBarrier },
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

async function thread(boardId: string, text = 'Controlled late opening') {
  const id = newId(threadRoute);
  const post = newId(threadRoute);
  const revision = newId(threadRoute);
  const bytes = Buffer.from(JSON.stringify(fromPlainText(text)));
  await runCommand(db.pool, { partition: partitionOf(threadRoute) }, async (tx) => {
    await tx.query(
      `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id,created_at)
       VALUES ($1,$2,$3,$4,'Controlled late title','published',1,$2,$5,'2026-10-24T00:00:00.000Z')`,
      [threadRoute, id, authorId, boardId, post],
    );
    await tx.query(
      `INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
       VALUES ($1,$2,$3,$4,$5,'published',1,$3)`,
      [threadRoute, id, post, authorId, revision],
    );
    await tx.query(
      `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
       VALUES ($1,$2,$3,$4,$5,sha256($5),$6,'MIT','{}',$7,'available',$4)`,
      [threadRoute, id, post, revision, bytes, text, boardId],
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
            actorId: authorId,
            ...SUBJECT_THREAD_EVENT_FIELDS,
          },
        },
      ],
    };
  });
  return { id, post, revision };
}

/** A committed taken-down Board row: visibility and security revision, as the read path observes them. */
async function takedown(boardId: string) {
  await db.admin.query(
    'UPDATE content.board SET visibility=$3, security_revision=security_revision+1 WHERE route=$1 AND board_id=$2',
    [routeOf(boardId), boardId, 'taken_down'],
  );
}

async function get(path: string) {
  const response = await app.handle(new Request(`http://kernel.test${path}`));
  const text = await response.clone().text();
  return { response, text, body: response.status === 200 ? (JSON.parse(text) as unknown) : null };
}

/** Holds reaction-totals reads. A Board change committed during the hold cannot wait for the lock. */
async function holdReactionTotals() {
  const lock = await db.pool.connect();
  await lock.query('BEGIN');
  await lock.query('LOCK TABLE content.reaction_total IN ACCESS EXCLUSIVE MODE');
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

async function waitForReactionTotalsWait() {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const waiting = await db.pool.query(
      `SELECT 1 FROM pg_stat_activity
       WHERE datname=current_database() AND wait_event_type='Lock' AND position('content.reaction_total' in query) > 0
       LIMIT 1`,
    );
    if (waiting.rowCount) return;
    if (Date.now() >= deadline) throw new Error('Read never reached its reaction-totals lock');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function heldUntilReactionTotals(path: string, change: 'takedown' | 'none', boardId: string) {
  const lock = await holdReactionTotals();
  const pending = get(path);
  // A failed wait must not leave the request's rejection unobserved; the caller still receives it on success.
  pending.catch(() => undefined);
  try {
    await waitForReactionTotalsWait();
    if (change === 'takedown') await takedown(boardId);
  } finally {
    await lock.release();
  }
  return pending;
}

async function heldAtSeam(path: string, target: string, change: 'takedown' | 'none', boardId: string) {
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  seamHolds.set(target, { entered, released });
  const pending = get(path);
  pending.catch(() => undefined);
  try {
    await reached;
    if (change === 'takedown') await takedown(boardId);
  } finally {
    release();
  }
  return pending;
}

test('late-board-revocation-point-reads: anonymous thread head conceals a Board takedown committed after its Board check', async () => {
  const boardId = await board();
  const { id } = await thread(boardId);
  const path = `/v1/threads/${id}`;
  expect((await get(path)).response.status).toBe(200);
  const late = await heldUntilReactionTotals(path, 'takedown', boardId);
  expect(late.response.status).toBe(404);
  expect(late.text).not.toContain(id);
  expect(late.text).not.toContain('Controlled late title');

  const controlBoard = await board();
  const control = await thread(controlBoard);
  const controlPath = `/v1/threads/${control.id}`;
  const expected = await get(controlPath);
  const unchanged = await heldUntilReactionTotals(controlPath, 'none', controlBoard);
  expect(unchanged.response.status).toBe(200);
  expect(unchanged.body).toEqual(expected.body);
});

test('late-board-revocation-point-reads: anonymous post head conceals a Board takedown committed after its Board check', async () => {
  const boardId = await board();
  const { post } = await thread(boardId);
  const path = `/v1/posts/${post}`;
  expect((await get(path)).response.status).toBe(200);
  const late = await heldUntilReactionTotals(path, 'takedown', boardId);
  expect(late.response.status).toBe(404);
  expect(late.text).not.toContain(post);

  const controlBoard = await board();
  const control = await thread(controlBoard);
  const controlPath = `/v1/posts/${control.post}`;
  const expected = await get(controlPath);
  const unchanged = await heldUntilReactionTotals(controlPath, 'none', controlBoard);
  expect(unchanged.response.status).toBe(200);
  expect(unchanged.body).toEqual(expected.body);
});

test('late-board-revocation-point-reads: anonymous exact revision conceals a Board takedown committed after its Board check', async () => {
  const boardId = await board();
  const { post, revision } = await thread(boardId);
  const path = `/v1/posts/${post}/revisions/${revision}`;
  expect((await get(path)).response.status).toBe(200);
  const late = await heldAtSeam(path, post, 'takedown', boardId);
  expect(late.response.status).toBe(404);
  expect(late.text).not.toContain(revision);

  const controlBoard = await board();
  const control = await thread(controlBoard);
  const controlPath = `/v1/posts/${control.post}/revisions/${control.revision}`;
  const unchanged = await heldAtSeam(controlPath, control.post, 'none', controlBoard);
  expect(unchanged.response.status).toBe(200);
});
