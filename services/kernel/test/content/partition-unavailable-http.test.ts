import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { runCommand } from '../../src/command/command.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { threadTarget } from '../../src/content/commands.ts';
import { standingFixture } from '../access/standing-fixture.ts';
import { openGrowthDatabase } from '../support/growth.ts';

const routeKey = new Uint8Array(32).fill(71);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(72)]]) };
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let fixture: Awaited<ReturnType<typeof standingFixture>>;
let anonymousApp: ReturnType<typeof createKernel>;
let memberApp: ReturnType<typeof createKernel>;

beforeAll(async () => {
  db = await openGrowthDatabase();
  fixture = await standingFixture();
  await fixture.reset();
  const authenticate = fixture.access.authenticate;
  fixture.access.authenticate = (token, boundary) => authenticate(token, { ...boundary, pool: db.pool });
  anonymousApp = createKernel({ pool: db.pool, routeKey, tokens });
  memberApp = createKernel({
    pool: db.pool,
    routeKey,
    tokens,
    access: fixture.access,
    writeRate: createWriteRateLimiter({ secret: 'partition-unavailable-test-secret-at-least-32-bytes' }),
  });
});

afterAll(async () => {
  await fixture?.close();
  await db?.close();
});

async function credential(accountId: string) {
  const authenticate = fixture.access.authenticate;
  let bearer = '';
  fixture.access.authenticate = (token, boundary) => {
    bearer = token;
    return authenticate(token, { ...boundary, pool: db.pool });
  };
  try {
    const context = await fixture.context(accountId);
    return { actor: context.actor, bearer };
  } finally {
    fixture.access.authenticate = authenticate;
  }
}

async function createBoard(route: number, actorId: string) {
  const boardId = newId(route);
  const realmId = newId(route);
  const conceptId = newId(route);
  await runCommand(db.pool, { partition: partitionOf(route) }, async (tx, command) => {
    await tx.query(
      `INSERT INTO content.board
         (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
       VALUES ($1, $2, $3, 'Partition test board', 'published', 1, $4)`,
      [route, boardId, conceptId, command.transactionId],
    );
    return {
      value: null,
      events: [
        {
          type: 'com.rezics.content.board.created.v1',
          subject: boardId,
          data: { boardId, realmId, conceptId, actorId },
        },
      ],
    };
  });
  await fixture.grant(actorId, 'board:read', { route, id: boardId });
  await fixture.grant(actorId, 'thread:create', { route, id: boardId });
  return boardId;
}

async function postThread(boardId: string, bearer: string, idempotencyKey: string) {
  const response = await memberApp.handle(
    new Request('http://kernel.test/v1/threads', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        'idempotency-key': JSON.stringify(idempotencyKey),
      },
      body: JSON.stringify({
        title: 'Partition test thread',
        body: fromPlainText('Partition test body'),
        licence: 'MIT',
        subjectIds: [],
        boardId,
        visibility: 'published',
      }),
    }),
  );
  const value = await response.json();
  if (response.status !== 201) throw new Error(`Thread setup failed: ${response.status} ${JSON.stringify(value)}`);
  return (value as { thread: { id: string; firstPost: { id: string } } }).thread;
}

async function get(path: string, bearer?: string) {
  const app = bearer === undefined ? anonymousApp : memberApp;
  const response = await app.handle(
    new Request(`http://kernel.test${path}`, {
      headers: bearer === undefined ? {} : { authorization: `Bearer ${bearer}` },
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}

async function effects(boardId: string, threadId: string, partition: number) {
  const result = await db.admin.query(
    `SELECT
       (SELECT to_jsonb(board) FROM content.board AS board WHERE board.route=$1 AND board.board_id=$2) AS board,
       (SELECT to_jsonb(thread) FROM content.thread AS thread WHERE thread.route=$3 AND thread.thread_id=$4) AS thread,
       (SELECT count(*)::integer FROM content.post WHERE route=$3 AND thread_id=$4) AS posts,
       (SELECT count(*)::integer FROM content.revision WHERE route=$3 AND thread_id=$4) AS revisions,
       (SELECT count(*)::integer FROM content.board_thread WHERE route=$1 AND board_id=$2) AS board_threads,
       (SELECT to_jsonb(partition) FROM core.partition AS partition WHERE partition.partition_no=$5) AS partition,
       (SELECT count(*)::integer FROM core.receipt WHERE partition_no=$5) AS receipts,
       (SELECT count(*)::integer FROM core.outbox WHERE partition_no=$5) AS events`,
    [routeOf(boardId), boardId, routeOf(threadId), threadId, partition],
  );
  return result.rows[0];
}

test('thread and board thread reads report moved partitions without effects and recover when active', async () => {
  const { actor, bearer } = await credential(fixture.actor);
  const key = crypto.randomUUID();
  const route = threadTarget(routeKey, actor.accountId, key).route;
  const boardId = await createBoard(route, actor.accountId);
  const thread = await postThread(boardId, bearer, key);
  const partition = partitionOf(route);
  await fixture.grant(actor.accountId, 'thread:read', { route, id: thread.id });
  await fixture.grant(actor.accountId, 'post:read', { route, id: thread.firstPost.id });

  await db.admin.query(
    "UPDATE core.partition SET write_state='moved', moved_to='content-node-2' WHERE partition_no=$1",
    [partition],
  );
  try {
    const before = await effects(boardId, thread.id, partition);
    for (const reader of [undefined, bearer]) {
      for (const path of [`/v1/threads/${thread.id}`, `/v1/boards/${boardId}/threads`]) {
        const result = await get(path, reader);
        expect(result.response.status).toBe(503);
        expect(result.body.code).toBe('partition_unavailable');
        expect(result.response.headers.get('retry-after')).toBeTruthy();
      }
    }
    expect(await effects(boardId, thread.id, partition)).toEqual(before);
  } finally {
    await db.admin.query("UPDATE core.partition SET write_state='active', moved_to=NULL WHERE partition_no=$1", [
      partition,
    ]);
  }

  for (const reader of [undefined, bearer]) {
    const threadRead = await get(`/v1/threads/${thread.id}`, reader);
    expect(threadRead.response.status).toBe(200);
    expect(threadRead.body.thread.id).toBe(thread.id);
    const boardRead = await get(`/v1/boards/${boardId}/threads`, reader);
    expect(boardRead.response.status).toBe(200);
    expect(boardRead.body.threads.some((entry: { id: string }) => entry.id === thread.id)).toBe(true);
  }
});
