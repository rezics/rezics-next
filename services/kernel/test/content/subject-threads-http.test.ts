import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { createKernel } from '../../src/http/kernel.ts';
import { openApiDocument } from '../../src/http/openapi.ts';
import { SESSION_HEADER } from '../../src/http/request.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openGrowthDatabase } from '../support/growth.ts';

const routeKey = new Uint8Array(32).fill(7);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
const boardRoute = 0x4321;
const threadRoute = 0x1234;
const subjectRoute = 0x6789;
const authorId = newId(0x9abc);
let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let app: ReturnType<typeof createKernel>;

beforeAll(async () => {
  db = await openGrowthDatabase();
  app = createKernel({ pool: db.pool, routeKey, tokens });
  db.pool.options.max = 1;
});

afterAll(async () => {
  await db?.close();
});

async function subject(visibility = 'visible') {
  const id = newId(subjectRoute);
  await db.admin.query(
    `INSERT INTO semantic.subject(route,subject_id,type,recorded_transaction_id,visibility,security_revision)
     VALUES ($1,$2,'schema:Book',$2,$3,1)`,
    [subjectRoute, id, visibility],
  );
  return id;
}

async function board(conceptId: string, visibility = 'published', realmId: string | null = null) {
  const id = newId(boardRoute);
  await db.admin.query(
    `INSERT INTO content.board
     (route,board_id,realm_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,$4,'Subject thread board',$5,1,$2)`,
    [boardRoute, id, realmId, conceptId, visibility],
  );
  return id;
}

async function thread(
  subjectId: string,
  boardId: string,
  options: { activityAt: string; kind?: 'discussion' | 'review'; visibility?: string; placeId?: string },
) {
  const id = newId(threadRoute);
  const postId = newId(threadRoute);
  const revisionId = newId(threadRoute);
  const body = Buffer.from(JSON.stringify(fromPlainText(`Thread ${id}`)));
  await db.admin.query('BEGIN');
  try {
    await db.admin.query(
      `INSERT INTO content.thread
       (route,thread_id,author_account_id,board_id,title,visibility,security_revision,recorded_transaction_id,first_post_id,created_at)
       VALUES ($1,$2,$3,$4,'Thread title',$5,1,$2,$6,$7)`,
      [threadRoute, id, authorId, boardId, options.visibility ?? 'published', postId, options.activityAt],
    );
    await db.admin.query(
      `INSERT INTO content.post
       (route,thread_id,post_id,author_account_id,head_revision_id,visibility,security_revision,recorded_transaction_id)
       VALUES ($1,$2,$3,$4,$5,'published',1,$3)`,
      [threadRoute, id, postId, authorId, revisionId],
    );
    await db.admin.query(
      `INSERT INTO content.revision
       (route,thread_id,post_id,revision_id,body,body_sha256,search_text,licence,subject_ids,board_id,availability,recorded_transaction_id)
       VALUES ($1,$2,$3,$4,$5,sha256($5),$6,'MIT',$7,$8,'available',$4)`,
      [threadRoute, id, postId, revisionId, body, `Thread ${id}`, [subjectId], boardId],
    );
    await db.admin.query(
      `INSERT INTO content.subject_thread
       (route,subject_id,thread_route,thread_id,place_id,kind,last_activity_at,source_epoch,source_position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,1,1)`,
      [
        subjectRoute,
        subjectId,
        threadRoute,
        id,
        options.placeId ?? GLOBAL_CONTEXT,
        options.kind ?? 'discussion',
        options.activityAt,
      ],
    );
    await db.admin.query('COMMIT');
  } catch (error) {
    await db.admin.query('ROLLBACK');
    throw error;
  }
  return id;
}

async function get(url: string) {
  const response = await app.handle(new Request(`http://kernel.test${url}`));
  return { response, body: await response.json() };
}

function path(subjectId: string, values: Record<string, string> = {}) {
  return `/v1/subjects/${subjectId}/threads?${new URLSearchParams(values)}`;
}

async function invalid(url: string) {
  const result = await get(url);
  expect(result.response.status).toBe(400);
  expect(result.response.headers.get('content-type')).toContain('application/problem+json');
  expect(result.body).toMatchObject({ code: 'invalid_request', effect_status: 'not_applicable' });
  expect(Object.keys(result.body).sort()).toEqual(
    ['type', 'title', 'status', 'code', 'retryable', 'effect_status', 'request_id'].sort(),
  );
  expect(result.response.headers.get(SESSION_HEADER)).toBeNull();
}

