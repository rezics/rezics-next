import { afterAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createHash, randomUUID } from 'node:crypto';
import { runCommand } from '../../src/command/command.ts';
import { anonymousAccess } from '../../src/request/access.ts';
import { listBoardThreads, type BoardPageInput, type ContentBoardDependencies } from '../../src/content/boards.ts';
import { refreshBoardRankBatch } from '../../src/content/board-rank.ts';
import { createBoardEffect } from '../../src/content/board-projection.ts';
import { readBatch, type CloudEvent } from '../../src/events/log.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';
import { SUBJECT_THREAD_EVENT_FIELDS } from '../support/subject-thread-event.ts';

const db = await openGrowthDatabase();
afterAll(() => db.close());

const sourceRoute = 0x1234;
const boardRoute = 0x5678;
const growthAuthorId = newId(0x9abc);
const tokenKeys = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(9)]]) };
const createdType = 'com.rezics.content.thread.created.v1';
const replyType = 'com.rezics.content.post.created.v1';
const baseCreatedAt = '2026-10-25T00:00:00.000Z';
const refreshAt = '2026-10-26T12:00:00.000Z';
const growingRelations = new Set([
  'access.account',
  'access.membership_inverse',
  'access.resource_grant',
  'access.resource_role_grant',
  'community.realm_member',
  'community.space',
  'community.space_revision',
  'community.realm',
  'community.realm_revision',
  'content.board',
  'content.board_thread',
  'content.thread',
  'content.post',
  'content.revision',
]);

type SourceThread = {
  boardId: string;
  threadId: string;
  authorId: string;
  itemId: string;
  revisionId: string;
  createdAt: string;
};

type RankedPage = Awaited<ReturnType<typeof listBoardThreads>> & { rankRefreshedAt: string | null };

function readerContext() {
  return { actor: { kind: 'anonymous' as const }, deadline: Date.now() + 10_000 };
}

function dependencies(pool = db.pool): ContentBoardDependencies {
  return {
    pool,
    access: anonymousAccess,
    tokens: tokenKeys,
    cursorNow: () => Date.parse(refreshAt),
  };
}

function activePageInput(input: { limit: number; cursor?: string }): BoardPageInput {
  return { ...input, sort: 'active' } as unknown as BoardPageInput;
}

async function createBoard(): Promise<string> {
  const boardId = newId(boardRoute);
  await db.admin.query(
    `INSERT INTO content.board
      (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
     VALUES ($1, $2, $3, 'Ranked board', 'published', 1, $4)`,
    [boardRoute, boardId, newId(boardRoute), randomUUID()],
  );
  return boardId;
}

async function createSourceThread(boardId: string, createdAt: string): Promise<SourceThread> {
  const threadId = newId(sourceRoute);
  const authorId = newId(0x9abc);
  const itemId = newId(sourceRoute);
  const revisionId = newId(sourceRoute);
  const body = Buffer.from(JSON.stringify(fromPlainText(`Thread ${threadId}`)));
  const digest = createHash('sha256').update(body).digest();
  await runCommand(db.pool, { partition: partitionOf(sourceRoute) }, async (tx, context) => {
    await tx.query(
      `INSERT INTO content.thread
        (route, thread_id, author_account_id, board_id, title, visibility, security_revision,
         recorded_transaction_id, first_post_id, created_at)
       VALUES ($1, $2, $3, $4, 'Ranked thread', 'published', 1, $5, $6, $7)`,
      [sourceRoute, threadId, authorId, boardId, context.transactionId, itemId, createdAt],
    );
    await tx.query(
      `INSERT INTO content.post
        (route, thread_id, post_id, author_account_id, head_revision_id, visibility, security_revision,
         recorded_transaction_id, created_at)
       VALUES ($1, $2, $3, $4, $5, 'published', 1, $6, $7)`,
      [sourceRoute, threadId, itemId, authorId, revisionId, context.transactionId, createdAt],
    );
    await tx.query(
      `INSERT INTO content.revision
        (route, thread_id, post_id, revision_id, body, body_sha256, search_text, licence,
         subject_ids, board_id, availability, recorded_transaction_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'MIT', '{}', $8, 'available', $9, $10)`,
      [
        sourceRoute,
        threadId,
        itemId,
        revisionId,
        body,
        digest,
        `Thread ${threadId}`,
        boardId,
        context.transactionId,
        createdAt,
      ],
    );
    return {
      value: null,
      events: [
        {
          type: createdType,
          subject: threadId,
          data: { threadId, itemId, revisionId, actorId: authorId, ...SUBJECT_THREAD_EVENT_FIELDS },
        },
      ],
    };
  });
  return { boardId, threadId, authorId, itemId, revisionId, createdAt };
}

