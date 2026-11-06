import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { runCommand } from '../../src/command/command.ts';
import type { DisclosureBarrier } from '../../src/content/reads.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { standingFixture } from '../access/standing-fixture.ts';
import { openGrowthDatabase } from '../support/growth.ts';
import { SUBJECT_THREAD_EVENT_FIELDS } from '../support/subject-thread-event.ts';

// A Board change committed after a point read's Board check must not reach the final response. Thread head and post
// head pause on the reaction-totals read, which follows their final disclosure. Exact revision pauses at the
// disclosure seam, before its final disclosure. The pauses only hold the request. The Board and grant changes are
// committed row writes, not the moderation command, and the reads run through the production kernel.
const routeKey = new Uint8Array(32).fill(7);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
const boardRoute = 0x4321;
const threadRoute = 0x1234;
const subject = newId(0x6789);
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let fixture: Awaited<ReturnType<typeof standingFixture>>;
let app: ReturnType<typeof createKernel>;
let readerBearer: string;
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
    await fixture.context(fixture.recipient);
    readerBearer = issued[1]!;
  } finally {
    fixture.access.authenticate = authenticate;
  }
  app = createKernel({
    pool: db.pool,
    routeKey,
    tokens,
    access: fixture.access,
    content: { cursorNow: () => now, disclosureBarrier },
  });
});
afterAll(async () => {
  await fixture?.close();
  await db?.close();
});

async function board(visibility: 'published' | 'protected') {
  const id = newId(boardRoute);
  await db.admin.query(
    `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,'Current board',$4,1,$2)`,
    [boardRoute, id, subject, visibility],
  );
  for (const viewer of [fixture.actor, fixture.recipient]) {
    await fixture.grant(viewer, 'board:read', { route: boardRoute, id });
  }
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
      [threadRoute, id, fixture.actor, boardId, post],
    );
    await tx.query(
      `INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
       VALUES ($1,$2,$3,$4,$5,'published',1,$3)`,
      [threadRoute, id, post, fixture.actor, revision],
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
            actorId: fixture.actor,
            ...SUBJECT_THREAD_EVENT_FIELDS,
          },
        },
      ],
    };
  });
  for (const viewer of [fixture.actor, fixture.recipient]) {
    await fixture.grant(viewer, 'thread:read', { route: threadRoute, id });
    await fixture.grant(viewer, 'post:read', { route: threadRoute, id: post });
  }
  return { id, post, revision };
}

/** A committed taken-down Board row: visibility and security revision, as the read path observes them. */
async function takedown(boardId: string) {
  await db.admin.query(
    'UPDATE content.board SET visibility=$3, security_revision=security_revision+1 WHERE route=$1 AND board_id=$2',
    [routeOf(boardId), boardId, 'taken_down'],
  );
}

/** The reader's Board read grant, removed as a committed Access row change. */
async function revokeReaderBoardRead(boardId: string) {
  await db.admin.query(
    "DELETE FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND action='board:read'",
    [routeOf(boardId), boardId, fixture.recipient],
  );
}

async function get(path: string, bearer?: string) {
  const response = await app.handle(
    new Request(`http://kernel.test${path}`, { headers: bearer ? { authorization: `Bearer ${bearer}` } : {} }),
  );
  const text = await response.clone().text();
  return { response, text, body: response.status === 200 ? (JSON.parse(text) as unknown) : null };
}

/** Holds one reaction-totals read. A Board change committed during the hold cannot wait for the lock. */
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

async function heldUntilReactionTotals(path: string, change: 'takedown' | 'revoke' | 'none', boardId: string) {
  const lock = await holdReactionTotals();
  const pending = get(path, readerBearer);
  // A failed wait must not leave the request's rejection unobserved; the caller still receives it on success.
  pending.catch(() => undefined);
  try {
    await waitForReactionTotalsWait();
    if (change === 'takedown') await takedown(boardId);
    if (change === 'revoke') await revokeReaderBoardRead(boardId);
  } finally {
    await lock.release();
  }
  return pending;
}

async function heldAtSeam(path: string, target: string, change: 'takedown' | 'revoke' | 'none', boardId: string) {
  let entered!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  seamHolds.set(target, { entered, released });
  const pending = get(path, readerBearer);
  pending.catch(() => undefined);
  try {
    await reached;
    if (change === 'takedown') await takedown(boardId);
    if (change === 'revoke') await revokeReaderBoardRead(boardId);
  } finally {
    release();
  }
  return pending;
}

test('late-board-revocation-point-reads: thread head conceals a late Board takedown or protected read-grant revocation', async () => {
  for (const [visibility, change] of [
    ['published', 'takedown'],
    ['protected', 'revoke'],
  ] as const) {
    const boardId = await board(visibility);
    const { id } = await thread(boardId);
    const path = `/v1/threads/${id}`;
    const before = await get(path, readerBearer);
    expect(before.response.status).toBe(200);
    const late = await heldUntilReactionTotals(path, change, boardId);
    expect(late.response.status).toBe(404);
    expect(late.text).not.toContain(id);
    expect(late.text).not.toContain('Controlled late title');

    const control = await board(visibility);
    const controlThread = await thread(control);
    const expected = await get(`/v1/threads/${controlThread.id}`, readerBearer);
    const unchanged = await heldUntilReactionTotals(`/v1/threads/${controlThread.id}`, 'none', control);
    expect(unchanged.response.status).toBe(200);
    expect(unchanged.body).toEqual(expected.body);
  }
});

test('late-board-revocation-point-reads: post head conceals a late Board takedown or protected read-grant revocation', async () => {
  for (const [visibility, change] of [
    ['published', 'takedown'],
    ['protected', 'revoke'],
  ] as const) {
    const boardId = await board(visibility);
    const { post } = await thread(boardId);
    const path = `/v1/posts/${post}`;
    expect((await get(path, readerBearer)).response.status).toBe(200);
    const late = await heldUntilReactionTotals(path, change, boardId);
    expect(late.response.status).toBe(404);
    expect(late.text).not.toContain(post);

    const control = await board(visibility);
    const controlThread = await thread(control);
    const controlPath = `/v1/posts/${controlThread.post}`;
    const expected = await get(controlPath, readerBearer);
    const unchanged = await heldUntilReactionTotals(controlPath, 'none', control);
    expect(unchanged.response.status).toBe(200);
    expect(unchanged.body).toEqual(expected.body);
  }
});

test('late-board-revocation-point-reads: exact revision conceals a Board change committed after its Board check', async () => {
  for (const [visibility, change] of [
    ['published', 'takedown'],
    ['protected', 'revoke'],
  ] as const) {
    const boardId = await board(visibility);
    const { post, revision } = await thread(boardId);
    const path = `/v1/posts/${post}/revisions/${revision}`;
    expect((await get(path, readerBearer)).response.status).toBe(200);
    const late = await heldAtSeam(path, post, change, boardId);
    expect(late.response.status).toBe(404);
    expect(late.text).not.toContain(revision);

    const control = await board(visibility);
    const controlThread = await thread(control);
    const controlPath = `/v1/posts/${controlThread.post}/revisions/${controlThread.revision}`;
    const unchanged = await heldAtSeam(controlPath, controlThread.post, 'none', control);
    expect(unchanged.response.status).toBe(200);
  }
});
