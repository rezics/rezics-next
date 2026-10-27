import { afterAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createHash, randomUUID } from 'node:crypto';
import { runCommand } from '../../src/command/command.ts';
import { createBoardEffect } from '../../src/content/board-projection.ts';
import { readBatch, type CloudEvent } from '../../src/events/log.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { newId, partitionOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';
import { SUBJECT_THREAD_EVENT_FIELDS } from '../support/subject-thread-event.ts';

const db = await openGrowthDatabase();
afterAll(() => db.close());

const routeKey = new Uint8Array(32).fill(11);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(13)]]) };
const kernel = createKernel({ pool: db.pool, routeKey, tokens });
const sourceRoute = 0x1248;
const boardRoute = 0x2468;
const createdType = 'com.rezics.content.thread.created.v1';
const replyType = 'com.rezics.content.post.created.v1';
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

type ListedThread = {
  id: string;
  boardId: string;
  availability: string;
  title: string | null;
  firstPost: { revisionId: string; availability: string; body: unknown };
};
type ListedPage = {
  threads?: ListedThread[];
  next?: string | null;
  rankRefreshedAt?: string | null;
  code?: string;
};
type RankSort = 'hot' | 'active';

function listing(boardId: string, values: Record<string, string> = {}): string {
  return `/v1/boards/${boardId}/threads?${new URLSearchParams(values)}`;
}

async function get(urlPath: string): Promise<{ response: Response; body: ListedPage }> {
  const response = await kernel.handle(new Request(`http://kernel.test${urlPath}`));
  return { response, body: (await response.json()) as ListedPage };
}

async function createBoard(): Promise<string> {
  const boardId = newId(boardRoute);
  await db.admin.query(
    `INSERT INTO content.board
      (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
     VALUES ($1, $2, $3, 'Hot board', 'published', 1, $4)`,
    [boardRoute, boardId, newId(boardRoute), randomUUID()],
  );
  return boardId;
}