test('subject thread listing is mounted as a subject read and conceals unknown or unreadable subjects', async () => {
  const operation = openApiDocument(app).paths['/v1/subjects/{id}/threads']?.get;
  expect(operation?.operationId).toBe('subject_threads.list');
  expect(operation?.['x-action']).toBe('subject:read');
  expect(app.routes.filter((route) => route.path === '/v1/subjects/:id/threads')).toHaveLength(1);

  const unknown = newId(subjectRoute);
  expect((await get(path(unknown, { place: GLOBAL_CONTEXT, kind: 'discussion' }))).response.status).toBe(404);

  const hidden = await subject('hidden');
  expect((await get(path(hidden, { place: GLOBAL_CONTEXT, kind: 'discussion' }))).response.status).toBe(404);

  const readable = await subject();
  const empty = await get(path(readable, { place: GLOBAL_CONTEXT, kind: 'review' }));
  expect(empty.response.status).toBe(200);
  expect(empty.body).toMatchObject({
    threads: [],
    next: null,
    context: {
      subject: { id: readable, label: null, source: { partition: subjectRoute >> 4 } },
      place: { kind: 'global', id: GLOBAL_CONTEXT },
      kind: 'review',
    },
  });
  const missingPlace = await get(path(readable, { place: newId(0x789a), kind: 'review' }));
  expect(missingPlace.response.status).toBe(404);
  expect(missingPlace.body).not.toHaveProperty('threads');
  for (const values of [
    { kind: 'discussion' },
    { place: GLOBAL_CONTEXT },
    { place: GLOBAL_CONTEXT, kind: 'other' },
    { place: GLOBAL_CONTEXT, kind: 'discussion', limit: '0' },
    { place: GLOBAL_CONTEXT, kind: 'discussion', limit: '21' },
    { place: GLOBAL_CONTEXT, kind: 'discussion', limit: '1.5' },
  ])
    await invalid(path(readable, values));
});

test('subject thread pages sort by activity, bind signed cursors, and skip hidden or out-of-place candidates', async () => {
  const subjectId = await subject();
  const visibleBoard = await board(subjectId);
  const hiddenBoard = await board(subjectId, 'taken_down');
  const otherPlace = newId(0x789a);
  const topHidden = await thread(subjectId, visibleBoard, {
    activityAt: '2026-10-27T00:04:00.000Z',
    visibility: 'taken_down',
  });
  const containerHidden = await thread(subjectId, hiddenBoard, { activityAt: '2026-10-27T00:03:00.000Z' });
  const outOfPlace = await thread(subjectId, visibleBoard, {
    activityAt: '2026-10-27T00:02:30.000Z',
    placeId: otherPlace,
  });
  const review = await thread(subjectId, visibleBoard, {
    activityAt: '2026-10-26T23:59:00.000Z',
    kind: 'review',
  });
  const newest = await thread(subjectId, visibleBoard, { activityAt: '2026-10-27T00:01:00.000Z' });
  const nextNewest = await thread(subjectId, visibleBoard, { activityAt: '2026-10-27T00:00:00.000Z' });

  const first = await get(path(subjectId, { place: GLOBAL_CONTEXT, kind: 'discussion', limit: '1' }));
  expect(first.response.status).toBe(200);
  expect(first.body.context).toMatchObject({
    subject: { id: subjectId },
    place: { kind: 'global', id: GLOBAL_CONTEXT },
    kind: 'discussion',
  });
  expect(first.body.threads.map((value: { id: string }) => value.id)).toEqual([newest]);
  expect(first.body.next).toEqual(expect.any(String));
  expect(first.response.headers.get(SESSION_HEADER)).toEqual(expect.any(String));

  const second = await get(
    path(subjectId, { place: GLOBAL_CONTEXT, kind: 'discussion', limit: '1', cursor: first.body.next }),
  );
  expect(second.response.status).toBe(200);
  expect(second.body.context).toEqual(first.body.context);
  expect(second.body.threads.map((value: { id: string }) => value.id)).toEqual([nextNewest]);
  expect(second.body.threads.map((value: { id: string }) => value.id)).not.toContain(topHidden);
  expect(second.body.threads.map((value: { id: string }) => value.id)).not.toContain(containerHidden);
  expect(second.body.threads.map((value: { id: string }) => value.id)).not.toContain(outOfPlace);
  expect(second.body.threads.map((value: { id: string }) => value.id)).not.toContain(review);

  await invalid(path(subjectId, { place: GLOBAL_CONTEXT, kind: 'review', cursor: first.body.next }));
  await invalid(path(subjectId, { place: otherPlace, kind: 'discussion', cursor: first.body.next }));
  await invalid(
    path(subjectId, { place: GLOBAL_CONTEXT, kind: 'discussion', cursor: `${first.body.next.slice(0, -1)}x` }),
  );
});

test('thread disclosure changes take effect before the next page is returned', async () => {
  const subjectId = await subject();
  const boardId = await board(subjectId);
  const firstId = await thread(subjectId, boardId, { activityAt: '2026-10-27T01:00:00.000Z' });
  const secondId = await thread(subjectId, boardId, { activityAt: '2026-10-27T00:59:00.000Z' });

  const first = await get(path(subjectId, { place: GLOBAL_CONTEXT, kind: 'discussion', limit: '1' }));
  expect(first.body.threads.map((value: { id: string }) => value.id)).toEqual([firstId]);
  await db.admin.query(
    `UPDATE content.board SET visibility='taken_down',security_revision=security_revision+1 WHERE route=$1 AND board_id=$2`,
    [routeOf(boardId), boardId],
  );
  const next = await get(
    path(subjectId, { place: GLOBAL_CONTEXT, kind: 'discussion', limit: '1', cursor: first.body.next }),
  );
  expect(next.response.status).toBe(200);
  expect(next.body.threads).toEqual([]);
  expect(next.body.next).toBeNull();
  expect(next.body.threads.map((value: { id: string }) => value.id)).not.toContain(secondId);
});
