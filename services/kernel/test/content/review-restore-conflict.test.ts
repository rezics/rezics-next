import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import liveReviewRead from '../../src/content/live-review-read.sql';
import restoreReview from '../../src/content/restore-review.sql';
import originalReview from '../../src/content/restoration-conflict-original.sql';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { observeSql } from './support/sql-observer.ts';
import {
  createReviewLifecycleFixture,
  requestKey,
  type ReviewLifecycleFixture,
  type ReviewLifecycleResponse,
} from './review-native-lifecycle-fixture.ts';

let f: ReviewLifecycleFixture;
beforeAll(async () => {
  f = await createReviewLifecycleFixture();
});
afterAll(async () => {
  await f?.close();
});

function status(result: ReviewLifecycleResponse, expected: number) {
  expect(result.response.status, result.text).toBe(expected);
}

function conflict(result: ReviewLifecycleResponse, existingThreadId?: string) {
  status(result, 409);
  expect(result.response.headers.get('content-type')).toBe('application/problem+json');
  const problem: Record<string, unknown> = { ...result.value, request_id: null };
  expect(problem).toEqual({
    type: 'https://rezics.com/problems/conflict',
    title: 'Conflict',
    status: 409,
    code: 'conflict',
    retryable: false,
    effect_status: 'not_applied',
    request_id: null,
    ...(existingThreadId ? { existingThreadId } : {}),
  });
}

async function createReview(subjectId: string) {
  const result = await f.call('POST', '/v1/threads', {
    bearer: f.author.bearer,
    body: {
      kind: 'review',
      title: 'Restorable review',
      body: fromPlainText('Retained immutable review body.'),
      licence: 'MIT',
      subjectIds: [subjectId],
      boardId: f.boardId,
      visibility: 'published',
    },
  });
  status(result, 201);
  return { threadId: result.value.thread.id as string, postId: result.value.thread.firstPost.id as string };
}

async function pair() {
  const subjectId = await f.subject('Review restoration destination');
  const original = await createReview(subjectId);
  status(await f.call('DELETE', `/v1/posts/${original.postId}`, { bearer: f.author.bearer }), 204);
  const existing = await createReview(subjectId);
  return { subjectId, original, existing };
}

async function stored(threadIds: string[]) {
  const route = routeOf(f.author.accountId)!;
  const rows = await f.admin.query(
    `SELECT t.thread_id, t.review_live, t.visibility, p.post_id, p.availability,
       p.security_revision, p.head_revision_id, r.revision_id, r.body, r.body_sha256,
       r.licence, r.subject_ids, r.board_id, r.vote_citation
     FROM content.thread t JOIN content.post p USING (route, thread_id)
     JOIN content.revision r USING (route, thread_id, post_id)
     WHERE t.route = $1 AND t.thread_id = ANY($2::uuid[])
     ORDER BY t.thread_id, p.post_id, r.revision_id`,
    [route, threadIds],
  );
  const position = await f.admin.query('SELECT position::text FROM core.partition WHERE partition_no = $1', [
    partitionOf(route),
  ]);
  return { rows: rows.rows, position: position.rows };
}

test('Existing review restoration conflict gives only an independently current-readable existing review reference', async () => {
  const { original, existing, subjectId } = await pair();
  const before = await stored([original.threadId, existing.threadId]);
  const key = requestKey('restore-conflict');
  const observer = observeSql(f.system.database.pool);
  try {
    conflict(
      await f.call('POST', `/v1/posts/${original.postId}:restore`, { bearer: f.author.bearer, key }),
      existing.threadId,
    );
    const statements = observer.records.map(({ statement }) => statement);
    const failure = statements.indexOf(restoreReview.sql);
    const lookup = statements.indexOf(liveReviewRead.sql);
    expect(failure).toBeGreaterThanOrEqual(0);
    expect(statements.indexOf('ROLLBACK', failure)).toBeGreaterThan(failure);
    expect(lookup).toBeGreaterThan(statements.indexOf('ROLLBACK', failure));
    const probes = observer.records.filter(({ statement }) => statement === liveReviewRead.sql);
    expect(probes).toHaveLength(1);
    const parameters: Record<string, unknown> = {
      route: routeOf(f.author.accountId),
      board_id: f.boardId,
      author_id: f.author.accountId,
      subject_id: subjectId,
    };
    expect(probes[0]!.parameters).toEqual(liveReviewRead.params.map((name) => parameters[name]));
    expect(await stored([original.threadId, existing.threadId])).toEqual(before);
    const destination = await f.call('GET', `/v1/threads/${existing.threadId}`, { bearer: f.author.bearer });
    status(destination, 200);
    expect(destination.value.thread).toMatchObject({
      id: existing.threadId,
      authorId: f.author.accountId,
      boardId: f.boardId,
      subjectIds: [subjectId],
    });
    // The failed key has no successful receipt to replay or overwrite.
    conflict(
      await f.call('POST', `/v1/posts/${original.postId}:restore`, { bearer: f.author.bearer, key }),
      existing.threadId,
    );
    expect(await stored([original.threadId, existing.threadId])).toEqual(before);
    for (const missing of ['thread:read', 'post:read', 'board:read', 'subject:read']) {
      const scoped = await f.system.auth.issue({
        accountId: f.author.accountId,
        clientId: f.system.auth.ordinaryClient.id,
        scopes: f.system.auth.ordinaryScopes.filter((scope) => scope !== missing),
      });
      conflict(await f.call('POST', `/v1/posts/${original.postId}:restore`, { bearer: scoped.bearer }));
      expect(await stored([original.threadId, existing.threadId])).toEqual(before);
    }
  } finally {
    await observer.close();
    await f.system.auth.issue({
      accountId: f.author.accountId,
      clientId: f.system.auth.ordinaryClient.id,
      scopes: f.system.auth.ordinaryScopes,
    });
  }
});

