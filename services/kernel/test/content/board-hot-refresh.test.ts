import { afterAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createHash, randomUUID } from 'node:crypto';
import { createAccess as createPermissionAccess } from '../../src/access/permission.ts';
import { installResourceRoleCatalogue, resolveResourceRoles } from '../../src/access/resource-roles.ts';
import { readAccount } from '../../src/access/account-data.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { bundledRelease } from '@rezics/definitions/bundled';
import { createRealm, updateRealm } from '../../src/community/realm.ts';
import { readRealmVotes } from '../../src/community/realm-votes.ts';
import { withConnection } from '../../src/database/pool.ts';
import { createSpace } from '../../src/community/space.ts';
import type { Access, AccountActor } from '../../src/request/access.ts';
import { runCommand } from '../../src/command/command.ts';
import { createBoardEffect } from '../../src/content/board-projection.ts';
import { createReactionCountEffect } from '../../src/content/reaction-projection.ts';
import { refreshBoardRankBatch } from '../../src/content/board-rank.ts';
import { projectBatch, type CloudEvent } from '../../src/events/log.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type GrowthDatabase, type Population } from '../support/growth.ts';
import { productionActions } from '../support/production-actions.ts';

const db = await openGrowthDatabase();
afterAll(() => db.close());

const sourceRoute = 0x1234;
const boardRoute = 0x5678;
const changedType = 'com.rezics.content.reaction.changed.v1';
const threadType = 'com.rezics.content.thread.created.v1';
const replyType = 'com.rezics.content.post.created.v1';
const scales = [256, 1024, 4096] as const;
const staleAt = '2000-01-01T00:00:00.000Z';

type SourceThread = {
  boardId: string;
  threadId: string;
  authorId: string;
  itemId: string;
  createdAt: string;
};

type RankRow = {
  thread_id: string;
  score: number;
  active_rank: number;
  hot_rank: number;
  created_at: Date;
  last_activity_at: Date;
  rank_refreshed_at: Date;
};

function rank(score: number, inputAt: Date, at: Date): number {
  const hours = Math.max(0, (at.getTime() - inputAt.getTime()) / 3_600_000);
  if (at.getTime() - inputAt.getTime() > 7 * 24 * 3_600_000) return 0;
  return Math.log10(Math.max(2, score + 2)) / Math.pow(hours + 2, 1.8);
}

async function createBoard(realmId: string | null = null): Promise<string> {
  const route = realmId === null ? boardRoute : routeOf(realmId)!;
  const boardId = newId(route);
  await db.admin.query(
    `INSERT INTO content.board
      (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id, realm_id)
     VALUES ($1, $2, $3, 'Rank refresh board', 'published', 1, $4, $5)`,
    [route, boardId, newId(route), randomUUID(), realmId],
  );
  return boardId;
}

async function createSourceThread(boardId: string, createdAt: string): Promise<SourceThread> {
  const threadId = newId(sourceRoute);
  const authorId = newId(sourceRoute);
  const itemId = newId(sourceRoute);
  const revisionId = newId(sourceRoute);
  const body = Buffer.from(JSON.stringify(fromPlainText(`Thread ${threadId}`)));
  const digest = createHash('sha256').update(body).digest();
  await runCommand(db.pool, { partition: partitionOf(sourceRoute) }, async (tx, context) => {
    await tx.query(
      `INSERT INTO content.thread
        (route, thread_id, author_account_id, board_id, title, visibility, security_revision,
         recorded_transaction_id, first_post_id, created_at)
       VALUES ($1, $2, $3, $4, 'Rank refresh thread', 'published', 1, $5, $6, $7)`,
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
          type: threadType,
          subject: threadId,
          data: { threadId, itemId, revisionId, actorId: authorId },
        },
      ],
    };
  });
  return { boardId, threadId, authorId, itemId, createdAt };
}

async function createReply(thread: SourceThread, createdAt: string): Promise<void> {
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
          },
        },
      ],
    };
  });
}

async function appendReaction(targetId: string, kind: 'upvote' | 'downvote'): Promise<void> {
  const actorId = newId(sourceRoute);
  await runCommand(db.pool, { partition: partitionOf(sourceRoute) }, async () => ({
    value: null,
    events: [
      {
        type: changedType,
        subject: targetId,
        data: {
          actorId,
          targetKind: 'thread',
          targetId,
          previousKind: null,
          kind,
        },
      },
    ],
  }));
}

