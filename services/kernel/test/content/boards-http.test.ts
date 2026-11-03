import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { runCommand } from '../../src/command/command.ts';
import { readBatch, type CloudEvent } from '../../src/events/log.ts';
import { applyBoardCandidate, createBoardEffect } from '../../src/content/board-projection.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { actionCatalogue, SESSION_HEADER } from '../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { standingFixture } from '../access/standing-fixture.ts';
import { checkGrowth, openGrowthDatabase } from '../support/growth.ts';
import { SUBJECT_THREAD_EVENT_FIELDS } from '../support/subject-thread-event.ts';

const routeKey = new Uint8Array(32).fill(7);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let fixture: Awaited<ReturnType<typeof standingFixture>>;
let app: ReturnType<typeof createKernel>;
let memberApp: ReturnType<typeof createKernel>;
let bearer: string;
let otherBearer: string;
let now = Date.now();
const boardRoute = 0x4321;
const threadRoute = 0x1234;
const subject = newId(0x6789);

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
    bearer = issued[0]!;
    otherBearer = issued[1]!;
  } finally {
    fixture.access.authenticate = authenticate;
  }
  const config = { pool: db.pool, routeKey, tokens, content: { cursorNow: () => now } };
  app = createKernel(config);
  memberApp = createKernel({ ...config, access: fixture.access });
  // A single checkout detects accidental nested board/thread pool acquisitions.
  db.pool.options.max = 1;
});
afterAll(async () => {
  await fixture?.close();
  await db?.close();
});