async function createReply(thread: SourceThread, createdAt: string): Promise<string> {
  const postId = newId(sourceRoute);
  const revisionId = newId(sourceRoute);
  const body = Buffer.from(JSON.stringify(fromPlainText(`Reply ${postId}`)));
  const digest = createHash('sha256').update(body).digest();
  await runCommand(db.pool, { partition: partitionOf(sourceRoute) }, async (tx, context) => {
    await tx.query(
      `INSERT INTO content.post
        (route, thread_id, post_id, reply_to_post_id, author_account_id, head_revision_id, visibility,
         security_revision, recorded_transaction_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'published', 1, $7, $8)`,
      [
        sourceRoute,
        thread.threadId,
        postId,
        thread.itemId,
        thread.authorId,
        revisionId,
        context.transactionId,
        createdAt,
      ],
    );
    await tx.query(
      `INSERT INTO content.revision
        (route, thread_id, post_id, revision_id, body, body_sha256, search_text, licence,
         subject_ids, board_id, availability, recorded_transaction_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'MIT', '{}', $8, 'available', $9, $10)`,
      [
        sourceRoute,
        thread.threadId,
        postId,
        revisionId,
        body,
        digest,
        `Reply ${postId}`,
        thread.boardId,
        context.transactionId,
        createdAt,
      ],
    );
    return {
      value: null,
      events: [
        {
          type: replyType,
          subject: postId,
          data: {
            threadId: thread.threadId,
            itemId: postId,
            revisionId,
            actorId: thread.authorId,
            ...SUBJECT_THREAD_EVENT_FIELDS,
          },
        },
      ],
    };
  });
  return postId;
}

async function readEvents(): Promise<CloudEvent[]> {
  const events: CloudEvent[] = [];
  const result = await readBatch(db.pool, {
    partition: partitionOf(sourceRoute),
    consumer: `board_rank_${randomUUID().replaceAll('-', '')}`,
    apply: async (envelopes) => {
      events.push(...envelopes.flatMap((envelope) => envelope.events));
    },
  });
  expect(result.status).toBe('read');
  return events;
}

async function project(events: readonly CloudEvent[]): Promise<void> {
  const effect = createBoardEffect(db.pool);
  for (const event of events) {
    if (event.type === createdType || event.type === replyType) await effect.run(event);
  }
}

async function rankRow(threadId: string): Promise<{ last_activity_at: string; rank_refreshed_at: string }> {
  const result = await db.admin.query<{ last_activity_at: string; rank_refreshed_at: string }>(
    `SELECT to_char(last_activity_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_activity_at,
            to_char(rank_refreshed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS rank_refreshed_at
     FROM content.board_thread WHERE route = $1 AND thread_id = $2`,
    [boardRoute, threadId],
  );
  return result.rows[0]!;
}

