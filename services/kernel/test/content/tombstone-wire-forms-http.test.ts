import { afterAll, beforeAll, expect, test } from 'bun:test';
import { fromPlainText } from '@rezics/document';
import { randomUUID } from 'node:crypto';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { clearErasedPostRevisions } from '../../src/content/erased-post-cleanup.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { newId, routeOf } from '../../src/route/route.ts';
import { standingFixture } from '../access/standing-fixture.ts';
import { openGrowthDatabase } from '../support/growth.ts';

let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
let fixture: Awaited<ReturnType<typeof standingFixture>>;
let app: ReturnType<typeof createKernel>;
const credentials = new Map<string, string>();
const boardId = newId(0x4321);
const day = 86400000;

beforeAll(async () => {
  db = await openGrowthDatabase();
  fixture = await standingFixture(['account:read']);
  await fixture.reset();
  const authenticate = fixture.access.authenticate;
  let issued = '';
  fixture.access.authenticate = (token, boundary) => {
    issued = token;
    return authenticate(token, { ...boundary, pool: db.pool });
  };
  try {
    for (const account of [fixture.actor, fixture.principal, fixture.recipient]) {
      await fixture.context(account);
      credentials.set(account, issued);
    }
  } finally {
    fixture.access.authenticate = authenticate;
  }
  app = createKernel({
    pool: db.pool,
    routeKey: new Uint8Array(32).fill(17),
    tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(18)]]) },
    access: fixture.access,
    writeRate: createWriteRateLimiter({
      secret: 'tombstone-http-fixture-secret-at-least-32-bytes',
      overrides: JSON.stringify({ 'new-account': { write: { maximum: 10000, seconds: 60 } } }),
    }),
  });
  await db.admin.query(
    `INSERT INTO content.board
      (route,board_id,subject_id,title,visibility,security_revision,recorded_transaction_id)
      VALUES ($1,$2,$3,'Wire forms board','published',1,$4)`,
    [routeOf(boardId), boardId, newId(0x6789), randomUUID()],
  );
  await fixture.grant(fixture.actor, 'thread:create', { route: routeOf(boardId)!, id: boardId });
  await fixture.grant(fixture.actor, 'account:read', { route: routeOf(fixture.actor)!, id: fixture.actor });
});

afterAll(async () => {
  await fixture?.close();
  await db?.close();
});