test('current private, hidden-subject and disappeared destinations omit the restoration reference', async () => {
  const { original, existing, subjectId } = await pair();
  const grant = await f.admin.query<{ valid: string }>(
    `SELECT valid::text FROM access.resource_role_grant
     WHERE route = $1 AND resource_id = $2 AND subject_id = $3 AND grant_role = 'content.thread.owner'`,
    [routeOf(existing.threadId), existing.threadId, f.author.accountId],
  );
  expect(grant.rows).toHaveLength(1);
  status(
    await f.call('POST', '/v1/roleGrants:revoke', {
      bearer: f.governance.bearer,
      body: {
        resource: { route: routeOf(existing.threadId), id: existing.threadId },
        subject: { kind: 'account', id: f.author.accountId },
        role: 'content.thread.owner',
        valid: grant.rows[0]!.valid,
      },
    }),
    200,
  );
  // The index returns a real, previously readable row. Privacy changes after
  // that read must still be observed by the independent ordinary read.
  const observer = observeSql(f.system.database.pool);
  try {
    const probe = observer.hold({ statement: liveReviewRead.sql }, 'after');
    const pending = f.call('POST', `/v1/posts/${original.postId}:restore`, { bearer: f.author.bearer });
    try {
      await probe.entered;
      await f.admin.query(
        `UPDATE content.thread SET visibility = 'protected', security_revision = security_revision + 1
         WHERE route = $1 AND thread_id = $2`,
        [routeOf(existing.threadId), existing.threadId],
      );
    } finally {
      probe.release();
    }
    conflict(await pending);
    status(await f.call('GET', `/v1/threads/${existing.threadId}`, { bearer: f.author.bearer }), 404);
    await f.admin.query(
      `UPDATE content.thread SET visibility = 'published', security_revision = security_revision + 1
       WHERE route = $1 AND thread_id = $2`,
      [routeOf(existing.threadId), existing.threadId],
    );
    await f.admin.query(
      `UPDATE semantic.subject SET visibility = 'hidden', security_revision = security_revision + 1
       WHERE route = $1 AND subject_id = $2`,
      [routeOf(subjectId), subjectId],
    );
    conflict(await f.call('POST', `/v1/posts/${original.postId}:restore`, { bearer: f.author.bearer }));
    await f.admin.query(
      `UPDATE semantic.subject SET visibility = 'visible', security_revision = security_revision + 1
       WHERE route = $1 AND subject_id = $2`,
      [routeOf(subjectId), subjectId],
    );
    const rollback = observer.hold({ statement: 'ROLLBACK' }, 'after');
    const disappeared = f.call('POST', `/v1/posts/${original.postId}:restore`, { bearer: f.author.bearer });
    try {
      await rollback.entered;
      await f.admin.query('UPDATE content.thread SET review_live = false WHERE route = $1 AND thread_id = $2', [
        routeOf(existing.threadId),
        existing.threadId,
      ]);
    } finally {
      rollback.release();
    }
    conflict(await disappeared);
  } finally {
    await observer.close();
  }
});

test('restore denials and reply restoration keep their native outcomes without a destination probe', async () => {
  const { original, existing } = await pair();
  const observer = observeSql(f.system.database.pool);
  try {
    status(await f.call('POST', `/v1/posts/${original.postId}:restore`, { bearer: f.other.bearer }), 404);
    const reply = await f.call('POST', `/v1/threads/${existing.threadId}/posts`, {
      bearer: f.author.bearer,
      body: { body: fromPlainText('Restorable reply.'), licence: 'MIT' },
    });
    status(reply, 201);
    status(await f.call('DELETE', `/v1/posts/${reply.value.post.id}`, { bearer: f.author.bearer }), 204);
    status(await f.call('POST', `/v1/posts/${reply.value.post.id}:restore`, { bearer: f.author.bearer }), 204);
    const route = routeOf(original.postId);
    await f.admin.query(
      `UPDATE content.post SET purge_started_at = clock_timestamp() WHERE route = $1 AND post_id = $2`,
      [route, original.postId],
    );
    const purged = await f.call('POST', `/v1/posts/${original.postId}:restore`, { bearer: f.author.bearer });
    status(purged, 404);
    expect(purged.value).not.toHaveProperty('existingThreadId');
    const expired = await pair();
    const deleted = await f.admin.query<{ deleted_at: string }>(
      'SELECT deleted_at::text FROM content.post WHERE route = $1 AND post_id = $2',
      [routeOf(expired.original.postId), expired.original.postId],
    );
    await f.system.clock.setCommandTime(
      new Date(Date.parse(deleted.rows[0]!.deleted_at) + 30 * 86400000).toISOString(),
    );
    const denied = await f.call('POST', `/v1/posts/${expired.original.postId}:restore`, { bearer: f.author.bearer });
    status(denied, 404);
    expect(denied.value).not.toHaveProperty('existingThreadId');
    expect(observer.records.filter(({ statement }) => statement === liveReviewRead.sql)).toHaveLength(0);
    expect(observer.records.filter(({ statement }) => statement === originalReview.sql)).toHaveLength(0);
  } finally {
    await observer.close();
  }
});