async function createSourceThread(boardId: string, createdAt: string): Promise<{ threadId: string; itemId: string }> {
  const threadId = newId(sourceRoute);
  const authorId = newId(sourceRoute);
  const itemId = newId(sourceRoute);
  const revisionId = newId(sourceRoute);
  const text = `Hot thread ${threadId}`;
  const body = Buffer.from(JSON.stringify(fromPlainText(text)));
  const digest = createHash('sha256').update(body).digest();
  await runCommand(db.pool, { partition: partitionOf(sourceRoute) }, async (tx, context) => {
    await tx.query(
      `INSERT INTO content.thread
        (route, thread_id, author_account_id, board_id, title, visibility, security_revision,
         recorded_transaction_id, first_post_id, created_at)
       VALUES ($1, $2, $3, $4, 'Hot thread', 'published', 1, $5, $6, $7)`,
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
      [sourceRoute, threadId, itemId, revisionId, body, digest, text, boardId, context.transactionId, createdAt],
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
  return { threadId, itemId };
}

async function createReply(boardId: string, threadId: string, parentId: string, createdAt: string): Promise<void> {
  const authorId = newId(sourceRoute);
  const postId = newId(sourceRoute);
  const revisionId = newId(sourceRoute);
  const text = `Hot reply ${postId}`;
  const body = Buffer.from(JSON.stringify(fromPlainText(text)));
  const digest = createHash('sha256').update(body).digest();
  await runCommand(db.pool, { partition: partitionOf(sourceRoute) }, async (tx, context) => {
    await tx.query(
      `INSERT INTO content.post
        (route, thread_id, post_id, reply_to_post_id, author_account_id, head_revision_id, visibility,
         security_revision, recorded_transaction_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'published', 1, $7, $8)`,
      [sourceRoute, threadId, postId, parentId, authorId, revisionId, context.transactionId, createdAt],
    );
    await tx.query(
      `INSERT INTO content.revision
        (route, thread_id, post_id, revision_id, body, body_sha256, search_text, licence,
         subject_ids, board_id, availability, recorded_transaction_id, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'MIT', '{}', $8, 'available', $9, $10)`,
      [sourceRoute, threadId, postId, revisionId, body, digest, text, boardId, context.transactionId, createdAt],
    );
    return {
      value: null,
      events: [
        {
          type: replyType,
          subject: postId,
          data: { threadId, itemId: postId, revisionId, actorId: authorId, ...SUBJECT_THREAD_EVENT_FIELDS },
        },
      ],
    };
  });
}

async function projectUntilQuiet(): Promise<void> {
  const effect = createBoardEffect(db.pool);
  const consumer = `board_hot_http_${randomUUID().replaceAll('-', '')}`;
  let finished = false;
  for (let batch = 0; batch < 20 && !finished; batch++) {
    const events: CloudEvent[] = [];
    const result = await readBatch(db.pool, {
      partition: partitionOf(sourceRoute),
      consumer,
      apply: async (envelopes) => {
        events.push(...envelopes.flatMap((envelope) => envelope.events));
      },
    });
    expect(result.status).toBe('read');
    if (result.status !== 'read' || result.envelopes === 0) {
      finished = result.status === 'read' && result.envelopes === 0;
      break;
    }
    for (const event of events) {
      if (event.type === createdType || event.type === replyType) await effect.run(event);
    }
  }
  expect(finished).toBe(true);
}

async function storedOrder(boardId: string, sort: RankSort): Promise<string[]> {
  const sql =
    sort === 'hot'
      ? `SELECT thread_id::text AS thread_id
         FROM content.board_thread
         WHERE route = $1 AND board_id = $2
         ORDER BY hot_rank DESC, thread_id ASC`
      : `SELECT thread_id::text AS thread_id
         FROM content.board_thread
         WHERE route = $1 AND board_id = $2
         ORDER BY active_rank DESC, thread_id ASC`;
  const result = await db.admin.query<{ thread_id: string }>(sql, [boardRoute, boardId]);
  return result.rows.map((row) => row.thread_id);
}

async function rankRefreshedAt(threadId: string): Promise<string> {
  const result = await db.admin.query<{ rank_refreshed_at: string }>(
    `SELECT to_char(rank_refreshed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS rank_refreshed_at
     FROM content.board_thread
     WHERE route = $1 AND thread_id = $2`,
    [boardRoute, threadId],
  );
  return result.rows[0]!.rank_refreshed_at;
}

async function keyset(boardId: string, sort: RankSort): Promise<{ ids: string[]; firstCursor: string }> {
  const ids: string[] = [];
  let cursor: string | undefined;
  let firstCursor = '';
  for (let index = 0; index < 5; index++) {
    const query: Record<string, string> = { sort, limit: '1' };
    if (cursor) query.cursor = cursor;
    const page = await get(listing(boardId, query));
    expect(page.response.status).toBe(200);
    expect(page.body.threads?.length).toBeLessThanOrEqual(1);
    if (index === 0) {
      expect(typeof page.body.next).toBe('string');
      firstCursor = page.body.next!;
    }
    ids.push(...(page.body.threads ?? []).map((thread) => thread.id));
    if (page.body.next == null) return { ids, firstCursor };
    cursor = page.body.next;
  }
  expect(ids).toHaveLength(3);
  return { ids, firstCursor };
}

function literalValues(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object') return [];
  const record = schema as { enum?: unknown; anyOf?: unknown[]; const?: unknown };
  if (Array.isArray(record.enum)) return record.enum.filter((value): value is string => typeof value === 'string');
  if (typeof record.const === 'string') return [record.const];
  if (!Array.isArray(record.anyOf)) return [];
  return record.anyOf.flatMap((entry) => literalValues(entry));
}

async function rankedBoard(): Promise<string> {
  const boardId = await createBoard();
  const now = Date.now();
  const oldest = await createSourceThread(boardId, new Date(now - 6 * 60 * 60_000).toISOString());
  await createSourceThread(boardId, new Date(now - 3 * 60 * 60_000).toISOString());
  await createSourceThread(boardId, new Date(now - 60 * 60_000).toISOString());
  await createReply(boardId, oldest.threadId, oldest.itemId, new Date(now - 30 * 60_000).toISOString());
  await projectUntilQuiet();
  return boardId;
}

test.serial(
  'GET /v1/boards/{id}/threads?sort=hot lists by hot rank and sort=active by active rank, each with a keyset cursor bound to its sort',
  async () => {
    const boardId = await rankedBoard();
    const hot = await keyset(boardId, 'hot');
    const active = await keyset(boardId, 'active');
    expect(hot.ids).toEqual(await storedOrder(boardId, 'hot'));
    expect(active.ids).toEqual(await storedOrder(boardId, 'active'));
    expect(hot.ids).not.toEqual(active.ids);
    expect(hot.ids).toHaveLength(3);
    for (const sort of ['active', 'newest', 'oldest'] as const) {
      const rejected = await get(listing(boardId, { sort, limit: '1', cursor: hot.firstCursor }));
      expect(rejected.response.status).toBe(400);
      expect(rejected.body.code).toBe('invalid_request');
    }
    const rejectedHot = await get(listing(boardId, { sort: 'hot', limit: '1', cursor: active.firstCursor }));
    expect(rejectedHot.response.status).toBe(400);
    expect(rejectedHot.body.code).toBe('invalid_request');
  },
  30_000,
);

test.serial(
  'active and hot responses declare rankRefreshedAt, and every item passes the final disclosure check',
  async () => {
    const operation = openApiDocument(kernel).paths['/v1/boards/{id}/threads']?.get;
    expect(operation?.operationId).toBe('board_threads.list');
    expect(operation?.['x-exposure']).toBe('public');
    expect(operation?.['x-action']).toBe('thread:read');
    const parameters = (operation?.parameters ?? []) as { name: string; schema?: unknown }[];
    expect(parameters.map((parameter) => parameter.name).sort()).toEqual(['cursor', 'id', 'limit', 'query', 'sort']);
    const sort = parameters.find((parameter) => parameter.name === 'sort');
    expect(literalValues(sort?.schema).sort()).toEqual(['active', 'hot', 'newest', 'oldest']);
    expect(JSON.stringify(operation?.responses?.['200'])).toContain('"rankRefreshedAt"');

    const boardId = await rankedBoard();
    const hiddenId = (await storedOrder(boardId, 'hot'))[0]!;
    await db.admin.query(
      `UPDATE content.thread
       SET visibility = 'taken_down', security_revision = security_revision + 1
       WHERE route = $1 AND thread_id = $2`,
      [sourceRoute, hiddenId],
    );
    const visibleHot = (await storedOrder(boardId, 'hot')).filter((id) => id !== hiddenId);
    const visibleActive = (await storedOrder(boardId, 'active')).filter((id) => id !== hiddenId);

    const hot = await get(listing(boardId, { sort: 'hot', limit: '10' }));
    expect(hot.response.status).toBe(200);
    expect(hot.body.threads?.map((thread) => thread.id)).toEqual(visibleHot);
    expect(hot.body.next).toBeNull();
    const hotLast = hot.body.threads!.at(-1)!;
    expect(hot.body.rankRefreshedAt).toBe(await rankRefreshedAt(hotLast.id));
    expect(Number.isFinite(Date.parse(hot.body.rankRefreshedAt!))).toBe(true);

    const active = await get(listing(boardId, { sort: 'active', limit: '10' }));
    expect(active.response.status).toBe(200);
    expect(active.body.threads?.map((thread) => thread.id)).toEqual(visibleActive);
    const activeLast = active.body.threads!.at(-1)!;
    expect(active.body.rankRefreshedAt).toBe(await rankRefreshedAt(activeLast.id));
    expect(Number.isFinite(Date.parse(active.body.rankRefreshedAt!))).toBe(true);

    for (const sort of ['newest', 'oldest'] as const) {
      const page = await get(listing(boardId, { sort, limit: '10' }));
      expect(page.response.status).toBe(200);
      expect(page.body.threads?.map((thread) => thread.id)).not.toContain(hiddenId);
      expect(page.body).toHaveProperty('rankRefreshedAt', null);
    }

    const hidden = await get(`/v1/threads/${hiddenId}`);
    expect(hidden.response.status).toBe(404);
    for (const item of hot.body.threads ?? []) {
      const direct = await get(`/v1/threads/${item.id}`);
      expect(direct.response.status).toBe(200);
      const thread = (direct.body as { thread?: ListedThread }).thread;
      expect(thread?.id).toBe(item.id);
      expect(thread?.boardId).toBe(item.boardId);
      expect(thread?.firstPost.revisionId).toBe(item.firstPost.revisionId);
      expect(item.availability).toBe('available');
      expect(item.firstPost.availability).toBe('available');
      expect(item.firstPost.body).not.toBeNull();
    }
  },
  30_000,
);

test.serial(
  'the hot page stays within its bound as boards and threads grow',
  async () => {
    const boardId = await createBoard();
    const probe = await createSourceThread(boardId, new Date(Date.now() - 60 * 60_000).toISOString());
    await projectUntilQuiet();
    const body = Buffer.from(JSON.stringify(fromPlainText('A fixed hot page body')));
    const bodyHash = createHash('sha256').update(body).digest();
    const at = '2000-01-01T00:00:00.000Z';
    const authorId = newId(0x9abc);
    const population: Population = {
      name: `board-hot-http-${randomUUID()}`,
      hotPartition: partitionOf(sourceRoute),
      hotShare: 1,
      rows: ({ ordinal, route }) => {
        const otherBoardId = newId(boardRoute);
        const subjectId = newId(boardRoute);
        const accountId = newId(boardRoute);
        const spaceId = newId(boardRoute);
        const spaceRevisionId = newId(boardRoute);
        const realmId = newId(boardRoute);
        const realmRevisionId = newId(boardRoute);
        const threadId = newId(route);
        const postId = newId(route);
        const revisionId = newId(route);
        const reservationId = newId(boardRoute);
        const transactionId = randomUUID();
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
              resource_id: otherBoardId,
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
              title: 'Other hot growth Realm host',
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
              title: 'Other hot growth Realm',
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
              board_id: otherBoardId,
              realm_id: realmId,
              subject_id: subjectId,
              title: 'Other hot board',
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
              author_account_id: authorId,
              board_id: otherBoardId,
              title: 'Hot growth thread',
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
              author_account_id: authorId,
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
              search_text: 'A fixed hot page body',
              licence: 'MIT',
              subject_ids: [],
              board_id: otherBoardId,
              availability: 'available',
              recorded_transaction_id: transactionId,
              recorded_at: at,
              media_ids: [],
            },
          ],
          'content.board_thread': [
            {
              route: boardRoute,
              board_id: otherBoardId,
              thread_id: threadId,
              created_at: at,
              last_activity_at: at,
              score: 0,
              active_rank: 0,
              hot_rank: 0,
              rank_refreshed_at: at,
              source_epoch: 1,
              source_position: ordinal + 1,
              source_revision_id: revisionId,
            },
          ],
        };
      },
    };
    const scales = [8, 32, 128] as const;
    // Grow grants, memberships, Realms, boards, and threads on other resources at 500 × scale; keep the requested board and page fixed.
    const report = await checkGrowth(db, {
      name: 'Hot board page',
      scales,
      bounds: { rows: 'constant', blocks: 'logarithmic', statements: 'constant' },
      repetitions: 1,
      grow: async (growthDb, scale, previous) => {
        await seed({ pool: growthDb.pool, admin: growthDb.admin }, population, {
          from: 500 * previous,
          to: 500 * scale,
        });
      },
      operation: async () => {
        const page = await get(listing(boardId, { sort: 'hot', limit: '1' }));
        expect(page.response.status).toBe(200);
        expect(page.body.threads?.map((thread) => thread.id)).toEqual([probe.threadId]);
        expect(Number.isFinite(Date.parse(page.body.rankRefreshedAt!))).toBe(true);
        return page.body;
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([...scales]);
    for (const { cost } of report.samples) {
      expect(cost.rows).toBeGreaterThan(0);
      expect(cost.statements).toBeGreaterThan(0);
      const boardThread = Object.entries(cost.relations ?? {}).filter(([name]) => name.endsWith('board_thread'));
      expect(boardThread).toHaveLength(1);
      expect(boardThread[0]?.[1].sequentialScans).toBe(0);
      for (const [name, relation] of Object.entries(cost.relations ?? {}))
        if (growingRelations.has(name)) expect(relation.sequentialScans).toBe(0);
    }
  },
  300_000,
);