async function call(method: string, path: string, account: string | null, body?: unknown) {
  const response = await app.handle(
    new Request(`http://kernel.test/v1${path}`, {
      method,
      headers: {
        ...(account === null ? {} : { authorization: `Bearer ${credentials.get(account)}` }),
        ...(method === 'GET' ? {} : { 'idempotency-key': JSON.stringify(randomUUID()) }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { response, body: response.status === 204 ? null : await response.json() };
}

async function create() {
  const created = await call('POST', '/threads', fixture.actor, {
    boardId,
    title: 'Wire forms thread',
    body: fromPlainText('Opening sentinel'),
    licence: 'MIT',
    subjectIds: [],
    visibility: 'published',
  });
  expect(created.response.status).toBe(201);
  const thread = created.body.thread;
  const replied = await call('POST', `/threads/${thread.id}/posts`, fixture.actor, {
    parentId: thread.firstPost.id,
    body: fromPlainText('Reply sentinel'),
    licence: 'MIT',
    subjectIds: [],
    boardId,
  });
  expect(replied.response.status).toBe(201);
  return { thread, reply: replied.body.post };
}

async function page(threadId: string, account: string | null) {
  const result = await call('GET', `/threads/${threadId}/posts`, account);
  expect(result.response.status).toBe(200);
  return result.body.posts;
}

test('a deleted post shows as a tombstone to everyone and only its author also sees restorableUntil', async () => {
  const { thread, reply } = await create();
  const post = thread.firstPost;
  const beforeDeletion = await page(thread.id, null);
  expect(beforeDeletion.find((item: { id: string }) => item.id === post.id)).toMatchObject({
    availability: 'available',
    body: post.body,
    sha256: post.sha256,
  });
  expect((await call('DELETE', `/posts/${post.id}`, fixture.actor)).response.status).toBe(204);
  const {
    rows: [deleted],
  } = await db.admin.query('SELECT deleted_at FROM content.post WHERE route=$1 AND post_id=$2', [
    routeOf(post.id),
    post.id,
  ]);
  const until = new Date(deleted.deleted_at.getTime() + 30 * day).toISOString();
  let publicTombstone: unknown;
  for (const account of [null, fixture.actor, fixture.principal, fixture.recipient]) {
    const posts = await page(thread.id, account);
    const tombstone = posts.find((item: { id: string }) => item.id === post.id);
    expect(tombstone).toMatchObject({
      id: post.id,
      threadId: thread.id,
      parentId: null,
      route: post.route,
      availability: 'erased',
      removed: true,
      body: null,
      sha256: null,
    });
    expect(tombstone).not.toHaveProperty('decisionId');
    if (account === fixture.actor) expect(tombstone.restorableUntil).toBe(until);
    else {
      expect(tombstone).not.toHaveProperty('restorableUntil');
      expect(Object.keys(tombstone).sort()).toEqual([
        'availability',
        'body',
        'id',
        'parentId',
        'removed',
        'route',
        'sha256',
        'threadId',
      ]);
    }
    if (account === null) publicTombstone = tombstone;
    expect(posts.find((item: { id: string }) => item.id === reply.id)).toMatchObject({
      parentId: post.id,
      availability: 'available',
      body: reply.body,
      sha256: reply.sha256,
    });
    const exact = await call('GET', `/posts/${post.id}`, account);
    expect(exact.response.status).toBe(200);
    expect(exact.body.post.restorableUntil).toBe(account === fixture.actor ? until : undefined);
    if (account !== fixture.actor) expect(exact.body.post).not.toHaveProperty('authorId');
    expect((await call('GET', `/posts/${post.id}/revisions/${post.revisionId}`, account)).response.status).toBe(404);
    const detail = await call('GET', `/threads/${thread.id}`, account);
    expect(detail.response.status).toBe(200);
    expect(detail.body.thread.firstPost.restorableUntil).toBe(account === fixture.actor ? until : undefined);
    if (account !== fixture.actor) expect(detail.body.thread.firstPost).not.toHaveProperty('authorId');
  }
  // Expiry hides Undo immediately, even before physical cleanup has run.
  expect((await call('POST', `/posts/${post.id}:restore`, fixture.actor)).response.status).toBe(204);
  const {
    rows: [expired],
  } = await db.admin.query(
    `UPDATE content.post
     SET availability='erased', security_revision=security_revision+1, deleted_at=$3
     WHERE route=$1 AND post_id=$2 AND availability='available'
     RETURNING post_id`,
    [routeOf(post.id), post.id, new Date(Date.now() - 31 * day)],
  );
  expect(expired?.post_id).toBe(post.id);
  await clearErasedPostRevisions(db.pool, { postId: post.id }, Date.now() + 20000);
  expect((await page(thread.id, null))[0]).toEqual(publicTombstone);
  expect((await page(thread.id, fixture.actor))[0]).not.toHaveProperty('restorableUntil');
  expect((await call('GET', `/posts/${post.id}`, fixture.actor)).body.post).not.toHaveProperty('restorableUntil');

  const restored = await create();
  const id = restored.thread.firstPost.id;
  expect((await call('DELETE', `/posts/${id}`, fixture.actor)).response.status).toBe(204);
  expect((await call('POST', `/posts/${id}:restore`, fixture.actor)).response.status).toBe(204);
  const live = (await page(restored.thread.id, fixture.actor))[0];
  expect(live.availability).toBe('available');
  expect(live).not.toHaveProperty('restorableUntil');
});

test('a taken-down post shows as withheld with its metadata and no body, and only its author also sees the decision id', async () => {
  const { thread, reply } = await create();
  const post = thread.firstPost;
  expect((await page(thread.id, null))[0]).toMatchObject({
    id: post.id,
    availability: 'available',
    body: post.body,
    sha256: post.sha256,
  });
  await fixture.grant(fixture.principal, 'moderation:takedown', { route: post.route, id: post.id });
  const taken = await call('POST', `/posts/${post.id}:takeDown`, fixture.principal, { reason: 'Policy violation' });
  expect(taken.response.status).toBe(200);
  const {
    rows: [decision],
  } = await db.admin.query(
    "SELECT decision_id FROM content.moderation_decision WHERE route=$1 AND target_kind='post' AND target_id=$2",
    [post.route, post.id],
  );
  for (const account of [null, fixture.actor, fixture.principal, fixture.recipient]) {
    const posts = await page(thread.id, account);
    const withheld = posts.find((item: { id: string }) => item.id === post.id);
    const metadata = Object.fromEntries(
      [
        'id',
        'threadId',
        'parentId',
        'route',
        'authorId',
        'licence',
        'subjectIds',
        'boardId',
        'createdAt',
        'revisedAt',
        'mediaIds',
        'voteCitation',
        'revisionId',
      ].map((key) => [key, post[key]]),
    );
    expect(withheld).toMatchObject({
      ...metadata,
      availability: 'withheld',
      removed: true,
      body: null,
      sha256: null,
      visibility: 'taken_down',
      securityRevision: taken.body.securityRevision,
    });
    expect(withheld).not.toHaveProperty('restorableUntil');
    if (account === fixture.actor) expect(withheld.decisionId).toBe(decision.decision_id);
    else expect(withheld).not.toHaveProperty('decisionId');
    expect(posts.find((item: { id: string }) => item.id === reply.id)).toMatchObject({
      parentId: post.id,
      availability: 'available',
      body: reply.body,
    });
    const detail = await call('GET', `/threads/${thread.id}`, account);
    expect(detail.response.status).toBe(200);
    expect(detail.body.thread.firstPost).toMatchObject({
      ...metadata,
      availability: 'withheld',
      removed: true,
      body: null,
      sha256: null,
      securityRevision: taken.body.securityRevision,
    });
    expect(detail.body.thread.firstPost.decisionId).toBe(account === fixture.actor ? decision.decision_id : undefined);
    expect((await call('GET', `/posts/${post.id}`, account)).response.status).toBe(404);
    expect((await call('GET', `/posts/${post.id}/revisions/${post.revisionId}`, account)).response.status).toBe(404);
  }
});