async function eventsForSource(): Promise<CloudEvent[]> {
  const events: CloudEvent[] = [];
  const result = await projectBatch(db.pool, {
    consumer: `board_hot_refresh_${randomUUID().replaceAll('-', '')}`,
    partition: partitionOf(sourceRoute),
    apply: async (envelopes) => {
      events.push(...envelopes.flatMap((envelope) => envelope.events));
    },
  });
  expect(result.status).toBe('read');
  return events;
}

async function projectThreads(events: readonly CloudEvent[]): Promise<void> {
  const effect = createBoardEffect(db.pool);
  for (const event of events) if (event.type === threadType || event.type === replyType) await effect.run(event);
}

async function projectReactions(events: readonly CloudEvent[]): Promise<void> {
  const effect = createReactionCountEffect(db.pool);
  for (const event of events) if (event.type === changedType) await effect.run(event);
}

async function rankRows(boardIds: readonly string[], threadIds: readonly string[]): Promise<Map<string, RankRow>> {
  const result = await db.admin.query<RankRow>(
    `SELECT thread_id, score, active_rank, hot_rank, created_at, last_activity_at, rank_refreshed_at
     FROM content.board_thread
     WHERE board_id = ANY($1::uuid[]) AND thread_id = ANY($2::uuid[])`,
    [boardIds, threadIds],
  );
  const rows = new Map<string, RankRow>();
  for (const row of result.rows) rows.set(row.thread_id, row);
  return rows;
}

const roleActions = [
  'realm:participate',
  'realm:join',
  'realm:read',
  'realm:manage',
  'realm:publish',
  'board:create',
  'access:grant',
  'space:read',
  'space:manage',
  'space:create',
  'realm:create',
  'context:read',
];

async function createTestRealm() {
  const accountId = newId(sourceRoute);
  const route = routeOf(accountId)!;
  await db.admin.query(
    `INSERT INTO access.account (route, account_id, kind, state, transaction_id)
     VALUES ($1, $2, 'actor', 'active', $3)`,
    [route, accountId, randomUUID()],
  );
  const account = await readAccount(db.pool, route, accountId);
  if (!account) throw new Error('Realm rank test account is unavailable');
  const actions = productionActions();
  const permissions = createPermissionAccess({
    actions,
    accountEvidence: () => account,
  });
  const access: Access = {
    authenticate: permissions.authenticate.bind(permissions),
    prepare: permissions.prepare!.bind(permissions),
    async authorize() {
      return true;
    },
  };
  installResourceRoleCatalogue(access, resolveResourceRoles(actions));
  const actor: AccountActor = {
    kind: 'account',
    accountId,
    clientId: 'board-rank-test',
    scopes: roleActions,
    requestedBy: null,
    authnEpoch: 1,
  };
  const routeKey = new Uint8Array(32).fill(44);
  const dependencies = { pool: db.pool, access, routeKey };
  await bootstrapRelease(db.pool, bundledRelease);
  const space = await createSpace(
    dependencies,
    actor,
    {
      title: 'Board rank test space',
      summary: 'A fixture for Realm weighted scores.',
    },
    { idempotencyKey: randomUUID(), deadline: Date.now() + 20_000 },
  );
  const realm = await createRealm(
    dependencies,
    actor,
    {
      spaceId: space.value.spaceId,
      title: 'Board rank test Realm',
      visibility: 'public',
      contextId: GLOBAL_CONTEXT,
    },
    { idempotencyKey: randomUUID(), deadline: Date.now() + 20_000 },
  );
  let headRevisionId = realm.value.revisionId;
  return {
    realmId: realm.value.realmId,
    async updateVotes(votes: { upvote: -1; downvote: 1 }) {
      const updated = await updateRealm(
        dependencies,
        actor,
        { realmId: realm.value.realmId, expectedHead: headRevisionId, votes },
        { idempotencyKey: randomUUID(), deadline: Date.now() + 20_000 },
      );
      headRevisionId = updated.value.revisionId;
    },
  };
}

// Every scale step needs 1000 due candidates (two batches of 500), so each ordinal carries several candidates.
const candidatesPerOrdinal = 4;
const dueCandidates = 1000;

