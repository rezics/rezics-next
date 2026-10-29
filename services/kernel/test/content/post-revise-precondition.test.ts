import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { normalizeDocument } from '@rezics/document';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteRateLimiter } from '../../src/access/write-rate.ts';
import { standingFixture } from '../access/standing-fixture.ts';
import { createKernel } from '../../src/http/kernel.ts';
import type { AccountActor } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import { checkGrowth, openGrowthDatabase, seed, type Population } from '../support/growth.ts';

const routeKey = new Uint8Array(32).fill(7);
const tokens = { current: 1, keys: new Map([[1, new Uint8Array(32).fill(8)]]) };
const snapshot = (text: string) =>
  normalizeDocument({
    version: 'rezics-document-v1',
    profile: 'text',
    doc: {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { id: 'revise-paragraph' }, content: [{ type: 'text', text }] }],
    },
  });

type PostView = { id: string; revisionId: string; revisedAt: string | null };
type ThreadView = { id: string; route: number; firstPost: PostView };

describe('post revise precondition through the mounted kernel', () => {
  let db: Awaited<ReturnType<typeof openGrowthDatabase>>;
  let app: ReturnType<typeof createKernel>;
  let fixture: Awaited<ReturnType<typeof standingFixture>>;
  let actor: AccountActor;
  let bearer: string;
  const boardId = newId(0x4321);
  const subjectIds = [newId(0x6789)];

  beforeAll(async () => {
    db = await openGrowthDatabase();
    db.pool.options.max = 1;
    fixture = await standingFixture();
    await fixture.reset();
    const authenticate = fixture.access.authenticate;
    fixture.access.authenticate = (token, boundary) => {
      bearer = token;
      return authenticate(token, { ...boundary, pool: db.pool });
    };
    try {
      actor = (await fixture.context()).actor;
    } finally {
      fixture.access.authenticate = authenticate;
    }
    app = createKernel({
      pool: db.pool,
      routeKey,
      tokens,
      access: fixture.access,
      writeRate: createWriteRateLimiter({
        secret: 'content-revise-precondition-secret-32b',
        overrides: '{"new-account":{"write":{"maximum":100000,"seconds":60}}}',
      }),
    });
    await fixture.grant(actor.accountId, 'thread:create', { route: routeOf(boardId)!, id: boardId });
    await fixture.grant(actor.accountId, 'board:read', { route: routeOf(boardId)!, id: boardId });
    await db.admin.query(
      `INSERT INTO content.board
         (route, board_id, subject_id, title, visibility, security_revision, recorded_transaction_id)
       VALUES ($1, $2, $3, 'Revise board', 'published', 1, $4)`,
      [routeOf(boardId), boardId, subjectIds[0], randomUUID()],
    );
  });
  afterAll(async () => {
    await fixture?.close();
    await db?.close();
  });

  async function call(
    method: string,
    path: string,
    body?: unknown,
    key?: string,
    headers: Record<string, string> = {},
  ) {
    const response = await app.handle(
      new Request(`http://kernel.test${path}`, {
        method,
        headers: {
          authorization: `Bearer ${bearer}`,
          ...headers,
          ...(body === undefined
            ? {}
            : { 'content-type': 'application/json', 'idempotency-key': JSON.stringify(key ?? randomUUID()) }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { response, body: await response.json() };
  }

  async function create(text: string): Promise<ThreadView> {
    const result = await call('POST', '/v1/threads', {
      title: 'Revise thread',
      body: snapshot(text),
      licence: 'CC-BY-SA-4.0',
      subjectIds,
      boardId,
      visibility: 'published',
    });
    expect(result.response.status).toBe(201);
    return result.body.thread;
  }

  async function marks(postId: string) {
    const [revisions, posts, receipts, outbox, head] = await Promise.all([
      db.admin.query<{ count: string }>('SELECT count(*)::text AS count FROM content.revision'),
      db.admin.query<{ count: string }>('SELECT count(*)::text AS count FROM content.post'),
      db.admin.query<{ count: string }>('SELECT count(*)::text AS count FROM core.receipt'),
      db.admin.query<{ count: string }>('SELECT count(*)::text AS count FROM core.outbox'),
      db.admin.query<{ head_revision_id: string }>('SELECT head_revision_id FROM content.post WHERE post_id = $1', [
        postId,
      ]),
    ]);
    return {
      revisions: revisions.rows[0]!.count,
      posts: posts.rows[0]!.count,
      receipts: receipts.rows[0]!.count,
      outbox: outbox.rows[0]!.count,
      head: head.rows[0]!.head_revision_id,
    };
  }

  async function headRecordedAt(revisionId: string): Promise<string> {
    const stored = await db.admin.query<{ recorded_at: Date }>(
      'SELECT recorded_at FROM content.revision WHERE revision_id = $1',
      [revisionId],
    );
    return stored.rows[0]!.recorded_at.toISOString();
  }

  function viewRevisedAt(views: readonly { id?: string; revisionId?: string; revisedAt: string | null }[], id: string) {
    const view = views.find((entry) => entry.id === id || entry.revisionId === id);
    expect(view).toBeDefined();
    return view!.revisedAt;
  }

  test('a matching If-Match revises, a stale one is 412 with no write, and readers see one edited time', async () => {
    const thread = await create('Original bytes');
    const postId = thread.firstPost.id;
    const originalRevisionId = thread.firstPost.revisionId;
    expect(thread.firstPost.revisedAt).toBeNull();

    const unread = await call('GET', `/v1/posts/${postId}`);
    expect(unread.response.status).toBe(200);
    expect(unread.response.headers.get('etag')).toBe(JSON.stringify(originalRevisionId));
    expect(unread.body.post.revisedAt).toBeNull();
    const threadRead = await call('GET', `/v1/threads/${thread.id}`);
    expect(threadRead.body.thread.firstPost.revisedAt).toBeNull();
    const page = await call('GET', `/v1/threads/${thread.id}/posts`);
    expect(viewRevisedAt(page.body.posts, postId)).toBeNull();
    const history = await call('GET', `/v1/posts/${postId}/revisions`);
    expect(history.body.revisions).toHaveLength(1);
    expect(viewRevisedAt(history.body.revisions, originalRevisionId)).toBeNull();
    const exact = await call('GET', `/v1/posts/${postId}/revisions/${originalRevisionId}`);
    expect(exact.body.post.revisedAt).toBeNull();

    const revised = await call(
      'POST',
      `/v1/posts/${postId}/revisions`,
      { body: snapshot('Edited bytes') },
      randomUUID(),
      { 'if-match': JSON.stringify(originalRevisionId) },
    );
    expect(revised.response.status).toBe(200);
    const headRevisionId = revised.body.post.revisionId as string;
    expect(headRevisionId).not.toBe(originalRevisionId);
    const editedAt = await headRecordedAt(headRevisionId);
    expect(revised.body.post.revisedAt).toBe(editedAt);

    const current = await call('GET', `/v1/posts/${postId}`);
    expect(current.response.status).toBe(200);
    expect(current.response.headers.get('etag')).toBe(JSON.stringify(headRevisionId));
    expect(current.body.post.revisedAt).toBe(editedAt);
    expect((await call('GET', `/v1/threads/${thread.id}`)).body.thread.firstPost.revisedAt).toBe(editedAt);
    expect(viewRevisedAt((await call('GET', `/v1/threads/${thread.id}/posts`)).body.posts, postId)).toBe(editedAt);
    const revisedHistory = await call('GET', `/v1/posts/${postId}/revisions`);
    expect(viewRevisedAt(revisedHistory.body.revisions, originalRevisionId)).toBe(editedAt);
    expect(viewRevisedAt(revisedHistory.body.revisions, headRevisionId)).toBe(editedAt);
    expect((await call('GET', `/v1/posts/${postId}/revisions/${originalRevisionId}`)).body.post.revisedAt).toBe(
      editedAt,
    );
    expect((await call('GET', `/v1/posts/${postId}/revisions/${headRevisionId}`)).body.post.revisedAt).toBe(editedAt);

    const beforeStale = await marks(postId);
    const stale = await call('POST', `/v1/posts/${postId}/revisions`, { body: snapshot('Stale bytes') }, randomUUID(), {
      'if-match': JSON.stringify(originalRevisionId),
    });
    expect(stale.response.status).toBe(412);
    expect(stale.body).toMatchObject({
      code: 'precondition_failed',
      status: 412,
      title: 'Precondition Failed',
      retryable: false,
      effect_status: 'not_applied',
    });
    expect(await marks(postId)).toEqual(beforeStale);

    const beforeMalformed = await marks(postId);
    const malformed = await call(
      'POST',
      `/v1/posts/${postId}/revisions`,
      { body: snapshot('Malformed precondition') },
      randomUUID(),
      { 'if-match': '"not-a-revision"' },
    );
    expect(malformed.response.status).toBe(400);
    expect(malformed.body).toMatchObject({ code: 'invalid_request', status: 400, effect_status: 'not_applied' });
    expect(await marks(postId)).toEqual(beforeMalformed);

    const optional = await call('POST', `/v1/posts/${postId}/revisions`, { body: snapshot('Optional precondition') });
    expect(optional.response.status).toBe(200);
    expect(optional.body.post.revisionId).not.toBe(headRevisionId);
    expect(optional.body.post.revisedAt).toBe(await headRecordedAt(optional.body.post.revisionId));
  });

  test('the revise request digest includes the If-Match precondition', async () => {
    const thread = await create('Digest bytes');
    const postId = thread.firstPost.id;
    const etag = JSON.stringify(thread.firstPost.revisionId);
    const key = randomUUID();
    const body = { body: snapshot('Digest revision') };
    const first = await call('POST', `/v1/posts/${postId}/revisions`, body, key, { 'if-match': etag });
    expect(first.response.status).toBe(200);
    const revisionId = first.body.post.revisionId as string;
    const before = await marks(postId);
    const replay = await call('POST', `/v1/posts/${postId}/revisions`, body, key, { 'if-match': etag });
    expect(replay.response.status).toBe(200);
    expect(replay.body.post.revisionId).toBe(revisionId);
    expect(await marks(postId)).toEqual(before);
    const conflict = await call('POST', `/v1/posts/${postId}/revisions`, body, key, {
      'if-match': JSON.stringify(newId(thread.route)),
    });
    expect(conflict.response.status).toBe(422);
    expect(conflict.body).toMatchObject({
      code: 'idempotency_conflict',
      status: 422,
      retryable: false,
      effect_status: 'not_applied',
    });
    expect(await marks(postId)).toEqual(before);
  });

  test('revise with a precondition and the revisedAt read stay fixed as other revisions grow', async () => {
    const targets: ThreadView[] = [];
    for (let run = 0; run < 12; run++) targets.push(await create('Fixed measured bytes'));
    const thread = targets[0]!;
    const distractorThreadId = newId(thread.route);
    await db.admin.query(
      `INSERT INTO content.thread
           (route, thread_id, author_account_id, board_id, title, visibility, security_revision, recorded_transaction_id)
         VALUES ($1, $2, $3, $4, 'Distractor thread', 'published', 1, $5)`,
      [thread.route, distractorThreadId, actor.accountId, boardId, randomUUID()],
    );
    const bytes = Buffer.from('seed');
    const digest = createHash('sha256').update(bytes).digest();
    const population: Population = {
      name: 'other post revisions',
      hotPartition: partitionOf(thread.route),
      hotShare: 1,
      rows() {
        const siblingId = newId(thread.route);
        const revisionId = newId(thread.route);
        const transactionId = randomUUID();
        return {
          'content.post': [
            {
              route: thread.route,
              thread_id: distractorThreadId,
              post_id: siblingId,
              author_account_id: actor.accountId,
              head_revision_id: revisionId,
              visibility: 'published',
              security_revision: 1,
              recorded_transaction_id: transactionId,
            },
          ],
          'content.revision': [
            {
              route: thread.route,
              thread_id: distractorThreadId,
              post_id: siblingId,
              revision_id: revisionId,
              body: bytes,
              body_sha256: digest,
              search_text: 'seed',
              licence: 'MIT',
              subject_ids: [],
              board_id: boardId,
              availability: 'available',
              recorded_transaction_id: transactionId,
              media_ids: [],
            },
          ],
        };
      },
    };
    const report = await checkGrowth(db, {
      name: 'post revise precondition and revisedAt read',
      rule: 'series',
      scales: [64, 512, 4096],
      bounds: { rows: 'constant', statements: 'constant', blocks: 'logarithmic' },
      repetitions: 3,
      warmups: 1,
      async grow(database, scale, previous) {
        if (previous === 0)
          await seed(database, { ...population, name: 'other post revisions baseline' }, { from: 0, to: 4096 });
        await seed(database, population, { from: previous, to: scale });
      },
      async operation(_database, _scale, repetition) {
        const postId = targets[repetition]!.firstPost.id;
        const read = await call('GET', `/v1/posts/${postId}`);
        expect(read.response.status).toBe(200);
        expect(read.response.headers.get('etag')).toBe(JSON.stringify(read.body.post.revisionId));
        const revised = await call(
          'POST',
          `/v1/posts/${postId}/revisions`,
          { body: snapshot(`Growth revise ${repetition}`) },
          `growth-${repetition}`,
          { 'if-match': read.response.headers.get('etag')! },
        );
        expect(revised.response.status).toBe(200);
      },
    });
    expect(report.samples.map(({ scale }) => scale)).toEqual([64, 512, 4096]);
    for (const { cost } of report.samples) {
      expect(cost.statements).toBeGreaterThan(0);
      expect(cost.rows).toBeGreaterThan(0);
    }
  }, 300_000);
});