async function board() {
  const id = newId(boardRoute);
  await db.admin.query(
    `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,'Current board','published',1,$2)`,
    [boardRoute, id, subject],
  );
  for (const viewer of [fixture.actor, fixture.recipient]) {
    // This Auth fixture's catalogue has bearer-only reads, so account requests
    // use actual grants even for public boards. Anonymous requests use app's floor.
    await fixture.grant(viewer, 'board:read', { route: boardRoute, id });
  }
  return id;
}
async function thread(boardId: string, text = 'current searchable sentinel', at = '2026-10-24T00:00:00.000Z') {
  const id = newId(threadRoute);
  const post = newId(threadRoute);
  const revision = newId(threadRoute);
  const body = Buffer.from(JSON.stringify(fromPlainText(text)));
  await runCommand(db.pool, { partition: partitionOf(threadRoute) }, async (tx) => {
    await tx.query(
      `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id,created_at)
     VALUES ($1,$2,$3,$4,'Current title','published',1,$2,$5,$6)`,
      [threadRoute, id, fixture.actor, boardId, post, at],
    );
    await tx.query(
      `INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,$4,$5,'published',1,$3)`,
      [threadRoute, id, post, fixture.actor, revision],
    );
    await tx.query(
      `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
     VALUES ($1,$2,$3,$4,$5,sha256($5),$6,'MIT','{}',$7,'available',$4)`,
      [threadRoute, id, post, revision, body, text, boardId],
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
  await applyBoardCandidate(db.pool, { id, boardId, createdAt: at, epoch: 1, position: 1n });
  return { id, post, revision };
}
async function state(kind: 'board' | 'thread' | 'post', id: string, visibility: string) {
  await db.admin.query(
    `UPDATE content.${kind} SET visibility=$3,security_revision=security_revision+1 WHERE route=$1 AND ${kind}_id=$2`,
    [routeOf(id), id, visibility],
  );
}
async function get(path: string, token?: string) {
  const response = await (token ? memberApp : app).handle(
    new Request(`http://kernel.test${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }),
  );
  return { response, body: await response.json() };
}
function path(id: string, values: Record<string, string> = {}) {
  return `/v1/boards/${id}/threads?${new URLSearchParams(values)}`;
}
async function invalid(url: string, token?: string) {
  const result = await get(url, token);
  expect(result.response.status).toBe(400);
  expect(result.response.headers.get('content-type')).toContain('application/problem+json');
  expect(result.body).toMatchObject({ code: 'invalid_request', effect_status: 'not_applicable' });
  expect(Object.keys(result.body).sort()).toEqual(
    ['type', 'title', 'status', 'code', 'retryable', 'effect_status', 'request_id'].sort(),
  );
  expect(result.response.headers.get(SESSION_HEADER)).toBeNull();
}

test('board metadata and listing mount once with the actual read action and plural envelope', async () => {
  const operation = openApiDocument(app).paths['/v1/boards/{id}/threads']?.get;
  expect(operation?.operationId).toBe('board_threads.list');
  expect(operation?.['x-action']).toBe('thread:read');
  expect(actionCatalogue(app).get('thread:read')?.anonymous).toBe(true);
  expect(app.routes.filter((r) => r.path === '/v1/boards/:id')).toHaveLength(1);
  const id = await board();
  const detail = await get(`/v1/boards/${id}`);
  expect(detail.response.status).toBe(200);
  expect(Object.keys(detail.body.board).sort()).toEqual(
    [
      'id',
      'route',
      'title',
      'purpose',
      'visibility',
      'securityRevision',
      'availability',
      'createdAt',
      'realmId',
    ].sort(),
  );
  expect(detail.body.board.realmId).toBeNull();
  expect((await get(path(id))).body).toEqual({ pinnedThreads: [], threads: [], next: null, rankRefreshedAt: null });
  for (const values of [{ limit: '0' }, { limit: '101' }, { limit: '1.5' }, { sort: 'popular' }])
    await invalid(path(id, values));
});

test('keyset ties reverse both keys and newer insertion cannot repeat an existing entry', async () => {
  const id = await board();
  const records = await Promise.all([thread(id), thread(id), thread(id)]);
  const ascending = records.map((r) => r.id).sort();
  const first = await get(path(id, { limit: '1' }));
  expect(first.response.status).toBe(200);
  expect(first.body.threads.map((r: { id: string }) => r.id)).toEqual([ascending[2]]);
  expect(first.response.headers.get(SESSION_HEADER)).toEqual(expect.any(String));
  await thread(id, 'new insertion', '2026-10-25T00:00:00.000Z');
  const second = await get(path(id, { limit: '1', cursor: first.body.next }));
  expect(second.body.threads.map((r: { id: string }) => r.id)).toEqual([ascending[1]]);
  const oldest = await get(path(id, { limit: '3', sort: 'oldest' }));
  expect(oldest.body.threads.map((r: { id: string }) => r.id)).toEqual(ascending);
});

test('signed cursors bind board normalized query sort verified viewer epoch and trusted expiry clock', async () => {
  const id = await board();
  await thread(id);
  await thread(id);
  const first = await get(path(id, { limit: '1', query: '  searchable  ' }));
  expect(first.response.status).toBe(200);
  const cursor = first.body.next;
  expect(cursor).toEqual(expect.any(String));
  expect((await get(path(id, { limit: '1', query: 'searchable', cursor }))).response.status).toBe(200);
  await invalid(path(await board(), { cursor, query: 'searchable' }));
  await invalid(path(id, { cursor, query: 'different' }));
  await invalid(path(id, { cursor, query: 'searchable', sort: 'oldest' }));
  await invalid(path(id, { cursor: `${cursor.slice(0, -4)}xxxx`, query: 'searchable' }));
  await invalid(path(id, { cursor, query: 'searchable' }), bearer);
  const members = await db.admin.query(
    'SELECT thread_id,first_post_id FROM content.thread WHERE route=$1 AND board_id=$2',
    [threadRoute, id],
  );
  for (const row of members.rows) {
    for (const viewer of [fixture.actor, fixture.recipient]) {
      await fixture.grant(viewer, 'thread:read', { route: threadRoute, id: row.thread_id });
      await fixture.grant(viewer, 'post:read', { route: threadRoute, id: row.first_post_id });
    }
  }
  const member = await get(path(id, { limit: '1' }), bearer);
  expect(member.response.status).toBe(200);
  await invalid(path(id, { cursor: member.body.next }), otherBearer);
  now += 31 * 60 * 1000;
  try {
    await invalid(path(id, { cursor: member.body.next }), bearer);
    expect((await get(path(id), bearer)).response.status).toBe(200);
  } finally {
    now -= 31 * 60 * 1000;
  }
  await db.admin.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [partitionOf(boardRoute)]);
  try {
    await invalid(path(id, { cursor, query: 'searchable' }));
  } finally {
    await db.admin.query('UPDATE core.partition SET epoch=epoch-1 WHERE partition_no=$1', [partitionOf(boardRoute)]);
  }
});

test('every returned candidate passes current thread root and board disclosure while projection is paused', async () => {
  const id = await board();
  const f = await thread(id);
  expect((await get(path(id))).body.threads).toHaveLength(1);
  for (const [kind, target] of [
    ['thread', f.id],
    ['post', f.post],
  ] as const) {
    for (const visibility of ['protected', 'taken_down']) {
      await state(kind, target, visibility);
      expect((await get(path(id))).body).toEqual({ pinnedThreads: [], threads: [], next: null, rankRefreshedAt: null });
    }
    await state(kind, target, 'published');
  }
  await state('board', id, 'protected');
  for (const url of [`/v1/boards/${id}`, path(id)]) expect((await get(url)).response.status).toBe(404);
  await state('board', id, 'taken_down');
  expect((await get(path(id))).response.status).toBe(404);
});

test('current protected positive needs actual grants and scope; named denial overrides author identity', async () => {
  const id = await board();
  const f = await thread(id);
  await state('thread', f.id, 'protected');
  await state('post', f.post, 'protected');
  expect((await get(path(id), bearer)).body.threads).toEqual([]);
  await fixture.grant(fixture.actor, 'thread:read', { route: threadRoute, id: f.id });
  await fixture.grant(fixture.actor, 'post:read', { route: threadRoute, id: f.post });
  expect((await get(path(id), bearer)).body.threads.map((r: { id: string }) => r.id)).toEqual([f.id]);
  expect((await get(path(id), otherBearer)).body.threads).toEqual([]);
  await db.admin.query(
    `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
     VALUES ($1,$2,$3,'post:read','resource','(,)',$2)`,
    [threadRoute, f.post, fixture.actor],
  );
  expect((await get(path(id), bearer)).body.threads).toEqual([]);
});

test('hidden board and unknown board give identical404 without content or session evidence', async () => {
  const id = await board();
  await state('board', id, 'protected');
  for (const suffix of ['', '/threads']) {
    const hidden = await get(`/v1/boards/${id}${suffix}`);
    const missing = await get(`/v1/boards/${newId(boardRoute)}${suffix}`);
    expect(hidden.response.status).toBe(404);
    expect(missing.response.status).toBe(404);
    expect({ ...hidden.body, request_id: null }).toEqual({ ...missing.body, request_id: null });
    expect(hidden.body.effect_status).toBe('not_applicable');
    expect(hidden.response.headers.get(SESSION_HEADER)).toBeNull();
  }
});

test('entire hidden candidate page makes bounded progress from the last scanned key until exhaustion', async () => {
  const id = await board();
  for (let i = 0; i < 201; i++) {
    await applyBoardCandidate(db.pool, {
      id: newId(threadRoute),
      boardId: id,
      createdAt: '2026-10-24T00:00:00.000Z',
      epoch: 1,
      position: 1n,
    });
  }
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  do {
    const page = await get(path(id, { limit: '1', ...(cursor ? { cursor } : {}) }));
    expect(page.response.status).toBe(200);
    expect(page.body.threads).toEqual([]);
    cursor = page.body.next;
    if (cursor) {
      expect(seen.has(cursor)).toBe(false);
      seen.add(cursor);
    }
    pages++;
    expect(pages).toBeLessThanOrEqual(202);
  } while (cursor);
  expect(pages).toBeGreaterThan(1);
});

test('query matches only current authorized revision text and never erased text after real projection replay', async () => {
  const id = await board();
  const f = await thread(id, 'erasuresentinel');
  expect((await get(path(id, { query: 'erasuresentinel' }))).body.threads).toHaveLength(1);
  const revision = newId(threadRoute);
  const bytes = Buffer.from(JSON.stringify(fromPlainText('replacementtoken')));
  await db.admin.query(
    `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
     VALUES ($1,$2,$3,$4,$5,sha256($5),'replacementtoken','MIT','{}',$6,'available',$4)`,
    [threadRoute, f.id, f.post, revision, bytes, id],
  );
  await db.admin.query('UPDATE content.post SET head_revision_id=$3 WHERE route=$1 AND post_id=$2', [
    threadRoute,
    f.post,
    revision,
  ]);
  expect((await get(path(id, { query: 'erasuresentinel' }))).body.threads).toEqual([]);
  const current = await get(path(id, { query: 'replacementtoken' }));
  expect(current.body.threads[0].firstPost.revisionId).toBe(revision);
  await db.admin.query(
    "UPDATE content.post SET availability='erased',security_revision=security_revision+1 WHERE route=$1 AND thread_id=$2 AND post_id=$3",
    [threadRoute, f.id, f.post],
  );
  await db.admin.query(
    "UPDATE content.revision SET body=NULL,body_sha256=NULL,search_text=NULL,availability='erased' WHERE route=$1 AND thread_id=$2",
    [threadRoute, f.id],
  );
  const events: CloudEvent[] = [];
  // Drain the real transactional outbox; the creation event remains replayable after erasure.
  do {
    await readBatch(db.pool, {
      partition: partitionOf(threadRoute),
      consumer: 'boards_http_replay',
      apply: async (envelopes) => {
        events.push(...envelopes.flatMap((envelope) => envelope.events));
      },
    });
  } while (!events.some((event) => event.subject === f.id));
  await createBoardEffect(db.pool).run(events.find((event) => event.subject === f.id)!);
  for (const query of ['erasuresentinel', 'replacementtoken']) {
    const result = await get(path(id, { query }));
    expect(result.response.status).toBe(200);
    expect(result.body).toEqual({ pinnedThreads: [], threads: [], next: null, rankRefreshedAt: null });
    expect(JSON.stringify(result.body)).not.toContain(query);
  }
});

test('checkGrowth proves the declared three-scale machine-independent bound', async () => {
  const id = await board();
  const f = await thread(id, 'growthtoken', '2026-10-25T00:00:00.000Z');
  // Fixed candidate population makes Q independent of the unrelated seed scales.
  for (let index = 0; index < 200; index++) {
    await applyBoardCandidate(db.pool, {
      id: newId(threadRoute),
      boardId: id,
      createdAt: '2026-10-23T00:00:00.000Z',
      epoch: 1,
      position: 1n,
    });
  }
  const report = await checkGrowth(db, {
    name: 'board HTTP current query and disclosure with same-partition distractors',
    scales: [256, 1024, 4096],
    bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
    async grow(database, scale, previous) {
      const count = scale - previous;
      const boardIds = Array.from({ length: count }, () => newId(boardRoute));
      const threadIds = Array.from({ length: count }, () => newId(threadRoute));
      const postIds = Array.from({ length: count }, () => newId(threadRoute));
      const revisionIds = Array.from({ length: count }, () => newId(threadRoute));
      const candidateIds = Array.from({ length: count }, () => newId(threadRoute));
      const body = Buffer.from(JSON.stringify(fromPlainText('unrelated bytes')));
      const client = await database.admin.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO content.board(route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
           SELECT $1::integer, board_id, $2::uuid, 'Current board', 'published', 1, board_id
           FROM unnest($3::uuid[]) AS board_id`,
          [boardRoute, subject, boardIds],
        );
        await client.query(
          `INSERT INTO access.resource_grant(route,resource_id,subject_id,action,valid,transaction_id)
           SELECT $1::integer, board_id, subject_id, 'board:read', '(,)'::tstzrange, subject_id
           FROM unnest($2::uuid[]) AS board_id
           CROSS JOIN unnest($3::uuid[]) AS subject_id
           ON CONFLICT DO NOTHING`,
          [boardRoute, boardIds, [fixture.actor, fixture.recipient]],
        );
        await client.query(
          `INSERT INTO content.thread(route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id,created_at)
           SELECT $1::integer, thread_id, $2::uuid, board_id, 'Current title', 'published', 1, thread_id, post_id, '2026-10-24T00:00:00.000Z'::timestamptz
           FROM unnest($3::uuid[], $4::uuid[], $5::uuid[]) AS row(board_id, thread_id, post_id)`,
          [threadRoute, fixture.actor, boardIds, threadIds, postIds],
        );
        await client.query(
          `INSERT INTO content.post(route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
           SELECT $1::integer, thread_id, post_id, $2::uuid, revision_id, 'published', 1, post_id
           FROM unnest($3::uuid[], $4::uuid[], $5::uuid[]) AS row(thread_id, post_id, revision_id)`,
          [threadRoute, fixture.actor, threadIds, postIds, revisionIds],
        );
        await client.query(
          `INSERT INTO content.revision(route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
           SELECT $1::integer, thread_id, post_id, revision_id, $2::bytea, sha256($2::bytea), 'unrelated bytes', 'MIT', '{}'::uuid[], board_id, 'available', revision_id
           FROM unnest($3::uuid[], $4::uuid[], $5::uuid[], $6::uuid[]) AS row(board_id, thread_id, post_id, revision_id)`,
          [threadRoute, body, boardIds, threadIds, postIds, revisionIds],
        );
        await client.query(
          `INSERT INTO content.board_thread(route, board_id, thread_id, created_at, source_epoch, source_position)
           SELECT $1::integer, board_id, thread_id, '2026-10-24T00:00:00.000Z'::timestamptz, 1, 1::bigint
           FROM unnest($2::uuid[], $3::uuid[]) AS row(board_id, thread_id)
           UNION ALL
           SELECT $1::integer, $4::uuid, candidate_id, '2026-10-23T00:00:00.000Z'::timestamptz, 1, 1::bigint
           FROM unnest($5::uuid[]) AS candidate_id`,
          [boardRoute, boardIds, threadIds, id, candidateIds],
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      const grants = Array.from({ length: scale - previous }, () => ({
        route: threadRoute,
        resource_id: newId(threadRoute),
        subject_id: newId(0x6789),
        transaction_id: newId(threadRoute),
      }));
      await database.admin.query(
        `INSERT INTO access.resource_role_grant(route,resource_id,subject_id,grant_role,valid,transaction_id)
         SELECT route,resource_id,subject_id,'content.thread.standing','(,)'::tstzrange,transaction_id
         FROM jsonb_to_recordset($1::jsonb) AS row(route integer,resource_id uuid,subject_id uuid,transaction_id uuid)`,
        [JSON.stringify(grants)],
      );
      await database.admin.query(
        `INSERT INTO access.resource_denial(route,resource_id,subject_id,action,reason,valid,transaction_id)
         SELECT route,resource_id,subject_id,'thread:read','resource','(,)'::tstzrange,transaction_id
         FROM jsonb_to_recordset($1::jsonb) AS row(route integer,resource_id uuid,subject_id uuid,transaction_id uuid)`,
        [JSON.stringify(grants)],
      );
      await database.admin.query(
        'VACUUM (ANALYZE) content.board,content.board_thread,content.thread,content.post,content.revision,access.resource_grant,access.resource_role_grant,access.resource_denial',
      );
    },
    async operation() {
      const result = await get(path(id, { limit: '1', query: 'growthtoken' }));
      expect(result.response.status).toBe(200);
      expect(result.body.threads.map((r: { id: string }) => r.id)).toEqual([f.id]);
    },
  });
  expect(report.samples.map((s) => s.scale)).toEqual([256, 1024, 4096]);
  for (const { cost } of report.samples) {
    expect(cost.rows).toBeGreaterThan(0);
    expect(cost.statements).toBeGreaterThan(0);
  }
  console.info(JSON.stringify(report));
}, 600_000);