function refreshPopulation(baseAt: Date): Population {
  return {
    name: `board-hot-refresh-${randomUUID()}`,
    hotPartition: partitionOf(sourceRoute),
    hotShare: 1,
    rows: ({ ordinal }) => {
      const first = ordinal * candidatesPerOrdinal;
      const dueFrom = (start: number) =>
        first >= start * candidatesPerOrdinal && first < start * candidatesPerOrdinal + dueCandidates;
      const rankRefreshedAt =
        first < dueCandidates
          ? staleAt
          : dueFrom(scales[1])
            ? new Date(baseAt.getTime() - 38 * 60_000).toISOString()
            : dueFrom(scales[0])
              ? new Date(baseAt.getTime() - 49 * 60_000).toISOString()
              : new Date(baseAt.getTime() + 60 * 60_000).toISOString();
      const boards: Record<string, unknown>[] = [];
      const boardThreads: Record<string, unknown>[] = [];
      const totals: Record<string, unknown>[] = [];
      for (let copy = 0; copy < candidatesPerOrdinal; copy++) {
        const boardId = newId(boardRoute);
        const threadId = newId(sourceRoute);
        const sourcePosition = first + copy + 1;
        boards.push({
          route: boardRoute,
          board_id: boardId,
          subject_id: newId(boardRoute),
          title: 'Rank growth board',
          visibility: 'published',
          security_revision: 1,
          recorded_transaction_id: randomUUID(),
          created_at: staleAt,
          realm_id: null,
        });
        boardThreads.push({
          route: boardRoute,
          board_id: boardId,
          thread_id: threadId,
          created_at: staleAt,
          last_activity_at: staleAt,
          score: 0,
          active_rank: 1,
          hot_rank: 1,
          rank_refreshed_at: rankRefreshedAt,
          source_epoch: 1,
          source_position: sourcePosition,
          source_revision_id: null,
        });
        totals.push({
          route: sourceRoute,
          target_id: threadId,
          kind: 'upvote',
          count: 2,
          source_epoch: 1,
          source_position: sourcePosition,
        });
      }
      return {
        'content.board': boards,
        'content.board_thread': boardThreads,
        'content.reaction_total': totals,
      };
    },
  };
}

