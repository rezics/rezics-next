import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { t } from 'elysia';
import { Value } from 'typebox/value';
import { ProblemError, problemResponse, problemSchema } from '../../src/http/problem.ts';
import liveReviewRead from '../../src/content/live-review-read.sql';
import { observeSql } from './support/sql-observer.ts';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { createAccess } from '../../src/access/index.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { measure, openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';

const routeKey = new Uint8Array(32).fill(83);
const authorId = newId(0x6d10);
const otherAuthorId = newId(0x6d20);
const actions = ['thread:create', 'thread:read', 'post:read', 'board:read'];
let db: GrowthDatabase;
let kernel: ReturnType<typeof createKernel>;
let bearer: string;
let otherBearer: string;
let reviewsBoardId: string;
const discussionBoardId = newId(0x6d30);

beforeAll(async () => {
  db = await openGrowthDatabase();
  const keys = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(keys.publicKey)), alg: 'ES256', kid: 'review-conflict-http' };
  const issuer = 'https://auth.example.test';
  const audience = 'https://api.example.test';
  const auth = { issuer, audience, jwksUrl: `${issuer}/jwks`, fetch: async () => Response.json({ keys: [jwk] }) };
  for (const id of [authorId, otherAuthorId]) {
    await db.admin.query(
      `INSERT INTO access.account (route,account_id,kind,state,transaction_id) VALUES ($1,$2,'actor','active',$2)`,
      [routeOf(id), id],
    );
  }
  reviewsBoardId = (
    await db.admin.query<{ board_id: string }>(
      "SELECT board_id FROM content.board WHERE realm_id IS NULL AND purpose = 'reviews'",
    )
  ).rows[0]!.board_id;
  await db.admin.query(
    `INSERT INTO content.board (route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
     VALUES ($1,$2,$3,'Discussion fixture','published',1,$2)`,
    [routeOf(discussionBoardId), discussionBoardId, newId(0x6d40)],
  );
  for (const boardId of [reviewsBoardId, discussionBoardId]) {
    for (const id of [authorId, otherAuthorId]) {
      for (const action of ['thread:create', 'board:read']) {
        await db.admin.query(
          `INSERT INTO access.resource_grant (route,resource_id,subject_id,action,valid,transaction_id)
           VALUES ($1,$2,$3,$4,'(,)'::tstzrange,$3)`,
          [routeOf(boardId), boardId, id, action],
        );
      }
    }
  }
  const issue = (id: string) =>
    new SignJWT({
      client_id: 'web',
      scope: actions.join(' '),
      authn_epoch: 1,
      auth_time: Math.floor(Date.now() / 1000),
      amr: ['pwd'],
    })
      .setProtectedHeader({ alg: 'ES256', kid: jwk.kid, typ: 'at+jwt' })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject(id)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(keys.privateKey);
  bearer = await issue(authorId);
  otherBearer = await issue(otherAuthorId);
  kernel = createKernel({
    pool: db.pool,
    access: (config) => createAccess({ ...config, auth }),
    routeKey,
    writeRate: createWriteRateLimiter({ secret: 'review-conflict-http-write-rate-secret-32b' }),
  });
});
afterAll(async () => {
  await db?.close();
});