function growthPopulation(activeRank: number): Population {
  const body = Buffer.from(JSON.stringify(fromPlainText('A fixed rank growth body')));
  const bodyHash = createHash('sha256').update(body).digest();
  return {
    name: `board-rank-growth-${randomUUID()}`,
    hotPartition: partitionOf(sourceRoute),
    hotShare: 1,
    rows: ({ ordinal, route }) => {
      const threadId = newId(route);
      const postId = newId(route);
      const revisionId = newId(route);
      const boardId = newId(boardRoute);
      const subjectId = newId(boardRoute);
      const accountId = newId(boardRoute);
      const spaceId = newId(boardRoute);
      const spaceRevisionId = newId(boardRoute);
      const realmId = newId(boardRoute);
      const realmRevisionId = newId(boardRoute);
      const reservationId = newId(boardRoute);
      const transactionId = randomUUID();
      const at = '2000-01-01T00:00:00.000Z';
      return {
        'access.account': [
          { route: boardRoute, account_id: accountId, kind: 'actor', state: 'active', transaction_id: transactionId },
        ],
        'access.membership_inverse': [
          {
            route: boardRoute,
            account_id: accountId,
            kind: 'realm',
            group_id: realmId,
            reservation_id: reservationId,
            transaction_id: transactionId,
          },
        ],
        'access.resource_grant': [
          {
            route: boardRoute,
            resource_id: boardId,
            subject_id: accountId,
            subject_role: '',
            action: 'board:read',
            valid: '(,)',
            transaction_id: transactionId,
          },
        ],
        'access.resource_role_grant': [
          {
            route: boardRoute,
            resource_id: realmId,
            subject_kind: 'identity',
            subject_id: accountId,
            subject_role: '',
            grant_role: 'community.realm.member',
            valid: '(,)',
            transaction_id: transactionId,
          },
        ],
        'community.realm_member': [
          {
            route: boardRoute,
            realm_id: realmId,
            account_id: accountId,
            role: 'member',
            valid: '(,)',
            reservation_id: reservationId,
            transaction_id: transactionId,
          },
        ],
        'community.space': [
          {
            route: boardRoute,
            space_id: spaceId,
            state: 'active',
            head_revision_id: spaceRevisionId,
            created_at: at,
            creator: accountId,
          },
        ],
        'community.space_revision': [
          {
            route: boardRoute,
            space_id: spaceId,
            revision_id: spaceRevisionId,
            predecessor: null,
            title: 'Other ranked-board host',
            summary: '',
            created_at: at,
            author: accountId,
          },
        ],
        'community.realm': [
          {
            route: boardRoute,
            realm_id: realmId,
            space_id: spaceId,
            state: 'active',
            visibility: 'public',
            context_id: GLOBAL_CONTEXT,
            head_revision_id: realmRevisionId,
            created_at: at,
            creator: accountId,
          },
        ],
        'community.realm_revision': [
          {
            route: boardRoute,
            realm_id: realmId,
            revision_id: realmRevisionId,
            predecessor: null,
            title: 'Other ranked-board Realm',
            summary: '',
            visibility: 'public',
            context_id: GLOBAL_CONTEXT,
            created_at: at,
            author: accountId,
          },
        ],
        'content.board': [
          {
            route: boardRoute,
            board_id: boardId,
            realm_id: realmId,
            subject_id: subjectId,
            title: 'Rank growth board',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            created_at: at,
          },
        ],
        'content.thread': [
          {
            route,
            thread_id: threadId,
            author_account_id: growthAuthorId,
            board_id: boardId,
            title: 'Rank growth thread',
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            created_at: at,
            first_post_id: postId,
            availability: 'available',
          },
        ],
        'content.post': [
          {
            route,
            thread_id: threadId,
            post_id: postId,
            reply_to_post_id: null,
            author_account_id: growthAuthorId,
            head_revision_id: revisionId,
            visibility: 'published',
            security_revision: 1,
            recorded_transaction_id: transactionId,
            created_at: at,
            availability: 'available',
          },
        ],
        'content.revision': [
          {
            route,
            thread_id: threadId,
            post_id: postId,
            revision_id: revisionId,
            body,
            body_sha256: bodyHash,
            search_text: 'A fixed rank growth body',
            licence: 'MIT',
            subject_ids: [],
            board_id: boardId,
            availability: 'available',
            recorded_transaction_id: transactionId,
            recorded_at: at,
            media_ids: [],
          },
        ],
        'content.board_thread': [
          {
            route: boardRoute,
            board_id: boardId,
            thread_id: threadId,
            created_at: at,
            last_activity_at: at,
            score: 0,
            active_rank: activeRank,
            rank_refreshed_at: at,
            source_epoch: 1,
            source_position: ordinal + 1,
            source_revision_id: revisionId,
          },
        ],
      };
    },
  };
}

test.serial(
  'a reply moves its thread activity and active listing uses the rank keyset cursor',
  async () => {
    const boardId = await createBoard();
    const now = Date.now();
    const repliedThread = await createSourceThread(boardId, new Date(now - 6 * 60 * 60_000).toISOString());
    const otherThread = await createSourceThread(boardId, new Date(now - 2 * 60 * 60_000).toISOString());
    const replyAt = new Date(now - 60 * 60_000).toISOString();
    const replyId = await createReply(repliedThread, replyAt);
    const events = await readEvents();
    await project(events);

    expect(await rankRow(repliedThread.threadId)).toMatchObject({
      last_activity_at: replyAt.replace('Z', '000Z'),
    });

    const first = (await listBoardThreads(
      dependencies(),
      boardId,
      readerContext(),
      activePageInput({ limit: 1 }),
    )) as RankedPage;
    expect(first.entries.map(({ id }) => id)).toEqual([repliedThread.threadId]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.rankRefreshedAt).toBe((await rankRow(repliedThread.threadId)).rank_refreshed_at);

    const second = (await listBoardThreads(
      dependencies(),
      boardId,
      readerContext(),
      activePageInput({ limit: 1, cursor: first.nextCursor! }),
    )) as RankedPage;
    expect(second.entries.map(({ id }) => id)).toEqual([otherThread.threadId]);
    await expect(
      listBoardThreads(dependencies(), boardId, readerContext(), {
        limit: 1,
        sort: 'newest',
        cursor: first.nextCursor!,
      }),
    ).rejects.toThrow(TypeError);
    expect(replyId).toEqual(expect.any(String));
  },
  30_000,
);