test.serial(
  'one refresh batch stays within its bound as candidates and reactions grow',
  async () => {
    const baseAt = new Date(Date.now() + 20 * 60_000);
    const population = refreshPopulation(baseAt);
    const refresh = async (_growthDb: GrowthDatabase, _scale: number, repetition: number) => {
      const at = new Date(baseAt.getTime() + repetition * 11 * 60_000);
      const refreshed = await refreshBoardRankBatch(db.pool, at, [partitionOf(boardRoute)]);
      expect(refreshed).toBe(500);
      return refreshed;
    };
    const report = await checkGrowth(db, {
      name: 'one hot rank refresh batch',
      scales,
      bounds: {
        rows: 'constant',
        blocks: 'logarithmic',
        statements: 'constant',
      },
      repetitions: 1,
      grow: async (growthDb, scale, previous) =>
        seed({ pool: growthDb.pool, admin: growthDb.admin }, population, {
          from: previous,
          to: scale,
        }),
      warmup: refresh,
      operation: refresh,
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
    expect(
      report.samples.every((sample) =>
        Object.values(sample.cost.relations ?? {}).every((relation) => relation.sequentialScans === 0),
      ),
    ).toBe(true);
  },
  180_000,
);

test.serial('a new board candidate starts with both ranks at score 0', async () => {
  const boardId = await createBoard();
  const createdAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
  const thread = await createSourceThread(boardId, createdAt);
  await projectThreads(await eventsForSource());
  const row = (await rankRows([boardId], [thread.threadId])).get(thread.threadId)!;
  expect(row.score).toBe(0);
  expect(row.active_rank).toBeCloseTo(rank(0, row.last_activity_at, row.rank_refreshed_at));
  expect(row.hot_rank).toBeCloseTo(rank(0, row.created_at, row.rank_refreshed_at));
});

test.serial(
  'one refresh sets Realm weighted scores and recomputes active and hot ranks',
  async () => {
    const { realmId } = await createTestRealm();
    const outsideBoard = await createBoard();
    const realmBoard = await createBoard(realmId);
    const createdAt = new Date(Date.now() - 36 * 60 * 60_000).toISOString();
    const outsideThread = await createSourceThread(outsideBoard, createdAt);
    const outsideOtherThread = await createSourceThread(outsideBoard, createdAt);
    const realmThread = await createSourceThread(realmBoard, createdAt);
    await createReply(outsideThread, new Date(Date.now() - 3 * 60 * 60_000).toISOString());
    const initialEvents = await eventsForSource();
    await projectThreads(initialEvents);

    for (let vote = 0; vote < 4; vote++) await appendReaction(outsideThread.threadId, 'upvote');
    await appendReaction(outsideThread.threadId, 'downvote');
    await appendReaction(outsideOtherThread.threadId, 'upvote');
    for (let vote = 0; vote < 3; vote++) await appendReaction(outsideOtherThread.threadId, 'downvote');
    await appendReaction(realmThread.threadId, 'upvote');
    for (let vote = 0; vote < 3; vote++) await appendReaction(realmThread.threadId, 'downvote');
    await projectReactions(await eventsForSource());

    const at = new Date(Date.now() + 20 * 60_000);
    await db.admin.query(
      `UPDATE content.board_thread SET rank_refreshed_at = $1::timestamptz
       WHERE NOT (board_id = ANY($2::uuid[]))`,
      [at.toISOString(), [outsideBoard, realmBoard]],
    );
    const refreshed = await refreshBoardRankBatch(db.pool, at, [
      ...new Set([outsideBoard, realmBoard].map((id) => partitionOf(routeOf(id)!))),
    ]);
    expect(refreshed).toBe(3);

    const rows = await rankRows(
      [outsideBoard, realmBoard],
      [outsideThread.threadId, outsideOtherThread.threadId, realmThread.threadId],
    );
    const expectedScores = new Map([
      [outsideThread.threadId, 3],
      [outsideOtherThread.threadId, -2],
      [realmThread.threadId, -2],
    ]);
    for (const [threadId, score] of expectedScores) {
      const row = rows.get(threadId)!;
      expect(row.score).toBe(score);
      expect(row.active_rank).toBeCloseTo(rank(score, row.last_activity_at, at));
      expect(row.hot_rank).toBeCloseTo(rank(score, row.created_at, at));
      expect(row.rank_refreshed_at.toISOString()).toBe(at.toISOString());
    }
    expect(rows.get(outsideThread.threadId)!.active_rank).not.toBeCloseTo(
      rows.get(outsideOtherThread.threadId)!.active_rank,
    );
  },
  60_000,
);

test.serial(
  'a refresh after Realm vote weight change rescores hot ranks immediately',
  async () => {
    const realm = await createTestRealm();
    const boardId = await createBoard(realm.realmId);
    const createdAt = new Date(Date.now() - 60 * 60_000).toISOString();
    const upvoted = await createSourceThread(boardId, createdAt);
    const downvoted = await createSourceThread(boardId, createdAt);
    await projectThreads(await eventsForSource());
    await appendReaction(upvoted.threadId, 'upvote');
    await appendReaction(downvoted.threadId, 'downvote');
    await projectReactions(await eventsForSource());

    const initialAt = new Date(Date.now() + 20 * 60_000);
    const partition = partitionOf(routeOf(boardId)!);
    expect(await refreshBoardRankBatch(db.pool, initialAt, [partition])).toBe(2);
    const initialRows = await rankRows([boardId], [upvoted.threadId, downvoted.threadId]);
    const initialOrder = [upvoted.threadId, downvoted.threadId].sort(
      (left, right) => initialRows.get(right)!.hot_rank - initialRows.get(left)!.hot_rank,
    );

    await realm.updateVotes({ upvote: -1, downvote: 1 });
    const observedWeights = await withConnection(db.pool, (client) => readRealmVotes(client, [realm.realmId]));
    const refreshAt = new Date(initialAt.getTime() + 60_000);
    const refreshed = await refreshBoardRankBatch(db.pool, refreshAt, [partition]);
    const rows = await rankRows([boardId], [upvoted.threadId, downvoted.threadId]);
    const refreshedOrder = [upvoted.threadId, downvoted.threadId].sort(
      (left, right) => rows.get(right)!.hot_rank - rows.get(left)!.hot_rank,
    );

    expect({
      currentWeightsFromRefreshReader: observedWeights.get(realm.realmId),
      refreshedRows: refreshed,
      scoresWritten: [rows.get(upvoted.threadId)!.score, rows.get(downvoted.threadId)!.score],
      initialOrder,
      refreshedOrder,
      refreshedAt: [rows.get(upvoted.threadId)!.rank_refreshed_at, rows.get(downvoted.threadId)!.rank_refreshed_at],
    }).toEqual({
      currentWeightsFromRefreshReader: { upvote: -1, downvote: 1 },
      refreshedRows: 2,
      scoresWritten: [-1, 1],
      initialOrder: [upvoted.threadId, downvoted.threadId],
      refreshedOrder: [downvoted.threadId, upvoted.threadId],
      refreshedAt: [refreshAt, refreshAt],
    });
  },
  60_000,
);