async function call(method: string, path: string, body?: unknown, token = bearer) {
  const response = await kernel.handle(
    new Request(`http://kernel.test${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined
          ? {}
          : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(Bun.randomUUIDv7()) }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, body: await response.json() };
}
function review(subjectId = newId(0x6d50)) {
  return {
    kind: 'review',
    title: 'A review',
    body: fromPlainText('Review body.'),
    licence: 'MIT',
    boardId: reviewsBoardId,
    subjectIds: [subjectId],
    visibility: 'published',
  };
}

test("a second live review of the same subject on the same board answers 409 conflict carrying the author's existing review thread id", async () => {
  const input = review();
  const first = await call('POST', '/v1/threads', input);
  expect(first.response.status, JSON.stringify(first.body)).toBe(201);
  const conflict = await call('POST', '/v1/threads', input);
  expect(conflict.response.status).toBe(409);
  expect(conflict.response.headers.get('content-type')).toBe('application/problem+json');
  expect(conflict.body).toMatchObject({ code: 'conflict', existingThreadId: first.body.thread.id });
  const existing = await call('GET', `/v1/threads/${conflict.body.existingThreadId}`);
  expect(existing.response.status).toBe(200);
  expect(existing.body.thread.id).toBe(first.body.thread.id);
  expect((await call('POST', '/v1/threads', input, otherBearer)).response.status).toBe(201);

  // Remove the first review after the uniqueness failure has rolled back, before the lookup.
  const observer = observeSql(db.pool);
  try {
    const rollback = observer.hold({ statement: 'ROLLBACK' }, 'after');
    const pending = call('POST', '/v1/threads', input);
    try {
      await rollback.entered;
      await db.admin.query('UPDATE content.thread SET review_live = false WHERE route = $1 AND thread_id = $2', [
        routeOf(first.body.thread.id),
        first.body.thread.id,
      ]);
    } finally {
      rollback.release();
    }
    const gone = await pending;
    expect(gone.response.status).toBe(409);
    expect({ ...gone.body, request_id: null }).toEqual({
      type: 'https://rezics.com/problems/conflict',
      title: 'Conflict',
      status: 409,
      code: 'conflict',
      retryable: false,
      effect_status: 'not_applied',
      request_id: null,
    });
  } finally {
    await observer.close();
  }
});

test('the review conflict adds one point read only on conflict and no other problem response changes', async () => {
  const input = review();
  // Warm authentication and the creation path before measuring fresh commands.
  const warmup = await call('POST', '/v1/threads', review());
  expect(warmup.response.status, JSON.stringify(warmup.body)).toBe(201);
  const observer = observeSql(db.pool);
  const success = await measure(db, () => call('POST', '/v1/threads', input));
  expect(success.value.response.status).toBe(201);
  // The pre-extension HTTP path measured 99 statements on success and 18 on conflict.
  expect(success.cost.statements).toBe(99);
  expect(observer.records.filter(({ statement }) => statement === liveReviewRead.sql)).toHaveLength(0);
  const conflictStart = observer.records.length;
  const conflict = await measure(db, () => call('POST', '/v1/threads', input));
  expect(conflict.value.response.status).toBe(409);
  expect(conflict.cost.statements).toBe(18 + 1);
  expect(conflict.cost.failedStatements).toEqual({ '23505': 1 });
  const statements = observer.records.slice(conflictStart);
  const lookups = statements.filter(({ statement }) => statement === liveReviewRead.sql);
  expect(lookups).toHaveLength(1);
  const parameters: Record<string, unknown> = {
    route: routeOf(authorId),
    board_id: reviewsBoardId,
    author_id: authorId,
    subject_id: input.subjectIds[0],
  };
  expect(lookups[0]!.parameters).toEqual(liveReviewRead.params.map((name) => parameters[name]));
  const lookupIndex = statements.indexOf(lookups[0]!);
  const transactionControls = statements
    .slice(0, lookupIndex)
    .filter(({ statement }) => /^(?:BEGIN|COMMIT|ROLLBACK)/.test(statement));
  expect(transactionControls.at(-1)?.statement).toBe('ROLLBACK');
  await observer.close();
  const nonReview = await call('POST', '/v1/threads', {
    ...review(),
    kind: 'discussion',
    boardId: discussionBoardId,
    mediaIds: [newId(0x6d60)],
  });
  expect(nonReview.response.status).toBe(409);
  expect({ ...nonReview.body, request_id: null }).toEqual({
    type: 'https://rezics.com/problems/media_unavailable',
    title: 'Media Unavailable',
    status: 409,
    code: 'media_unavailable',
    retryable: false,
    effect_status: 'not_applied',
    request_id: null,
  });
  const context = { method: 'POST', id: 'review-conflict-extension-test' };
  const options = { detail: 'Original detail', errors: [{ pointer: '/title', code: 'required' as const }] };
  const original = await problemResponse(new ProblemError('conflict', options), context).json();
  const extensions = Object.fromEntries(
    ['type', 'title', 'status', 'detail', 'instance', 'errors', 'code', 'retryable', 'effect_status', 'request_id'].map(
      (name) => [name, 'overridden'],
    ),
  );
  const extended = await problemResponse(
    new ProblemError('conflict', {
      ...options,
      extensions: { ...extensions, existingThreadId: authorId },
    }),
    context,
  ).json();
  expect(extended).toEqual({ ...original, existingThreadId: authorId });
  const schema = problemSchema('conflict', {
    ...Object.fromEntries(Object.keys(extensions).map((name) => [name, t.String()])),
    existingThreadId: t.Optional(t.String({ format: 'uuid' })),
  });
  expect(Value.Check(schema, original)).toBe(true);
  expect(Value.Check(schema, extended)).toBe(true);
  expect(schema.properties).not.toHaveProperty('instance');
});