test.serial('rank refresh skips zero rows and updates no more than 500 rows per batch', async () => {
  const batchAt = new Date().toISOString();
  const staleAt = new Date(Date.parse(batchAt) - 60 * 60_000).toISOString();
  const boardId = newId(boardRoute);
  const rows = Array.from({ length: 504 }, (_, index) => ({ threadId: newId(sourceRoute), zero: index >= 502 }));
  await db.admin.query(
    `INSERT INTO content.board_thread
       (route, board_id, thread_id, created_at, last_activity_at, score, active_rank, rank_refreshed_at,
        source_epoch, source_position, source_revision_id)
     SELECT $1::integer, $2::uuid, entry.thread_id, $3::timestamptz, $4::timestamptz, 0,
            CASE WHEN entry.zero THEN 0::double precision ELSE 1::double precision END,
            $4::timestamptz, 1, entry.ordinal, NULL
     FROM jsonb_to_recordset($5::jsonb) AS entry(thread_id uuid, zero boolean, ordinal bigint)`,
    [
      boardRoute,
      boardId,
      baseCreatedAt,
      staleAt,
      JSON.stringify(rows.map((row, index) => ({ thread_id: row.threadId, zero: row.zero, ordinal: index + 1 }))),
    ],
  );

  const first = await refreshBoardRankBatch(db.pool, new Date(batchAt), [partitionOf(boardRoute)]);
  const second = await refreshBoardRankBatch(db.pool, new Date(batchAt), [partitionOf(boardRoute)]);
  expect(first).toBe(500);
  expect(second).toBe(2);
  const stored = await db.admin.query<{ active_rank: number; rank_refreshed_at: Date }>(
    `SELECT active_rank, rank_refreshed_at FROM content.board_thread WHERE route = $1 AND board_id = $2`,
    [boardRoute, boardId],
  );
  expect(stored.rows.filter((row) => row.active_rank > 0)).toHaveLength(502);
  expect(
    stored.rows.filter((row) => row.rank_refreshed_at.toISOString() === new Date(batchAt).toISOString()),
  ).toHaveLength(502);
  expect(
    stored.rows.filter((row) => row.active_rank === 0 && row.rank_refreshed_at.toISOString() === staleAt),
  ).toHaveLength(2);
  expect(stored.rows.find((row) => row.active_rank > 0)?.active_rank).toBeCloseTo(Math.log10(2) / Math.pow(3, 1.8));
});

test.serial(
  'active board pages keep constant cost as boards and threads grow',
  async () => {
    const boardId = await createBoard();
    const anchor = await createSourceThread(boardId, new Date(Date.now() - 60 * 60_000).toISOString());
    await project(await readEvents());
    const pagePopulation = growthPopulation(0);
    const scales = [8, 32, 128] as const;
    // Grow grants, memberships, Realms, boards, and threads on other resources at 500 × scale; keep the requested board and page fixed.
    const pageReport = await checkGrowth(db, {
      name: 'active board page',
      scales,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      repetitions: 1,
      grow: async (growthDb, scale, previous) =>
        seed({ pool: growthDb.pool, admin: growthDb.admin }, pagePopulation, { from: 500 * previous, to: 500 * scale }),
      operation: async (growthDb) => {
        const page = (await listBoardThreads(
          dependencies(growthDb.pool),
          boardId,
          readerContext(),
          activePageInput({ limit: 1 }),
        )) as RankedPage;
        expect(page.entries.map(({ id }) => id)).toEqual([anchor.threadId]);
        return page;
      },
    });
    expect(pageReport.samples.map(({ scale }) => scale)).toEqual([...scales]);
    for (const { cost } of pageReport.samples)
      for (const [name, relation] of Object.entries(cost.relations ?? {}))
        if (growingRelations.has(name)) expect(relation.sequentialScans).toBe(0);
  },
  180_000,
);
